import path from "node:path";
import type { BridgeConfig, DecisionEvent, SessionEvent } from "../types/events.js";
import { decryptJsonIfNeeded } from "./crypto.js";
import { listSessionFiles, readJsonl, readText } from "./fs-utils.js";
import { resolveBridgePaths } from "./paths.js";
import { detectLeakageRisk } from "./redaction.js";
import { validateDecisionEvent, validateSessionEvent } from "./schema.js";

export interface LintResult {
  ok: boolean;
  errors: string[];
  warnings: string[];
  stats: {
    sessionCount: number;
    decisionCount: number;
    sessionFilesCount: number;
  };
}

export async function runLint(workspace: string, config: BridgeConfig): Promise<LintResult> {
  const paths = resolveBridgePaths(path.resolve(workspace));
  const errors: string[] = [];
  const warnings: string[] = [];
  let sessionCount = 0;
  let decisionCount = 0;

  // 1. Verify project-context.md
  const projectContext = await readText(paths.projectContextFile);
  if (projectContext === undefined) {
    warnings.push("Missing project-context.md file.");
  } else {
    const leaks = detectLeakageRisk(projectContext);
    if (leaks.length > 0) {
      warnings.push(`Potential secret leakage in project-context.md: ${leaks.join(", ")}`);
    }
  }

  // 2. Verify handoff.md
  const handoff = await readText(paths.handoffFile);
  if (handoff === undefined) {
    warnings.push("Missing handoff.md file. Consider running 'memory-bridge handoff build'.");
  } else {
    const leaks = detectLeakageRisk(handoff);
    if (leaks.length > 0) {
      warnings.push(`Potential secret leakage in handoff.md: ${leaks.join(", ")}`);
    }
  }

  // 3. Verify decisions.jsonl
  const decisionIds = new Set<string>();
  const supersededIds = new Set<string>();
  const { records: decisionRecords, warnings: decisionFileWarnings } = await readJsonl(paths.decisionsFile);
  if (decisionFileWarnings.length > 0) {
    errors.push(...decisionFileWarnings);
  }

  for (const [idx, record] of decisionRecords.entries()) {
    const decoded = decryptJsonIfNeeded<DecisionEvent>(record, config, warnings);
    if (!decoded || !validateDecisionEvent(decoded)) {
      errors.push(`Invalid decision record at decisions.jsonl line ${idx + 1}`);
      continue;
    }
    decisionCount += 1;
    if (decisionIds.has(decoded.id)) {
      warnings.push(`Duplicate decision ID '${decoded.id}' in decisions.jsonl`);
    }
    decisionIds.add(decoded.id);
    for (const sup of decoded.supersedes) {
      supersededIds.add(sup);
    }
  }

  // Check for orphan superseded references
  for (const supId of supersededIds) {
    if (!decisionIds.has(supId)) {
      warnings.push(`Decision references non-existent superseded ID: '${supId}'`);
    }
  }

  // 4. Verify sessions/*.jsonl
  const sessionFiles = await listSessionFiles(paths.sessionsDir);
  for (const file of sessionFiles) {
    const basename = path.basename(file);
    const { records: sessionRecords, warnings: sessionFileWarnings } = await readJsonl(file);
    if (sessionFileWarnings.length > 0) {
      errors.push(...sessionFileWarnings);
    }

    for (const [idx, record] of sessionRecords.entries()) {
      const decoded = decryptJsonIfNeeded<SessionEvent>(record, config, warnings);
      if (!decoded || !validateSessionEvent(decoded)) {
        errors.push(`Invalid session record at ${basename} line ${idx + 1}`);
        continue;
      }
      sessionCount += 1;
    }
  }

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    stats: {
      sessionCount,
      decisionCount,
      sessionFilesCount: sessionFiles.length
    }
  };
}
