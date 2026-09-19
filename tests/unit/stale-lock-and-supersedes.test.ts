import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { filterActiveDecisions } from "../../src/core/context.js";
import { initWorkspace, loadConfig } from "../../src/core/config.js";
import { withLock, appendJsonlAtomic, writeJsonFile } from "../../src/core/fs-utils.js";
import { resolveBridgePaths } from "../../src/core/paths.js";
import { semanticEnabled } from "../../src/core/vector.js";
import { makeTempWorkspace } from "../helpers.js";
import type { DecisionEvent } from "../../src/types/events.js";

test("stale lock recovery breaks lock from dead process or elapsed timeout", async () => {
  const dir = await makeTempWorkspace("mb-stale-lock-");
  const lockFile = path.join(dir, ".lock");

  // Create an artificial dead/stale lock with PID 99999999 (guaranteed dead) and ancient timestamp
  await fs.writeFile(lockFile, "99999999:1000\n", "utf8");

  let acquired = false;
  await withLock(lockFile, async () => {
    acquired = true;
  }, 1000);

  assert.equal(acquired, true);
});

test("filterActiveDecisions excludes superseded decisions and keeps active ones", () => {
  const decisions: DecisionEvent[] = [
    {
      id: "dec-1",
      ts: "2026-09-19T10:00:00.000Z",
      title: "Use Redis",
      context: "Initial cache idea",
      decision: "Adopt Redis",
      impact: "Added redis dep",
      supersedes: []
    },
    {
      id: "dec-2",
      ts: "2026-09-19T11:00:00.000Z",
      title: "Use Local SQLite",
      context: "Redis is too heavy",
      decision: "Switch to SQLite and deprecate Redis",
      impact: "Zero daemons",
      supersedes: ["dec-1"]
    },
    {
      id: "dec-3",
      ts: "2026-09-19T12:00:00.000Z",
      title: "Add FTS5",
      context: "Search needs speed",
      decision: "Index documents with FTS5",
      impact: "Fast search",
      supersedes: []
    }
  ];

  const { active, superseded } = filterActiveDecisions(decisions);
  assert.equal(superseded.length, 1);
  assert.equal(superseded[0]?.id, "dec-1");
  assert.equal(active.length, 2);
  assert.equal(active[0]?.id, "dec-2");
  assert.equal(active[1]?.id, "dec-3");
});

test("appendJsonlAtomic appends without overwriting existing content", async () => {
  const dir = await makeTempWorkspace("mb-append-");
  const target = path.join(dir, "events.jsonl");
  const lock = path.join(dir, ".lock");

  await appendJsonlAtomic(target, JSON.stringify({ item: 1 }), lock);
  await appendJsonlAtomic(target, JSON.stringify({ item: 2 }), lock);

  const content = await fs.readFile(target, "utf8");
  const lines = content.trim().split("\n");
  assert.equal(lines.length, 2);
  assert.deepEqual(JSON.parse(lines[0]!), { item: 1 });
  assert.deepEqual(JSON.parse(lines[1]!), { item: 2 });
});

test("initWorkspace with enableSemanticSearch sets provider to local", async () => {
  const workspace = await makeTempWorkspace("mb-init-sem-");
  const { config } = await initWorkspace({
    workspace,
    enableSemanticSearch: true
  });

  assert.equal(config.semanticSearch.enabled, true);
  assert.equal(config.semanticSearch.provider, "local");
  assert.equal(semanticEnabled(config), true);
});

test("loadConfig preserves capture settings from config.json", async () => {
  const workspace = await makeTempWorkspace("mb-load-cap-");
  const { config: initialConfig } = await initWorkspace({ workspace });
  const paths = resolveBridgePaths(workspace);

  const customConfig = {
    ...initialConfig,
    capture: {
      enabled: true,
      retentionDays: 14,
      maxSessions: 100,
      exclude: ["*.secret", ".env.local"]
    }
  };

  await writeJsonFile(paths.configFile, customConfig);

  const { config: reloaded } = await loadConfig(workspace);
  assert.ok(reloaded.capture);
  assert.equal(reloaded.capture?.enabled, true);
  assert.equal(reloaded.capture?.retentionDays, 14);
  assert.equal(reloaded.capture?.maxSessions, 100);
  assert.deepEqual(reloaded.capture?.exclude, ["*.secret", ".env.local"]);
});
