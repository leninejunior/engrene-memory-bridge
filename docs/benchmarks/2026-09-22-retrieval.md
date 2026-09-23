# Retrieval quality benchmark — 2026-09-22

Issue: #2 "benchmark: evaluate retrieval quality on real-world projects".
Harness: `tests/benchmark/` (`npm run bench`). Raw report: [`2026-09-22-retrieval.json`](./2026-09-22-retrieval.json).

## TL;DR

| variant | P@3 | max P@3 | R@5 | MRR | noise@5 | min noise | superseded leak@3 | stale-session leak@3 | p50 ms | p95 ms |
|---|---|---|---|---|---|---|---|---|---|---|
| `text` (in-memory BM25, default `init`) | 0.537 | 0.574 | 0.972 | 0.944 | 0.667 | 0.656 | **0/6** | 4/6 | 9.43 | 15.43 |
| `text-fts5` (SQLite FTS5, `init --semantic`) | 0.556 | 0.574 | **1.000** | **0.972** | 0.656 | 0.656 | **0/6** | 4/6 | 11.10 | 25.97 |
| `semantic` (local embeddings) | 0.315 | 0.574 | 0.676 | 0.567 | 0.767 | 0.656 | **0/6** | 3/6 | 15.43 | 24.18 |
| `hybrid` (RRF of FTS5 + embeddings) | 0.463 | 0.574 | **1.000** | 0.824 | 0.656 | 0.656 | **0/6** | 4/6 | 12.97 | 19.99 |

- Superseded decisions never surfaced in any mode (0/6 trap queries): the `filterActiveDecisions` filter at query time plus the vector/FTS purge on `decision add --supersedes` work.
- **Sessions logged while an obsolete decision was in force do leak** (4/6 in text, FTS5 and hybrid). For "session cache" the first hit in `text` and `hybrid` is the *Redis* session, not the SQLite migration. This is the main retrieval failure found.
- `resume --for codex` is **377 tokens** (target 300–500, met). `resume --json` is **2512 tokens** (5x over target). `handoff.md` is 413 tokens.
- Rankings were identical across 7 timed runs per query and across two separate invocations (0 unstable queries): the harness is deterministic; only latency moves.

## How it was run

Build, tests and benchmark were executed on a Linux build host inside the official `node:24` Docker image (4 vCPU, 8 GB RAM). They were **not** run on macOS: the developer Mac blocks local builds by policy.

```
node --version          # v24.21.0 (linux/x64), node:sqlite available
npm ci
npm test                # 49 tests, 49 pass, 0 fail (10.3 s)
node dist/tests/benchmark/run.js --runs 7            # text table below (same as `npm run bench -- --runs 7`)
node dist/tests/benchmark/run.js --runs 7 --json     # 2026-09-22-retrieval.json
```

Timings are in-process (`searchMemory()` called directly). They exclude Node start-up of the `memory-bridge` CLI, which is not measured.

## What the harness does

1. Creates a temporary workspace with the same code path as `memory-bridge init --semantic --project-name orbit-crm-benchmark` (`initWorkspace()` from `src/core/config.ts`).
2. Populates it through the public store functions: `appendSessionEvent()` for 31 sessions, `appendDecisionEvent()` for 12 decisions, writes `project-context.md`, builds `handoff.md` exactly like `handoff build` (`buildContextSnapshot()` + `renderHandoffMarkdown()` + `saveHandoff()`), then `indexSemanticFromState()`.
3. Runs 18 labeled queries through `searchMemory()` for each variant. Every query is executed once untimed (warm-up) and then `--runs` times timed.
4. Measures the `resume` footprint with `buildContextSnapshot()` + `renderResumeText()` and the `resume --json` payload as printed by `src/cli/bin.ts`.

Variants map to CLI modes as follows: `text` = `search --mode text` on a workspace **without** `--semantic` (pure in-memory BM25); `text-fts5` = `search --mode text` on a `--semantic` workspace (SQLite FTS5 backend, detected per query via `text_score`; 18/18 queries used FTS5); `semantic` and `hybrid` = `--mode semantic|hybrid`.

### Corpus (synthetic, `tests/benchmark/fixtures/`)

- `sessions.json`: 31 session events from a fictional CRM project across six tools: claude (9), codex (8), qwen (5), hermes (4), antigravity (3), gemini (2), with `taskId`/`parentTaskId` chains. Dates 2026-07-06 … 2026-08-28, i.e. older than the 7-day recency window used by hybrid search, so rankings do not drift with the wall clock.
- `decisions.json`: 12 decisions, 3 of them superseded (`dec-cache-redis` → `dec-cache-sqlite`, `dec-auth-jwt-24h` → `dec-auth-jwt-15m`, `dec-queue-rabbitmq` → `dec-queue-pg`).
- `queries.json`: 18 queries with `expected` refs, `supersededTraps` (obsolete decision must not be in top-3) and `staleTraps` (sessions written under the obsolete decision must not be in top-3). Six queries target superseding decisions.

### Metrics

- **P@3** = relevant hits in top-3 / 3. Most gold sets have 1–2 items, so the attainable ceiling is **max P@3 = 0.574**; compare against it, not against 1.0.
- **R@5** = relevant hits in top-5 / |expected|.
- **MRR** = mean reciprocal rank of the first relevant hit.
- **noise@5** = 1 − relevant hits in top-5 / 5. The floor given the gold sets is **min noise = 0.656**; `text-fts5` and `hybrid` sit exactly on it (every expected item was in the top-5).
- **superseded leak@3** = queries whose top-3 contains a superseded decision / queries with traps.
- **stale-session leak@3** = queries whose top-3 contains a session flagged `staleFor` a superseded decision / queries with traps.
- **latency** = p50/p95 over `queries × runs` samples (18 × 7 = 126 per variant).
- **footprint tokens** = chars / 4 (estimate, not a tokenizer).

## Footprint of `resume`

```
Footprint of `resume --for codex` (target 300-500 tokens, 4 chars/token, build 6.52 ms):
resume (text)      1505 chars  ~  377 tokens  22 lines  (within-target)
resume --json     10047 chars  ~ 2512 tokens  163 lines  (above-target)
handoff.md         1651 chars  ~  413 tokens  35 lines  (within-target)
```

The JSON payload is 6.7x the text because it embeds `snapshot.activeDecisions` (all 9 active decisions with context/decision/impact) and repeats the rendered `resume` string. Agents that read `resume --json` into their prompt pay ~2.5k tokens; the text form stays inside the 300–500 target.

## Failure cases

Aliases: `s03` = claude "Wire Redis as the login session cache" (2026-07-08), `s04` = qwen review of the Redis store (07-09), `s05` = codex "JWT access tokens with a 24 hour lifetime" (07-10), `s07` = codex "RabbitMQ consumer for campaign emails" (07-15), `s18` = claude "Migrate the session cache from Redis to embedded SQLite" (08-04), `s22` = codex "Shorten access tokens to 15 minutes" (08-11), `s23` = qwen review of refresh rotation (08-12), `s25` = gemini auth docs (08-14), `s26` = codex "Replace RabbitMQ with a Postgres job queue" (08-18), `s15` = csv import (07-30), `s17` = dedupe contacts (08-03), `s13` = timezone fix (07-27), `s11` = JSON logging (07-22), `s28` = invoice PDF (08-20).

### Stale sessions outrank the current decision (text, text-fts5, hybrid)

| query | mode | top-5 returned | expected | what went wrong |
|---|---|---|---|---|
| q01 "session cache" | text | **s03**, dec-cache-sqlite, s18, s04, s01 | dec-cache-sqlite, s18 | Redis session ranks #1; an agent reading the top hit adopts the dropped technology. |
| q01 "session cache" | text-fts5 | dec-cache-sqlite, **s03**, s18, s04, s01 | same | Decision correct at #1, obsolete session still #2. |
| q01 "session cache" | hybrid | **s03**, dec-cache-sqlite, s25, s05, s18 | same | Redis session #1, and the JWT sessions (s25, s05) push the SQLite migration to #5. |
| q02 "JWT access token lifetime" | text / text-fts5 / hybrid | **s05**, dec-auth-jwt-15m, s22, … | dec-auth-jwt-15m, s22 | The 24-hour-token session is #1 in all three lexical-backed modes (it literally contains "access token" and "24 hours"). |
| q03 "email job queue" | hybrid | s26, **s07**, s17, dec-queue-pg, s06 | dec-queue-pg, s26 | RabbitMQ session #2, decision pushed to #4. |
| q04 "why was Redis removed" | text / text-fts5 | dec-cache-sqlite, **s04**, s18, s03, s26 | dec-cache-sqlite, s18 | Correct decision first, but the Redis review is #2. |
| q04 "why was Redis removed" | hybrid | **project-context.md**, dec-cache-sqlite, **s04**, s19, s18 | same | The whole project-context document ("no Redis, no RabbitMQ") takes #1. |
| q06 "RabbitMQ consumer crashes on broker restart" | text / text-fts5 | dec-queue-pg, s26, **s07**, project-context.md, s27 | dec-queue-pg | Correct at #1; obsolete consumer session #3. |

Root cause: `supersedes` only demotes **decisions**. Session events are never re-evaluated when a decision is superseded, and they carry the strongest lexical signal (intent + summary + tags all mention the old technology). Nothing in the schema links a session to the decision it implemented.

### Semantic-only mode misses out-of-vocabulary queries

| query | top-5 (semantic) | expected | note |
|---|---|---|---|
| q01 "session cache" | s25, s05, s22, s03, dec-auth-jwt-15m | dec-cache-sqlite, s18 | "session" activates the `auth` concept cluster; every hit is about tokens/login. Recall 0. |
| q04 "why was Redis removed" | project-context.md, s19, dec-i18n-icu, dec-webhook-retry, s08 | dec-cache-sqlite, s18 | No cluster covers "redis"/"removed"; only trigram noise remains. Recall 0. |
| q06 "RabbitMQ consumer crashes on broker restart" | dec-webhook-retry, s23, s30, dec-i18n-icu, s04 | dec-queue-pg | "crashes" activates the `error` cluster, which matches the webhook decision instead. |
| q10 "reminders fired at the wrong hour timezone" | s09, s26, s29, s15, dec-queue-pg | s13 | Recall 0. |
| q03, q05, q08, q13 | — | — | Partial misses (recall 0.5–0.67), see the JSON report. |

Root cause: `embedLocalDense()` in `src/core/vector.ts` is a hand-built vector (8 concept clusters + hashed character trigrams + hashed words). It has no notion of the project's own vocabulary, so it is only reliable when the query and the document share one of the eight clusters. Hybrid mode recovers full recall through RRF, but pays in MRR (0.824 vs 0.972 for FTS5 alone).

### Whole-document entries are a noise source in hybrid

`handoff.md` and `project-context.md` are indexed as single documents. In `hybrid` they reach the top-3 of 6/18 queries (q04, q06, q07, q08, q12, q14) and are #1 for q04 and q06: a long document that mentions many topics scores in both the lexical and the semantic list, and RRF rewards presence in both. In `text` modes they appear at #2–#5 for q02, q03, q06, q07, q08, q09, q14 (`handoff.md` is #2 for q03 in `text`).

### One gold-set miss in `text`

q11 "csv import contacts" (text): top-5 = s15, s29, s30, s02, s09; the dedupe session `s17` is missing. `s17` shares only the token "contacts" with the query; it is included in the gold set as a "related follow-up" and is arguably a stretch. FTS5, semantic and hybrid all return it.

## Observations that are not failures

- `text` vs `text-fts5`: FTS5 is slightly better (R@5 1.000 vs 0.972, MRR 0.972 vs 0.944) for about +2 ms p50. Note a sharp edge: on a `--semantic` workspace `search --mode text` uses FTS5 only once the SQLite index exists, and only `semantic`/`hybrid` searches build it lazily. Until the first hybrid search, `--mode text` silently runs in-memory BM25. The harness calls `indexSemanticFromState()` explicitly to make this deterministic.
- Latency: 9–16 ms p50 and 15–26 ms p95 in-process for 31 sessions + 12 decisions. Every `searchMemory()` call re-reads all JSONL files, re-opens SQLite and, with semantic enabled, re-issues `DELETE` statements for every superseded id. Fine at this size; worth watching as corpora grow.
- `resume` build time: 6.5 ms.

## Not covered

- **Real-world handoff cases (Claude → Codex → Qwen / Hermes / Antigravity) were NOT collected.** This requires actual usage data from users' `.memory-bridge/` directories, which is private and was not available for this run. The corpus here is synthetic and was written to mimic such handoffs (tool chains, `parentTaskId` links, reviews by a second tool, decisions superseded weeks later). The failure modes found are structural (schema and ranking), so they will reproduce on real data, but the numbers above are not real-world numbers.
- CLI process latency (spawning `memory-bridge search`) is not measured; only the in-process search.
- The recency boost of hybrid search is not exercised (all fixtures are older than 7 days by design, for determinism).
- Encryption and custom redaction patterns are not benchmarked (default config: redaction on, encryption off).
- Tokens are estimated as chars / 4, not counted with a tokenizer.
- Not run on macOS or on Node 20. On Node 20 `node:sqlite` is missing, so `text-fts5`, `semantic` and `hybrid` fall back to in-memory BM25; the harness records this in `sqliteSupported` and in per-query `warnings`.

### Feeding the harness with your own `.memory-bridge/`

```
# 1. Write labeled queries for your project. Refs are the values `search --json` prints:
#    "decision:<id>", "session:<ts>", "handoff.md", "project-context.md".
cat > my-queries.json <<'EOF'
[
  {
    "id": "q01",
    "query": "session store",
    "expected": ["decision:dec-abc123", "session:2026-09-01T10:00:00.000Z"],
    "supersededTraps": ["decision:dec-old456"],
    "staleTraps": ["session:2026-08-20T09:00:00.000Z"]
  }
]
EOF

# 2. Run against the workspace (nothing is written to it except the SQLite index a normal search would build).
npm run bench -- --workspace /path/to/your/repo --queries my-queries.json --runs 5

# 3. Machine-readable output for comparison between versions:
npm run bench -- --workspace /path/to/your/repo --queries my-queries.json --json > my-report.json
```

Only the variants supported by the workspace config run (`semantic`/`hybrid`/`text-fts5` need `memory-bridge init --semantic`); the others are reported as skipped. Queries and reports contain your memory content: keep them private unless you have scrubbed them.

## Issue #2 checklist status

- [ ] Collect real-world usage cases of tool context handoffs — **not done** (needs real user data; see above).
- [x] Record when agents recover the correct context vs when retrieval misses — done on synthetic fixtures (`missing`, `recallAt5`, per-query hit lists in the JSON report).
- [x] Measure if obsolete / superseded decisions appear inappropriately — done: 0/6 leaks for decisions, 3–4/6 for stale sessions.
- [x] Evaluate noise level, retrieval latency and context window footprint — done: `noiseAt5` (with its floor), p50/p95, `resume` chars/tokens vs the 300–500 target.
- [x] Transform failure cases into reproducible benchmark fixtures — done: `tests/benchmark/fixtures/*.json` plus `tests/integration/benchmark-harness.test.ts`, which runs the harness in `npm test`.

## Verbatim harness output

```
memory-bridge retrieval benchmark  (2026-09-23T02:04:31.564Z)
node v24.21.0 linux/x64  node:sqlite=yes  source=fixtures
corpus: 31 sessions (antigravity, claude, codex, gemini, hermes, qwen), 12 decisions (3 supersedes links, 3 superseded), 18 queries, 7 timed run(s)/query, limit 5

variant    |    P@3 |  maxP@3 |    R@5 |    MRR |  noise@5 | minNoise |  sup.leak@3 |  stale@3 |   p50 ms |   p95 ms |  warn | unstable
-----------+--------+---------+--------+--------+----------+----------+-------------+----------+----------+----------+-------+---------
text       |  0.537 |   0.574 |  0.972 |  0.944 |    0.667 |    0.656 |         0/6 |      4/6 |     9.43 |    15.43 |     0 |        0
text-fts5  |  0.556 |   0.574 |  1.000 |  0.972 |    0.656 |    0.656 |         0/6 |      4/6 |    11.10 |    25.97 |     0 |        0
semantic   |  0.315 |   0.574 |  0.676 |  0.567 |    0.767 |    0.656 |         0/6 |      3/6 |    15.43 |    24.18 |     0 |        0
hybrid     |  0.463 |   0.574 |  1.000 |  0.824 |    0.656 |    0.656 |         0/6 |      4/6 |    12.97 |    19.99 |     0 |        0

Footprint of `resume --for codex` (target 300-500 tokens, 4 chars/token, build 6.52 ms):
resume (text)      1505 chars  ~  377 tokens  22 lines  (within-target)
resume --json     10047 chars  ~ 2512 tokens  163 lines  (above-target)
handoff.md         1651 chars  ~  413 tokens  35 lines  (within-target)
```

The full failure-case listing (every variant, every query with a miss or a leak) is in the JSON report under `variants[].queries[]`.
