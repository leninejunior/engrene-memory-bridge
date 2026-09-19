import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";

import { currentGitBranch, findGitRoot, resolveWorkspaceWithGitFallback } from "../../src/core/git.js";

test("git utilities resolve branch and root correctly", () => {
  const cwd = process.cwd();
  const branch = currentGitBranch(cwd);
  assert.ok(typeof branch === "string" && branch.length > 0);

  const gitRoot = findGitRoot(cwd);
  assert.ok(gitRoot !== undefined);
  assert.equal(typeof gitRoot, "string");

  const resolved = resolveWorkspaceWithGitFallback(cwd);
  assert.equal(typeof resolved, "string");
  assert.ok(path.isAbsolute(resolved));
});
