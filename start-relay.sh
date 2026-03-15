#!/bin/bash
# Wrapper for PM2 — ensures shell env doesn't override .env values
unset ANTHROPIC_API_KEY
unset TELEGRAM_BOT_TOKEN

# Source .env so PM2-spawned processes pick up all config
cd "$(dirname "$0")"
if [ -f .env ]; then
  set -a
  source .env
  set +a
fi

# Use flock for process-level mutual exclusion.
# During PM2 reload, the new instance blocks here until the old one exits
# and the kernel auto-releases the flock. No race condition possible.
LOCK_DIR="$HOME/.claude-relay"
mkdir -p "$LOCK_DIR"
FLOCK_FILE="$LOCK_DIR/relay.flock"

exec 200>"$FLOCK_FILE"
echo "Waiting for exclusive lock..."
if ! flock --wait 15 200; then
  echo "ERROR: Could not acquire flock after 15s. Exiting."
  exit 1
fi
echo "Lock acquired (PID $$), starting relay..."

exec bun run src/relay.ts
