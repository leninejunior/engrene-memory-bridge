export type StringList = string[];

export interface SessionEvent {
  ts: string;
  tool: string;
  workspace: string;
  branch: string;
  intent: string;
  actions: StringList;
  artifacts: StringList;
  summary: string;
  tags: StringList;
  taskId?: string;
  parentTaskId?: string;
}

export interface DecisionEvent {
  id: string;
  ts: string;
  title: string;
  context: string;
  decision: string;
  impact: string;
  supersedes: StringList;
}

export type SemanticProvider = "disabled" | "local" | "openai-compatible" | "ollama" | "jev";

export interface SemanticSearchConfig {
  enabled: boolean;
  dimensions: number;
  provider?: SemanticProvider;
  model?: string;
  endpoint?: string;
  apiKeyEnvVar?: string;
}

export interface CaptureConfig {
  enabled: boolean;
  retentionDays: number;
  maxSessions: number;
  exclude: string[];
}

export type ObservationType = "session_start" | "user_prompt" | "tool_call" | "tool_result" | "session_end";

export interface ObservationEvent {
  id: string;
  ts: string;
  sessionId: string;
  tool: string;
  type: ObservationType;
  payload: Record<string, unknown>;
}

export interface IntegrationsConfig {
  ce?: {
    autoSync?: boolean;
  };
  obsidian?: {
    autoSync?: boolean;
    vaultDir?: string;
    /** When true, `resume` pulls vault edits into `.memory-bridge/` before building the snapshot. */
    autoImport?: boolean;
    /** Conflict rule for import: who wins when the same record differs on both sides. Default: "vault". */
    prefer?: "vault" | "bridge";
  };
}

export interface BridgeConfig {
  schemaVersion: string;
  projectName: string;
  createdAt: string;
  redaction: {
    enabled: boolean;
    customPatterns?: string[];
  };
  encryption: {
    enabled: boolean;
    kdf: "scrypt";
    saltBase64: string;
    keyEnvVar: string;
  };
  semanticSearch: SemanticSearchConfig;
  capture?: CaptureConfig;
  integrations?: IntegrationsConfig;
}

export interface ResumeSnapshot {
  objective: string;
  projectObjective?: string | undefined;
  currentTask?: string | undefined;
  currentFocus?: string | undefined;
  recentDecisions: DecisionEvent[];
  activeDecisions?: DecisionEvent[] | undefined;
  pending: string[];
  nextSteps: string[];
  warnings: string[];
}

export interface SearchHit {
  source: "sessions" | "decisions" | "handoff" | "project-context" | "semantic";
  score: number;
  ts?: string;
  snippet: string;
  ref?: string;
  text_score?: number;
  semantic_score?: number;
  recency_score?: number;
}

export interface DoctorResult {
  ok: boolean;
  checks: Array<{
    name: string;
    ok: boolean;
    severity: "info" | "warn" | "error";
    message: string;
  }>;
}
