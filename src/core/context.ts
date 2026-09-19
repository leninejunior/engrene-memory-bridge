import type { BridgeConfig, DecisionEvent, ResumeSnapshot, SessionEvent } from "../types/events.js";
import { readDecisionEvents, readHandoff, readProjectContext, readSessionEvents } from "./store.js";

function parseProjectObjective(markdown: string | undefined): string | undefined {
  if (!markdown) {
    return undefined;
  }
  const lines = markdown.split(/\r?\n/);
  const idx = lines.findIndex((line) => /##\s+Current Objective/i.test(line));
  if (idx < 0) {
    return undefined;
  }
  for (let i = idx + 1; i < lines.length; i += 1) {
    const line = lines[i]?.trim() ?? "";
    if (line === "") {
      continue;
    }
    if (line.startsWith("## ")) {
      break;
    }
    return line;
  }
  return undefined;
}

function parseBulletsFromSection(markdown: string | undefined, sectionTitle: string): string[] {
  if (!markdown) {
    return [];
  }
  const lines = markdown.split(/\r?\n/);
  const regex = new RegExp(`^##\\s+${sectionTitle}\\s*$`, "i");
  const idx = lines.findIndex((line) => regex.test(line.trim()));
  if (idx < 0) {
    return [];
  }

  const items: string[] = [];
  for (let i = idx + 1; i < lines.length; i += 1) {
    const line = lines[i] ?? "";
    const trimmed = line.trim();
    if (trimmed.startsWith("## ")) {
      break;
    }
    if (trimmed.startsWith("- ")) {
      items.push(trimmed.slice(2).trim());
    }
  }
  return items;
}

function derivePendingFromSessions(events: SessionEvent[]): string[] {
  const pending: string[] = [];
  for (const event of events.slice(-10)) {
    for (const action of event.actions) {
      if (/\b(todo|pend|pending|fixme|next)\b/i.test(action)) {
        pending.push(action);
      }
    }
  }
  return pending;
}

function compactList(items: string[], limit: number): string[] {
  const deduped = Array.from(
    new Set(
      items
        .map((item) => item.trim())
        .filter((item) => item !== "" && !/^(n\/a|na|none)$/i.test(item))
    )
  );
  return deduped.slice(0, limit);
}

export interface BuildContextResult {
  snapshot: ResumeSnapshot;
  sessions: SessionEvent[];
  decisions: DecisionEvent[];
  projectContext: string | undefined;
  handoff: string | undefined;
}

export async function buildContextSnapshot(
  workspace: string,
  config: BridgeConfig
): Promise<BuildContextResult> {
  const [sessionsResult, decisionsResult, handoffResult, projectContext] = await Promise.all([
    readSessionEvents(workspace, config, 100),
    readDecisionEvents(workspace, config, 50),
    readHandoff(workspace, config),
    readProjectContext(workspace)
  ]);

  const warnings = [
    ...sessionsResult.warnings,
    ...decisionsResult.warnings,
    ...handoffResult.warnings
  ];

  const latestSession = sessionsResult.events.at(-1);
  const objective =
    latestSession?.intent ||
    parseProjectObjective(projectContext) ||
    "No explicit objective yet. Add one in project-context.md or log an intent.";

  const recentDecisions = decisionsResult.events.slice(-5);
  const pending = compactList(
    [
      ...parseBulletsFromSection(handoffResult.text, "Pending"),
      ...derivePendingFromSessions(sessionsResult.events)
    ],
    8
  );

  const nextSteps = compactList(
    [
      ...parseBulletsFromSection(handoffResult.text, "Next Steps"),
      ...(latestSession?.actions ?? [])
    ],
    8
  );

  if (sessionsResult.events.length === 0) {
    warnings.push("No session history found yet.");
  }
  if (decisionsResult.events.length === 0) {
    warnings.push("No decision history found yet.");
  }

  const snapshot: ResumeSnapshot = {
    objective,
    recentDecisions,
    pending,
    nextSteps,
    warnings
  };

  return {
    snapshot,
    sessions: sessionsResult.events,
    decisions: decisionsResult.events,
    projectContext,
    handoff: handoffResult.text
  };
}

export function renderResumeText(tool: string, snapshot: ResumeSnapshot): string {
  const decisions =
    snapshot.recentDecisions.length === 0
      ? "- None"
      : snapshot.recentDecisions
          .map((item) => `- [${item.id}] ${item.title}: ${item.decision}`)
          .join("\n");

  const pending = snapshot.pending.length === 0 ? "- None" : snapshot.pending.map((item) => `- ${item}`).join("\n");
  const nextSteps =
    snapshot.nextSteps.length === 0 ? "- None" : snapshot.nextSteps.map((item) => `- ${item}`).join("\n");

  const warnings =
    snapshot.warnings.length === 0
      ? ""
      : `\nWarnings:\n${snapshot.warnings.map((item) => `- ${item}`).join("\n")}`;

  return [
    `Resume for ${tool}`,
    "",
    `Objective: ${snapshot.objective}`,
    "",
    "Recent Decisions:",
    decisions,
    "",
    "Pending:",
    pending,
    "",
    "Next Steps:",
    nextSteps,
    warnings
  ]
    .join("\n")
    .trimEnd() + "\n";
}

export function renderHandoffMarkdown(input: {
  objective: string;
  recentDecisions: DecisionEvent[];
  pending: string[];
  nextSteps: string[];
  recentArtifacts: string[];
  risks?: string[];
}): string {
  const decisions =
    input.recentDecisions.length === 0
      ? "- N/A"
      : input.recentDecisions.map((item) => `- [${item.id}] ${item.title}: ${item.decision}`).join("\n");
  const pending = input.pending.length === 0 ? "- N/A" : input.pending.map((item) => `- ${item}`).join("\n");
  const next = input.nextSteps.length === 0 ? "- N/A" : input.nextSteps.map((item) => `- ${item}`).join("\n");
  const artifacts =
    input.recentArtifacts.length === 0
      ? "- N/A"
      : input.recentArtifacts.map((item) => `- ${item}`).join("\n");

  const sections = [
    `# Handoff`,
    ``,
    `## Objective`,
    input.objective,
    ``,
    `## Recent Decisions`,
    decisions,
    ``,
    `## Pending`,
    pending,
    ``,
    `## Next Steps`,
    next,
    ``,
    `## Recent Artifacts`,
    artifacts
  ];

  if (input.risks && input.risks.length > 0) {
    sections.push(``, `## Risks & Warnings`, input.risks.map((r) => `- ${r}`).join("\n"));
  }

  return sections.join("\n").trimEnd() + "\n";
}
