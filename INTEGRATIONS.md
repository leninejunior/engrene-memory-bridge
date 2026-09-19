# Integrating with Any IDE or CLI

This guide explains exactly how to make `memory-bridge` work with any developer tool.

## Integration contract

For any tool `<tool>`:

1. **Pre-hook** (before prompt/task):
   - `memory-bridge resume --for <tool>`
2. **Post-hook** (after task):
   - `memory-bridge log ...`
   - `memory-bridge handoff build`

This is the full interoperability model.

## What this enables

This contract is specifically designed for cross-tool continuity:

- Session A in Tool X writes memory.
- Session B in Tool Y reads and continues from it.
- No tool-specific memory backend is required.

## Popular tool matrix

### Official wrapper support

- Codex: `mb-codex`
- Claude: `mb-claude`
- Gemini: `mb-gemini`
- Hermes Agent: `mb-hermes`
- Qwen Code: `mb-qwen`
- Kiro: `mb-kiro`
- Kilo: `mb-kilo`
- Copilot CLI: `mb-copilot`
- Aider: `mb-aider`
- Antigravity: `mb-antigravity`
- Trae: `mb-trae`
- Dyad: `mb-dyad`
- Replit: `mb-replit`
- Qoder: `mb-qoder`
- Cursor: `mb-cursor`
- VS Code: `mb-vscode`

### Common tools with contract-based support

Use Option A (manual) or Option C (native hooks/scripts):

- Cursor
- VS Code (Continue/Cline and similar)
- Windsurf
- JetBrains IDEs
- Firebase Studio

Requirement: the tool must allow shell commands and/or task hooks.

## Visual mode for developers

For teams that want a visual view/edit layer over the same memory contract:

```bash
memory-bridge ui
```

This opens a local dashboard to inspect and edit context/handoff and create events while keeping CLI interoperability unchanged.

## Option A: Manual (works everywhere)

Use this when your IDE has no hook support.

### Before starting work

```bash
memory-bridge resume --for <tool>
```

### After finishing work

```bash
memory-bridge log --tool <tool> --intent "..." --summary "..." --actions "a,b" --artifacts "x,y" --tags "t1,t2"
memory-bridge handoff build
```

## Option B: Wrapper-based (recommended)

Use built-in wrappers:

- `mb-codex pre|post`
- `mb-claude pre|post`
- `mb-gemini pre|post`
- `mb-kiro pre|post`
- `mb-kilo pre|post`
- `mb-copilot pre|post`
- `mb-aider pre|post`
- `mb-antigravity pre|post`
- `mb-trae pre|post`
- `mb-dyad pre|post`
- `mb-replit pre|post`
- `mb-qoder pre|post`
- `mb-cursor pre|post`
- `mb-vscode pre|post`

Example:

```bash
mb-claude pre
mb-claude post --intent "Fix auth race" --summary "Locking added" --actions "TODO: benchmark" --artifacts "src/auth.ts"

mb-gemini pre
mb-gemini post --intent "Close security gap" --summary "Validation improved" --actions "TODO: add stress test" --artifacts "src/security.ts"
```

## Option C: Native hooks (if your IDE supports them)

Map these commands:

- **On session/task start**: `memory-bridge resume --for <tool> --json`
- **On task completion**:
  - `memory-bridge log --tool <tool> ... --json`
  - `memory-bridge handoff build --json`

## Option D: Native Skills & AI Agent Guidelines

For developers using AI agents (Antigravity, Claude Code, Cursor, GitHub Copilot, Codex, Windsurf), `engrene-memory-bridge` includes first-class guidelines and native skills pre-configured in the repository:

### 1. Ready-to-Use Agent Instructions
- **Universal Agent Standard**: [`AGENTS.md`](./AGENTS.md)
- **Claude Code CLI**: [`CLAUDE.md`](./CLAUDE.md)
- **Cursor IDE / Composer**: [`.cursorrules`](./.cursorrules)
- **GitHub Copilot**: [`.github/copilot-instructions.md`](./.github/copilot-instructions.md)

### 2. Native Skill Package
The repository provides a declarative agent skill:
- In-repo standard path: `.agents/skills/memory-bridge/SKILL.md`
- Source template path: `skills/memory-bridge/SKILL.md`

#### Antigravity Setup:
```bash
# View setup instructions:
memory-bridge hook print antigravity

# Install globally for all projects in Antigravity:
mkdir -p ~/.gemini/config/skills/memory-bridge
cp skills/memory-bridge/SKILL.md ~/.gemini/config/skills/memory-bridge/SKILL.md

# Or install for this repository only:
mkdir -p .agents/skills/memory-bridge
cp skills/memory-bridge/SKILL.md .agents/skills/memory-bridge/SKILL.md
```

Once installed or detected, any AI agent will automatically:
1. Run `memory-bridge resume` before executing tasks.
2. Record `memory-bridge decision add` whenever architectural choices are made.
3. Run `npm test` and `memory-bridge lint` to verify stability.
4. Run `memory-bridge log` and `memory-bridge handoff build` upon task completion.

## Option E: Windows scripts (PowerShell/cmd)

If your team uses Windows terminals, use the helper scripts from `scripts/windows`:

- `scripts/windows/mb.ps1` (recommended, no global install)
- `scripts/windows/mb.cmd` (recommended, no global install)
- `scripts/windows/mb-pre.ps1`
- `scripts/windows/mb-post.ps1`
- `scripts/windows/mb-pre.cmd`
- `scripts/windows/mb-post.cmd`

Quick start (PowerShell):

```powershell
.\scripts\windows\mb.ps1 init
.\scripts\windows\mb.ps1 resume --for gemini
```

Quick start (cmd):

```cmd
scripts\windows\mb.cmd init
scripts\windows\mb.cmd resume --for gemini
```

PowerShell example:

```powershell
.\scripts\windows\mb-pre.ps1 -Tool gemini
.\scripts\windows\mb-post.ps1 -Tool gemini -Intent "Implement report export" -Summary "CSV endpoint added" -Actions "TODO: pagination" -Artifacts "src/reports.ts" -Tags "reporting,api"
```

cmd example:

```cmd
scripts\windows\mb-pre.cmd -Tool gemini
scripts\windows\mb-post.cmd -Tool gemini -Intent "Implement report export" -Summary "CSV endpoint added" -Actions "TODO: pagination" -Artifacts "src/reports.ts" -Tags "reporting,api"
```

## Option F: Linux & macOS scripts (Bash/Zsh)

If your team uses Linux or macOS terminal environments, use the helper scripts from `scripts/linux`:

- `scripts/linux/mb.sh` (recommended, runs local build or via `npx`, no global install required)
- `scripts/linux/mb-pre.sh`
- `scripts/linux/mb-post.sh`

Quick start:

```bash
chmod +x scripts/linux/*.sh
./scripts/linux/mb.sh init
./scripts/linux/mb.sh resume --for gemini
```

Bash/Zsh example:

```bash
./scripts/linux/mb-pre.sh --tool gemini
./scripts/linux/mb-post.sh --tool gemini --intent "Implement report export" --summary "CSV endpoint added" --actions "TODO: pagination" --artifacts "src/reports.ts" --tags "reporting,api" --task-id "task-rep-01"
```

## User prompt template for IDEs

When users want consistent behavior, use this instruction in IDE/system prompt:

```text
Always start by reading Memory Bridge context for this workspace.
Use current objective, decisions, pending items, and next steps from `.memory-bridge`.
When done, provide a concise execution summary so it can be persisted via memory-bridge log.
```

## Team policy recommendation

For team-wide consistency, enforce this policy in docs/onboarding:

1. Run `memory-bridge init` once per repository.
2. Never commit `.memory-bridge/*` runtime files.
3. Always run pre/post contract when changing tools.
4. Keep `project-context.md` updated with stable constraints.

## Option G: Model Context Protocol (MCP)

`memory-bridge` includes a built-in JSON-RPC 2.0 MCP server (`memory-bridge mcp`) that communicates over stdio. This enables any MCP-compatible agent or client (Claude Desktop, Cursor, Windsurf, Hermes Agent, Zed, etc.) to query and mutate memory directly via tools.

### Configuration (Claude Desktop / Cursor / Windsurf)

Add to your `claude_desktop_config.json` or cursor MCP settings:

```json
{
  "mcpServers": {
    "memory-bridge": {
      "command": "npx",
      "args": ["-y", "memory-bridge", "mcp"]
    }
  }
}
```

Or when running from a checked-out repository:

```json
{
  "mcpServers": {
    "memory-bridge": {
      "command": "node",
      "args": ["/absolute/path/to/engrene-memory-bridge/dist/src/cli/bin.js", "mcp"]
    }
  }
}
```

### Available MCP Tools

| Tool | Purpose |
|---|---|
| `memory_resume` | Get current objective, pending tasks, recent decisions, and handoff snapshot |
| `memory_search` | Hybrid, semantic, or full-text BM25 search across sessions, decisions, and handoff |
| `memory_log` | Record a session event with intent, summary, actions, and artifacts |
| `memory_decision` | Record an architectural or technical decision (with supersedes tracking) |
| `memory_handoff` | Rebuild and fetch the latest markdown handoff for cross-agent transitions |

---

## Troubleshooting

### Missing or partial resume data

Run:

```bash
memory-bridge doctor
```

`resume` is intentionally fault-tolerant and returns partial context with warnings.

### Encryption enabled but resume cannot decrypt

Set local key:

```bash
export MEMORY_BRIDGE_KEY="your-local-passphrase"
```

### No semantic results

Enable semantic mode and build data:

```bash
memory-bridge init --semantic
memory-bridge search "query" --mode semantic
```
