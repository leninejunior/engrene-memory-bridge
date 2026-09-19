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
  semanticSearch: {
    enabled: boolean;
    dimensions: number;
  };
}

export interface ResumeSnapshot {
  objective: string;
  recentDecisions: DecisionEvent[];
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
