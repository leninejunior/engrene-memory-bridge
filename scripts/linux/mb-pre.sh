#!/usr/bin/env bash
set -euo pipefail

TOOL="codex"
WORKSPACE=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --tool|-Tool)
      TOOL="$2"
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

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MB_RUNNER="$SCRIPT_DIR/mb.sh"

ARGS=("resume" "--for" "$TOOL")
if [ -n "$WORKSPACE" ]; then
  ARGS+=("--workspace" "$WORKSPACE")
fi

exec "$MB_RUNNER" "${ARGS[@]}"
