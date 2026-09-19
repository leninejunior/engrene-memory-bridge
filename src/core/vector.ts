import { createHash } from "node:crypto";
import path from "node:path";

import type { BridgeConfig, SearchHit } from "../types/events.js";
import { resolveBridgePaths } from "./paths.js";

export interface SemanticDoc {
  id: string;
  source: string;
  ts: string;
  text: string;
  ref?: string;
  memory_type?: string;
}

const CONCEPT_CLUSTERS: Array<{ name: string; weight: number; terms: string[] }> = [
  {
    name: "auth",
    weight: 4.0,
    terms: [
      "login",
      "logon",
      "signin",
      "auth",
      "autenticacao",
      "autentica",
      "autenticar",
      "credential",
      "credencial",
      "senha",
      "password",
      "token",
      "session",
      "sessao",
      "jwt",
      "oauth",
      "user",
      "usuario"
    ]
  },
  {
    name: "error",
    weight: 3.5,
    terms: [
      "falha",
      "erro",
      "error",
      "bug",
      "problema",
      "problem",
      "issue",
      "crash",
      "exception",
      "failure",
      "failed",
      "quebrado",
      "broken",
      "timeout"
    ]
  },
  {
    name: "db",
    weight: 3.5,
    terms: [
      "banco",
      "database",
      "db",
      "sqlite",
      "postgres",
      "sql",
      "tabela",
      "table",
      "query",
      "storage",
      "persist",
      "persistencia",
      "fts5"
    ]
  },
  {
    name: "network",
    weight: 3.0,
    terms: [
      "api",
      "endpoint",
      "request",
      "response",
      "http",
      "https",
      "url",
      "route",
      "fetch",
      "conexao",
      "network",
      "socket",
      "server",
      "servidor"
    ]
  },
  {
    name: "ui",
    weight: 3.0,
    terms: [
      "ui",
      "interface",
      "dashboard",
      "css",
      "html",
      "tema",
      "theme",
      "dark",
      "light",
      "visual",
      "tela",
      "frontend",
      "front",
      "browser",
      "navegador"
    ]
  },
  {
    name: "vcs",
    weight: 3.0,
    terms: ["git", "branch", "commit", "merge", "push", "pull", "pr", "remote", "repositorio", "repo", "diff"]
  },
  {
    name: "security",
    weight: 3.5,
    terms: [
      "secret",
      "segredo",
      "crypto",
      "criptografia",
      "redact",
      "redacao",
      "protect",
      "key",
      "chave",
      "privacy",
      "privacidade",
      "permission",
      "permissao"
    ]
  },
  {
    name: "build_test",
    weight: 3.0,
    terms: [
      "teste",
      "test",
      "unit",
      "integration",
      "build",
      "compile",
      "compilar",
      "lint",
      "clean",
      "dist",
      "release",
      "publish",
      "package"
    ]
  }
];

function normalizeSemanticText(input: string): string {
  return input
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9\s_-]+/g, " ")
    .trim();
}

export function embedLocalDense(text: string, dimensions = 256): number[] {
  const norm = normalizeSemanticText(text);
  const words = norm.split(/\s+/).filter((w) => w.length > 1);
  const vec = new Float64Array(dimensions);

  if (words.length === 0) {
    return Array.from(vec);
  }

  // 1. Semantic Concept Cluster Activations (dimensions 0..127)
  CONCEPT_CLUSTERS.forEach((cluster, cIdx) => {
    let matchCount = 0;
    for (const word of words) {
      if (cluster.terms.some((t) => word.includes(t) || t.includes(word))) {
        matchCount += 1;
      }
    }
    if (matchCount > 0) {
      const startDim = (cIdx * 16) % 128;
      for (let i = 0; i < 16; i += 1) {
        const target = startDim + i;
        vec[target] = (vec[target] ?? 0) + matchCount * cluster.weight;
      }
    }
  });

  // 2. Subword Character 3-grams for morphological root matching (dimensions 128..191)
  for (const word of words) {
    for (let i = 0; i < word.length - 2; i += 1) {
      const gram = word.slice(i, i + 3);
      let hash = 0;
      for (let j = 0; j < gram.length; j += 1) {
        hash = (hash * 31 + gram.charCodeAt(j)) & 0xffffffff;
      }
      const dim = 128 + (Math.abs(hash) % 64);
      vec[dim] = (vec[dim] ?? 0) + 0.5;
    }
  }

  // 3. Word Token Projections (dimensions 192..255)
  for (const word of words) {
    let hash = 0;
    for (let j = 0; j < word.length; j += 1) {
      hash = (hash * 37 + word.charCodeAt(j)) & 0xffffffff;
    }
    const dim = 192 + (Math.abs(hash) % 64);
    vec[dim] = (vec[dim] ?? 0) + 1.0;
  }

  // L2 Normalization (Unit Sphere)
  let sumSq = 0;
  for (let i = 0; i < dimensions; i += 1) {
    const val = vec[i] ?? 0;
    sumSq += val * val;
  }
  const magnitude = Math.sqrt(sumSq) || 1;
  return Array.from(vec).map((val) => val / magnitude);
}

export async function generateEmbedding(text: string, config: BridgeConfig): Promise<number[]> {
  const dimensions = config.semanticSearch.dimensions || 256;
  const provider = config.semanticSearch.provider || "local";

  if (provider === "openai-compatible" || provider === "ollama") {
    const endpoint = config.semanticSearch.endpoint || "http://localhost:11434/api/embeddings";
    const model = config.semanticSearch.model || "all-minilm";
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 2000);
      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model, prompt: text, input: text }),
        signal: controller.signal
      });
      clearTimeout(timeoutId);
      if (res.ok) {
        const json = (await res.json()) as any;
        const rawVec: number[] | undefined = json.embedding ?? json.data?.[0]?.embedding;
        if (Array.isArray(rawVec) && rawVec.length > 0) {
          const sumSq = rawVec.reduce((acc, v) => acc + v * v, 0);
          const norm = Math.sqrt(sumSq) || 1;
          return rawVec.map((v) => v / norm);
        }
      }
    } catch {
      // Fallback to local dense embedding on timeout or connection error
    }
  }

  return embedLocalDense(text, dimensions);
}

export function cosineSimilarity(a: number[], b: number[]): number {
  const len = Math.min(a.length, b.length);
  let dot = 0;
  for (let i = 0; i < len; i += 1) {
    dot += a[i]! * b[i]!;
  }
  return dot;
}

interface SqliteDbLike {
  exec: (sql: string) => void;
  prepare: (sql: string) => {
    run: (...args: any[]) => unknown;
    all: (...args: any[]) => unknown[];
  };
  close: () => void;
}

export async function isSqliteSupported(): Promise<boolean> {
  try {
    const sqliteModule = await import("node:sqlite");
    return typeof (sqliteModule as any).DatabaseSync === "function";
  } catch {
    return false;
  }
}

async function openDb(dbPath: string): Promise<SqliteDbLike | null> {
  try {
    const sqliteModule = await import("node:sqlite");
    const DatabaseSyncCtor = (sqliteModule as any).DatabaseSync;
    if (!DatabaseSyncCtor) {
      return null;
    }
    const db = new DatabaseSyncCtor(dbPath);

    // Initialize both dense vector table and FTS5 full-text search table
    db.exec(`
      CREATE TABLE IF NOT EXISTS docs (
        id TEXT PRIMARY KEY,
        source TEXT NOT NULL,
        ts TEXT NOT NULL,
        ref TEXT,
        text TEXT NOT NULL,
        vector TEXT NOT NULL,
        memory_type TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_docs_ts ON docs(ts DESC);
      CREATE VIRTUAL TABLE IF NOT EXISTS fts_docs USING fts5(
        id UNINDEXED,
        source,
        ts,
        ref,
        text,
        memory_type,
        tokenize='unicode61'
      );
    `);

    // Schema migration: ensure memory_type exists on older sqlite files
    try {
      db.exec("ALTER TABLE docs ADD COLUMN memory_type TEXT;");
    } catch {
      // Column already exists
    }

    return db;
  } catch {
    return null;
  }
}

export function semanticEnabled(config: BridgeConfig): boolean {
  return Boolean(config.semanticSearch.enabled && config.semanticSearch.provider !== "disabled");
}

export async function upsertSemanticDoc(
  workspace: string,
  config: BridgeConfig,
  doc: SemanticDoc
): Promise<void> {
  if (!semanticEnabled(config)) {
    return;
  }
  const paths = resolveBridgePaths(path.resolve(workspace));
  const db = await openDb(paths.vectorDbFile);
  if (!db) {
    return;
  }
  try {
    const vector = await generateEmbedding(doc.text, config);
    db.prepare(
      `
      INSERT INTO docs (id, source, ts, ref, text, vector, memory_type)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        source = excluded.source,
        ts = excluded.ts,
        ref = excluded.ref,
        text = excluded.text,
        vector = excluded.vector,
        memory_type = excluded.memory_type
    `
    ).run(
      doc.id,
      doc.source,
      doc.ts,
      doc.ref ?? null,
      doc.text,
      JSON.stringify(vector),
      doc.memory_type ?? "episodic"
    );

    // Sync into FTS5 virtual table
    db.prepare("DELETE FROM fts_docs WHERE id = ?").run(doc.id);
    db.prepare(
      `
      INSERT INTO fts_docs (id, source, ts, ref, text, memory_type)
      VALUES (?, ?, ?, ?, ?, ?)
    `
    ).run(doc.id, doc.source, doc.ts, doc.ref ?? null, doc.text, doc.memory_type ?? "episodic");
  } finally {
    db.close();
  }
}

export async function semanticSearch(
  workspace: string,
  config: BridgeConfig,
  query: string,
  limit: number
): Promise<SearchHit[]> {
  if (!semanticEnabled(config)) {
    return [];
  }
  const paths = resolveBridgePaths(path.resolve(workspace));
  const db = await openDb(paths.vectorDbFile);
  if (!db) {
    return [];
  }
  try {
    const queryVector = await generateEmbedding(query, config);
    const rows = db
      .prepare("SELECT id, source, ts, ref, text, vector, memory_type FROM docs ORDER BY ts DESC LIMIT 1000")
      .all() as Array<{
      id: string;
      source: string;
      ts: string;
      ref: string | null;
      text: string;
      vector: string;
      memory_type: string | null;
    }>;

    return rows
      .map((row) => {
        const parsed = JSON.parse(row.vector) as number[];
        const score = cosineSimilarity(queryVector, parsed);
        return {
          source: (row.source as SearchHit["source"]) || "semantic",
          score,
          ts: row.ts,
          ref: row.ref ?? row.id,
          snippet: row.text.slice(0, 240),
          semantic_score: score
        };
      })
      .sort((a, b) => b.score - a.score)
      .slice(0, Math.max(1, limit));
  } finally {
    db.close();
  }
}

export async function ftsSearch(
  workspace: string,
  config: BridgeConfig,
  query: string,
  limit: number
): Promise<SearchHit[]> {
  if (!semanticEnabled(config)) {
    return [];
  }
  const paths = resolveBridgePaths(path.resolve(workspace));
  const db = await openDb(paths.vectorDbFile);
  if (!db) {
    return [];
  }
  try {
    const sanitized = query
      .replace(/[^a-zA-Z0-9_\s]/g, " ")
      .trim()
      .split(/\s+/)
      .filter(Boolean)
      .join(" OR ");

    if (!sanitized) {
      return [];
    }

    const rows = db
      .prepare(
        `SELECT id, source, ts, ref, text, bm25(fts_docs) as rank
         FROM fts_docs
         WHERE fts_docs MATCH ?
         ORDER BY rank
         LIMIT ?`
      )
      .all(sanitized, Math.max(1, limit)) as Array<{
      id: string;
      source: string;
      ts: string;
      ref: string | null;
      text: string;
      rank: number;
    }>;

    return rows.map((row) => {
      // BM25 rank in SQLite is negative (lower = more relevant)
      const normalizedScore = Math.max(0.1, 1 / (1 + Math.abs(row.rank)));
      return {
        source: (row.source as SearchHit["source"]) || "sessions",
        score: normalizedScore,
        ts: row.ts,
        ref: row.ref ?? row.id,
        snippet: row.text.slice(0, 240),
        text_score: normalizedScore
      };
    });
  } catch {
    return [];
  } finally {
    db.close();
  }
}
