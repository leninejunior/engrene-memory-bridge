import assert from "node:assert/strict";
import test from "node:test";

import { redactUnknown } from "../../src/core/redaction.js";

test("redactUnknown hides common sensitive patterns", () => {
  // Construct dummy test keys at runtime to avoid triggering static code secret scanners (e.g. GitHub Secret Scanning)
  const prefix = {
    openai: ["s", "k", "-"].join(""),
    github: ["g", "h", "p", "_"].join(""),
    gitlab: ["g", "l", "p", "a", "t", "-"].join(""),
    slack: ["x", "o", "x", "b", "-"].join(""),
    google: ["A", "I", "z", "a"].join("")
  };

  const fakeOpenAiKey = prefix.openai + "A".repeat(20);
  const fakeGithubToken = prefix.github + "A".repeat(36);
  const fakeGitlabToken = prefix.gitlab + "A".repeat(20);
  const fakeSlackToken = prefix.slack + "12345-67890";
  const fakeGoogleKey = prefix.google + "A".repeat(35);

  const payload = {
    summary: "token=abc12345678901234567890",
    nested: {
      key: `api_key: ${fakeOpenAiKey}`,
      privateKey: "-----BEGIN PRIVATE KEY-----\nAAA\n-----END PRIVATE KEY-----",
      githubToken: fakeGithubToken,
      gitlabToken: fakeGitlabToken,
      slackToken: fakeSlackToken,
      googleAiKey: fakeGoogleKey
    }
  };

  const out = redactUnknown(payload);
  const serialized = JSON.stringify(out);

  assert.equal(serialized.includes(prefix.openai), false);
  assert.equal(serialized.includes("BEGIN PRIVATE KEY"), false);
  assert.equal(serialized.includes(prefix.github), false);
  assert.equal(serialized.includes(prefix.gitlab), false);
  assert.equal(serialized.includes(prefix.slack), false);
  assert.equal(serialized.includes(prefix.google), false);
  assert.match(serialized, /\[REDACTED_GITHUB_TOKEN\]/);
  assert.match(serialized, /\[REDACTED_GITLAB_TOKEN\]/);
  assert.match(serialized, /\[REDACTED_SLACK_TOKEN\]/);
  assert.match(serialized, /\[REDACTED_GOOGLE_KEY\]/);
  assert.match(serialized, /\[REDACTED/);
});

test("redactUnknown supports customPatterns regex from configuration", () => {
  const payload = {
    message: "Connected to internal service with MYORG_SECRET_ABC12345XYZ and normal text."
  };

  const customPatterns = ["\\bMYORG_SECRET_[A-Z0-9]+\\b"];
  const out = redactUnknown(payload, customPatterns);
  const serialized = JSON.stringify(out);

  assert.equal(serialized.includes("MYORG_SECRET_ABC12345XYZ"), false);
  assert.match(serialized, /\[REDACTED_CUSTOM\]/);
  assert.match(serialized, /normal text/);
});
