#!/usr/bin/env sh
set -eu

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
PACKAGE_DIR="$SCRIPT_DIR"

# Each process loads an immutable SQLite addon for its own Node ABI.
NODE_BIN="$(node -p 'process.execPath')"
AGENT_CONTROL_SQLITE_BINDING="$("$NODE_BIN" "$PACKAGE_DIR/runtime/bootstrap.mjs")"
export AGENT_CONTROL_SQLITE_BINDING

if [ -f "$PACKAGE_DIR/dist/index.js" ]; then
  exec "$NODE_BIN" "$PACKAGE_DIR/dist/index.js"
fi

exec "$NODE_BIN" "$PACKAGE_DIR/node_modules/tsx/dist/cli.mjs" "$PACKAGE_DIR/src/index.ts"
