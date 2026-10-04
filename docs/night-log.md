# Night log, 4 October 2026: hub + app + crypto

Running log of the night build (brief: thin hub on hub.trommi.com, static E2E app on app.trommi.com, agents as E2E members).

## Shipped

- 03:27 **Cutover to protocol v1.1 live** (main 691ecc4; A crypto + hub, B core, D channel). hub.trommi.com: fresh hub.db (old one moved aside on schema version), online backup before the deploy (hub-20261004-012545.db.gz, 131 MB). v1.1 smoke from the PC on prod: found, session grant, room + session envelopes, read back, live POST→SSE p50 29 ms. Also shipped: sliced catch-up + global stream-buffer cap (256 MiB), incremental auto-vacuum, backups 7 + daily. Dev hub :8890 on v1.1 with fresh data.
- 03:15 Stream A: load-test leak fixed on prod (eb1ef81; heap flat over 20k envelopes, `hub/heap-test.mjs`). Local numbers after the fix: 80k envelopes at 800/s, POST→SSE delivery p50 0.6 / p95 1.3 / p99 2.0 ms, event loop max 11.7 ms (10 ms monitor resolution), heap 12–19 MB; hub.db 113 MB (1.4 KB/envelope incl. 256 B padded body); hub start 7.6 ms, lazy load of the 80k room 24 ms. Deploy now only on hub/, crypto/, workflow changes (db30474). Protocol v1.1 (review R1–R9, R6 session keys, BLOB columns, schema move-aside) is green on branch `hub-v11` and waits for the coordinated cutover; v1.1 dev hub on :8893, v1 dev hub on :8890.
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
- ~03:00 app areas (trommi/trommi):
  - Memo E2E (0551a5a): 19/20 checks; the gap is concurrent edits in the core, sent to B.
  - Pairing/devices/settings (2f3f0bf, 0c88861): QR (own encoder, zbarimg-verified), tap 1 of 4 codes, founding/recovery with the code shown once, device list with fingerprints, agent invite; e2e 18/18; QR in 48 ms, tap→joined 46 ms.
  - Password login and session handover are built but hidden until A's zcrypto v1.1 (branch hub-v11, 38ff44b) lands on main.
- Superkind first pass (a990b62, docs/parity.md): 42 states × 4 profiles; 37/39 decision round trips green through the real channel; app steps 27–75 ms locally. Turbo baseline: Desk cold 58 ms desktop / 128 ms phone 4x.
- Leak fixed (eb1ef81): heap flat over 20k envelopes.
- Pad/Desk paper E2E (trommi/trommi 66bb018, 2dae58d), two devices on a local hub:
  - pen up → stroke on the other device p50 28 ms; first piece of a live stroke 186–198 ms
  - area send → agent 35–39 ms
  - 20k strokes: snapshot 119–134 ms (257 KB); fresh reload 0.31 s (0.97 s at 4x CPU, longest task 108 ms)
  - Not yet run against production; no real touch test. Sessions still addressed by agent device id until R6. Info card Nr. 217.
- Card page (trommi/trommi b5a77df…a49f163): 17/17 card flows in the flow test (all decision flows, comments paged newest first, drafts, pen marks, versions, permission, info).
  - Crazy room: open card 15–20 ms desktop / 45–65 ms phone 4x; own comment 13 / 50 ms.
  - Open: answer → Desk repaint 240–280 ms on phone 4x (the Desk render path, with C).
- Phone (618d89e, dda34ca): parity at 390/360 light/dark; PWA update flow; long-press sheet 18–24 ms.
  - Phone 4x crazy room: first paint 573 ms, open session 127 ms, back to Desk 197 ms, longest task 444 ms (over budget, C on the Desk render path).
- Desk (trommi/trommi 33afa40, dbc49fc, c5bd7a3): 165/165 Desk checks at 1440 and 390.
  - Crazy room (300 open), desktop / phone 4x: answer 28 / 63 ms, Next 28 / 94 ms, patch 3.6 / 12.5 ms, longest task on phone 93 ms.
  - Open: whole-page switches on phone 4x take 95–150 ms (over the 100 ms budget).
- First load of the crazy room (113k envelopes) on a new device: 367 s → 31 s (C, cc891d3). The rest is core catch-up; a room snapshot (B) targets < 10 s.
- v1.1 (A crypto + hub, B core 20/20 incl. R6 isolation + handover, lease, cut, escrow login) is green on branch hub-v11. Coordinated cutover pending C (app) + D (channel).
- ~03:55 **v1.1 cutover live**: hub.trommi.com runs 691ecc4 (crypto + hub v1.1, core v1.1 with R6 session keys, room snapshot, channel v1.1). Verified by the lead on the merged head: crypto 74/74, hub-test 25/25, session-grants 4/4, hub 13/13, ops 9/9, core 21/21, channel 26/26, old server suite green. Prod hub.db wiped once (moved aside). New deploy backups use VACUUM INTO + gzip, 7 + daily. Global stream-buffer cap 256 MiB, catch-up sent in slices, incremental auto_vacuum.
- Room snapshot (B): first start of a 20k room 29 ms vs 1,039 ms full replay. Browser catch-up without snapshot ~13k envelopes/s, 0 long tasks.
- Session area (trommi/trommi 32eaf3a…035ca79): own message visible 2.4 ms desktop / 13 ms phone 4x; open session 45 / 145 ms; Earlier 6 / 25–35 ms.
- Superkind live pass (pre-cutover): 45/46 round trips green; agent→app 44–64 ms, click→agent ~103 ms, phone join incl. code 4.4 s.
- ~04:05 **app v1.1 live** (trommi/trommi 8748d6c). Prod e2e (app.trommi.com + hub.trommi.com) green 19/19, twice:
  - card 98 ms
  - encrypted picture 179 ms
  - answer/Undo/What?? at the agent 66–229 ms
  - phone pairs by tapping 1 of 4 codes
  - read on A → gone on B 269 ms
  - warm Desk 63 ms
  Prod v1.1 smoke by A: POST→SSE p50 29 ms.
- Outsider share links live (hub 3047372): `shares` table, uploader-only create, public GET with x-share-secret (timing-safe, 60/min/IP, Range). Channel share_asset is being wired (D), the viewer by C.
- Channel live smoke on v1.1 prod (e719675): join + session assigned 1.8 s, card 91 ms, decision 85 ms, chat 50 ms; the session is named after its folder.
- The v1 bytes/vectors are deliberately NOT frozen yet: they freeze after the second security review of the implemented code (requested from the coordinator).
- KISS pass:
  - App: ~1,300 lines of dead code removed (ui.js 1276 → 121, old islands, Dev menu leftovers, duplicate pen tables and base64url).
  - Channel: module surface trimmed.
  - README protocol and krypto-konzept brought in line with the code.
  - Proposals for hub/crypto/core (duplicated HTTP helpers, session-grants copying zcrypto internals, FORMAT.md §6/§9 stale) were handed to S1/S2/C.
  - Left on purpose: channel-bridge question parsing and hub/push.mjs copy old-board code until the old board retires.
- 04:50 the account usage limit killed every stream mid-step. Resumed 04:55 at a reduced pace: security fixers D, S1, S2 and integrator C first; parity fixer, Superkind, F and fuzz triage paused until the security fixes land. Half-done work found only in S1's worktree (session-grants, ops flow/test-rooms), handed back to S1.
- Review-2 fixes landed:
  - CRITICAL path traversal fixed in the channel (3f6b0ce; PoC as a regression test).
  - Lease fencing required (1922506).
  - Slot-lock race fixed with atomic link/rename (9b24958; 4 processes × 8 runs, exactly one winner).
  - join is CLI-only, with no MCP tool (9b24958).
  - Agent invites default to without history (app 60db893).
- App warm reload now cache-first in the SW: desktop 236 → 47–57 ms (Turbo 34), phone 4x 130–150 ms. Cold desktop 260–550 ms (80 files, no build step; Turbo 58). Prod e2e 19/19.
- S1 hub/crypto review-2 fixes done (1d57cd7, fc4883e, 005422d, 16f71c4, 8249435, 657637c, 3e48540, 19b87db). Suites: crypto 76, hub-test 28, grants 8, hub 21, ops 10, core 21, channel 30, server ok.
  - Grants from removed humans refused; session keys must change after a member change.
  - Slow-upload slot exhaustion: timeouts, a per-address cap, a reserved pool for membership.
  - Attachment hijack closed; re-authorisation after the body is read; verified ephemeral relay; cf-connecting-ip trusted only from private peers.
  - FORMAT.md rewritten from the code (§19 grants, §20 refusals and void records).
  - Test key off by default; new key at ~/.local/share/trommi/hub-test-key.v2.
  - Escrow v2 addressed by a passphrase-derived id; pending uploads swept after 1 h; challenge flood can't lock out sign-in.
  - Still open (README): C22 attachment padding, M6 recovery-key change, escrow still PBKDF2, per-device byte budgets, agents see room metadata.
- Channel slot lock: the stale-lock takeover had a real double-winner race. Rewritten as claim files without any takeover (63d35e4); stress 8×50 and 4×60 runs, exactly one winner; channel 32/32 five runs in a row.
- S2 core fixes on main: 8075516 ids, 41d71bc handover rotates + fsync write-ahead + history boundary, 77fb6ec per-agent history, 12ab66b no chain rewind (void records), a262672 Lamport register order, d59201b crash-safe re-key + real recovery cuts, 2fd5fef snapshot trust. 5bf1127 (live epoch/assignment check) broke app→agent answers in C's prod e2e. The app vendor is pinned at d59201b (prod green 19/19) while S2 investigates.
- **Superkind final (fb6e35c, docs/parity.md):** 232 ok, 10 gap, 4 n/a, 105 todo of 351 rows. Live round trips through the real channel with CLI join: **48/48 green** (every decision flow, allow/deny, second device with check code, outsider share link). Live agent → visible 41–65 ms, click → agent 52–105 ms.
  - Perf vs Turbo (desktop / 4x / phone 4x): cold Desk 116/244/257 vs 58/80/128 ms (app ~2x slower cold); warm 77/179/182 vs 34/57/83 ms; navigation faster (desk→session 105/158/170 vs 192/391/281 ms); longest task 62/140/111 ms.
  - Open gaps: presence shown disconnected (C); 4 channel P3 items (D); 5 small P3 items (fixer). By design: no voiceover/read-aloud.
- **Parity final (677f51b):** 247 ok, 2 gap, 4 n/a, 98 todo of 351 rows.
  - Gaps: presence takes ~57 s after a new join (C fixing); no voiceover / read-aloud (no speech service on the new hub, by design for now).
  - The 98 todo rows (memo/pad details, phone layout details, agents-page actions, push/PWA, admin) were not checked.
  - All P3 channel items fixed (47b4da0, e37528e).
  - Live presence fixed (df15ada).
  - Batched session grants on removal (eef3452).
- **Load/perf (F, 7008157, docs/perf-night.md, info card Nr. 220).** Local means the real hub code on this PC; live means hub.trommi.com measured from outside.
  - Memory: hub RSS flat at 160–220 MB from 0 to 1.19M envelopes (local). Before the leak fix it was 1.6 GB and rising.
  - 1,000 stalled streams: 177 → 212 MB, probe p99 89 ms. Before the fix: 5 GB and minute-long stalls.
  - Throughput: 2,826/s max, 1,762/s sustained to 1.19M. Delivery p99 5–24 ms up to 900/s.
  - Catch-up of 1.18M envelopes: 141 s. hub.db is 1.6 KB per envelope.
  - Chat next to 10k strokes: one covering-index hit, 1 ms.
  - Live normal room: delivery p50 45 ms, p99 72–114 ms; a fresh device catches up 5.2k envelopes in 3.1 s.
  - App, crazy room v1.1 with snapshot (40 % scale): first load 2.4 s desktop / 3.4 s phone (v1.0 core was 367 → 29 s).
  - Budgets: desktop ≈ pass. **Phone fails**: open/switch session and card thread p95 290–580 ms, long tasks up to 501 ms.
  - Not done: 1M on prod (test key off, no server metrics). The canvas without a snapshot takes 6.8/19.8 s for 20k strokes.
- Hub restart forgot agent leases, so every deploy would have stopped running channels. Found by C; S2 is fixing it (persisted leases). Answer durability across a hub restart was verified by C (5e4d91b): nothing lost, delivered 0.85 s after the hub returns.
- After a snapshot join, histories don't show (F). S2 is fixing it.
- Streams running: A hub+crypto+deploy, B client core (`client/core/`, API in its README, b15ab91), C app (trommi/trommi), D agent channel, E verifier "Superkind", G admin (Tailscale login + password).

- Protocol v1 drafted in `README.md` ("Hub v1: the wire protocol"), awaiting two independent security reviews before freezing.

## Open issues / requests for the morning

- Prod has throwaway rooms that cannot be deleted (no delete for non-test rooms): e.g. cd1ef8bf0ed4 (5k envelopes, F), v1.1 smoke rooms, Superkind's room. Cleanup = one approved wipe via deploy (schema bump), with Christopher, before real use.
- Perf regression on core v1.1 found by F: ~90 ms CPU per own envelope with 5,300 cards (O(cards)); removing an agent with 24 sessions takes 1.7–2.3 s (one grant post per session). S2 is on both.

- Second security review (Codex, code at 691ecc4+): 9 HIGH findings, several reproduced (scratchpad/review2-codex.md). Fixes are running:
  - S1 hub/crypto: grants from removed humans, slot exhaustion, attachment hijack, ephemeral verification, forwarded-IP trust, FORMAT.md
  - S2 core: handover always rotates, atomic re-keying, transitive register order, no chain rewind, fsync write-ahead, history after state loss, epoch/assignment checks, snapshot trust
  - D: required lease fencing + lease renewal bug
  The Claude round-2 review is also in (scratchpad/review2-claude.md). It adds a CRITICAL path traversal: a human member could write files on the agent's machine via attachment_id. Fixed first by D + S2. Also: per-agent with_history, recovery cuts, slot-lock race, escrow redesign, quota TTL, challenge flood, join made a human/CLI action, invites default to no history, test key off by default. A third short verification pass by both reviewers follows the fixes. **Not ready for real users until both reviews' HIGH items are fixed and verified.**

- Hub ops live (A2, 1b12490/e03907e/4034cd6/8dcf20f). Version endpoint + 426; signed test rooms (Ed25519 key, private key at ~/.local/share/trommi/hub-test-key); 512-write queue with 503; 4 MiB per-stream buffer with drop + resume; WAL checkpoints; quota 1 GiB with eviction; escrow route; metrics on METRICS_PORT only. Local: 4,220 env/s, 36 µs SQLite per envelope, ~1.4 KB per envelope. **Needs server clearance (refused for agents):** compose METRICS_PORT=8792 + METRICS_HOST=0.0.0.0 + ports 127.0.0.1:8792:8792, and HUB_MIN_* version minimums.

- Cleanup plan ready (docs/cleanup-plan.md, dev/cleanup.sh, c4bba9e): 1,581 files / 166 MiB to delete after the switch, dry run by default. A history rewrite would take .git from 164.7 to 7.2 MiB (bulk only). Blockers before --apply: channel-bridge imports server/richhtml.mjs; dev/session.mjs (board status for subagents) needs an E2E replacement; test.yml still runs server tests. Owner decisions are listed in the plan.

- Channel (stream D, done for v1.1): live smoke on hub.trommi.com: join 1.8 s, card to the human 101 ms after create_decision, decision event at the channel 84 ms after the answer. Open: R6 session keys, lease route, not ported (create_voiceover, share_asset, adopt_session, silent publish_asset), handback_withdrawn has no envelope; not yet tried in a real interactive Claude Code session. Throwaway rooms on prod: ae49694b…, 44dc925b… (delete after the test-room route exists).
- Morning: add `"trommi": { "command": "node", "args": ["/home/christopher/git/trommi/hub/channel.mjs"] }` to .mcp.json, start `claude --dangerously-load-development-channels server:board server:trommi`, invite the agent in the app, paste the link into the session.

- Admin view: code + 12 tests ready (Tailscale login + scrypt password, logout, change password), but the permission system refused the wiring twice. It needs the owner's own clearance in the session. A throwaway smoke room is on prod (to be deleted once the test-room delete route exists).

- Owner: confirm "rotation on agent join" (assumed yes, R6).
- Admin auth confirmed by the owner (Tailscale login + extra password); stream G was blocked once by the permission classifier before that confirmation.

## Numbers
