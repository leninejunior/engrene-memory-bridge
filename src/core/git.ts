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
