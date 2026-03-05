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

## Key Files

```
src/
├── index.ts              # Entry point, message forwarding + mention filtering
├── config.ts             # Env var loading (incl. requireMention)
├── bridge.ts             # Glue: Happy events ↔ Discord messages/buttons + typing/emoji
├── store.ts              # Bot state persistence (~/.happy-discord-bot/state.json)
├── happy/
│   ├── client.ts         # HappyClient: Socket.IO + sessionRPC + HTTP
│   ├── permission-cache.ts  # Tool approval caching (allowedTools, BashLiterals)
│   ├── state-tracker.ts  # agentState monitoring, permission request detection
│   └── types.ts          # RPC request/response types
├── discord/
│   ├── bot.ts            # Discord client init + event routing + typing/reaction methods
│   ├── commands.ts       # Slash command handlers
│   ├── buttons.ts        # Button builders (permission, AskUserQuestion, session, ExitPlanMode)
│   ├── interactions.ts   # Button interaction handlers (ask, session, ExitPlanMode)
│   ├── formatter.ts      # Code fence-aware message chunking, code blocks, diff formatting
│   └── deploy-commands.ts  # One-time slash command deployment
└── vendor/               # Vendored from happy-agent (~800 lines)
    ├── encryption.ts     # AES-256-GCM + XSalsa20 + key derivation
    ├── credentials.ts    # ~/.happy/agent.key read/write
    ├── api.ts            # REST API (listSessions, getMessages, etc.)
    └── config.ts         # Happy server config loading
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

Both react on user's last Discord message (`lastUserMsgId`). `/send` commands have no message ID — typing only.

### Direct Message Forwarding
User messages in the configured channel auto-forward to CLI via `bridge.sendMessage()`. Optional `DISCORD_REQUIRE_MENTION=true` requires @bot mention (strips mention text before forwarding).

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

Happy credentials (one of):
- `HAPPY_TOKEN` + `HAPPY_SECRET` env vars, or
- `~/.happy/agent.key` file (created by `happy-agent auth login`)

## Commands

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
- 11 test suites, 220 tests
- Test files: `src/**/__tests__/*.test.ts`
- All Happy/Discord dependencies mocked (no real connections needed)

## E2E Smoke Tests

Real end-to-end tests using a second Discord bot + live Happy relay. Located in `e2e/` directory (separate vitest config).

**Setup:**
1. Create a second Discord bot (test bot) and add to same server
2. Create a dedicated test channel (both bots have access)
3. Copy `.env.e2e.example` to `.env.e2e` and fill in values
4. Ensure happy daemon is running (`happy daemon start`)
5. Ensure at least one CLI session is active

**Run:** `npm run test:e2e`

**Test scenarios:** Message E2E flow, permission auto-approve via state.json, bot restart recovery.

## Gotchas

- **`agentState` has no `state` field** — only `controlledByUser`, `requests`, `completedRequests`. Thinking status comes from `ephemeral` Socket.IO events, not agentState.
- **`chunkMessage` reserves 24 chars** — for code fence close/reopen overhead when splitting. Final chunks may be slightly under 2000 chars.
- **Discord `sendTyping()` has no stop API** — typing disappears on timeout (~10s) or when bot sends a message.

## Vendor Modules

Copied from `~/Coding/happy/packages/happy-agent/src/`. Dependencies: `node:crypto` + `tweetnacl` (no React Native).

Vendor source cannot be directly imported from happy-agent because its package.json only exports the CLI entry point (index.ts), not library modules.

## Research Documents

- Obsidian: [[Happy-Discord-Bot-Plan]] — full implementation plan
- Obsidian: [[Happy-Coder-Mobile-Architecture]] — mobile app architecture analysis
- Obsidian: [[Claude-Code-Remote-Control-Research]] — five-route comparison
