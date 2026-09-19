import path from "node:path";
import type { BridgeConfig, DecisionEvent } from "../types/events.js";
import { buildContextSnapshot, renderHandoffMarkdown } from "./context.js";
import { readDecisionEvents, saveHandoff } from "./store.js";
import { semanticEnabled, upsertSemanticDoc } from "./vector.js";

export interface ConsolidateResult {
  ok: boolean;
  totalDecisions: number;
  activeDecisions: number;
  supersededDecisions: number;
  supersededIds: string[];
  handoffRefreshed: boolean;
  warnings: string[];
}

export async function runConsolidation(workspace: string, config: BridgeConfig): Promise<ConsolidateResult> {
  const normalized = path.resolve(workspace);
  const { events: decisions, warnings } = await readDecisionEvents(normalized, config, 1000);

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

  // Refresh and build consolidated handoff
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
    recentArtifacts
  });

  await saveHandoff(normalized, config, markdown);

  if (semanticEnabled(config)) {
    await upsertSemanticDoc(normalized, config, {
      id: "handoff:latest",
      source: "handoff",
      ts: new Date().toISOString(),
      ref: "handoff.md",
      text: markdown
    });
  }

  return {
    ok: true,
    totalDecisions: decisions.length,
    activeDecisions: activeDecisionsList.length,
    supersededDecisions: supersededIds.length,
    supersededIds,
    handoffRefreshed: true,
    warnings
  };
}
