import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { initWorkspace } from "../../src/core/config.js";
import {
  buildObservationFromHook,
  parseClaudeHookPayload,
  relativizeWithinRoot,
  renderClaudeSettingsHook
} from "../../src/core/hooks.js";
import { readObservations } from "../../src/core/capture.js";
import { makeTempWorkspace } from "../helpers.js";

const BIN = path.resolve(process.cwd(), "dist/src/cli/bin.js");

/** Runs the hook exactly as Claude Code would: payload on stdin, nothing else. */
function runHook(payload: unknown, cwd: string) {
  return spawnSync(process.execPath, [BIN, "observe", "--stdin"], {
    input: typeof payload === "string" ? payload : JSON.stringify(payload),
    encoding: "utf-8",
    cwd
  });
}

function editPayload(cwd: string, filePath: string) {
  return {
    session_id: "sess-abc",
    transcript_path: "/tmp/t.jsonl",
    cwd,
    hook_event_name: "PostToolUse",
    tool_name: "Edit",
    tool_input: { file_path: filePath, old_string: "a", new_string: "b" }
  };
}

test("parses a PostToolUse payload into an observation with tool and file", () => {
  const parsed = parseClaudeHookPayload(JSON.stringify(editPayload("/repo", "/repo/src/a.ts")));
  assert.equal(parsed?.type, "tool_result");
  assert.equal(parsed?.tool, "claude");
  assert.equal(parsed?.sessionId, "sess-abc");
  assert.equal(parsed?.cwd, "/repo");
  // `consolidate` reads payload.tool and payload.files.
  assert.equal(parsed?.payload.tool, "Edit");
  assert.deepEqual(parsed?.payload.files, ["/repo/src/a.ts"]);
});

test("prompt and command text are withheld unless opted in", () => {
  const prompt = {
    session_id: "s",
    cwd: "/repo",
    hook_event_name: "UserPromptSubmit",
    user_prompt: "deploy to 10.0.0.9 using the prod key"
  };
  assert.equal(parseClaudeHookPayload(JSON.stringify(prompt))?.payload.prompt, undefined);
  assert.equal(
    parseClaudeHookPayload(JSON.stringify(prompt), { includePrompts: true })?.payload.prompt,
    "deploy to 10.0.0.9 using the prod key"
  );

  const bash = {
    session_id: "s",
    cwd: "/repo",
    hook_event_name: "PostToolUse",
    tool_name: "Bash",
    tool_input: { command: "ssh root@example.internal 'rm -rf /tmp/x'" }
  };
  assert.equal(parseClaudeHookPayload(JSON.stringify(bash))?.payload.command, undefined);
  assert.ok(parseClaudeHookPayload(JSON.stringify(bash), { includeCommands: true })?.payload.command);
});

test("unusable payloads are ignored rather than guessed at", () => {
  assert.equal(parseClaudeHookPayload("not json"), undefined);
  assert.equal(parseClaudeHookPayload("[]"), undefined);
  assert.equal(parseClaudeHookPayload("{}"), undefined, "no hook_event_name");
  assert.equal(parseClaudeHookPayload('{"hook_event_name":"PreCompact"}'), undefined, "unmapped event");
});

test("paths outside the workspace root are dropped", () => {
  assert.deepEqual(relativizeWithinRoot(["/repo/src/a.ts", "/etc/passwd", "/other/b.ts"], "/repo"), ["src/a.ts"]);
  const obs = buildObservationFromHook(
    parseClaudeHookPayload(JSON.stringify(editPayload("/repo", "/somewhere/else.ts")))!,
    "/repo"
  );
  assert.equal(obs.payload.files, undefined, "a file outside the repo leaves no trace");
});

test("the settings block targets editing tools and avoids PreToolUse and Stop", () => {
  const rendered = JSON.parse(renderClaudeSettingsHook("/abs/bin.js")) as {
    hooks: Record<string, Array<{ matcher?: string; hooks: Array<{ command: string; timeout: number }> }>>;
  };
  assert.deepEqual(Object.keys(rendered.hooks).sort(), ["PostToolUse", "SessionEnd", "SessionStart", "UserPromptSubmit"]);
  assert.equal(rendered.hooks.PostToolUse![0]!.matcher, "Edit|MultiEdit|Write|NotebookEdit|Bash");
  assert.equal(rendered.hooks.SessionStart![0]!.hooks[0]!.command, "/abs/bin.js observe --stdin");
  assert.ok(rendered.hooks.SessionStart![0]!.hooks[0]!.timeout <= 5, "a slow hook is felt on every event");
  assert.ok(!("PreToolUse" in rendered.hooks), "PreToolUse would double process spawns per tool call");
  assert.ok(!("Stop" in rendered.hooks), "Stop fires every turn, not at session end");
});

test("CLI hook mode records an observation, prints nothing, and always exits 0", async () => {
  const workspace = await makeTempWorkspace("mb-hook-");
  const { config } = await initWorkspace({ workspace });

  const res = runHook(editPayload(workspace, path.join(workspace, "src", "a.ts")), workspace);
  assert.equal(res.status, 0);
  assert.equal(res.stdout, "", "stdout is injected into the model's context on some events");

  const observations = await readObservations(workspace, 10);
  assert.equal(observations.length, 1);
  assert.equal(observations[0]!.type, "tool_result");
  assert.equal(observations[0]!.payload.tool, "Edit");
  assert.deepEqual(observations[0]!.payload.files, ["src/a.ts"], "stored relative to the repo");
  assert.equal(observations[0]!.payload.prompt, undefined);
  void config;
});

test("CLI hook mode survives garbage and never blocks the session", async () => {
  const workspace = await makeTempWorkspace("mb-hook-garbage-");
  await initWorkspace({ workspace });

  for (const bad of ["", "not json at all", "{", "[1,2,3]", '{"hook_event_name":"Nope"}']) {
    const res = runHook(bad, workspace);
    assert.equal(res.status, 0, `exit 0 required for input: ${bad}`);
    assert.equal(res.stdout, "");
  }
  assert.equal((await readObservations(workspace, 10)).length, 0);
});

test("an uninitialized directory is left untouched", async () => {
  const plain = await makeTempWorkspace("mb-hook-uninit-");
  const res = runHook(editPayload(plain, path.join(plain, "a.ts")), plain);
  assert.equal(res.status, 0);
  assert.equal(res.stdout, "");
  const created = await fs.stat(path.join(plain, ".memory-bridge")).then(() => true).catch(() => false);
  assert.equal(created, false, "a user-level hook must not scatter .memory-bridge/ across every repo");
});

test("session boundaries record files from git, since shell edits report no file_path", async () => {
  const workspace = await makeTempWorkspace("mb-hook-git-");
  await initWorkspace({ workspace });
  spawnSync("git", ["init", "-q", "-b", "main"], { cwd: workspace });
  spawnSync("git", ["config", "user.email", "t@l"], { cwd: workspace });
  spawnSync("git", ["config", "user.name", "t"], { cwd: workspace });
  await fs.writeFile(path.join(workspace, "calc.js"), "const a = 1;\n", "utf8");
  spawnSync("git", ["add", "-A"], { cwd: workspace });
  spawnSync("git", ["commit", "-qm", "init"], { cwd: workspace });
  // An edit made through the shell: no tool_input.file_path anywhere.
  await fs.writeFile(path.join(workspace, "calc.js"), "const a = 2;\n", "utf8");

  for (const event of ["SessionEnd", "UserPromptSubmit"]) {
    const res = runHook({ session_id: "s", cwd: workspace, hook_event_name: event }, workspace);
    assert.equal(res.status, 0);
    assert.equal(res.stdout, "");
  }

  const observations = await readObservations(workspace, 10);
  for (const type of ["session_end", "user_prompt"]) {
    const found = observations.find((o) => o.type === type);
    assert.ok(found, `${type} must be recorded`);
    // SessionEnd runs under a short budget and can be dropped, so user_prompt carries it too.
    assert.deepEqual(found.payload.files, ["calc.js"], `${type}: git sees what the tool payload never mentioned`);
    assert.equal(found.payload.branch, "main");
  }
});

test("hook print claude emits a valid settings block; the prose snippet stays under claude-prompt", () => {
  const asJson = spawnSync(process.execPath, [BIN, "hook", "print", "claude", "--json"], { encoding: "utf-8" });
  assert.equal(asJson.status, 0, asJson.stderr);
  const snippet = JSON.parse(asJson.stdout).snippet as string;
  // The header comments mention a JSON fragment, so take the block from the first line
  // that is exactly `{`, which is where the pasteable settings object starts.
  const lines = snippet.split("\n");
  const startLine = lines.findIndex((line) => line.trim() === "{");
  assert.ok(startLine >= 0, "the snippet must contain a pasteable JSON object on its own line");
  const parsed = JSON.parse(lines.slice(startLine).join("\n").trim()) as { hooks: Record<string, unknown> };
  assert.ok(parsed.hooks.SessionStart, "must be pasteable into settings.json");
  assert.ok(snippet.includes("observe --stdin"));

  const prose = spawnSync(process.execPath, [BIN, "hook", "print", "claude-prompt"], { encoding: "utf-8" });
  assert.equal(prose.status, 0);
  assert.ok(prose.stdout.includes("handoff.md"), "the old snippet must remain available");
});
