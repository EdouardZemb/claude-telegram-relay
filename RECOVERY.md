# Recovery Procedures

Emergency guide for when the bot stops responding or you can't access the server.

## Quick Diagnostic

If the bot stops responding on Telegram, follow this checklist in order:

1. Check if the server is reachable (SSH)
2. Check PM2 processes
3. Check relay logs
4. Restart if needed

## 1. SSH Access

### Normal Connection

```bash
ssh edouard@<SERVER_IP>
```

Replace `<SERVER_IP>` with your server's IP address. Authentication is by SSH key only (password disabled).

### SSH Troubleshooting

**"Connection refused"**
- The server might be down or SSH service stopped
- If you have physical/console access: `sudo systemctl start ssh`
- Contact your hosting provider if the server is unreachable

**"Connection timed out"**
- Check your internet connection
- Your IP might be banned by fail2ban (see below)
- The firewall might be blocking port 22

**"Permission denied (publickey)"**
- Your local SSH key doesn't match the server
- Check you're using the correct key: `ssh -i ~/.ssh/your_key edouard@<SERVER_IP>`
- If you lost your key, you need console access from your hosting provider to add a new one

### fail2ban (IP Ban)

fail2ban automatically bans IPs after failed SSH attempts. If you've been locked out:

**From the server (if you have another way in):**
```bash
# Check if your IP is banned
sudo fail2ban-client status sshd

# Unban your IP
sudo fail2ban-client set sshd unbanip YOUR_IP

# Whitelist your IP permanently (edit /etc/fail2ban/jail.d/sshd.conf)
# Add under [sshd]: ignoreip = YOUR_IP
sudo systemctl restart fail2ban
```

**If you can't SSH at all:**
- Use your hosting provider's console/VNC access
- Or wait for the ban to expire (usually 10 minutes by default)

## 2. Check PM2 Processes

Once connected via SSH:

```bash
# See all services
npx pm2 status

# Expected output: claude-relay (online), claude-dashboard (online), claude-autodeploy (online)
```

### Service is "errored" or "stopped"

```bash
# View recent logs for the relay
npx pm2 logs claude-relay --lines 50

# Restart the relay
npx pm2 restart claude-relay

# Restart all services
npx pm2 restart all
```

### Service keeps crashing (restart loop)

```bash
# Check error logs
cat ~/.claude-relay/logs/relay-error.log | tail -100

# Stop the service to investigate
npx pm2 stop claude-relay

# Try running manually to see the error
cd /home/edouard/claude-telegram-relay
bun run src/relay.ts
# Watch the output for errors, then Ctrl+C

# Once fixed, restart via PM2
npx pm2 start ecosystem.config.cjs
```

### PM2 not found or lost process list

```bash
# Reinstall PM2 processes from config
cd /home/edouard/claude-telegram-relay
npx pm2 start ecosystem.config.cjs
npx pm2 save
```

## 3. Common Issues

### Bot not responding but server is up

1. Check PM2: `npx pm2 status`
2. If relay is online but not responding, check logs: `npx pm2 logs claude-relay --lines 20`
3. Possible causes:
   - Claude CLI not authenticated: run `claude` in terminal to re-authenticate
   - Telegram API issue: check https://downdetector.com/status/telegram/
   - Bot token revoked: see "Token Rotation" below

### Telegram Token Rotation

If the bot token is compromised or needs renewal:

1. Open Telegram, go to @BotFather
2. Send `/revoke` and select your bot
3. Copy the new token
4. Run the rotation script:

```bash
./scripts/rotate-token.sh <NEW_TOKEN>
```

The script validates the token format, updates `.env`, restarts PM2, and verifies the bot is back online. The old `.env` is backed up as `.env.bak`.

**Manual method** (if the script fails):
```bash
# Edit .env and replace TELEGRAM_BOT_TOKEN
nano /home/edouard/claude-telegram-relay/.env

# Restart the relay
npx pm2 restart claude-relay --update-env
```

**Important:** The bot will be offline between the `/revoke` and the restart (~5 seconds). This is normal.

### Lock file prevents startup

```bash
# If the bot says "Another instance running" but no instance exists
rm ~/.claude-relay/bot.lock
npx pm2 restart claude-relay
```

### Out of disk space

```bash
# Check disk usage
df -h

# Clean PM2 logs (can grow large)
npx pm2 flush

# Clean old temp files
rm -rf ~/.claude-relay/temp/*
rm -rf ~/.claude-relay/uploads/*
```

### High memory usage

```bash
# Check system memory
free -h

# Check PM2 process memory
npx pm2 monit

# Restart to free memory
npx pm2 restart all
```

## 4. Full Reset

If nothing else works:

```bash
# Stop everything
npx pm2 stop all

# Pull latest code
cd /home/edouard/claude-telegram-relay
git pull origin master

# Reinstall dependencies
bun install

# Clear lock and temp files
rm -f ~/.claude-relay/bot.lock
rm -rf ~/.claude-relay/temp/*

# Start fresh
npx pm2 start ecosystem.config.cjs
npx pm2 save

# Verify
npx pm2 status
npx pm2 logs claude-relay --lines 10
```

## 5. Dashboard Not Loading

```bash
# Check if dashboard is running
npx pm2 status claude-dashboard

# Restart dashboard
npx pm2 restart claude-dashboard

# Check what's on port 3456
ss -tlnp | grep 3456

# Check Caddy reverse proxy (if configured)
sudo systemctl status caddy
sudo caddy reload --config /home/edouard/claude-telegram-relay/Caddyfile
```

## 6. Useful Paths

| What | Path |
|------|------|
| Project root | `/home/edouard/claude-telegram-relay` |
| PM2 config | `/home/edouard/claude-telegram-relay/ecosystem.config.cjs` |
| Environment vars | `/home/edouard/claude-telegram-relay/.env` |
| Relay logs | `~/.claude-relay/logs/relay-*.log` |
| Dashboard logs | `~/.claude-relay/logs/dashboard-*.log` |
| Lock file | `~/.claude-relay/bot.lock` |
| Reminders | `~/.claude-relay/reminders.json` |
| Session | `~/.claude-relay/session.json` |
| User profile | `/home/edouard/claude-telegram-relay/config/profile.md` |

## 7. Server Info

- OS: Debian 13 (trixie)
- Hostname: openclaw-node
- SSH: Key-only auth, user `edouard`, port 22
- Firewall: UFW (port 22 open)
- fail2ban: active on SSH
- Process manager: PM2
- Runtime: Bun
