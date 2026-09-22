---
id: "dec-mu7tvkjh"
title: "Hybrid Local Search Engine"
date: "2026-09-19T03:28:45.245Z"
tags:
  - memory-bridge
  - decision
---

# Decision: Hybrid Local Search Engine

- **ID:** `dec-mu7tvkjh`
- **Date:** 2026-09-19T03:28:45.245Z
- **Supersedes:** N/A

## Context
Text matching alone misses conceptual intent while pure vectors struggle with exact token symbols

## Decision
Combine BM25 term weighting with local embedded SQLite cosine similarity

## Impact
Fast, local, offline search without cloud LLM API dependencies
