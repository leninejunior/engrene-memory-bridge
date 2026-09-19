import path from "node:path";

export interface BridgePaths {
  workspace: string;
  root: string;
  sessionsDir: string;
  observationsDir: string;
  configFile: string;
  projectContextFile: string;
  decisionsFile: string;
  handoffFile: string;
  lockFile: string;
  vectorDbFile: string;
}

export function resolveBridgePaths(workspace: string): BridgePaths {
  const root = path.join(workspace, ".memory-bridge");
  return {
    workspace,
    root,
    sessionsDir: path.join(root, "sessions"),
    observationsDir: path.join(root, "observations"),
    configFile: path.join(root, "config.json"),
    projectContextFile: path.join(root, "project-context.md"),
    decisionsFile: path.join(root, "decisions.jsonl"),
    handoffFile: path.join(root, "handoff.md"),
    lockFile: path.join(root, ".lock"),
    vectorDbFile: path.join(root, "vector.sqlite")
  };
}
