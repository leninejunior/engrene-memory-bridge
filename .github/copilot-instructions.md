# GitHub Copilot Instructions — Memory Bridge

This repository uses **Memory Bridge** (`engrene-memory-bridge`).
Please review [AGENTS.md](../AGENTS.md) for full agent guidelines.

## Quick Protocol
- **Resume**: Run `memory-bridge resume --for copilot` or inspect `.memory-bridge/handoff.md` before starting tasks.
- **Skill**: Skill documentation is at `skills/memory-bridge/SKILL.md`.
- **Decisions**: Log non-trivial architectural decisions with `memory-bridge decision add`.
- **Validation**: Ensure tests pass with `npm test`.
- **Log & Handoff**: On completion, run `memory-bridge log --tool copilot ...` and `memory-bridge handoff build`.
- **Local-first**: Storage is strictly local under `.memory-bridge/`. Do not exfiltrate codebase memory.
