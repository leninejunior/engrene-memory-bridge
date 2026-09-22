# GitHub Copilot Instructions (Compound Engineering + Memory Bridge)

## Project Rules
- Follow Memory Bridge lifecycle protocol defined in AGENTS.md.
- Read .memory-bridge/handoff.md before starting work.
- Maintain zero runtime dependencies and local-first storage.

## Active Decisions
- **[dec-mu7tvkhc] Independent Community Memory Bridge**: Adopt filesystem JSONL and Markdown contracts under .memory-bridge with zero runtime dependencies *(Impact: Full transparency, no vendor lock-in, cross-tool continuity between Claude, Codex, Gemini, Antigravity and Orca)*
- **[dec-mu7tvkjh] Hybrid Local Search Engine**: Combine BM25 term weighting with local embedded SQLite cosine similarity *(Impact: Fast, local, offline search without cloud LLM API dependencies)*
- **[dec-muc3rsh5] Obsidian Vault Export & JEV BM25 Hybrid Provider Support**: Added optional Obsidian vault sync (memory-bridge obsidian --vault <path>) exporting Markdown notes with YAML frontmatter and wikilinks, and added 'jev' semantic provider option for joint code-text search combined with BM25 SQLite FTS5. *(Impact: Expands memory-bridge export capabilities to Obsidian and improves semantic vector retrieval options.)*
- **[dec-mucoine1] Compound Engineering (CE) Multi-Agent Rules Synchronization**: Added 'memory-bridge ce' CLI command and core module (src/core/ce.ts) to automatically generate and sync AGENTS.md, .cursorrules, CLAUDE.md, and copilot-instructions.md with active decisions and pitfalls. *(Impact: Ensures all AI assistants automatically inherit project decisions, memory lifecycle protocols, and pitfalls without manual prompt editing.)*
- **[dec-mucplvwt] Automatic Multi-Agent & Obsidian Sync Triggers**: Added automatic integration execution (src/core/auto-sync.ts) triggered on 'decision add', 'log', and 'handoff build' events to keep Compound Engineering files and Obsidian vaults in sync automatically. *(Impact: Eliminates manual sync steps and keeps rule files and Obsidian notes updated in real-time.)*
