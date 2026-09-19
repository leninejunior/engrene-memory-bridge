import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { appendObservation, listObservationFiles } from "../../src/core/capture.js";
import { initWorkspace } from "../../src/core/config.js";
import { runConsolidation } from "../../src/core/consolidate.js";
import { readHandoff, readSessionEvents } from "../../src/core/store.js";
import type { ObservationEvent } from "../../src/types/events.js";

test("runConsolidation synthesizes pending observations into durable sessions and refreshes handoff", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "mb-consolidate-smart-"));

  try {
    const { config } = await initWorkspace({ workspace: tmpDir });
    config.capture = {
      enabled: true,
      retentionDays: 7,
      maxSessions: 20,
      exclude: []
    };

    // Ingest 3 observations for session-xyz
    const obs1: ObservationEvent = {
      id: "obs-1",
      ts: new Date().toISOString(),
      sessionId: "session-xyz",
      tool: "hermes",
      type: "user_prompt",
      payload: { prompt: "Corrigir vazamento de conexões no pool do banco" }
    };

    const obs2: ObservationEvent = {
      id: "obs-2",
      ts: new Date().toISOString(),
      sessionId: "session-xyz",
      tool: "hermes",
      type: "tool_call",
      payload: { tool: "edit_file", path: "src/db/pool.ts" }
    };

    const obs3: ObservationEvent = {
      id: "obs-3",
      ts: new Date().toISOString(),
      sessionId: "session-xyz",
      tool: "hermes",
      type: "tool_result",
      payload: { success: true }
    };

    await appendObservation(tmpDir, config, obs1);
    await appendObservation(tmpDir, config, obs2);
    await appendObservation(tmpDir, config, obs3);

    const obsFilesBefore = await listObservationFiles(tmpDir);
    assert.equal(obsFilesBefore.length, 1);

    // Run consolidation
    const result = await runConsolidation(tmpDir, config);
    assert.equal(result.ok, true);
    assert.equal(result.consolidatedSessions, 1);
    assert.equal(result.observationsProcessed, 3);
    assert.equal(result.handoffRefreshed, true);

    // Verify observation files were purged post-consolidation
    const obsFilesAfter = await listObservationFiles(tmpDir);
    assert.equal(obsFilesAfter.length, 0);

    // Verify durable session was appended
    const { events: sessions } = await readSessionEvents(tmpDir, config);
    assert.equal(sessions.length, 1);
    assert.equal(sessions[0]?.intent, "Corrigir vazamento de conexões no pool do banco");
    assert.ok(sessions[0]?.artifacts.includes("src/db/pool.ts"));
    assert.equal(sessions[0]?.tool, "hermes");

    // Verify handoff was refreshed
    const handoff = await readHandoff(tmpDir, config);
    assert.ok(handoff.text?.includes("Corrigir vazamento de conexões no pool do banco"));
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});
