# Night log, 4 October 2026: hub + app + crypto

Running log of the night build (brief: thin hub on hub.trommi.com, static E2E app on app.trommi.com, agents as E2E members).

## Shipped

- 02:15 **M1 live: thin hub on https://hub.trommi.com** (stream A, commit 528fa73; crypto header 3c6a0f3). `hub/server.mjs` (node:http + node:sqlite, no deps) replaces the hello stand-in; deploy runs crypto + hub tests, builds `hub/Dockerfile`, stops/backs up/starts. Live smoke from the PC: found, sign-in, post, read back (openVerifiedEnvelope), stream catch-up + live; POST→SSE latency p50 20.5 ms (17.9–40.3, 10 samples), SSE not buffered by the tunnel. Tests: hub 12/12, crypto 70/70, hub-test 16/16, server green. Server: `chown 1000:1000 /srv/trommi/data` (was root 700) so the container user can write; compose.yaml untouched. A throwaway smoke room (ae49694b…) stays on prod until a delete route exists. Dev hub for the streams: 127.0.0.1:8890 (scratchpad/hub-dev-data, pid scratchpad/hub-dev.pid). `deploy/hello` removed.
- 01:35–02:40 Protocol v1 → v1.1 in README (commits 39160d0 … 811725e): objects/timelines/registers/projections, seven kinds, timeline_kind+timeline_id, no plaintext names, derived tables, then the security rules R1–R9 from the two reviews (Claude, Codex). Info cards Nr. 214 (reviews) and 215 (research) on the PC board.
- 02:05 M1 live: https://hub.trommi.com runs hub/server.mjs (528fa73). healthz shows the commit; live smoke passed (found, sign-in, post, read, stream). POST→SSE p50 ~20 ms (17.9–40.3 ms over 10 envelopes), so no buffering by the tunnel. Tests: hub 12/12, crypto 70/70, hub-test 16/16.
- client/core on main (f463705 … cf3c055): 17 Node tests + browser test. Node verify 21.5k envelopes/s; Chromium 20k catch-up in 1.4 s, 0 long tasks; warm start 8 ms.
- Channel hub/channel.mjs (7d37db9, 2658081): 21 tests, including MCP stdio end to end.
- App live on https://app.trommi.com (trommi/trommi ebdb711). dev/e2e.mjs passes against production:
  - card agent→Desk 96 ms
  - encrypted picture shown 217 ms
  - answer/Undo/What?? reach the agent in 63–177 ms
  - second browser pairs by 6-digit code; read→gone on the other device 306 ms
- Streams running: A hub+crypto+deploy, B client core (`client/core/`, API in its README, b15ab91), C app (trommi/trommi), D agent channel, E verifier "Superkind", G admin (Tailscale login + password).

- Protocol v1 drafted in `README.md` ("Hub v1: the wire protocol"), awaiting two independent security reviews before freezing.

## Open issues / requests for the morning

- Cleanup plan ready (docs/cleanup-plan.md, dev/cleanup.sh, c4bba9e): 1,581 files / 166 MiB to delete after the switch, dry run by default. A history rewrite would take .git from 164.7 to 7.2 MiB (bulk only). Blockers before --apply: channel-bridge imports server/richhtml.mjs; dev/session.mjs (board status for subagents) needs an E2E replacement; test.yml still runs server tests. Owner decisions are listed in the plan.

- Channel (stream D, done for v1.1): live smoke on hub.trommi.com: join 1.8 s, card to the human 101 ms after create_decision, decision event at the channel 84 ms after the answer. Open: R6 session keys, lease route, not ported (create_voiceover, share_asset, adopt_session, silent publish_asset), handback_withdrawn has no envelope; not yet tried in a real interactive Claude Code session. Throwaway rooms on prod: ae49694b…, 44dc925b… (delete after the test-room route exists).
- Morning: add `"trommi": { "command": "node", "args": ["/home/christopher/git/trommi/hub/channel.mjs"] }` to .mcp.json, start `claude --dangerously-load-development-channels server:board server:trommi`, invite the agent in the app, paste the link into the session.

- Admin view: code + 12 tests ready (Tailscale login + scrypt password, logout, change password), but the permission system refused the wiring twice. It needs the owner's own clearance in the session. A throwaway smoke room is on prod (to be deleted once the test-room delete route exists).

- Owner: confirm "rotation on agent join" (assumed yes, R6).
- Admin auth confirmed by the owner (Tailscale login + extra password); stream G was blocked once by the permission classifier before that confirmation.

## Numbers
