#!/bin/bash
# Rotate the Telegram bot token with zero-confusion workflow
# Usage: ./scripts/rotate-token.sh <NEW_TOKEN>
#
# Steps:
#   1. Go to @BotFather on Telegram, send /revoke, select your bot
#   2. Copy the new token
#   3. Run: ./scripts/rotate-token.sh <NEW_TOKEN>
#
# The script will:
#   - Validate the new token format
#   - Update .env
#   - Restart the relay via PM2
#   - Verify the bot is back online

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
RELAY_DIR="$(dirname "$SCRIPT_DIR")"
ENV_FILE="$RELAY_DIR/.env"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

info() { echo -e "${GREEN}[OK]${NC} $1"; }
warn() { echo -e "${YELLOW}[!]${NC} $1"; }
fail() { echo -e "${RED}[ERREUR]${NC} $1"; exit 1; }

# Check argument
if [ -z "${1:-}" ]; then
    echo ""
    echo "Rotation du token Telegram"
    echo "=========================="
    echo ""
    echo "Usage: $0 <NOUVEAU_TOKEN>"
    echo ""
    echo "Etapes :"
    echo "  1. Ouvre Telegram, va sur @BotFather"
    echo "  2. Envoie /revoke et selectionne ton bot"
    echo "  3. Copie le nouveau token"
    echo "  4. Lance : $0 <NOUVEAU_TOKEN>"
    echo ""
    exit 1
fi

NEW_TOKEN="$1"

# Validate token format (numeric_id:alphanumeric)
if ! echo "$NEW_TOKEN" | grep -qE '^[0-9]+:[A-Za-z0-9_-]+$'; then
    fail "Format de token invalide. Un token Telegram ressemble a : 123456789:ABCdefGHIjklMNOpqrSTUvwxYZ"
fi

# Check .env exists
if [ ! -f "$ENV_FILE" ]; then
    fail "Fichier .env introuvable : $ENV_FILE"
fi

# Backup .env
cp "$ENV_FILE" "$ENV_FILE.bak"
info "Backup .env -> .env.bak"

# Get old token for comparison
OLD_TOKEN=$(grep '^TELEGRAM_BOT_TOKEN=' "$ENV_FILE" | cut -d'=' -f2- | tr -d '"' | tr -d "'")

if [ "$OLD_TOKEN" = "$NEW_TOKEN" ]; then
    warn "Le nouveau token est identique a l'ancien. Rien a faire."
    exit 0
fi

# Replace token in .env
sed -i "s|^TELEGRAM_BOT_TOKEN=.*|TELEGRAM_BOT_TOKEN=$NEW_TOKEN|" "$ENV_FILE"
info "Token mis a jour dans .env"

# Restart relay via PM2
if command -v npx &> /dev/null && npx pm2 list 2>/dev/null | grep -q "claude-relay"; then
    npx pm2 restart claude-relay --update-env
    info "claude-relay redemarre via PM2"

    # Wait for startup
    sleep 3

    # Check status
    STATUS=$(npx pm2 jlist 2>/dev/null | bun -e "
        const data = JSON.parse(await Bun.stdin.text());
        const relay = data.find(p => p.name === 'claude-relay');
        console.log(relay ? relay.pm2_env.status : 'not_found');
    " 2>/dev/null || echo "unknown")

    if [ "$STATUS" = "online" ]; then
        info "Bot en ligne ! Envoie un message sur Telegram pour verifier."
    else
        warn "Le bot ne semble pas en ligne (status: $STATUS). Verifie les logs :"
        echo "  npx pm2 logs claude-relay --lines 20"
    fi
else
    warn "PM2 non detecte ou claude-relay non enregistre."
    echo "  Redemarre manuellement : bun run start"
fi

echo ""
info "Rotation terminee."
echo "  Ancien token : ${OLD_TOKEN:0:10}...${OLD_TOKEN: -5}"
echo "  Nouveau token : ${NEW_TOKEN:0:10}...${NEW_TOKEN: -5}"
echo ""
