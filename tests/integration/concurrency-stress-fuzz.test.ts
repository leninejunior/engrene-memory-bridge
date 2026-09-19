import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { initWorkspace } from "../../src/core/config.js";
import { buildContextSnapshot } from "../../src/core/context.js";
import { runLint } from "../../src/core/lint.js";
import { appendDecisionEvent, appendSessionEvent, readDecisionEvents, readSessionEvents } from "../../src/core/store.js";
import { resolveBridgePaths } from "../../src/core/paths.js";

test("high-concurrency stress test with 25 parallel writes and fuzzing corruption resilience", async () => {
  const tempDir = path.join(process.cwd(), `tmp-test-stress-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  await fs.mkdir(tempDir, { recursive: true });

  try {
    const { config } = await initWorkspace({ workspace: tempDir });

    // 1. Run 25 parallel session logs
    const sessionPromises = Array.from({ length: 25 }).map((_, i) =>
      appendSessionEvent(tempDir, config, {
        ts: new Date(Date.now() + i * 10).toISOString(),
        tool: `agent-${i % 5}`,
        workspace: tempDir,
        branch: "main",
        intent: `Concurrent intent ${i}`,
        actions: [`TODO: action ${i}`],
        artifacts: [`file-${i}.ts`],
        summary: `Finished parallel task ${i}`,
        tags: ["stress", `worker-${i}`],
        taskId: `task-${i}`
      })
    );

    // 2. Run 15 parallel decision writes
    const decisionPromises = Array.from({ length: 15 }).map((_, i) =>
      appendDecisionEvent(tempDir, config, {
        id: `dec-stress-${i}`,
        ts: new Date(Date.now() + i * 10).toISOString(),
        title: `Stress Decision ${i}`,
        context: `Context for decision ${i}`,
        decision: `Approach ${i}`,
        impact: `Impact ${i}`,
        supersedes: []
      })
    );

    await Promise.all([...sessionPromises, ...decisionPromises]);

    // Verify all records were stored
    const sessionsRes = await readSessionEvents(tempDir, config, 100);
    assert.equal(sessionsRes.events.length, 25);

    const decisionsRes = await readDecisionEvents(tempDir, config, 100);
    assert.equal(decisionsRes.events.length, 15);

    // 3. Fuzzing / Corruption Injection: append broken/truncated JSON lines
    const paths = resolveBridgePaths(tempDir);
    await fs.appendFile(paths.decisionsFile, "INVALID_GARBAGE_JSON_LINE\n{\"truncated\": \n", "utf8");

    // Reading decisions must not crash, should return valid records + warnings
    const fuzzedDecisions = await readDecisionEvents(tempDir, config, 100);
    assert.equal(fuzzedDecisions.events.length, 15);
    assert.ok(fuzzedDecisions.warnings.length >= 2);

    // Context snapshot must not fail
    const context = await buildContextSnapshot(tempDir, config);
    assert.ok(context.snapshot.objective.length > 0);

    // Lint must report errors on the corrupted lines without crashing
    const lint = await runLint(tempDir, config);
    assert.equal(lint.ok, false);
    assert.ok(lint.errors.length >= 2);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});
