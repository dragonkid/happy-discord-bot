# CLAUDE.md

## Overview

Discord Bot that controls Claude Code sessions via Happy Coder's relay server. Single-user private bot with per-operation HITL permission approval.

## Architecture

```
Discord (Gateway WebSocket) ↔ Bot ↔ Happy Relay (Socket.IO + REST) ↔ happy-cli ↔ Claude Code
```

Three-layer communication through Happy relay:
1. **Socket.IO Events** — real-time push (messages, agentState, heartbeat)
2. **HTTP REST** — message send (POST) / pull (GET), session management
3. **RPC over Socket.IO** — permission approval, remote commands, file operations

Bot connects as `user-scoped` client (monitors all sessions), unlike `session-scoped` (single session).

### Thread per Session

Each Claude Code session maps to a Discord thread. Main channel serves as thread container + status summaries.

```
Main Channel (status summaries only)
  +-- Thread: "happy-discord-bot @ macbook" -> session abc123
  +-- Thread: "my-project @ macbook"        -> session def456
```

- **Thread creation:** Auto-created on bot connect for sessions without threads, and on `/new` session creation. Anchor message sent to main channel, thread created on it.
- **Thread naming:** `{directoryName} @ {host}` from session metadata (e.g. `happy-discord-bot @ macbook`).
- **Message routing:** Messages in a thread auto-route to the bound session (no `activeSession` switch). Main channel messages fallback to active session. `activeSession` only changed via `/sessions` button or bot startup.
- **Command resolution:** `/stop`, `/compact`, `/mode`, `/archive`, `/delete`, `/loop` in a thread resolve to that thread's session via `resolveSessionFromContext()`. Explicit `session` parameter overrides. `/usage` in a thread auto-scopes to that session via `getSessionByThread()`.
- **Thread lifecycle:** `/archive` archives thread, `/delete` deletes thread + removes mapping.
- **Persistence:** Thread mapping (`sessionId -> threadId`) saved in `state.json` under `threads` field, restored on bot restart.
- **Output routing:** All bot output (text, permissions, TodoWrite, typing, emoji) routes to session's thread when available, falls back to main channel.

## Key Files

```
src/
├── cli.ts                # CLI entry point (bin), arg parsing, subcommand routing
├── version.ts            # Version from package.json (cached)
├── index.ts              # Bot entry point, message forwarding + thread routing + pendingApprove
├── config.ts             # Env var loading + ~/.happy-discord-bot/.env fallback
├── credentials.ts        # Bot credential CRUD (~/.happy-discord-bot/credentials.json)
├── bridge.ts             # Glue: Happy events ↔ Discord messages/buttons + typing/emoji + thread routing
├── store.ts              # Bot state persistence (~/.happy-discord-bot/state.json)
├── cli/
│   ├── auth.ts           # Auth CLI: login/restore/status/logout
│   ├── daemon.ts         # Daemon start/stop/restart/status (detached child_process)
│   ├── logs.ts           # Tail daemon log (tail -f daemon.log)
│   ├── update.ts         # Self-update (npm install -g + dual-process handoff)
│   └── init.ts           # Interactive config setup (~/.happy-discord-bot/.env)
├── happy/
│   ├── client.ts         # HappyClient: Socket.IO + sessionRPC + machineRPC + HTTP
│   ├── auth-approve.ts   # QR decode (jsqr+sharp) + device approve via NaCl box
│   ├── session-metadata.ts  # Session metadata decryption + directory extraction + threadName
│   ├── usage.ts          # REST API wrapper for /v1/usage/query (token/cost)
│   ├── skill-registry.ts # Skills/commands discovery (personal + project + plugins)
│   ├── permission-cache.ts  # Tool approval caching (allowedTools, BashLiterals)
│   ├── state-tracker.ts  # agentState monitoring, permission request detection
│   └── types.ts          # RPC request/response types
├── discord/
│   ├── bot.ts            # Discord client init + event routing + typing/reaction + thread CRUD
│   ├── commands.ts       # Slash command handlers (thread-aware session resolution)
│   ├── buttons.ts        # Button builders (permission, AskUserQuestion, session, ExitPlanMode, NewSession)
│   ├── interactions.ts   # Button interaction handlers (ask, session, ExitPlanMode, NewSession)
│   ├── formatter.ts      # Code fence-aware message chunking, code blocks, diff formatting
│   └── deploy-commands.ts  # One-time slash command deployment
└── vendor/               # Vendored from happy-agent (~800 lines)
    ├── encryption.ts     # AES-256-GCM + XSalsa20 + key derivation + NaCl box
    ├── credentials.ts    # Credentials type definition (type-only, no I/O)
    ├── api.ts            # REST API (listSessions, getMessages, etc.)
    └── config.ts         # Happy server URL config
```

## Happy Relay Protocol Reference

### Socket.IO Connection
- Endpoint: `https://api.cluster-fluster.com`
- Path: `/v1/updates`
- Auth: `{ token, clientType: 'user-scoped' }`
- Transport: websocket only

### sessionRPC Pattern
```typescript
// encrypt params → emitWithAck → decrypt result
socket.emitWithAck('rpc-call', {
  method: `${sessionId}:${method}`,
  params: await encrypt(params)
})
```

### Permission HITL Flow
1. Claude Code → `control_request` → happy-cli PermissionHandler
2. PermissionHandler → `agentState.requests` update → Relay push
3. Bot detects via `update-session` Socket.IO event
4. Bot checks PermissionCache → auto-approve or show Discord buttons
5. User clicks → `sessionRPC('permission', {id, approved, mode?, allowTools?})`
6. PermissionHandler resolves → `control_response` to Claude Code

### ExitPlanMode Flow
1. Claude calls `ExitPlanMode` (or `exit_plan_mode`) with `{ plan: "..." }`
2. Bot detects via agentState; short plans inline as ` ```md ` code block, long plans as `.md` file attachment
3. Discord shows Approve / Approve+AllowEdits / Reject buttons
4. Approve → `sessionRPC('permission', {id, approved: true, mode?})` → CLI injects PLAN_FAKE_RESTART
5. Reject → Discord Modal for optional feedback → `sessionRPC('permission', {id, approved: false, reason?})`
   - With feedback (`reason` present) → Claude continues with feedback, re-plans
   - Without feedback (`reason` absent) → CLI aborts, waits for new user input
6. CLI always denies the tool call itself (PLAN_FAKE_REJECT), restarts with new mode

### Typing Indicator + Emoji Reactions
Two independent signal sources:
- **Ephemeral activity** (`ephemeral` Socket.IO event, `{ type: 'activity', thinking: boolean }`) → typing loop (8s interval) + 🤔 emoji
- **Session protocol** (`new-message` with `role: 'session'`, `ev.t: 'tool-call-start'`/`'tool-call-end'`) → 🔧 emoji

Both react on user's last Discord message (`lastUserMsgId`). Thread-aware: typing and emoji route to the thread when `lastUserMsgThreadId` is set. `/send` commands have no message ID — typing only.

### TodoWrite Progress Display
Intercepts `tool-call-start` events for `TodoWrite` in session protocol messages. Formats the todo list and sends/edits a pinned Discord message.
- **First TodoWrite** → send new message + pin
- **Subsequent TodoWrite** → edit same message (keeps pin)
- **All completed** → final edit + unpin
- Only processes TodoWrite from sessions with registered encryption keys
- State (`todoMessageId`) resets on session switch

### Direct Message Forwarding
User messages in the configured channel auto-forward to CLI via `bridge.sendMessage()`. Optional `DISCORD_REQUIRE_MENTION=true` requires @bot mention (strips mention text before forwarding).

### Attachment Upload
When a Discord message includes attachments (images, PDFs, code files, etc.), the bot downloads each file, base64-encodes it, and writes it to the CLI working directory via `writeFile` RPC.
- Files stored in `.attachments/<timestamp>-<sanitized-name>`
- Directory created via `bash` RPC (`mkdir -p .attachments`) before first write
- 10MB size limit per file (checked against both Discord metadata and actual download)
- Filenames sanitized with `path.basename()` + character allowlist to prevent path traversal
- Hint text appended to forwarded message: `[Attached image: .attachments/... — use Read tool to view]`
- Pure-attachment messages (no text) are forwarded as hint-only messages

### /new Session Creation Flow
1. User runs `/new` → bot fetches all sessions via `listAllSessions()`, decrypts metadata
2. `extractDirectories()` deduplicates by path, filters E2E dirs, sorts by activeAt, limits to 25
3. Bot shows `StringSelectMenu` with directory options + "Custom path..." button
4. User selects directory (or enters custom path via modal) → `bridge.createNewSession(machineId, directory)`
5. `machineRPC('spawn-happy-session', {directory, approvedNewDirectoryCreation})` → daemon spawns CLI session
6. Bot polls `loadSessions()` to find new session → registers encryption key → sets active

**StringSelectMenu values use index-based encoding** (`String(i)`) instead of JSON to stay within Discord's 100-char value limit. Handler re-fetches sessions to resolve the index.

### /archive and /delete Session Lifecycle
- `/archive [session]` — Kill session process (data preserved): `sessionRPC('killSession', {})`
- `/delete [session]` — Permanently delete session + all data: `DELETE /v1/sessions/:id`
- Both default to current active session; optional `session` parameter accepts session ID prefix
- `/archive` executes directly; `/delete` shows "Confirm Delete" / "Cancel" buttons first
- Deleting the active session clears `activeSessionId`
- Both also manage the associated Discord thread: `/archive` archives the thread, `/delete` deletes the thread and removes the thread mapping

### /usage Token Usage Query
- `/usage` — In a thread: query that session's all-time usage. In main channel: query today's all-account usage (by hour).
- `/usage [period]` — Explicit period (`today`, `7d`, `30d`) queries all-account usage.
- Data source: `POST /v1/usage/query` REST API on relay server (server-side aggregation).
- Reply is ephemeral (only visible to command user).
- Output: session summary (tokens in/out/cache + cost) or time-grouped table with totals.

### /skills Command
- `/skills` — List all available skills/commands (personal + project + plugins).
- `/skills [name]` — Invoke a skill by sending `/<name>` to the thread's session (or active session in main channel).
- `/skills [name] [args]` — Invoke with arguments: `/<name> <args>`.
- `/skills reload` — Re-scan skills from disk (personal, plugins, project directories).
- **Autocomplete:** Searches by name and description with relevance ranking (exact > prefix > contains).
- **Project isolation:** Project-level skills (`.claude/skills/`, `.claude/commands/`) are per-session — each thread only sees its own session's project skills, merged with global (personal + plugin) skills.
- **Discovery sources:** (1) `~/.claude/skills/` + `~/.claude/commands/` (personal), (2) `<projectDir>/.claude/skills/` + `.claude/commands/` (project, per session), (3) enabled plugins via `installed_plugins.json`.

### /loop Command
- `/loop <args>` — Forward `/loop <args>` to the thread's session (or active session in main channel).
- Wraps Claude Code CLI's built-in `/loop` command which runs a prompt or slash command on a recurring interval.
- Example: `/loop 5m /compact` runs `/compact` every 5 minutes.

### /approve Command
- `/approve` — Two-step device authorization flow (replaces App's QR scan).
- Step 1: User runs `/approve` → bot enters `pendingApprove` state (60s timeout), replies with instructions.
- Step 2: User pastes QR screenshot → bot downloads image → `sharp` converts to RGBA → `jsqr` decodes QR URL.
- QR format: `happy:///account?<base64url-encoded ephemeral public key>`.
- Bot encrypts its secret via NaCl box for the ephemeral key → `POST /v1/auth/account/response`.
- Channel-scoped: only images in the same channel as `/approve` trigger QR detection.
- 10MB image size limit. Non-image attachments ignored.
- `pendingApprove` auto-clears on timeout or after processing.

### /cleanup Command
- `/cleanup` — Delete all archived (inactive) sessions and their associated Discord threads.
- Shows "Confirm Cleanup" / "Cancel" buttons before executing.
- Iterates all sessions, deletes inactive ones via `DELETE /v1/sessions/:id`, removes thread mappings.

### /update Command
- `/update` — Check npm registry for newer version; if available, run `npm install -g`, spawn new process with `--update-handoff`, wait for ready signal, then exit.
- Owner-only (same `DISCORD_USER_ID` check).
- Safe dual-process handoff: new process validates config + writes ready file, old process polls (30s timeout), on success old exits and new takes over Discord.
- On failure: old process continues running, reports error.

### /sessions Display
- Sessions grouped by host (from metadata), with directory name extracted from path.
- `Bot vX.Y.Z` version footer.
- "current" marker: thread-bound session in threads, activeSession in main channel.

### Self-Update Handoff Protocol
1. Old process installs new version via `npm install -g`
2. Spawns new process with `--update-handoff <oldPid>` flag
3. New process validates config, writes `~/.happy-discord-bot/update-ready` file
4. Old process polls for ready file (30s timeout)
5. On ready: old exits, new connects Discord + re-deploys slash commands
6. On timeout: old kills new process, continues running

### machineRPC Encryption
All machineRPC calls use the bot's own `secret` + `legacy` (XSalsa20-Poly1305) variant. Communication goes through the relay server — bot never connects directly to the daemon. No `~/.happy/` dependency.

### PermissionCache Logic (replicate from permissionHandler.ts:116-165)
Check order: Bash literal → Bash prefix → tool whitelist → permissionMode
- `bypassPermissions` → approve all
- `acceptEdits` + edit tool → approve
- Cache accumulates at runtime via user approvals
- **Per-session persistence:** Full permission state (mode, allowedTools, bashLiterals, bashPrefixes) saved per session in `~/.happy-discord-bot/state.json`. Session switches save/restore. Bot restart restores from disk.

### Key Source References

> Line numbers may drift — search by function/variable name if they don't match.

| Purpose | File | Lines |
|---------|------|-------|
| Socket.IO connection | happy-app/sync/apiSocket.ts | 58-69 |
| sessionRPC | happy-app/sync/apiSocket.ts | 114-129 |
| HTTP request wrapper | happy-app/sync/apiSocket.ts | 167-187 |
| Message send | happy-app/sync/sync.ts | 1544-1556 |
| Message receive | happy-app/sync/sync.ts | 1800-1806 |
| agentState detection | happy-app/sync/sync.ts | 1886-1890 |
| Permission RPC types | happy-app/sync/ops.ts | 13-20 |
| Permission cache | happy-cli/claude/utils/permissionHandler.ts | 116-165 |
| Bash permission parse | happy-cli/claude/utils/permissionHandler.ts | 236-260 |
| Approval button conditions | happy-app/components/tools/PermissionFooter.tsx | 389 |

## Environment

Required env vars (via `.env` or shell):
- `DISCORD_TOKEN` — Bot token from Discord Developer Portal
- `DISCORD_CHANNEL_ID` — Target channel for bot messages
- `DISCORD_USER_ID` — Owner's Discord user ID (single-user access control)
- `DISCORD_REQUIRE_MENTION` — (optional, default `false`) Require @bot mention to forward messages
- `BOT_STATE_DIR` — (optional, default `~/.happy-discord-bot`) Directory for state.json persistence

Happy credentials (checked in order):
1. `HAPPY_TOKEN` + `HAPPY_SECRET` env vars
2. `~/.happy-discord-bot/credentials.json` (created by `happy-discord-bot auth login`)

Bot does NOT read from `~/.happy/` — all credentials are self-managed.

## CLI Commands (npm global install)

```
happy-discord-bot start             # Run bot (foreground, default)
happy-discord-bot daemon start      # Run as background daemon
happy-discord-bot daemon stop       # Stop daemon
happy-discord-bot daemon restart    # Restart daemon (stop + start)
happy-discord-bot daemon status     # Show daemon status
happy-discord-bot auth login        # Generate new account (secret + Ed25519 → POST /v1/auth)
happy-discord-bot auth restore      # Input existing secret (base64url) to reuse account
happy-discord-bot auth status       # Show credential status
happy-discord-bot auth logout       # Delete stored credentials
happy-discord-bot update            # Check for updates and upgrade
happy-discord-bot init              # Interactive config setup
happy-discord-bot logs              # Tail daemon log output
happy-discord-bot deploy-commands   # Register Discord slash commands
happy-discord-bot version           # Show version
```

## Release & Publish

GitHub Actions automates npm publishing on release creation.

**Release flow:**
```bash
npm version patch          # bump version in package.json + create git tag
git push origin main --tags
gh release create v<version> --generate-notes
```

**Workflows:**
- `.github/workflows/ci.yml` — build + test + lint on push/PR to main
- `.github/workflows/publish.yml` — build → test → version check → `npm publish --provenance` on GitHub Release
- `.github/release.yml` — categorizes changelog by PR labels (feature, bug, other)

**Secrets required:** `NPM_TOKEN` (npm granular access token, scoped to this package)

**Version tag convention:** `v<semver>` (e.g. `v0.1.3`). Workflow verifies tag matches `package.json` version.

## npm Scripts (development)

```bash
npm run dev              # Development (tsx)
npm run build            # Compile TypeScript
npm start                # Run compiled
npm run deploy-commands  # Register Discord slash commands (once)
npm run lint             # ESLint
npm run lint:fix         # ESLint auto-fix
npm test                 # Vitest (run once)
npm run test:watch       # Vitest (watch mode)
npm run test:e2e         # E2E smoke tests (requires .env.e2e, real services)
```

## Testing

- Framework: Vitest
- 26 test suites, 581 tests
- Test files: `src/**/__tests__/*.test.ts`
- All Happy/Discord dependencies mocked (no real connections needed)

## E2E Smoke Tests

Real end-to-end tests using a second Discord bot + live Happy relay. Located in `e2e/` directory (separate vitest config). Each test auto-spawns a fresh CLI session via daemon HTTP API — no pre-existing session needed.

**Setup:**
1. Create a second Discord bot (test bot) and add to same server
2. Create a dedicated test channel (both bots have access)
3. Copy `.env.e2e.example` to `.env.e2e` and fill in values
4. Ensure happy daemon is running (`happy daemon start`)

**Run:** `npm run test:e2e`

**Test files:**

| File | Scenario | Requires HappyTestClient? |
|------|----------|--------------------------|
| `smoke-messaging.test.ts` | Message forwarding round-trip | No |
| `smoke-permission.test.ts` | `acceptEdits` auto-approve (no buttons shown) | No |
| `smoke-restart.test.ts` | Bot restart preserves permission state | No |
| `smoke-manual-permission.test.ts` | Manual permission approval via sessionRPC | Yes |
| `smoke-ask-user.test.ts` | AskUserQuestion option buttons + answer | Yes |
| `smoke-plan-mode.test.ts` | ExitPlanMode reject with feedback → revised plan → approve | Yes |
| `smoke-tool-signals.test.ts` | Typing indicator + 🔧 emoji during tool calls | No |
| `smoke-todowrite.test.ts` | TodoWrite progress display (best-effort) | No |
| `smoke-attachment.test.ts` | Attachment upload via writeFile RPC + Claude reads file | No |
| `smoke-thread.test.ts` | Thread creation + thread messaging + restart recovery | No |
| `smoke-usage.test.ts` | Usage data pipeline: message → relay usage API has token/cost data | No |

**E2E helper classes (`e2e/helpers/`):**

| Helper | Purpose |
|--------|---------|
| `DaemonClient` | HTTP API to spawn/stop CLI sessions via `~/.happy/daemon.state.json` |
| `BotProcess` | Spawn bot as subprocess, capture logs, start/stop/restart |
| `DiscordTestClient` | Second Discord bot: send messages/attachments, collect responses/typing/reactions |
| `HappyTestClient` | Connect to Happy relay for sessionRPC (approve/deny permissions) |
| `StateFile` | Write/read `state.json` for pre-seeding permission state |
| `wait.ts` | Polling `waitFor()` + `waitForExit()` utilities |

**E2E test pattern:** Each test spawns a fresh session → optionally pre-seeds permission state via `StateFile` → starts bot subprocess → sends Discord messages → asserts on bot responses/buttons/signals → cleans up session and state.

## Gotchas

- **`agentState` has no `state` field** — only `controlledByUser`, `requests`, `completedRequests`. Thinking status comes from `ephemeral` Socket.IO events, not agentState.
- **`chunkMessage` reserves 24 chars** — for code fence close/reopen overhead when splitting. Final chunks may be slightly under 2000 chars.
- **Discord `sendTyping()` has no stop API** — typing disappears on timeout (~10s) or when bot sends a message.
- **`EDIT_TOOLS` includes `Read`** — intentional divergence from upstream CLI (`getToolDescriptor.ts`). CLI's Write tool requires Read first (safety mechanism), so without Read in EDIT_TOOLS, `acceptEdits` mode deadlocks: Write auto-approved → Read blocked → "File has not been read yet" error.
- **E2E 🔧 emoji is transient** — tool-call emoji is added then removed quickly; `smoke-tool-signals` catches it best-effort without failing on miss.
- **E2E tests are non-deterministic** — Claude model responses vary; predicates should match loosely (e.g. check for keywords, not exact strings). Timeouts are generous (60-90s) to accommodate model latency.

## Vendor Modules

Copied from `~/Coding/happy/packages/happy-agent/src/`. Dependencies: `node:crypto` + `tweetnacl` (no React Native).

Vendor source cannot be directly imported from happy-agent because its package.json only exports the CLI entry point (index.ts), not library modules.

## Research Documents

- Obsidian: [[Happy-Discord-Bot-Plan]] — full implementation plan
- Obsidian: [[Happy-Coder-Mobile-Architecture]] — mobile app architecture analysis
- Obsidian: [[Claude-Code-Remote-Control-Research]] — five-route comparison
