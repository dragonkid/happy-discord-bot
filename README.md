# Happy Discord Bot

Discord Bot that controls Claude Code sessions via Happy Coder's relay server. Single-user private bot with per-operation HITL permission approval.

## Prerequisites

- Node.js 20+
- A Discord Bot token
- A Happy Coder account with paired agent credentials

## Setup

### 1. Install dependencies

```bash
npm install
```

### 2. Create Discord Bot

1. Go to [Discord Developer Portal](https://discord.com/developers/applications)
2. Create a new application → Bot
3. Enable **Privileged Gateway Intents** → **Message Content Intent**
4. Copy the Bot token

**Invite the bot** to your server:
- OAuth2 → URL Generator
- Scopes: `bot`, `applications.commands`
- Permissions: `Send Messages`, `Read Message History`, `View Channels`

### 3. Get Happy Coder credentials

**Option A: File-based (local development)**

```bash
npm install -g @slopus/agent
happy-agent auth login
```

This displays a QR code in the terminal. Scan it with the Happy Coder app:
**Settings → Account → Link New Device**. The app is required for this step — it performs a device pairing that transfers your encrypted account secret to the CLI.

Once paired, `~/.happy/agent.key` is created with your token and secret.

**Option B: Environment variables (deployment)**

Extract token and secret from an existing `agent.key`:

```bash
cat ~/.happy/agent.key
# Output: {"token":"...","secret":"..."}
```

Set them as `HAPPY_TOKEN` and `HAPPY_SECRET` in your environment.

### 4. Configure environment

```bash
cp .env.example .env
```

Fill in:

| Variable | Required | Description |
|----------|----------|-------------|
| `DISCORD_TOKEN` | Yes | Discord Bot token |
| `DISCORD_CHANNEL_ID` | Yes | Target channel ID (right-click → Copy Channel ID) |
| `DISCORD_USER_ID` | Yes | Your Discord user ID (right-click → Copy User ID) |
| `HAPPY_TOKEN` | No* | Happy API token (env-based auth) |
| `HAPPY_SECRET` | No* | Happy account secret, base64 (env-based auth) |
| `HAPPY_SERVER_URL` | No | Override relay URL (default: `https://api.cluster-fluster.com`) |

\* Either set `HAPPY_TOKEN` + `HAPPY_SECRET`, or have `~/.happy/agent.key` present.

## Run

```bash
# Development
npm run dev

# Production
npm run build
npm start
```

## Commands

```bash
npm run dev              # Development with tsx (auto-restart)
npm run build            # Compile TypeScript to dist/
npm start                # Run compiled JS
npm run deploy-commands  # Register Discord slash commands (run once)
```
