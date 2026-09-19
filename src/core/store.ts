import path from "node:path";

import type { BridgeConfig, DecisionEvent, SessionEvent } from "../types/events.js";
import { decryptJsonIfNeeded, decryptTextIfNeeded, encryptJsonIfNeeded, encryptTextIfNeeded } from "./crypto.js";
import {
  appendJsonlAtomic,
  atomicWriteFile,
  listSessionFiles,
  readJsonl,
  readText,
  sessionFileForDate,
  withLock
} from "./fs-utils.js";
import { resolveBridgePaths } from "./paths.js";
import { redactUnknown } from "./redaction.js";
import { toJsonLine, validateDecisionEvent, validateSessionEvent } from "./schema.js";

export interface ReadSessionsResult {
  events: SessionEvent[];
  warnings: string[];
}

export interface ReadDecisionsResult {
  events: DecisionEvent[];
  warnings: string[];
}

export interface PersistResult {
  file: string;
  encrypted: boolean;
}

export async function appendSessionEvent(
  workspace: string,
  config: BridgeConfig,
  session: SessionEvent
): Promise<PersistResult> {
  const paths = resolveBridgePaths(path.resolve(workspace));
  const event = config.redaction.enabled ? redactUnknown(session, config.redaction.customPatterns) : session;
  if (!validateSessionEvent(event)) {
    throw new Error("Invalid session_event payload.");
  }
  const payload = encryptJsonIfNeeded(event, "session_event", config);
  const line = toJsonLine(payload);
  const target = sessionFileForDate(paths.sessionsDir, new Date(event.ts));
  await appendJsonlAtomic(target, line, paths.lockFile);
  return { file: target, encrypted: config.encryption.enabled };
}

export async function appendDecisionEvent(
  workspace: string,
  config: BridgeConfig,
  decision: DecisionEvent
): Promise<PersistResult> {
  const paths = resolveBridgePaths(path.resolve(workspace));
  const event = config.redaction.enabled ? redactUnknown(decision, config.redaction.customPatterns) : decision;
  if (!validateDecisionEvent(event)) {
    throw new Error("Invalid decision_event payload.");
  }
  const payload = encryptJsonIfNeeded(event, "decision_event", config);
  const line = toJsonLine(payload);
  await appendJsonlAtomic(paths.decisionsFile, line, paths.lockFile);
  return { file: paths.decisionsFile, encrypted: config.encryption.enabled };
}

export async function readSessionEvents(
  workspace: string,
  config: BridgeConfig,
  maxEvents?: number
): Promise<ReadSessionsResult> {
  const paths = resolveBridgePaths(path.resolve(workspace));
  const warnings: string[] = [];
  const files = await listSessionFiles(paths.sessionsDir);
  const events: SessionEvent[] = [];

  for (const file of files) {
    const { records, warnings: fileWarnings } = await readJsonl(file);
    warnings.push(...fileWarnings);
    for (const record of records) {
      const decoded = decryptJsonIfNeeded<SessionEvent>(record, config, warnings);
      if (decoded && validateSessionEvent(decoded)) {
        events.push(decoded);
      }
    }
  }

  events.sort((a, b) => a.ts.localeCompare(b.ts));
  if (!maxEvents || maxEvents >= events.length) {
    return { events, warnings };
  }
  return { events: events.slice(events.length - maxEvents), warnings };
}

export async function readDecisionEvents(
  workspace: string,
  config: BridgeConfig,
  maxEvents?: number
): Promise<ReadDecisionsResult> {
  const paths = resolveBridgePaths(path.resolve(workspace));
  const warnings: string[] = [];
  const { records, warnings: fileWarnings } = await readJsonl(paths.decisionsFile);
  warnings.push(...fileWarnings);
  const events: DecisionEvent[] = [];

  for (const record of records) {
    const decoded = decryptJsonIfNeeded<DecisionEvent>(record, config, warnings);
    if (decoded && validateDecisionEvent(decoded)) {
      events.push(decoded);
    }
  }

  events.sort((a, b) => a.ts.localeCompare(b.ts));
  if (!maxEvents || maxEvents >= events.length) {
    return { events, warnings };
  }
  return { events: events.slice(events.length - maxEvents), warnings };
}

export async function readProjectContext(workspace: string): Promise<string | undefined> {
  const paths = resolveBridgePaths(path.resolve(workspace));
  return readText(paths.projectContextFile);
}

export async function saveHandoff(workspace: string, config: BridgeConfig, markdown: string): Promise<PersistResult> {
  const paths = resolveBridgePaths(path.resolve(workspace));
  const payload = config.redaction.enabled ? redactUnknown(markdown, config.redaction.customPatterns) : markdown;
  const content = config.encryption.enabled ? encryptTextIfNeeded(payload, config) : payload;
  await withLock(paths.lockFile, async () => {
    await atomicWriteFile(paths.handoffFile, content.endsWith("\n") ? content : `${content}\n`, 0o600);
  });
  return { file: paths.handoffFile, encrypted: config.encryption.enabled };
}

export async function readHandoff(workspace: string, config: BridgeConfig): Promise<{ text: string | undefined; warnings: string[] }> {
  const paths = resolveBridgePaths(path.resolve(workspace));
  const warnings: string[] = [];
  const text = await readText(paths.handoffFile);
  if (text === undefined) {
    return { text: undefined, warnings };
  }

  const trimmed = text.trim();
  if (trimmed.startsWith("{")) {
    try {
      const json = JSON.parse(trimmed) as { content?: string; _markdown?: string };
      const encoded = json.content ?? json._markdown;
      if (typeof encoded === "string") {
        const decoded = decryptTextIfNeeded(encoded, config, warnings);
        return { text: decoded, warnings };
      }
    } catch {
      // Keep reading as plain text.
    }
  }

  const decoded = decryptTextIfNeeded(text, config, warnings);
  return { text: decoded, warnings };
}
