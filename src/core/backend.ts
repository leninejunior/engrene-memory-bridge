import type {
  BridgeConfig,
  DecisionEvent,
  ObservationEvent,
  ResumeSnapshot,
  SearchHit,
  SessionEvent
} from "../types/events.js";
import { appendObservation } from "./capture.js";
import { initWorkspace, loadConfig, type InitOptions } from "./config.js";
import { ConsolidateOptions, ConsolidateResult, runConsolidation } from "./consolidate.js";
import { buildContextSnapshot } from "./context.js";
import { searchMemory, type SearchMode } from "./search.js";
import {
  appendDecisionEvent,
  appendSessionEvent,
  readDecisionEvents,
  readHandoff,
  readSessionEvents,
  saveHandoff
} from "./store.js";

export interface MemoryBackend {
  readonly name: string;
  initialize(options: InitOptions): Promise<{ config: BridgeConfig }>;
  getContext(workspace: string, tool: string): Promise<{ snapshot: ResumeSnapshot; warnings: string[] }>;
  getHandoff(workspace: string): Promise<{ text: string | undefined; warnings: string[] }>;
  saveHandoff(workspace: string, markdown: string): Promise<void>;
  appendSession(workspace: string, event: SessionEvent): Promise<void>;
  appendDecision(workspace: string, event: DecisionEvent): Promise<void>;
  search(workspace: string, query: string, mode: SearchMode, limit: number): Promise<{ hits: SearchHit[]; warnings: string[] }>;
  consolidate(workspace: string, options?: ConsolidateOptions): Promise<ConsolidateResult>;
  observe(workspace: string, event: ObservationEvent): Promise<{ file: string }>;
}

export class LocalFilesystemBackend implements MemoryBackend {
  readonly name = "local-filesystem";

  async initialize(options: InitOptions): Promise<{ config: BridgeConfig }> {
    const result = await initWorkspace(options);
    return { config: result.config };
  }

  async getContext(workspace: string, tool: string): Promise<{ snapshot: ResumeSnapshot; warnings: string[] }> {
    const { config } = await loadConfig(workspace);
    const { snapshot } = await buildContextSnapshot(workspace, config);
    return { snapshot, warnings: snapshot.warnings };
  }

  async getHandoff(workspace: string): Promise<{ text: string | undefined; warnings: string[] }> {
    const { config } = await loadConfig(workspace);
    return readHandoff(workspace, config);
  }

  async saveHandoff(workspace: string, markdown: string): Promise<void> {
    const { config } = await loadConfig(workspace);
    await saveHandoff(workspace, config, markdown);
  }

  async appendSession(workspace: string, event: SessionEvent): Promise<void> {
    const { config } = await loadConfig(workspace);
    await appendSessionEvent(workspace, config, event);
  }

  async appendDecision(workspace: string, event: DecisionEvent): Promise<void> {
    const { config } = await loadConfig(workspace);
    await appendDecisionEvent(workspace, config, event);
  }

  async search(
    workspace: string,
    query: string,
    mode: SearchMode = "hybrid",
    limit = 10
  ): Promise<{ hits: SearchHit[]; warnings: string[] }> {
    const { config } = await loadConfig(workspace);
    return searchMemory({ workspace, config, query, mode, limit });
  }

  async consolidate(workspace: string, options?: ConsolidateOptions): Promise<ConsolidateResult> {
    const { config } = await loadConfig(workspace);
    return runConsolidation(workspace, config, options);
  }

  async observe(workspace: string, event: ObservationEvent): Promise<{ file: string }> {
    const { config } = await loadConfig(workspace);
    const result = await appendObservation(workspace, config, event);
    return { file: result.file };
  }
}

export const defaultBackend = new LocalFilesystemBackend();
