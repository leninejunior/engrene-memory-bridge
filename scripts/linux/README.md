# Linux / POSIX Helpers

Ready-to-use scripts for Linux and macOS environments (Bash, Zsh).

## Files

- `mb.sh`: CLI entrypoint (runs local build or via `npx`, no global install required).
- `mb-pre.sh`: pre-task hook running `memory-bridge resume --for <tool>`.
- `mb-post.sh`: post-task hook running `memory-bridge log ...` followed by `memory-bridge handoff build`.

## Permissions

Ensure execution permission:

```bash
chmod +x scripts/linux/*.sh
```

## Quick Start (No global install required)

```bash
./scripts/linux/mb.sh init
./scripts/linux/mb.sh doctor
./scripts/linux/mb.sh resume --for codex
```

## Workflow Example

Before prompt/task:

```bash
./scripts/linux/mb-pre.sh --tool claude
```

After task completion:

```bash
./scripts/linux/mb-post.sh \
  --tool claude \
  --intent "Implement auth validation" \
  --summary "Added token validation guards" \
  --actions "TODO: benchmark MFA" \
  --artifacts "src/auth.ts" \
  --tags "auth,security" \
  --task-id "task-auth-01"
```
