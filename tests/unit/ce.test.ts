import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { syncCompoundEngineering, generateAgentsMdContent, generateCursorrulesContent, generateClaudeMdContent } from "../../src/core/ce.js";
import { initWorkspace, loadConfig } from "../../src/core/config.js";
import type { DecisionEvent } from "../../src/types/events.js";
import { appendDecisionEvent } from "../../src/core/store.js";

test("generateAgentsMdContent embeds Memory Bridge lifecycle protocol and decisions", () => {
  const content = generateAgentsMdContent("- **[dec-1] Title**: Choice", "Project rule text");
  assert.match(content, /AGENTS\.md — Universal AI Agent Guidelines/);
  assert.match(content, /Memory Bridge Lifecycle Protocol/);
  assert.match(content, /Project rule text/);
  assert.match(content, /\[dec-1\] Title/);
});

test("syncCompoundEngineering creates and updates rule files in workspace", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "mb-ce-test-"));

  try {
    await initWorkspace({ workspace: tmpDir });
    const { config } = await loadConfig(tmpDir);

    const event: DecisionEvent = {
      id: "dec-ce-1",
      ts: new Date().toISOString(),
      title: "Use Node Stdlib",
      decision: "Zero runtime dependencies",
      context: "Keep footprint minimal",
      impact: "High stability",
      supersedes: []
    };
    await appendDecisionEvent(tmpDir, config, event);

    const result = await syncCompoundEngineering(tmpDir, config);

    assert.equal(result.activeDecisionsCount, 1);
    assert.ok(result.createdFiles.length > 0 || result.updatedFiles.length > 0);

    const agentsMdPath = path.join(tmpDir, "AGENTS.md");
    const cursorrulesPath = path.join(tmpDir, ".cursorrules");
    const claudeMdPath = path.join(tmpDir, "CLAUDE.md");
    const copilotPath = path.join(tmpDir, ".github", "copilot-instructions.md");

    const agentsMd = await fs.readFile(agentsMdPath, "utf-8");
    const cursorrules = await fs.readFile(cursorrulesPath, "utf-8");
    const claudeMd = await fs.readFile(claudeMdPath, "utf-8");
    const copilot = await fs.readFile(copilotPath, "utf-8");

    assert.match(agentsMd, /dec-ce-1/);
    assert.match(cursorrules, /dec-ce-1/);
    assert.match(claudeMd, /dec-ce-1/);
    assert.match(copilot, /dec-ce-1/);

  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});
