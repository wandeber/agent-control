#!/usr/bin/env sh
set -eu

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
PACKAGE_DIR="$SCRIPT_DIR"

ensure_deps() {
  if [ ! -d "$PACKAGE_DIR/node_modules" ] || [ ! -e "$PACKAGE_DIR/node_modules/@modelcontextprotocol" ]; then
    pnpm --dir "$PACKAGE_DIR" install --frozen-lockfile --silent >/dev/null
  fi
  current_abi="$(node -p 'process.versions.modules')"
  abi_file="$PACKAGE_DIR/node_modules/.agent-control-node-abi"
  if [ ! -f "$abi_file" ] || [ "$(cat "$abi_file")" != "$current_abi" ]; then
    pnpm --dir "$PACKAGE_DIR" rebuild better-sqlite3 --silent >/dev/null
    printf '%s\n' "$current_abi" > "$abi_file"
  fi
}

ensure_deps

if [ -f "$PACKAGE_DIR/dist/index.js" ]; then
  exec node "$PACKAGE_DIR/dist/index.js"
fi

PATH="$PACKAGE_DIR/node_modules/.bin:$PATH"
exec tsx "$PACKAGE_DIR/src/index.ts"
