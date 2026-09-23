#!/usr/bin/env node
/**
 * CLI entry point for the retrieval benchmark (`npm run bench`).
 *
 *   npm run bench                       text table over the synthetic fixtures
 *   npm run bench -- --json             machine readable report
 *   npm run bench -- --runs 10          more timing samples per query
 *   npm run bench -- --modes text,hybrid
 *   npm run bench -- --workspace <dir> --queries <file.json>
 *                                       benchmark a real `.memory-bridge/` with your own labeled queries
 */

import { getBoolFlag, getListFlag, getStringFlag, parseArgs } from "../../src/cli/args.js";
import {
  ALL_VARIANTS,
  formatReport,
  isBenchmarkVariant,
  runBenchmark,
  type BenchmarkOptions,
  type BenchmarkVariant
} from "./harness.js";

const USAGE = `memory-bridge retrieval benchmark

Usage:
  node dist/tests/benchmark/run.js [options]

Options:
  --json                 print the full report as JSON instead of a text table
  --runs <n>             timed executions per query after one warm-up (default 5)
  --limit <n>            hits requested per query (default 5, minimum 5)
  --modes <a,b,...>      subset of: ${ALL_VARIANTS.join(", ")}
  --fixtures <dir>       directory with sessions.json, decisions.json, queries.json
  --queries <file>       labeled queries file (overrides the fixtures' queries.json)
  --workspace <dir>      benchmark an existing workspace (.memory-bridge/) instead of fixtures;
                         requires --queries with refs like "decision:<id>" or "session:<ts>"
  --resume-tool <name>   tool name used for the resume footprint (default codex)
  --keep                 keep the temporary fixture workspace on disk
  --help                 show this help
`;

function parsePositiveInt(raw: string | undefined, fallback: number): number {
  if (raw === undefined) {
    return fallback;
  }
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`Expected a positive integer, got: ${raw}`);
  }
  return value;
}

async function main(): Promise<void> {
  const parsed = parseArgs(process.argv.slice(2));

  if (getBoolFlag(parsed, "help")) {
    process.stdout.write(USAGE);
    return;
  }

  const requestedModes = getListFlag(parsed, "modes");
  const unknownModes = requestedModes.filter((mode) => !isBenchmarkVariant(mode));
  if (unknownModes.length > 0) {
    throw new Error(`Unknown mode(s): ${unknownModes.join(", ")}. Valid modes: ${ALL_VARIANTS.join(", ")}`);
  }
  const variants = requestedModes.filter(isBenchmarkVariant) as BenchmarkVariant[];

  const workspace = getStringFlag(parsed, "workspace");
  const fixturesDir = getStringFlag(parsed, "fixtures");
  const queriesFile = getStringFlag(parsed, "queries");
  const resumeTool = getStringFlag(parsed, "resume-tool");

  const options: BenchmarkOptions = {
    runs: parsePositiveInt(getStringFlag(parsed, "runs"), 5),
    limit: parsePositiveInt(getStringFlag(parsed, "limit"), 5),
    keepWorkspace: getBoolFlag(parsed, "keep"),
    ...(variants.length > 0 ? { variants } : {}),
    ...(workspace ? { workspace } : {}),
    ...(fixturesDir ? { fixturesDir } : {}),
    ...(queriesFile ? { queriesFile } : {}),
    ...(resumeTool ? { resumeTool } : {})
  };

  const report = await runBenchmark(options);

  if (getBoolFlag(parsed, "json")) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    process.stdout.write(formatReport(report));
    if (report.keptWorkspace && report.source === "fixtures") {
      process.stdout.write(`Workspace kept at: ${report.workspace}\n`);
    }
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`benchmark failed: ${message}\n`);
  process.exit(1);
});
