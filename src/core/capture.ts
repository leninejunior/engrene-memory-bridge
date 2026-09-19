import fs from "node:fs/promises";
import path from "node:path";

import type { BridgeConfig, CaptureConfig, ObservationEvent } from "../types/events.js";
import { appendJsonlAtomic, ensureDirSecure, exists, readJsonl } from "./fs-utils.js";
import { resolveBridgePaths } from "./paths.js";
import { redactUnknown } from "./redaction.js";
import { toJsonLine } from "./schema.js";

export const DEFAULT_CAPTURE_CONFIG: CaptureConfig = {
  enabled: false,
  retentionDays: 7,
  maxSessions: 30,
  exclude: [
    ".env*",
    "node_modules/**",
    "secrets/**",
    "credentials/**",
    "*.pem",
    "*.key",
    "*.p12",
    "id_rsa*",
    "id_ed25519*"
  ]
};

function matchGlob(filename: string, pattern: string): boolean {
  const normFile = filename.replace(/\\/g, "/");
  const normPat = pattern.replace(/\\/g, "/");

  // Simple wildcard glob matching (* and **)
  const regexStr = normPat
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, ".*")
    .replace(/(?<!\.)\*/g, "[^/]*");

  try {
    const regex = new RegExp(`(^|/)${regexStr}($|/)`, "i");
    return regex.test(normFile);
  } catch {
    return false;
  }
}

export function isPathExcluded(filePath: string, excludePatterns: string[]): boolean {
  const basename = path.basename(filePath);
  for (const pattern of excludePatterns) {
    if (matchGlob(filePath, pattern) || matchGlob(basename, pattern)) {
      return true;
    }
  }
  return false;
}

function sanitizeValueRecursive(val: unknown, excludePatterns: string[]): unknown {
  if (typeof val === "string") {
    return isPathExcluded(val, excludePatterns) ? "[EXCLUDED_PATH]" : val;
  }
  if (Array.isArray(val)) {
    return val.map((item) => sanitizeValueRecursive(item, excludePatterns));
  }
  if (val && typeof val === "object" && val !== null) {
    const obj = val as Record<string, unknown>;
    const sanitizedObj: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) {
      if (isPathExcluded(k, excludePatterns)) {
        sanitizedObj[k] = "[EXCLUDED_KEY]";
      } else {
        sanitizedObj[k] = sanitizeValueRecursive(v, excludePatterns);
      }
    }
    return sanitizedObj;
  }
  return val;
}

export function sanitizeObservationPayload(
  payload: Record<string, unknown>,
  config: BridgeConfig
): Record<string, unknown> {
  const excludePatterns = config.capture?.exclude ?? DEFAULT_CAPTURE_CONFIG.exclude;
  const sanitized = sanitizeValueRecursive(payload, excludePatterns) as Record<string, unknown>;

  return config.redaction.enabled
    ? (redactUnknown(sanitized, config.redaction.customPatterns) as Record<string, unknown>)
    : sanitized;
}

export async function appendObservation(
  workspace: string,
  config: BridgeConfig,
  event: ObservationEvent
): Promise<{ file: string; skipped?: boolean }> {
  if (config.capture && !config.capture.enabled) {
    return { file: "", skipped: true };
  }

  const paths = resolveBridgePaths(path.resolve(workspace));
  await ensureDirSecure(paths.observationsDir);

  const cleanPayload = sanitizeObservationPayload(event.payload, config);
  const cleanEvent: ObservationEvent = {
    ...event,
    payload: cleanPayload
  };

  const safeSessionId = (cleanEvent.sessionId || "default").replace(/[^a-zA-Z0-9_-]/g, "_");
  const dateStr = cleanEvent.ts.slice(0, 10);
  const filename = `${dateStr}-session-${safeSessionId}.jsonl`;
  const targetFile = path.join(paths.observationsDir, filename);

  const line = toJsonLine(cleanEvent);
  await appendJsonlAtomic(targetFile, line, paths.lockFile);

  return { file: targetFile };
}

export async function listObservationFiles(workspace: string): Promise<string[]> {
  const paths = resolveBridgePaths(path.resolve(workspace));
  if (!(await exists(paths.observationsDir))) {
    return [];
  }
  try {
    const entries = await fs.readdir(paths.observationsDir);
    return entries
      .filter((name) => name.endsWith(".jsonl"))
      .sort()
      .map((name) => path.join(paths.observationsDir, name));
  } catch {
    return [];
  }
}

export async function cleanStaleObservations(
  workspace: string,
  config: BridgeConfig
): Promise<{ removedFiles: string[] }> {
  const retentionDays = config.capture?.retentionDays ?? DEFAULT_CAPTURE_CONFIG.retentionDays;
  const maxSessions = config.capture?.maxSessions ?? DEFAULT_CAPTURE_CONFIG.maxSessions;
  const files = await listObservationFiles(workspace);
  const removedFiles: string[] = [];

  const now = Date.now();
  const maxAgeMs = retentionDays * 24 * 60 * 60 * 1000;

  for (const file of files) {
    try {
      const stat = await fs.stat(file);
      const age = now - stat.mtimeMs;
      if (age > maxAgeMs) {
        await fs.unlink(file);
        removedFiles.push(file);
      }
    } catch {
      // Ignore individual file errors
    }
  }

  // Enforce maxSessions if remaining files exceed cap
  const remainingFiles = await listObservationFiles(workspace);
  if (remainingFiles.length > maxSessions) {
    const excess = remainingFiles.slice(0, remainingFiles.length - maxSessions);
    for (const excessFile of excess) {
      try {
        await fs.unlink(excessFile);
        removedFiles.push(excessFile);
      } catch {
        // Ignore unlink error
      }
    }
  }

  return { removedFiles };
}

export async function readObservations(
  workspace: string,
  maxFiles = 10
): Promise<ObservationEvent[]> {
  const { events } = await readObservationsWithFiles(workspace, maxFiles);
  return events;
}

export interface ReadObservationsResult {
  events: ObservationEvent[];
  processedFiles: string[];
}

export async function readObservationsWithFiles(
  workspace: string,
  maxFiles = 10
): Promise<ReadObservationsResult> {
  const files = await listObservationFiles(workspace);
  const events: ObservationEvent[] = [];
  const processedFiles = files.slice(-maxFiles);

  for (const file of processedFiles) {
    const { records } = await readJsonl(file);
    for (const record of records) {
      if (
        record &&
        typeof record === "object" &&
        "type" in record &&
        "sessionId" in record
      ) {
        events.push(record as ObservationEvent);
      }
    }
  }

  return { events, processedFiles };
}
