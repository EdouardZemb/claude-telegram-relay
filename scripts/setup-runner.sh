#!/bin/bash
# Setup GitHub Actions self-hosted runner
# Usage: bash scripts/setup-runner.sh <REGISTRATION_TOKEN>
#
# Get the registration token from:
# GitHub repo → Settings → Actions → Runners → New self-hosted runner
#
# This script:
# 1. Downloads the latest GitHub Actions runner
# 2. Registers it with the repository
# 3. Creates a systemd service for auto-start

set -euo pipefail

RUNNER_DIR="/home/edouard/actions-runner"
REPO_URL="https://github.com/EdouardZemb/claude-telegram-relay"
RUNNER_VERSION="2.322.0"
RUNNER_ARCH="linux-x64"
RUNNER_TAR="actions-runner-${RUNNER_ARCH}-${RUNNER_VERSION}.tar.gz"
RUNNER_URL="https://github.com/actions/runner/releases/download/v${RUNNER_VERSION}/${RUNNER_TAR}"
LABELS="self-hosted,linux"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

log() { echo -e "${GREEN}[runner-setup]${NC} $1"; }
warn() { echo -e "${YELLOW}[runner-setup]${NC} $1"; }
err() { echo -e "${RED}[runner-setup]${NC} $1" >&2; }

# Check for registration token
if [ -z "${1:-}" ]; then
  err "Usage: bash scripts/setup-runner.sh <REGISTRATION_TOKEN>"
  echo ""
  echo "Get the token from:"
  echo "  GitHub repo → Settings → Actions → Runners → New self-hosted runner"
  echo "  Copy the token from the './config.sh --token' line"
  exit 1
fi

REGISTRATION_TOKEN="$1"

# Check if runner is already installed
if [ -d "$RUNNER_DIR" ] && [ -f "$RUNNER_DIR/run.sh" ]; then
  warn "Runner already installed at $RUNNER_DIR"
  warn "To reinstall, remove the directory first: rm -rf $RUNNER_DIR"
  exit 1
fi

# Create runner directory
log "Creating runner directory: $RUNNER_DIR"
mkdir -p "$RUNNER_DIR"
cd "$RUNNER_DIR"

# Download runner
log "Downloading GitHub Actions runner v${RUNNER_VERSION}..."
curl -sL "$RUNNER_URL" -o "$RUNNER_TAR"

if [ ! -f "$RUNNER_TAR" ]; then
  err "Download failed"
  exit 1
fi

# Extract
log "Extracting runner..."
tar xzf "$RUNNER_TAR"
rm -f "$RUNNER_TAR"

# Configure runner
log "Registering runner with repository..."
./config.sh \
  --url "$REPO_URL" \
  --token "$REGISTRATION_TOKEN" \
  --name "$(hostname)" \
  --labels "$LABELS" \
  --work "_work" \
  --unattended \
  --replace

log "Runner registered successfully"

# Create systemd service
log "Creating systemd service..."
SERVICE_FILE="/etc/systemd/system/github-runner.service"

sudo tee "$SERVICE_FILE" > /dev/null << 'SYSTEMD'
[Unit]
Description=GitHub Actions Runner
After=network.target

[Service]
Type=simple
User=edouard
WorkingDirectory=/home/edouard/actions-runner
ExecStart=/home/edouard/actions-runner/run.sh
Restart=always
RestartSec=5
KillSignal=SIGTERM
TimeoutStopSec=10

[Install]
WantedBy=multi-user.target
SYSTEMD

# Enable and start the service
log "Enabling and starting the runner service..."
sudo systemctl daemon-reload
sudo systemctl enable github-runner.service
sudo systemctl start github-runner.service

# Verify
sleep 2
if systemctl is-active --quiet github-runner.service; then
  log "Runner service is running!"
  log ""
  log "Verify in GitHub: Settings → Actions → Runners"
  log "The runner should appear as 'Online' with labels: $LABELS"
  log ""
  log "Useful commands:"
  log "  systemctl status github-runner    — check status"
  log "  journalctl -u github-runner -f    — view logs"
  log "  sudo systemctl restart github-runner — restart"
else
  err "Runner service failed to start"
  err "Check logs: journalctl -u github-runner -e"
  exit 1
fi
