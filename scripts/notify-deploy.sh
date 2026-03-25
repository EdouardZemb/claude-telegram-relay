#!/bin/bash
# Sends a deploy notification to the serveur topic on Telegram
# and writes an MCP pending notification for the heartbeat relay.
# Usage: notify-deploy.sh <success|failure> <commit message>

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

# Load env
if [ -f "$PROJECT_DIR/.env" ]; then
    export $(grep -v '^#' "$PROJECT_DIR/.env" | xargs)
fi

STATUS="${1:-unknown}"
DETAILS="${2:-}"

HOSTNAME=$(hostname)
TIMESTAMP=$(date '+%Y-%m-%d %H:%M')

if [ "$STATUS" = "success" ]; then
    MESSAGE="Deploy OK ($HOSTNAME) - $TIMESTAMP
$DETAILS
Services redemarres."
    SEVERITY="normal"
else
    MESSAGE="Deploy ECHEC ($HOSTNAME) - $TIMESTAMP
$DETAILS"
    SEVERITY="critical"
fi

# ── Telegram notification ────────────────────────────────────────

BOT_TOKEN="${TELEGRAM_BOT_TOKEN:-}"
GROUP_ID="${TELEGRAM_GROUP_ID:-}"
SERVER_THREAD="${SERVER_THREAD_ID:-7}"

if [ -n "$BOT_TOKEN" ] && [ -n "$GROUP_ID" ]; then
    curl -s -X POST "https://api.telegram.org/bot${BOT_TOKEN}/sendMessage" \
        -d "chat_id=${GROUP_ID}" \
        -d "text=${MESSAGE}" \
        -d "message_thread_id=${SERVER_THREAD}" > /dev/null 2>&1
    echo "[notify-deploy] Telegram notification sent: $STATUS"
else
    echo "[notify-deploy] Missing BOT_TOKEN or GROUP_ID — skipping Telegram"
fi

# ── MCP pending notification (for heartbeat relay) ───────────────

MCP_RELAY_DIR="${RELAY_DIR:-${HOME:-~}/.claude-relay}"
MCP_PENDING_FILE="$MCP_RELAY_DIR/mcp-pending-notifications.json"

# Ensure relay dir exists
mkdir -p "$MCP_RELAY_DIR"

# Build the notification JSON entry
# Escape special characters in MESSAGE for JSON
ESCAPED_MESSAGE=$(printf '%s' "$MESSAGE" | sed 's/\\/\\\\/g; s/"/\\"/g; s/\t/\\t/g' | tr '\n' ' ')
ESCAPED_DETAILS=$(printf '%s' "$DETAILS" | sed 's/\\/\\\\/g; s/"/\\"/g; s/\t/\\t/g' | tr '\n' ' ')

NOTIF_JSON="{\"type\":\"alert\",\"severity\":\"$SEVERITY\",\"message\":\"$ESCAPED_MESSAGE\",\"data\":{\"deployStatus\":\"$STATUS\",\"alertType\":\"deploy_result\",\"commitInfo\":\"$ESCAPED_DETAILS\"}}"

# Read existing pending notifications (or start with empty array)
if [ -f "$MCP_PENDING_FILE" ]; then
    EXISTING=$(cat "$MCP_PENDING_FILE" 2>/dev/null || echo "[]")
    # Validate it's a JSON array
    if ! printf '%s' "$EXISTING" | grep -q '^\['; then
        EXISTING="[]"
    fi
else
    EXISTING="[]"
fi

# Append the new notification to the array
# Use a temp file + mv for atomicity
TMP_FILE="$MCP_PENDING_FILE.tmp.$$"
if [ "$EXISTING" = "[]" ]; then
    printf '[%s]' "$NOTIF_JSON" > "$TMP_FILE"
else
    # Remove trailing ] and append new item
    printf '%s' "$EXISTING" | sed 's/]$//' > "$TMP_FILE"
    printf ',%s]' "$NOTIF_JSON" >> "$TMP_FILE"
fi
mv "$TMP_FILE" "$MCP_PENDING_FILE"

echo "[notify-deploy] MCP notification written: $STATUS"
