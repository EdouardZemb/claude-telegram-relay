# Setup Guide

> For new users setting up the project. Walk through one phase at a time.
> If this is a fresh clone, run `bun run setup` first.

## Phase 1: Telegram Bot (~3 min)

**You need from the user:**
- A Telegram bot token from @BotFather
- Their personal Telegram user ID

**What to tell them:**
1. Open Telegram, search for @BotFather, send `/newbot`
2. Pick a display name and a username ending in "bot"
3. Copy the token BotFather gives them
4. Get their user ID by messaging @userinfobot on Telegram

**What you do:**
1. Run `bun run setup` if `.env` does not exist yet
2. Save `TELEGRAM_BOT_TOKEN` and `TELEGRAM_USER_ID` in `.env`
3. Run `bun run test:telegram` to verify — it sends a test message to the user

**Done when:** Test message arrives on Telegram.

## Phase 2: Database & Memory — Supabase (~12 min)

### Step 1: Create Supabase Project

**You need from the user:**
- Supabase Project URL
- Supabase anon public key

**What to tell them:**
1. Go to supabase.com, create a free account
2. Create a new project (any name, any region close to them)
3. Wait ~2 minutes for it to provision
4. Go to Project Settings > API
5. Copy: Project URL and anon public key

**What you do:**
1. Save `SUPABASE_URL` and `SUPABASE_ANON_KEY` to `.env`

### Step 2: Connect Supabase MCP

**What to tell them:**
1. Go to supabase.com/dashboard/account/tokens
2. Create an access token, copy it

**What you do:**
```
claude mcp add supabase -- npx -y @supabase/mcp-server-supabase@latest --access-token ACCESS_TOKEN
```

### Step 3: Create Tables

1. Read `db/schema.sql`
2. Execute it via `execute_sql` (or tell the user to paste it in the SQL Editor)
3. Run `bun run test:supabase` to verify tables exist

### Step 4: Set Up Semantic Search

**You need from the user:**
- An OpenAI API key (for generating text embeddings)

**What you do:**
1. Deploy the embed Edge Function via Supabase MCP (`deploy_edge_function` with `supabase/functions/embed/index.ts`)
2. Deploy the search Edge Function (`supabase/functions/search/index.ts`)
3. Tell the user to store their OpenAI key in Supabase:
   - Go to Supabase dashboard > Project Settings > Edge Functions
   - Under Secrets, add: `OPENAI_API_KEY` = their key
4. Set up database webhooks so embeddings are generated automatically:
   - Go to Supabase dashboard > Database > Webhooks > Create webhook
   - Name: `embed_messages`, Table: `messages`, Events: INSERT
   - Type: Supabase Edge Function, Function: `embed`
   - Create a second webhook: `embed_memory`, Table: `memory`, Events: INSERT, Function: `embed`
   - Create a third webhook: `embed_documents`, Table: `documents`, Events: INSERT, Function: `embed`

### Step 5: Verify

Run `bun run test:supabase` to confirm tables exist, Edge Functions respond, and embeddings work.

## Phase 3: Personalize (~3 min)

**Ask the user:** first name, timezone, occupation, time constraints, communication style.

**What you do:**
1. Save `USER_NAME` and `USER_TIMEZONE` to `.env`
2. Copy `config/profile.example.md` to `config/profile.md`
3. Fill in `config/profile.md` with their answers

## Phase 4: Test (~2 min)

1. Run `bun run start`
2. Tell the user to send a test message on Telegram
3. Confirm it responded, then Ctrl+C to stop

## Phase 5: Always On (~5 min)

**macOS:** `bun run setup:launchd -- --service relay`
**Linux:** `bun run setup:services -- --service relay` (uses PM2)
**Verify:** `npx pm2 status` (Linux) or `launchctl list | grep com.claude` (macOS)

## Phase 6: Proactive AI (Optional)

- `examples/smart-checkin.ts` — Periodic intelligent check-ins
- `examples/morning-briefing.ts` — Daily summary

Schedule: `bun run setup:services -- --service all`

## Phase 7: Voice Transcription (Optional)

**Option A: Groq (recommended)** — Set `VOICE_PROVIDER=groq` and `GROQ_API_KEY`
**Option B: Local whisper** — Set `VOICE_PROVIDER=local`, `WHISPER_BINARY`, `WHISPER_MODEL_PATH`
Verify: `bun run test:voice`

## After Setup

Run `bun run setup:verify` for full health check.
