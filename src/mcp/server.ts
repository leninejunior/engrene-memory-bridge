import readline from "node:readline";
import path from "node:path";

import { currentGitBranch } from "../core/git.js";
import { defaultBackend } from "../core/backend.js";
import { runConsolidation } from "../core/consolidate.js";
import { loadConfig } from "../core/config.js";
import { renderResumeText } from "../core/context.js";
import { type SearchMode } from "../core/search.js";
import type { DecisionEvent, SessionEvent } from "../types/events.js";

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: string | number | null | undefined;
  method: string;
  params?: any;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id?: string | number | null | undefined;
  result?: any;
  error?: {
    code: number;
    message: string;
    data?: any;
  };
}

const MCP_TOOLS = [
  {
    name: "memory_resume",
    description: "Resume project context before starting work: current objective, pending tasks, and recent decisions.",
    inputSchema: {
      type: "object",
      properties: {
        tool: { type: "string", description: "Agent or tool identifier (e.g. claude, codex, antigravity)" }
      },
      required: ["tool"]
    }
  },
  {
    name: "memory_search",
    description: "Search project memory using hybrid (BM25 + dense semantic vectors) or text search.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search query or concept" },
        mode: { type: "string", enum: ["text", "semantic", "hybrid"], default: "hybrid" },
        limit: { type: "number", default: 10 }
      },
      required: ["query"]
    }
  },
  {
    name: "memory_log",
    description: "Record a completed session event into durable project memory.",
    inputSchema: {
      type: "object",
      properties: {
        tool: { type: "string" },
        intent: { type: "string" },
        summary: { type: "string" },
        actions: { type: "array", items: { type: "string" } },
        artifacts: { type: "array", items: { type: "string" } },
        tags: { type: "array", items: { type: "string" } }
      },
      required: ["tool", "intent", "summary"]
    }
  },
  {
    name: "memory_decision",
    description: "Record an architectural or technical decision so all future AI tools respect it.",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string" },
        decision: { type: "string" },
        context: { type: "string" },
        impact: { type: "string" },
        supersedes: { type: "array", items: { type: "string" } }
      },
      required: ["title", "decision"]
    }
  },
  {
    name: "memory_handoff",
    description: "Read or rebuild the consolidated handoff state for the next AI agent or teammate.",
    inputSchema: {
      type: "object",
      properties: {
        rebuild: { type: "boolean", default: false }
      }
    }
  }
];

export async function handleMcpToolCall(
  name: string,
  args: any,
  workspace: string
): Promise<{ text: string; isError?: boolean }> {
  try {
    const { config } = await loadConfig(workspace);

    if (name === "memory_resume") {
      const tool = String(args?.tool || "mcp");
      const { snapshot, warnings } = await defaultBackend.getContext(workspace, tool);
      const text = renderResumeText(tool, snapshot);
      return { text: warnings.length > 0 ? `${text}\nWarnings:\n${warnings.join("\n")}` : text };
    }

    if (name === "memory_search") {
      const query = String(args?.query || "");
      const mode: SearchMode = args?.mode === "text" || args?.mode === "semantic" ? args.mode : "hybrid";
      const limit = Number(args?.limit) || 10;
      const { hits, warnings } = await defaultBackend.search(workspace, query, mode, limit);
      return { text: JSON.stringify({ hits, warnings }, null, 2) };
    }

    if (name === "memory_log") {
      const event: SessionEvent = {
        ts: new Date().toISOString(),
        tool: String(args?.tool || "mcp"),
        workspace,
        branch: String(args?.branch || currentGitBranch(workspace)),
        intent: String(args?.intent || ""),
        summary: String(args?.summary || ""),
        actions: Array.isArray(args?.actions) ? args.actions.map(String) : [],
        artifacts: Array.isArray(args?.artifacts) ? args.artifacts.map(String) : [],
        tags: Array.isArray(args?.tags) ? args.tags.map(String) : []
      };
      await defaultBackend.appendSession(workspace, event);
      return { text: JSON.stringify({ ok: true, event }, null, 2) };
    }

    if (name === "memory_decision") {
      const randomId = Math.random().toString(36).slice(2, 10);
      const event: DecisionEvent = {
        id: `dec-${Date.now().toString(36)}${randomId.slice(0, 4)}`,
        ts: new Date().toISOString(),
        title: String(args?.title || ""),
        decision: String(args?.decision || ""),
        context: String(args?.context || ""),
        impact: String(args?.impact || ""),
        supersedes: Array.isArray(args?.supersedes) ? args.supersedes.map(String) : []
      };
      await defaultBackend.appendDecision(workspace, event);
      return { text: JSON.stringify({ ok: true, decision: event }, null, 2) };
    }

    if (name === "memory_handoff") {
      if (args?.rebuild) {
        const res = await runConsolidation(workspace, config);
        const handoff = await defaultBackend.getHandoff(workspace);
        return { text: JSON.stringify({ ok: true, handoff: handoff.text, consolidation: res }, null, 2) };
      }
      const handoff = await defaultBackend.getHandoff(workspace);
      return { text: handoff.text || "No handoff generated yet." };
    }

    return { text: `Unknown tool: ${name}`, isError: true };
  } catch (err) {
    return { text: `Error executing tool ${name}: ${err instanceof Error ? err.message : String(err)}`, isError: true };
  }
}

export function startMcpServer(workspace = process.cwd()): void {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: false
  });

  const send = (response: JsonRpcResponse) => {
    process.stdout.write(`${JSON.stringify(response)}\n`);
  };

  rl.on("line", async (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;

    let req: JsonRpcRequest;
    try {
      req = JSON.parse(trimmed);
    } catch {
      send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
      return;
    }

    if (req.method === "initialize") {
      send({
        jsonrpc: "2.0",
        id: req.id,
        result: {
          protocolVersion: "2024-11-05",
          capabilities: { tools: {} },
          serverInfo: { name: "engrene-memory-bridge", version: "0.1.0" }
        }
      });
      return;
    }

    if (req.method === "notifications/initialized") {
      // Client ack notification
      return;
    }

    if (req.method === "tools/list") {
      send({
        jsonrpc: "2.0",
        id: req.id,
        result: { tools: MCP_TOOLS }
      });
      return;
    }

    if (req.method === "tools/call") {
      const toolName = String(req.params?.name || "");
      const toolArgs = req.params?.arguments || {};
      const { text, isError } = await handleMcpToolCall(toolName, toolArgs, workspace);

      send({
        jsonrpc: "2.0",
        id: req.id,
        result: {
          content: [{ type: "text", text }],
          isError: Boolean(isError)
        }
      });
      return;
    }

    send({
      jsonrpc: "2.0",
      id: req.id,
      error: { code: -32601, message: `Method not found: ${req.method}` }
    });
  });
}
