#!/usr/bin/env bash
set -euo pipefail

# engrene-memory-bridge runner for Linux / macOS
# If run inside the repo or built, runs local bin; otherwise runs via npx

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"

if [ -f "$REPO_DIR/dist/src/cli/bin.js" ]; then
  exec node "$REPO_DIR/dist/src/cli/bin.js" "$@"
elif command -v memory-bridge >/dev/null 2>&1; then
  exec memory-bridge "$@"
else
  exec npx --yes --package=git+https://github.com/leninejunior/engrene-memory-bridge.git memory-bridge "$@"
fi
