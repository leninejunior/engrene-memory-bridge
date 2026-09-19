import fs from "node:fs/promises";
import path from "node:path";

import type { BridgeConfig, DecisionEvent, ObservationEvent, SessionEvent } from "../types/events.js";
import { currentGitBranch } from "./git.js";
import { readObservationsWithFiles } from "./capture.js";
import { buildContextSnapshot, renderHandoffMarkdown } from "./context.js";
import { appendSessionEvent, readDecisionEvents, saveHandoff } from "./store.js";
import { semanticEnabled, upsertSemanticDoc } from "./vector.js";

export interface ConsolidateOptions {
  mode?: "deterministic" | "llm";
  llmProvider?: string;
  llmModel?: string;
}

export interface ConsolidateResult {
  ok: boolean;
  totalDecisions: number;
  activeDecisions: number;
  supersededDecisions: number;
  supersededIds: string[];
  consolidatedSessions: number;
  observationsProcessed: number;
  handoffRefreshed: boolean;
  warnings: string[];
}

export async function runConsolidation(
  workspace: string,
  config: BridgeConfig,
  options?: ConsolidateOptions
): Promise<ConsolidateResult> {
  const normalized = path.resolve(workspace);
  const warnings: string[] = [];

  // 1. Synthesize pending observations from observations/
  let consolidatedSessionsCount = 0;
  let observationsProcessedCount = 0;
  const allDetectedRisks: string[] = [];

  try {
    const { events: rawEvents, processedFiles } = await readObservationsWithFiles(normalized, 50);
    if (rawEvents.length > 0) {
      observationsProcessedCount = rawEvents.length;

      // Group observations by sessionId
      const sessionMap = new Map<string, ObservationEvent[]>();
      for (const ev of rawEvents) {
        const sId = ev.sessionId || "default";
        const list = sessionMap.get(sId) || [];
        list.push(ev);
        sessionMap.set(sId, list);
      }

      for (const [sessionId, obsList] of sessionMap.entries()) {
        let intent = "Executed session tasks";
        const actions: string[] = [];
        const artifacts: string[] = [];
        const detectedRisks: string[] = [];
        let tool = "ai";
        let latestTs = new Date().toISOString();

        for (const obs of obsList) {
          latestTs = obs.ts || latestTs;
          tool = obs.tool || tool;

          if (obs.type === "user_prompt") {
            const prompt = String(
              obs.payload?.prompt ??
              obs.payload?.intent ??
              obs.payload?.content ??
              ""
            ).trim();
            if (prompt) {
              intent = prompt.slice(0, 120);
            }
          } else if (obs.type === "tool_call") {
            const toolName = String(obs.payload?.tool ?? obs.payload?.content ?? "action");
            actions.push(`Executed ${toolName}`);

            const fileList = Array.isArray(obs.payload?.files)
              ? obs.payload.files.map(String)
              : [obs.payload?.path, obs.payload?.file].filter(Boolean).map(String);

            for (const f of fileList) {
              if (f && !artifacts.includes(f)) {
                artifacts.push(f);
              }
            }
          } else if (obs.type === "tool_result") {
            const resultStr = JSON.stringify(obs.payload || "");
            if (/error|fail|exception|crash/i.test(resultStr)) {
              const riskMsg = `Potential failure in session ${sessionId}`;
              detectedRisks.push(riskMsg);
              allDetectedRisks.push(riskMsg);
            }
          }
        }

        const distinctActions = Array.from(new Set(actions)).slice(0, 8);
        const distinctArtifacts = Array.from(new Set(artifacts)).slice(0, 8);

        const syntheticSession: SessionEvent = {
          ts: latestTs,
          tool,
          workspace: normalized,
          branch: currentGitBranch(normalized),
          intent,
          actions: distinctActions.length > 0 ? distinctActions : ["completed observation tasks"],
          artifacts: distinctArtifacts,
          summary: `Synthesized from ${obsList.length} observations (session: ${sessionId})`,
          tags: ["consolidated", "auto-capture"]
        };

        await appendSessionEvent(normalized, config, syntheticSession);
        consolidatedSessionsCount += 1;
      }

      // Cleanup ONLY processed observation files to prevent data loss
      for (const file of processedFiles) {
        try {
          await fs.unlink(file);
        } catch {
          // Ignore removal error
        }
      }
    }
  } catch (err) {
    warnings.push(`Observation consolidation warning: ${err instanceof Error ? err.message : String(err)}`);
  }

  // 2. Read decisions and deduplicate superseded
  const { events: decisions, warnings: decWarnings } = await readDecisionEvents(normalized, config, 1000);
  warnings.push(...decWarnings);

  const supersededSet = new Set<string>();
  for (const dec of decisions) {
    for (const sup of dec.supersedes) {
      supersededSet.add(sup);
    }
  }

  const activeDecisionsList: DecisionEvent[] = [];
  const supersededIds: string[] = [];

  for (const dec of decisions) {
    if (supersededSet.has(dec.id)) {
      supersededIds.push(dec.id);
    } else {
      activeDecisionsList.push(dec);
    }
  }

  // 3. Refresh and build consolidated handoff
  const context = await buildContextSnapshot(normalized, config);
  const recentArtifacts = context.sessions
    .slice(-8)
    .flatMap((session) => session.artifacts)
    .slice(-12);

  const markdown = renderHandoffMarkdown({
    objective: context.snapshot.objective,
    recentDecisions: activeDecisionsList.slice(-5),
    pending: context.snapshot.pending,
    nextSteps: context.snapshot.nextSteps,
    recentArtifacts,
    risks: Array.from(new Set(allDetectedRisks))
  });

  await saveHandoff(normalized, config, markdown);

  if (semanticEnabled(config)) {
    await upsertSemanticDoc(normalized, config, {
      id: "handoff:latest",
      source: "handoff",
      ts: new Date().toISOString(),
      ref: "handoff.md",
      text: markdown,
      memory_type: "working"
    });
  }

  return {
    ok: true,
    totalDecisions: decisions.length,
    activeDecisions: activeDecisionsList.length,
    supersededDecisions: supersededIds.length,
    supersededIds,
    consolidatedSessions: consolidatedSessionsCount,
    observationsProcessed: observationsProcessedCount,
    handoffRefreshed: true,
    warnings
  };
}
