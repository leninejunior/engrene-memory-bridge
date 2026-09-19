import { randomBytes } from "node:crypto";
import path from "node:path";

import type { BridgeConfig, SemanticProvider } from "../types/events.js";
import {
  atomicWriteFile,
  ensureDirSecure,
  ensureFile,
  exists,
  readJsonFile,
  readText,
  writeJsonFile
} from "./fs-utils.js";
import { resolveBridgePaths, type BridgePaths } from "./paths.js";

export interface InitOptions {
  workspace: string;
  enableEncryption?: boolean;
  enableSemanticSearch?: boolean;
  disableRedaction?: boolean;
  projectName?: string;
}

export interface ConfigLoadResult {
  config: BridgeConfig;
  paths: BridgePaths;
  warnings: string[];
}

export interface InitResult {
  paths: BridgePaths;
  config: BridgeConfig;
  created: string[];
  updated: string[];
}

function normalizeProjectName(name: string): string {
  return name.trim() || "memory-bridge-project";
}

export function defaultConfig(projectName: string): BridgeConfig {
  return {
    schemaVersion: "1.0.0",
    projectName: normalizeProjectName(projectName),
    createdAt: new Date().toISOString(),
    redaction: {
      enabled: true
    },
    encryption: {
      enabled: false,
      kdf: "scrypt",
      saltBase64: randomBytes(16).toString("base64"),
      keyEnvVar: "MEMORY_BRIDGE_KEY"
    },
    semanticSearch: {
      enabled: false,
      provider: "disabled",
      dimensions: 256
    }
  };
}

export async function loadConfig(workspace: string): Promise<ConfigLoadResult> {
  const paths = resolveBridgePaths(path.resolve(workspace));
  const warnings: string[] = [];
  const parsed = await readJsonFile<BridgeConfig>(paths.configFile);

  if (!parsed) {
    warnings.push("Config missing. Falling back to defaults.");
    return {
      paths,
      warnings,
      config: defaultConfig(path.basename(paths.workspace))
    };
  }

  const isSemanticEnabled = parsed.semanticSearch?.enabled ?? false;
  const config: BridgeConfig = {
    schemaVersion: parsed.schemaVersion || "1.0.0",
    projectName: normalizeProjectName(parsed.projectName || path.basename(paths.workspace)),
    createdAt: parsed.createdAt || new Date().toISOString(),
    redaction: {
      enabled: parsed.redaction?.enabled ?? true,
      ...(Array.isArray(parsed.redaction?.customPatterns) ? { customPatterns: parsed.redaction.customPatterns } : {})
    },
    encryption: {
      enabled: parsed.encryption?.enabled ?? false,
      kdf: "scrypt",
      saltBase64: parsed.encryption?.saltBase64 || randomBytes(16).toString("base64"),
      keyEnvVar: parsed.encryption?.keyEnvVar || "MEMORY_BRIDGE_KEY"
    },
    semanticSearch: {
      enabled: isSemanticEnabled,
      provider: parsed.semanticSearch?.provider ?? (isSemanticEnabled ? "local" : "disabled"),
      dimensions: Math.max(32, parsed.semanticSearch?.dimensions ?? 256),
      ...(parsed.semanticSearch?.model ? { model: parsed.semanticSearch.model } : {}),
      ...(parsed.semanticSearch?.endpoint ? { endpoint: parsed.semanticSearch.endpoint } : {}),
      ...(parsed.semanticSearch?.apiKeyEnvVar ? { apiKeyEnvVar: parsed.semanticSearch.apiKeyEnvVar } : {})
    },
    ...(parsed.capture
      ? {
          capture: {
            enabled: parsed.capture.enabled ?? false,
            retentionDays: parsed.capture.retentionDays ?? 7,
            maxSessions: parsed.capture.maxSessions ?? 30,
            exclude: Array.isArray(parsed.capture.exclude) ? parsed.capture.exclude : [".env*", "node_modules/**"]
          }
        }
      : {})
  };

  return { config, paths, warnings };
}

const DEFAULT_PROJECT_CONTEXT = `# Project Context

## Current Objective
Describe the current milestone and expected outcome.

## Constraints
- Local-first only
- Keep memory portable between tools

## Notes
Add stable context that should persist across sessions.
`;

const DEFAULT_HANDOFF = `# Handoff

## Objective
N/A

## Recent Decisions
- N/A

## Pending
- N/A

## Next Steps
- N/A
`;

async function ensureGitignoreEntry(workspace: string): Promise<boolean> {
  const gitignorePath = path.join(workspace, ".gitignore");
  const entry = ".memory-bridge/";
  const current = (await readText(gitignorePath)) ?? "";
  const lines = new Set(current.split(/\r?\n/).map((line) => line.trim()));
  if (lines.has(entry)) {
    return false;
  }
  const next = `${current.trimEnd()}\n${entry}\n`;
  await atomicWriteFile(gitignorePath, next.startsWith("\n") ? next.slice(1) : next, 0o644);
  return true;
}

export async function initWorkspace(options: InitOptions): Promise<InitResult> {
  const workspace = path.resolve(options.workspace);
  const paths = resolveBridgePaths(workspace);
  const created: string[] = [];
  const updated: string[] = [];

  await ensureDirSecure(paths.root);
  await ensureDirSecure(paths.sessionsDir);

  const base = defaultConfig(options.projectName || path.basename(workspace));
  base.redaction.enabled = options.disableRedaction !== true;
  base.encryption.enabled = Boolean(options.enableEncryption);

  if (options.enableSemanticSearch) {
    base.semanticSearch.enabled = true;
    base.semanticSearch.provider = "local";
  }

  if (!(await exists(paths.configFile))) {
    await writeJsonFile(paths.configFile, base, paths.lockFile);
    created.push(paths.configFile);
  } else {
    const existing = (await readJsonFile<BridgeConfig>(paths.configFile)) ?? base;
    const isSemEnabled = existing.semanticSearch?.enabled ?? base.semanticSearch.enabled;
    const existingProvider = (existing.semanticSearch?.provider || (isSemEnabled ? "local" : "disabled")) as SemanticProvider;
    const merged: BridgeConfig = {
      ...base,
      ...existing,
      redaction: {
        enabled: existing.redaction?.enabled ?? base.redaction.enabled,
        ...(existing.redaction?.customPatterns ? { customPatterns: existing.redaction.customPatterns } : {})
      },
      encryption: {
        enabled: existing.encryption?.enabled ?? base.encryption.enabled,
        kdf: "scrypt",
        saltBase64: existing.encryption?.saltBase64 || base.encryption.saltBase64,
        keyEnvVar: existing.encryption?.keyEnvVar || base.encryption.keyEnvVar
      },
      semanticSearch: {
        enabled: isSemEnabled,
        provider: existingProvider,
        dimensions: existing.semanticSearch?.dimensions ?? base.semanticSearch.dimensions,
        ...(existing.semanticSearch?.model ? { model: existing.semanticSearch.model } : {}),
        ...(existing.semanticSearch?.endpoint ? { endpoint: existing.semanticSearch.endpoint } : {}),
        ...(existing.semanticSearch?.apiKeyEnvVar ? { apiKeyEnvVar: existing.semanticSearch.apiKeyEnvVar } : {})
      },
      ...(existing.capture ? { capture: existing.capture } : {})
    };
    await writeJsonFile(paths.configFile, merged, paths.lockFile);
    updated.push(paths.configFile);
  }

  if (!(await exists(paths.projectContextFile))) {
    await ensureFile(paths.projectContextFile, DEFAULT_PROJECT_CONTEXT, 0o600);
    created.push(paths.projectContextFile);
  }
  if (!(await exists(paths.decisionsFile))) {
    await ensureFile(paths.decisionsFile, "", 0o600);
    created.push(paths.decisionsFile);
  }
  if (!(await exists(paths.handoffFile))) {
    await ensureFile(paths.handoffFile, DEFAULT_HANDOFF, 0o600);
    created.push(paths.handoffFile);
  }

  if (await ensureGitignoreEntry(workspace)) {
    updated.push(path.join(workspace, ".gitignore"));
  }

  const loaded = await loadConfig(workspace);
  return {
    paths,
    config: loaded.config,
    created,
    updated
  };
}
