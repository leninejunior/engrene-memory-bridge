import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { initWorkspace } from "../../src/core/config.js";
import { syncObsidianVault, formatObsidianDecisionNote, formatObsidianSessionNote } from "../../src/core/obsidian.js";
import { appendDecisionEvent, appendSessionEvent } from "../../src/core/store.js";
import { generateEmbedding } from "../../src/core/vector.js";
import { makeTempWorkspace } from "../helpers.js";
import type { DecisionEvent, SessionEvent } from "../../src/types/events.js";

test("syncObsidianVault exports decisions and sessions with wikilinks and YAML frontmatter", async () => {
  const workspace = await makeTempWorkspace("mb-obsidian-test-");
  const vaultDir = path.join(workspace, "my-obsidian-vault");
  const { config } = await initWorkspace({ workspace, enableSemanticSearch: true });

  const oldDecision: DecisionEvent = {
    id: "dec-old-cache",
    ts: "2026-09-21T10:00:00.000Z",
    title: "Use Redis Cache",
    context: "Fast in-memory cache",
    decision: "Adopt Redis",
    impact: "High RAM usage",
    supersedes: []
  };

  const newDecision: DecisionEvent = {
    id: "dec-new-sqlite",
    ts: "2026-09-21T11:00:00.000Z",
    title: "Use Local SQLite",
    context: "Redis is heavy",
    decision: "Switch to SQLite",
    impact: "Zero external daemons",
    supersedes: ["dec-old-cache"]
  };

  const session: SessionEvent = {
    ts: "2026-09-21T12:00:00.000Z",
    tool: "qoder",
    workspace,
    branch: "main",
    intent: "Implement Obsidian integration",
    summary: "Exported Markdown notes with wikilinks and YAML frontmatter",
    actions: ["Created obsidian.ts"],
    artifacts: ["src/core/obsidian.ts"],
    tags: ["obsidian", "feature"]
  };

  await appendDecisionEvent(workspace, config, oldDecision);
  await appendDecisionEvent(workspace, config, newDecision);
  await appendSessionEvent(workspace, config, session);

  const result = await syncObsidianVault(workspace, config, vaultDir);

  assert.equal(result.totalDecisions, 2);
  assert.equal(result.totalSessions, 1);
  assert.ok(result.createdFiles.length >= 3);

  // Check decision file with wikilink
  const newDecNote = await fs.readFile(path.join(vaultDir, "Decisions", "dec-new-sqlite.md"), "utf8");
  assert.ok(newDecNote.includes('[[dec-old-cache]]'));
  assert.ok(newDecNote.includes("tags:\n  - memory-bridge\n  - decision"));

  // Check session file
  const sessionFiles = await fs.readdir(path.join(vaultDir, "Sessions"));
  assert.ok(sessionFiles.length >= 1);
  const sessionNote = await fs.readFile(path.join(vaultDir, "Sessions", sessionFiles[0]!), "utf8");
  assert.ok(sessionNote.includes("Implement Obsidian integration"));
});

test("generateEmbedding supports jev provider", async () => {
  const workspace = await makeTempWorkspace("mb-jev-test-");
  const { config } = await initWorkspace({ workspace });

  const jevConfig = {
    ...config,
    semanticSearch: {
      enabled: true,
      provider: "jev" as const,
      dimensions: 256
    }
  };

  const vec = await generateEmbedding("Authentication error in login handler", jevConfig);
  assert.equal(vec.length, 256);
  assert.ok(vec.some((val) => val !== 0));
});
