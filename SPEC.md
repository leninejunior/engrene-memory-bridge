# Memory Bridge Specification

## Spec Version
- `1.1.0`

## 1. Storage Interface (Primary API)

All integrations must use project files under `.memory-bridge/`.

Required paths:
- `.memory-bridge/config.json`
- `.memory-bridge/project-context.md`
- `.memory-bridge/decisions.jsonl`
- `.memory-bridge/sessions/<yyyy-mm-dd>.jsonl`
- `.memory-bridge/handoff.md`

Optional and indexing acceleration paths:
- `.memory-bridge/observations/<yyyy-mm-dd>-session-<id>.jsonl` (short-term captured observations)
- `.memory-bridge/vector.sqlite` (SQLite FTS5 + dense vector embeddings)
- `.memory-bridge/.lock` (atomic multi-process writer lock)

## 2. Event Contracts

### 2.1 `session_event`
Fields (required):
- `ts` (ISO-8601)
- `tool` (string)
- `workspace` (absolute path)
- `branch` (string)
- `intent` (string)
- `actions` (string[])
- `artifacts` (string[])
- `summary` (string)
- `tags` (string[])

Optional fields:
- `taskId` (string, Orca/subagent task identifier)
- `parentTaskId` (string, parent task identifier)

### 2.2 `decision_event`
Fields (required):
- `id` (string)
- `ts` (ISO-8601)
- `title` (string)
- `context` (string)
- `decision` (string)
- `impact` (string)
- `supersedes` (string[])

### 2.3 `observation_event`
Fields (required):
- `id` (string)
- `ts` (ISO-8601)
- `sessionId` (string)
- `tool` (string)
- `type` ("session_start" | "user_prompt" | "tool_call" | "tool_result" | "session_end")
- `payload` (Record<string, unknown>)

## 3. Resume Contract

`resume --for <tool>` must return a compact context with:
- current objective
- recent decisions
- pending items
- next steps
- warnings (if data is missing/decryption unavailable)

If some files are missing, command must not fail hard; return partial context + warnings.

## 4. Security

### 4.1 Redaction & Path Exclusions
Before persistence, sensitive patterns must be redacted (API keys, tokens, passwords, private keys, `.env`-style sensitive assignments).
Observations must filter out paths matching sensitive glob patterns (`.env*`, `node_modules/**`, `secrets/**`, `*.pem`, `*.key`, `id_rsa*`).

### 4.2 Optional encryption
When `config.encryption.enabled=true`, payloads may be persisted as encrypted envelopes:

```json
{
  "_encrypted": true,
  "alg": "aes-256-gcm",
  "iv": "...",
  "tag": "...",
  "data": "...",
  "kind": "session_event",
  "ts": "2026-03-19T00:00:00.000Z"
}
```

## 5. Concurrency and Atomicity

Write operations must use:
- lockfile (`.memory-bridge/.lock`) with stale lock detection (>10m)
- atomic append and atomic replace (temp file + rename)

Goal: avoid JSONL corruption under concurrent `log` and `observe` calls across parallel subagents.

## 6. Search & Retrieval

Command: `search <query>`

Modes:
- `text`: SQLite FTS5 full-text search with BM25 ranking (fallback to token scoring if SQLite unavailable)
- `semantic`: Cosine similarity over 128-dimensional dense vector embeddings (`embedLocalDense` or external provider: `ollama`, `openai-compatible`)
- `hybrid`: Reciprocal Rank Fusion (RRF) with constant k=60 combining FTS5 lexical rank, dense vector similarity, and recency boost

## 7. Model Context Protocol (MCP)

Command: `mcp`

Exposes an stdio JSON-RPC 2.0 MCP server with tools:
- `memory_resume`
- `memory_search`
- `memory_log`
- `memory_decision`
- `memory_handoff`

## 8. CLI Compatibility

All public commands must support `--json`.

Core commands:
- `init`
- `log`
- `decision add`
- `handoff build`
- `resume --for <tool>`
- `lint`
- `consolidate`
- `doctor`
- `stats`
- `observe`
- `mcp`
- `search <query>`
- `hook print <target>`
- `ui`

## 9. Wrapper Contract

Official wrappers:
- `mb-codex`
- `mb-claude`
- `mb-gemini`
- `mb-hermes`
- `mb-qwen`
- `mb-kiro`
- `mb-kilo`
- `mb-copilot`
- `mb-aider`
- `mb-antigravity`
- `mb-trae`
- `mb-dyad`
- `mb-replit`
- `mb-qoder`
- `mb-cursor`
- `mb-vscode`

Wrapper naming pattern:
- `mb-<tool>`

Behavior:
- `pre`: run `resume --for <tool>`
- `post`: run `log` then `handoff build`

