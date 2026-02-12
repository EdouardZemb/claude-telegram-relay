#!/bin/bash
# Sends a deploy notification to the serveur topic on Telegram
# Usage: notify-deploy.sh <success|failure> <commit message>

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
RELAY_DIR="$(dirname "$SCRIPT_DIR")"

# Load env
if [ -f "$RELAY_DIR/.env" ]; then
    export $(grep -v '^#' "$RELAY_DIR/.env" | xargs)
fi

STATUS="${1:-unknown}"
DETAILS="${2:-}"

BOT_TOKEN="${TELEGRAM_BOT_TOKEN:-}"
GROUP_ID="${TELEGRAM_GROUP_ID:-}"
SERVER_THREAD="${SERVER_THREAD_ID:-7}"

if [ -z "$BOT_TOKEN" ] || [ -z "$GROUP_ID" ]; then
    echo "[notify-deploy] Missing BOT_TOKEN or GROUP_ID"
    exit 0
fi

HOSTNAME=$(hostname)
TIMESTAMP=$(date '+%Y-%m-%d %H:%M')

if [ "$STATUS" = "success" ]; then
    MESSAGE="Deploy OK ($HOSTNAME) - $TIMESTAMP
$DETAILS
Services redemarres."
else
    MESSAGE="Deploy ECHEC ($HOSTNAME) - $TIMESTAMP
$DETAILS"
fi

curl -s -X POST "https://api.telegram.org/bot${BOT_TOKEN}/sendMessage" \
    -d "chat_id=${GROUP_ID}" \
    -d "text=${MESSAGE}" \
    -d "message_thread_id=${SERVER_THREAD}" > /dev/null 2>&1

echo "[notify-deploy] Notification sent: $STATUS"
