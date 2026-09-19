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
    }).trim();

    if (statusOut) {
      for (const line of statusOut.split(/\r?\n/)) {
        const file = line.slice(3).trim();
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
