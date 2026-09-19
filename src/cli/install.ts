import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ensureDirSecure, exists, readText } from "../core/fs-utils.js";

export interface InstallResult {
  target: string;
  ok: boolean;
  actions: string[];
  warnings: string[];
}

const HERMES_SKILL_CONTENT = `---
name: memory-bridge
description: "Universal local-first memory layer: resume context, record decisions, search past sessions, build handoffs."
version: 0.1.0
author: Engrene
license: MIT
metadata:
  hermes:
    tags: [memory, context, handoff, universal, local-first]
prerequisites:
  commands: [memory-bridge]
---

# Memory Bridge Skill for Hermes Agent

Use this skill to maintain continuous context across sessions without vendor lock-in.

## Commands:
- Resume: \`memory-bridge resume --for hermes\` (or \`mb-hermes pre\`)
- Search: \`memory-bridge search "<query>" --mode hybrid\`
- Decision: \`memory-bridge decision add --title "<title>" --decision "<decision>"\`
- Wrap-up: \`mb-hermes post --intent "<intent>" --summary "<summary>"\`
- MCP Server: \`memory-bridge mcp\`
`;

export async function installHermes(workspace: string): Promise<InstallResult> {
  const actions: string[] = [];
  const warnings: string[] = [];
  const homeDir = os.homedir();
  const hermesDir = path.join(homeDir, ".hermes");

  // 1. Workspace HERMES.md
  const workspaceHermesMd = path.join(workspace, "HERMES.md");
  if (!(await exists(workspaceHermesMd))) {
    try {
      await fs.writeFile(workspaceHermesMd, "# HERMES.md\n\nSee AGENTS.md for universal memory protocol.\n", "utf-8");
      actions.push(`Created ${workspaceHermesMd}`);
    } catch (err) {
      warnings.push(`Could not create ${workspaceHermesMd}: ${err instanceof Error ? err.message : String(err)}`);
    }
  } else {
    actions.push(`Verified ${workspaceHermesMd}`);
  }

  // 2. Global ~/.hermes setup
  if (await exists(hermesDir)) {
    // a. Install Hermes Skill
    const skillTargetDir = path.join(hermesDir, "skills", "software-development", "memory-bridge");
    try {
      await ensureDirSecure(skillTargetDir);
      await fs.writeFile(path.join(skillTargetDir, "SKILL.md"), HERMES_SKILL_CONTENT, "utf-8");
      actions.push(`Installed Hermes skill in ${skillTargetDir}/SKILL.md`);
    } catch (err) {
      warnings.push(`Could not install Hermes skill: ${err instanceof Error ? err.message : String(err)}`);
    }

    // b. Configure MCP in config.yaml
    const configYamlPath = path.join(hermesDir, "config.yaml");
    if (await exists(configYamlPath)) {
      try {
        const rawContent = await readText(configYamlPath);
        const content = rawContent ?? "";
        if (!content.includes("memory-bridge")) {
          let updated = content;
          if (content.includes("mcp_servers:")) {
            // Append under existing mcp_servers
            updated = content.replace(
              /mcp_servers:\s*/,
              `mcp_servers:\n  memory-bridge:\n    command: "npx"\n    args: ["-y", "engrene-memory-bridge", "mcp"]\n`
            );
          } else {
            // Append new mcp_servers section
            updated += `\n# Model Context Protocol (MCP) Servers\nmcp_servers:\n  memory-bridge:\n    command: "npx"\n    args: ["-y", "engrene-memory-bridge", "mcp"]\n`;
          }
          await fs.writeFile(configYamlPath, updated, "utf-8");
          actions.push(`Configured memory-bridge MCP server in ${configYamlPath}`);
        } else {
          actions.push(`memory-bridge MCP server already configured in ${configYamlPath}`);
        }
      } catch (err) {
        warnings.push(`Failed to update ${configYamlPath}: ${err instanceof Error ? err.message : String(err)}`);
      }
    } else {
      warnings.push(`Config file ${configYamlPath} not found.`);
    }
  } else {
    warnings.push(`~/.hermes directory not found on this system.`);
  }

  return {
    target: "hermes",
    ok: warnings.length === 0,
    actions,
    warnings
  };
}

export async function installAntigravity(workspace: string): Promise<InstallResult> {
  const actions: string[] = [];
  const warnings: string[] = [];
  const homeDir = os.homedir();

  // 1. In-workspace .agents/skills/memory-bridge
  const localSkillDir = path.join(workspace, ".agents", "skills", "memory-bridge");
  try {
    await ensureDirSecure(localSkillDir);
    const sourceSkill = path.join(workspace, "skills", "memory-bridge", "SKILL.md");
    if (await exists(sourceSkill)) {
      const content = (await readText(sourceSkill)) ?? "";
      await fs.writeFile(path.join(localSkillDir, "SKILL.md"), content, "utf-8");
      actions.push(`Installed local skill at ${localSkillDir}/SKILL.md`);
    }
  } catch (err) {
    warnings.push(`Could not install workspace skill: ${err instanceof Error ? err.message : String(err)}`);
  }

  // 2. Global ~/.gemini/config/skills/memory-bridge
  const globalSkillDir = path.join(homeDir, ".gemini", "config", "skills", "memory-bridge");
  try {
    await ensureDirSecure(globalSkillDir);
    const sourceSkill = path.join(workspace, "skills", "memory-bridge", "SKILL.md");
    if (await exists(sourceSkill)) {
      const content = (await readText(sourceSkill)) ?? "";
      await fs.writeFile(path.join(globalSkillDir, "SKILL.md"), content, "utf-8");
      actions.push(`Installed global skill at ${globalSkillDir}/SKILL.md`);
    }
  } catch (err) {
    warnings.push(`Could not install global skill: ${err instanceof Error ? err.message : String(err)}`);
  }

  return {
    target: "antigravity",
    ok: warnings.length === 0,
    actions,
    warnings
  };
}

export async function installToolIntegration(target: string, workspace: string): Promise<InstallResult> {
  switch (target.toLowerCase()) {
    case "hermes":
      return installHermes(workspace);
    case "antigravity":
      return installAntigravity(workspace);
    default:
      return {
        target,
        ok: false,
        actions: [],
        warnings: [`Unsupported install target: ${target}. Supported targets: hermes, antigravity.`]
      };
  }
}
