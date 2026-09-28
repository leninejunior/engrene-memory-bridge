import assert from "node:assert/strict";
import test from "node:test";

import { initWorkspace } from "../../src/core/config.js";
import { searchMemory } from "../../src/core/search.js";
import { appendDecisionEvent, appendSessionEvent } from "../../src/core/store.js";
import { getSemanticDocCount, isSqliteSupported } from "../../src/core/vector.js";
import { makeTempWorkspace } from "../helpers.js";
import type { DecisionEvent, SessionEvent } from "../../src/types/events.js";

async function seeded(): Promise<{ workspace: string; config: Awaited<ReturnType<typeof initWorkspace>>["config"] }> {
  const workspace = await makeTempWorkspace("mb-text-fts5-");
  const { config } = await initWorkspace({ workspace, enableSemanticSearch: true });
  const base: Omit<SessionEvent, "ts" | "intent" | "summary"> = {
    tool: "codex",
    workspace,
    branch: "main",
    actions: [],
    artifacts: [],
    tags: []
  };
  // appendSessionEvent/appendDecisionEvent write JSONL only; nothing touches the SQLite index,
  // which is exactly the state of a workspace that has only ever been written to.
  await appendSessionEvent(workspace, config, {
    ...base,
    ts: "2026-09-20T10:00:00.000Z",
    intent: "Migrate cache from Redis to SQLite",
    summary: "Replaced the Redis client with node:sqlite and removed the daemon."
  });
  await appendSessionEvent(workspace, config, {
    ...base,
    ts: "2026-09-21T10:00:00.000Z",
    intent: "Harden JWT refresh",
    summary: "Rotated refresh tokens and shortened access token lifetime."
  });
  const decision: DecisionEvent = {
    id: "dec-cache-sqlite",
    ts: "2026-09-20T11:00:00.000Z",
    title: "Use SQLite for the cache",
    context: "Redis needed a separate daemon.",
    decision: "Cache lives in SQLite.",
    impact: "One less process.",
    supersedes: []
  };
  await appendDecisionEvent(workspace, config, decision);
  return { workspace, config };
}

test("text mode builds the FTS5 index on first use and returns the same hits as after a hybrid search", async (t) => {
  if (!(await isSqliteSupported())) {
    t.skip("node:sqlite unavailable on this Node version");
    return;
  }
  const { workspace, config } = await seeded();
  assert.equal(await getSemanticDocCount(workspace, config), 0, "fresh workspace: nothing indexed yet");

  const first = await searchMemory({ workspace, config, query: "sqlite cache", mode: "text", limit: 5 });
  assert.ok(await getSemanticDocCount(workspace, config) > 0, "a text search must populate the index (issue #11)");
  assert.ok(first.hits.length > 0);
  assert.ok(first.hits.every((hit) => typeof hit.text_score === "number"), "hits must come from FTS5, not the in-memory fallback");
  assert.deepEqual(first.warnings, []);

  await searchMemory({ workspace, config, query: "sqlite cache", mode: "hybrid", limit: 5 });
  const again = await searchMemory({ workspace, config, query: "sqlite cache", mode: "text", limit: 5 });
  assert.deepEqual(
    again.hits.map((hit) => hit.ref),
    first.hits.map((hit) => hit.ref),
    "text results must not change once a hybrid search has run"
  );
});

test("text mode: a query with no FTS5 match falls through to the in-memory hits, silently", async (t) => {
  if (!(await isSqliteSupported())) {
    t.skip("node:sqlite unavailable on this Node version");
    return;
  }
  const { workspace, config } = await seeded();
  const miss = await searchMemory({ workspace, config, query: "kubernetes ingress mesh", mode: "text", limit: 5 });
  assert.equal(miss.warnings.length, 0, "a query that matches nothing is an ordinary miss, not a warning");
  assert.ok(await getSemanticDocCount(workspace, config) > 0, "the index is still built even when the query misses");
});
