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
| Deploy | `deploy/` (systemd unit, nginx TLS proxy, install script), fork-only Windows installer workflow | See `deploy/README.md`. |

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
- Single shared `BRIDGE_API_KEY`. Per-device tokens would need a client
  change in the pairing flow; nginx `limit_req`/`limit_conn` and the
  constant-time check are the mitigation for now.

## Known remaining weaknesses

- The key still travels in the WebSocket URL (`?token=`); nginx logs are
  configured not to record the query string.
- Everything runs as root because `claude` must act as the owner; the
  systemd unit only adds the hardening directives that do not break that.
- Push notifications need Firebase, which this server cannot reach.
