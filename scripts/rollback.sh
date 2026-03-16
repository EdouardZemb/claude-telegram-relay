#!/bin/bash
# Rollback script — reverts to previous commit, restarts services, validates (S29-T4)
# Usage: ./scripts/rollback.sh [reason]

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
RELAY_DIR="$(dirname "$SCRIPT_DIR")"

# Load env
if [ -f "$RELAY_DIR/.env" ]; then
    export $(grep -v '^#' "$RELAY_DIR/.env" | xargs)
fi

BOT_TOKEN="${TELEGRAM_BOT_TOKEN:-}"
GROUP_ID="${TELEGRAM_GROUP_ID:-}"
USER_ID="${TELEGRAM_USER_ID:-}"
SERVER_THREAD="${SERVER_THREAD_ID:-7}"
CHAT_ID="${GROUP_ID:-$USER_ID}"
REASON="${1:-manual rollback}"

send_notification() {
    local message="$1"
    if [ -z "$BOT_TOKEN" ] || [ -z "$CHAT_ID" ]; then
        echo "[rollback] No Telegram config, skipping notification"
        return
    fi

    local params=(-s -X POST "https://api.telegram.org/bot${BOT_TOKEN}/sendMessage" \
        -d "chat_id=${CHAT_ID}" \
        -d "text=${message}")

    if [ -n "$GROUP_ID" ] && [ "$CHAT_ID" = "$GROUP_ID" ]; then
        params+=(-d "message_thread_id=${SERVER_THREAD}")
    fi

    curl "${params[@]}" > /dev/null 2>&1 || true
}

cd "$RELAY_DIR"

# Check we have at least 2 commits
COMMIT_COUNT=$(git rev-list --count HEAD 2>/dev/null || echo "0")
if [ "$COMMIT_COUNT" -lt 2 ]; then
    echo "[rollback] ERREUR: pas assez de commits pour rollback"
    send_notification "ROLLBACK ECHOUE: pas assez de commits dans l'historique"
    exit 1
fi

CURRENT_COMMIT=$(git log --oneline -1)
PREV_COMMIT=$(git log --oneline -1 HEAD~1)

echo "[rollback] Rollback en cours..."
echo "[rollback] Depuis: $CURRENT_COMMIT"
echo "[rollback] Vers: $PREV_COMMIT"
echo "[rollback] Raison: $REASON"

# Save current commit for reference
echo "$CURRENT_COMMIT" > /tmp/rollback-from

# Checkout previous commit files
git checkout HEAD~1 -- . 2>/dev/null || {
    echo "[rollback] ERREUR: git checkout echoue"
    send_notification "ROLLBACK ECHOUE: git checkout HEAD~1 echoue"
    exit 1
}

# Reinstall dependencies
bun install 2>/dev/null || true

# Restart PM2 services
npx pm2 restart claude-relay --update-env 2>/dev/null || true
npx pm2 restart claude-dashboard --update-env 2>/dev/null || true

# Wait for services to start
sleep 5

# Run smoke tests
echo "[rollback] Validation post-rollback..."
if bun run smoke 2>/dev/null; then
    echo "[rollback] Smoke tests OK apres rollback"
    send_notification "ROLLBACK OK
Depuis: $CURRENT_COMMIT
Vers: $PREV_COMMIT
Raison: $REASON
Smoke tests: OK"
else
    echo "[rollback] ATTENTION: smoke tests echoues apres rollback"
    send_notification "ROLLBACK CRITIQUE
Depuis: $CURRENT_COMMIT
Vers: $PREV_COMMIT
Raison: $REASON
Smoke tests: ECHEC — intervention manuelle requise"
    # Don't re-rollback (EC-003: max 1 rollback)
    exit 1
fi

echo "[rollback] Rollback termine avec succes"
