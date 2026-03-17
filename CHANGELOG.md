# Changelog

## v0.1.6

### Features

- **Connected machines in daemon status** -- `daemon status` now shows online/offline machines from the relay API, independent of sessions
- **Daemon restart command** -- `daemon restart` stops and restarts the background daemon
- **Daemon logs command** -- `daemon logs` tails the daemon log file
- **Init reconfig** -- `init` now supports reconfiguration with existing values as defaults
- **/new works on fresh accounts** -- discovers machines via `GET /v1/machines` when no sessions exist, shows "Enter directory path..." button

### Fixes

- **Machine hostname shown in daemon status** -- was displaying machine ID prefix instead of hostname due to incorrect metadata type guard
- **Remote ~ expansion** -- `/new` custom path modal now expands `~` using the remote machine's home directory instead of the bot's local `$HOME`
- **Daemon error messages surfaced** -- `createNewSession` now extracts and displays actual daemon errors instead of generic "Daemon did not return a sessionId"
- **Webhook timeout recovery** -- when daemon's session webhook times out (slow CLI startup), bot falls back to polling for the new session for up to 60s
- **/approve uses correct endpoint** -- terminal auth now uses the right API endpoint

### Docs

- Restructured README with better onboarding flow and Discord UI mockups
- Recommend running `happy` directly in a project directory as primary session start method
- Clarified `/approve` as account linking step in setup flow

### Chore

- 600 tests across 27 suites
- Makefile: `make install` builds and installs globally
