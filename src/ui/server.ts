import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import fs from "node:fs/promises";

import { loadConfig, initWorkspace } from "../core/config.js";
import { buildContextSnapshot, renderHandoffMarkdown } from "../core/context.js";
import { runDoctor } from "../core/doctor.js";
import { currentGitBranch } from "../core/git.js";
import { searchMemory, type SearchMode } from "../core/search.js";
import {
  appendDecisionEvent,
  appendSessionEvent,
  readDecisionEvents,
  readHandoff,
  readProjectContext,
  readSessionEvents,
  saveHandoff
} from "../core/store.js";
import { semanticEnabled, upsertSemanticDoc } from "../core/vector.js";
import type { DecisionEvent, SessionEvent } from "../types/events.js";
import { atomicWriteFile } from "../core/fs-utils.js";
import { resolveBridgePaths } from "../core/paths.js";

export interface UiServerOptions {
  workspace: string;
  host: string;
  port: number;
  readonly: boolean;
}

interface UiServerResult {
  url: string;
  close: () => Promise<void>;
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const staticRoot = path.resolve(__dirname, "./public");

function json(res: ServerResponse, statusCode: number, payload: unknown): void {
  res.statusCode = statusCode;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(`${JSON.stringify(payload)}\n`);
}

function text(
  res: ServerResponse,
  statusCode: number,
  payload: string,
  contentType = "text/plain; charset=utf-8"
): void {
  res.statusCode = statusCode;
  res.setHeader("Content-Type", contentType);
  res.end(payload);
}

function parseQuery(urlRaw: string | undefined): URL {
  return new URL(urlRaw || "/", "http://localhost");
}

async function readBody(req: IncomingMessage, maxBytes = 1024 * 512): Promise<string> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buff = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buff.length;
    if (total > maxBytes) {
      throw new Error("Request body too large");
    }
    chunks.push(buff);
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function readJsonBody<T>(req: IncomingMessage): Promise<T> {
  const raw = await readBody(req);
  if (!raw.trim()) {
    return {} as T;
  }
  return JSON.parse(raw) as T;
}

function listFromUnknown(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((item) => String(item))
    .map((item) => item.trim())
    .filter((item) => item !== "");
}

export async function startUiServer(options: UiServerOptions): Promise<UiServerResult> {
  const workspace = path.resolve(options.workspace);
  await initWorkspace({
    workspace,
    enableEncryption: false,
    enableSemanticSearch: false,
    disableRedaction: false
  });

  const server = createServer(async (req, res) => {
    try {
      const method = req.method || "GET";
      const url = parseQuery(req.url);
      const pathname = url.pathname;

      if (method === "GET" && pathname === "/health") {
        json(res, 200, { ok: true });
        return;
      }

      if (method === "GET" && pathname === "/api/state") {
        const { config } = await loadConfig(workspace);
        const [context, sessions, decisions, projectContext, handoff] = await Promise.all([
          buildContextSnapshot(workspace, config),
          readSessionEvents(workspace, config, 120),
          readDecisionEvents(workspace, config, 80),
          readProjectContext(workspace),
          readHandoff(workspace, config)
        ]);

        json(res, 200, {
          ok: true,
          workspace,
          readonly: options.readonly,
          config,
          snapshot: context.snapshot,
          sessions: sessions.events,
          decisions: decisions.events,
          projectContext,
          handoff: handoff.text,
          warnings: [
            ...context.snapshot.warnings,
            ...sessions.warnings,
            ...decisions.warnings,
            ...handoff.warnings
          ]
        });
        return;
      }

      if (method === "GET" && pathname === "/api/doctor") {
        const { config } = await loadConfig(workspace);
        const result = await runDoctor(workspace, config);
        json(res, 200, { ok: result.ok, result });
        return;
      }

      if (method === "GET" && pathname === "/api/search") {
        const { config } = await loadConfig(workspace);
        const query = (url.searchParams.get("q") || "").trim();
        const modeRaw = (url.searchParams.get("mode") || "text").trim();
        const mode: SearchMode = modeRaw === "semantic" ? "semantic" : "text";
        const limitRaw = Number.parseInt(url.searchParams.get("limit") || "10", 10);
        const limit = Number.isNaN(limitRaw) || limitRaw <= 0 ? 10 : limitRaw;

        const result = await searchMemory({ workspace, config, query, mode, limit });
        json(res, 200, { ok: true, mode, query, hits: result.hits, warnings: result.warnings });
        return;
      }

      if (!options.readonly && method === "PUT" && pathname === "/api/project-context") {
        const body = await readJsonBody<{ markdown?: string }>(req);
        const markdown = String(body.markdown || "");
        const paths = resolveBridgePaths(workspace);
        await atomicWriteFile(
          paths.projectContextFile,
          markdown.endsWith("\n") ? markdown : `${markdown}\n`,
          0o600
        );
        json(res, 200, { ok: true });
        return;
      }

      if (!options.readonly && method === "PUT" && pathname === "/api/handoff") {
        const body = await readJsonBody<{ markdown?: string }>(req);
        const { config } = await loadConfig(workspace);
        const markdown = String(body.markdown || "");
        const persisted = await saveHandoff(workspace, config, markdown);
        json(res, 200, { ok: true, persistedAt: persisted.file, encrypted: persisted.encrypted });
        return;
      }

      if (!options.readonly && method === "POST" && pathname === "/api/handoff/build") {
        const { config } = await loadConfig(workspace);
        const context = await buildContextSnapshot(workspace, config);
        const recentArtifacts = context.sessions.slice(-8).flatMap((session) => session.artifacts).slice(-12);
        const markdown = renderHandoffMarkdown({
          objective: context.snapshot.objective,
          recentDecisions: context.snapshot.recentDecisions,
          pending: context.snapshot.pending,
          nextSteps: context.snapshot.nextSteps,
          recentArtifacts
        });
        const persisted = await saveHandoff(workspace, config, markdown);
        json(res, 200, { ok: true, markdown, persistedAt: persisted.file, encrypted: persisted.encrypted });
        return;
      }

      if (!options.readonly && method === "POST" && pathname === "/api/log") {
        const body = await readJsonBody<Partial<SessionEvent>>(req);
        const { config } = await loadConfig(workspace);
        const event: SessionEvent = {
          ts: new Date().toISOString(),
          tool: String(body.tool || "ui"),
          workspace,
          branch: String(body.branch || currentGitBranch(workspace)),
          intent: String(body.intent || ""),
          actions: listFromUnknown(body.actions),
          artifacts: listFromUnknown(body.artifacts),
          summary: String(body.summary || ""),
          tags: listFromUnknown(body.tags)
        };

        if (!event.intent.trim() || !event.summary.trim()) {
          json(res, 400, { ok: false, error: "intent and summary are required" });
          return;
        }

        const persisted = await appendSessionEvent(workspace, config, event);

        if (semanticEnabled(config)) {
          await upsertSemanticDoc(workspace, config, {
            id: `session:${event.ts}:${event.tool}`,
            source: "sessions",
            ts: event.ts,
            ref: `session:${event.ts}`,
            text: [event.intent, event.summary, ...event.actions, ...event.artifacts, ...event.tags].join("\n")
          });
        }

        json(res, 200, { ok: true, event, persistedAt: persisted.file, encrypted: persisted.encrypted });
        return;
      }

      if (!options.readonly && method === "POST" && pathname === "/api/decision") {
        const body = await readJsonBody<Partial<DecisionEvent>>(req);
        const { config } = await loadConfig(workspace);

        const event: DecisionEvent = {
          id: String(body.id || `dec-${Date.now().toString(36)}`),
          ts: new Date().toISOString(),
          title: String(body.title || ""),
          context: String(body.context || "N/A"),
          decision: String(body.decision || ""),
          impact: String(body.impact || "N/A"),
          supersedes: listFromUnknown(body.supersedes)
        };

        if (!event.title.trim() || !event.decision.trim()) {
          json(res, 400, { ok: false, error: "title and decision are required" });
          return;
        }

        const persisted = await appendDecisionEvent(workspace, config, event);

        if (semanticEnabled(config)) {
          await upsertSemanticDoc(workspace, config, {
            id: `decision:${event.id}`,
            source: "decisions",
            ts: event.ts,
            ref: `decision:${event.id}`,
            text: [event.title, event.context, event.decision, event.impact, ...event.supersedes].join("\n")
          });
        }

        json(res, 200, { ok: true, event, persistedAt: persisted.file, encrypted: persisted.encrypted });
        return;
      }

      if ((method === "GET" || method === "HEAD") && pathname === "/") {
        const html = await fs.readFile(path.join(staticRoot, "index.html"), "utf8");
        text(res, 200, method === "HEAD" ? "" : html, "text/html; charset=utf-8");
        return;
      }

      if ((method === "GET" || method === "HEAD") && pathname === "/app.js") {
        const js = await fs.readFile(path.join(staticRoot, "app.js"), "utf8");
        text(res, 200, method === "HEAD" ? "" : js, "text/javascript; charset=utf-8");
        return;
      }

      if ((method === "GET" || method === "HEAD") && pathname === "/styles.css") {
        const css = await fs.readFile(path.join(staticRoot, "styles.css"), "utf8");
        text(res, 200, method === "HEAD" ? "" : css, "text/css; charset=utf-8");
        return;
      }

      json(res, 404, { ok: false, error: "Not found" });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      json(res, 500, { ok: false, error: message });
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, options.host, () => {
      server.off("error", reject);
      resolve();
    });
  });

  const address = server.address();
  const port = typeof address === "object" && address ? address.port : options.port;
  const url = `http://${options.host === "0.0.0.0" ? "127.0.0.1" : options.host}:${port}`;

  return {
    url,
    close: async () => {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
    }
  };
}
