# Memory Bridge Specification

## Spec Version
- `1.0.0`

## 1. Storage Interface (Primary API)

All integrations must use project files under `.memory-bridge/`.

Required paths:
- `.memory-bridge/config.json`
- `.memory-bridge/project-context.md`
- `.memory-bridge/decisions.jsonl`
- `.memory-bridge/sessions/<yyyy-mm-dd>.jsonl`
- `.memory-bridge/handoff.md`

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

## 3. Resume Contract

`resume --for <tool>` must return a compact context with:
- current objective
- recent decisions
- pending items
- next steps
- warnings (if data is missing/decryption unavailable)

If some files are missing, command must not fail hard; return partial context + warnings.

## 4. Security

### 4.1 Redaction
Before persistence, sensitive patterns must be redacted (API keys, tokens, passwords, private keys, `.env`-style sensitive assignments).

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

Kinds:
- `session_event`
- `decision_event`
- `handoff`

## 5. Concurrency and Atomicity

Write operations must use:
- lockfile (`.memory-bridge/.lock`)
- atomic replace (temp file + rename)

Goal: avoid JSONL corruption under concurrent `log` calls.

## 6. Search

Command: `search <query>`

Modes:
- `text` (default)
- `semantic` (optional, requires `semanticSearch.enabled=true`)

Local semantic index:
- `.memory-bridge/vector.sqlite`

## 7. CLI Compatibility

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
- `search <query>`
- `hook print <target>`
- `ui`

## 8. Wrapper Contract

Official wrappers:
- `mb-codex`
- `mb-claude`
- `mb-gemini`
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
