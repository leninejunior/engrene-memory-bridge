import path from "node:path";
import type { BridgeConfig } from "../types/events.js";
import { syncCompoundEngineering } from "./ce.js";
import { syncObsidianVault } from "./obsidian.js";

export interface AutoSyncTriggerOptions {
  vaultDir?: string;
  syncCe?: boolean;
}

export interface AutoSyncResult {
  ceSynced: boolean;
  obsidianSynced: boolean;
  warnings: string[];
}

export async function runAutoSyncIntegrations(
  workspace: string,
  config: BridgeConfig,
  options: AutoSyncTriggerOptions = {}
): Promise<AutoSyncResult> {
  const warnings: string[] = [];
  let ceSynced = false;
  let obsidianSynced = false;

  const shouldSyncCe = options.syncCe !== false && (config.integrations?.ce?.autoSync !== false);
  if (shouldSyncCe) {
    try {
      await syncCompoundEngineering(workspace, config);
      ceSynced = true;
    } catch (err) {
      warnings.push(`Auto-sync CE failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  const targetVaultDir = options.vaultDir || config.integrations?.obsidian?.vaultDir;
  const shouldSyncObsidian = Boolean(targetVaultDir) && (config.integrations?.obsidian?.autoSync !== false || Boolean(options.vaultDir));

  if (shouldSyncObsidian && targetVaultDir) {
    try {
      await syncObsidianVault(workspace, config, targetVaultDir);
      obsidianSynced = true;
    } catch (err) {
      warnings.push(`Auto-sync Obsidian failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return {
    ceSynced,
    obsidianSynced,
    warnings
  };
}
