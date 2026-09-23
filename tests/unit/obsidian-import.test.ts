import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { initWorkspace, loadConfig } from "../../src/core/config.js";
import { buildContextSnapshot, renderResumeText } from "../../src/core/context.js";
import {
  formatObsidianDecisionNote,
  formatObsidianSessionNote,
  importObsidianVault,
  parseObsidianDecisionNote,
  parseObsidianSessionNote,
  syncObsidianVault
} from "../../src/core/obsidian.js";
import { appendDecisionEvent, appendSessionEvent, readDecisionEvents, readSessionEvents } from "../../src/core/store.js";
import { makeTempWorkspace } from "../helpers.js";
import type { DecisionEvent, SessionEvent } from "../../src/types/events.js";

const oldDecision: DecisionEvent = {
  id: "dec-old-cache",
  ts: "2026-09-21T10:00:00.000Z",
  title: 'Use "Redis" Cache',
  context: "Fast in-memory cache",
  decision: "Adopt Redis",
  impact: "High RAM usage",
  supersedes: []
};

const newDecision: DecisionEvent = {
  id: "dec-new-sqlite",
  ts: "2026-09-21T11:00:00.000Z",
  title: "Use Local SQLite",
  context: "Redis is heavy.\n\nSecond paragraph with `code` and a [[dec-old-cache]] mention.",
  decision: "Switch to SQLite",
  impact: "N/A",
  supersedes: ["dec-old-cache"]
};

function makeSession(workspace: string): SessionEvent {
  return {
    ts: "2026-09-21T12:34:56.000Z",
    tool: "claude",
    workspace,
    branch: "main",
    intent: "Implement Obsidian import: vault -> bridge",
    summary: "Parsed notes back into events.",
    actions: ["Wrote parser", "Added tests"],
    artifacts: ["src/core/obsidian.ts", "tests/unit/obsidian-import.test.ts"],
    tags: ["obsidian", "feature"]
  };
}

async function snapshotVault(vaultDir: string): Promise<Map<string, string>> {
  const files = new Map<string, string>();
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else {
        files.set(path.relative(vaultDir, full), await fs.readFile(full, "utf8"));
      }
    }
  };
  await walk(vaultDir);
  return files;
}

async function countLines(file: string): Promise<number> {
  const text = await fs.readFile(file, "utf8").catch(() => "");
  return text.split("\n").filter((line) => line.trim() !== "").length;
}

type LoadedConfig = Awaited<ReturnType<typeof loadConfig>>["config"];

async function seededWorkspace(): Promise<{ workspace: string; vaultDir: string; config: LoadedConfig }> {
  const workspace = await makeTempWorkspace("mb-obsidian-import-");
  const vaultDir = path.join(workspace, "vault");
  const { config } = await initWorkspace({ workspace, enableSemanticSearch: true });
  await appendDecisionEvent(workspace, config, oldDecision);
  await appendDecisionEvent(workspace, config, newDecision);
  await appendSessionEvent(workspace, config, makeSession(workspace));
  return { workspace, vaultDir, config };
}

test("parseObsidianDecisionNote and parseObsidianSessionNote invert the exporters", () => {
  const decision = parseObsidianDecisionNote(formatObsidianDecisionNote(newDecision));
  assert.deepEqual(decision, {
    id: newDecision.id,
    ts: newDecision.ts,
    title: newDecision.title,
    context: newDecision.context,
    decision: newDecision.decision,
    impact: newDecision.impact,
    supersedes: newDecision.supersedes
  });
  const quoted = parseObsidianDecisionNote(formatObsidianDecisionNote(oldDecision));
  assert.equal(quoted?.title, 'Use "Redis" Cache');

  const expected = makeSession("/tmp/x");
  const session = parseObsidianSessionNote(formatObsidianSessionNote(expected));
  assert.deepEqual(session, {
    ts: expected.ts,
    tool: expected.tool,
    branch: expected.branch,
    intent: expected.intent,
    summary: expected.summary,
    actions: expected.actions,
    artifacts: expected.artifacts,
    tags: expected.tags
  });
});

test("round trip export -> import -> export is byte-identical and idempotent", async () => {
  const { workspace, vaultDir, config } = await seededWorkspace();

  await syncObsidianVault(workspace, config, vaultDir);
  const before = await snapshotVault(vaultDir);
  const decisionsFile = path.join(workspace, ".memory-bridge", "decisions.jsonl");
  const decisionLines = await countLines(decisionsFile);

  const imported = await importObsidianVault(workspace, config, vaultDir);
  assert.deepEqual(imported.created, { decisions: [], sessions: [] });
  assert.deepEqual(imported.updated, { decisions: [], sessions: [] });
  assert.equal(imported.skippedConflicts.length, 0);
  assert.equal(imported.assignedIds.length, 0);
  assert.equal(imported.unchanged, 4, "2 decisions + 1 session + project context");
  assert.equal(await countLines(decisionsFile), decisionLines);

  await syncObsidianVault(workspace, config, vaultDir);
  const after = await snapshotVault(vaultDir);
  assert.deepEqual([...after.keys()].sort(), [...before.keys()].sort());
  for (const [file, content] of before) {
    assert.equal(after.get(file), content, `vault file changed after round trip: ${file}`);
  }
});

test("a decision edited in the vault is visible in resume after import", async () => {
  const { workspace, vaultDir, config } = await seededWorkspace();
  await syncObsidianVault(workspace, config, vaultDir);

  const notePath = path.join(vaultDir, "Decisions", "dec-new-sqlite.md");
  const note = await fs.readFile(notePath, "utf8");
  await fs.writeFile(notePath, note.replace("Switch to SQLite", "Switch to SQLite with WAL mode"), "utf8");

  const imported = await importObsidianVault(workspace, config, vaultDir);
  assert.deepEqual(imported.updated.decisions, ["dec-new-sqlite"]);

  const { events } = await readDecisionEvents(workspace, config);
  const updated = events.find((event) => event.id === "dec-new-sqlite");
  assert.equal(updated?.decision, "Switch to SQLite with WAL mode");
  assert.equal(events.length, 2, "in-place replace must not append a duplicate");

  const context = await buildContextSnapshot(workspace, config);
  const resume = renderResumeText("claude", context.snapshot);
  assert.ok(resume.includes("Switch to SQLite with WAL mode"), resume);
});

test("a new vault note without id becomes a decision, gets its id written back, and export reuses the note", async () => {
  const { workspace, vaultDir, config } = await seededWorkspace();
  await syncObsidianVault(workspace, config, vaultDir);

  const userNote = path.join(vaultDir, "Decisions", "Adopt pnpm.md");
  await fs.writeFile(
    userNote,
    `---
title: "Adopt pnpm"
tags:
  - decision
---

# Decision: Adopt pnpm

- **Supersedes:** N/A

## Context
npm install is slow on CI.

## Decision
Use pnpm workspaces.

## Impact
Lockfile changes.
`,
    "utf8"
  );

  const decisionsFile = path.join(workspace, ".memory-bridge", "decisions.jsonl");
  const linesBefore = await countLines(decisionsFile);

  const first = await importObsidianVault(workspace, config, vaultDir);
  assert.equal(first.created.decisions.length, 1);
  assert.equal(first.assignedIds.length, 1);
  const assignedId = first.assignedIds[0]!.id;
  assert.match(assignedId, /^dec-/);
  assert.equal(await countLines(decisionsFile), linesBefore + 1);

  const rewritten = await fs.readFile(userNote, "utf8");
  assert.ok(rewritten.startsWith(`---\nid: "${assignedId}"\n`), rewritten.slice(0, 80));

  const { events } = await readDecisionEvents(workspace, config);
  const created = events.find((event) => event.id === assignedId);
  assert.equal(created?.title, "Adopt pnpm");
  assert.equal(created?.decision, "Use pnpm workspaces.");

  const second = await importObsidianVault(workspace, config, vaultDir);
  assert.equal(second.created.decisions.length, 0);
  assert.equal(second.updated.decisions.length, 0);
  assert.equal(second.assignedIds.length, 0);
  assert.equal(await countLines(decisionsFile), linesBefore + 1);

  await syncObsidianVault(workspace, config, vaultDir);
  const decisionNotes = await fs.readdir(path.join(vaultDir, "Decisions"));
  assert.ok(decisionNotes.includes("Adopt pnpm.md"));
  assert.ok(!decisionNotes.includes(`${assignedId}.md`), "export must not duplicate a user-named note");
});

test("sessions and project context import; --prefer bridge keeps local content on conflict", async () => {
  const { workspace, vaultDir, config } = await seededWorkspace();
  await syncObsidianVault(workspace, config, vaultDir);

  await fs.writeFile(
    path.join(vaultDir, "Sessions", "2026-09-22-codex-08-00-00.md"),
    `---
tool: "codex"
branch: "feature/x"
date: "2026-09-22T08:00:00.000Z"
tags:
  - memory-bridge
  - session
  - refactor
---

# Session (2026-09-22): Refactor parser

## Summary
Moved parsing into its own module. token=ghp_abcdefghijklmnopqrstuvwxyz0123456789

## Actions
- Split file

## Artifacts
- \`src/parser.ts\`
`,
    "utf8"
  );
  await fs.writeFile(
    path.join(vaultDir, "Project-Context.md"),
    `---
tags:
  - memory-bridge
  - project-context
---

# Project Context

Edited in the vault.
`,
    "utf8"
  );
  const sessionNote = path.join(vaultDir, "Sessions", "2026-09-21-claude-12-34-56.md");
  const original = await fs.readFile(sessionNote, "utf8");
  await fs.writeFile(sessionNote, original.replace("Parsed notes back into events.", "Edited summary."), "utf8");

  const kept = await importObsidianVault(workspace, config, vaultDir, { prefer: "bridge" });
  assert.deepEqual(kept.created.sessions, ["2026-09-22T08:00:00.000Z:codex"]);
  assert.deepEqual(kept.updated.sessions, []);
  assert.ok(kept.skippedConflicts.includes("session:2026-09-21T12:34:56.000Z:claude"));
  assert.equal(kept.projectContext, "skipped-conflict");

  const { events: sessionsAfterKeep } = await readSessionEvents(workspace, config);
  const codex = sessionsAfterKeep.find((event) => event.tool === "codex");
  assert.ok(codex);
  assert.deepEqual(codex.tags, ["refactor"]);
  assert.deepEqual(codex.artifacts, ["src/parser.ts"]);
  assert.ok(!codex.summary.includes("ghp_abcdefghijklmnopqrstuvwxyz0123456789"), "redaction must run on import");
  assert.ok(codex.summary.includes("[REDACTED"), codex.summary);
  assert.equal(sessionsAfterKeep.find((event) => event.tool === "claude")?.summary, "Parsed notes back into events.");

  const pulled = await importObsidianVault(workspace, config, vaultDir);
  assert.deepEqual(pulled.updated.sessions, ["2026-09-21T12:34:56.000Z:claude"]);
  assert.equal(pulled.projectContext, "updated");
  const { events: sessionsAfterPull } = await readSessionEvents(workspace, config);
  assert.equal(sessionsAfterPull.length, 2);
  assert.equal(sessionsAfterPull.find((event) => event.tool === "claude")?.summary, "Edited summary.");
  const projectContext = await fs.readFile(path.join(workspace, ".memory-bridge", "project-context.md"), "utf8");
  assert.ok(projectContext.includes("Edited in the vault."));
  assert.ok(!projectContext.startsWith("---"), "frontmatter added by export must be stripped");
});

test("loadConfig preserves the integrations block (vaultDir, autoSync, autoImport, prefer) and drops junk", async () => {
  const workspace = await makeTempWorkspace("mb-config-integrations-");
  const { config } = await initWorkspace({ workspace });
  await fs.writeFile(
    path.join(workspace, ".memory-bridge", "config.json"),
    JSON.stringify(
      {
        ...config,
        integrations: {
          ce: { autoSync: false, junk: 1 },
          obsidian: { vaultDir: "/tmp/vault", autoSync: false, autoImport: true, prefer: "bridge", other: "x" }
        }
      },
      null,
      2
    ),
    "utf8"
  );
  const { config: loaded } = await loadConfig(workspace);
  assert.deepEqual(loaded.integrations, {
    ce: { autoSync: false },
    obsidian: { vaultDir: "/tmp/vault", autoSync: false, autoImport: true, prefer: "bridge" }
  });

  await fs.writeFile(
    path.join(workspace, ".memory-bridge", "config.json"),
    JSON.stringify({ ...config, integrations: { obsidian: { prefer: "nobody", vaultDir: "" } } }, null, 2),
    "utf8"
  );
  const { config: sanitized } = await loadConfig(workspace);
  assert.deepEqual(sanitized.integrations, { obsidian: {} });
});

test("CLI: obsidian import / sync / --prefer validation, and resume auto-import via config", async () => {
  const { workspace, vaultDir, config } = await seededWorkspace();
  const bin = path.resolve(process.cwd(), "dist/src/cli/bin.js");
  const run = (...args: string[]) =>
    spawnSync(process.execPath, [bin, ...args, "--workspace", workspace, "--json"], { encoding: "utf-8" });

  const exported = run("obsidian", "--vault", vaultDir);
  assert.equal(exported.status, 0, exported.stderr);
  assert.equal(JSON.parse(exported.stdout).command, "obsidian export");

  // dec-new-sqlite is the ACTIVE decision (dec-old-cache is superseded and never shows in resume)
  const notePath = path.join(vaultDir, "Decisions", "dec-new-sqlite.md");
  await fs.writeFile(notePath, (await fs.readFile(notePath, "utf8")).replace("Switch to SQLite", "Switch to SQLite 7"), "utf8");

  const imported = run("obsidian", "import", "--vault", vaultDir);
  assert.equal(imported.status, 0, imported.stderr);
  const importedJson = JSON.parse(imported.stdout);
  assert.equal(importedJson.command, "obsidian import");
  assert.deepEqual(importedJson.import.updated.decisions, ["dec-new-sqlite"]);

  const bad = run("obsidian", "import", "--vault", vaultDir, "--prefer", "nobody");
  assert.notEqual(bad.status, 0);

  const synced = run("obsidian", "sync", "--vault", vaultDir, "--prefer", "bridge");
  assert.equal(synced.status, 0, synced.stderr);
  const syncedJson = JSON.parse(synced.stdout);
  assert.equal(syncedJson.command, "obsidian sync");
  assert.ok(Array.isArray(syncedJson.createdFiles));
  assert.equal(syncedJson.import.unchanged, 4);

  // resume with autoImport pulls a vault edit before rendering
  const configPath = path.join(workspace, ".memory-bridge", "config.json");
  await fs.writeFile(
    configPath,
    JSON.stringify({ ...config, integrations: { obsidian: { vaultDir, autoImport: true, autoSync: false } } }, null, 2),
    "utf8"
  );
  await fs.writeFile(notePath, (await fs.readFile(notePath, "utf8")).replace("Switch to SQLite 7", "Switch to SQLite 8"), "utf8");
  const resumed = run("resume", "--for", "claude");
  assert.equal(resumed.status, 0, resumed.stderr);
  const resumeText: string = JSON.parse(resumed.stdout).resume;
  assert.ok(resumeText.includes("Switch to SQLite 8"), resumeText);
  const { events: afterResume } = await readDecisionEvents(workspace, config);
  assert.equal(afterResume.find((event) => event.id === "dec-new-sqlite")?.decision, "Switch to SQLite 8");

  const lint = run("lint");
  assert.equal(lint.status, 0, lint.stderr);
});
