# Handoff

## Objective
Reposicionar a comparacao com o Hindsight depois de descobrir a integracao Coding Agents

## Recent Decisions
- [dec-muc3rsh5] Obsidian Vault Export & JEV BM25 Hybrid Provider Support: Added optional Obsidian vault sync (memory-bridge obsidian --vault <path>) exporting Markdown notes with YAML frontmatter and wikilinks, and added 'jev' semantic provider option for joint code-text search combined with BM25 SQLite FTS5.
- [dec-mucoine1] Compound Engineering (CE) Multi-Agent Rules Synchronization: Added 'memory-bridge ce' CLI command and core module (src/core/ce.ts) to automatically generate and sync AGENTS.md, .cursorrules, CLAUDE.md, and copilot-instructions.md with active decisions and pitfalls.
- [dec-mucplvwt] Automatic Multi-Agent & Obsidian Sync Triggers: Added automatic integration execution (src/core/auto-sync.ts) triggered on 'decision add', 'log', and 'handoff build' events to keep Compound Engineering files and Obsidian vaults in sync automatically.
- [dec-mudge6ri] Obsidian vault import is bidirectional, vault wins by default: Added 'memory-bridge obsidian import' and 'obsidian sync' (import then export). Decisions match by frontmatter id; notes without id get a generated id written back and export reuses the user's file name. Sessions match by ts+tool. Conflicts resolved by --prefer vault (default) or bridge; updates replace the JSONL record in place (same id, no duplicate). Redaction runs on import. config.integrations.obsidian.autoImport pulls before resume. loadConfig now preserves the integrations block (it was silently dropped before, so vaultDir/autoSync from config.json never applied).
- [dec-mudi62tf] This repository commits its own .memory-bridge/ (selective .gitignore): Track config.json, decisions.jsonl, sessions/*.jsonl, handoff.md and project-context.md in Git; ignore only vector.sqlite, .lock and observations/. Every log/decision/handoff change is committed together with the code. redaction.customPatterns redacts IPv4(:port); hostnames and SSH aliases are not covered, so never put server names in summaries (the repo is public).

## Pending
- next: decidir se o projeto muda de posicionamento
- next: publicar 0.4.0 no npm com 2FA
- next: dono publicar 0.4.0 no npm com 2FA
- next: decidir issues 13 9 e 10
- next: decidir entre o PR 18 e o trabalho do Codex na issue 15
- next: decidir as issues 13 9 e 10
- implementar derivacao de Pending
- next: decidir entre PR 18 e o trabalho do Codex na issue 15

## Next Steps
- verificar doc do Hindsight
- consultar API do GitHub
- reescrever secao do HERMES.md
- corrigir INTEGRATIONS.md
- next: decidir se o projeto muda de posicionamento

## Recent Artifacts
- README.md
- .gitignore
- https://github.com/leninejunior/engrene-memory-bridge/pull/17
- https://github.com/leninejunior/engrene-memory-bridge/pull/18
- src/core/context.ts
- tests/unit/handoff-pending.test.ts
- https://github.com/leninejunior/engrene-memory-bridge/releases/tag/v0.3.1
- https://www.npmjs.com/package/engrene-memory-bridge
- https://github.com/leninejunior/engrene-memory-bridge/releases/tag/v0.4.0
- HERMES.md
- HERMES.md
- INTEGRATIONS.md
