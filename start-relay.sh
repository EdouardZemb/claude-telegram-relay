#!/bin/bash
# Wrapper for PM2 — ensures shell env doesn't override .env values
unset ANTHROPIC_API_KEY
unset TELEGRAM_BOT_TOKEN
exec bun run src/relay.ts
