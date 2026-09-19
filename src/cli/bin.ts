#!/usr/bin/env node

import path from "node:path";

import { getBoolFlag, getListFlag, getStringFlag, parseArgs } from "./args.js";
import { fail, printOutput } from "./output.js";
import { initWorkspace, loadConfig } from "../core/config.js";
import { runConsolidation } from "../core/consolidate.js";
import { buildContextSnapshot, renderHandoffMarkdown, renderResumeText } from "../core/context.js";
import { runDoctor } from "../core/doctor.js";
import { currentGitBranch, resolveWorkspaceWithGitFallback } from "../core/git.js";
import { runLint } from "../core/lint.js";
import { searchMemory, type SearchMode } from "../core/search.js";
import { appendDecisionEvent, appendSessionEvent, saveHandoff } from "../core/store.js";
import { redactUnknown } from "../core/redaction.js";
import { semanticEnabled, upsertSemanticDoc } from "../core/vector.js";
import { startUiServer } from "../ui/server.js";
import type { DecisionEvent, SessionEvent } from "../types/events.js";

function usage(): string {
  return `memory-bridge

Commands:
  init [--workspace <path>] [--project-name <name>] [--encryption] [--semantic] [--no-redaction] [--json]
  log --tool <tool> --intent <intent> --summary <summary> [--actions a,b] [--artifacts a,b] [--tags a,b] [--task-id <id>] [--parent-task-id <id>] [--workspace <path>] [--branch <name>] [--json]
  decision add --title <title> --decision <decision> [--context <text>] [--impact <text>] [--id <id>] [--supersedes a,b] [--workspace <path>] [--json]
  handoff build [--workspace <path>] [--json]
  resume --for <tool> [--workspace <path>] [--json]
  lint [--workspace <path>] [--json]
  consolidate [--workspace <path>] [--json]
  doctor [--workspace <path>] [--json]
  search <query> [--mode text|semantic|hybrid] [--limit <n>] [--workspace <path>] [--json]
  hook print <zsh|bash|fish|aider|claude|git> [--json]
  ui [--workspace <path>] [--host <host>] [--port <n>] [--readonly] [--json]
`;
}

function requireString(value: string | undefined, name: string, asJson: boolean): string {
  if (!value || value.trim() === "") {
    fail(`Missing required argument: ${name}`, asJson);
  }
  return value;
}

function parseLimit(raw: string | undefined, fallback: number): number {
  if (!raw) {
    return fallback;
  }
  const parsed = Number.parseInt(raw, 10);
  if (Number.isNaN(parsed) || parsed <= 0) {
    return fallback;
  }
  return parsed;
}

function normalizeWorkspace(raw: string | undefined): string {
  if (raw && raw.trim() !== "") {
    return path.resolve(raw);
  }
  return resolveWorkspaceWithGitFallback(process.cwd());
}

async function commandInit(argv: string[], asJson: boolean): Promise<void> {
  const parsed = parseArgs(argv);
  const workspace = normalizeWorkspace(getStringFlag(parsed, "workspace"));
  const initArgs = {
    workspace,
    enableEncryption: getBoolFlag(parsed, "encryption", false),
    enableSemanticSearch: getBoolFlag(parsed, "semantic", false),
    disableRedaction: getBoolFlag(parsed, "no-redaction", false)
  };
  const projectName = getStringFlag(parsed, "project-name");
  const result = await initWorkspace(
    projectName ? { ...initArgs, projectName } : initArgs
  );

  printOutput(
    {
      ok: true,
      command: "init",
      workspace,
      created: result.created,
      updated: result.updated,
      config: result.config
    },
    asJson
  );
}

async function commandLog(argv: string[], asJson: boolean): Promise<void> {
  const parsed = parseArgs(argv);
  const workspace = normalizeWorkspace(getStringFlag(parsed, "workspace"));
  const { config } = await loadConfig(workspace);

  const ts = new Date().toISOString();
  const tool = requireString(getStringFlag(parsed, "tool"), "--tool", asJson);
  const intent = requireString(getStringFlag(parsed, "intent"), "--intent", asJson);
  const summary = requireString(getStringFlag(parsed, "summary"), "--summary", asJson);
  const taskId = getStringFlag(parsed, "task-id");
  const parentTaskId = getStringFlag(parsed, "parent-task-id");

  const event: SessionEvent = {
    ts,
    tool,
    workspace,
    branch: getStringFlag(parsed, "branch") || currentGitBranch(workspace),
    intent,
    actions: getListFlag(parsed, "actions"),
    artifacts: getListFlag(parsed, "artifacts"),
    summary,
    tags: getListFlag(parsed, "tags"),
    ...(taskId ? { taskId } : {}),
    ...(parentTaskId ? { parentTaskId } : {})
  };

  const redactedEvent = config.redaction.enabled
    ? redactUnknown(event, config.redaction.customPatterns)
    : event;

  const persist = await appendSessionEvent(workspace, config, redactedEvent);

  if (semanticEnabled(config)) {
    await upsertSemanticDoc(workspace, config, {
      id: `session:${redactedEvent.ts}:${redactedEvent.tool}`,
      source: "sessions",
      ts: redactedEvent.ts,
      ref: `session:${redactedEvent.ts}`,
      text: [redactedEvent.intent, redactedEvent.summary, ...redactedEvent.actions, ...redactedEvent.artifacts, ...redactedEvent.tags].join("\n")
    });
  }

  printOutput(
    {
      ok: true,
      command: "log",
      event: redactedEvent,
      persistedAt: persist.file,
      encrypted: persist.encrypted
    },
    asJson
  );
}

async function commandDecisionAdd(argv: string[], asJson: boolean): Promise<void> {
  const parsed = parseArgs(argv);
  const workspace = normalizeWorkspace(getStringFlag(parsed, "workspace"));
  const { config } = await loadConfig(workspace);

  const event: DecisionEvent = {
    id: getStringFlag(parsed, "id") || `dec-${Date.now().toString(36)}`,
    ts: new Date().toISOString(),
    title: requireString(getStringFlag(parsed, "title"), "--title", asJson),
    context: getStringFlag(parsed, "context") || "N/A",
    decision: requireString(getStringFlag(parsed, "decision"), "--decision", asJson),
    impact: getStringFlag(parsed, "impact") || "N/A",
    supersedes: getListFlag(parsed, "supersedes")
  };

  const redactedEvent = config.redaction.enabled
    ? redactUnknown(event, config.redaction.customPatterns)
    : event;

  const persist = await appendDecisionEvent(workspace, config, redactedEvent);

  if (semanticEnabled(config)) {
    await upsertSemanticDoc(workspace, config, {
      id: `decision:${redactedEvent.id}`,
      source: "decisions",
      ts: redactedEvent.ts,
      ref: `decision:${redactedEvent.id}`,
      text: [redactedEvent.title, redactedEvent.context, redactedEvent.decision, redactedEvent.impact, ...redactedEvent.supersedes].join("\n")
    });
  }

  printOutput(
    {
      ok: true,
      command: "decision add",
      event: redactedEvent,
      persistedAt: persist.file,
      encrypted: persist.encrypted
    },
    asJson
  );
}

async function commandHandoffBuild(argv: string[], asJson: boolean): Promise<void> {
  const parsed = parseArgs(argv);
  const workspace = normalizeWorkspace(getStringFlag(parsed, "workspace"));
  const { config } = await loadConfig(workspace);

  const context = await buildContextSnapshot(workspace, config);
  const recentArtifacts = context.sessions
    .slice(-8)
    .flatMap((session) => session.artifacts)
    .slice(-12);

  const markdown = renderHandoffMarkdown({
    objective: context.snapshot.objective,
    recentDecisions: context.snapshot.recentDecisions,
    pending: context.snapshot.pending,
    nextSteps: context.snapshot.nextSteps,
    recentArtifacts
  });

  const persist = await saveHandoff(workspace, config, markdown);

  if (semanticEnabled(config)) {
    await upsertSemanticDoc(workspace, config, {
      id: "handoff:latest",
      source: "handoff",
      ts: new Date().toISOString(),
      ref: "handoff.md",
      text: markdown
    });
  }

  if (asJson) {
    printOutput(
      {
        ok: true,
        command: "handoff build",
        persistedAt: persist.file,
        encrypted: persist.encrypted,
        warnings: context.snapshot.warnings,
        markdown
      },
      true
    );
    return;
  }

  printOutput(markdown, false);
}

async function commandResume(argv: string[], asJson: boolean): Promise<void> {
  const parsed = parseArgs(argv);
  const workspace = normalizeWorkspace(getStringFlag(parsed, "workspace"));
  const targetTool = requireString(getStringFlag(parsed, "for"), "--for", asJson);
  const { config, warnings: configWarnings } = await loadConfig(workspace);

  const context = await buildContextSnapshot(workspace, config);
  const mergedWarnings = [...configWarnings, ...context.snapshot.warnings];
  const snapshot = { ...context.snapshot, warnings: mergedWarnings };
  const resumeText = renderResumeText(targetTool, snapshot);

  if (asJson) {
    printOutput(
      {
        ok: true,
        command: "resume",
        tool: targetTool,
        workspace,
        snapshot,
        resume: resumeText
      },
      true
    );
    return;
  }

  printOutput(resumeText, false);
}

async function commandDoctor(argv: string[], asJson: boolean): Promise<void> {
  const parsed = parseArgs(argv);
  const workspace = normalizeWorkspace(getStringFlag(parsed, "workspace"));
  const { config } = await loadConfig(workspace);
  const result = await runDoctor(workspace, config);

  if (asJson) {
    printOutput({ ok: result.ok, command: "doctor", result }, true);
  } else {
    const lines = [
      `Doctor: ${result.ok ? "OK" : "FAIL"}`,
      ...result.checks.map((check) => {
        const icon = check.ok ? "[ok]" : check.severity === "error" ? "[error]" : "[warn]";
        return `${icon} ${check.name}: ${check.message}`;
      })
    ];
    printOutput(lines.join("\n"), false);
  }

  if (!result.ok) {
    process.exitCode = 1;
  }
}

async function commandSearch(argv: string[], asJson: boolean): Promise<void> {
  const parsed = parseArgs(argv);
  const workspace = normalizeWorkspace(getStringFlag(parsed, "workspace"));
  const query = requireString(parsed.positionals[0], "<query>", asJson);
  const modeRaw = getStringFlag(parsed, "mode", "text") || "text";
  const mode: SearchMode = modeRaw === "semantic" ? "semantic" : modeRaw === "hybrid" ? "hybrid" : "text";
  const limit = parseLimit(getStringFlag(parsed, "limit"), 10);

  const { config } = await loadConfig(workspace);
  const result = await searchMemory({ workspace, config, query, mode, limit });

  if (asJson) {
    printOutput(
      {
        ok: true,
        command: "search",
        mode,
        query,
        hits: result.hits,
        warnings: result.warnings
      },
      true
    );
    return;
  }

  const lines: string[] = [`Search (${mode}) for: ${query}`];
  for (const hit of result.hits) {
    lines.push(`- [${hit.source}] score=${hit.score.toFixed(4)} ref=${hit.ref || "n/a"}`);
    lines.push(`  ${hit.snippet.replace(/\s+/g, " ")}`);
  }
  if (result.warnings.length > 0) {
    lines.push("Warnings:");
    lines.push(...result.warnings.map((warning) => `- ${warning}`));
  }
  printOutput(lines.join("\n"), false);
}

async function commandUi(argv: string[], asJson: boolean): Promise<void> {
  const parsed = parseArgs(argv);
  const workspace = normalizeWorkspace(getStringFlag(parsed, "workspace"));
  const host = getStringFlag(parsed, "host", "127.0.0.1") || "127.0.0.1";
  const port = parseLimit(getStringFlag(parsed, "port"), 8787);
  const readonly = getBoolFlag(parsed, "readonly", false);

  const server = await startUiServer({ workspace, host, port, readonly });
  const payload = {
    ok: true,
    command: "ui",
    workspace,
    host,
    port,
    readonly,
    url: server.url
  };

  if (asJson) {
    printOutput(payload, true);
  } else {
    printOutput(`Memory Bridge UI running at ${server.url}`, false);
  }

  const shutdown = async () => {
    await server.close();
    process.exit(0);
  };
  process.on("SIGINT", () => {
    void shutdown();
  });
  process.on("SIGTERM", () => {
    void shutdown();
  });
}

function generateHookSnippet(target: string): string {
  switch (target.toLowerCase()) {
    case "zsh":
    case "bash":
      return `# engrene-memory-bridge shell hook
# Add to ~/.zshrc or ~/.bashrc:
mb_wrap() {
  local tool="$1"
  shift
  memory-bridge resume --for "$tool"
  "$tool" "$@"
  local code=$?
  echo "Session finished (exit code $code). Run: memory-bridge log --tool $tool ..."
  return $code
}
alias mb-claude-wrap="mb_wrap claude"
alias mb-aider-wrap="mb_wrap aider"
alias mb-codex-wrap="mb_wrap codex"
`;
    case "fish":
      return `# engrene-memory-bridge fish hook
# Add to ~/.config/fish/functions/mb_wrap.fish:
function mb_wrap
  set tool $argv[1]
  set -e argv[1]
  memory-bridge resume --for $tool
  $tool $argv
  set code $status
  echo "Session finished (exit code $code). Run: memory-bridge log --tool $tool ..."
  return $code
end
`;
    case "aider":
      return `# .aider.conf.yml snippet
# Add to your repository root:
auto-commits: false
attribute-author: false
read:
  - .memory-bridge/handoff.md
  - .memory-bridge/project-context.md
`;
    case "claude":
      return `# Claude Code / CLI prompt instruction snippet
Before answering or editing files, read .memory-bridge/handoff.md and recent decisions in .memory-bridge/decisions.jsonl.
When concluding your task, provide a concise summary with intent, actions, and modified artifacts so it can be logged via memory-bridge log.
`;
    case "git":
      return `#!/usr/bin/env bash
# Git post-checkout hook for engrene-memory-bridge
# Save as .git/hooks/post-checkout and chmod +x .git/hooks/post-checkout
if command -v memory-bridge >/dev/null 2>&1; then
  if [ -d ".memory-bridge" ]; then
    echo "=== Memory Bridge Context ==="
    memory-bridge resume --for git-checkout 2>/dev/null || true
  fi
fi
`;
    default:
      return `# Unknown hook target: ${target}. Supported targets: zsh, bash, fish, aider, claude, git\n`;
  }
}

async function commandHook(argv: string[], asJson: boolean): Promise<void> {
  const action = argv[0];
  const target = argv[1];

  if (!action || action !== "print" || !target) {
    fail("Usage: memory-bridge hook print <zsh|bash|fish|aider|claude|git> [--json]", asJson);
  }

  const snippet = generateHookSnippet(target);
  if (asJson) {
    printOutput(
      {
        ok: true,
        command: "hook print",
        target,
        snippet
      },
      true
    );
    return;
  }

  printOutput(snippet, false);
}

async function commandLint(argv: string[], asJson: boolean): Promise<void> {
  const parsed = parseArgs(argv);
  const workspace = normalizeWorkspace(getStringFlag(parsed, "workspace"));
  const { config } = await loadConfig(workspace);
  const result = await runLint(workspace, config);

  if (asJson) {
    printOutput({ ok: result.ok, command: "lint", result }, true);
  } else {
    const lines = [
      `Memory Lint: ${result.ok ? "PASS" : "FAIL"}`,
      `Stats: ${result.stats.sessionCount} sessions (${result.stats.sessionFilesCount} files), ${result.stats.decisionCount} decisions`
    ];
    if (result.errors.length > 0) {
      lines.push("Errors:");
      lines.push(...result.errors.map((e) => `  [error] ${e}`));
    }
    if (result.warnings.length > 0) {
      lines.push("Warnings:");
      lines.push(...result.warnings.map((w) => `  [warn] ${w}`));
    }
    printOutput(lines.join("\n"), false);
  }

  if (!result.ok) {
    process.exitCode = 1;
  }
}

async function commandConsolidate(argv: string[], asJson: boolean): Promise<void> {
  const parsed = parseArgs(argv);
  const workspace = normalizeWorkspace(getStringFlag(parsed, "workspace"));
  const { config } = await loadConfig(workspace);
  const result = await runConsolidation(workspace, config);

  if (asJson) {
    printOutput({ ok: result.ok, command: "consolidate", result }, true);
  } else {
    const lines = [
      `Memory Consolidate: OK`,
      `Active Decisions: ${result.activeDecisions} (Superseded: ${result.supersededDecisions})`,
      `Handoff Refreshed: ${result.handoffRefreshed ? "yes" : "no"}`
    ];
    if (result.supersededIds.length > 0) {
      lines.push(`Superseded IDs: ${result.supersededIds.join(", ")}`);
    }
    if (result.warnings.length > 0) {
      lines.push("Warnings:");
      lines.push(...result.warnings.map((w) => `  [warn] ${w}`));
    }
    printOutput(lines.join("\n"), false);
  }
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const asJson = argv.includes("--json");
  const cleanArgv = argv.filter((arg) => arg !== "--json");

  if (cleanArgv.length === 0 || cleanArgv.includes("--help") || cleanArgv.includes("-h")) {
    printOutput(usage(), false);
    return;
  }

  const command = cleanArgv[0];
  const commandArgs = cleanArgv.slice(1);

  if (command === "init") {
    await commandInit(commandArgs, asJson);
    return;
  }

  if (command === "log") {
    await commandLog(commandArgs, asJson);
    return;
  }

  if (command === "decision" && commandArgs[0] === "add") {
    await commandDecisionAdd(commandArgs.slice(1), asJson);
    return;
  }

  if (command === "handoff" && commandArgs[0] === "build") {
    await commandHandoffBuild(commandArgs.slice(1), asJson);
    return;
  }

  if (command === "resume") {
    await commandResume(commandArgs, asJson);
    return;
  }

  if (command === "lint") {
    await commandLint(commandArgs, asJson);
    return;
  }

  if (command === "consolidate") {
    await commandConsolidate(commandArgs, asJson);
    return;
  }

  if (command === "doctor") {
    await commandDoctor(commandArgs, asJson);
    return;
  }

  if (command === "search") {
    await commandSearch(commandArgs, asJson);
    return;
  }

  if (command === "hook") {
    await commandHook(commandArgs, asJson);
    return;
  }

  if (command === "ui") {
    await commandUi(commandArgs, asJson);
    return;
  }

  fail(`Unknown command.\n\n${usage()}`, asJson);
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exit(1);
});
