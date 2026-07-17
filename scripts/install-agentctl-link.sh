#!/usr/bin/env sh
set -eu

# Resolve the CLI from this plugin copy so the link always targets the exact
# marketplace cache version that Codex installed and verified.
SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
PLUGIN_ROOT="$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)"
SOURCE="$PLUGIN_ROOT/mcp/agent-control/bin/agentctl"
DESTINATION_DIR="${AGENT_CONTROL_BIN_DIR:-$HOME/.local/bin}"
DESTINATION="$DESTINATION_DIR/agentctl"

if [ ! -x "$SOURCE" ]; then
  echo "Packaged Agent Control CLI is not executable: $SOURCE" >&2
  exit 1
fi

# Exercise dependency installation and CLI startup before changing an existing
# command. A failed standalone package therefore leaves the legacy command
# untouched and available for recovery.
if ! "$SOURCE" --help >/dev/null; then
  echo "Packaged Agent Control CLI failed its startup check: $SOURCE" >&2
  exit 1
fi

if [ -L "$DESTINATION" ]; then
  current_target="$(readlink "$DESTINATION")"
  case "$current_target" in
    "$SOURCE")
      echo "$DESTINATION"
      exit 0
      ;;
    */mcp/agent-control/bin/agentctl)
      # Repoint links created by an older standalone or legacy plugin cache.
      ;;
    *)
      echo "Refusing to replace unrelated agentctl symlink: $DESTINATION -> $current_target" >&2
      exit 1
      ;;
  esac
elif [ -e "$DESTINATION" ]; then
  if ! grep -Fq "/.codex/plugins/cache/agent-settings/agent-control/" "$DESTINATION" \
    && ! grep -Fq "/.codex/plugins/cache/agent-control/agent-control/" "$DESTINATION"; then
    echo "Refusing to replace unrelated agentctl executable: $DESTINATION" >&2
    exit 1
  fi
fi

mkdir -p "$DESTINATION_DIR"
temporary_link="$DESTINATION.tmp.$$"
trap 'rm -f "$temporary_link"' 0 1 2 15
ln -s "$SOURCE" "$temporary_link"

# The temporary link is created first so replacement of a known Agent Control
# wrapper or previous cache link is atomic from the caller's perspective.
mv -f "$temporary_link" "$DESTINATION"
trap - 0 1 2 15
echo "$DESTINATION"
