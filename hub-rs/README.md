# hub-rs: the thin hub in Rust

The hub of the README section "Hub v1: the wire protocol", rebuilt in Rust with the same behaviour as `hub/server.mjs`:
the same routes and answers, the same `hub.db` schema (either hub opens the other's data directory), the same
environment variables, the same Docker image shape. It is checked by the existing JavaScript suites, unchanged in what
they assert, run against the binary. **Production stays on the Node hub until the owner switches; nothing here is
deployed.**

| Path | What |
| --- | --- |
| `crates/zcrypto/` | the wire format of `shared/crypto/FORMAT.md` (member list, invites, sign-in, envelope header grammar and receiver checks, pruned form, session grants, plus the primitives the vectors need); `tests/vectors.rs` checks `shared/crypto/vectors.json` byte for byte (sealed boxes and wraps rebuilt with the vectors' generator) |
| `crates/hub/` | the binary `trommi-hub`: `server.rs` (routes, stream, presence, push, retention: `hub/server.mjs`), `room.rs` (`shared/crypto/hub.mjs`), `store.rs` + `db.rs` (`hub/store.mjs`), `ops.rs` + `metrics.rs` (`hub/ops/`), `accounts.rs`, `mail.rs`, `push.rs` (Web Push and APNs), `admin.rs` + `admin_view.rs` (`hub/admin.mjs`, `admin-view.mjs`), `control.rs` (test hooks, only with `HUB_TEST_CONTROL=1`) |
| `Dockerfile` | the static musl binary on `scratch` |
| `contract.sh` | every check below in one run |

## Build, run, image

```bash
~/.cargo/bin/cargo build --release            # in hub-rs/: target/release/trommi-hub (8.7 MB)
HUB_PORT=8890 HUB_DATA=/tmp/trommi-dev hub-rs/target/release/trommi-hub      # as `node hub/server.mjs`
trommi-hub backup <file>                       # VACUUM INTO: an online copy of $HUB_DATA/hub.db (hub/deploy-backup.sh)
trommi-hub healthcheck                         # GET /healthz on $HUB_PORT, exit 0/1 (the image's HEALTHCHECK)
trommi-hub hash < password                     # an admin password hash (as `node hub/admin.mjs hash`)
trommi-hub admin --db <hub.db> [--data <dir>] [--host 127.0.0.1] [--port 8791] [--published-loopback]   # the admin page alone
docker build -f hub-rs/Dockerfile --build-arg COMMIT=$(git rev-parse HEAD) -t trommi-hub-rs .           # from the repository root
```

The image is 13.7 MB (Node image: 257 MB): port 8790, volume `/data`, uid 1000 (the Node image's `node` user, so the
same volume stays writable), the same `ENV` lines as `hub/Dockerfile` (`NODE_ENV=production` included: it switches the
localhost origins off, as on the Node hub). `compose.yaml`, `apns.env`, `admin.env` and `compose.override.yaml` on the
server need no change. `hub/deploy-backup.sh` uses `trommi-hub backup` when the running image is this one.

**Switching** (the owner's call, not done): build this image instead of `hub/Dockerfile` in `.github/workflows/deploy.yml`
and `dev/deploy/hub.sh` (one line each), deploy, `/healthz` reports the commit as before. The data directory stays; a
switch back to the Node image reads it too (`dev/interop/run.mjs --switch-hub-cmd` shows both directions).

## Configuration

Every variable of the Node hub, with the same defaults: `HUB_PORT`, `HUB_HOST`, `HUB_DATA`, `HUB_URL`, `COMMIT`,
`HUB_ORIGINS`, `HUB_PREVIEW_ORIGINS`, `NODE_ENV`, `HUB_FOUND_TOKEN`, `HUB_MAX_ROOMS`, `HUB_TRUST_CF`, `HUB_APP_URL`,
`HUB_LOSS_MS`, `HUB_LIMIT_<NAME>` (each key of `LIMITS`), `HUB_WRITE_QUEUE`, `HUB_WRITE_QUEUE_MEMBERSHIP`,
`HUB_WRITE_PER_IP`, `HUB_STREAM_BUFFER_BYTES`, `HUB_STREAM_BUFFER_TOTAL_BYTES`, `HUB_WAL_TRUNCATE_BYTES`,
`ROOM_ATTACHMENT_QUOTA_BYTES`, `HUB_TEST_PUBLIC_KEY`, `HUB_MIN_APP|CONNECTOR|IOS`, `HUB_RECOMMENDED_APP|CONNECTOR|IOS`,
`HUB_UPGRADE_MESSAGE`, `HUB_WRITE_ENVELOPE_VERSION`, `HUB_WRITE_SCHEMA_VERSION`, `HUB_PUSH_HOSTS`, `HUB_PUSH_SUBJECT`,
`APNS_KEY` / `APNS_KEY_FILE`, `APNS_KEY_ID`, `APNS_TEAM_ID`, `APNS_TOPIC`, `HUB_MAIL_TRANSPORT`, `HUB_MAIL_OUTBOX`,
`HUB_ACCOUNT_UNVERIFIED_HOURS`, `HUB_ACCOUNT_EXPIRE`, `HUB_LIMIT_LOGINS_PER_IP_10MIN`,
`HUB_LIMIT_LOGIN_FAILURES_PER_EMAIL_HOUR`, `METRICS_PORT`, `METRICS_HOST`, `ADMIN_PORT`, `ADMIN_HOST`,
`ADMIN_PUBLISHED_LOOPBACK`, `ADMIN_LOGINS`, `ADMIN_PASSWORD_HASH`, `ADMIN_TZ`.

Only here, for what the Node tests pass to `startHub()` as options: `HUB_PING_MS` (25000), `HUB_RETENTION_EVERY_MS`
(a day), `HUB_STREAM_CAP_EVERY_MS` (1000), `HUB_BODY_TIMEOUT_MS` (15000), `HUB_APNS_HOSTS` (JSON `{ production, sandbox }`),
`HUB_QUIET=1` (no log), `HUB_TEST_CONTROL=1` (the `/__test/…` routes and the test clock: never in production).

## How it is checked

`hub-rs/contract.sh` runs all of it, one line per suite. The JavaScript suites start the binary through
`hub/external.mjs` when `HUB_CMD` names it: a `startHub()` of the same shape as `hub/server.mjs`'s (the test reads the same
`hub.db` with node:sqlite; `prune()`, `stats`, `ops.flow` and the other internals go over `/__test/…`; a test's clock
becomes the header `x-test-now`).

```bash
cargo test --release                                    # in hub-rs/: vectors.json and units
HUB_CMD=hub-rs/target/release/trommi-hub node hub/test.mjs           # also hub/ops/test.mjs, hub/accounts-test.mjs, hub/admin-test.mjs
node dev/interop/hub-diff.mjs --a='node hub/server.mjs' --b=hub-rs/target/release/trommi-hub --n=10000
node dev/interop/run.mjs --hub-cmd hub-rs/target/release/trommi-hub                # all pairs, Swift ones too
node dev/interop/run.mjs --switch-hub-cmd hub-rs/target/release/trommi-hub         # Node and Rust taking turns on one data dir
HUB_CMD=hub-rs/target/release/trommi-hub node connector/test-e2e.mjs --only integration   # parts: integration updates hooks monitor keyclaim link
HUB_CMD=hub-rs/target/release/trommi-hub node dev/fuzz/run.mjs --quick
node dev/load/ingest-bench.mjs --hub-cmd=hub-rs/target/release/trommi-hub          # and --hub-cmd='node hub/server.mjs'
```

Last run (8 October 2026, this machine, release build):

| Check | Node hub | hub-rs |
| --- | --- | --- |
| `cargo test` (vectors.json, units) | | 12 passed (8 vector sections, 2 quota, 2 admin formatting) |
| `hub/test.mjs` | 28 of 28 | 28 of 28 |
| `hub/ops/test.mjs` | 9 of 9 | 9 of 9 |
| `hub/accounts-test.mjs` | all passed | all passed |
| `hub/admin-test.mjs` | 20 passed | 20 passed |
| `dev/interop/hub-diff.mjs` (10,000 requests) | | 0 differences in status, error code, JSON keys; texts equal |
| `dev/interop/run.mjs` (js-js, js-swift, swift-js) | 61 passed, 2 failed | 61 passed, 2 failed (the same two: `version_info`, a JS/Swift difference of known kinds, not the hub) |
| `dev/interop/run.mjs --switch-hub-cmd` (63 hub restarts) | Node↔Node: 54 passed, 9 failed | Node↔Rust: 52 passed, 11 failed (below) |
| `connector/test-e2e.mjs` (6 parts) | 61 passed | 61 passed |
| `dev/fuzz/run.mjs --quick` | 0 failures | 0 failures |
| fuzz, 4 workers, 6 min, seed rustnight2 | 1 finding (a client convergence case) | 1 finding (a client retry loop, flaky, not reproduced on replay) |

## Load: Node vs Rust

`dev/load/ingest-bench.mjs`: 48 human members, 1,200 pre-sealed desk strokes each (57,600 envelopes), posted from 6
worker threads, one stream observer; both hubs as their own process on the same machine (24 cores, shared with other work).
`dev/load/load.mjs --hub=local` (real members sealing as they go, 10 agents, 3 humans, phases ramp, burst, 300 stalled
streams, catch-up) with `HUB_CMD` for the Rust hub.

| | Node hub | hub-rs |
| --- | --- | --- |
| Ingest, pre-sealed (envelopes/s) | 1,480 | 1,992 (+35 %) |
| POST latency p50 / p95 / p99 | 16.1 / 78.7 / 114.5 ms | 8.0 / 60.9 / 106.7 ms |
| Delivery to a stream (from the POST) p50 / p99 | 16 / 114 ms | 8 / 106 ms |
| Hub CPU per 1,000 envelopes | 304 ms | 212 ms (−30 %) |
| Hub RSS peak (ingest bench) | 152.5 MB | 26.8 MB |
| load.mjs: CPU per 1,000 envelopes | 0.61 s | 0.34 s |
| load.mjs: RSS start / peak / end (300 stalled streams) | 82 / 345 / 161 MB | 37 / 136 / 82 MB |
| load.mjs: fresh device catches up ~115,000 envelopes | 14,539/s | 17,103/s (client-bound) |
| hub.db per envelope | the same file (same schema): 1.7 KB | |

Both hubs stayed below one core: the senders (sealing in JavaScript) are the limit on this machine, as the README's
Performance section found for the Node hub; the differences are per envelope, not a new ceiling.

## Parity

Status: **done** = the same behaviour, checked by the named suite against hub-rs; **differs** = a deliberate, listed difference.

| Route / feature | Status | Checked by |
| --- | --- | --- |
| `GET /healthz` (`ok`, `commit`, `protocol_version`), 302 to the app for page navigations | done | hub/test.mjs, hub-diff |
| CORS (app, localhost outside production, `HUB_ORIGINS` + `HUB_PREVIEW_ORIGINS`), preflight 86400 s | done | hub/test.mjs |
| Errors `{ error, message }`, status table, ZError codes outside it 400, `voided` + `envelope_number`, `signed_entries`, `retry-after` | done | hub/test.mjs, hub-diff |
| `POST /v1/rooms` (founding token, per-address limit, `HUB_MAX_ROOMS`, test rooms) | done | hub/test.mjs, ops/test.mjs |
| `POST challenge`, `POST access_tokens` (removed device gets its signed entries) | done | hub/test.mjs, interop |
| `GET/POST members` (incl. `invite_id=`), entry checks, wraps, back links, removal closes streams and tokens | done | hub/test.mjs, interop, fuzz |
| `GET devices` (`is_online`, `offline_since`, `link`), `presence` events | done | hub/test.mjs, connector e2e link |
| `GET sealed_room_keys`, `GET key_back_links` | done | hub/test.mjs |
| Invites: `POST`, `GET`, `DELETE` (burn), `requests` POST/GET, `reveal`, `status` (waiting, revealed, joined, taken), `join_request` event | done | hub/test.mjs, interop |
| Sessions: `GET sessions`, `POST/GET …/grants`, `POST/GET session_grants` (atomic batch), `sealed_session_keys`, `key_back_links` (with history), child sessions (32 per agent), `stale-grant`, `session_grant` events | done | hub/test.mjs, connector e2e, interop |
| `POST envelopes`: strict kinds, 64 KiB, R1/R6 write rules, R3 epoch grace, `stale-session-key`, `lease-lost`, void records | done | hub/test.mjs, interop, fuzz |
| `GET envelopes` (depth rule, `newest=1`, recovery key reads pruned) | done | hub/test.mjs |
| `GET threads` (newest first, oldest first, `has_more`) | done | hub/test.mjs |
| `GET stream`: catch-up in slices of 64, pending live chunks, `Last-Event-ID`, pings, 8 per device, per-stream and total buffer caps, `upgrade_required` | done | hub/test.mjs, ops/test.mjs |
| Agent lease (takeover closes old streams, renew, persisted), `agent_link`, `agent_watch`, loss and cut-off pushes | done | hub/test.mjs, connector e2e |
| Attachments: `PUT` (write once, 64 MiB, upload deadline, removed during upload stores nothing), `GET`/`HEAD` with `Range`, pending-upload sweep | done | hub/test.mjs |
| Shares: `POST`, `DELETE`, `GET /v1/shares/:id` (`x-share-secret`, one answer for every refusal) | done | hub/test.mjs |
| Quota (eviction order, agents' quarter, status pins, `attachment_evicted`), `GET usage` | done | ops/test.mjs, ops_tests.rs |
| Push: `POST/GET push_subscriptions` (levels `all`/`knocking`), `GET /v1/push_key`, Web Push (RFC 8291, VAPID, same `vapid.pem`), APNs (HTTP/2, ES256, sealed `e`, dead tokens forgotten) | done | hub/test.mjs, interop |
| Accounts: create, get, password, recovery, verify, code, login, recover (scrypt N=16384, timing, limits, claims, expiry) | done | accounts-test, interop |
| Mail transports `log`, `outbox`, `off` | done | accounts-test |
| Versions: `GET /v1/version`, 426 `client-too-old` on every route, `bad-version`, `upgrade_required` at run time | done | ops/test.mjs |
| Write admission: 503 `overloaded` + `retry-after`, per address, reserved membership pool | done | ops/test.mjs, hub/test.mjs C03 |
| Rate limits (`HUB_LIMIT_*`), `cf-connecting-ip` only from a private peer with `HUB_TRUST_CF=1` | done | hub/test.mjs |
| Test rooms (`x-test-signature`, `DELETE`, 24 h expiry, limits lifted) | done | ops/test.mjs |
| Retention (30 days after the answer, card chat, attachments), derived tables rebuild | done | hub/test.mjs |
| Slow requests: 15 s JSON body, upload 60 s + size/16 KiB/s, no upload bytes for 30 s | done | hub/test.mjs C03 |
| Idle connections: keep-alive kept 65 s (`keepAliveTimeout`), a connection that never sends closed after 65 s (Node: 60 s) | done | probe (scratch script) |
| A download whose client takes no bytes for 30 s | differs | cut after 30 s, as the README's Limits say ("any request with no bytes moving for 30 s is closed"); the Node hub serves it to the end however long the client pauses (its socket timeout does not see a blocked pipe) |
| `hub.db` schema, migrations (`referenced_at`, `void_code`, `level`, schema 2 moved aside), WAL, incremental vacuum, leases kept across restarts | done | hub/test.mjs restart, switchover |
| WAL keeper, metrics port (`/metrics`, `/metrics/history`), `metrics.db` minutes | done (Node-only figures see below) | ops/test.mjs, admin-test |
| Admin page: Tailscale login + password, sessions, CSRF, rate limits, password change, overview, data browser, row detail with decoded header | done | admin-test |
| Graceful close (in-flight finish, idle connections closed, no late 503) | done | hub/test.mjs F14, fuzz restarts |
| Backups (`VACUUM INTO`, `hub/deploy-backup.sh`) and healthcheck | done | image smoke test |
| Docker image (port, volume, env, uid) | done | image smoke test |
| Prometheus `nodejs_*` series | differs | kept for dashboards: `nodejs_heap_bytes` = resident memory, `nodejs_eventloop_lag_ms` = scheduler delay of a 10 ms timer, `nodejs_gc_*` = 0; plus `process_uptime_seconds` |
| `ADMIN_TZ` | differs | Europe/Berlin (EU summer time rule) and UTC are built in; any other zone is shown as Europe/Berlin (the image has no zoneinfo) |
| `Range: bytes=-` on an existing attachment | differs | 416, as for every unsatisfiable range; the Node hub breaks the connection there (start and end stay `undefined`; found by hub-diff) |
| `shared/crypto/hub-crypto-test.mjs`, `session-grants-test.mjs` | n/a | module tests of `hub.mjs` / `session-grants.mjs` in memory, not of a hub process; their rules are checked over HTTP above and by the fuzz |

## Open points

- The switchover run fails two more Swift scenarios than a Node-to-Node restart (52 vs 54 of 63); both pass alone
  (`--pairs swift-js --only account`): they follow from earlier failures of the same run. Those come from the Swift
  client: after a hub restart it sends on a pooled connection the old hub closed (EOF) and does not try again (also
  with Node to Node). Worth fixing in TrommiCore before any switch, whichever hub runs.
- The 15-minute fuzz before the shutdown fix found restart-window effects (503, refused connections); after it, one
  flaky client finding (an agent re-reading `GET envelopes` in a loop, 435,000 requests, not reproduced on replay).
- Not measured: a run against hub.trommi.com-like conditions (Cloudflare, tailnet) and a multi-day soak.
