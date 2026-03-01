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

TODO: remove the dependency on the app and Happy Server api.cluster-fluster.com

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
| `DISCORD_APPLICATION_ID` | Yes* | Application ID (Developer Portal → General Information) |
| `DISCORD_GUILD_ID` | No | Guild ID for fast command deployment (dev only) |
| `HAPPY_TOKEN` | No** | Happy API token (env-based auth) |
| `HAPPY_SECRET` | No** | Happy account secret, base64 (env-based auth) |
| `HAPPY_SERVER_URL` | No | Override relay URL (default: `https://api.cluster-fluster.com`) |

\* Required for `npm run deploy-commands`.
\*\* Either set `HAPPY_TOKEN` + `HAPPY_SECRET`, or have `~/.happy/agent.key` present.

### 5. Deploy slash commands

Register bot commands with Discord (run once, or after adding new commands):

```bash
npm run deploy-commands
```

If `DISCORD_GUILD_ID` is set, commands deploy to that guild instantly. Otherwise they deploy globally (up to 1 hour propagation).

## Run

```bash
# Development
npm run dev

# Production
npm run build
npm start
```

## Starting a Claude Code Session

The bot monitors Claude Code sessions running through the Happy relay. You need at least one active session for the bot to interact with.

### Using `happy` CLI

```bash
# Install happy CLI (if not already installed)
brew install slopus/tap/happy

# Authenticate (first time only)
happy auth

# Start a Claude Code session in any project directory
cd ~/your-project
happy
```

The `happy auth` command will prompt you to authenticate via the Happy Coder mobile app (scan QR code) or web browser. Once authenticated, `happy` starts a Claude Code session connected through the relay.

### How the bot discovers sessions

On startup, the bot calls the relay API to list all active sessions and auto-selects the most recently active one. To refresh the session list after starting new sessions, use the `/sessions` command in Discord.

## Slash Commands

| Command | Description |
|---------|-------------|
| `/sessions` | List active Claude Code sessions |
| `/send <message>` | Send a message to the active session |
| `/stop` | Abort the current operation |
| `/compact` | Compact session context |
| `/mode <mode>` | Set permission mode (default/accept-edits/bypass/plan) |

## npm Scripts

```bash
npm run dev              # Development with tsx
npm run build            # Compile TypeScript to dist/
npm start                # Run compiled JS
npm run deploy-commands  # Register Discord slash commands (run once)
npm test                 # Run tests
```
