import fs from "node:fs/promises";
import path from "node:path";

import type { BridgeConfig } from "../types/events.js";
import { ensureDirSecure, exists, readText } from "./fs-utils.js";
import { readDecisionEvents, readProjectContext } from "./store.js";
import { filterActiveDecisions } from "./context.js";

export interface CESyncResult {
  workspace: string;
  updatedFiles: string[];
  createdFiles: string[];
  activeDecisionsCount: number;
}

export function generateAgentsMdContent(decisionsText: string, contextText: string): string {
  return `# AGENTS.md — Universal AI Agent Guidelines (Compound Engineering)

Welcome, AI Agent! This project uses **Memory Bridge** (\`engrene-memory-bridge\`) alongside **Compound Engineering (CE)** principles to maintain seamless context, project standards, and historical learnings across all AI tools.

---

## 🧭 Memory Bridge Lifecycle Protocol (Mandatory)

Whenever operating in this repository, follow this execution lifecycle:

\`\`\`mermaid
flowchart LR
    A["1. Resume Context\\n(memory-bridge resume)"] --> B["2. Search / Inspect\\n(memory-bridge search)"]
    B --> C["3. Execute & Record Decisions\\n(memory-bridge decision add)"]
    C --> D["4. Build & Verify\\n(npm test)"]
    D --> E["5. Log & Handoff\\n(memory-bridge log && handoff build)"]
\`\`\`

### 1. Session Start
Before making any changes, inspect active context:
\`\`\`bash
memory-bridge resume --for <agent-name>
\`\`\`

### 2. Decision Recording
When making non-trivial architectural choices or adding dependencies:
\`\`\`bash
memory-bridge decision add --title "Title" --decision "Choice" --context "Rationale" --impact "Effects"
\`\`\`

### 3. Verification & Handoff
Before wrapping up your turn:
\`\`\`bash
npm run build && npm test
memory-bridge log --tool <agent-name> --intent "Summary" --summary "Details"
memory-bridge handoff build
\`\`\`

---

## 📌 Project Invariants & Context
${contextText || "No project context defined yet."}

---

## 🏛️ Active Architectural Decisions & Project Pitfalls
${decisionsText || "No active architectural decisions recorded yet."}
`;
}

export function generateCursorrulesContent(decisionsText: string): string {
  return `# .cursorrules — Cursor IDE Instructions (Compound Engineering + Memory Bridge)

# 1. Context & Handoff Protocol
Always read .memory-bridge/handoff.md and .memory-bridge/project-context.md before starting work.
When completing a non-trivial task, run:
  memory-bridge log --tool cursor --intent "<intent>" --summary "<summary>"
  memory-bridge handoff build

# 2. Architectural Decisions & Pitfalls to Avoid
${decisionsText || "No active architectural decisions recorded yet."}

# 3. Quality & Verification
Never claim success without running tests (\`npm test\`).
`;
}

export function generateClaudeMdContent(decisionsText: string): string {
  return `# CLAUDE.md — Claude Code Instructions (Compound Engineering + Memory Bridge)

## Workflow & Memory Protocol
1. Resume context at session start: \`memory-bridge resume --for claude\`
2. Check past decisions & traps: \`memory-bridge search "<query>" --mode hybrid\`
3. Record architectural choices: \`memory-bridge decision add --title "<title>" --decision "<decision>"\`
4. Build & verify: \`npm test\`
5. Wrap-up session: \`memory-bridge log --tool claude --intent "<intent>" --summary "<summary>" && memory-bridge handoff build\`

## Active Architectural Decisions & Pitfalls
${decisionsText || "No active decisions recorded yet."}
`;
}

export function generateCopilotInstructionsContent(decisionsText: string): string {
  return `# GitHub Copilot Instructions (Compound Engineering + Memory Bridge)

## Project Rules
- Follow Memory Bridge lifecycle protocol defined in AGENTS.md.
- Read .memory-bridge/handoff.md before starting work.
- Maintain zero runtime dependencies and local-first storage.

## Active Decisions
${decisionsText || "No active decisions recorded yet."}
`;
}

export async function syncCompoundEngineering(
  workspace: string,
  config: BridgeConfig
): Promise<CESyncResult> {
  const decisionsResult = await readDecisionEvents(workspace, config, 1000);
  const projectContext = (await readProjectContext(workspace)) || "";
  const { active } = filterActiveDecisions(decisionsResult.events);

  const decisionsText =
    active.length > 0
      ? active
          .map(
            (d) =>
              `- **[${d.id}] ${d.title}**: ${d.decision} *(Impact: ${d.impact})*`
          )
          .join("\n")
      : "";

  const createdFiles: string[] = [];
  const updatedFiles: string[] = [];

  const targets = [
    {
      filepath: path.join(workspace, "AGENTS.md"),
      content: generateAgentsMdContent(decisionsText, projectContext)
    },
    {
      filepath: path.join(workspace, ".cursorrules"),
      content: generateCursorrulesContent(decisionsText)
    },
    {
      filepath: path.join(workspace, "CLAUDE.md"),
      content: generateClaudeMdContent(decisionsText)
    },
    {
      filepath: path.join(workspace, ".github", "copilot-instructions.md"),
      content: generateCopilotInstructionsContent(decisionsText)
    }
  ];

  for (const target of targets) {
    const parentDir = path.dirname(target.filepath);
    await ensureDirSecure(parentDir);

    const fileExists = await exists(target.filepath);
    await fs.writeFile(target.filepath, target.content, "utf-8");

    if (fileExists) {
      updatedFiles.push(target.filepath);
    } else {
      createdFiles.push(target.filepath);
    }
  }

  return {
    workspace,
    createdFiles,
    updatedFiles,
    activeDecisionsCount: active.length
  };
}
