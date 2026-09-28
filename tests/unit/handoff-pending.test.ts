import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { initWorkspace } from "../../src/core/config.js";
import { buildContextSnapshot, HANDOFF_LIST_LIMIT, renderHandoffMarkdown } from "../../src/core/context.js";
import { appendSessionEvent, saveHandoff } from "../../src/core/store.js";
import { makeTempWorkspace } from "../helpers.js";
import type { SessionEvent } from "../../src/types/events.js";

type Config = Awaited<ReturnType<typeof initWorkspace>>["config"];

const DAY = 86_400_000;
const T0 = Date.parse("2026-09-20T10:00:00.000Z");

function session(workspace: string, daysAfterT0: number, actions: string[], intent = "work"): SessionEvent {
  return {
    ts: new Date(T0 + daysAfterT0 * DAY).toISOString(),
    tool: "claude",
    workspace,
    branch: "main",
    intent,
    summary: `summary ${daysAfterT0}`,
    actions,
    artifacts: [],
    tags: []
  };
}

async function fresh(): Promise<{ workspace: string; config: Config }> {
  const workspace = await makeTempWorkspace("mb-handoff-pending-");
  const { config } = await initWorkspace({ workspace });
  return { workspace, config };
}

test("issue #15 repro: a pending item logged once does not survive forever", async () => {
  const { workspace, config } = await fresh();
  await appendSessionEvent(workspace, config, session(workspace, 0, ["next: mergear o 1241 quando os checks fecharem"]));

  const first = await buildContextSnapshot(workspace, config);
  assert.deepEqual(first.snapshot.pending, ["next: mergear o 1241 quando os checks fecharem"]);
  await saveHandoff(workspace, config, renderHandoffMarkdown({ ...first.snapshot, recentArtifacts: [] }));

  // a week of unrelated work, then more than 14 days after the zombie
  await appendSessionEvent(workspace, config, session(workspace, 7, ["refactor parser"]));
  await appendSessionEvent(workspace, config, session(workspace, 15, ["next: revisar PR 1300"]));

  const later = await buildContextSnapshot(workspace, config);
  assert.deepEqual(later.snapshot.pending, ["next: revisar PR 1300"], "expired item must not be re-read from the old handoff");
});

test("the previous handoff's Pending and Next Steps are never read back", async () => {
  const { workspace, config } = await fresh();
  await saveHandoff(
    workspace,
    config,
    "# Handoff\n\n## Objective\nx\n\n## Pending\n- fantasma de outro dia\n\n## Next Steps\n- passo velho\n"
  );
  await appendSessionEvent(workspace, config, session(workspace, 0, ["todo: item real", "escrever teste"]));

  const { snapshot } = await buildContextSnapshot(workspace, config);
  assert.deepEqual(snapshot.pending, ["todo: item real"]);
  assert.deepEqual(snapshot.nextSteps, ["todo: item real", "escrever teste"]);
});

test("newest items win the cut: the list keeps the 8 most recent, not the 8 oldest", async () => {
  const { workspace, config } = await fresh();
  for (let i = 1; i <= 10; i += 1) {
    await appendSessionEvent(workspace, config, session(workspace, i / 10, [`next: item ${i}`]));
  }
  const { snapshot } = await buildContextSnapshot(workspace, config);
  assert.equal(snapshot.pending.length, HANDOFF_LIST_LIMIT);
  assert.equal(snapshot.pending[0], "next: item 10");
  assert.ok(!snapshot.pending.includes("next: item 1"));
  assert.ok(!snapshot.pending.includes("next: item 2"));
});

test("done: markers retire matching pending items, and a re-opened item comes back", async () => {
  const { workspace, config } = await fresh();
  await appendSessionEvent(workspace, config, session(workspace, 0, ["next: mergear PR 1241", "next: rebase 1237"]));
  await appendSessionEvent(workspace, config, session(workspace, 1, ["done: mergear PR 1241"]));

  const { snapshot } = await buildContextSnapshot(workspace, config);
  assert.deepEqual(snapshot.pending, ["next: rebase 1237"]);
  assert.ok(!snapshot.nextSteps.some((step) => /^done:/i.test(step)), "done markers are not next steps");

  await appendSessionEvent(workspace, config, session(workspace, 2, ["next: mergear PR 1241 (reaberto)"]));
  const reopened = await buildContextSnapshot(workspace, config);
  assert.ok(reopened.snapshot.pending.includes("next: mergear PR 1241 (reaberto)"), "an older done must not retire a newer item");
});

test("items pinned in project-context.md stay first", async () => {
  const { workspace, config } = await fresh();
  await fs.writeFile(
    path.join(workspace, ".memory-bridge", "project-context.md"),
    "# Project Context\n\n## Current Objective\nShip 0.3.1\n\n## Pending\n- item fixo à mão\n\n## Next Steps\n- publicar\n",
    "utf8"
  );
  await appendSessionEvent(workspace, config, session(workspace, 0, ["next: da sessão", "rodar suíte"]));
  const { snapshot } = await buildContextSnapshot(workspace, config);
  assert.deepEqual(snapshot.pending, ["item fixo à mão", "next: da sessão"]);
  assert.deepEqual(snapshot.nextSteps, ["publicar", "next: da sessão", "rodar suíte"]);
});

test("CLI: handoff build and consolidate drop the zombie on the next run", async () => {
  const { workspace, config } = await fresh();
  const bin = path.resolve(process.cwd(), "dist/src/cli/bin.js");
  const run = (...args: string[]) => spawnSync(process.execPath, [bin, ...args, "--workspace", workspace, "--json"], { encoding: "utf-8" });
  const handoffPath = path.join(workspace, ".memory-bridge", "handoff.md");

  await appendSessionEvent(workspace, config, session(workspace, 0, ["next: tarefa que vai virar zumbi"]));
  assert.equal(run("handoff", "build").status, 0);
  assert.ok((await fs.readFile(handoffPath, "utf8")).includes("tarefa que vai virar zumbi"));

  await appendSessionEvent(workspace, config, session(workspace, 3, ["done: tarefa que vai virar zumbi", "next: coisa nova"]));
  assert.equal(run("handoff", "build").status, 0);
  const afterBuild = await fs.readFile(handoffPath, "utf8");
  assert.ok(!afterBuild.includes("tarefa que vai virar zumbi"), afterBuild);
  assert.ok(afterBuild.includes("next: coisa nova"));

  assert.equal(run("consolidate").status, 0);
  const afterConsolidate = await fs.readFile(handoffPath, "utf8");
  assert.ok(!afterConsolidate.includes("tarefa que vai virar zumbi"), afterConsolidate);
});
