---
id: "dec-muc3rsh5"
title: "Obsidian Vault Export & JEV BM25 Hybrid Provider Support"
date: "2026-09-22T03:16:49.769Z"
tags:
  - memory-bridge
  - decision
---

# Decision: Obsidian Vault Export & JEV BM25 Hybrid Provider Support

- **ID:** `dec-muc3rsh5`
- **Date:** 2026-09-22T03:16:49.769Z
- **Supersedes:** N/A

## Context
Users requested seamless integration with Obsidian graph view for visual decision lineage and joint embedding vector provider for hybrid search.

## Decision
Added optional Obsidian vault sync (memory-bridge obsidian --vault <path>) exporting Markdown notes with YAML frontmatter and wikilinks, and added 'jev' semantic provider option for joint code-text search combined with BM25 SQLite FTS5.

## Impact
Expands memory-bridge export capabilities to Obsidian and improves semantic vector retrieval options.
