import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export function currentGitBranch(workspace: string): string {
  try {
    const out = execSync("git rev-parse --abbrev-ref HEAD", {
      cwd: workspace,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"]
    }).trim();
    return out || "unknown";
  } catch {
    return "unknown";
  }
}

export function findGitRoot(workspace: string): string | undefined {
  try {
    const out = execSync("git rev-parse --show-toplevel", {
      cwd: workspace,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"]
    }).trim();
    return out ? path.resolve(out) : undefined;
  } catch {
    return undefined;
  }
}

export function resolveWorkspaceWithGitFallback(workspace: string): string {
  const normalized = path.resolve(workspace);
  const localBridge = path.join(normalized, ".memory-bridge");
  if (fs.existsSync(localBridge)) {
    return normalized;
  }
  const gitRoot = findGitRoot(normalized);
  if (gitRoot && gitRoot !== normalized) {
    const rootBridge = path.join(gitRoot, ".memory-bridge");
    if (fs.existsSync(rootBridge)) {
      return gitRoot;
    }
  }
  return normalized;
}

export interface GitChangesResult {
  branch: string;
  modifiedFiles: string[];
  recentCommitMessage?: string | undefined;
}

export function detectGitChanges(workspace: string): GitChangesResult {
  const branch = currentGitBranch(workspace);
  const modifiedFiles: string[] = [];
  let recentCommitMessage: string | undefined;

  try {
    const statusOut = execSync("git status --porcelain", {
      cwd: workspace,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"]
      // trimEnd only: `git status --porcelain` writes a two-character status field, and an
      // unstaged modification starts with a space (" M path"). Trimming the head of the output
      // shifted the first line left, so slice(3) ate the first character of its path.
    }).trimEnd();

    if (statusOut) {
      for (const rawLine of statusOut.split(/\r?\n/)) {
        if (rawLine.length < 4) {
          continue;
        }
        let file = rawLine.slice(3).trim();
        // Renames and copies are reported as "old -> new"; the destination is what now exists.
        const renamed = file.split(" -> ");
        if (renamed.length === 2 && renamed[1]) {
          file = renamed[1]!.trim();
        }
        // Paths containing spaces or non-ASCII are quoted by git.
        if (file.startsWith('"') && file.endsWith('"') && file.length >= 2) {
          file = file.slice(1, -1);
        }
        if (file && !file.startsWith(".memory-bridge/")) {
          modifiedFiles.push(file);
        }
      }
    }
  } catch {
    // Git status not available or non-git workspace
  }

  try {
    const logOut = execSync("git log -1 --pretty=format:%s", {
      cwd: workspace,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"]
    }).trim();
    if (logOut) {
      recentCommitMessage = logOut;
    }
  } catch {
    // Git log not available
  }

  return {
    branch,
    modifiedFiles,
    recentCommitMessage
  };
}
