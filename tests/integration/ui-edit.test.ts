import assert from "node:assert/strict";
import test from "node:test";

import { startUiServer } from "../../src/ui/server.js";
import { makeTempWorkspace, readFileSafe } from "../helpers.js";

async function requestJson(url: string, init?: RequestInit): Promise<any> {
  const response = await fetch(url, init);
  const json = (await response.json()) as any;
  if (!response.ok) {
    throw new Error(json?.error || `HTTP ${response.status}`);
  }
  return json;
}

test("ui supports editing project context and writing events", async (t) => {
  const workspace = await makeTempWorkspace("mb-ui-");
  let server;
  try {
    server = await startUiServer({
      workspace,
      host: "127.0.0.1",
      port: 0,
      readonly: false
    });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EPERM") {
      t.skip("Socket bind not allowed in this sandbox environment");
      return;
    }
    throw error;
  }

  try {
    await requestJson(`${server.url}/api/project-context`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ markdown: "# Project Context\n\n## Current Objective\nShip UI editing\n" })
    });

    await requestJson(`${server.url}/api/log`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        tool: "ui",
        intent: "Implement UI editing",
        summary: "Created editable dashboard",
        actions: ["TODO: improve filters"],
        artifacts: ["src/ui/server.ts"],
        tags: ["ui"]
      })
    });

    await requestJson(`${server.url}/api/decision`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: "Ship local web panel",
        decision: "Use built-in Node HTTP server",
        context: "No framework dependencies",
        impact: "Lightweight UI"
      })
    });

    const handoffOut = await requestJson(`${server.url}/api/handoff/build`, {
      method: "POST"
    });

    assert.equal(typeof handoffOut.markdown, "string");
    assert.match(handoffOut.markdown, /Objective/);

    const state = await requestJson(`${server.url}/api/state`);
    assert.equal(state.snapshot.objective, "Ship UI editing");
    assert.equal(state.snapshot.currentTask, "Implement UI editing");
    assert.equal(state.decisions.length >= 1, true);
    assert.equal(state.sessions.length >= 1, true);

    const projectContextRaw = await readFileSafe(`${workspace}/.memory-bridge/project-context.md`);
    assert.match(projectContextRaw, /Ship UI editing/);
  } finally {
    await server.close();
  }
});
