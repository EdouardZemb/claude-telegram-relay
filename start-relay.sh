#!/bin/bash
# Wrapper for PM2 — ensures ANTHROPIC_API_KEY is unset so Claude CLI uses Max subscription
unset ANTHROPIC_API_KEY
exec bun run src/relay.ts
