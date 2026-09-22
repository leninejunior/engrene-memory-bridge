import fs from "node:fs/promises";
import path from "node:path";

import type { BridgeConfig, DecisionEvent, SessionEvent } from "../types/events.js";
import { filterActiveDecisions } from "./context.js";
import { ensureDirSecure } from "./fs-utils.js";
import { readDecisionEvents, readHandoff, readProjectContext, readSessionEvents } from "./store.js";

export interface ObsidianSyncResult {
  vaultDir: string;
  createdFiles: string[];
  totalDecisions: number;
  totalSessions: number;
}

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

  const [sessionsResult, decisionsResult, handoffResult, projectContext] = await Promise.all([
    readSessionEvents(workspace, config, 1000),
    readDecisionEvents(workspace, config, 10000),
    readHandoff(workspace, config),
    readProjectContext(workspace)
  ]);

  // 1. Export Decisions with Wikilinks
  const { active, superseded } = filterActiveDecisions(decisionsResult.events);
  const allDecisions = [...active, ...superseded];

  for (const dec of allDecisions) {
    const filename = `${dec.id}.md`;
    const filepath = path.join(decisionsDir, filename);
    const content = formatObsidianDecisionNote(dec);
    await fs.writeFile(filepath, content, "utf8");
    createdFiles.push(filepath);
  }

  // 2. Export Sessions
  for (const session of sessionsResult.events) {
    const safeDate = session.ts.slice(0, 10);
    const safeTool = session.tool.replace(/[^a-zA-Z0-9_-]/g, "_");
    const filename = `${safeDate}-${safeTool}-${session.ts.slice(11, 19).replace(/:/g, "-")}.md`;
    const filepath = path.join(sessionsDir, filename);
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
