# Happy Discord Bot

Discord Bot that controls Claude Code sessions via Happy Coder's relay server. Single-user private bot with per-operation HITL permission approval.

## Features

- **Message forwarding** — Discord messages auto-forward to Claude Code, replies stream back
- **Permission HITL** — per-operation approval buttons (Yes / Allow All Edits / For This Tool / No)
- **Thread per session** — each Claude Code session maps to a Discord thread for parallel conversations
- **AskUserQuestion** — Claude's questions rendered as option buttons, answers sent as structured data
- **ExitPlanMode** — plan review with Approve / Reject (with feedback) buttons
- **TodoWrite progress** — task list displayed and updated as a pinned message
- **Typing & emoji signals** — typing indicator + thinking/tool-call emoji reactions
- **Attachment upload** — Discord file attachments written to CLI working directory via RPC
- **Permission persistence** — permission state saved per session, restored on bot restart
- **Permission replay** — pending permissions re-displayed on bot startup
- **Session management** — create, archive, delete sessions; batch cleanup of stale sessions
- **Usage tracking** — query token usage and cost per session or across all sessions

## Prerequisites

- Node.js 20+
- A Discord Bot token
- A Happy Coder account with paired agent credentials
- `happy` CLI daemon running (`happy daemon start`) for `/new` session creation

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
- Permissions: `Send Messages`, `Read Message History`, `View Channels`, `Manage Messages` (for pin/unpin), `Create Public Threads`, `Send Messages in Threads`, `Manage Threads`, `Add Reactions`

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
| `DISCORD_APPLICATION_ID` | Yes* | Application ID (Developer Portal → General Information) |
| `DISCORD_GUILD_ID` | No | Guild ID for fast command deployment (dev only) |
| `DISCORD_REQUIRE_MENTION` | No | Require @bot mention to forward messages (default: `false`) |
| `HAPPY_TOKEN` | No** | Happy API token (env-based auth) |
| `HAPPY_SECRET` | No** | Happy account secret, base64 (env-based auth) |
| `HAPPY_SERVER_URL` | No | Override relay URL (default: `https://api.cluster-fluster.com`) |
| `BOT_STATE_DIR` | No | Directory for state.json persistence (default: `~/.happy-discord-bot`) |

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

On startup, the bot:
1. Lists all active sessions from the relay API
2. Creates a Discord thread for each session (named `{directory} @ {host}`)
3. Replays any pending permission requests as buttons
4. Auto-selects the most recently active session

Messages sent in a thread auto-route to the bound session. Messages in the main channel go to the active session.

## Slash Commands

| Command | Description |
|---------|-------------|
| `/sessions` | List active sessions (active / archived), with thread links |
| `/stop` | Abort the current operation (thread-aware) |
| `/compact` | Compact session context (thread-aware) |
| `/mode <mode>` | Set permission mode (default / acceptEdits / bypass / plan) |
| `/new` | Create new session — pick directory or enter custom path |
| `/archive [session]` | Kill session process, preserve data, archive thread |
| `/delete [session]` | Permanently delete session + data + thread (with confirmation) |
| `/cleanup` | Batch delete archived sessions + orphan threads (with confirmation) |
| `/usage [period]` | Token usage & cost — session-scoped in threads, account-wide in channel |

Commands in a thread automatically resolve to that thread's session.

## npm Scripts

```bash
npm run dev              # Development with tsx
npm run build            # Compile TypeScript to dist/
npm start                # Run compiled JS
npm run deploy-commands  # Register Discord slash commands (run once)
npm run lint             # ESLint
npm run lint:fix         # ESLint auto-fix
npm test                 # Run tests (vitest)
npm run test:watch       # Run tests in watch mode
npm run test:e2e         # E2E smoke tests (requires .env.e2e, real services)
```

## Testing

Unit/integration tests use Vitest with all external dependencies mocked:

```bash
npm test
```

E2E smoke tests require a second Discord bot, a dedicated test channel, and a running `happy` daemon. See `e2e/` directory and `.env.e2e.example` for setup.
