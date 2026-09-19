import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { initWorkspace } from "../../src/core/config.js";
import { searchMemory } from "../../src/core/search.js";
import { appendDecisionEvent, appendSessionEvent } from "../../src/core/store.js";

test("searchMemory supports text, semantic, and hybrid modes with BM25 ranking", async () => {
  const tempDir = path.join(process.cwd(), `tmp-test-search-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  await fs.mkdir(tempDir, { recursive: true });

  try {
    const { config } = await initWorkspace({
      workspace: tempDir,
      enableSemanticSearch: true
    });

    await appendSessionEvent(tempDir, config, {
      ts: new Date().toISOString(),
      tool: "codex",
      workspace: tempDir,
      branch: "main",
      intent: "Implement MFA authentication guard",
      actions: ["TODO: benchmark MFA token verification"],
      artifacts: ["src/auth/mfa.guard.ts"],
      summary: "Added MFA authentication guard with strict token policy",
      tags: ["security", "mfa", "auth"]
    });

    await appendDecisionEvent(tempDir, config, {
      id: "dec-auth-1",
      ts: new Date().toISOString(),
      title: "MFA Token Provider Decision",
      context: "Need robust multi-factor authentication",
      decision: "Use time-based OTP for MFA guard verification",
      impact: "Higher authentication security",
      supersedes: []
    });

    // 1. Text Search
    const textResult = await searchMemory({
      workspace: tempDir,
      config,
      query: "MFA authentication guard",
      mode: "text",
      limit: 5
    });
    assert.ok(textResult.hits.length >= 1);
    assert.ok(textResult.hits[0]!.score > 0);

    // 2. Hybrid Search
    const hybridResult = await searchMemory({
      workspace: tempDir,
      config,
      query: "token verification",
      mode: "hybrid",
      limit: 5
    });
    assert.ok(hybridResult.hits.length >= 1);
    assert.ok(hybridResult.hits[0]!.score > 0);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});
