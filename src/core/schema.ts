import type { DecisionEvent, SessionEvent } from "../types/events.js";

export interface EncryptedEnvelope {
  _encrypted: true;
  alg: "aes-256-gcm";
  iv: string;
  tag: string;
  data: string;
  kind: "session_event" | "decision_event" | "handoff";
  ts: string;
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isIsoLike(ts: string): boolean {
  return !Number.isNaN(Date.parse(ts));
}

export function validateSessionEvent(value: unknown): value is SessionEvent {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const record = value as Record<string, unknown>;
  const hasValidOptionalTaskId = record.taskId === undefined || isString(record.taskId);
  const hasValidOptionalParentTaskId = record.parentTaskId === undefined || isString(record.parentTaskId);

  return (
    isString(record.ts) &&
    isIsoLike(record.ts) &&
    isString(record.tool) &&
    isString(record.workspace) &&
    isString(record.branch) &&
    isString(record.intent) &&
    isStringArray(record.actions) &&
    isStringArray(record.artifacts) &&
    isString(record.summary) &&
    isStringArray(record.tags) &&
    hasValidOptionalTaskId &&
    hasValidOptionalParentTaskId
  );
}

export function validateDecisionEvent(value: unknown): value is DecisionEvent {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    isString(record.id) &&
    isString(record.ts) &&
    isIsoLike(record.ts) &&
    isString(record.title) &&
    isString(record.context) &&
    isString(record.decision) &&
    isString(record.impact) &&
    isStringArray(record.supersedes)
  );
}

export function validateEncryptedEnvelope(value: unknown): value is EncryptedEnvelope {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    record._encrypted === true &&
    record.alg === "aes-256-gcm" &&
    isString(record.iv) &&
    isString(record.tag) &&
    isString(record.data) &&
    (record.kind === "session_event" ||
      record.kind === "decision_event" ||
      record.kind === "handoff") &&
    isString(record.ts) &&
    isIsoLike(record.ts)
  );
}

export function toJsonLine(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}

export function parseJsonLine(line: string): unknown {
  return JSON.parse(line);
}
