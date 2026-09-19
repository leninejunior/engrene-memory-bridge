import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";

test("practical end-to-end test of cross-platform workflow (Linux/macOS scripts + core CLI)", async () => {
  const sandboxDir = path.join(process.cwd(), `tmp-practical-e2e-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  await fs.mkdir(sandboxDir, { recursive: true });

  const rootDir = process.cwd();
  const mbBin = path.join(rootDir, "dist/src/cli/bin.js");
  const mbPreScript = path.join(rootDir, "scripts/linux/mb-pre.sh");
  const mbPostScript = path.join(rootDir, "scripts/linux/mb-post.sh");

  try {
    // 1. Initialize workspace
    const initOut = execSync(`node "${mbBin}" init --workspace "${sandboxDir}" --json`, {
      encoding: "utf8"
    });
    const initParsed = JSON.parse(initOut);
    assert.equal(initParsed.ok, true);

    // 2. Run Doctor
    const doctorOut = execSync(`node "${mbBin}" doctor --workspace "${sandboxDir}" --json`, {
      encoding: "utf8"
    });
    const doctorParsed = JSON.parse(doctorOut);
    assert.equal(doctorParsed.ok, true);

    // 3. Run Pre hook via Linux script
    const preOut = execSync(`bash "${mbPreScript}" --tool claude --workspace "${sandboxDir}"`, {
      encoding: "utf8"
    });
    assert.match(preOut, /Resume for claude/);

    // 4. Run Post hook via Linux script
    const postOut = execSync(
      `bash "${mbPostScript}" --tool claude --intent "Implement token guard" --summary "Added token validation guard" --actions "TODO: load test" --artifacts "src/auth.ts" --tags "auth,mfa" --task-id "task-1001" --workspace "${sandboxDir}"`,
      { encoding: "utf8" }
    );
    assert.match(postOut, /# Handoff/);

    // 5. Add decision
    const decOut = execSync(
      `node "${mbBin}" decision add --title "Use JWT tokens" --decision "Adopt JWT with 15min expiry" --workspace "${sandboxDir}" --json`,
      { encoding: "utf8" }
    );
    const decParsed = JSON.parse(decOut);
    assert.equal(decParsed.ok, true);

    // 6. Test lint
    const lintOut = execSync(`node "${mbBin}" lint --workspace "${sandboxDir}" --json`, {
      encoding: "utf8"
    });
    const lintParsed = JSON.parse(lintOut);
    assert.equal(lintParsed.ok, true);
    assert.equal(lintParsed.result.stats.sessionCount, 1);
    assert.equal(lintParsed.result.stats.decisionCount, 1);

    // 7. Test consolidate
    const consOut = execSync(`node "${mbBin}" consolidate --workspace "${sandboxDir}" --json`, {
      encoding: "utf8"
    });
    const consParsed = JSON.parse(consOut);
    assert.equal(consParsed.ok, true);
    assert.equal(consParsed.result.activeDecisions, 1);

    // 8. Test search
    const searchOut = execSync(`node "${mbBin}" search "token" --workspace "${sandboxDir}" --mode text --json`, {
      encoding: "utf8"
    });
    const searchParsed = JSON.parse(searchOut);
    assert.equal(searchParsed.ok, true);
    assert.ok(searchParsed.hits.length >= 1);

    // 9. Verify redaction in practical workflow
    const redactLogOut = execSync(
      `node "${mbBin}" log --tool codex --intent "Configure key" --summary "Configured key=sk-1234567890abcdef123456" --workspace "${sandboxDir}" --json`,
      { encoding: "utf8" }
    );
    const redactParsed = JSON.parse(redactLogOut);
    assert.equal(redactParsed.event.summary.includes("sk-123"), false);
    assert.match(redactParsed.event.summary, /\[REDACTED/);
  } finally {
    await fs.rm(sandboxDir, { recursive: true, force: true });
  }
});
