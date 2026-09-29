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

test("detectGitChanges reports whole paths for unstaged edits, renames and quoted names", async () => {
  const { detectGitChanges } = await import("../../src/core/git.js");
  const fs = await import("node:fs/promises");
  const { spawnSync } = await import("node:child_process");
  const { makeTempWorkspace } = await import("../helpers.js");

  const dir = await makeTempWorkspace("mb-git-status-");
  const git = (...args: string[]) => spawnSync("git", args, { cwd: dir, encoding: "utf-8" });
  git("init", "-q", "-b", "main");
  git("config", "user.email", "t@l");
  git("config", "user.name", "t");
  await fs.writeFile(path.join(dir, "calc.js"), "a\n", "utf8");
  await fs.writeFile(path.join(dir, "old name.txt"), "b\n", "utf8");
  git("add", "-A");
  git("commit", "-qm", "init");

  // An unstaged modification: porcelain reports " M calc.js", with a leading space.
  await fs.writeFile(path.join(dir, "calc.js"), "c\n", "utf8");
  git("mv", "old name.txt", "new name.txt");

  const changes = detectGitChanges(dir);
  assert.ok(changes.modifiedFiles.includes("calc.js"), `lost a character: ${JSON.stringify(changes.modifiedFiles)}`);
  assert.ok(
    changes.modifiedFiles.some((f) => f.includes("new name.txt")),
    `rename destination missing: ${JSON.stringify(changes.modifiedFiles)}`
  );
  assert.ok(!changes.modifiedFiles.some((f) => f.startsWith('"')), "quoted paths must be unquoted");
});
