import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { initWorkspace } from "../../src/core/config.js";
import {
  cosineSimilarity,
  embedLocalDense,
  ftsSearch,
  semanticSearch,
  upsertSemanticDoc
} from "../../src/core/vector.js";
import { rrfFusion } from "../../src/core/search.js";

test("embedLocalDense captures conceptual similarity without exact word match", () => {
  const query = embedLocalDense("problema de login", 256);
  const docAuthFailure = embedLocalDense("falha na autenticacao do usuario", 256);
  const docPostgres = embedLocalDense("configuracao de porta do banco de dados postgres", 256);
  const docCssTheme = embedLocalDense("atualizacao de estilos css do tema escuro", 256);

  const simAuth = cosineSimilarity(query, docAuthFailure);
  const simDb = cosineSimilarity(query, docPostgres);
  const simCss = cosineSimilarity(query, docCssTheme);

  // Conceptual match must be significantly higher than unrelated domains
  assert.ok(
    simAuth > simDb,
    `Auth similarity (${simAuth.toFixed(4)}) should be higher than DB similarity (${simDb.toFixed(4)})`
  );
  assert.ok(
    simAuth > simCss,
    `Auth similarity (${simAuth.toFixed(4)}) should be higher than CSS similarity (${simCss.toFixed(4)})`
  );
  assert.ok(simAuth > 0.75, `Auth similarity (${simAuth.toFixed(4)}) should exceed 0.75`);
});

test("semanticSearch and ftsSearch in SQLite vector database", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "mb-vector-real-"));

  try {
    const { config } = await initWorkspace({
      workspace: tmpDir,
      enableSemanticSearch: true
    });

    config.semanticSearch.enabled = true;
    config.semanticSearch.provider = "local";

    await upsertSemanticDoc(tmpDir, config, {
      id: "doc-1",
      source: "decisions",
      ts: new Date().toISOString(),
      text: "Investigamos e corrigimos uma falha grave na autenticação do usuário com token expirado.",
      memory_type: "decision"
    });

    await upsertSemanticDoc(tmpDir, config, {
      id: "doc-2",
      source: "sessions",
      ts: new Date().toISOString(),
      text: "Otimizamos a consulta SQL no banco de dados Postgres para melhorar a latência.",
      memory_type: "episodic"
    });

    await upsertSemanticDoc(tmpDir, config, {
      id: "doc-3",
      source: "handoff",
      ts: new Date().toISOString(),
      text: "Ajustamos a interface visual com CSS para o modo escuro no dashboard web.",
      memory_type: "working"
    });

    // 1. Semantic Search with synonyms (no exact word match)
    const semHits = await semanticSearch(tmpDir, config, "problema de login", 3);
    assert.ok(semHits.length > 0, "Semantic search should return results");
    assert.equal(semHits[0]?.ref, "doc-1", "Conceptual match should rank first for 'problema de login'");
    assert.ok((semHits[0]?.score ?? 0) > 0.7, "Top match should have high semantic score");

    // 2. FTS5 Search with keywords
    const ftsHits = await ftsSearch(tmpDir, config, "Postgres SQL", 3);
    assert.ok(ftsHits.length > 0, "FTS search should return results for keyword");
    assert.equal(ftsHits[0]?.ref, "doc-2", "FTS match should rank 'doc-2' first for 'Postgres SQL'");
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test("rrfFusion correctly combines text and semantic hits with recency", () => {
  const textHits = [
    { source: "sessions" as const, score: 5.0, ref: "doc-a", snippet: "Doc A exact match" },
    { source: "decisions" as const, score: 2.0, ref: "doc-b", snippet: "Doc B text match" }
  ];

  const semanticHits = [
    {
      source: "decisions" as const,
      score: 0.95,
      ref: "doc-b",
      snippet: "Doc B concept match",
      ts: new Date().toISOString()
    },
    { source: "sessions" as const, score: 0.85, ref: "doc-c", snippet: "Doc C concept match" }
  ];

  const fused = rrfFusion(textHits, semanticHits, 60, 5);

  assert.equal(fused.length, 3);
  // Doc B appeared in both lists (rank 2 in text + rank 1 in semantic) -> high composite RRF score
  assert.equal(fused[0]?.ref, "doc-b", "Doc B appearing in both rankings should fuse to top position");
  assert.ok(fused[0]?.text_score !== undefined);
  assert.ok(fused[0]?.semantic_score !== undefined);
  assert.ok((fused[0]?.recency_score ?? 0) > 0);
});
