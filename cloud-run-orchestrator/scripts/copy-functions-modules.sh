#!/usr/bin/env bash
# Copy the specific functions source modules that the orchestrator imports
# at runtime via @functions/* path aliases. These get compiled into lib/_functions/
# and tsc-alias rewrites the imports to point there.
#
# Run automatically via "prebuild" in package.json.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ORCH_DIR="$(dirname "$SCRIPT_DIR")"
FUNCTIONS_SRC="$ORCH_DIR/../functions/src"
TARGET="$ORCH_DIR/src/_functions"

# Wipe and recreate — always a clean copy
rm -rf "$TARGET"
mkdir -p "$TARGET"

# The three modules pipeline.ts directly imports:
#   @functions/gemini3Pipeline
#   @functions/alignment
#   @functions/audioUtils
#
# Plus their transitive dependencies:
#   gemini3Pipeline → ./logger, ./types, ./firestoreUtils
#   alignment       → (npm only: google-auth-library, fuzzball)
#   audioUtils      → (stdlib only)
MODULES=(
  gemini3Pipeline.ts
  alignment.ts
  audioUtils.ts
  logger.ts
  types.ts
  firestoreUtils.ts
)

for mod in "${MODULES[@]}"; do
  if [[ -f "$FUNCTIONS_SRC/$mod" ]]; then
    cp "$FUNCTIONS_SRC/$mod" "$TARGET/$mod"
  else
    echo "WARNING: $FUNCTIONS_SRC/$mod not found — build may fail" >&2
  fi
done

echo "[copy-functions-modules] Copied ${#MODULES[@]} modules to src/_functions/"
