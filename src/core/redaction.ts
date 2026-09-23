const PRIVATE_KEY_BLOCK = /-----BEGIN [A-Z0-9 ]*(PRIVATE KEY|RSA PRIVATE KEY|EC PRIVATE KEY|DSA PRIVATE KEY|OPENSSH PRIVATE KEY|PGP PRIVATE KEY BLOCK)-----[\s\S]*?-----END [A-Z0-9 ]*(PRIVATE KEY|RSA PRIVATE KEY|EC PRIVATE KEY|DSA PRIVATE KEY|OPENSSH PRIVATE KEY|PGP PRIVATE KEY BLOCK)-----/g;
const OPENAI_STYLE_KEY = /\bsk-[a-zA-Z0-9_-]{16,}\b/g;
const AWS_ACCESS_KEY = /\bAKIA[0-9A-Z]{16}\b/g;
const GITHUB_TOKEN = /\b(ghp_[a-zA-Z0-9]{36}|github_pat_[a-zA-Z0-9_]{82})\b/g;
const GITLAB_TOKEN = /\bglpat-[a-zA-Z0-9_-]{20,}\b/g;
const SLACK_TOKEN = /\bxox[baprs]-[a-zA-Z0-9-]{10,}\b/g;
const GOOGLE_AI_KEY = /\bAIza[0-9A-Za-z-_]{35}\b/g;
const AUTH_BEARER = /\bBearer\s+[A-Za-z0-9._\-+/=]{16,}\b/g;
const SENSITIVE_ASSIGNMENT = /(\b(?:api[_-]?key|token|password|passwd|secret|client[_-]?secret|private[_-]?key)\b\s*[:=]\s*)([^\s,;]+)/gi;
// `key: [REDACTED]` left behind by redactString must not be reported as a leak again.
const REDACTED_ASSIGNMENT = /(\b(?:api[_-]?key|token|password|passwd|secret|client[_-]?secret|private[_-]?key)\b\s*[:=]\s*)\[REDACTED[A-Z_]*\]/gi;
const ENV_LINE = /(^|\n)([A-Z][A-Z0-9_]{1,})=([^\n]+)/g;

function redactString(input: string, customPatterns?: string[]): string {
  let output = input;
  output = output.replace(PRIVATE_KEY_BLOCK, "[REDACTED_PRIVATE_KEY]");
  output = output.replace(OPENAI_STYLE_KEY, "[REDACTED_API_KEY]");
  output = output.replace(GITHUB_TOKEN, "[REDACTED_GITHUB_TOKEN]");
  output = output.replace(GITLAB_TOKEN, "[REDACTED_GITLAB_TOKEN]");
  output = output.replace(SLACK_TOKEN, "[REDACTED_SLACK_TOKEN]");
  output = output.replace(GOOGLE_AI_KEY, "[REDACTED_GOOGLE_KEY]");
  output = output.replace(AWS_ACCESS_KEY, "[REDACTED_AWS_KEY]");
  output = output.replace(AUTH_BEARER, "Bearer [REDACTED_TOKEN]");
  output = output.replace(SENSITIVE_ASSIGNMENT, (_full, prefix: string) => `${prefix}[REDACTED]`);
  output = output.replace(ENV_LINE, (full, leading: string, key: string, value: string) => {
    const looksSensitive = /(KEY|TOKEN|SECRET|PASSWORD|PASS|PRIVATE)/.test(key);
    if (!looksSensitive) {
      return full;
    }
    return `${leading}${key}=[REDACTED]`;
  });

  if (customPatterns && customPatterns.length > 0) {
    for (const pattern of customPatterns) {
      try {
        const regex = new RegExp(pattern, "gi");
        output = output.replace(regex, "[REDACTED_CUSTOM]");
      } catch {
        // Ignore invalid regex in user config
      }
    }
  }

  return output;
}

export function redactUnknown<T>(value: T, customPatterns?: string[]): T {
  const seen = new WeakMap<object, unknown>();

  const walk = (node: unknown): unknown => {
    if (typeof node === "string") {
      return redactString(node, customPatterns);
    }
    if (node === null || node === undefined) {
      return node;
    }
    if (typeof node !== "object") {
      return node;
    }
    if (seen.has(node)) {
      return seen.get(node);
    }
    if (Array.isArray(node)) {
      const arr: unknown[] = [];
      seen.set(node, arr);
      for (const item of node) {
        arr.push(walk(item));
      }
      return arr;
    }
    const out: Record<string, unknown> = {};
    seen.set(node, out);
    for (const [key, item] of Object.entries(node as Record<string, unknown>)) {
      out[key] = walk(item);
    }
    return out;
  };

  return walk(value) as T;
}

export function detectLeakageRisk(input: string): string[] {
  const findings: string[] = [];
  // String#search ignores the `g` flag and lastIndex, so repeated calls stay deterministic.
  const hit = (pattern: RegExp, text: string): boolean => text.search(pattern) !== -1;
  const probe = input.replace(REDACTED_ASSIGNMENT, "");

  if (hit(PRIVATE_KEY_BLOCK, input)) {
    findings.push("private-key-block");
  }
  if (hit(OPENAI_STYLE_KEY, input)) {
    findings.push("openai-key-pattern");
  }
  if (hit(GITHUB_TOKEN, input)) {
    findings.push("github-token-pattern");
  }
  if (hit(GITLAB_TOKEN, input)) {
    findings.push("gitlab-token-pattern");
  }
  if (hit(SLACK_TOKEN, input)) {
    findings.push("slack-token-pattern");
  }
  if (hit(GOOGLE_AI_KEY, input)) {
    findings.push("google-ai-key-pattern");
  }
  if (hit(AUTH_BEARER, input)) {
    findings.push("bearer-token-pattern");
  }
  if (hit(SENSITIVE_ASSIGNMENT, probe)) {
    findings.push("sensitive-assignment-pattern");
  }
  return Array.from(new Set(findings));
}
