---
tags:
  - memory-bridge
  - handoff
---

# Handoff

## Objective
Install global Antigravity memory-bridge skill and verify MCP server

## Recent Decisions
- [dec-mu7tvkhc] Independent Community Memory Bridge: Adopt filesystem JSONL and Markdown contracts under .memory-bridge with zero runtime dependencies
- [dec-mu7tvkjh] Hybrid Local Search Engine: Combine BM25 term weighting with local embedded SQLite cosine similarity
- [dec-muc3rsh5] Obsidian Vault Export & JEV BM25 Hybrid Provider Support: Added optional Obsidian vault sync (memory-bridge obsidian --vault <path>) exporting Markdown notes with YAML frontmatter and wikilinks, and added 'jev' semantic provider option for joint code-text search combined with BM25 SQLite FTS5.

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
- https://github.com/leninejunior/engrene-memory-bridge/releases/tag/v0.2.0
- README.md
- ROADMAP.md
- https://github.com/leninejunior/engrene-memory-bridge/issues/3
- https://github.com/leninejunior/engrene-memory-bridge/issues/4
- src/core/obsidian.ts
- src/core/vector.ts
- src/types/events.ts
- src/cli/bin.ts
- tests/unit/obsidian-and-jev.test.ts
- skills/memory-bridge/SKILL.md
- src/mcp/server.ts

