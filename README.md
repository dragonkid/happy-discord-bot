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
- **Built-in auth** — bot manages its own Happy account (`auth login` / `auth restore`), no external tools needed
- **Device approval** — `/approve` command to link new devices to your Happy account via QR code screenshot (replaces mobile app scan)

## Installation

### Global install (recommended)

```bash
npm install -g happy-discord-bot
happy-discord-bot init              # Interactive config setup (~/.happy-discord-bot/.env)
happy-discord-bot auth login        # Create Happy account (or `auth restore` with existing secret)
happy-discord-bot deploy-commands   # Register Discord slash commands
happy-discord-bot daemon start      # Run as background daemon
```

`init` prompts for Discord token, channel ID, user ID, and application ID. Config is saved to `~/.happy-discord-bot/.env` with restrictive file permissions (0600).

`auth login` generates a new Happy account (secret + Ed25519 keypair → challenge-response auth). Credentials are saved to `~/.happy-discord-bot/credentials.json`. If you already have a secret from another device, use `auth restore` to input it.

### From source (development)

```bash
git clone https://github.com/nicholasgriffintn/happy-discord-bot
cd happy-discord-bot
npm install
cp .env.example .env                # Edit with your credentials
npm run deploy-commands
npm run dev
```

## Prerequisites

- Node.js 20+
- A Discord Bot token
- A Happy Coder account (created via `auth login`, or restored from existing secret via `auth restore`)
- `happy` CLI daemon running on the target machine for `/new` session creation

## Setup (from source)

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

**Option A: Built-in auth (recommended)**

```bash
happy-discord-bot auth login
```

Creates a new Happy account. The bot generates a 32-byte secret, derives an Ed25519 keypair, and registers with the relay server. Credentials are saved to `~/.happy-discord-bot/credentials.json` (mode 0600).

The command prints a backup key (base64url-encoded secret). **Save it** — you'll need it to restore access on another machine via `auth restore`.

After login, the bot needs to be linked to an existing Happy account. From an already-linked device, use the `/approve` Discord command (see below) or scan the QR code from the Happy mobile app to share the account secret with the bot.

**Option B: Restore from existing secret**

```bash
happy-discord-bot auth restore
```

Prompts for a base64url-encoded secret (from a previous `auth login` backup or another device). Validates the secret length (32 bytes), authenticates with the relay, and saves credentials.

**Option C: Environment variables (CI/deployment)**

Set `HAPPY_TOKEN` and `HAPPY_SECRET` in your environment or `.env` file. These take precedence over `credentials.json`.

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
\*\* Either set `HAPPY_TOKEN` + `HAPPY_SECRET`, or run `happy-discord-bot auth login` to create `credentials.json`.

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
| `/skills [name] [args]` | List, search, or invoke Claude Code skills/commands (with autocomplete) |
| `/loop <args>` | Run a prompt or skill on a recurring interval (e.g. `5m /compact`) |
| `/approve` | Link a new device to your Happy account via QR code screenshot (two-step flow) |
| `/update` | Check for updates and upgrade the bot (safe dual-process handoff) |

Commands in a thread automatically resolve to that thread's session.

## CLI Commands

When installed globally (`npm install -g happy-discord-bot`):

```
happy-discord-bot start             # Run bot (foreground, default)
happy-discord-bot daemon start      # Run as background daemon
happy-discord-bot daemon stop       # Stop daemon
happy-discord-bot daemon restart    # Restart daemon (stop + start)
happy-discord-bot daemon status     # Show daemon status
happy-discord-bot update            # Check for updates and upgrade
happy-discord-bot init              # Interactive config setup
happy-discord-bot auth login        # Create new Happy account
happy-discord-bot auth restore      # Restore from existing secret
happy-discord-bot auth status       # Show credential status
happy-discord-bot auth logout       # Remove credentials
happy-discord-bot logs               # Tail daemon log output
happy-discord-bot deploy-commands   # Register Discord slash commands
happy-discord-bot version           # Show version
```

### Daemon mode

The daemon runs the bot as a detached background process. State is tracked in `~/.happy-discord-bot/daemon.state.json`.

```bash
happy-discord-bot daemon start      # Spawn detached process, print PID
happy-discord-bot daemon stop       # Send SIGTERM, wait for exit, clean up state
happy-discord-bot daemon restart    # Stop (if running) then start
happy-discord-bot daemon status     # Show PID, version, start time
happy-discord-bot logs              # Tail daemon log (stdout + stderr)
```

Use `logs` to monitor the daemon after starting it — helpful for verifying connection status or diagnosing errors.

### Updating

Two ways to update to the latest version:

**From the CLI:**

```bash
happy-discord-bot update
```

Checks npm registry, installs the new version globally, and restarts the daemon if running.

**From Discord:**

Use the `/update` slash command. The bot performs a safe dual-process handoff:
1. Installs new version via `npm install -g`
2. Spawns new process with `--update-handoff`
3. New process connects to Discord + Happy relay
4. New process signals ready via file
5. Old process exits gracefully

Zero downtime — the new process is fully connected before the old one shuts down.

### Config resolution

The bot loads `.env` from the first location found:
1. `.env` in the current working directory
2. `~/.happy-discord-bot/.env` (created by `init`)

Override the state directory with `BOT_STATE_DIR` env var.

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
