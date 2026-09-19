import { filterActiveDecisions } from "./context.js";
import type { BridgeConfig, SearchHit } from "../types/events.js";
import { readDecisionEvents, readHandoff, readProjectContext, readSessionEvents } from "./store.js";
import {
  deleteSemanticDocs,
  ftsSearch,
  getSemanticDocCount,
  isSqliteSupported,
  semanticEnabled,
  semanticSearch,
  upsertSemanticDoc
} from "./vector.js";

export type SearchMode = "text" | "semantic" | "hybrid";

function normalize(input: string): string {
  return input.toLowerCase();
}

function tokenize(input: string): string[] {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, " ")
    .split(/\s+/)
    .filter((token) => token.length > 1);
}

function bm25Score(query: string, content: string): number {
  const q = normalize(query).trim();
  if (!q) {
    return 0;
  }
  const c = normalize(content);
  let score = 0;

  // Exact phrase match boost
  if (c.includes(q)) {
    score += 5.0;
  }

  const queryTokens = tokenize(query);
  const contentTokens = tokenize(content);
  if (queryTokens.length === 0 || contentTokens.length === 0) {
    return score;
  }

  const tokenFreq = new Map<string, number>();
  for (const token of contentTokens) {
    tokenFreq.set(token, (tokenFreq.get(token) ?? 0) + 1);
  }

  const docLength = contentTokens.length;
  const avgDocLength = 60;
  const k1 = 1.2;
  const b = 0.75;

  for (const token of queryTokens) {
    const tf = tokenFreq.get(token) ?? 0;
    if (tf > 0) {
      const termScore = (tf * (k1 + 1)) / (tf + k1 * (1 - b + b * (docLength / avgDocLength)));
      score += termScore;
    }
  }

  return score;
}

function snippet(content: string, query: string): string {
  const normalized = normalize(content);
  const idx = normalized.indexOf(normalize(query));
  if (idx < 0) {
    return content.slice(0, 240);
  }
  const start = Math.max(0, idx - 80);
  const end = Math.min(content.length, idx + 160);
  return content.slice(start, end);
}

export async function indexSemanticFromState(workspace: string, config: BridgeConfig): Promise<void> {
  if (!semanticEnabled(config)) {
    return;
  }

  const [sessionsResult, decisionsResult, handoffResult, projectContext] = await Promise.all([
    readSessionEvents(workspace, config, 300),
    readDecisionEvents(workspace, config, 200),
    readHandoff(workspace, config),
    readProjectContext(workspace)
  ]);

  for (const event of sessionsResult.events) {
    await upsertSemanticDoc(workspace, config, {
      id: `session:${event.ts}:${event.tool}`,
      source: "sessions",
      ts: event.ts,
      ref: `session:${event.ts}`,
      text: [event.intent, event.summary, ...event.actions, ...event.artifacts, ...event.tags].join("\n")
    });
  }

  const { active: activeDecisions, superseded: supersededDecisions } = filterActiveDecisions(decisionsResult.events);
  for (const event of activeDecisions) {
    await upsertSemanticDoc(workspace, config, {
      id: `decision:${event.id}`,
      source: "decisions",
      ts: event.ts,
      ref: `decision:${event.id}`,
      text: [event.title, event.context, event.decision, event.impact, ...event.supersedes].join("\n")
    });
  }

  // Purge any superseded decisions from SQLite vector and FTS5 tables
  const supersededIds = Array.from(supersededDecisions.keys()).map((id) => `decision:${id}`);
  if (supersededIds.length > 0) {
    await deleteSemanticDocs(workspace, config, supersededIds);
  }

  if (handoffResult.text) {
    await upsertSemanticDoc(workspace, config, {
      id: "handoff:latest",
      source: "handoff",
      ts: new Date().toISOString(),
      ref: "handoff.md",
      text: handoffResult.text
    });
  }

  if (projectContext) {
    await upsertSemanticDoc(workspace, config, {
      id: "project-context:latest",
      source: "project-context",
      ts: new Date().toISOString(),
      ref: "project-context.md",
      text: projectContext
    });
  }
}

export async function searchMemory(args: {
  workspace: string;
  config: BridgeConfig;
  query: string;
  mode: SearchMode;
  limit: number;
}): Promise<{ hits: SearchHit[]; warnings: string[] }> {
  const { workspace, config, query, mode, limit } = args;
  const warnings: string[] = [];

  const [sessionsResult, decisionsResult, handoffResult, projectContext] = await Promise.all([
    readSessionEvents(workspace, config, 300),
    readDecisionEvents(workspace, config, 200),
    readHandoff(workspace, config),
    readProjectContext(workspace)
  ]);

  warnings.push(...sessionsResult.warnings, ...decisionsResult.warnings, ...handoffResult.warnings);

  const textHits: SearchHit[] = [];

  for (const event of sessionsResult.events) {
    const content = [event.intent, event.summary, ...event.actions, ...event.artifacts, ...event.tags].join("\n");
    const score = bm25Score(query, content);
    if (score > 0) {
      textHits.push({
        source: "sessions",
        score,
        ts: event.ts,
        ref: `session:${event.ts}`,
        snippet: snippet(content, query)
      });
    }
  }

  const { active: activeDecisions } = filterActiveDecisions(decisionsResult.events);
  for (const event of activeDecisions) {
    const content = [event.title, event.context, event.decision, event.impact, ...event.supersedes].join("\n");
    const score = bm25Score(query, content);
    if (score > 0) {
      textHits.push({
        source: "decisions",
        score,
        ts: event.ts,
        ref: `decision:${event.id}`,
        snippet: snippet(content, query)
      });
    }
  }

  if (handoffResult.text) {
    const score = bm25Score(query, handoffResult.text);
    if (score > 0) {
      textHits.push({
        source: "handoff",
        score,
        ref: "handoff.md",
        snippet: snippet(handoffResult.text, query)
      });
    }
  }

  if (projectContext) {
    const score = bm25Score(query, projectContext);
    if (score > 0) {
      textHits.push({
        source: "project-context",
        score,
        ref: "project-context.md",
        snippet: snippet(projectContext, query)
      });
    }
  }

  const sortedTextHits = textHits.sort((a, b) => b.score - a.score).slice(0, Math.max(1, limit));
  let lexicalHits = sortedTextHits;
  if (semanticEnabled(config) && (await isSqliteSupported())) {
    const ftsHits = await ftsSearch(workspace, config, query, limit);
    if (ftsHits.length > 0) {
      lexicalHits = ftsHits;
    }
  }

  if (mode === "text") {
    return { hits: lexicalHits, warnings };
  }

  if (!semanticEnabled(config)) {
    warnings.push("Semantic/hybrid search requested, but semanticSearch.enabled=false. Falling back to text search.");
    return { hits: lexicalHits, warnings };
  }

  const docCount = await getSemanticDocCount(workspace, config);
  if (docCount === 0) {
    await indexSemanticFromState(workspace, config);
  }

  const semanticHits = await semanticSearch(workspace, config, query, limit);

  if (mode === "semantic") {
    if (semanticHits.length === 0) {
      warnings.push("Semantic index is empty. Returning text search hits.");
      return { hits: lexicalHits, warnings };
    }
    return { hits: semanticHits, warnings };
  }

  // Hybrid Mode: Reciprocal Rank Fusion (RRF) combining SQLite FTS5 BM25 (or in-memory fallback) + Vector Embeddings + Recency
  const hybridHits = rrfFusion(lexicalHits, semanticHits, 60, limit);
  return { hits: hybridHits.length > 0 ? hybridHits : lexicalHits, warnings };
}

export function rrfFusion(
  textHits: SearchHit[],
  semanticHits: SearchHit[],
  k = 60,
  limit = 10
): SearchHit[] {
  const scoreMap = new Map<string, { hit: SearchHit; rrfScore: number }>();

  textHits.forEach((hit, idx) => {
    const key = hit.ref || hit.snippet;
    const rank = idx + 1;
    const item = scoreMap.get(key) || { hit: { ...hit }, rrfScore: 0 };
    item.rrfScore += 1 / (k + rank);
    item.hit.text_score = hit.score;
    scoreMap.set(key, item);
  });

  semanticHits.forEach((hit, idx) => {
    const key = hit.ref || hit.snippet;
    const rank = idx + 1;
    const item = scoreMap.get(key) || { hit: { ...hit }, rrfScore: 0 };
    item.rrfScore += 1 / (k + rank);
    item.hit.semantic_score = hit.score;
    if (hit.ts && !item.hit.ts) {
      item.hit.ts = hit.ts;
    }
    scoreMap.set(key, item);
  });

  const now = Date.now();
  const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

  return Array.from(scoreMap.values())
    .map(({ hit, rrfScore }) => {
      let recencyBoost = 0;
      if (hit.ts) {
        const itemTime = new Date(hit.ts).getTime();
        if (!isNaN(itemTime)) {
          const age = Math.max(0, now - itemTime);
          if (age < SEVEN_DAYS_MS) {
            recencyBoost = (1 - age / SEVEN_DAYS_MS) * 0.005;
          }
        }
      }
      return {
        ...hit,
        score: rrfScore + recencyBoost,
        recency_score: recencyBoost
      };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, Math.max(1, limit));
}
