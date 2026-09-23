/**
 * Retrieval quality benchmark harness (issue #2).
 *
 * Builds a throw-away memory-bridge workspace from synthetic fixtures
 * (tests/benchmark/fixtures/*.json), runs a set of labeled queries through
 * every search mode exposed by src/core/search.ts and reports:
 *
 *   - precision@3, recall@5, MRR and noise@5 against the labeled expectations
 *   - superseded-decision leakage (does an obsolete decision reach the top-3?)
 *   - stale-session leakage (does a session written under an obsolete decision reach the top-3?)
 *   - latency p50/p95 per mode (each query is executed `runs` times after a warm-up)
 *   - the context-window footprint of `memory-bridge resume` (chars, tokens ~ chars/4)
 *
 * The harness only talks to the public functions of src/core (store, search,
 * context, config, vector). It never spawns the CLI, so results are the
 * in-process cost of the search itself (process start-up excluded).
 *
 * Determinism: nothing here is random. Fixture timestamps are fixed and older
 * than the 7-day recency window used by hybrid search, so rankings do not drift
 * with the wall clock. Only latency numbers vary between machines/runs.
 */

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

import { initWorkspace, loadConfig } from "../../src/core/config.js";
import {
  buildContextSnapshot,
  filterActiveDecisions,
  renderHandoffMarkdown,
  renderResumeText
} from "../../src/core/context.js";
import { atomicWriteFile } from "../../src/core/fs-utils.js";
import { resolveBridgePaths } from "../../src/core/paths.js";
import { indexSemanticFromState, searchMemory, type SearchMode } from "../../src/core/search.js";
import {
  appendDecisionEvent,
  appendSessionEvent,
  readDecisionEvents,
  readHandoff,
  readSessionEvents,
  saveHandoff
} from "../../src/core/store.js";
import { isSqliteSupported, semanticEnabled } from "../../src/core/vector.js";
import type { BridgeConfig, DecisionEvent, SearchHit, SessionEvent } from "../../src/types/events.js";

// ---------------------------------------------------------------------------
// Variants
// ---------------------------------------------------------------------------

/**
 * A variant is a search mode plus the workspace configuration it runs under.
 * `text` is what a default `memory-bridge init` gives you (in-memory BM25);
 * the other three need `init --semantic` (SQLite FTS5 + local embeddings).
 */
export type BenchmarkVariant = "text" | "text-fts5" | "semantic" | "hybrid";

export const ALL_VARIANTS: BenchmarkVariant[] = ["text", "text-fts5", "semantic", "hybrid"];

interface VariantSpec {
  mode: SearchMode;
  semantic: boolean;
  label: string;
}

const VARIANT_SPECS: Record<BenchmarkVariant, VariantSpec> = {
  text: { mode: "text", semantic: false, label: "text (in-memory BM25, default init)" },
  "text-fts5": { mode: "text", semantic: true, label: "text (SQLite FTS5, init --semantic)" },
  semantic: { mode: "semantic", semantic: true, label: "semantic (local embeddings)" },
  hybrid: { mode: "hybrid", semantic: true, label: "hybrid (RRF of FTS5 + embeddings)" }
};

export function isBenchmarkVariant(value: string): value is BenchmarkVariant {
  return (ALL_VARIANTS as string[]).includes(value);
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

export interface SessionFixture {
  /** Fixture-only alias used by queries.json (e.g. "s18"). Not persisted. */
  id: string;
  ts: string;
  tool: string;
  branch: string;
  intent: string;
  actions: string[];
  artifacts: string[];
  summary: string;
  tags: string[];
  taskId?: string;
  parentTaskId?: string;
  /** Decision ids this session was written under and which are now superseded. Not persisted. */
  staleFor?: string[];
}

export type DecisionFixture = DecisionEvent;

export interface QueryFixture {
  id: string;
  query: string;
  category?: string;
  /** Aliases (session fixture id or decision id) or full refs expected in the top-k. */
  expected: string[];
  /** Superseded decision ids that must NOT appear in the top-3. */
  supersededTraps?: string[];
  /** Session aliases describing an obsolete choice that should NOT appear in the top-3. */
  staleTraps?: string[];
  note?: string;
}

export interface BenchmarkFixtures {
  sessions: SessionFixture[];
  decisions: DecisionFixture[];
  queries: QueryFixture[];
}

const here = path.dirname(fileURLToPath(import.meta.url));

async function readJson<T>(file: string): Promise<T> {
  const text = await fs.readFile(file, "utf8");
  return JSON.parse(text) as T;
}

/**
 * The harness is compiled to dist/tests/benchmark, but the JSON fixtures stay in
 * the source tree. Try a sibling `fixtures/` first, then the source location.
 */
export async function resolveDefaultFixturesDir(): Promise<string> {
  const candidates = [path.resolve(here, "fixtures"), path.resolve(here, "../../../tests/benchmark/fixtures")];
  for (const candidate of candidates) {
    try {
      await fs.access(path.join(candidate, "queries.json"));
      return candidate;
    } catch {
      // try next candidate
    }
  }
  throw new Error(`Benchmark fixtures not found. Looked in: ${candidates.join(", ")}`);
}

export async function loadFixtures(fixturesDir?: string): Promise<BenchmarkFixtures> {
  const dir = fixturesDir ? path.resolve(fixturesDir) : await resolveDefaultFixturesDir();
  const [sessions, decisions, queries] = await Promise.all([
    readJson<SessionFixture[]>(path.join(dir, "sessions.json")),
    readJson<DecisionFixture[]>(path.join(dir, "decisions.json")),
    readJson<QueryFixture[]>(path.join(dir, "queries.json"))
  ]);
  return { sessions, decisions, queries };
}

// ---------------------------------------------------------------------------
// Report types
// ---------------------------------------------------------------------------

export interface LatencyStats {
  samples: number;
  p50: number;
  p95: number;
  min: number;
  max: number;
  mean: number;
}

export interface HitSummary {
  ref: string;
  source: string;
  score: number;
  snippet: string;
}

export interface QueryResult {
  id: string;
  query: string;
  category: string;
  expected: string[];
  supersededTraps: string[];
  staleTraps: string[];
  hits: HitSummary[];
  precisionAt3: number;
  recallAt5: number;
  reciprocalRank: number;
  noiseAt5: number;
  missing: string[];
  supersededLeak: boolean;
  staleLeak: boolean;
  leakedRefs: string[];
  /** Which lexical backend served a `text` search (detected from `text_score`). */
  lexicalBackend: "fts5" | "bm25-memory" | "none" | "n/a";
  warnings: string[];
  stableAcrossRuns: boolean;
  latencyP50Ms: number;
}

export interface VariantResult {
  variant: BenchmarkVariant;
  mode: SearchMode;
  label: string;
  semanticEnabled: boolean;
  skipped?: string;
  precisionAt3: number;
  recallAt5: number;
  mrr: number;
  noiseAt5: number;
  /** Best precision@3 attainable given the size of each gold set (min(|expected|, 3) / 3). */
  maxPrecisionAt3: number;
  /** Lowest noise@5 attainable given the size of each gold set (1 - min(|expected|, 5) / 5). */
  minNoiseAt5: number;
  supersededLeakRate: number;
  supersededLeakQueries: number;
  supersededTrapQueries: number;
  staleLeakRate: number;
  staleLeakQueries: number;
  staleTrapQueries: number;
  fullRecallQueries: number;
  queriesWithWarnings: number;
  unstableQueries: number;
  latencyMs: LatencyStats;
  queries: QueryResult[];
}

export type FootprintStatus = "below-target" | "within-target" | "above-target";

export interface FootprintMeasure {
  chars: number;
  lines: number;
  estimatedTokens: number;
  status: FootprintStatus;
}

export interface FootprintResult {
  targetTokens: { min: number; max: number };
  charsPerToken: number;
  resumeTool: string;
  resumeLatencyMs: number;
  resumeText: FootprintMeasure;
  resumeJson: FootprintMeasure;
  handoff: FootprintMeasure;
}

export interface CorpusStats {
  sessions: number;
  decisions: number;
  activeDecisions: number;
  supersededDecisions: number;
  supersedesLinks: number;
  tools: string[];
}

export interface BenchmarkReport {
  schema: "memory-bridge-benchmark/1";
  generatedAt: string;
  node: string;
  platform: string;
  arch: string;
  sqliteSupported: boolean;
  source: "fixtures" | "workspace";
  workspace: string;
  keptWorkspace: boolean;
  runs: number;
  limit: number;
  corpus: CorpusStats;
  queryCount: number;
  variants: VariantResult[];
  footprint: FootprintResult;
}

export interface BenchmarkOptions {
  /** Benchmark an existing workspace (its `.memory-bridge/`) instead of the synthetic fixtures. */
  workspace?: string;
  /** Directory holding sessions.json, decisions.json and queries.json. */
  fixturesDir?: string;
  /** Labeled queries file (required together with `workspace`). */
  queriesFile?: string;
  variants?: BenchmarkVariant[];
  /** Timed executions per query (after one untimed warm-up). */
  runs?: number;
  /** Hits requested per query; never below 5 because recall@5 needs them. */
  limit?: number;
  /** Keep the temporary workspace on disk (fixtures mode only). */
  keepWorkspace?: boolean;
  /** Tool name passed to `resume --for`. */
  resumeTool?: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export const FOOTPRINT_TARGET_TOKENS = { min: 300, max: 500 } as const;
export const CHARS_PER_TOKEN = 4;

function round(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function percentile(sortedAscending: number[], p: number): number {
  if (sortedAscending.length === 0) {
    return 0;
  }
  const rank = Math.ceil((p / 100) * sortedAscending.length);
  const index = Math.min(sortedAscending.length - 1, Math.max(0, rank - 1));
  return sortedAscending[index] ?? 0;
}

function latencyStats(samples: number[]): LatencyStats {
  const sorted = [...samples].sort((a, b) => a - b);
  const total = sorted.reduce((acc, value) => acc + value, 0);
  return {
    samples: sorted.length,
    p50: round(percentile(sorted, 50), 2),
    p95: round(percentile(sorted, 95), 2),
    min: round(sorted[0] ?? 0, 2),
    max: round(sorted[sorted.length - 1] ?? 0, 2),
    mean: round(sorted.length === 0 ? 0 : total / sorted.length, 2)
  };
}

function refOf(hit: SearchHit): string {
  return hit.ref ?? hit.snippet;
}

function measureText(text: string): FootprintMeasure {
  const chars = text.length;
  const estimatedTokens = Math.ceil(chars / CHARS_PER_TOKEN);
  const status: FootprintStatus =
    estimatedTokens < FOOTPRINT_TARGET_TOKENS.min
      ? "below-target"
      : estimatedTokens > FOOTPRINT_TARGET_TOKENS.max
        ? "above-target"
        : "within-target";
  return {
    chars,
    lines: text === "" ? 0 : text.split("\n").length,
    estimatedTokens,
    status
  };
}

function withSemantic(config: BridgeConfig, enabled: boolean): BridgeConfig {
  if (enabled) {
    return config;
  }
  return {
    ...config,
    semanticSearch: { ...config.semanticSearch, enabled: false, provider: "disabled" }
  };
}

const PROJECT_CONTEXT = `# Project Context

## Current Objective
Ship orbit-crm v1.0 on the simplified single-process stack (no Redis, no RabbitMQ).

## Constraints
- Local-first only
- Keep memory portable between tools
- Public API frozen under /v1

## Notes
Synthetic benchmark workspace generated by tests/benchmark/harness.ts.
`;

// ---------------------------------------------------------------------------
// Workspace population
// ---------------------------------------------------------------------------

function toSessionEvent(fixture: SessionFixture, workspace: string): SessionEvent {
  return {
    ts: fixture.ts,
    tool: fixture.tool,
    workspace,
    branch: fixture.branch,
    intent: fixture.intent,
    actions: fixture.actions,
    artifacts: fixture.artifacts,
    summary: fixture.summary,
    tags: fixture.tags,
    ...(fixture.taskId ? { taskId: fixture.taskId } : {}),
    ...(fixture.parentTaskId ? { parentTaskId: fixture.parentTaskId } : {})
  };
}

/**
 * Populates a freshly initialised workspace exactly the way the CLI would:
 * `log` -> appendSessionEvent, `decision add` -> appendDecisionEvent,
 * `handoff build` -> buildContextSnapshot + renderHandoffMarkdown + saveHandoff,
 * followed by the semantic index build that `search --mode hybrid` triggers lazily.
 */
export async function populateWorkspace(
  workspace: string,
  config: BridgeConfig,
  fixtures: BenchmarkFixtures
): Promise<void> {
  const sessions = [...fixtures.sessions].sort((a, b) => a.ts.localeCompare(b.ts));
  for (const session of sessions) {
    await appendSessionEvent(workspace, config, toSessionEvent(session, workspace));
  }

  const decisions = [...fixtures.decisions].sort((a, b) => a.ts.localeCompare(b.ts));
  for (const decision of decisions) {
    await appendDecisionEvent(workspace, config, decision);
  }

  const paths = resolveBridgePaths(workspace);
  await atomicWriteFile(paths.projectContextFile, PROJECT_CONTEXT, 0o600);

  const context = await buildContextSnapshot(workspace, config);
  const recentArtifacts = context.sessions
    .slice(-8)
    .flatMap((session) => session.artifacts)
    .slice(-12);
  const markdown = renderHandoffMarkdown({
    objective: context.snapshot.objective,
    recentDecisions: context.snapshot.recentDecisions,
    pending: context.snapshot.pending,
    nextSteps: context.snapshot.nextSteps,
    recentArtifacts
  });
  await saveHandoff(workspace, config, markdown);

  if (semanticEnabled(config)) {
    await indexSemanticFromState(workspace, config);
  }
}

// ---------------------------------------------------------------------------
// Ref resolution
// ---------------------------------------------------------------------------

type RefResolver = (alias: string) => string;

async function buildRefResolver(
  workspace: string,
  config: BridgeConfig,
  fixtures: BenchmarkFixtures | undefined
): Promise<RefResolver> {
  const map = new Map<string, string>();
  const decisions = await readDecisionEvents(workspace, config);
  for (const decision of decisions.events) {
    map.set(decision.id, `decision:${decision.id}`);
  }
  if (fixtures) {
    for (const session of fixtures.sessions) {
      map.set(session.id, `session:${session.ts}`);
    }
  }
  return (alias: string): string => map.get(alias) ?? alias;
}

// ---------------------------------------------------------------------------
// Evaluation
// ---------------------------------------------------------------------------

function evaluateHits(
  hits: SearchHit[],
  expected: Set<string>,
  supersededTraps: Set<string>,
  staleTraps: Set<string>
): Pick<
  QueryResult,
  "precisionAt3" | "recallAt5" | "reciprocalRank" | "noiseAt5" | "missing" | "supersededLeak" | "staleLeak" | "leakedRefs"
> {
  const refs = hits.map(refOf);
  const top3 = refs.slice(0, 3);
  const top5 = refs.slice(0, 5);

  const relevant3 = top3.filter((ref) => expected.has(ref)).length;
  const relevant5 = top5.filter((ref) => expected.has(ref)).length;
  const firstRelevant = refs.findIndex((ref) => expected.has(ref));

  const leakedRefs = top3.filter((ref) => supersededTraps.has(ref) || staleTraps.has(ref));

  return {
    precisionAt3: relevant3 / 3,
    recallAt5: expected.size === 0 ? 0 : relevant5 / expected.size,
    reciprocalRank: firstRelevant < 0 ? 0 : 1 / (firstRelevant + 1),
    noiseAt5: 1 - relevant5 / 5,
    missing: Array.from(expected).filter((ref) => !top5.includes(ref)),
    supersededLeak: top3.some((ref) => supersededTraps.has(ref)),
    staleLeak: top3.some((ref) => staleTraps.has(ref)),
    leakedRefs
  };
}

function detectLexicalBackend(mode: SearchMode, hits: SearchHit[]): QueryResult["lexicalBackend"] {
  if (mode !== "text") {
    return "n/a";
  }
  if (hits.length === 0) {
    return "none";
  }
  return hits.some((hit) => hit.text_score !== undefined) ? "fts5" : "bm25-memory";
}

async function evaluateVariant(args: {
  workspace: string;
  baseConfig: BridgeConfig;
  variant: BenchmarkVariant;
  queries: QueryFixture[];
  resolveRef: RefResolver;
  runs: number;
  limit: number;
}): Promise<VariantResult> {
  const { workspace, baseConfig, variant, queries, resolveRef, runs, limit } = args;
  const spec = VARIANT_SPECS[variant];

  const base: VariantResult = {
    variant,
    mode: spec.mode,
    label: spec.label,
    semanticEnabled: spec.semantic,
    precisionAt3: 0,
    recallAt5: 0,
    mrr: 0,
    noiseAt5: 1,
    maxPrecisionAt3: 0,
    minNoiseAt5: 1,
    supersededLeakRate: 0,
    supersededLeakQueries: 0,
    supersededTrapQueries: 0,
    staleLeakRate: 0,
    staleLeakQueries: 0,
    staleTrapQueries: 0,
    fullRecallQueries: 0,
    queriesWithWarnings: 0,
    unstableQueries: 0,
    latencyMs: latencyStats([]),
    queries: []
  };

  if (spec.semantic && !semanticEnabled(baseConfig)) {
    return {
      ...base,
      skipped: "workspace config has semanticSearch disabled; re-run `memory-bridge init --semantic` to enable FTS5/embeddings"
    };
  }

  const config = withSemantic(baseConfig, spec.semantic);
  const allSamples: number[] = [];
  const results: QueryResult[] = [];

  for (const query of queries) {
    const expected = new Set(query.expected.map(resolveRef));
    const supersededTraps = new Set((query.supersededTraps ?? []).map(resolveRef));
    const staleTraps = new Set((query.staleTraps ?? []).map(resolveRef));

    // Warm-up (untimed): first call may build indexes or warm the page cache.
    await searchMemory({ workspace, config, query: query.query, mode: spec.mode, limit });

    let first: { hits: SearchHit[]; warnings: string[] } | undefined;
    const orderings = new Set<string>();
    const samples: number[] = [];
    for (let i = 0; i < runs; i += 1) {
      const startedAt = performance.now();
      const result = await searchMemory({ workspace, config, query: query.query, mode: spec.mode, limit });
      const elapsed = performance.now() - startedAt;
      samples.push(elapsed);
      allSamples.push(elapsed);
      first ??= result;
      orderings.add(result.hits.map(refOf).join("|"));
    }

    const hits = first?.hits ?? [];
    const warnings = first?.warnings ?? [];
    const scored = evaluateHits(hits, expected, supersededTraps, staleTraps);

    results.push({
      id: query.id,
      query: query.query,
      category: query.category ?? "unlabeled",
      expected: Array.from(expected),
      supersededTraps: Array.from(supersededTraps),
      staleTraps: Array.from(staleTraps),
      hits: hits.slice(0, 5).map((hit) => ({
        ref: refOf(hit),
        source: hit.source,
        score: round(hit.score, 4),
        snippet: hit.snippet.replace(/\s+/g, " ").slice(0, 80)
      })),
      ...scored,
      lexicalBackend: detectLexicalBackend(spec.mode, hits),
      warnings,
      stableAcrossRuns: orderings.size <= 1,
      latencyP50Ms: latencyStats(samples).p50
    });
  }

  const count = results.length;
  const mean = (select: (result: QueryResult) => number): number =>
    count === 0 ? 0 : round(results.reduce((acc, result) => acc + select(result), 0) / count, 3);

  const supersededTrapQueries = results.filter((result) => result.supersededTraps.length > 0).length;
  const supersededLeakQueries = results.filter((result) => result.supersededLeak).length;
  const staleTrapQueries = results.filter((result) => result.staleTraps.length > 0).length;
  const staleLeakQueries = results.filter((result) => result.staleLeak).length;

  return {
    ...base,
    precisionAt3: mean((result) => result.precisionAt3),
    recallAt5: mean((result) => result.recallAt5),
    mrr: mean((result) => result.reciprocalRank),
    noiseAt5: mean((result) => result.noiseAt5),
    maxPrecisionAt3: mean((result) => Math.min(result.expected.length, 3) / 3),
    minNoiseAt5: mean((result) => 1 - Math.min(result.expected.length, 5) / 5),
    supersededLeakRate: supersededTrapQueries === 0 ? 0 : round(supersededLeakQueries / supersededTrapQueries, 3),
    supersededLeakQueries,
    supersededTrapQueries,
    staleLeakRate: staleTrapQueries === 0 ? 0 : round(staleLeakQueries / staleTrapQueries, 3),
    staleLeakQueries,
    staleTrapQueries,
    fullRecallQueries: results.filter((result) => result.recallAt5 >= 1).length,
    queriesWithWarnings: results.filter((result) => result.warnings.length > 0).length,
    unstableQueries: results.filter((result) => !result.stableAcrossRuns).length,
    latencyMs: latencyStats(allSamples),
    queries: results
  };
}

async function measureFootprint(workspace: string, config: BridgeConfig, tool: string): Promise<FootprintResult> {
  const startedAt = performance.now();
  const context = await buildContextSnapshot(workspace, config);
  const resumeLatencyMs = performance.now() - startedAt;

  const resumeText = renderResumeText(tool, context.snapshot);
  // Mirrors the `resume --json` payload printed by src/cli/bin.ts.
  const resumeJson = JSON.stringify(
    { ok: true, command: "resume", tool, workspace, snapshot: context.snapshot, resume: resumeText },
    null,
    2
  );
  const handoff = (await readHandoff(workspace, config)).text ?? "";

  return {
    targetTokens: { ...FOOTPRINT_TARGET_TOKENS },
    charsPerToken: CHARS_PER_TOKEN,
    resumeTool: tool,
    resumeLatencyMs: round(resumeLatencyMs, 2),
    resumeText: measureText(resumeText),
    resumeJson: measureText(resumeJson),
    handoff: measureText(handoff)
  };
}

async function describeCorpus(workspace: string, config: BridgeConfig): Promise<CorpusStats> {
  const [sessions, decisions] = await Promise.all([
    readSessionEvents(workspace, config),
    readDecisionEvents(workspace, config)
  ]);
  const { superseded } = filterActiveDecisions(decisions.events);
  return {
    sessions: sessions.events.length,
    decisions: decisions.events.length,
    activeDecisions: decisions.events.length - superseded.length,
    supersededDecisions: superseded.length,
    supersedesLinks: decisions.events.reduce((acc, decision) => acc + decision.supersedes.length, 0),
    tools: Array.from(new Set(sessions.events.map((event) => event.tool))).sort()
  };
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export async function runBenchmark(options: BenchmarkOptions = {}): Promise<BenchmarkReport> {
  const runs = Math.max(1, Math.floor(options.runs ?? 5));
  const limit = Math.max(5, Math.floor(options.limit ?? 5));
  const variants = options.variants && options.variants.length > 0 ? options.variants : ALL_VARIANTS;
  const resumeTool = options.resumeTool ?? "codex";

  let workspace: string;
  let config: BridgeConfig;
  let fixtures: BenchmarkFixtures | undefined;
  let queries: QueryFixture[];
  let source: BenchmarkReport["source"];

  if (options.workspace) {
    source = "workspace";
    workspace = path.resolve(options.workspace);
    if (!options.queriesFile) {
      throw new Error("A labeled queries file is required when benchmarking an existing workspace (--queries <file>).");
    }
    config = (await loadConfig(workspace)).config;
    queries = await readJson<QueryFixture[]>(path.resolve(options.queriesFile));
  } else {
    source = "fixtures";
    fixtures = await loadFixtures(options.fixturesDir);
    queries = options.queriesFile ? await readJson<QueryFixture[]>(path.resolve(options.queriesFile)) : fixtures.queries;
    workspace = await fs.mkdtemp(path.join(os.tmpdir(), "mb-bench-"));
    // Same code path as `memory-bridge init --semantic --project-name orbit-crm-benchmark`.
    config = (await initWorkspace({ workspace, enableSemanticSearch: true, projectName: "orbit-crm-benchmark" })).config;
    await populateWorkspace(workspace, config, fixtures);
  }

  const keepWorkspace = source === "workspace" || options.keepWorkspace === true;

  try {
    const resolveRef = await buildRefResolver(workspace, config, fixtures);
    const sqliteSupported = await isSqliteSupported();
    const corpus = await describeCorpus(workspace, config);

    const variantResults: VariantResult[] = [];
    for (const variant of variants) {
      variantResults.push(
        await evaluateVariant({ workspace, baseConfig: config, variant, queries, resolveRef, runs, limit })
      );
    }

    const footprint = await measureFootprint(workspace, config, resumeTool);

    return {
      schema: "memory-bridge-benchmark/1",
      generatedAt: new Date().toISOString(),
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      sqliteSupported,
      source,
      workspace,
      keptWorkspace: keepWorkspace,
      runs,
      limit,
      corpus,
      queryCount: queries.length,
      variants: variantResults,
      footprint
    };
  } finally {
    if (!keepWorkspace) {
      await fs.rm(workspace, { recursive: true, force: true });
    }
  }
}

// ---------------------------------------------------------------------------
// Text rendering
// ---------------------------------------------------------------------------

function pad(value: string, width: number, align: "left" | "right" = "left"): string {
  if (value.length >= width) {
    return value;
  }
  const fill = " ".repeat(width - value.length);
  return align === "left" ? `${value}${fill}` : `${fill}${value}`;
}

function fmt(value: number): string {
  return value.toFixed(3);
}

export function formatTable(report: BenchmarkReport): string {
  const columns: Array<{ title: string; width: number; align: "left" | "right"; cell: (v: VariantResult) => string }> = [
    { title: "variant", width: 10, align: "left", cell: (v) => v.variant },
    { title: "P@3", width: 6, align: "right", cell: (v) => fmt(v.precisionAt3) },
    { title: "maxP@3", width: 7, align: "right", cell: (v) => fmt(v.maxPrecisionAt3) },
    { title: "R@5", width: 6, align: "right", cell: (v) => fmt(v.recallAt5) },
    { title: "MRR", width: 6, align: "right", cell: (v) => fmt(v.mrr) },
    { title: "noise@5", width: 8, align: "right", cell: (v) => fmt(v.noiseAt5) },
    { title: "minNoise", width: 8, align: "right", cell: (v) => fmt(v.minNoiseAt5) },
    {
      title: "sup.leak@3",
      width: 11,
      align: "right",
      cell: (v) => `${v.supersededLeakQueries}/${v.supersededTrapQueries}`
    },
    { title: "stale@3", width: 8, align: "right", cell: (v) => `${v.staleLeakQueries}/${v.staleTrapQueries}` },
    { title: "p50 ms", width: 8, align: "right", cell: (v) => v.latencyMs.p50.toFixed(2) },
    { title: "p95 ms", width: 8, align: "right", cell: (v) => v.latencyMs.p95.toFixed(2) },
    { title: "warn", width: 5, align: "right", cell: (v) => String(v.queriesWithWarnings) },
    { title: "unstable", width: 8, align: "right", cell: (v) => String(v.unstableQueries) }
  ];

  const header = columns.map((column) => pad(column.title, column.width, column.align)).join(" | ");
  const separator = columns.map((column) => "-".repeat(column.width)).join("-+-");
  const rows = report.variants.map((variant) => {
    if (variant.skipped) {
      return `${pad(variant.variant, 10)} | skipped: ${variant.skipped}`;
    }
    return columns.map((column) => pad(column.cell(variant), column.width, column.align)).join(" | ");
  });

  return [header, separator, ...rows].join("\n");
}

function formatFootprintLine(label: string, measure: FootprintMeasure): string {
  return `${pad(label, 16)} ${String(measure.chars).padStart(6)} chars  ~${String(measure.estimatedTokens).padStart(5)} tokens  ${measure.lines} lines  (${measure.status})`;
}

export function formatFailures(report: BenchmarkReport): string {
  const lines: string[] = [];
  for (const variant of report.variants) {
    if (variant.skipped) {
      continue;
    }
    for (const query of variant.queries) {
      const failed = query.missing.length > 0 || query.supersededLeak || query.staleLeak;
      if (!failed) {
        continue;
      }
      const flags: string[] = [];
      if (query.supersededLeak) {
        flags.push("SUPERSEDED-LEAK");
      }
      if (query.staleLeak) {
        flags.push("stale-leak");
      }
      if (query.missing.length > 0) {
        flags.push(`missing ${query.missing.length}/${query.expected.length}`);
      }
      lines.push(`[${variant.variant}] ${query.id} "${query.query}" -> ${flags.join(", ")}`);
      lines.push(`    top5    : ${query.hits.map((hit) => hit.ref).join(", ") || "(no hits)"}`);
      lines.push(`    expected: ${query.expected.join(", ")}`);
      if (query.leakedRefs.length > 0) {
        lines.push(`    leaked  : ${query.leakedRefs.join(", ")}`);
      }
      if (query.warnings.length > 0) {
        lines.push(`    warnings: ${query.warnings.join(" | ")}`);
      }
    }
  }
  return lines.length === 0 ? "(none)" : lines.join("\n");
}

export function formatReport(report: BenchmarkReport): string {
  const header = [
    `memory-bridge retrieval benchmark  (${report.generatedAt})`,
    `node ${report.node} ${report.platform}/${report.arch}  node:sqlite=${report.sqliteSupported ? "yes" : "no"}  source=${report.source}`,
    `corpus: ${report.corpus.sessions} sessions (${report.corpus.tools.join(", ")}), ` +
      `${report.corpus.decisions} decisions (${report.corpus.supersedesLinks} supersedes links, ${report.corpus.supersededDecisions} superseded), ` +
      `${report.queryCount} queries, ${report.runs} timed run(s)/query, limit ${report.limit}`
  ];

  const footprint = [
    `Footprint of \`resume --for ${report.footprint.resumeTool}\` (target ${report.footprint.targetTokens.min}-${report.footprint.targetTokens.max} tokens, ${report.footprint.charsPerToken} chars/token, build ${report.footprint.resumeLatencyMs} ms):`,
    formatFootprintLine("resume (text)", report.footprint.resumeText),
    formatFootprintLine("resume --json", report.footprint.resumeJson),
    formatFootprintLine("handoff.md", report.footprint.handoff)
  ];

  return [
    ...header,
    "",
    formatTable(report),
    "",
    ...footprint,
    "",
    "Failure cases (missing expected hits in top-5, or a trap in top-3):",
    formatFailures(report),
    ""
  ].join("\n");
}
