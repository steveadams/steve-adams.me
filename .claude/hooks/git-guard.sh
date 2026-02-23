#!/usr/bin/env bash
set -euo pipefail

COMMAND=$(jq -r '.tool_input.command // empty')
[[ -z "$COMMAND" ]] && exit 0

if echo "$COMMAND" | grep -qE '\bgit\b.*\b(commit|push)\b|\bgit\b.*\breset\b.*--hard\b'; then
  echo "Blocked: prohibited git operation" >&2
  echo "Stop vibe coding and do it yourself" >&2
  exit 2
fi
