# CLAUDE.md

This project uses **Memory Bridge** (`engrene-memory-bridge`) to maintain continuous context across AI sessions and different AI tools.

See [AGENTS.md](AGENTS.md) for the universal agent protocol.

---

## Native Skill

Claude Code agents can use the native skill located at:
* [skills/memory-bridge/SKILL.md](skills/memory-bridge/SKILL.md)

---

## Session Workflow for Claude

### 1. On Every Session Start
Run this command or read `.memory-bridge/handoff.md` before taking any actions:
```bash
memory-bridge resume --for claude
```

### 2. When Making Decisions
```bash
memory-bridge decision add \
  --title "Decision Title" \
  --decision "What was chosen" \
  --context "Why this choice was made" \
  --impact "Consequences and affected parts"
```

### 3. Build & Test Commands
```bash
# Build
npm run build

# Test
npm test

# Lint & Health
memory-bridge lint
memory-bridge doctor
```

### 4. On Session Completion
Always record what was done and rebuild the handoff:
```bash
memory-bridge log \
  --tool claude \
  --intent "<what the user requested>" \
  --summary "<what was implemented>" \
  --actions "task1,task2" \
  --artifacts "file1.ts,file2.md" \
  --tags "feature,test"

memory-bridge handoff build
```

---

## Architecture Principles
- **Local-first**: Storage lives in `.memory-bridge/`. No cloud or external telemetry.
- **Zero runtime dependencies**: Pure Node.js standard library.
- **Security**: Automatic redaction of secrets in memory logs.
