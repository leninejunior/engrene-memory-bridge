import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import type { BridgeConfig, DecisionEvent, SessionEvent } from "../types/events.js";
import { filterActiveDecisions } from "./context.js";
import { atomicWriteFile, ensureDirSecure, exists } from "./fs-utils.js";
import { resolveBridgePaths } from "./paths.js";
import { redactUnknown } from "./redaction.js";
import {
  appendDecisionEvent,
  appendSessionEvent,
  readDecisionEvents,
  readHandoff,
  readProjectContext,
  readSessionEvents,
  replaceDecisionEvent,
  replaceSessionEvent
} from "./store.js";
import { semanticEnabled, upsertSemanticDoc } from "./vector.js";

export interface ObsidianSyncResult {
  vaultDir: string;
  createdFiles: string[];
  totalDecisions: number;
  totalSessions: number;
}

export type ObsidianImportPreference = "vault" | "bridge";

export interface ObsidianImportOptions {
  /** Who wins when a record exists on both sides with different content. Default: "vault". */
  prefer?: ObsidianImportPreference;
}

export interface ObsidianImportResult {
  vaultDir: string;
  scannedFiles: number;
  created: { decisions: string[]; sessions: string[] };
  updated: { decisions: string[]; sessions: string[] };
  unchanged: number;
  skippedConflicts: string[];
  assignedIds: Array<{ file: string; id: string }>;
  projectContext: "created" | "updated" | "unchanged" | "absent" | "skipped-conflict";
  warnings: string[];
}

const RESERVED_DECISION_TAGS = new Set(["memory-bridge", "decision"]);
const RESERVED_SESSION_TAGS = new Set(["memory-bridge", "session"]);

// ---------------------------------------------------------------------------
// Export (bridge -> vault)
// ---------------------------------------------------------------------------

export function formatObsidianDecisionNote(event: DecisionEvent): string {
  const supersedesLinks =
    Array.isArray(event.supersedes) && event.supersedes.length > 0
      ? event.supersedes.map((id) => `[[${id}]]`).join(", ")
      : "N/A";

  return `---
id: "${event.id}"
title: "${event.title.replace(/"/g, '\\"')}"
date: "${event.ts}"
tags:
  - memory-bridge
  - decision
---

# Decision: ${event.title}

- **ID:** \`${event.id}\`
- **Date:** ${event.ts}
- **Supersedes:** ${supersedesLinks}

## Context
${event.context}

## Decision
${event.decision}

## Impact
${event.impact}
`;
}

export function formatObsidianSessionNote(event: SessionEvent): string {
  const dateStr = event.ts.slice(0, 10);
  const actionsList = event.actions.map((a) => `- ${a}`).join("\n") || "- N/A";
  const artifactsList = event.artifacts.map((a) => `- \`${a}\``).join("\n") || "- N/A";
  const tagsList = event.tags.map((t) => `  - ${t}`).join("\n");

  return `---
tool: "${event.tool}"
branch: "${event.branch}"
date: "${event.ts}"
tags:
  - memory-bridge
  - session
${tagsList}
---

# Session (${dateStr}): ${event.intent}

- **Tool:** \`${event.tool}\`
- **Branch:** \`${event.branch}\`
- **Timestamp:** ${event.ts}

## Summary
${event.summary}

## Actions
${actionsList}

## Artifacts
${artifactsList}
`;
}

export function sessionNoteFilename(event: SessionEvent): string {
  const safeDate = event.ts.slice(0, 10);
  const safeTool = event.tool.replace(/[^a-zA-Z0-9_-]/g, "_");
  return `${safeDate}-${safeTool}-${event.ts.slice(11, 19).replace(/:/g, "-")}.md`;
}

export async function syncObsidianVault(
  workspace: string,
  config: BridgeConfig,
  targetVaultDir: string
): Promise<ObsidianSyncResult> {
  const vaultDir = path.resolve(targetVaultDir);
  const decisionsDir = path.join(vaultDir, "Decisions");
  const sessionsDir = path.join(vaultDir, "Sessions");

  await ensureDirSecure(vaultDir);
  await ensureDirSecure(decisionsDir);
  await ensureDirSecure(sessionsDir);

  const createdFiles: string[] = [];

  const [sessionsResult, decisionsResult, handoffResult, projectContext, existingDecisionNotes] = await Promise.all([
    readSessionEvents(workspace, config, 1000),
    readDecisionEvents(workspace, config, 10000),
    readHandoff(workspace, config),
    readProjectContext(workspace),
    scanDecisionNotePaths(decisionsDir)
  ]);

  // 1. Export Decisions with Wikilinks.
  //    A note the user created under their own name (and that import already tagged with an id)
  //    is updated in place instead of duplicated as `<id>.md`.
  const { active, superseded } = filterActiveDecisions(decisionsResult.events);
  const allDecisions = [...active, ...superseded];

  for (const dec of allDecisions) {
    const filepath = existingDecisionNotes.get(dec.id) ?? path.join(decisionsDir, `${dec.id}.md`);
    const content = formatObsidianDecisionNote(dec);
    await fs.writeFile(filepath, content, "utf8");
    createdFiles.push(filepath);
  }

  // 2. Export Sessions
  for (const session of sessionsResult.events) {
    const filepath = path.join(sessionsDir, sessionNoteFilename(session));
    const content = formatObsidianSessionNote(session);
    await fs.writeFile(filepath, content, "utf8");
    createdFiles.push(filepath);
  }

  // 3. Export Overview Handoff Note
  if (handoffResult.text) {
    const handoffPath = path.join(vaultDir, "Handoff.md");
    const handoffContent = `---
tags:
  - memory-bridge
  - handoff
---

${handoffResult.text}
`;
    await fs.writeFile(handoffPath, handoffContent, "utf8");
    createdFiles.push(handoffPath);
  }

  // 4. Export Project Context Note
  if (projectContext) {
    const contextPath = path.join(vaultDir, "Project-Context.md");
    const contextContent = `---
tags:
  - memory-bridge
  - project-context
---

${projectContext}
`;
    await fs.writeFile(contextPath, contextContent, "utf8");
    createdFiles.push(contextPath);
  }

  return {
    vaultDir,
    createdFiles,
    totalDecisions: allDecisions.length,
    totalSessions: sessionsResult.events.length
  };
}

// ---------------------------------------------------------------------------
// Note parsing (vault -> events)
// ---------------------------------------------------------------------------

export interface ParsedFrontmatter {
  fields: Record<string, string>;
  lists: Record<string, string[]>;
  body: string;
  /** Raw header text between the `---` fences, without trailing newline. */
  header: string;
}

function unquote(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return trimmed.slice(1, -1).replace(/\\"/g, '"');
  }
  if (trimmed.length >= 2 && trimmed.startsWith("'") && trimmed.endsWith("'")) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

/**
 * Minimal flat-YAML frontmatter parser: `key: value` scalars and `key:` + `  - item` lists.
 * Deliberately small so the package keeps zero runtime dependencies.
 */
export function parseFrontmatter(content: string): ParsedFrontmatter | undefined {
  const normalized = content.replace(/\r\n/g, "\n");
  if (!normalized.startsWith("---\n")) {
    return undefined;
  }
  const end = normalized.indexOf("\n---\n", 4);
  if (end === -1) {
    return undefined;
  }
  const header = normalized.slice(4, end);
  const body = normalized.slice(end + 5);
  const fields: Record<string, string> = {};
  const lists: Record<string, string[]> = {};
  let currentList: string | undefined;

  for (const line of header.split("\n")) {
    const listItem = /^\s+-\s+(.*)$/.exec(line);
    if (listItem && currentList) {
      lists[currentList]!.push(unquote(listItem[1] ?? ""));
      continue;
    }
    const scalar = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(line);
    if (scalar) {
      const key = scalar[1]!;
      const raw = scalar[2] ?? "";
      if (raw.trim() === "") {
        currentList = key;
        lists[key] = [];
      } else {
        currentList = undefined;
        fields[key] = unquote(raw);
      }
    }
  }

  return { fields, lists, body, header };
}

function splitSections(body: string): { preamble: string; sections: Map<string, string> } {
  const sections = new Map<string, string>();
  const preambleLines: string[] = [];
  let current: string | undefined;
  let buffer: string[] = [];

  const flush = (): void => {
    if (current !== undefined) {
      sections.set(current, buffer.join("\n").trim());
    }
  };

  for (const line of body.split("\n")) {
    const heading = /^##\s+(.+?)\s*$/.exec(line);
    if (heading) {
      flush();
      current = heading[1]!.toLowerCase();
      buffer = [];
      continue;
    }
    if (current === undefined) {
      preambleLines.push(line);
    } else {
      buffer.push(line);
    }
  }
  flush();
  return { preamble: preambleLines.join("\n"), sections };
}

function extractWikilinks(text: string): string[] {
  const ids: string[] = [];
  const regex = /\[\[([^\]|#]+)(?:[|#][^\]]*)?\]\]/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(text)) !== null) {
    const id = (match[1] ?? "").trim();
    if (id && !ids.includes(id)) {
      ids.push(id);
    }
  }
  return ids;
}

function bulletItems(sectionText: string | undefined): string[] {
  if (!sectionText) {
    return [];
  }
  const items = sectionText
    .split("\n")
    .map((line) => /^\s*[-*]\s+(.*)$/.exec(line)?.[1]?.trim() ?? "")
    .filter((item) => item.length > 0)
    .map((item) => (item.startsWith("`") && item.endsWith("`") && item.length >= 2 ? item.slice(1, -1) : item));
  if (items.length === 1 && items[0] === "N/A") {
    return [];
  }
  return items;
}

function isoOrUndefined(value: string | undefined): string | undefined {
  if (!value || Number.isNaN(Date.parse(value))) {
    return undefined;
  }
  return value;
}

export interface ParsedDecisionNote {
  id?: string;
  ts?: string;
  title: string;
  context: string;
  decision: string;
  impact: string;
  supersedes: string[];
}

/** Parses a decision note written by `formatObsidianDecisionNote` (or hand-written in the same shape). */
export function parseObsidianDecisionNote(content: string): ParsedDecisionNote | undefined {
  const fm = parseFrontmatter(content);
  const body = fm ? fm.body : content.replace(/\r\n/g, "\n");
  const { preamble, sections } = splitSections(body);

  const h1 = /^#\s+(?:Decision:\s*)?(.+?)\s*$/m.exec(preamble)?.[1];
  const title = fm?.fields.title || h1;
  if (!title) {
    return undefined;
  }

  const supersedesLine = /\*\*Supersedes:\*\*\s*(.*)$/m.exec(preamble)?.[1] ?? "";
  const supersedes = fm?.lists.supersedes && fm.lists.supersedes.length > 0
    ? fm.lists.supersedes
    : extractWikilinks(supersedesLine);

  return {
    ...(fm?.fields.id ? { id: fm.fields.id } : {}),
    ...(isoOrUndefined(fm?.fields.date) ? { ts: fm!.fields.date! } : {}),
    title,
    context: sections.get("context") || "N/A",
    decision: sections.get("decision") || "N/A",
    impact: sections.get("impact") || "N/A",
    supersedes
  };
}

export interface ParsedSessionNote {
  ts: string;
  tool: string;
  branch: string;
  intent: string;
  summary: string;
  actions: string[];
  artifacts: string[];
  tags: string[];
}

/** Parses a session note written by `formatObsidianSessionNote`. */
export function parseObsidianSessionNote(content: string): ParsedSessionNote | undefined {
  const fm = parseFrontmatter(content);
  if (!fm) {
    return undefined;
  }
  const { preamble, sections } = splitSections(fm.body);
  const ts = isoOrUndefined(fm.fields.date) ?? isoOrUndefined(/\*\*Timestamp:\*\*\s*(\S+)/.exec(preamble)?.[1]);
  const tool = fm.fields.tool || /\*\*Tool:\*\*\s*`([^`]*)`/.exec(preamble)?.[1];
  const intent = /^#\s+Session\s*\([^)]*\):\s*(.*?)\s*$/m.exec(preamble)?.[1] ?? /^#\s+(.+?)\s*$/m.exec(preamble)?.[1];
  if (!ts || !tool || intent === undefined) {
    return undefined;
  }
  const branch = fm.fields.branch || /\*\*Branch:\*\*\s*`([^`]*)`/.exec(preamble)?.[1] || "unknown";
  const tags = (fm.lists.tags ?? []).filter((tag) => !RESERVED_SESSION_TAGS.has(tag));

  return {
    ts,
    tool,
    branch,
    intent,
    summary: sections.get("summary") ?? "",
    actions: bulletItems(sections.get("actions")),
    artifacts: bulletItems(sections.get("artifacts")),
    tags
  };
}

function stripFrontmatter(content: string): string {
  const fm = parseFrontmatter(content);
  return (fm ? fm.body : content.replace(/\r\n/g, "\n")).replace(/^\n+/, "");
}

// ---------------------------------------------------------------------------
// Import (vault -> bridge)
// ---------------------------------------------------------------------------

async function listMarkdownFiles(dir: string): Promise<string[]> {
  if (!(await exists(dir))) {
    return [];
  }
  const entries = await fs.readdir(dir, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".md"))
    .map((entry) => path.join(dir, entry.name))
    .sort((a, b) => a.localeCompare(b));
}

/** Maps decision id -> note path for every note in `Decisions/` that carries an `id` in its frontmatter. */
async function scanDecisionNotePaths(decisionsDir: string): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  for (const file of await listMarkdownFiles(decisionsDir)) {
    const fm = parseFrontmatter(await fs.readFile(file, "utf8"));
    const id = fm?.fields.id;
    if (id && !map.has(id)) {
      map.set(id, file);
    }
  }
  return map;
}

function generateDecisionId(taken: Set<string>): string {
  let id = "";
  do {
    id = `dec-${Date.now().toString(36)}-${randomBytes(2).toString("hex")}`;
  } while (taken.has(id));
  taken.add(id);
  return id;
}

async function writeIdIntoFrontmatter(file: string, content: string, id: string): Promise<void> {
  const normalized = content.replace(/\r\n/g, "\n");
  const idLine = `id: "${id}"\n`;
  const updated = normalized.startsWith("---\n")
    ? `---\n${idLine}${normalized.slice(4)}`
    : `---\n${idLine}tags:\n  - memory-bridge\n  - decision\n---\n\n${normalized}`;
  await fs.writeFile(file, updated, "utf8");
}

function decisionFingerprint(event: DecisionEvent): string {
  return JSON.stringify([event.id, event.ts, event.title, event.context, event.decision, event.impact, event.supersedes]);
}

function sessionFingerprint(event: SessionEvent): string {
  return JSON.stringify([event.ts, event.tool, event.branch, event.intent, event.summary, event.actions, event.artifacts, event.tags]);
}

function applyRedaction<T>(value: T, config: BridgeConfig): T {
  return config.redaction.enabled ? redactUnknown(value, config.redaction.customPatterns) : value;
}

async function indexDecision(workspace: string, config: BridgeConfig, event: DecisionEvent): Promise<void> {
  if (!semanticEnabled(config)) {
    return;
  }
  await upsertSemanticDoc(workspace, config, {
    id: `decision:${event.id}`,
    source: "decisions",
    ts: event.ts,
    ref: `decision:${event.id}`,
    text: [event.title, event.context, event.decision, event.impact, ...event.supersedes].join("\n")
  });
}

async function indexSession(workspace: string, config: BridgeConfig, event: SessionEvent): Promise<void> {
  if (!semanticEnabled(config)) {
    return;
  }
  await upsertSemanticDoc(workspace, config, {
    id: `session:${event.ts}:${event.tool}`,
    source: "sessions",
    ts: event.ts,
    ref: `session:${event.ts}`,
    text: [event.intent, event.summary, ...event.actions, ...event.artifacts, ...event.tags].join("\n")
  });
}

/**
 * Pulls notes from an Obsidian vault back into `.memory-bridge/`.
 *
 * - `Decisions/*.md`: matched by `id`. Notes without an id become new decisions and get the id written back.
 * - `Sessions/*.md`: matched by `ts + tool`.
 * - `Project-Context.md`: replaces `project-context.md` when different.
 * - `Handoff.md` is generated on export and ignored here.
 *
 * Idempotent: identical content is reported as `unchanged`. When both sides differ, `prefer` decides
 * (default `vault`, because the vault being the source of truth is the reason this command exists).
 */
export async function importObsidianVault(
  workspace: string,
  config: BridgeConfig,
  sourceVaultDir: string,
  options: ObsidianImportOptions = {}
): Promise<ObsidianImportResult> {
  const vaultDir = path.resolve(sourceVaultDir);
  const prefer: ObsidianImportPreference = options.prefer ?? config.integrations?.obsidian?.prefer ?? "vault";
  const paths = resolveBridgePaths(path.resolve(workspace));
  const result: ObsidianImportResult = {
    vaultDir,
    scannedFiles: 0,
    created: { decisions: [], sessions: [] },
    updated: { decisions: [], sessions: [] },
    unchanged: 0,
    skippedConflicts: [],
    assignedIds: [],
    projectContext: "absent",
    warnings: []
  };

  if (!(await exists(vaultDir))) {
    throw new Error(`Obsidian vault not found: ${vaultDir}`);
  }

  const [decisionsResult, sessionsResult] = await Promise.all([
    readDecisionEvents(workspace, config, 100000),
    readSessionEvents(workspace, config, 100000)
  ]);
  result.warnings.push(...decisionsResult.warnings, ...sessionsResult.warnings);

  const bridgeDecisions = new Map(decisionsResult.events.map((event) => [event.id, event]));
  const bridgeSessions = new Map(sessionsResult.events.map((event) => [`${event.ts}\u0000${event.tool}`, event]));
  const takenIds = new Set(bridgeDecisions.keys());

  // 1. Decisions
  for (const file of await listMarkdownFiles(path.join(vaultDir, "Decisions"))) {
    result.scannedFiles += 1;
    const content = await fs.readFile(file, "utf8");
    const parsed = parseObsidianDecisionNote(content);
    if (!parsed) {
      result.warnings.push(`Skipped ${path.relative(vaultDir, file)}: no title found.`);
      continue;
    }

    let id = parsed.id;
    if (!id) {
      id = generateDecisionId(takenIds);
      await writeIdIntoFrontmatter(file, content, id);
      result.assignedIds.push({ file, id });
    }
    takenIds.add(id);

    const existing = bridgeDecisions.get(id);
    const candidate: DecisionEvent = applyRedaction(
      {
        id,
        ts: parsed.ts ?? existing?.ts ?? new Date().toISOString(),
        title: parsed.title,
        context: parsed.context,
        decision: parsed.decision,
        impact: parsed.impact,
        supersedes: parsed.supersedes
      },
      config
    );

    if (!existing) {
      await appendDecisionEvent(workspace, config, candidate);
      await indexDecision(workspace, config, candidate);
      bridgeDecisions.set(id, candidate);
      result.created.decisions.push(id);
      continue;
    }
    if (decisionFingerprint(existing) === decisionFingerprint(candidate)) {
      result.unchanged += 1;
      continue;
    }
    if (prefer === "bridge") {
      result.skippedConflicts.push(`decision:${id}`);
      continue;
    }
    await replaceDecisionEvent(workspace, config, candidate);
    await indexDecision(workspace, config, candidate);
    bridgeDecisions.set(id, candidate);
    result.updated.decisions.push(id);
  }

  // 2. Sessions
  for (const file of await listMarkdownFiles(path.join(vaultDir, "Sessions"))) {
    result.scannedFiles += 1;
    const parsed = parseObsidianSessionNote(await fs.readFile(file, "utf8"));
    if (!parsed) {
      result.warnings.push(`Skipped ${path.relative(vaultDir, file)}: missing tool, date or intent.`);
      continue;
    }
    const key = `${parsed.ts}\u0000${parsed.tool}`;
    const existing = bridgeSessions.get(key);
    const candidate: SessionEvent = applyRedaction(
      {
        ts: parsed.ts,
        tool: parsed.tool,
        workspace: existing?.workspace ?? path.resolve(workspace),
        branch: parsed.branch,
        intent: parsed.intent,
        actions: parsed.actions,
        artifacts: parsed.artifacts,
        summary: parsed.summary,
        tags: parsed.tags,
        ...(existing?.taskId ? { taskId: existing.taskId } : {}),
        ...(existing?.parentTaskId ? { parentTaskId: existing.parentTaskId } : {})
      },
      config
    );

    if (!existing) {
      await appendSessionEvent(workspace, config, candidate);
      await indexSession(workspace, config, candidate);
      bridgeSessions.set(key, candidate);
      result.created.sessions.push(`${candidate.ts}:${candidate.tool}`);
      continue;
    }
    if (sessionFingerprint(existing) === sessionFingerprint(candidate)) {
      result.unchanged += 1;
      continue;
    }
    if (prefer === "bridge") {
      result.skippedConflicts.push(`session:${candidate.ts}:${candidate.tool}`);
      continue;
    }
    await replaceSessionEvent(workspace, config, candidate);
    await indexSession(workspace, config, candidate);
    bridgeSessions.set(key, candidate);
    result.updated.sessions.push(`${candidate.ts}:${candidate.tool}`);
  }

  // 3. Project context
  const contextNote = path.join(vaultDir, "Project-Context.md");
  if (await exists(contextNote)) {
    result.scannedFiles += 1;
    const vaultText = applyRedaction(stripFrontmatter(await fs.readFile(contextNote, "utf8")), config);
    const bridgeText = await readProjectContext(workspace);
    if (bridgeText === undefined) {
      await atomicWriteFile(paths.projectContextFile, vaultText, 0o600);
      result.projectContext = "created";
    } else if (bridgeText.replace(/\r\n/g, "\n").trimEnd() === vaultText.trimEnd()) {
      result.projectContext = "unchanged";
      result.unchanged += 1;
    } else if (prefer === "bridge") {
      result.projectContext = "skipped-conflict";
      result.skippedConflicts.push("project-context");
    } else {
      await atomicWriteFile(paths.projectContextFile, vaultText, 0o600);
      result.projectContext = "updated";
    }
  }

  return result;
}
