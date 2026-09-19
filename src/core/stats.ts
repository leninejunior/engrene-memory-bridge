import fs from "node:fs/promises";
import path from "node:path";

import type { BridgeConfig } from "../types/events.js";
import { listObservationFiles, readObservations } from "./capture.js";
import { exists } from "./fs-utils.js";
import { resolveBridgePaths } from "./paths.js";
import { readDecisionEvents, readSessionEvents } from "./store.js";

export interface MemoryStats {
  workspace: string;
  projectName: string;
  totalSessions: number;
  totalDecisions: number;
  activeDecisions: number;
  supersededDecisions: number;
  pendingObservations: number;
  diskSizeBytes: number;
  oldestEventTs?: string | undefined;
  newestEventTs?: string | undefined;
  vectorDocsCount: number;
}

async function getDirSizeBytes(dirPath: string): Promise<number> {
  let total = 0;
  try {
    const entries = await fs.readdir(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dirPath, entry.name);
      if (entry.isDirectory()) {
        total += await getDirSizeBytes(fullPath);
      } else if (entry.isFile()) {
        const stat = await fs.stat(fullPath);
        total += stat.size;
      }
    }
  } catch {
    // Ignore access error
  }
  return total;
}

export async function getMemoryStats(workspace: string, config: BridgeConfig): Promise<MemoryStats> {
  const normalized = path.resolve(workspace);
  const paths = resolveBridgePaths(normalized);

  const [sessionsRes, decisionsRes, obsEvents, diskSize] = await Promise.all([
    readSessionEvents(normalized, config, 5000),
    readDecisionEvents(normalized, config, 5000),
    readObservations(normalized, 100),
    getDirSizeBytes(paths.root)
  ]);

  const supersededSet = new Set<string>();
  for (const dec of decisionsRes.events) {
    for (const sup of dec.supersedes) {
      supersededSet.add(sup);
    }
  }

  const activeCount = decisionsRes.events.filter((d) => !supersededSet.has(d.id)).length;
  const supersededCount = decisionsRes.events.length - activeCount;

  const allTimestamps = [
    ...sessionsRes.events.map((e) => e.ts),
    ...decisionsRes.events.map((d) => d.ts)
  ].filter(Boolean).sort();

  let vectorDocs = 0;
  if (await exists(paths.vectorDbFile)) {
    try {
      const sqliteModule = await import("node:sqlite");
      const db = new sqliteModule.DatabaseSync(paths.vectorDbFile);
      const row = db.prepare("SELECT COUNT(*) as count FROM docs").all()[0] as { count: number } | undefined;
      vectorDocs = Number(row?.count ?? 0);
      db.close();
    } catch {
      // Ignore database access error
    }
  }

  return {
    workspace: normalized,
    projectName: config.projectName,
    totalSessions: sessionsRes.events.length,
    totalDecisions: decisionsRes.events.length,
    activeDecisions: activeCount,
    supersededDecisions: supersededCount,
    pendingObservations: obsEvents.length,
    diskSizeBytes: diskSize,
    oldestEventTs: allTimestamps[0],
    newestEventTs: allTimestamps[allTimestamps.length - 1],
    vectorDocsCount: vectorDocs
  };
}
