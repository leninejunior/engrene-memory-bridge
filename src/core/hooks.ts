import path from "node:path";

import type { BridgeConfig, ObservationEvent, ObservationType } from "../types/events.js";

/**
 * Parsing for lifecycle-hook payloads delivered on stdin by coding agents.
 *
 * Design rules, in order of importance:
 * 1. Never throw, never write to stdout, always exit 0. On SessionStart and UserPromptSubmit
 *    Claude Code injects a hook's stdout into the model's context as plain text, and exit 2 on
 *    UserPromptSubmit erases the user's prompt. Silence is a correctness requirement here.
 * 2. Capture metadata, not content. By default we record what happened (event, tool,
 *    repo-relative file paths), never prompt text, shell commands or file contents:
 *    observations are promoted into versioned `sessions/*.jsonl` by `consolidate`,
 *    and redaction covers secrets but not hostnames or absolute paths.
 * 3. Nothing outside the workspace root is recorded.
 */

/** Claude Code `hook_event_name` -> our observation type. Events we do not map are ignored. */
const CLAUDE_EVENT_MAP: Record<string, ObservationType> = {
  SessionStart: "session_start",
  UserPromptSubmit: "user_prompt",
  PreToolUse: "tool_call",
  PostToolUse: "tool_result",
  SessionEnd: "session_end"
};

export interface HookCaptureOptions {
  /** Store the user's prompt text. Off by default; it is the most sensitive field. */
  includePrompts?: boolean;
  /** Store shell command text for Bash-like tools. Off by default; commands carry hosts and paths. */
  includeCommands?: boolean;
}

export interface ParsedHookPayload {
  type: ObservationType;
  tool: string;
  sessionId: string;
  /** Directory the agent reported working in; the caller resolves the workspace from it. */
  cwd?: string;
  payload: Record<string, unknown>;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

/**
 * Collects file paths from a tool input, covering the shapes used by editing tools:
 * `file_path`, `notebook_path`, and the `edits[]` array of multi-edit tools.
 */
function collectFilePaths(toolInput: Record<string, unknown> | undefined): string[] {
  if (!toolInput) {
    return [];
  }
  const found: string[] = [];
  for (const key of ["file_path", "notebook_path", "path"]) {
    const value = asString(toolInput[key]);
    if (value) {
      found.push(value);
    }
  }
  if (Array.isArray(toolInput.edits)) {
    for (const edit of toolInput.edits) {
      const value = asString(asRecord(edit)?.file_path);
      if (value) {
        found.push(value);
      }
    }
  }
  return Array.from(new Set(found));
}

/**
 * Makes paths relative to the workspace and drops anything outside it, so a hook installed
 * at user level cannot record another project's tree.
 */
export function relativizeWithinRoot(paths: string[], root: string): string[] {
  const resolvedRoot = path.resolve(root);
  const kept: string[] = [];
  for (const candidate of paths) {
    const absolute = path.isAbsolute(candidate) ? candidate : path.resolve(resolvedRoot, candidate);
    const relative = path.relative(resolvedRoot, absolute);
    if (relative && !relative.startsWith("..") && !path.isAbsolute(relative)) {
      kept.push(relative);
    }
  }
  return Array.from(new Set(kept));
}

/**
 * Parses one Claude Code hook payload. Returns undefined for anything unusable:
 * malformed JSON, an unmapped event, or a payload with no event name.
 */
export function parseClaudeHookPayload(raw: string, options: HookCaptureOptions = {}): ParsedHookPayload | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  const root = asRecord(parsed);
  if (!root) {
    return undefined;
  }

  const eventName = asString(root.hook_event_name);
  const type = eventName ? CLAUDE_EVENT_MAP[eventName] : undefined;
  if (!type) {
    return undefined;
  }

  const toolName = asString(root.tool_name);
  const toolInput = asRecord(root.tool_input);
  const payload: Record<string, unknown> = { event: eventName };

  if (toolName) {
    // `consolidate` reads `payload.tool` to render "Executed <tool>".
    payload.tool = toolName;
  }

  const files = collectFilePaths(toolInput);
  if (files.length > 0) {
    payload.files = files;
  }

  if (type === "user_prompt" && options.includePrompts) {
    // Claude Code names this `user_prompt`; `prompt` is accepted as a fallback for other agents.
    const prompt = asString(root.user_prompt) ?? asString(root.prompt);
    if (prompt) {
      // `consolidate` reads `payload.prompt` to build the session intent.
      payload.prompt = prompt.slice(0, 500);
    }
  }

  if (options.includeCommands) {
    const command = asString(toolInput?.command);
    if (command) {
      payload.command = command.slice(0, 500);
    }
  }

  if (type === "session_start") {
    const source = asString(root.source);
    if (source) {
      payload.source = source;
    }
  }

  return {
    type,
    tool: "claude",
    sessionId: asString(root.session_id) ?? `hook-${Date.now()}`,
    ...(asString(root.cwd) ? { cwd: asString(root.cwd)! } : {}),
    payload
  };
}

export function captureOptionsFromConfig(config: BridgeConfig): HookCaptureOptions {
  const capture = config.capture as (BridgeConfig["capture"] & HookCaptureOptions) | undefined;
  return {
    includePrompts: capture?.includePrompts === true,
    includeCommands: capture?.includeCommands === true
  };
}

export function buildObservationFromHook(parsed: ParsedHookPayload, workspace: string): ObservationEvent {
  const payload = { ...parsed.payload };
  if (Array.isArray(payload.files)) {
    const relative = relativizeWithinRoot(payload.files.map(String), workspace);
    if (relative.length > 0) {
      payload.files = relative;
    } else {
      delete payload.files;
    }
  }
  return {
    id: `obs-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    ts: new Date().toISOString(),
    sessionId: parsed.sessionId,
    tool: parsed.tool,
    type: parsed.type,
    payload
  };
}

/**
 * The settings.json block a user pastes into `.claude/settings.json`.
 *
 * PostToolUse is matched to editing and shell tools only, and PreToolUse is deliberately
 * absent: it would double the process spawns on every tool call while adding nothing that
 * PostToolUse does not already record. `Stop` is not used either, since it fires on every
 * turn rather than at the end of a session.
 */
export function renderClaudeSettingsHook(binPath: string): string {
  const command = `${binPath} observe --stdin`;
  const entry = (matcher: string | undefined) => ({
    ...(matcher === undefined ? {} : { matcher }),
    hooks: [{ type: "command", command, timeout: 5 }]
  });
  return JSON.stringify(
    {
      hooks: {
        SessionStart: [entry(undefined)],
        UserPromptSubmit: [entry(undefined)],
        PostToolUse: [entry("Edit|MultiEdit|Write|NotebookEdit|Bash")],
        SessionEnd: [entry(undefined)]
      }
    },
    null,
    2
  );
}
