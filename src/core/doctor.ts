import fs from "node:fs/promises";
import path from "node:path";

import type { BridgeConfig, DoctorResult } from "../types/events.js";
import { encryptionReady } from "./crypto.js";
import { listSessionFiles, readText } from "./fs-utils.js";
import { resolveBridgePaths } from "./paths.js";
import { detectLeakageRisk } from "./redaction.js";

function addCheck(result: DoctorResult, check: DoctorResult["checks"][number]): void {
  result.checks.push(check);
  if (!check.ok && check.severity === "error") {
    result.ok = false;
  }
}

async function statMode(filePath: string): Promise<number | undefined> {
  try {
    const stat = await fs.stat(filePath);
    return stat.mode;
  } catch {
    return undefined;
  }
}

function permissionIsStrict(mode: number): boolean {
  if (process.platform === "win32") {
    return true;
  }
  return (mode & 0o077) === 0;
}

async function scanLeakRisks(filePath: string): Promise<string[]> {
  const text = await readText(filePath);
  if (!text) {
    return [];
  }
  return detectLeakageRisk(text);
}

export async function runDoctor(workspace: string, config: BridgeConfig): Promise<DoctorResult> {
  const paths = resolveBridgePaths(path.resolve(workspace));
  const result: DoctorResult = { ok: true, checks: [] };

  const requiredPaths = [
    paths.root,
    paths.configFile,
    paths.projectContextFile,
    paths.decisionsFile,
    paths.sessionsDir,
    paths.handoffFile
  ];

  for (const requiredPath of requiredPaths) {
    const mode = await statMode(requiredPath);
    addCheck(result, {
      name: `exists:${path.basename(requiredPath)}`,
      ok: mode !== undefined,
      severity: mode !== undefined ? "info" : "error",
      message: mode !== undefined ? "ok" : `Missing: ${requiredPath}`
    });

    if (mode !== undefined) {
      addCheck(result, {
        name: `permissions:${path.basename(requiredPath)}`,
        ok: permissionIsStrict(mode),
        severity: permissionIsStrict(mode) ? "info" : "warn",
        message: permissionIsStrict(mode)
          ? "strict-permissions"
          : "Permissions allow group/others access; use chmod 600 (files) / 700 (dirs)."
      });
    }
  }

  addCheck(result, {
    name: "redaction-enabled",
    ok: config.redaction.enabled,
    severity: config.redaction.enabled ? "info" : "warn",
    message: config.redaction.enabled ? "redaction-active" : "Redaction disabled. Secrets may leak to memory files."
  });

  if (config.encryption.enabled) {
    addCheck(result, {
      name: "encryption-key-ready",
      ok: encryptionReady(config),
      severity: encryptionReady(config) ? "info" : "error",
      message: encryptionReady(config)
        ? `encryption-active (${config.encryption.keyEnvVar})`
        : `Set ${config.encryption.keyEnvVar} to read/write encrypted records.`
    });
  } else {
    addCheck(result, {
      name: "encryption-mode",
      ok: true,
      severity: "info",
      message: "Encryption disabled (optional local-first mode)."
    });
  }

  const filesToScan = [paths.decisionsFile, paths.handoffFile, paths.projectContextFile];
  const sessionFiles = await listSessionFiles(paths.sessionsDir);
  filesToScan.push(...sessionFiles.slice(-10));

  let leakageCount = 0;
  for (const filePath of filesToScan) {
    const findings = await scanLeakRisks(filePath);
    if (findings.length > 0) {
      leakageCount += findings.length;
      addCheck(result, {
        name: `leak-risk:${path.basename(filePath)}`,
        ok: false,
        severity: "warn",
        message: `Potential secret patterns found: ${Array.from(new Set(findings)).join(", ")}`
      });
    }
  }

  if (leakageCount === 0) {
    addCheck(result, {
      name: "leak-risk",
      ok: true,
      severity: "info",
      message: "No obvious secret patterns found in scanned memory files."
    });
  }

  return result;
}
