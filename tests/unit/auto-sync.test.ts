import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { runAutoSyncIntegrations } from "../../src/core/auto-sync.js";
import { initWorkspace, loadConfig } from "../../src/core/config.js";

test("runAutoSyncIntegrations triggers CE sync by default", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "mb-auto-sync-test-"));

  try {
    await initWorkspace({ workspace: tmpDir });
    const { config } = await loadConfig(tmpDir);

    const result = await runAutoSyncIntegrations(tmpDir, config);

    assert.equal(result.ceSynced, true);
    assert.equal(result.warnings.length, 0);

    const agentsMdExists = await fs.stat(path.join(tmpDir, "AGENTS.md")).then(() => true).catch(() => false);
    assert.ok(agentsMdExists);

  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test("runAutoSyncIntegrations triggers Obsidian sync if vaultDir option provided", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "mb-auto-sync-obsidian-test-"));
  const vaultDir = path.join(tmpDir, "test-vault");

  try {
    await initWorkspace({ workspace: tmpDir });
    const { config } = await loadConfig(tmpDir);

    const result = await runAutoSyncIntegrations(tmpDir, config, { vaultDir });

    assert.equal(result.obsidianSynced, true);
    assert.equal(result.warnings.length, 0);

    const handoffMdInVault = await fs.stat(path.join(vaultDir, "Handoff.md")).then(() => true).catch(() => false);
    assert.ok(handoffMdInVault);

  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});
