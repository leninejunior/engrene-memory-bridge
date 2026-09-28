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

/** Only sessions this recent feed Pending / Next Steps. Measured from the newest session, not from "now",
 *  so an idle project still shows where it stopped. */
export const HANDOFF_WINDOW_DAYS = 14;
export const HANDOFF_MAX_SESSIONS = 25;
export const HANDOFF_LIST_LIMIT = 8;

const PENDING_MARKER = /\b(todo|pend|pending|fixme|next)\b/i;
const DONE_MARKER = /^\s*(done|resolved|resolves|fixed|closed|merged|feito|resolvido|conclu[ií]do)\s*[:\-\u2013]\s*(.+)$/i;
const LEADING_MARKER = /^\s*(todo|pend|pending|fixme|next|done|resolved|resolves|fixed|closed|merged|feito|resolvido|conclu[ií]do)\s*[:\-\u2013]?\s*/i;

function normalizeItem(text: string): string {
  return text.replace(LEADING_MARKER, "").toLowerCase().replace(/\s+/g, " ").trim();
}

/** Newest first, capped in count and in age relative to the newest session. */
export function recentSessions(events: SessionEvent[]): SessionEvent[] {
  const latest = events.at(-1);
  if (!latest) {
    return [];
  }
  const latestTs = Date.parse(latest.ts);
  const cutoff = Number.isNaN(latestTs) ? Number.NEGATIVE_INFINITY : latestTs - HANDOFF_WINDOW_DAYS * 86_400_000;
  return events
    .slice(-HANDOFF_MAX_SESSIONS)
    .filter((event) => {
      const ts = Date.parse(event.ts);
      return Number.isNaN(ts) || ts >= cutoff;
    })
    .reverse();
}

/**
 * Pending items come from session actions that carry a pending marker (todo/pending/fixme/next),
 * newest first. An action such as `done: <text>` in the same or a later session retires every
 * older pending item whose text matches. Nothing is read back from a previous handoff.
 */
export function derivePendingFromSessions(events: SessionEvent[]): string[] {
  const done = new Set<string>();
  const pending: string[] = [];
  // Newest session first, so the cut in compactList drops old items and never new ones.
  for (const event of recentSessions(events)) {
    // Retire within the same session too: ["next: X", "done: X"] must not leave X pending.
    const retiredHere: string[] = [];
    for (const action of event.actions) {
      const finished = DONE_MARKER.exec(action);
      const key = finished ? normalizeItem(finished[2] ?? "") : "";
      if (key) {
        retiredHere.push(key);
      }
    }
    for (const key of retiredHere) {
      done.add(key);
    }
    for (const action of event.actions) {
      if (DONE_MARKER.test(action) || !PENDING_MARKER.test(action)) {
        continue;
      }
      // Exact match after normalization: a loose `includes` would let `done: PR` retire `preparar`.
      const key = normalizeItem(action);
      if (key && !done.has(key)) {
        pending.push(action);
      }
    }
  }
  return pending;
}

/** Next steps are the newest session's actions, minus `done:` markers; older sessions are not replayed. */
export function deriveNextStepsFromSessions(events: SessionEvent[]): string[] {
  const latest = events.at(-1);
  if (!latest) {
    return [];
  }
  return latest.actions.filter((action) => !DONE_MARKER.test(action));
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

export function filterActiveDecisions(events: DecisionEvent[]): {
  active: DecisionEvent[];
  superseded: DecisionEvent[];
} {
  const supersededIds = new Set<string>();
  for (const event of events) {
    if (Array.isArray(event.supersedes)) {
      for (const id of event.supersedes) {
        if (id) {
          supersededIds.add(id);
        }
      }
    }
  }

  const active: DecisionEvent[] = [];
  const superseded: DecisionEvent[] = [];

  for (const event of events) {
    if (supersededIds.has(event.id)) {
      superseded.push(event);
    } else {
      active.push(event);
    }
  }

  return { active, superseded };
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
  const rawProjectObjective = parseProjectObjective(projectContext);
  const isTemplatePlaceholder =
    Boolean(rawProjectObjective && /describe the current milestone/i.test(rawProjectObjective));

  const projectObjective = !isTemplatePlaceholder && rawProjectObjective ? rawProjectObjective : undefined;
  const currentTask = latestSession?.intent;

  const { active: activeDecisions } = filterActiveDecisions(decisionsResult.events);
  const recentDecisions = activeDecisions.slice(-5);

  // Pinned items live in project-context.md (hand-maintained). The previous handoff is never read
  // back: doing so re-injected every item forever and let old items push new ones out (issue #15).
  const pending = compactList(
    [
      ...parseBulletsFromSection(projectContext, "Pending"),
      ...derivePendingFromSessions(sessionsResult.events)
    ],
    HANDOFF_LIST_LIMIT
  );

  const nextSteps = compactList(
    [
      ...parseBulletsFromSection(projectContext, "Next Steps"),
      ...deriveNextStepsFromSessions(sessionsResult.events)
    ],
    HANDOFF_LIST_LIMIT
  );

  const objective =
    projectObjective ||
    latestSession?.intent ||
    rawProjectObjective ||
    "No explicit objective yet. Add one in project-context.md or log an intent.";

  if (sessionsResult.events.length === 0) {
    warnings.push("No session history found yet.");
  }
  if (decisionsResult.events.length === 0) {
    warnings.push("No decision history found yet.");
  }
  const currentFocus = nextSteps[0] || pending[0] || undefined;

  const snapshot: ResumeSnapshot = {
    objective,
    projectObjective,
    currentTask,
    currentFocus,
    recentDecisions,
    activeDecisions,
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
          .map((item) => {
            const supersededTag = item.supersedes && item.supersedes.length > 0 ? ` (supersedes ${item.supersedes.join(", ")})` : "";
            return `- [${item.id}] ${item.title}${supersededTag}: ${item.decision}`;
          })
          .join("\n");

  const pending = snapshot.pending.length === 0 ? "- None" : snapshot.pending.map((item) => `- ${item}`).join("\n");
  const nextSteps =
    snapshot.nextSteps.length === 0 ? "- None" : snapshot.nextSteps.map((item) => `- ${item}`).join("\n");

  const warnings =
    snapshot.warnings.length === 0
      ? ""
      : `\nWarnings:\n${snapshot.warnings.map((item) => `- ${item}`).join("\n")}`;

  const primaryObjective = snapshot.projectObjective || snapshot.objective;
  const taskLine =
    snapshot.currentTask && snapshot.currentTask !== primaryObjective
      ? `\nCurrent Task: ${snapshot.currentTask}`
      : "";
  const focusLine = snapshot.currentFocus ? `\nImmediate Focus: ${snapshot.currentFocus}` : "";

  return [
    `Resume for ${tool}`,
    "",
    `Objective: ${primaryObjective}${taskLine}${focusLine}`,
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
    .filter((line) => line !== undefined)
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
