import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { initWorkspace } from "../../src/core/config.js";
import { detectLeakageRisk, redactUnknown } from "../../src/core/redaction.js";
import { makeTempWorkspace } from "../helpers.js";

async function gitignoreLines(workspace: string): Promise<string[]> {
  const text = await fs.readFile(path.join(workspace, ".gitignore"), "utf8").catch(() => "");
  return text.split(/\r?\n/).map((line) => line.trim()).filter((line) => line !== "");
}

test("init ignores .memory-bridge/ by default and stays idempotent", async () => {
  const workspace = await makeTempWorkspace("mb-gitignore-default-");
  await initWorkspace({ workspace });
  await initWorkspace({ workspace });
  const lines = await gitignoreLines(workspace);
  assert.deepEqual(lines.filter((line) => line === ".memory-bridge/"), [".memory-bridge/"]);
});

test("init respects a selective .gitignore (opt-in to committing memory)", async () => {
  const workspace = await makeTempWorkspace("mb-gitignore-optin-");
  const selective = ["node_modules/", ".memory-bridge/vector.sqlite", ".memory-bridge/.lock", ".memory-bridge/observations/"];
  await fs.writeFile(path.join(workspace, ".gitignore"), `${selective.join("\n")}\n`, "utf8");

  const result = await initWorkspace({ workspace });
  const lines = await gitignoreLines(workspace);

  assert.deepEqual(lines, selective, "init must not add .memory-bridge/ over a selective configuration");
  assert.ok(!result.updated.some((file) => file.endsWith(".gitignore")), "gitignore must not be reported as updated");
});

test("detectLeakageRisk ignores already-redacted placeholders and is deterministic across calls", () => {
  const redacted = redactUnknown("deploy with api_key: abc123XYZ and token=ghp_abcdefghijklmnopqrstuvwxyz0123456789");
  assert.ok(redacted.includes("[REDACTED]"), redacted);
  assert.deepEqual(detectLeakageRisk(redacted), [], "placeholders left by redaction are not leaks");
  assert.deepEqual(detectLeakageRisk(`{"summary":"key=[REDACTED_GITHUB_TOKEN] and api_key: [REDACTED]","tags":["test"]}`), []);

  const raw = "api_key: abc123XYZ";
  assert.deepEqual(detectLeakageRisk(raw), ["sensitive-assignment-pattern"]);
  assert.deepEqual(detectLeakageRisk(raw), ["sensitive-assignment-pattern"], "second call must not be affected by regex lastIndex");

  const openai = "sk-abcdefghijklmnopqrstuvwxyz0123";
  assert.ok(detectLeakageRisk(openai).includes("openai-key-pattern"));
  assert.ok(detectLeakageRisk(openai).includes("openai-key-pattern"), "global regex state must not hide the second hit");
});
