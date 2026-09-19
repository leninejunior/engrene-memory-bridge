import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { LocalFilesystemBackend } from "../../src/core/backend.js";
import { getMemoryStats } from "../../src/core/stats.js";
import { handleMcpToolCall } from "../../src/mcp/server.js";

test("LocalFilesystemBackend supports full memory lifecycle", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "mb-backend-test-"));
  const backend = new LocalFilesystemBackend();

  try {
    const { config } = await backend.initialize({ workspace: tmpDir });
    assert.equal(config.projectName, path.basename(tmpDir));

    await backend.appendSession(tmpDir, {
      ts: new Date().toISOString(),
      tool: "claude",
      workspace: tmpDir,
      branch: "main",
      intent: "Implement backend interface",
      actions: ["created backend.ts"],
      artifacts: ["src/core/backend.ts"],
      summary: "Abstracted storage into MemoryBackend",
      tags: ["refactor", "backend"]
    });

    await backend.appendDecision(tmpDir, {
      id: "dec-backend-01",
      ts: new Date().toISOString(),
      title: "Pluggable Storage Backend",
      decision: "Adopt MemoryBackend interface with LocalFilesystemBackend default",
      context: "Enable future backends without modifying core logic",
      impact: "Clean architectural decoupling",
      supersedes: []
    });

    await backend.saveHandoff(tmpDir, "# Handoff\n\n## Objective\nBackend complete\n");

    const handoff = await backend.getHandoff(tmpDir);
    assert.ok(handoff.text?.includes("Backend complete"));

    const { snapshot } = await backend.getContext(tmpDir, "claude");
    assert.equal(snapshot.objective, "Implement backend interface");
    assert.equal(snapshot.recentDecisions.length, 1);

    const stats = await getMemoryStats(tmpDir, config);
    assert.equal(stats.totalSessions, 1);
    assert.equal(stats.totalDecisions, 1);
    assert.equal(stats.activeDecisions, 1);
    assert.ok(stats.diskSizeBytes > 0);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test("handleMcpToolCall handles core MCP tool invocations", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "mb-mcp-test-"));
  const backend = new LocalFilesystemBackend();

  try {
    await backend.initialize({ workspace: tmpDir });

    // 1. memory_log via MCP
    const logRes = await handleMcpToolCall(
      "memory_log",
      {
        tool: "codex",
        intent: "Test MCP tool call",
        summary: "Called memory_log through JSON-RPC adapter",
        actions: ["log call"],
        artifacts: ["server.ts"],
        tags: ["mcp", "test"]
      },
      tmpDir
    );
    assert.equal(logRes.isError, undefined);
    assert.ok(logRes.text.includes("ok"));

    // 2. memory_decision via MCP
    const decRes = await handleMcpToolCall(
      "memory_decision",
      {
        title: "MCP First-class Tools",
        decision: "Provide 5 compact tools for MCP clients",
        context: "Low token overhead",
        impact: "Fast integration"
      },
      tmpDir
    );
    assert.equal(decRes.isError, undefined);
    assert.ok(decRes.text.includes("dec-"));

    // 3. memory_resume via MCP
    const resumeRes = await handleMcpToolCall("memory_resume", { tool: "codex" }, tmpDir);
    assert.equal(resumeRes.isError, undefined);
    assert.ok(resumeRes.text.includes("Test MCP tool call"));
    assert.ok(resumeRes.text.includes("MCP First-class Tools"));

    // 4. memory_handoff via MCP
    const handoffRes = await handleMcpToolCall("memory_handoff", { rebuild: true }, tmpDir);
    assert.equal(handoffRes.isError, undefined);
    assert.ok(handoffRes.text.includes("ok"));
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});
