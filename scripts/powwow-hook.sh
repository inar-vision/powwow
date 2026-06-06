#!/bin/bash
# Claude Code hook: auto-start powwow serve when a session begins.
#
# Install by adding this to your ~/.claude/settings.json hooks:
#
#   "hooks": {
#     "UserPromptSubmit": [
#       {
#         "hooks": [{ "type": "command", "command": "/path/to/powwow/scripts/powwow-hook.sh" }]
#       }
#     ]
#   }
#
# Or use: powwow hook-setup  (sets this up automatically)

POWWOW_CLI="$(dirname "$0")/../dist/cli.js"
CWD="$(pwd)"

# Only run if this project has opted in by placing a .powwow file in the root
[ -f "$CWD/.powwow" ] || exit 0

# Check registry: if a relay is already running for this cwd, exit immediately
SLUG=$(echo "$CWD" | sed 's|/|-|g')
REGISTRY="$HOME/.powwow/active/$SLUG.json"

if [ -f "$REGISTRY" ]; then
  PID=$(node -e "try{process.stdout.write(String(JSON.parse(require('fs').readFileSync('$REGISTRY')).pid))}catch{}" 2>/dev/null)
  if [ -n "$PID" ] && kill -0 "$PID" 2>/dev/null; then
    exit 0
  fi
fi

# Start relay (detaches by default; writes registry, opens browser, exits)
node "$POWWOW_CLI" serve --cwd "$CWD"
