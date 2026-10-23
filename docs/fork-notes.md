# Fork notes (dmitry575/ccpocket)

This fork runs a single-user, desktop-first bridge on a small Linux server
(2 CPU, 4 GB RAM) behind nginx with TLS. Nothing here is meant to go back to
upstream as a PR; the goal is to keep merging upstream cleanly, so changes are
kept small and local.

## What differs from upstream (October 2026)

| Area | Change | Why |
|---|---|---|
| Dependencies | ws 8.22, undici 7.30, sharp 0.35.5, Claude Agent SDK 0.3.308, MCP SDK 1.32 | `npm audit` had high/critical advisories (ws memory exhaustion before auth, undici TLS bypass over SOCKS, sharp/librsvg). |
| HTTP auth | `/usage`, `/doctor`, gallery list/upload/delete require the API key (`Authorization: Bearer` or `?token=`); `/health` hides counters without the key | These routes were reachable without the key through the public port. `GET /api/gallery/:id` stays capability based (random UUID) so image widgets keep working. |
| Key check | constant-time compare; refuse to start without a key on a non-loopback host (`BRIDGE_ALLOW_NO_AUTH=1` overrides) | Plain `!==` and silent "no auth" mode. |
| Robustness | URL parsing against a constant base; `unhandledRejection`/`uncaughtException` logged instead of killing every session; handler errors answered to the client; WebSocket `maxPayload`; gallery upload body cap 64 MiB | A hostile `Host` header or any thrown handler took the whole process down. |
| Sessions | resume of an already live Claude session attaches to it (or replaces an idle one when the client explicitly asks for other settings) | Two processes on one transcript interleave writes and cost ~300 MB each. |
| Capacity | `BRIDGE_MAX_LIVE_SESSIONS`, `BRIDGE_MAX_IDLE_SESSIONS`; idle sessions with live background tasks are never evicted | 30 idle `claude` processes do not fit in 4 GB; a backgrounded command wakes the session later. |
| Permissions | pending requests are denied and `permission_resolved` is sent on interrupt/stop/result; tool actions are routed by request id, never by "newest session" | Approval cards stayed open and a blind approve could hit another session. |
| Files / git | diff images resolve symlinks and re-check allowed roots; branch names validated with `git check-ref-format`; timeouts on every git call | Symlink read outside the project; `--orphan`-style names; a hung `git pull` froze the bridge. |
| Device tokens | `ccpocket-bridge devices add/list/rotate/revoke/remove`; hashes in `~/.ccpocket/devices.json`; accepted next to `BRIDGE_API_KEY`; connection log names the device | One shared key could not be revoked per device. |
| Permission timeout | `BRIDGE_PERMISSION_TIMEOUT_MINUTES` (60): unanswered requests are denied, `permission_resolved` + `tool_result` sent | A waiting session held its process forever and was never evicted. |
| External holder | resume refused with `session_held_externally` when `~/.claude/sessions` or `ps` shows another `claude` on the same id (`--resume`/`--session-id`); `forkSession` bypasses | Two writers on one transcript. Interactive `/resume` picks are not detectable. |
| Push | `BRIDGE_FIREBASE_API_KEY`, `BRIDGE_PUSH_RELAY_URL` | Point the relay at your own Firebase project instead of upstream's. |
| Session list | headless transcripts (`entrypoint` `sdk-*`: `claude -p`, cron jobs, other SDK hosts) are hidden unless the bridge created/resumed them (`~/.ccpocket/known-sessions.json`); `BRIDGE_SHOW_HEADLESS_SESSIONS=1` shows all | The owner runs many unattended `claude -p` writers that drowned the list. |
| Desktop layout | the session list pane has a drag handle (260px minimum, center pane keeps 360); width persisted in SharedPreferences | Requested for desktop-first use. |
| Subagent viewer | `GET /api/subagent?session=&toolUseId=|agentId=` (key required) reads `<session>/subagents/agent-<id>.jsonl` + `.meta.json`; Agent/Task cards get an "Open" button with a polling transcript screen | Upstream only shows a summary of subagent tool calls. |
| Input during a turn | a message sent while Claude works is handed to the CLI, which folds it into the running turn (like typing in the terminal); frames of subagents (`parent_tool_use_id`) no longer mark the session busy. `BRIDGE_INTERRUPT_ON_INPUT=1` restores upstream interrupt-and-resend | Upstream interrupted the turn on every new message; the interrupt also killed background subagents, and their frames kept an idle session "running". |
| Subagent frames | tool frames of subagents (`parent_tool_use_id`) are not forwarded to the chat; the Agent/Task card's "Open" shows them. `BRIDGE_SHOW_SUBAGENT_FRAMES=1` restores forwarding | They arrived unmarked, looked like the main agent's own tool calls and disappeared on history reload. |
| Safe restart | authorized `/health` lists `busy` sessions (turn in flight, pending permission, background tasks); `deploy/restart-when-idle.sh` restarts only when that list stays empty | Sessions are child processes of the bridge; a plain restart kills running turns and background subagents. |
| Deploy | `deploy/` (systemd unit, nginx TLS proxy, install script), fork-only Windows installer and all-platforms release workflows | See `deploy/README.md`. |

## Deliberately not changed

- **Session history loader** (`sessions-index.ts getSessionHistory`). Replacing
  the hand-written JSONL parse with the SDK's `getSessionMessages()` was
  evaluated on a real 5.5 MB transcript with compaction: the SDK follows the
  `parentUuid` chain correctly but (a) adds queued harness notifications
  (`<task-notification>`, subagent hand-backs) as user messages, (b) exposes
  `is_meta` with different semantics than the file's `isMeta` (the compaction
  summary is meta, "continued from another machine" is dropped entirely), and
  (c) drops `isVisibleInTranscriptOnly`. The Flutter client renders history
  from these flags, and it cannot be exercised on the server. The switch is
  possible but needs client-side filtering plus fixtures; deferred.
- Upstream workflows (`windows-release.yml` etc.) are untouched; the fork adds
  `windows-installer.yml` instead.
- The pairing UI in the app still shows one "API key" field: a device token
  is pasted there like the master key. No client change was needed.

## Known remaining weaknesses

- The key still travels in the WebSocket URL (`?token=`); nginx logs are
  configured not to record the query string.
- Everything runs as root because `claude` must act as the owner; the
  systemd unit only adds the hardening directives that do not break that.
- Push notifications need Firebase, which this server cannot reach.
