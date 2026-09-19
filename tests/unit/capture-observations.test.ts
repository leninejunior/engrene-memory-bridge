import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  appendObservation,
  cleanStaleObservations,
  DEFAULT_CAPTURE_CONFIG,
  isPathExcluded,
  listObservationFiles,
  readObservations,
  sanitizeObservationPayload
} from "../../src/core/capture.js";
import { initWorkspace } from "../../src/core/config.js";
import type { ObservationEvent } from "../../src/types/events.js";

test("isPathExcluded recognizes sensitive files and wildcards", () => {
  const exclude = DEFAULT_CAPTURE_CONFIG.exclude;

  assert.equal(isPathExcluded(".env", exclude), true);
  assert.equal(isPathExcluded(".env.local", exclude), true);
  assert.equal(isPathExcluded("/app/.env.production", exclude), true);
  assert.equal(isPathExcluded("secrets/api_keys.json", exclude), true);
  assert.equal(isPathExcluded("certs/server.pem", exclude), true);
  assert.equal(isPathExcluded("id_rsa", exclude), true);

  assert.equal(isPathExcluded("src/core/capture.ts", exclude), false);
  assert.equal(isPathExcluded("README.md", exclude), false);
});

test("sanitizeObservationPayload scrubs excluded paths and redacts tokens", () => {
  const dummyGithubToken = ["ghp", "123456789012345678901234567890123456"].join("_");
  const payload = {
    file: ".env.production",
    token: `api_key: ${dummyGithubToken}`,
    message: "Read file .env successfully"
  };

  const config = {
    schemaVersion: "1.0.0",
    projectName: "test",
    createdAt: new Date().toISOString(),
    redaction: { enabled: true },
    encryption: { enabled: false, kdf: "scrypt" as const, saltBase64: "", keyEnvVar: "" },
    semanticSearch: { enabled: false, dimensions: 256 },
    capture: DEFAULT_CAPTURE_CONFIG
  };

  const sanitized = sanitizeObservationPayload(payload, config);

  assert.equal(sanitized.file, "[EXCLUDED_PATH]");
  assert.match(String(sanitized.token), /\[REDACTED/);
});

test("appendObservation and cleanStaleObservations manage observations folder", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "mb-obs-test-"));

  try {
    const { config } = await initWorkspace({ workspace: tmpDir });
    config.capture = {
      enabled: true,
      retentionDays: 1,
      maxSessions: 2,
      exclude: DEFAULT_CAPTURE_CONFIG.exclude
    };

    const event1: ObservationEvent = {
      id: "obs-1",
      ts: new Date().toISOString(),
      sessionId: "session-alpha",
      tool: "claude",
      type: "user_prompt",
      payload: { prompt: "Refatorar módulo de busca" }
    };

    const event2: ObservationEvent = {
      id: "obs-2",
      ts: new Date().toISOString(),
      sessionId: "session-alpha",
      tool: "claude",
      type: "tool_call",
      payload: { tool: "edit_file", path: "src/core/search.ts" }
    };

    await appendObservation(tmpDir, config, event1);
    await appendObservation(tmpDir, config, event2);

    const files = await listObservationFiles(tmpDir);
    assert.equal(files.length, 1);

    const observations = await readObservations(tmpDir);
    assert.equal(observations.length, 2);
    assert.equal(observations[0]?.type, "user_prompt");
    assert.equal(observations[1]?.type, "tool_call");

    // Clean stale observations with maxSessions enforcement
    const event3: ObservationEvent = {
      id: "obs-3",
      ts: new Date().toISOString(),
      sessionId: "session-beta",
      tool: "codex",
      type: "session_start",
      payload: {}
    };
    const event4: ObservationEvent = {
      id: "obs-4",
      ts: new Date().toISOString(),
      sessionId: "session-gamma",
      tool: "gemini",
      type: "session_start",
      payload: {}
    };

    await appendObservation(tmpDir, config, event3);
    await appendObservation(tmpDir, config, event4);

    const filesBeforeClean = await listObservationFiles(tmpDir);
    assert.equal(filesBeforeClean.length, 3);

    // With maxSessions: 2, oldest should be rotated out
    const { removedFiles } = await cleanStaleObservations(tmpDir, config);
    assert.equal(removedFiles.length, 1);

    const filesAfterClean = await listObservationFiles(tmpDir);
    assert.equal(filesAfterClean.length, 2);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});
