import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { initWorkspace } from "../../src/core/config.js";
import { runConsolidation } from "../../src/core/consolidate.js";
import { runLint } from "../../src/core/lint.js";
import { appendDecisionEvent, appendSessionEvent } from "../../src/core/store.js";
import { validateSessionEvent } from "../../src/core/schema.js";

test("validateSessionEvent accepts taskId and parentTaskId", () => {
  const event = {
    ts: new Date().toISOString(),
    tool: "orca",
    workspace: "/tmp/test",
    branch: "main",
    intent: "Multi-agent subtask",
    actions: ["TODO: verify subagent"],
    artifacts: ["src/test.ts"],
    summary: "Subagent finished step",
    tags: ["orca", "subagent"],
    taskId: "task-101",
    parentTaskId: "task-root"
  };

  assert.equal(validateSessionEvent(event), true);
});

test("runLint and runConsolidation validate and organize project memory", async () => {
  const tempDir = path.join(process.cwd(), `tmp-test-lint-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  await fs.mkdir(tempDir, { recursive: true });

  try {
    const { config } = await initWorkspace({ workspace: tempDir });

    // Append session event with taskId
    await appendSessionEvent(tempDir, config, {
      ts: new Date().toISOString(),
      tool: "claude",
      workspace: tempDir,
      branch: "main",
      intent: "Setup test session",
      actions: ["TODO: write e2e test"],
      artifacts: ["test.ts"],
      summary: "Created test session",
      tags: ["test"],
      taskId: "task-1"
    });

    // Append decision 1
    await appendDecisionEvent(tempDir, config, {
      id: "dec-1",
      ts: new Date().toISOString(),
      title: "Initial Decision",
      context: "Context 1",
      decision: "Approach A",
      impact: "Low",
      supersedes: []
    });

    // Append decision 2 that supersedes decision 1
    await appendDecisionEvent(tempDir, config, {
      id: "dec-2",
      ts: new Date().toISOString(),
      title: "Updated Decision",
      context: "Context 2",
      decision: "Approach B",
      impact: "High",
      supersedes: ["dec-1"]
    });

    // Test Lint
    const lintRes = await runLint(tempDir, config);
    assert.equal(lintRes.ok, true);
    assert.equal(lintRes.stats.decisionCount, 2);
    assert.equal(lintRes.stats.sessionCount, 1);

    // Test Consolidate
    const consRes = await runConsolidation(tempDir, config);
    assert.equal(consRes.ok, true);
    assert.equal(consRes.totalDecisions, 2);
    assert.equal(consRes.activeDecisions, 1);
    assert.equal(consRes.supersededDecisions, 1);
    assert.deepEqual(consRes.supersededIds, ["dec-1"]);
    assert.equal(consRes.handoffRefreshed, true);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});
