import fs from "node:fs/promises";
import type { Dirent } from "node:fs";
import path from "node:path";

import { parseJsonLine } from "./schema.js";

export interface JsonlReadResult {
  records: unknown[];
  warnings: string[];
}

function nowMs(): number {
  return Date.now();
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function exists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

export async function ensureDirSecure(dirPath: string): Promise<void> {
  await fs.mkdir(dirPath, { recursive: true, mode: 0o700 });
}

export async function ensureFile(filePath: string, initialContent: string, mode = 0o600): Promise<void> {
  if (await exists(filePath)) {
    return;
  }
  await ensureDirSecure(path.dirname(filePath));
  await atomicWriteFile(filePath, initialContent, mode);
}

export async function readText(filePath: string): Promise<string | undefined> {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

export async function atomicWriteFile(filePath: string, content: string, mode = 0o600): Promise<void> {
  await ensureDirSecure(path.dirname(filePath));
  const tempPath = `${filePath}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  await fs.writeFile(tempPath, content, { encoding: "utf8", mode });
  try {
    await fs.rename(tempPath, filePath);
  } catch (error) {
    if (process.platform === "win32") {
      await fs.copyFile(tempPath, filePath);
      await fs.unlink(tempPath).catch(() => {});
    } else {
      throw error;
    }
  }
  if (process.platform !== "win32") {
    await fs.chmod(filePath, mode).catch(() => {});
  }
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function checkAndBreakStaleLock(lockPath: string, staleMs = 15000): Promise<boolean> {
  try {
    const content = await fs.readFile(lockPath, "utf8");
    const [pidStr, tsStr] = content.trim().split(":");
    const pid = Number(pidStr);
    const ts = Number(tsStr);
    const now = Date.now();

    const isStaleByTime = !Number.isNaN(ts) && now - ts > staleMs;
    const isProcessDead = !Number.isNaN(pid) && pid > 0 && !isPidAlive(pid);

    if (isStaleByTime || isProcessDead) {
      await fs.unlink(lockPath).catch(() => {});
      return true;
    }
  } catch {
    // Lock removed or inaccessible in race condition
  }
  return false;
}

export async function withLock<T>(
  lockPath: string,
  fn: () => Promise<T>,
  timeoutMs = 15000
): Promise<T> {
  await ensureDirSecure(path.dirname(lockPath));
  const startedAt = nowMs();
  // Simple lockfile with PID and timestamp verification for cross-process safety
  while (true) {
    try {
      const handle = await fs.open(lockPath, "wx", 0o600);
      try {
        await handle.writeFile(`${process.pid}:${Date.now()}\n`, "utf8");
        return await fn();
      } finally {
        await handle.close();
        await fs.unlink(lockPath).catch(() => {
          // Ignore unlock errors from race conditions.
        });
      }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EEXIST" && code !== "EPERM") {
        throw error;
      }
      // Inspect existing lock for dead process or stale timestamp
      await checkAndBreakStaleLock(lockPath, timeoutMs);

      if (nowMs() - startedAt > timeoutMs) {
        throw new Error(`Timed out waiting for lock: ${lockPath}`);
      }
      await sleep(25 + Math.floor(Math.random() * 35));
    }
  }
}

export async function appendJsonlAtomic(filePath: string, line: string, lockPath: string): Promise<void> {
  await withLock(lockPath, async () => {
    await ensureDirSecure(path.dirname(filePath));
    const formatted = line.endsWith("\n") ? line : `${line}\n`;
    await fs.appendFile(filePath, formatted, { encoding: "utf8", mode: 0o600 });
    if (process.platform !== "win32") {
      await fs.chmod(filePath, 0o600).catch(() => {});
    }
  });
}

export async function readJsonFile<T>(filePath: string): Promise<T | undefined> {
  const text = await readText(filePath);
  if (text === undefined || text.trim() === "") {
    return undefined;
  }
  return JSON.parse(text) as T;
}

export async function writeJsonFile(filePath: string, payload: unknown, lockPath?: string): Promise<void> {
  const content = `${JSON.stringify(payload, null, 2)}\n`;
  if (!lockPath) {
    await atomicWriteFile(filePath, content, 0o600);
    return;
  }
  await withLock(lockPath, async () => {
    await atomicWriteFile(filePath, content, 0o600);
  });
}

export async function readJsonl(filePath: string): Promise<JsonlReadResult> {
  const text = await readText(filePath);
  if (!text || text.trim() === "") {
    return { records: [], warnings: [] };
  }

  const lines = text.split(/\r?\n/).filter((line) => line.trim() !== "");
  const records: unknown[] = [];
  const warnings: string[] = [];
  for (const [index, line] of lines.entries()) {
    try {
      records.push(parseJsonLine(line));
    } catch {
      warnings.push(`Invalid JSONL at ${filePath}:${index + 1}`);
    }
  }
  return { records, warnings };
}

export function sessionFileForDate(sessionsDir: string, date = new Date()): string {
  const day = date.toISOString().slice(0, 10);
  return path.join(sessionsDir, `${day}.jsonl`);
}

export async function listSessionFiles(sessionsDir: string): Promise<string[]> {
  if (!(await exists(sessionsDir))) {
    return [];
  }
  const items = await fs.readdir(sessionsDir, { withFileTypes: true });
  return items
    .filter((entry: Dirent) => entry.isFile() && entry.name.endsWith(".jsonl"))
    .map((entry: Dirent) => path.join(sessionsDir, entry.name))
    .sort((a: string, b: string) => a.localeCompare(b));
}
