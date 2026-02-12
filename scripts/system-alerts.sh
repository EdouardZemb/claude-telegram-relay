#!/bin/bash
# System alerts: monitors server health and sends alerts to Telegram
# Runs as a periodic check (called by cron or systemd timer)

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
SPRINT_THREAD_ID="${SPRINT_THREAD_ID:-}"

# Prefer sending to group's serveur topic, fallback to user DM
CHAT_ID="${GROUP_ID:-$USER_ID}"

send_alert() {
    local message="$1"
    local params=(-s -X POST "https://api.telegram.org/bot${BOT_TOKEN}/sendMessage" \
        -d "chat_id=${CHAT_ID}" \
        -d "text=${message}")

    # If sending to group, use the serveur topic if known
    # Thread ID 7 is typically the serveur topic (adjust if needed)
    if [ -n "$GROUP_ID" ] && [ "$CHAT_ID" = "$GROUP_ID" ]; then
        params+=(-d "message_thread_id=7")
    fi

    curl "${params[@]}" > /dev/null 2>&1
}

ALERTS=""

# Check disk usage
DISK_USAGE=$(df / | awk 'NR==2 {print $5}' | tr -d '%')
if [ "$DISK_USAGE" -gt 85 ]; then
    ALERTS="${ALERTS}DISQUE: ${DISK_USAGE}% utilise (seuil: 85%)\n"
fi

# Check memory usage
MEM_TOTAL=$(free -m | awk 'NR==2 {print $2}')
MEM_USED=$(free -m | awk 'NR==2 {print $3}')
MEM_PCT=$((MEM_USED * 100 / MEM_TOTAL))
if [ "$MEM_PCT" -gt 90 ]; then
    ALERTS="${ALERTS}MEMOIRE: ${MEM_PCT}% utilisee (${MEM_USED}/${MEM_TOTAL} MB)\n"
fi

# Check load average (alert if > 2x number of CPUs)
NCPU=$(nproc)
LOAD=$(awk '{print $1}' /proc/loadavg)
LOAD_INT=$(echo "$LOAD" | cut -d. -f1)
THRESHOLD=$((NCPU * 2))
if [ "$LOAD_INT" -gt "$THRESHOLD" ]; then
    ALERTS="${ALERTS}CHARGE: load average ${LOAD} (seuil: ${THRESHOLD})\n"
fi

# Check PM2 services
for SERVICE in claude-relay claude-dashboard; do
    STATUS=$(npx pm2 jlist 2>/dev/null | python3 -c "import sys,json;apps=json.load(sys.stdin);[print(a['pm2_env']['status']) for a in apps if a['name']=='${SERVICE}']" 2>/dev/null || echo "unknown")
    if [ "$STATUS" != "online" ]; then
        ALERTS="${ALERTS}SERVICE: ${SERVICE} est ${STATUS}\n"
    fi
done

# Check if SSH is running
if ! systemctl is-active --quiet sshd; then
    ALERTS="${ALERTS}SSH: le service sshd n'est pas actif\n"
fi

# Check fail2ban
if ! systemctl is-active --quiet fail2ban; then
    ALERTS="${ALERTS}SECURITE: fail2ban n'est pas actif\n"
fi

# Send alerts if any
if [ -n "$ALERTS" ]; then
    HOSTNAME=$(hostname)
    TIMESTAMP=$(date '+%Y-%m-%d %H:%M')
    MESSAGE="ALERTE SERVEUR (${HOSTNAME}) - ${TIMESTAMP}

${ALERTS}
Verifier avec /status dans le topic serveur."

    send_alert "$MESSAGE"
    echo "[system-alerts] Alerts sent: $ALERTS"
else
    echo "[system-alerts] All checks passed"
fi
