import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  ALL_VARIANTS,
  CHARS_PER_TOKEN,
  formatReport,
  loadFixtures,
  runBenchmark,
  type BenchmarkReport
} from "../benchmark/harness.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const runScript = path.resolve(here, "../benchmark/run.js");

const REQUIRED_TOOLS = ["claude", "codex", "qwen", "hermes", "antigravity", "gemini"];

function assertUnitInterval(value: number, label: string): void {
  assert.equal(typeof value, "number", `${label} must be a number`);
  assert.ok(value >= 0 && value <= 1, `${label} must be within [0, 1], got ${value}`);
}

test("benchmark fixtures describe multi-tool handoffs with supersedes pairs and labeled queries", async () => {
  const fixtures = await loadFixtures();

  assert.ok(fixtures.sessions.length >= 30, `expected ~30 sessions, got ${fixtures.sessions.length}`);
  assert.ok(fixtures.decisions.length >= 10, `expected ~10 decisions, got ${fixtures.decisions.length}`);
  assert.ok(fixtures.queries.length >= 15, `expected ~15 queries, got ${fixtures.queries.length}`);

  const tools = new Set(fixtures.sessions.map((session) => session.tool));
  for (const tool of REQUIRED_TOOLS) {
    assert.ok(tools.has(tool), `fixtures must contain sessions from ${tool}`);
  }

  const sessionIds = new Set(fixtures.sessions.map((session) => session.id));
  const decisionIds = new Set(fixtures.decisions.map((decision) => decision.id));
  assert.equal(sessionIds.size, fixtures.sessions.length, "session fixture ids must be unique");
  assert.equal(decisionIds.size, fixtures.decisions.length, "decision ids must be unique");

  const supersedesLinks = fixtures.decisions.flatMap((decision) => decision.supersedes);
  assert.ok(supersedesLinks.length >= 3, "at least 3 old -> new decision pairs are required");
  for (const target of supersedesLinks) {
    assert.ok(decisionIds.has(target), `supersedes target ${target} must exist`);
  }

  const knownAliases = new Set([...sessionIds, ...decisionIds]);
  let queriesWithTraps = 0;
  for (const query of fixtures.queries) {
    assert.ok(query.expected.length > 0, `${query.id} needs at least one expected ref`);
    for (const alias of [...query.expected, ...(query.supersededTraps ?? []), ...(query.staleTraps ?? [])]) {
      assert.ok(knownAliases.has(alias), `${query.id} references unknown fixture alias ${alias}`);
    }
    if ((query.supersededTraps ?? []).length > 0) {
      queriesWithTraps += 1;
      for (const trap of query.supersededTraps ?? []) {
        assert.ok(supersedesLinks.includes(trap), `${query.id} trap ${trap} must be a superseded decision`);
      }
    }
  }
  assert.ok(queriesWithTraps >= 3, "at least 3 queries must target a superseding decision");
});

test("benchmark harness runs over the fixtures and produces metrics for every search mode", async () => {
  const report: BenchmarkReport = await runBenchmark({ runs: 1 });

  assert.equal(report.schema, "memory-bridge-benchmark/1");
  assert.equal(report.source, "fixtures");
  assert.equal(report.runs, 1);
  assert.equal(typeof report.sqliteSupported, "boolean");

  assert.ok(report.corpus.sessions >= 30);
  assert.ok(report.corpus.decisions >= 10);
  assert.ok(report.corpus.supersedesLinks >= 3);
  assert.equal(report.corpus.supersededDecisions, report.corpus.supersedesLinks);
  for (const tool of REQUIRED_TOOLS) {
    assert.ok(report.corpus.tools.includes(tool));
  }

  assert.deepEqual(
    report.variants.map((variant) => variant.variant),
    ALL_VARIANTS,
    "every search mode must be measured"
  );

  for (const variant of report.variants) {
    assert.equal(variant.skipped, undefined, `${variant.variant} must not be skipped on a --semantic workspace`);
    assert.equal(variant.queries.length, report.queryCount);

    assertUnitInterval(variant.precisionAt3, `${variant.variant}.precisionAt3`);
    assertUnitInterval(variant.maxPrecisionAt3, `${variant.variant}.maxPrecisionAt3`);
    assertUnitInterval(variant.recallAt5, `${variant.variant}.recallAt5`);
    assertUnitInterval(variant.mrr, `${variant.variant}.mrr`);
    assertUnitInterval(variant.noiseAt5, `${variant.variant}.noiseAt5`);
    assertUnitInterval(variant.minNoiseAt5, `${variant.variant}.minNoiseAt5`);
    assert.ok(variant.precisionAt3 <= variant.maxPrecisionAt3 + 1e-9);
    assert.ok(variant.noiseAt5 >= variant.minNoiseAt5 - 1e-9);

    // Superseded leakage must be computed, not merely defaulted.
    assert.ok(variant.supersededTrapQueries >= 3, `${variant.variant} must evaluate the supersedes traps`);
    assertUnitInterval(variant.supersededLeakRate, `${variant.variant}.supersededLeakRate`);
    assert.equal(
      variant.supersededLeakRate,
      Math.round((variant.supersededLeakQueries / variant.supersededTrapQueries) * 1000) / 1000
    );
    assert.ok(variant.staleTrapQueries >= 3);
    assertUnitInterval(variant.staleLeakRate, `${variant.variant}.staleLeakRate`);

    assert.equal(variant.latencyMs.samples, report.queryCount * report.runs);
    assert.ok(variant.latencyMs.p50 >= 0);
    assert.ok(variant.latencyMs.p95 >= variant.latencyMs.p50);
    assert.ok(variant.latencyMs.max >= variant.latencyMs.min);

    for (const query of variant.queries) {
      assert.equal(typeof query.supersededLeak, "boolean");
      assert.equal(typeof query.staleLeak, "boolean");
      assert.ok(query.hits.length <= 5);
      if (variant.mode === "text") {
        assert.ok(["fts5", "bm25-memory", "none"].includes(query.lexicalBackend));
      } else {
        assert.equal(query.lexicalBackend, "n/a");
      }
    }
  }

  const { footprint } = report;
  assert.deepEqual(footprint.targetTokens, { min: 300, max: 500 });
  for (const measure of [footprint.resumeText, footprint.resumeJson, footprint.handoff]) {
    assert.ok(measure.chars > 0);
    assert.equal(measure.estimatedTokens, Math.ceil(measure.chars / CHARS_PER_TOKEN));
    assert.ok(["below-target", "within-target", "above-target"].includes(measure.status));
  }
  assert.match(footprint.resumeText.status, /target$/);

  const rendered = formatReport(report);
  assert.match(rendered, /sup\.leak@3/);
  assert.match(rendered, /hybrid/);
  assert.match(rendered, /resume \(text\)/);

  // Temporary fixture workspace must be removed when not kept.
  assert.equal(report.keptWorkspace, false);
  await assert.rejects(fs.access(report.workspace));
});

test("bench entry point prints a JSON report with --json", () => {
  const result = spawnSync(process.execPath, [runScript, "--json", "--runs", "1", "--modes", "text,hybrid"], {
    encoding: "utf8"
  });
  assert.equal(result.status, 0, result.stderr);

  const parsed = JSON.parse(result.stdout) as BenchmarkReport;
  assert.equal(parsed.schema, "memory-bridge-benchmark/1");
  assert.deepEqual(
    parsed.variants.map((variant) => variant.variant),
    ["text", "hybrid"]
  );
  assert.equal(typeof parsed.variants[0]?.supersededLeakRate, "number");
  assert.ok(parsed.footprint.resumeText.estimatedTokens > 0);
});
