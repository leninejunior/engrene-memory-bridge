import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { spawnSync } from "node:child_process";

import { runDoctor } from "../../src/core/doctor.js";
import { initWorkspace } from "../../src/core/config.js";

function getBinPath(): string {
  return path.resolve(process.cwd(), "dist/src/cli/bin.js");
}

function getWrapperPath(name: string): string {
  return path.resolve(process.cwd(), `dist/src/wrappers/${name}.js`);
}

test("doctor reports sqlite-fts5, semantic-search, and observations health", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "mb-doctor-test-"));
  try {
    const { config } = await initWorkspace({ workspace: tmpDir, projectName: "doctor-test" });
    const result = await runDoctor(tmpDir, config);

    assert.equal(result.ok, true);
    const ftsCheck = result.checks.find((c) => c.name === "sqlite-fts5");
    assert.ok(ftsCheck);
    assert.equal(ftsCheck?.ok, true);

    const semanticCheck = result.checks.find((c) => c.name === "semantic-search");
    assert.ok(semanticCheck);
    assert.equal(semanticCheck?.ok, true);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test("CLI commands stats, observe, and hook print work end-to-end", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "mb-cli-exp-"));
  const bin = getBinPath();

  try {
    // 1. init
    const initRes = spawnSync(process.execPath, [bin, "init", "--workspace", tmpDir, "--json"], { encoding: "utf-8" });
    assert.equal(initRes.status, 0);

    // 2. observe
    const obsRes = spawnSync(
      process.execPath,
      [
        bin,
        "observe",
        "--workspace",
        tmpDir,
        "--type",
        "tool_call",
        "--content",
        "git status inspection",
        "--files",
        "src/cli.ts",
        "--json"
      ],
      { encoding: "utf-8" }
    );
    assert.equal(obsRes.status, 0, obsRes.stderr);
    const obsData = JSON.parse(obsRes.stdout);
    assert.equal(obsData.ok, true);
    assert.equal(obsData.observation.type, "tool_call");

    // 3. stats
    const statsRes = spawnSync(process.execPath, [bin, "stats", "--workspace", tmpDir, "--json"], { encoding: "utf-8" });
    assert.equal(statsRes.status, 0, statsRes.stderr);
    const statsData = JSON.parse(statsRes.stdout);
    assert.equal(statsData.ok, true);
    assert.equal(typeof statsData.stats.diskSizeBytes, "number");
    assert.equal(statsData.stats.pendingObservations, 1);

    // 4. hook print
    for (const target of ["hermes", "qwen", "cursor", "mcp"]) {
      const hookRes = spawnSync(process.execPath, [bin, "hook", "print", target], { encoding: "utf-8" });
      assert.equal(hookRes.status, 0);
      assert.ok(hookRes.stdout.length > 20);
    }

    // 5. wrappers mb-hermes and mb-qwen
    const hermesRes = spawnSync(
      process.execPath,
      [getWrapperPath("mb-hermes"), "post", "--workspace", tmpDir, "--intent", "hermes test", "--summary", "completed hermes step", "--json"],
      { encoding: "utf-8" }
    );
    assert.equal(hermesRes.status, 0, hermesRes.stderr);

    const qwenRes = spawnSync(
      process.execPath,
      [getWrapperPath("mb-qwen"), "pre", "--workspace", tmpDir, "--json"],
      { encoding: "utf-8" }
    );
    assert.equal(qwenRes.status, 0, qwenRes.stderr);

    // 6. install command
    const installRes = spawnSync(
      process.execPath,
      [bin, "install", "hermes", "--workspace", tmpDir, "--json"],
      { encoding: "utf-8" }
    );
    assert.equal(installRes.status, 0, installRes.stderr);
    const installData = JSON.parse(installRes.stdout);
    assert.equal(installData.result.target, "hermes");
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});
