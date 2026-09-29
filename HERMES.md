# HERMES.md — Hermes Agent Guidelines for Memory Bridge

Welcome, Hermes Agent! This repository utilizes **Memory Bridge** (`engrene-memory-bridge`) to maintain continuous, portable context across AI sessions and different agents without vendor lock-in.

---

## 🧭 Native Skills & MCP Support

Hermes Agent can interact with Memory Bridge via **two seamless mechanisms**:

1. **Model Context Protocol (MCP)**:
   If the `memory-bridge` MCP server is active in `~/.hermes/config.yaml`, you have direct access to 5 native tools:
   - `memory_resume` — inspect current objective, pending tasks, recent decisions, and handoff snapshot
   - `memory_search` — hybrid search (SQLite FTS5 BM25 + dense vector embeddings)
   - `memory_log` — persist session events (intent, summary, actions, artifacts)
   - `memory_decision` — record architectural or technical decisions with supersedes tracking
   - `memory_handoff` — rebuild and fetch the latest markdown handoff

2. **Native Skill**:
   - Repository path: [`skills/memory-bridge/SKILL.md`](skills/memory-bridge/SKILL.md)
   - Global Hermes path: `~/.hermes/skills/software-development/memory-bridge/SKILL.md`

---

## ⚡ Agent Lifecycle Protocol for Hermes

```mermaid
flowchart LR
    A["1. Resume Context\n(mb-hermes pre)"] --> B["2. Search / Inspect\n(memory-bridge search)"]
    B --> C["3. Execute & Record Decisions\n(memory-bridge decision add)"]
    C --> D["4. Build & Verify\n(npm test)"]
    D --> E["5. Log & Handoff\n(mb-hermes post)"]
```

### 1. Session Start (Resume Context)

Before executing commands, creating plans, or modifying code:

```bash
# Using wrapper:
mb-hermes pre

# Or core CLI:
memory-bridge resume --for hermes
```

If terminal execution is restricted:
- Read `.memory-bridge/handoff.md`
- Read `.memory-bridge/project-context.md`

### 2. Searching Past Decisions & Technical Context

```bash
# Hybrid search (combines SQLite FTS5 BM25 + dense semantic embeddings):
memory-bridge search "<query>" --mode hybrid

# Text search:
memory-bridge search "<query>" --mode text
```

### 3. Recording Architectural or Technical Choices

Whenever you make non-trivial technical choices (dependencies, architecture, schemas):

```bash
memory-bridge decision add \
  --title "Short decision title" \
  --decision "What was decided and chosen" \
  --context "Why this was needed and alternatives considered" \
  --impact "Effects on codebase and downstream components"
```

### 4. Build, Test & Lint

Always ensure tests and memory integrity pass:

```bash
npm run build
npm test
memory-bridge doctor
```

### 5. Session Wrap-Up & Handoff

Always conclude your turn by recording your work and building the handoff for the next agent:

```bash
# Using wrapper (automatically logs and rebuilds handoff in one step):
mb-hermes post \
  --intent "<what user requested>" \
  --summary "<concise description of changes made>" \
  --actions "task 1,task 2" \
  --artifacts "file1.ts,file2.md" \
  --tags "feature,fix,docs"
```

---

## 🔒 Security & Local-First Principles

1. **100% Local-First**: All memory is stored under `.memory-bridge/` on disk.
2. **Zero Runtime Dependencies**: The core uses pure Node.js stdlib.
3. **Automatic Redaction**: API keys, tokens, and private keys are scrubbed before persistence.
4. **Zero Daemons**: No background daemon required. Everything executes in milliseconds and terminates immediately.

---

## ⚖️ Deep Dive: Hermes Hindsight Plugin vs. Engrene Memory Bridge

Hermes Agent ships a memory plugin called **Hindsight** in its plugin catalog (`plugin-catalog/hindsight.yaml`, installed under `plugins/memory/hindsight/`). It is a **community-tier** plugin maintained by **vectorize-io**, the same provider that previously shipped in-tree. When working with Hermes, developers often ask: **"What is Hindsight, and why use Engrene Memory Bridge instead, or alongside it?"**

Here is the architectural breakdown, with a note at the end on what we measured and what we did not.

---

### 1. What is Hermes Hindsight?

Hindsight is an automated episodic and entity-graph memory engine tailored specifically for the Python runtime of Hermes Agent:
* **Version**: 1.0.1 at the time of writing, requiring Hermes `>=0.21.4`.
* **Technology Stack**: Python. Per the Hermes catalog entry, `local_embedded` mode installs the `hindsight-all` PyPI package into the Hermes virtualenv on first use, through core's lazy-install path (subject to `security.allow_lazy_installs`). `hermes memory setup` also fetches a bank-template catalog from `raw.githubusercontent.com`.
* **Execution Modes**: `cloud`, `local embedded` and `local external`. Embedded mode runs the engine in-process alongside Hermes; cloud mode sends turns to the Hindsight API.
* **Capabilities**: knowledge graph, entity resolution, multi-strategy retrieval (`recall` / `reflect` / `retain`) and **automatic per-turn capture**.
* **Storage Location**: outside your repository, in Hermes' user-level state.

---

### 2. Why Hindsight Causes Friction in Modern Dev Workflows

While Hindsight has impressive knowledge-graph capabilities, in real-world multi-agent software engineering it introduces significant operational bottlenecks:

| Limitation in Hindsight | Real-World Pain Point |
|---|---|
| **No shared project memory** | Hindsight is a product with its own SDKs and integrations, but the Hermes plugin keeps memory in Hermes' own store. Switching to **Claude Code**, **Cursor**, **Codex**, **Gemini** or **Antigravity** means those agents do not read it, unless you adopt Hindsight's API in each of them. |
| **Python runtime and lazy install** | Embedded mode pulls a Python dependency chain into the Hermes venv on first use and downloads model assets. We did not benchmark its memory or startup cost; see the note at the end. |
| **Daemon & Port Fragility** | **Background Process Failures**: Operating background daemons on local ports leads to port collisions, orphaned processes, and connection timeouts if the daemon crashes or fails to boot. |
| **Opaque Black-Box Data** | **Non-Auditable**: Memories are serialized in internal binary/database schemas outside the repository. You cannot run `git diff` on what the agent learned, and team members cannot review memory updates in Pull Requests. |
| **Cloud Lock-In Risk** | When running in hosted mode, project context and code snippets are dispatched to external cloud APIs, violating strict zero-trust or offline/air-gapped privacy requirements. |

---

### 3. How Engrene Memory Bridge Solves This

**Engrene Memory Bridge** was engineered specifically as an open, universal standard for multi-agent software engineering:

1. **Universal Interoperability (The Shared Brain)**:
   - Memory Bridge does not belong to any single AI vendor.
   - It creates a standardized `.memory-bridge/` folder in the project root.
   - **Hermes Agent**, **Claude Code**, **Cursor**, **Codex**, **Gemini**, and **Antigravity** all read from and write to the *exact same memory store*.
   - Example: You brainstorm an architecture in Claude Code (`mb-claude post`), implement features with Hermes Agent (`mb-hermes pre`), and debug in Cursor — everyone shares identical, up-to-date context.

2. **Zero Runtime Dependencies & Zero Daemons**:
   - Built on the Node.js standard library (`node:sqlite`, `node:fs`, `node:crypto`). Note that `node:sqlite` ships with Node 22.5+; on Node 20 search falls back to in-memory BM25.
   - Package weight is **110 kB packed, 497 kB unpacked**, with zero runtime dependencies (`npm pack`, v0.4.0).
   - Execution is **stateless**: the CLI runs, reads or writes, and exits. No daemon, so nothing holds RAM between calls.

3. **100% Transparent & Git-Auditable**:
   - Core handoff and context are human-readable Markdown (`handoff.md`, `project-context.md`).
   - Session events and architectural decisions are append-only JSON Lines (`decisions.jsonl`, `sessions/*.jsonl`).
   - Every single decision and task handoff is visible in `git status`, `git diff`, and Pull Requests.

4. **Hybrid Search Without Heavy ML Runtimes**:
   - Uses SQLite's native FTS5 engine for full-text BM25 search.
   - Combines lexical search (SQLite FTS5 BM25) with local vector embeddings through Reciprocal Rank Fusion, with no external service and no Python toolchain. Quality is measured in `docs/benchmarks/`, including where the semantic path underperforms the lexical one.

---

### 4. Direct Architectural Comparison Matrix

| Feature | Hermes Hindsight Plugin | Engrene Memory Bridge |
|---|---|---|
| **Target Audience** | Single-agent Hermes Python ecosystem | Multi-agent universal developer workflows |
| **Cross-Tool Interoperability** | Via Hindsight's own API/SDK per tool | ✅ Any agent that can run a CLI or speak MCP (Hermes, Claude, Cursor, Codex, Gemini, Antigravity, Aider) |
| **Runtime & Dependencies** | Python, `hindsight-all` installed on first use in embedded mode | ✅ Zero runtime dependencies (Node.js standard library; 110 kB packed, 497 kB unpacked) |
| **Background Processes** | ❌ Requires background daemons/ports (`local_embedded`) or API | ✅ 0 daemons (Completely stateless CLI & stdio MCP) |
| **Storage Format** | ❌ Opaque internal database / entity graph in `~/.hermes/` | ✅ Human-readable Markdown (`.md`) + JSONL in repo `.memory-bridge/` |
| **Git & PR Auditing** | ❌ Incompatible with Git reviews | ✅ 100% Git-native, reviewable in `git diff` and PRs |
| **Search Architecture** | Entity graph resolution + dense vectors | SQLite FTS5 (BM25) + dense vector embeddings + RRF |
| **Context Window Consumption** | Dynamic graph traversal (variable token usage) | Ultra-lean, surgical context injection (~30-50 lines) |
| **Secrets & Privacy** | Manual or relies on remote service policies | Proactive automatic redaction of API keys, tokens, and certs |
| **Installation** | `hermes memory setup`, with a lazy install of the Python package on first use | 1-Click: `memory-bridge install hermes` |

---

### 5. What we measured, and what we did not

This comparison is written by the Memory Bridge maintainers, so treat it accordingly and verify anything that matters to you.

- **Measured**: Memory Bridge's own package size, dependency count and retrieval quality. The retrieval numbers are in `docs/benchmarks/`, including the weak spot: on our own fixtures the pure semantic mode reaches P@3 0.315 and R@5 0.676, well below the lexical path.
- **Not measured**: Hindsight's memory footprint, startup time and retrieval quality. We have not benchmarked it head to head. Statements about its runtime come from the Hermes catalog entry, not from our own runs.

**Where Hindsight is likely the better tool**: it captures memory automatically on every turn, while Memory Bridge only records what an agent explicitly logs, so a forgetful agent leaves no trace. It also offers entity-graph retrieval, which we do not have. If you want rich conversational memory inside Hermes, that is its strength.

---

### 6. Can I Use Both?

**Yes.**
* If you enjoy Hermes' entity graph for natural conversation history, you can keep Hindsight enabled in Hermes.
* But for **repository context, architectural decisions, task continuity, and cross-agent collaboration** (switching between Claude Code, Cursor, and Hermes), use **Engrene Memory Bridge** as your project's single source of truth.

To set Memory Bridge as your Hermes memory provider:
```bash
# 1-Click configuration of Hermes MCP and Skill:
memory-bridge install hermes
```
This automatically registers the `memory-bridge` MCP server in `~/.hermes/config.yaml` and deploys the Hermes-compatible skill to `~/.hermes/skills/software-development/memory-bridge/SKILL.md`.


