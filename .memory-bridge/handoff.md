# Handoff

## Objective
Mesclar PR #8 e versionar a memória deste repo

## Recent Decisions
- [dec-muc3rsh5] Obsidian Vault Export & JEV BM25 Hybrid Provider Support: Added optional Obsidian vault sync (memory-bridge obsidian --vault <path>) exporting Markdown notes with YAML frontmatter and wikilinks, and added 'jev' semantic provider option for joint code-text search combined with BM25 SQLite FTS5.
- [dec-mucoine1] Compound Engineering (CE) Multi-Agent Rules Synchronization: Added 'memory-bridge ce' CLI command and core module (src/core/ce.ts) to automatically generate and sync AGENTS.md, .cursorrules, CLAUDE.md, and copilot-instructions.md with active decisions and pitfalls.
- [dec-mucplvwt] Automatic Multi-Agent & Obsidian Sync Triggers: Added automatic integration execution (src/core/auto-sync.ts) triggered on 'decision add', 'log', and 'handoff build' events to keep Compound Engineering files and Obsidian vaults in sync automatically.
- [dec-mudge6ri] Obsidian vault import is bidirectional, vault wins by default: Added 'memory-bridge obsidian import' and 'obsidian sync' (import then export). Decisions match by frontmatter id; notes without id get a generated id written back and export reuses the user's file name. Sessions match by ts+tool. Conflicts resolved by --prefer vault (default) or bridge; updates replace the JSONL record in place (same id, no duplicate). Redaction runs on import. config.integrations.obsidian.autoImport pulls before resume. loadConfig now preserves the integrations block (it was silently dropped before, so vaultDir/autoSync from config.json never applied).
- [dec-mudi62tf] This repository commits its own .memory-bridge/ (selective .gitignore): Track config.json, decisions.jsonl, sessions/*.jsonl, handoff.md and project-context.md in Git; ignore only vector.sqlite, .lock and observations/. Every log/decision/handoff change is committed together with the code. redaction.customPatterns redacts IPv4(:port); hostnames and SSH aliases are not covered, so never put server names in summaries (the repo is public).

## Pending
- publish npm package (requires npm login)
- TODO: push community roadmap to remote

## Next Steps
- Login to npm registry (`npm login`)
- Publish package (`npm publish`)
- Open PR for branch `leninejunior/community-roadmap`
- created AGENTS.md
- created CLAUDE.md
- created .cursorrules
- created copilot-instructions.md
- updated README.md

## Recent Artifacts
- src/core/obsidian.ts
- src/core/config.ts
- src/core/store.ts
- tests/unit/obsidian-import.test.ts
- https://github.com/leninejunior/engrene-memory-bridge/releases/tag/v0.3.0
- https://github.com/leninejunior/engrene-memory-bridge/pull/8
- docs/benchmarks/2026-09-22-retrieval.md
- tests/benchmark/harness.ts
- src/core/config.ts
- src/core/redaction.ts
- tests/unit/gitignore-optin-and-leak-detection.test.ts
- .gitignore
