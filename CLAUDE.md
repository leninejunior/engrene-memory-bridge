# CLAUDE.md — Claude Code Instructions (Compound Engineering + Memory Bridge)

## Workflow & Memory Protocol
1. Resume context at session start: `memory-bridge resume --for claude`
2. Check past decisions & traps: `memory-bridge search "<query>" --mode hybrid`
3. Record architectural choices: `memory-bridge decision add --title "<title>" --decision "<decision>"`
4. Build & verify: `npm test`
5. Wrap-up session: `memory-bridge log --tool claude --intent "<intent>" --summary "<summary>" && memory-bridge handoff build`

## Active Architectural Decisions & Pitfalls
- **[dec-mu7tvkhc] Independent Community Memory Bridge**: Adopt filesystem JSONL and Markdown contracts under .memory-bridge with zero runtime dependencies *(Impact: Full transparency, no vendor lock-in, cross-tool continuity between Claude, Codex, Gemini, Antigravity and Orca)*
- **[dec-mu7tvkjh] Hybrid Local Search Engine**: Combine BM25 term weighting with local embedded SQLite cosine similarity *(Impact: Fast, local, offline search without cloud LLM API dependencies)*
- **[dec-muc3rsh5] Obsidian Vault Export & JEV BM25 Hybrid Provider Support**: Added optional Obsidian vault sync (memory-bridge obsidian --vault <path>) exporting Markdown notes with YAML frontmatter and wikilinks, and added 'jev' semantic provider option for joint code-text search combined with BM25 SQLite FTS5. *(Impact: Expands memory-bridge export capabilities to Obsidian and improves semantic vector retrieval options.)*
- **[dec-mucoine1] Compound Engineering (CE) Multi-Agent Rules Synchronization**: Added 'memory-bridge ce' CLI command and core module (src/core/ce.ts) to automatically generate and sync AGENTS.md, .cursorrules, CLAUDE.md, and copilot-instructions.md with active decisions and pitfalls. *(Impact: Ensures all AI assistants automatically inherit project decisions, memory lifecycle protocols, and pitfalls without manual prompt editing.)*
