#!/usr/bin/env bash
set -euo pipefail

TOOL="codex"
INTENT=""
SUMMARY=""
ACTIONS=""
ARTIFACTS=""
TAGS=""
TASK_ID=""
PARENT_TASK_ID=""
WORKSPACE=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --tool|-Tool)
      TOOL="$2"
      shift 2
      ;;
    --intent|-Intent)
      INTENT="$2"
      shift 2
      ;;
    --summary|-Summary)
      SUMMARY="$2"
      shift 2
      ;;
    --actions|-Actions)
      ACTIONS="$2"
      shift 2
      ;;
    --artifacts|-Artifacts)
      ARTIFACTS="$2"
      shift 2
      ;;
    --tags|-Tags)
      TAGS="$2"
      shift 2
      ;;
    --task-id|-TaskId)
      TASK_ID="$2"
      shift 2
      ;;
    --parent-task-id|-ParentTaskId)
      PARENT_TASK_ID="$2"
      shift 2
      ;;
    --workspace|-Workspace)
      WORKSPACE="$2"
      shift 2
      ;;
    *)
      echo "Unknown argument: $1" >&2
      exit 1
      ;;
  esac
done

if [ -z "$INTENT" ] || [ -z "$SUMMARY" ]; then
  echo "Error: --intent and --summary are required." >&2
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MB_RUNNER="$SCRIPT_DIR/mb.sh"

LOG_ARGS=("log" "--tool" "$TOOL" "--intent" "$INTENT" "--summary" "$SUMMARY")
if [ -n "$ACTIONS" ]; then LOG_ARGS+=("--actions" "$ACTIONS"); fi
if [ -n "$ARTIFACTS" ]; then LOG_ARGS+=("--artifacts" "$ARTIFACTS"); fi
if [ -n "$TAGS" ]; then LOG_ARGS+=("--tags" "$TAGS"); fi
if [ -n "$TASK_ID" ]; then LOG_ARGS+=("--task-id" "$TASK_ID"); fi
if [ -n "$PARENT_TASK_ID" ]; then LOG_ARGS+=("--parent-task-id" "$PARENT_TASK_ID"); fi
if [ -n "$WORKSPACE" ]; then LOG_ARGS+=("--workspace" "$WORKSPACE"); fi

"$MB_RUNNER" "${LOG_ARGS[@]}"

HANDOFF_ARGS=("handoff" "build")
if [ -n "$WORKSPACE" ]; then HANDOFF_ARGS+=("--workspace" "$WORKSPACE"); fi

exec "$MB_RUNNER" "${HANDOFF_ARGS[@]}"
