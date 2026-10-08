# Trommi

Chat and decision cards between a person and their Claude Code sessions, end-to-end encrypted. The app
(https://app.trommi.com) runs on every device of the person; each Claude Code session joins through the connector, an
MCP server with its own device key; the hub (https://hub.trommi.com) is a thin mailbox that stores and forwards sealed
envelopes and can read none of them. Formerly "Trommi". License: O'Saasy (`LICENSE.md`).

## Repository

| Path | What | Deployed |
| --- | --- | --- |
| `shared/` | what app, connector and hub share: the client core (room model, sync, codec, transport, storage; `shared/README.md`) and `shared/crypto/`, the pure crypto (`zcrypto.mjs`, `argon2.mjs`, `session-grants.mjs`, `hub.mjs` = the hub's checks; bytes: `FORMAT.md`, design: `CRYPTO.md`) | imported by the hub and the connector; copied into the app by its build |
| `app/web/` | the app, static, no framework (`app/web/README.md`); `dev/build.mjs` makes everything in `public/gen/` at deploy time (nothing generated is in git): the app and the core from `shared/` as one minified bundle in `app/` (esbuild, views loaded on demand), the stylesheets as one bundle, and, after `npm ci` at the repository root, the connector's single file, its checksum and the plugin (`connector/build.mjs`) | Cloudflare Workers Builds on every push to `main` (watch paths `app/web/*`, `shared/*`, `connector/*`, `package.json`, `package-lock.json`) |
| `connector/` | the agent connector, six files: `connector.mjs` (start and everything long-running: MCP stdio server `trommi`, sign-in, stream, slot lock, hot reload, the plugin's hook commands, the monitor, `say`), `tools.mjs` (the tools' schemas and what each does in the room), `prompt.md` (every text the agent reads: the instructions and each tool's description), `build.mjs` (the single-file bundle, its checksum and the plugin zip), `test.mjs` (fast), `test-e2e.mjs` (against a real local hub) | runs on the agent's machine from this checkout, or as one file installed by `curl -fsSL https://app.trommi.com/connect \| sh -s '<link>'` |
| `hub/` | the hub server (`server.mjs`, `store.mjs`, `accounts.mjs`, `ops/`, `Dockerfile`); `external.mjs` runs the hub suites against another hub binary (`HUB_CMD`) | GitHub Action "Hub deploy" on every push to `main` touching `hub/**` or the hub's four `shared/` files |
| `hub-rs/` | the same hub in Rust (Cargo workspace: `zcrypto`, `trommi-hub`; `Dockerfile`), checked by the hub suites, interop, connector e2e and fuzz against it; parity table and load comparison in `hub-rs/README.md` | not deployed: production runs `hub/` |
| `dev/` | everything not shipped: `deploy/` (hub and web deploys from this machine, "Deploy without CI"), `fuzz/` (model-based fuzzing of hub and clients, `dev/fuzz/README.md`; the quick run blocks the hub deploy), `load/` (load generator and perf tools with real members), `cdp.mjs` (headless Chromium, also used by the app's dev tools) | |

The old board (plaintext server `server/`, Turbo and SPA clients `client/web/`, the iOS and Linux clients, their tools
and docs) was removed on 4 October 2026; its history is in git and in
`~/Nextcloud/Christopher/Backups/trommi-hub-legacy-2026-10-04.bundle`.

<!-- trees:start -->
### File trees

Every tracked file per main folder (`git ls-files`; generated files are not in git). Regenerate with `node dev/readme-trees.mjs`.

<details><summary><code>app/web/</code> · 86 files</summary>

```
├── dev/
│   ├── build.mjs
│   ├── check.mjs
│   ├── e2e-mobile.mjs
│   ├── e2e.mjs
│   ├── look.mjs
│   ├── make-fixture.mjs
│   ├── perf.mjs
│   ├── serve.mjs
│   └── verify.mjs
├── public/
│   ├── demo/
│   │   ├── files/
│   │   │   ├── 12ca0ba4.png
│   │   │   ├── 256ffa7f.png
│   │   │   ├── 3eebd8de.png
│   │   │   ├── 40c1a1e0.csv
│   │   │   ├── 48a1d583.png
│   │   │   ├── 565e3764.png
│   │   │   ├── 635b3af5.png
│   │   │   ├── 6e7ec91e.log
│   │   │   ├── a62a99e2.json
│   │   │   ├── asset-cfPICArIl7UaWJknPD4TSg.html
│   │   │   ├── asset-MowFfYDajnyqlp_QwRhP1g.png
│   │   │   ├── board-desktop.png
│   │   │   ├── c573b0a8.png
│   │   │   ├── c9b8a0bd.png
│   │   │   ├── clip.webm
│   │   │   ├── d35bd5f7.png
│   │   │   ├── page-messwerte.html
│   │   │   ├── page-plan.html
│   │   │   ├── page-release.html
│   │   │   ├── phone-entscheidungen.png
│   │   │   ├── phone-gespraech.png
│   │   │   ├── tall-sheet.png
│   │   │   ├── thema-dunkel.png
│   │   │   └── thema-hell.png
│   │   ├── demo.mjs
│   │   ├── fixture.json
│   │   └── screens.css
│   ├── fonts/
│   │   ├── f0.woff2
│   │   ├── f1.woff2
│   │   ├── f2.woff2
│   │   ├── f3.woff2
│   │   ├── f4.woff2
│   │   ├── f5.woff2
│   │   ├── f6.woff2
│   │   ├── f7.woff2
│   │   ├── fallback.css
│   │   └── fonts.css
│   ├── icons/
│   │   ├── trommi-180.png
│   │   ├── trommi-192.png
│   │   ├── trommi-512.png
│   │   ├── trommi-maskable-512.png
│   │   ├── trommi-maskable.svg
│   │   └── trommi.svg
│   ├── _headers
│   ├── agents.css
│   ├── agents.mjs
│   ├── app.css
│   ├── app.mjs
│   ├── auth.css
│   ├── auth.mjs
│   ├── card.css
│   ├── card.mjs
│   ├── connect.sh
│   ├── desk.css
│   ├── desk.mjs
│   ├── drawings.json
│   ├── frame.html
│   ├── help.html
│   ├── index.html
│   ├── manifest.webmanifest
│   ├── media.css
│   ├── media.mjs
│   ├── notes.css
│   ├── notes.mjs
│   ├── session.css
│   ├── session.mjs
│   ├── sidebar.css
│   ├── sidebar.mjs
│   ├── sw.js
│   ├── ui.mjs
│   ├── whiteboard.css
│   └── whiteboard.mjs
├── .gitignore
├── .node-version
├── README.md
├── worker.js
└── wrangler.jsonc
```

</details>

<details><summary><code>connector/</code> · 6 files</summary>

```
├── build.mjs
├── connector.mjs
├── prompt.md
├── test-e2e.mjs
├── test.mjs
└── tools.mjs
```

</details>

<details><summary><code>hub/</code> · 29 files</summary>

```
├── ops/
│   ├── delete-room.mjs
│   ├── env.mjs
│   ├── flow.mjs
│   ├── http.mjs
│   ├── index.mjs
│   ├── metrics.mjs
│   ├── quota.mjs
│   ├── test-rooms.mjs
│   ├── test.mjs
│   ├── versions.mjs
│   └── wal.mjs
├── accounts-test.mjs
├── accounts.mjs
├── admin-test.mjs
├── admin-view.mjs
├── admin.mjs
├── apns.mjs
├── attachments.mjs
├── deploy-admin.sh
├── deploy-apns.sh
├── deploy-backup.sh
├── Dockerfile
├── external.mjs
├── heap-test.mjs
├── mail.mjs
├── push.mjs
├── server.mjs
├── store.mjs
└── test.mjs
```

</details>

<details><summary><code>hub-rs/</code> · 40 files</summary>

```
├── crates/
│   ├── hub/
│   │   ├── src/
│   │   │   ├── accounts.rs
│   │   │   ├── admin_assets.rs
│   │   │   ├── admin_view.rs
│   │   │   ├── admin.rs
│   │   │   ├── config.rs
│   │   │   ├── control.rs
│   │   │   ├── db.rs
│   │   │   ├── delete_room.rs
│   │   │   ├── error.rs
│   │   │   ├── files.rs
│   │   │   ├── http.rs
│   │   │   ├── limits.rs
│   │   │   ├── mail.rs
│   │   │   ├── main.rs
│   │   │   ├── metrics.rs
│   │   │   ├── ops_tests.rs
│   │   │   ├── ops.rs
│   │   │   ├── push.rs
│   │   │   ├── room.rs
│   │   │   ├── server.rs
│   │   │   ├── store.rs
│   │   │   ├── stream.rs
│   │   │   └── util.rs
│   │   ├── Cargo.toml
│   │   └── gen-admin-assets.mjs
│   └── zcrypto/
│       ├── src/
│       │   ├── bytes.rs
│       │   ├── envelope.rs
│       │   ├── grants.rs
│       │   ├── invite.rs
│       │   ├── lib.rs
│       │   ├── log.rs
│       │   └── prim.rs
│       ├── tests/
│       │   └── vectors.rs
│       └── Cargo.toml
├── .gitignore
├── Cargo.lock
├── Cargo.toml
├── contract.sh
├── Dockerfile
└── README.md
```

</details>

<details><summary><code>shared/</code> · 49 files</summary>

```
├── crypto/
│   ├── argon2.d.mts
│   ├── argon2.mjs
│   ├── crypto-test.mjs
│   ├── CRYPTO.md
│   ├── demo.html
│   ├── FORMAT.md
│   ├── hub-crypto-test.mjs
│   ├── hub.mjs
│   ├── session-grants-test.mjs
│   ├── session-grants.d.mts
│   ├── session-grants.mjs
│   ├── vectors.json
│   ├── zcrypto.d.mts
│   └── zcrypto.mjs
├── account-remote.ts
├── account.ts
├── agent.ts
├── browser-test.mjs
├── check-emoji.ts
├── client.ts
├── codec.ts
├── core-start.ts
├── core-worker.ts
├── index.ts
├── ink.ts
├── mirror-test.mjs
├── mirror.ts
├── model-shape.ts
├── model.ts
├── palette.ts
├── passwords.ts
├── README.md
├── remote.ts
├── room.ts
├── scribble-test.mjs
├── scribble.ts
├── snapshot.ts
├── storage-file.ts
├── storage-idb.ts
├── storage-memory.ts
├── tabs-test.mjs
├── tabs.ts
├── test-crash-child.mjs
├── test-hub.mjs
├── test.mjs
├── transport.ts
├── types.ts
├── wordlist.ts
└── worker-protocol.ts
```

</details>

<details><summary><code>dev/</code> · 56 files</summary>

```
├── deploy/
│   ├── hub.sh
│   ├── lib.sh
│   └── web.sh
├── fuzz/
│   ├── failures/
│   │   └── known.md
│   ├── lib/
│   │   ├── actions.mjs
│   │   ├── adversary.mjs
│   │   ├── check.mjs
│   │   ├── env.mjs
│   │   ├── forge.mjs
│   │   ├── httpfuzz.mjs
│   │   ├── oracle.mjs
│   │   ├── rng.mjs
│   │   ├── shrink.mjs
│   │   └── world.mjs
│   ├── regress/
│   │   ├── note-deleted-then-pruned.json
│   │   └── owner-says-again.json
│   ├── .gitignore
│   ├── FINDINGS.md
│   ├── known-open.json
│   ├── model.mjs
│   ├── README.md
│   ├── run.mjs
│   ├── sync-target.sh
│   └── worker.mjs
├── interop/
│   ├── fixtures/
│   │   ├── screens.json
│   │   └── strokes.json
│   ├── .gitignore
│   ├── driver-js.mjs
│   ├── hub-diff.mjs
│   ├── parity-baseline.json
│   ├── parity.mjs
│   ├── protocol.mjs
│   ├── run.mjs
│   └── screens.mjs
├── ios-audit/
│   ├── device.py
│   ├── LayoutProbe.swift
│   ├── rules.py
│   └── test_rules.py
├── load/
│   ├── app-perf.mjs
│   ├── crazy.mjs
│   ├── hub-local.mjs
│   ├── huge-room.mjs
│   ├── ingest-bench.mjs
│   ├── lib.mjs
│   ├── load.mjs
│   ├── perf-budget.mjs
│   ├── rotation.mjs
│   ├── tempo.mjs
│   └── worker.mjs
├── cdp.mjs
├── guard.mjs
├── ios-extra-vectors.mjs
├── ios-pen.mjs
├── ios-reference-shots.mjs
├── readme-trees.mjs
└── ts.mjs
```

</details>
<!-- trees:end -->

## Deploy without CI

When GitHub Actions is out of minutes (or down), two scripts in `dev/deploy/` do from this machine exactly what the
workflows do. Both refuse to run with uncommitted or staged changes, off `main`, or when `main` is behind or has
diverged from `origin/main` (they fetch it first); commits not pushed yet only with `--allow-unpushed`. They build from
`git archive HEAD`, so untracked files never get in. `--dry-run` checks the guards, the secrets file, ssh and wrangler
login, prints every step and what is live now, and changes nothing.

| Script | Does | Needs |
| --- | --- | --- |
| `dev/deploy/hub.sh [--dry-run] [--allow-unpushed] [--skip-config]` | `.github/workflows/deploy.yml`: `test:hub` + quick fuzz, `docker build` (COMMIT = HEAD), `docker save \| ssh docker load`, `hub/deploy-apns.sh` and `hub/deploy-admin.sh` (secrets on stdin), `hub/deploy-backup.sh`, restart, `/healthz` must report HEAD or the previous image is started again, admin page check | Docker; ssh `root@trommi-hub.tail276436.ts.net -p 2222` through the 1Password agent (`~/.1password/agent.sock`), host keys already in `~/.ssh/known_hosts` (`StrictHostKeyChecking=yes`); the secrets file below |
| `dev/deploy/web.sh [--dry-run] [--allow-unpushed] [--deploy]` | `.github/workflows/web-app.yml`: waits until app.trommi.com serves a build of the newest commit in Cloudflare's watch paths, checks the served connector against its checksum and the plugin it names. Cloudflare builds every push without Actions; `--deploy` builds HEAD here as Cloudflare does (`WORKERS_CI=1`) and uploads it with `wrangler deploy` first | `npx wrangler login` once (for `--deploy`) |

Secrets for `hub.sh` live outside the repository, never in git: `~/.config/trommi/deploy/hub.env` (mode 0600; another
path with `TROMMI_DEPLOY_ENV`), shell assignments of `APNS_KEY` (the .p8 as one line, newlines as `\n`), `APNS_KEY_ID`,
`APNS_TEAM_ID`, `APNS_TOPIC`, `ADMIN_LOGINS`, `ADMIN_PASSWORD_HASH` (the values of the `hub` environment in GitHub) and
optionally `PREVIEW_ORIGINS`. All six must be set, because an empty one switches APNs or the admin page off on the
server; `--skip-config` leaves the server's `apns.env`, `admin.env` and `compose.override.yaml` as they are instead.

## Tests

```bash
npm test        # test:app (layout check), test:hub (crypto, hub), test:core (core, connector); lists in package.json, CI runs the same
npm run fuzz    # node dev/fuzz/run.mjs --quick
(cd app/web && node dev/serve.mjs 8900)     # the app as deployed (build in memory); e2e: app/web/README.md
(cd app/web && node dev/serve.mjs 8901 --preview) && tailscale serve --bg --https=8443 http://127.0.0.1:8901
                                            # design preview: the working tree at https://desktop.TAILNET.ts.net:8443
                                            # (tailnet only) against the live hub; no shell cache, a reload shows every edit
```

Each suite starts its own hubs on free ports with throwaway data directories. A local hub for the app:
`HUB_PORT=8890 HUB_DATA=/tmp/trommi-dev node hub/server.mjs`.

The same suites against the Rust hub (`hub-rs/`): `HUB_CMD=hub-rs/target/release/trommi-hub node hub/test.mjs` (also
`hub/ops/test.mjs`, `hub/accounts-test.mjs`, `hub/admin-test.mjs`, `connector/test-e2e.mjs`, `dev/fuzz/run.mjs`),
`node dev/interop/run.mjs --hub-cmd …`, or all of it with `hub-rs/contract.sh` (`hub-rs/README.md`).

### Interop: web and iPhone against each other (`dev/interop/`)

The JS core (`shared/`, what the web app and the connector run) is the reference; the iPhone's core is TrommiCore
(`ios/TrommiCore`). Both expose one device as a **driver**: a process speaking JSON lines on stdin/stdout
(`dev/interop/protocol.mjs` has the command table and the result shapes).

```
driver -> {"ready": true, "impl": "js" | "swift", "driver_protocol": 1}
runner -> {"id": 7, "cmd": "answer", "args": {"card": "<object id>", "choices": ["now"]}}
driver -> {"id": 7, "ok": true, "result": {...}}  |  {"id": 7, "ok": false, "error": {"code": "needs-update", "message": "..."}}
```

JS: `node dev/interop/driver-js.mjs` (human or agent). Swift: `trommi-swift driver --home <dir>` (a human device;
`ios/TrommiCore/Sources/trommi-swift/Driver.swift`). A command a driver does not have answers `unsupported`.

```bash
(cd ios/TrommiCore && swift build)   # the Swift driver (without it the Swift pairs are skipped)
npm run interop                      # node dev/interop/run.mjs: a local hub, every pair js-js, js-swift, swift-js
node dev/interop/run.mjs --pairs js-swift --only answer --require-swift
npm run interop:parity               # node dev/interop/parity.mjs: the parity matrix (--check for CI, --update-baseline)
npm run interop:screens              # node dev/interop/screens.mjs: web screens beside the iPhone's (--iphone, --iphone-current)
```

- **run.mjs**: per pair a room of its own on one local hub (APNs and Web Push on, pointing nowhere): a JS founder, a JS
  agent, the actor A and the observer B. Checked: joining (the same six emoji, nobody added before "They match"),
  cards (options, final, multiple, urgency, teaser, sections, html), answer, settle, read, shred, revise, close,
  withdraw, decide again, the conversation (bodies paged in), registers, notes, the stack, pairing and agent invites
  from A, removal (new key epoch), writes of removed members, a forged signature, a changed byte and a replay
  (`check_envelope`: the same refusal code on both sides), a card and a message of a newer version (unsupported,
  never answered), push registration, the Scribble Board, "They don't match", the account (login, wrong password,
  status, Emergency Kit, password, Forgot password) and log out. Results: `dev/interop/out/run.json`.
- **parity.mjs**: what the web does against what the iPhone has, from code: the README's route table against the
  call sites on both sides, the wire vocabulary (`codec.mjs` against `Compat.swift`), every body field of `codec.mjs
  FIELDS`, the driver commands, and a feature list (each row names its evidence in the web code, the Swift core and
  the app; a row whose web evidence no longer matches is "stale"). `ios/TrommiApp/features.json` may declare a row
  (`{ "features": { "<id>": { "status": "full" | "partial" | "missing", "note" } } }`); a failed interop scenario caps
  its row at partial. Output `dev/interop/out/parity.{md,html,json}`; `--check` fails on any row worse than
  `dev/interop/parity-baseline.json`.
- **screens.mjs**: every state of `/screens` (`demo.mjs SCREENS`, listed in `dev/interop/fixtures/screens.json`) at
  393×852, light and dark, beside the iPhone's picture of the same state: the app is started with
  `TROMMI_SCREEN=<state id> TROMMI_THEME=<light|dark>` (`pymobiledevice3 developer dvt launch`, the demo data of
  `app/web/public/demo/fixture.json`) and captured with `pymobiledevice3 developer dvt screenshot` (a userspace tunnel,
  no root). Page: `dev/interop/out/screens.html`.

## Hub v1: the wire protocol (hub.trommi.com)

> **The hub** (`hub/`, deployed to `https://hub.trommi.com`) is a thin, hostile mailbox: it stores what members signed and sealed and serves no UI. The app is a static site (`app/web`, `https://app.trommi.com`); agents join through the connector process (`connector/connector.mjs`). This section is the contract between the three. Crypto design and pairing: the sections below; exact bytes: `shared/crypto/FORMAT.md`.

### Principles

1. **Everyone is a member.** A phone, a laptop, a Claude Code session: each has its own Ed25519 + X25519 keys and an entry in the room's signed member list. There are no client-specific routes; an agent uses exactly the routes a browser uses.
2. **One envelope format** (`shared/crypto/FORMAT.md` §9) for everything said in a room: messages, cards, answers, status lines, shared board state. Signed by the sender, chained per sender, encrypted with the sender's key of the key epoch.
3. **One sync mechanism, two depths.** Every client keeps one number: the `envelope_number` (the hub's arrival number) of the last envelope it processed. `GET envelopes?after_envelope_number=` and `GET stream?after_envelope_number=` deliver the same records in the same order to every client, app and agent alike. Every record carries the **signed header in full** (small; every client verifies every sender's whole chain) and the **encrypted body only for heads**. Threads are fetched when opened, newest first, in pages. Clients build all state locally; the hub never sends "state".
4. **Heads and threads.** The signed `envelope_kind` says whether an envelope belongs to the overview (every kind except `timeline_item` is a head: object versions, answers, registers). Messages and strokes are thread items: each carries a signed plaintext `timeline_kind` (`chat`, `scribble`; later `media` …) and `timeline_id` (`card/<object_id>`, `session/<session_id>`, `desk/<desk_id>`), so the hub pages one timeline with one index hit and never mixes chat with strokes. New timeline kinds need no hub change. The `envelope_kind` is in the signed header and is checked before anything else. A revision is a new object version that names the previous one; no envelope ever holds a whole conversation. Long text, HTML pages and pictures are attachments, fetched only when shown.
5. **The hub reads the signed header only.** It never parses a body. The body carries its own `schema_version`; new app features need no hub change.
6. **Plaintext is what the concept allows and nothing more** (concept §7): room, key epoch, sender, recipient, numbers, hashes, time, padded size; for objects id, state, urgency, answer time; attachment ids; `send_push`; `envelope_kind`; for thread items `timeline_kind` and `timeline_id`. Device roles (human, agent) in the member list; device names are not plaintext (decided 4 October 2026: member entries, offers and join requests carry no name field, R8; names live in the encrypted register `device/<device_id>`). (Also decided 4 October 2026: the kind and the timeline are visible to the hub so it can page timelines and keep chat apart from strokes; the hub learned most of it from the object state anyway.)
7. **Clear names, one scheme.** The same snake_case names in SQLite columns, JSON fields and this text, no abbreviations. Bytes travel as base64url without padding, ids as lowercase hex. Families, told apart by their names:
   - **Key material and key bookkeeping** start with `key_`: `key_epoch`, `key_sealed`, `key_back_link`, `key_signing_public`, `key_exchange_public`.
   - **Proofs** end in `_signature` or `_hash`, or start with `signed_`: `envelope_signature`, `entry_hash`, `previous_envelope_hash`, `signed_entry`, `signed_offer`.
   - **Routing metadata** is plain: `room_id`, `device_id`, `object_id`, `object_state`, `urgency`, `envelope_kind`, `timeline_kind`, `timeline_id`, `send_push`, `recipient_device_id`, `sender_sequence`.
   - **Lists of sealed keys** are `sealed_<scope>_keys`: `sealed_room_keys`, `sealed_session_keys`.
   - **Content** is only ever `encrypted_body` (and encrypted attachment bytes).

### Transport

- HTTPS, JSON bodies. Base path `/v1`. `GET /healthz` → `{ ok, commit, protocol_version: 1 }` without sign-in. A browser that opens the hub (`GET /` or any page navigation outside `/v1`) gets `302` to `https://app.trommi.com` (`HUB_APP_URL`).
- **CORS:** `Access-Control-Allow-Origin` echoes `https://app.trommi.com`, `http://localhost:<any port>` and `http://127.0.0.1:<any port>` (only when `NODE_ENV` is not `production`; the image sets production, so a local app against hub.trommi.com needs `HUB_ORIGINS`) and the origins in `HUB_ORIGINS` and `HUB_PREVIEW_ORIGINS` (comma lists; the deploy bakes `HUB_PREVIEW_ORIGINS` into the image from the repository variable of that name, default `https://desktop.TAILNET.ts.net:8443`, the design preview); methods `GET, POST, PUT, DELETE`; request headers `authorization, content-type, range, last-event-id, x-found-token, x-test-signature, x-lease-generation, x-share-secret, trommi-client, trommi-protocol`; exposed `content-range, content-length, retry-after`; no cookies; preflight cached 86400 s.
- **Sign-in:** `Authorization: Bearer <access_token>`. An access token comes from a signed challenge, is bound to one device and lasts 10 minutes. A client signs in again on `401 unauthorised` or a minute before `expires_at`. Writes need nothing more: member entries and envelopes are signed themselves.
- **Deadlines (shared/):** no request waits forever: 30 s for a JSON route, 120 s for attachment bytes; a `GET` that met a network failure, its deadline or a 502/503/504 is tried twice more (0.3 s, 1 s); writes are never repeated by the transport. The stream has its own watchdog (70 s silent: reconnect).
- **Client version:** every request carries `Trommi-Client: <app|connector|ios>/<semver>` and `Trommi-Protocol: 1` (below, "Versions and upgrades").
- Ids: `room_id` and `device_id` 64 hex characters (32 bytes), `invite_id`, `object_id`, `attachment_id` 32 hex characters (16 bytes). Times are milliseconds since 1970 (`…_at`).

### Versions and upgrades

Three version numbers, independent of each other:

| What | Where | Who reads it |
| --- | --- | --- |
| Protocol (`Trommi-Protocol: 1`) | request header; routes and JSON of this section | the hub |
| Format version byte | first byte of every signed structure (`shared/crypto/FORMAT.md`) | every client (the hub checks headers only) |
| `schema_version` | inside the encrypted body | app and connector only |

- `GET /v1/version` (public) → `{ protocol_versions_supported: [1], minimum_client_versions: { app?, connector?, ios? }, recommended_client_versions: { … }, write_format_versions: { envelope, schema }, message? }`, from `HUB_MIN_APP`, `HUB_MIN_CONNECTOR`, `HUB_MIN_IOS`, `HUB_RECOMMENDED_APP|CONNECTOR|IOS`, `HUB_WRITE_ENVELOPE_VERSION`, `HUB_WRITE_SCHEMA_VERSION` (default 1), `HUB_UPGRADE_MESSAGE`. A kind without a minimum is not checked.
- A client below the minimum of its kind gets `426 { error: "client-too-old", minimum_version, message }` on **every** route. An open stream of a client that becomes too old while connected (minimum raised at run time) gets `event: upgrade_required` `{ minimum_version, message }` and is closed. A request without `Trommi-Client` is served for now (counted in the log once a minute); a later protocol version may require it.
- `Trommi-Protocol` naming a version the hub does not speak → `400 bad-version` with the versions it does speak.
- **The rule for every reader** (hub, app, connector, iOS): ignore unknown optional fields; never guess at unknown *required* versions or kinds: "Versioning and compatibility" below.
- **A v2 migration** would run like this: the hub serves `/v1` and `/v2` side by side and lists `[1, 2]`; clients that know v2 switch, `minimum_client_versions` rises in steps while the share of old clients (log, metrics) falls; when it is zero or the window (announced in `message`) ends, the hub drops v1. Stored data never needs a big-bang rewrite: rows keep their format byte, and new rows get the new one.

### Versioning and compatibility

Every client meets data written by a newer one sooner or later (an agent's connector, the app, the iOS app update at different times). The rules, the same in `shared/` (`codec.mjs`, `model.mjs`), the connector and `ios/TrommiCore` (`Compat.swift`):

- **Unknown fields** are ignored, and kept where a body is written again (notes, registers: a version from an older client keeps what it does not know).
- **Unknown kinds** (an envelope kind 8–255, an `object_type`, `card_type`, `content_type`, `answer_action` or timeline kind this version does not know, or a body with a higher `schema_version`) are **verified like everything else** (signature, chain, seen: FORMAT.md section 9, "Kinds a reader does not know"), so they never break a sender's chain, and are **never applied as something they are not**. They are counted in `model.newer` and shown as a placeholder in their place: a card `unsupported` (its title, "This needs a newer version of Trommi", nothing to answer), a chat item `item_state: 'unsupported' | 'newer_schema'`, a note `unsupported`; an answer of a newer action or schema counts by its signed header (answered/closed). The app shows once a calm line with **Reload** (which fetches the new build); the connector tells the agent with a channel event `kind="unsupported"` (`update_required="1"`) instead of guessing; iOS: `Item.of(...)` → `.unsupported(kind:)`.
- **Writes that need a newer format** are refused locally with `needs-update` (answering an unsupported card, editing an unsupported note, an agent revising a card it cannot read).
- **A newer format version byte** is `newer-version`, not `bad-version`: a newer body is quarantined (the item shows the placeholder); a newer header cannot be verified at all, so it must never appear before every member reads it (below).

Rules for changes:

| Change | How |
| --- | --- |
| New optional field | Just add it. Old readers ignore it (and keep it on re-write). |
| New value of a kind field (`card_type`, `content_type`, `answer_action`, object type, timeline kind) | Add it; old clients show the placeholder. Raise `HUB_RECOMMENDED_*` so they get the quiet "update available". |
| Rename or change the meaning of a field | Write the new field, keep writing and reading the old one until `HUB_MIN_*` is past every client that only reads the old one; then drop it. |
| New envelope kind | Define it within the reader rule of FORMAT.md section 9 (no timeline block, object block by flag); deploy the hub first (it refuses kinds it does not know), then the clients. |
| Breaking change of a body | Bump `schema_version` (codec `SCHEMA_VERSION`). Readers accept 1..N. Writers write `min(own, write_format_versions.schema)` from `GET /v1/version`; raise `HUB_WRITE_SCHEMA_VERSION` only after `HUB_MIN_*` made every client one that reads N. |
| New envelope/header format | The same with the format version byte and `HUB_WRITE_ENVELOPE_VERSION`; an old reader cannot verify a newer header at all, so the minimum must come first. |
| New hub protocol | `Trommi-Protocol` and `/v2` routes side by side (above). |

Raising the minimum on the server: set `HUB_MIN_APP`, `HUB_MIN_CONNECTOR`, `HUB_MIN_IOS` (and `HUB_UPGRADE_MESSAGE`) in the hub's environment (`/srv/trommi`) and restart it; clients already connected learn it on their next request (426). At run time `ops.updateVersions` (hub/ops/index.mjs; no admin control yet) also ends the open streams of clients now too old (`upgrade_required`). Each client sends its own version: the app `APP_VERSION` in `app/web/public/app.mjs`, the connector `CLIENT` in `connector/connector.mjs`, iOS `HubClient.clientName`; raise it with every release that changes what it sends or understands.

What each client shows when it is too old (426 `client-too-old` or `upgrade_required`): the app a calm line "Please reload: this app needs a newer version." with **Reload** (asks the service worker for the new build, then reloads); the connector stops (`phase: too-old`) and tells the agent to update the plugin (or `git pull`) and reconnect; iOS `HubVersionInfo.verdict` → `.updateRequired` (the please-update screen), `.updateAvailable` for a recommended version. The app also offers a quiet Reload when `recommended_client_versions.app` is newer than it.

### Errors

Every refusal is `{ "error": "<code>", "message": "<text for humans>" }`. Codes are those of `crypto/` (`ZError.code`) plus transport codes:

| Status | Codes |
| --- | --- |
| 400 | `bad-format`, `bad-argument`, `bad-version`, `bad-entry`, `bad-signature`, `bad-invite`, `bad-grant`, `wrong-room`, `incomplete`, `chain-break`, `log-behind`, `log-fork` |
| 401 | `unauthorised`, `bad-challenge` |
| 403 | `forbidden`, `not-member`, `removed-sender`, `wrong-sender` |
| 404 | `not-found`, `no-room` |
| 409 | `replay`, `gap`, `equivocation`, `room-exists`, `invite-used`, `instance-conflict`, `wrong-epoch` (an old key epoch after the 2-minute grace: fetch the member list or the grants), `lease-lost`, `stale-grant`, `stale-session-key` (R6) |
| 410 | `invite-expired` (also 15 minutes after an invite was used), `invite-burned` |
| 413 | `too-large`, `quota-exceeded` (with `used`, `quota`) |
| 426 | `client-too-old` (with `minimum_version`) |
| 429 | `too-many`, `rate-limited` (with `retry-after`) |
| 500 | `internal` |
| 503 | `overloaded` (with `retry-after`: the write queue is full) |

**Void records (v1.1.1, review 2 #5).** When the hub refuses a posted envelope for good (`forbidden`, `wrong-epoch`, `too-large`, `bad-format` from the write rules) **after** it verified the signature, the sender and that it is exactly the sender's next `sender_sequence` with the right `previous_envelope_hash`, it keeps it as a void record: the pruned form (header, nonce, `encrypted_body_hash`, signature; no body) takes the next `envelope_number` and the sender's chain moves on. The refusal then carries `voided: true, envelope_number`. `GET envelopes` and the stream serve it like a pruned envelope with `"void": true, "void_code": "<refusal>"`; `GET threads` never; it binds no object, timeline or attachment. A client never signs a second envelope under a number it used: on `voided` it marks the item failed and keeps its chain; receivers verify the header chain and apply nothing. The void flag is the hub's word, not the sender's (review 3): a receiver accepts another sender's void silently only when it can re-check the reason from the signed header (`wrong-epoch`: the header's key epoch is not the scope's current one; `forbidden`: an agent writing under the room key or into a session it was not assigned to at that epoch); any other void from another sender raises the alert `hub-voided-other`, as visible as the gap it would have been. Retryable refusals (`unauthorised`, `gap`, `stale-session-key`, `lease-lost`, `rate-limited`, 5xx) take no number.

Any other `ZError` code is a 400.

`409 gap` on posting an envelope means the hub holds fewer of the sender's envelopes than the sender thinks (a lost write): the client posts the missing ones again, from its own outbox.

### Routes

"member": access token of an active member. "human": of a human device. "inviter": of the device that posted the invite.

| Route | Who | Request | Answer |
| --- | --- | --- | --- |
| `POST /v1/rooms` | anyone, rate-limited (if `HUB_FOUND_TOKEN` is set, also header `x-found-token`) | `{ signed_entry, sealed_room_keys: [{ device_id, key_sealed }] }`: the founding entry, the room key sealed for the first device and for the recovery key; `test_room: true` in a signed test request for a load-test room (Limits) | `201 { room_id, entry_number: 0, entry_hash, key_epoch: 1 }` |
| `POST /v1/rooms/:room_id/challenge` | anyone | | `{ challenge }` (32 bytes, 2 minutes, one use) |
| `POST /v1/rooms/:room_id/access_tokens` | a device or the recovery key | `{ signed_challenge }` (`signHubAuth` for this room and `HUB_URL`) | `{ access_token, device_id, signer: device \| recovery, device_role, expires_at }`. A removed device that signed the challenge with its key gets `403 not-member` with `signed_entries`: the member list up to the entry that removed it and no further, so it checks its removal against the signed list instead of taking the hub's word (it can read the list no other way) |
| `GET /v1/rooms/:room_id/members?after_entry_number=-1` | member, recovery, or `invite_id=` of an open invite | | `{ room_id, last_entry_number, signed_entries: [b64u] }` |
| `POST /v1/rooms/:room_id/members` | signed itself (a recovering human has no device yet) | `{ signed_entry, sealed_room_keys, key_back_link? }` | `{ entry_number, entry_hash, key_epoch, entry_action }` |
| `GET /v1/rooms/:room_id/devices` | member | | `{ last_entry_number, devices: [{ device_id, device_role, is_active, is_online, offline_since?, link? }] }` (`offline_since`: when this hub process saw the device's last stream close; `link`: an agent's last link report, "The link" below). A change of `is_online`, `offline_since` or `link` also goes to every stream of the room at once (event `presence`); clients still read the list on start, when their stream opens and every minute |
| `GET /v1/rooms/:room_id/sealed_room_keys?after_key_epoch=0` | member, recovery | | `{ sealed_room_keys: [{ key_epoch, key_sealed }] }` (the caller's own only) |
| `GET /v1/rooms/:room_id/key_back_links` | human, recovery | | `{ key_back_links: [{ key_epoch, key_back_link }] }` |
| `POST /v1/rooms/:room_id/invites` | human | `{ signed_offer }` | `{ invite_id, device_role, expires_at }` |
| `GET /v1/rooms/:room_id/invites/:invite_id` | anyone with the id | | `{ signed_offer, device_role, expires_at, room_id, signed_entries }` |
| `POST /v1/rooms/:room_id/invites/:invite_id/requests` | the newcomer | `{ signed_request }` | `{ request_hash }` |
| `GET /v1/rooms/:room_id/invites/:invite_id/requests` | inviter | | `{ signed_requests: [b64u] }` |
| `POST /v1/rooms/:room_id/invites/:invite_id/reveal` | inviter | `{ signed_reveal }` | `{ request_hash }` |
| `GET /v1/rooms/:room_id/invites/:invite_id/status?request_hash=` | the newcomer | | `{ join_status: waiting \| revealed \| joined \| taken, signed_reveal?, signed_entries?, key_sealed? }` (`key_sealed` for a human only: agents get no room key) |
| `DELETE /v1/rooms/:room_id/invites/:invite_id` | inviter | | `{ ok }`: the invite is called off (the human said the check codes do not match); its routes answer `410 invite-burned` from then on |
| `GET /v1/rooms/:room_id/sessions` | member | | `{ sessions: [{ session_id, last_grant_number, session_key_epoch }] }` |
| `POST /v1/rooms/:room_id/sessions/:session_id/grants` | signed itself (a human device or the recovery key; an agent only for the first grant of its own child session, R6) | `{ signed_grant, sealed_session_keys: [{ device_id, key_sealed }], key_back_link? }` | `{ grant_number, grant_hash, session_key_epoch }`; the sealed keys must be exactly one per active human device, the recovery key and each assigned agent (manifest hash in the grant); a back link exactly when the session key epoch rises. Every stream of the room gets `event: session_grant` |
| `POST /v1/rooms/:room_id/session_grants` | each grant signed itself | `{ grants: [{ session_id, signed_grant, sealed_session_keys, key_back_link? }] }` (1–1024, one per session) | `{ grants: [{ session_id, grant_number, grant_hash, session_key_epoch }] }`; every grant is checked like the single route, then all are stored in one transaction or none is (a removal re-keys every session in one request). One `event: session_grant` per grant |
| `GET /v1/rooms/:room_id/sessions/:session_id/grants?after_grant_number=-1` | member | | `{ signed_grants: [b64u] }` |
| `GET /v1/rooms/:room_id/sessions/:session_id/sealed_session_keys?after_session_key_epoch=0` | member, recovery | | `{ sealed_session_keys: [{ session_key_epoch, key_sealed }] }` (own only) |
| `GET /v1/rooms/:room_id/session_grants?session_ids=<id>,<id>…` | member, recovery | `session_ids` optional (at most 256; without: every session) | `{ sessions: [{ session_id, signed_grants: [b64u], sealed_session_keys: [{ session_key_epoch, key_sealed }] (own only), key_back_links?: [{ session_key_epoch, key_back_link }] }] }`: the three routes above and below for many sessions in one request (a new device, a reconnect). `key_back_links` only for human devices and the recovery key; an agent asks `…/key_back_links` per session. Sessions without a grant are left out |
| `GET /v1/rooms/:room_id/sessions/:session_id/key_back_links` | human, recovery; an assigned agent for epochs granted `with_history` | | `{ key_back_links: [{ session_key_epoch, key_back_link }] }` |
| `POST /v1/rooms/:room_id/envelopes` | member | `{ envelope }` | `{ envelope_number }` |
| `GET /v1/rooms/:room_id/envelopes?after_envelope_number=0&limit=1000` (`&newest=1`: the newest `limit` after the cursor) | member; the recovery key gets every envelope in the pruned form (for the cuts of a recovery) | | `{ last_envelope_number, envelopes: [{ envelope_number, envelope }] }` in hub order: the full envelope for heads, the pruned form (header, ciphertext hash, signature) for thread items and pruned cards |
| `GET /v1/rooms/:room_id/threads?timeline_kind=chat&timeline_id=card/<object_id>&before_envelope_number=&limit=50` (newest first) or `&after_envelope_number=` (oldest first, for a Scribble Board's tail after a snapshot) | member | | `{ envelopes: [{ envelope_number, envelope }], has_more }`: full items of exactly that timeline (index `room_id, timeline_kind, timeline_id, envelope_number`) |
| `GET /v1/rooms/:room_id/stream?after_envelope_number=` | member | `fetch` with the Bearer header (not `EventSource`) | `text/event-stream`, below |
| `POST /v1/rooms/:room_id/agent_lease` | agent | `{ process_instance }` | `{ lease_generation, expires_at }`: one running process per key. A new sign-in with a new `process_instance` takes the lease over and closes the old process's streams; the lease also ends when its stream closes or after 60 s without a stream. Posts carry the `lease_generation` (header `x-lease-generation`); an older generation gets `409 lease-lost`. The board id of an agent is `hex(device_id)[0..16]`; its readable name is in encrypted registers |
| `POST /v1/rooms/:room_id/agent_link` | agent, under its lease | `{ hears: 'live' \| 'oncall', attached?, last_call_at?, working?, since?, cut_since?, exit?: { reason, claude: 'alive' \| 'gone' \| 'checking' } }` | `{ ok }`: the link report ("The link" below). Kept in memory per device (a hub restart forgets it; connectors repeat it every 60 s), served with `GET devices`, announced as `presence`. Unknown fields are dropped, wrong types are `bad-argument`. The hub reads three fields for its push, `working`, `exit.claude` and `cut_since`, and nothing else of it |
| `POST /v1/rooms/:room_id/agent_watch` | agent, under its lease | `{ working }` | `{ ok }`: a connector before the link report says only whether it has running work (the push for a loss while working, as below) |
| `PUT /v1/rooms/:room_id/attachments/:attachment_id` | member | raw encrypted bytes, `application/octet-stream`, ≤ 64 MiB | `201 { attachment_id, total_size }`; written once, immutable |
| `GET /v1/rooms/:room_id/attachments/:attachment_id` | member | `Range` supported | the encrypted bytes |
| `POST /v1/rooms/:room_id/push_subscriptions` | human | `{ subscription }` (Web Push), or `{ subscription, remove: true }`; an iPhone: `{ apns: { token, environment: 'sandbox' \| 'production', topic, key } }`; either with `level: 'all' \| 'knocking'` (below, "Push") | `{ ok }` |
| `GET /v1/rooms/:room_id/push_subscriptions` | human | every human device's push state, no endpoint or key | `{ devices: { <device_id>: { web, apns, level } } }` |
| `GET /v1/push_key` | anyone | | `{ vapid_public_key, apns }` (`apns`: whether this hub sends APNs pushes) |
| `GET /v1/version` | anyone | | above, "Versions and upgrades" |
| `GET /v1/rooms/:room_id/usage` | member | | `{ attachment_bytes, quota_bytes }` |
| `POST /v1/rooms/:room_id/account` | human | `{ email, auth_key, key_wrapped, kdf }` (Accounts, below) | `201 { email, email_verified_at: null, revision: 1 }`, and a six-digit code is mailed. One account per room (`409 account-exists`). Never says whether the email is in use elsewhere |
| `GET /v1/rooms/:room_id/account` | human | | `{ email, email_verified_at, created_at, updated_at, revision, key_wrapped, kdf, has_recovery, claim_expires_at? }`, else `404` |
| `PUT /v1/rooms/:room_id/account/password` | human | `{ auth_key, key_wrapped, kdf, revision }` | `{ revision }`; compare-and-swap (`409 account-changed`) |
| `PUT /v1/rooms/:room_id/account/recovery` | human | `{ recovery_auth, recovery_wrapped, revision }` (the Emergency Kit) | `{ revision }`; compare-and-swap |
| `POST /v1/rooms/:room_id/account/verify` | human | `{ code }` | `{ email, email_verified_at }`; `400 wrong-code` (five tries per code, 30 minutes). Confirming deletes every other room's claim on that email |
| `POST /v1/rooms/:room_id/account/code` | human | | a new code (once a minute; at most 5 mails per address and hour) |
| `POST /v1/accounts/login` | anyone, rate-limited | `{ email, auth_key }` | `{ room_id, key_wrapped, kdf, challenge }` (a sign-in challenge of that room, saves the device a round trip), else `401 wrong-login` for an unknown email and a wrong password alike |
| `POST /v1/accounts/recover` | anyone, rate-limited | `{ email, recovery_auth }` | `{ room_id, recovery_wrapped }`, else `401 wrong-recovery` |
| `DELETE /v1/rooms/:room_id` | a signed test request, test rooms only | | `{ ok }`: every row of the room and its attachments are gone |

### Accounts (email + password)

A person signs up with an email and a password of their own (at least 12 characters; the app offers a generated
five-word one). The first device founds the room as before; the account only maps the email to that room and keeps,
opaque to the hub, what lets a new device in. Format and code: `shared/account.ts`; hub: `hub/accounts.mjs`.

- **In the browser:** `salt = SHA-256("trommi/v1/account-salt" 0 ‖ email)`, `master = Argon2id(password, salt, 64 MiB, t = 3, p = 1)`
  (hash-wasm, vendored as `shared/crypto/argon2.mjs`, checked against `node:crypto` and RFC 9106 in `hub/accounts-test.mjs`;
  ≈ 0.15 s on a desktop, ≈ 0.5–1.5 s on a phone). HKDF gives an **auth key** (sent at login) and a **wrap key** (never leaves
  the device) that seals the room's recovery code (`key_wrapped`).
- **Log in on a new device:** email + password → `POST /v1/accounts/login` → the device opens `key_wrapped`, signs in as the
  recovery key and adds itself as a human device (`joinWithRecoveryCode`; every other human device shows `recovery-add`).
  Or scan the QR code of a signed-in device (pairing, unchanged).
- **Emergency Kit:** twelve words of the EFF large list (155 bits), shown once to download or print (or "Later"; a new kit
  can be made any time from the password). The same code sealed under the words; "Forgot password" = email + words + a
  new password (`POST /v1/accounts/recover`, then `PUT …/account/password`).
- **Change password:** current password opens `key_wrapped`, the code is sealed again under the new one. Nothing else is
  re-encrypted.
- **Email confirmation:** a six-digit code by mail (`hub/mail.mjs`: transports `log` (default), `outbox` (a folder, for
  tests), `off`; **no real mail provider yet**, TODO). Several rooms may claim one email until one confirms it, which
  deletes the other claims; an unconfirmed claim is deleted after 24 h, but only while a real transport is set (with the
  log transport nobody could confirm; `HUB_ACCOUNT_EXPIRE=1` forces it).
- **Limits:** login and recover 30 tries per address per 10 minutes (`HUB_LIMIT_LOGINS_PER_IP_10MIN`) and 10 failures per
  email per hour (`HUB_LIMIT_LOGIN_FAILURES_PER_EMAIL_HOUR`; then even the right password waits, for known and unknown
  emails alike); one scrypt per try (a dummy one for an unknown email), so answers take the same time.

### The stream

One stream per signed-in device. SSE records; the SSE `id` is the `envelope_number` of the last envelope sent, so a reconnect resumes with `?after_envelope_number=<id>`.

```text
event: envelope       data: {"envelope_number":42,"envelope":"<b64u>"}
event: member_entry   data: {"entry_number":3,"entry_hash":"<hex>","key_epoch":2}   (fetch members, then sealed_room_keys)
event: join_request   data: {"invite_id":"<hex>"}                                    (to the inviter only)
event: session_grant  data: {"session_id":"<hex>","grant_number":1,"session_key_epoch":2}   (fetch grants, then sealed_session_keys)
event: presence       data: {"device_id":"<hex>","is_online":false,"offline_since":1790000000000,"link":{…}}   (a device's row of GET devices, when it changes)
event: ping           data: {}                                                       (every 25 s)
event: attachment_evicted  data: {"attachment_ids":["<hex>"]}                        (quota, below)
event: upgrade_required    data: {"minimum_version":"1.4.0","message":"…"}           (then the stream closes)
```

On connect the hub first sends what `GET envelopes` would (same depth rule), then live envelopes in full: a new message is small and probably shown. Member entries and grants are not replayed: a client reads the member list and the session grants again each time its stream opens (the hub registers the stream in the same step as it sends the headers), so an entry posted just before the stream reached the hub is not missed. A client may drop a thread item's body it does not show; the header stays. A removed device's streams are closed at once. `is_online` in `GET devices` means: the device has an open stream. A stream whose client does not read is dropped once more than `HUB_STREAM_BUFFER_BYTES` (4 MiB) wait for it; the client reconnects and resumes with its cursor.

### What the hub stores (SQLite `hub.db`, attachments as files)

| Table | Columns |
| --- | --- |
| `rooms` | `room_id`, `founded_at`, `last_entry_number`, `last_envelope_number` |
| `member_entries` | `room_id`, `entry_number`, `previous_entry_hash`, `entry_hash`, `entry_action` (`room_founded`, `device_added`, `devices_removed`, `recovery`), `signer_device_id`, `signed_entry` (the entry bytes with its `entry_signature`), `received_at` |
| `devices` | `room_id`, `device_id`, `device_role` (`human`, `agent`), `key_signing_public`, `key_exchange_public`, `added_entry_number`, `removed_entry_number`, `removal_cut_sequence`, `removal_cut_hash` |
| `accounts` | `room_id` (one account per room), `email` (**plaintext**, trimmed and lowercased), `email_verified_at`, `created_at`, `updated_at`, `revision`, `auth_salt` + `auth_hash` (scrypt of the client's auth key, never the password), `key_wrapped` (the room's recovery code, AES-GCM under a key only the password gives), `kdf`, `recovery_salt` + `recovery_hash` + `recovery_wrapped` (the same for the Emergency Kit words), the pending email code (salted SHA-256, expiry, tries) |
| `sealed_room_keys` | `room_id`, `key_epoch`, `device_id`, `key_sealed` |
| `key_back_links` | `room_id`, `key_epoch`, `key_back_link` |
| `session_grants` | `room_id`, `session_id`, `grant_number`, `previous_grant_hash`, `grant_hash`, `session_key_epoch`, `signer_device_id`, `signed_grant`, `received_at` |
| `sealed_session_keys` | `room_id`, `session_id`, `session_key_epoch`, `device_id`, `key_sealed` |
| `session_key_back_links` | `room_id`, `session_id`, `session_key_epoch`, `key_back_link` |
| `invites` | `room_id`, `invite_id`, `device_role`, `inviter_device_id`, `signed_offer`, `expires_at`, `signed_reveal`, `answered_request_hash`, `used_at`, `added_device_id`, `burned_at` |
| `join_requests` | `room_id`, `invite_id`, `request_hash`, `device_id`, `signed_request`, `received_at` |
| `envelopes` (schema 2: `sender_device_id`, `previous_envelope_hash`, `envelope_hash`, `recipient_device_id` are 32-byte BLOBs; `PRAGMA user_version` = 2, an older hub.db is moved aside to `hub.db.v1-<date>` on start) | `room_id`, `envelope_number`, `sender_device_id`, `sender_sequence`, `previous_envelope_hash`, `envelope_hash`, `key_epoch`, `recipient_device_id`, `object_id`, `object_state`, `urgency`, `answered_at`, `envelope_kind`, `timeline_kind`, `timeline_id`, `send_push`, `attachment_ids`, `padded_size`, `sent_at`, `received_at`, `envelope_header`, `envelope_nonce`, `encrypted_body` (BLOB; NULL once pruned), `encrypted_body_hash`, `envelope_signature` |
| `objects` (derived) | `room_id`, `object_id`, `object_state`, `urgency`, `answered_at`, `owner_device_id`, `first_envelope_number`, `latest_head_envelope_number` (cards, notes, permission requests: everything with an `object_id`) |
| `timelines` (derived) | `room_id`, `timeline_kind`, `timeline_id`, `last_envelope_number`, `item_count` |
| `attachments` | `room_id`, `attachment_id`, `object_id`, `uploader_device_id`, `total_size`, `chunk_count`, `stored_at` |
| `access_tokens` | `access_token_hash`, `room_id`, `device_id`, `expires_at` (kept in memory; listed for completeness) |
| `push_subscriptions` | `room_id`, `device_id`, `endpoint`, `subscription`, `created_at`, `level` (`all` \| `knocking`) |

**Truth: `envelopes` and `member_entries`. Derived: `objects`, `timelines`.** The two derived tables are written from signed header fields in the same transaction as the envelope and can be dropped and rebuilt from `envelopes` at any time (the hub's tests do exactly that). The hub uses them for fast answers (open cards by urgency, counts, later the admin page). They are never a source of truth for a client: clients verify everything against signatures. Card options and all content stay inside `encrypted_body`.

hub.db uses incremental auto-vacuum (pages freed by deleted rooms are returned every 30 s in small steps). Backups before each deploy: an online copy (`VACUUM INTO` in the running container) gzipped to `/srv/trommi/backups/hub-<stamp>.db.gz`, attachments mirrored to `backups/attachments/`; kept: 7 newest plus the newest of each of the last 7 days (`hub/deploy-backup.sh`).

Attachments are not in SQLite: encrypted client-side with `encryptAsset` (64 KiB STREAM chunks, a random key per file), stored as files `/data/attachments/<room_id>/<attachment_id>`, served with `Range`. The store is a four-method interface (`put`, `get` with range, `size`, `delete`) so it can move to object storage later.

**Retention.** 30 days after an object's newest head is answered or closed, every envelope of that object and of its chat timeline `card/<object_id>` is pruned to header, ciphertext hash and signature (`pruneEnvelope`) and its attachments are deleted; chains still verify. Envelopes without a card stay for now (whether chat goes after 30 days is a pending decision).

**Push.** For an envelope with `send_push`, the hub sends a Web Push to every human device of the room except the sender, with `{ room_id, envelope_number, urgency }` and nothing else. The app's service worker shows "Trommi: neue Frage" or, when it can open the room locally, the title. The one other push is the loss watch (`agent_watch`): `{ room_id, kind: 'agent-lost', device_id, since }`, shown as "Trommi: connection lost".

**Push level.** Each registration (Web Push or APNs) carries a `level`: `all` (the default) rings for every card version that asks to push; `knocking` rings only for a card of urgency `high` or `critical` (2, 3: the cards that knock on the Desk) and for a session that lost its link (`agent-lost`). A device sets it with `level` on the same `POST`, when it registers or again at any time; a registration sent again without `level` keeps its level. `GET` on the same route gives every human device's state (the number of Web Push and APNs registrations and the level; `all` when any of them is `all`), so a settings page can show the other devices read only: no row at all means push is off there. The web app's Settings · Devices offers Yes (`all`) / Only knocking (`knocking`) / No (the registration removed); the iOS app offers the same three against the same field.

**APNs (the iOS app).** The same two pushes reach an iPhone through Apple (`hub/apns.mjs`, Node's `http2` and `crypto`). The app registers `{ apns: { token, environment, topic, key } }` on the same route: its device token (hex), `sandbox` for a development build or `production`, its bundle id (must be one of `APNS_TOPIC`), and a random 32-byte key it made (base64url). The row is a `push_subscriptions` row with endpoint `apns:<token>`, tied to the device and gone with it like a Web Push subscription. Apple gets a fixed text and nothing about the room or the card: `{ aps: { alert: { title: 'Trommi', body: 'Eine neue Frage.' | 'Dringend: eine neue Frage.' | 'Ein Agent hat die Verbindung verloren.' | 'Eine Sitzung ist abgeschnitten.' }, sound: 'default' }, e }`, where `e` is the Web Push message sealed for the app (AES-256-GCM under its key, AAD `trommi-apns-v1`, `nonce || ciphertext || tag`, base64url); the app opens it and refreshes that room. Token auth: an ES256 JWT (`kid` = key id, `iss` = team id) from the team's APNs key, renewed every 40 minutes; one HTTP/2 connection per Apple host. Apple's 410 (`Unregistered`) or 400 `BadDeviceToken` / `DeviceTokenNotForTopic` deletes the row.

Config (env of the hub; any missing: APNs off, `apns: false`, APNs registrations refused): `APNS_KEY_FILE` (path of the `.p8`) or `APNS_KEY` (its PEM text), `APNS_KEY_ID`, `APNS_TEAM_ID`, `APNS_TOPIC` (bundle ids, comma list: `com.trommi.ios` and, for development builds installed by xtool, `XTL-70CB783D.com.trommi.ios`). On the server the deploy writes them: the hub environment secret `APNS_KEY` (the `.p8` as one line, newlines as `\n`) and the variables `APNS_KEY_ID`, `APNS_TEAM_ID`, `APNS_TOPIC` go through `hub/deploy-apns.sh` into `/srv/trommi/apns.env`, which `hub/deploy-admin.sh` adds to the hub's `env_file`.

### Limits

| What | Limit |
| --- | --- |
| JSON request | 1 MiB; an envelope's padded body ≤ 64 KiB (more goes into an attachment) |
| Attachment | 64 MiB |
| Founding rooms | 10 per IP address per hour; `HUB_MAX_ROOMS` (default 1000) |
| Envelopes | 50 per second per device, bursts of 200 |
| Streams | 8 per device |
| Invites | 16 open per room, 4 requests each, 10 minutes |
| Attachments per room | `ROOM_ATTACHMENT_QUOTA_BYTES` (1 GiB), below |
| Writes in flight | `HUB_WRITE_QUEUE` (512) POST/PUT/DELETE at once, at most `HUB_WRITE_PER_IP` (16) from one address; beyond: `503 overloaded`, `retry-after: 1`. Member entries, session grants and the batch re-key (`POST session_grants`) may also use a reserved pool of `HUB_WRITE_QUEUE_MEMBERSHIP` (32), so a full queue never blocks a removal or its re-key |
| Slow requests | A JSON body arrives whole within 15 s; an upload within 60 s + size / 16 KiB/s; any request with no bytes moving for 30 s is closed (streams live on their pings). Routes with a token check it before reading the body; uploads and share writes check it again after the body (a device removed meanwhile stores nothing) |
| Client address | The socket address. `cf-connecting-ip` counts only with `HUB_TRUST_CF=1` (set in `hub/Dockerfile`) **and** a loopback or private peer (cloudflared on the host, through Docker's port proxy); never from the tailnet or the internet |
| Pending uploads | An attachment no envelope of its uploader names within an hour is deleted. Only the uploader's own envelopes bind an attachment to an object (deleted with it) |
| Stream send buffer | `HUB_STREAM_BUFFER_BYTES` (4 MiB) per stream; beyond: dropped, resume by cursor |
| All stream buffers together | `HUB_STREAM_BUFFER_TOTAL_BYTES` (256 MiB); beyond: the fattest streams are dropped until 80 % remain, they resume by cursor. Catch-up is sent in slices of 64 envelopes and waits for the socket above 256 KiB |

Every rate limit of the table is configurable: `HUB_LIMIT_<NAME>` for each key of `LIMITS` in `hub/server.mjs` (`HUB_LIMIT_ENVELOPES_PER_SECOND`, `HUB_LIMIT_ENVELOPE_BURST`, `HUB_LIMIT_FOUND_PER_IP_HOUR`, `HUB_LIMIT_OPEN_REQUESTS_PER_IP_MINUTE`, `HUB_LIMIT_STREAMS_PER_DEVICE`, …).

**Attachment quota.** The bytes of a room's attachments are summed from `attachments.total_size`. An upload that would pass the quota first evicts, oldest first: attachments of answered or closed objects (cards, published pages no longer released), and attachments only thread items name. Never evicted: attachments of open objects (a released published page is open), anything a human's `status` envelope names (canvas snapshot pointers), what an agent's newest attachment-naming `status` in a scope names, and attachments no envelope names yet (an upload whose envelope is still to come). Review 3: only the uploader's own envelopes count as references (naming someone else's attachment neither protects it nor makes it evictable); an agent's upload evicts only that agent's attachments, never another device's; agents together hold at most a quarter of the quota (beyond: `413 quota-exceeded` with the agents' share as `quota`), so an agent cannot pin the room's quota with a status. Evictions are announced on the stream as `attachment_evicted`. If even that is not enough: `413 { error: "quota-exceeded", used, quota }` (before the upload when `content-length` is given). Honest gap: an old canvas snapshot that a newer one replaced is kept too, because the hub cannot tell registers apart.

**Test rooms.** Off unless `HUB_TEST_PUBLIC_KEY` is set (no key is baked into the image; unset, empty or `off` = off; **keep it off before launch**; a live load test needs someone with server access to set it in `/srv/trommi` for the run). A load harness signs its requests with the private half (Ed25519, never leaves the harness): header `x-test-signature: v1.<timestamp>.<nonce>.<signature>` over `trommi-test-request/v1`, method, path with query, timestamp and nonce; valid for 60 s and once (`signTestRequest()` in the same file). Such a request may found a room with `test_room: true` (standing in for `x-found-token` and the per-address founding limit; a signed founding without `test_room: true` is refused) and may `DELETE /v1/rooms/:room_id` a test room (rows of every table with a `room_id`, its attachment folder). The rate limits are lifted for the routes of test rooms only, never for a real room and never for the escrow. A test room expires after 24 hours.

**Metrics** are never served on the public port. With `METRICS_PORT` set (server: 8792, mapped to the host's 127.0.0.1 only; `METRICS_HOST` 0.0.0.0 inside the container), `GET /metrics` gives Prometheus text: requests and latency histograms per route, envelopes ingested, write queue depth and refusals, open streams, bytes waiting per stream (sum and fullest), dropped streams, SQLite and WAL size and checkpoint lag, heap, RSS, event-loop lag, GC pauses, open files, host load, memory and data-disk space (`/proc/loadavg`, `/proc/meminfo`, `statfs`); `GET /metrics/history` the last hour in 10-second samples (with host CPU % from `/proc/stat` and request latency p95 per sample). Every minute the samples are folded into one row of `/data/metrics.db` (its own small SQLite file, not hub.db; 7 days kept, about 10,000 rows), so the admin graphs for 24 h and 7 d survive a restart. The WAL is checkpointed every 10 s (passive; truncating above `HUB_WAL_TRUNCATE_BYTES`, 64 MiB).

**Admin page** (`hub/admin.mjs`, read-only but for the test-account cleanup): https://trommi-hub.tail276436.ts.net:8443, tailnet only, no Cloudflare. With `ADMIN_PORT` the hub starts a second listener; on the server it binds 0.0.0.0:8791 inside the container (`ADMIN_HOST`, `ADMIN_PUBLISHED_LOOPBACK=1`), published on the host's 127.0.0.1:8791 only, and `tailscale serve --https=8443 http://localhost:8791` puts it on the tailnet. Two checks on every request: the `Tailscale-User-Login` header that tailscale serve sets must be in `ADMIN_LOGINS` (no default), and a 12 h session from the admin password (scrypt; `node hub/admin.mjs hash` prints a hash). The initial hash comes from `ADMIN_PASSWORD_HASH`; "Passwort ändern" writes `/data/admin-password-hash`, which wins from then on and ends every session. Login attempts are rate limited (5 per login, 20 overall per 15 min), forms carry a CSRF token. Two pages. **Übersicht** (`/`): tiles with the current value and a sparkline (CPU, RAM, free disk, open streams, ingest in envelopes/min, latency p95, database size), then a chart each, last hour by default, `?range=24h` or `7d` from `metrics.db`; inline SVG drawn on the server, hover shows the value. **Daten** (`/data`): a tree on the left (all tables with counts; rooms, and in the open room its members and devices, envelopes by `envelope_kind`, by `timeline_kind` and the newest timelines, objects by state, attachments, keys, invites, account), on the right the selected rows, 50 per page from the server, sortable by column, with a prefix search over plain columns; a row opens every column, the decoded cleartext envelope header and links to related rows (object → its versions and card timeline, device → its envelopes and keys). Ciphertext and secrets are shown as size + first 16 bytes hex and can neither be searched, filtered nor sorted by (no oracle on e-mail addresses); the encrypted body is never decoded. **Test accounts** (`/test-accounts`): the accounts whose email ends with `@example.org` (throwaway accounts of old e2e runs; their emails are shown in full, every other email stays opaque) with room id prefix, created, last activity, envelope and attachment counts, and a button "Delete these N test rooms" that needs N typed. The admin listener never writes hub.db itself: it calls the hub's `ops.deleteTestRooms` (`hub/ops/delete-room.mjs`), which first takes an online backup (`VACUUM INTO`, gzipped to `/data/backups/hub-<stamp>-before-delete.db.gz`, i.e. `/srv/trommi/data/backups/` on the host, 5 kept), then per room closes its live streams and deletes every row of every table with a `room_id` column in one transaction, then its attachment files; each deletion goes to the hub log and to `/data/deletions.log` (JSON lines). `deleteRoom` refuses a room whose account email does not end with `@example.org` unless `allowNonTest` is passed, which the page never does. One stylesheet and one small script, pinned by hash in the CSP; no external assets, light and dark, usable on a phone. The deploy writes `/srv/trommi/admin.env` (0600) and `compose.override.yaml` with `hub/deploy-admin.sh` from the repository variable `ADMIN_LOGINS` and the `hub` environment secret `ADMIN_PASSWORD_HASH`, and checks the listener after the restart.

### The link: whether a session hears the human, and the receipt

A stream says that a connector process is connected. It does not say that the agent behind it hears the human: Claude Code may show board events at once or drop them, the agent may not have acted for an hour, Claude Code may have dropped the MCP server while the session runs on, and two Claude Code sessions in one folder share one key, so the stream may belong to the other one. Two signals close that gap.

**The link report** (`POST agent_link`, hub-readable like `is_online`; no content of the room in it). The connector that holds the key reports:

| Field | Meaning |
| --- | --- |
| `hears` | `live`: Claude Code shows board events at once (the channel flag, or the plugin's monitor wakes the session); `oncall`: events wait in the connector and go out with the agent's next tool call |
| `attached` | an agent's MCP session stands behind the key (the MCP server always says true) |
| `last_call_at` | the agent's last tool call through the connector, or a hook of its Claude Code process: the one sign that the agent itself is alive |
| `working` | a status line "working" in any of its sessions |
| `since` | when this process took the key |
| `cut_since` | the folder watch: a Claude Code session of this folder runs on while its connector is gone, since when (the oldest) |
| `exit` | the connector's last word before its stream closes: `reason` (`stdin`, `signal`, `parent-gone`, `handover`, `killed` when a witness says it) and `claude`: its Claude Code process is `gone`, `alive`, or `checking` (it was there when the connector left; the folder watch decides within its grace) |

The five states (`shared/model.ts linkState`, the app's words in `app/web/public/app.mjs linkOf`):

| State | In the app | When | The way out the app names |
| --- | --- | --- | --- |
| live | no sign | a stream, and `hears: live`; also a connector that reports nothing | |
| on call | "on its next step" | a stream, `hears: oncall` | start it with the channel flag |
| asleep | "not listening · 46 min" | on call, and no tool call for 10 minutes (`ASLEEP_MS`) | type anything in its terminal |
| cut off | "cut off · 16:16", red hand, the slip above the Desk's questions | no stream and `exit.claude: alive`; or a stream and `cut_since` | `/mcp → trommi → Reconnect` in its terminal |
| gone | "gone · 14:43" | no stream otherwise: it ended with its Claude Code, was killed, or is off the network | `claude --continue` in its folder |

**The push.** One Web Push `{ room_id, kind: 'agent-lost', state: 'cut' | 'gone', device_id, since }` to the room's human devices, never repeated: when a device's last stream stays closed for 60 s (`HUB_LOSS_MS`) and it had running work (`gone`) or its Claude Code lives on without it (`cut`); and when a connected agent reports `cut_since` (once per value). A session that said goodbye, ended with its Claude Code and had nothing running pushes nothing: the human ended it himself. A stream that returns within the 60 s pushes nothing, and the next push needs a new stream first.

**The receipt** (end to end, like every register). When the connector really hands the human's commands to the agent (a channel event Claude Code shows, or the text of a tool result), it writes the agent register `heard = { up_to, at }` into that session: every command of the session up to envelope number `up_to` is with the agent. One mark per session, not one envelope per command: a session's commands are handed over in order, a burst is one write, and the mark only rises. An answer is heard when `answer.envelope_number <= heard.up_to`, a hand-back or a chat message by its own envelope number. The first command that waits in a session without a mark sets the mark right before it, so "not picked up" shows from the first answer on. A session without a mark (an older connector) is "not known", and the app says what it said before. The app shows it as "has it, is on it" / "has not picked it up" (after 2 minutes) in the Desk's tail, as the first line of the note on the card's page, and as "1 answer waits" in the sidebar.

### The data model: objects, timelines, registers, projections

Everything in a room is one of three things, and the board is a fourth thing computed from them:

| | What | Examples | How it travels |
| --- | --- | --- | --- |
| **Objects** | things placed into the room, with versions | a card (decision, info), a permission request, a note, a published page | envelope kind `object_version`, a head. Each version is a new envelope naming the previous one (`previous_version_hash`). The newest version is the object. An object has an `object_id` (16 bytes) in the header |
| **Timelines** | append-only, small items, paged | the conversation under a card, a session's chat, the strokes on a Scribble Board | envelope kind `timeline_item`, a thread item, carrying `timeline_kind` (`chat`, `scribble`) and `timeline_id` (`card/<object_id>`, `session/<session_id>`, `desk/<desk_id>`) |
| **Registers** | "the current value of something" | status lines, an agent's profile, an agent's receipt (`heard`), drafts, snooze, duck, crown, desks, session settings, read markers, a Scribble Board snapshot pointer | envelope kind `status`, a head: `{ values: { "<key>": value \| null } }`, last writer wins |
| **Projections** | computed on every client, never stored or sent | the Desk, stacks, crowns, the Next line, counters, "in revision", queue order | — |

Four command kinds bind a human's decision to exactly the object version it answers (the crypto layer checks the bind, concept §6): `answer`, `decide_again`, `verdict` (to a permission request), and the agent's `permission_request` itself, which is an object with an expiry. That is all: **seven kinds, and none of them knows a content type.** A new content type (video, a new card type, a poll) is a new `object_type` or `content_type` inside the encrypted body, with big media as attachments (STREAM chunks, Range, thumbnails or posters as separate small attachments). The hub never needs a new kind.

### Inside the envelope: the body

The hub never reads this; app and connector agree on it. The body's payload is UTF-8 JSON: `{ "schema_version": 1, … }`. A client ignores fields it does not know and shows a body with a higher `schema_version` as "needs a newer app". An attachment reference:

```json
{ "attachment_id": "<hex>", "file_key": "<b64u>", "sha256": "<b64u>", "file_name": "plan.png", "media_type": "image/png",
  "total_size": 48213, "width": 1440, "height": 900, "caption": "…", "page": "…", "poster_attachment_id": "<hex>",
  "marks": [{ "x": 0.1, "y": 0.2, "width": 0.3, "height": 0.1, "label": "…" }] }
```

A `video/*` attachment (the connector maps `.mp4`, `.webm`, `.mov`) is shown on a card after its pictures as a player (`<video controls playsinline preload="metadata">`, never autoplaying); the app decrypts the whole file into a blob (up to the 64 MiB attachment limit) and its service worker answers the player's `Range` requests from that blob with `206`.

**Clips after What??** No signal of their own: a What?? (`explain: true` on a human message about a card) asks the agent to rework the card, and an agent with a clip skill (`trommi-clip`) also answers with a short silent clip (the card's pictures with drawn circles, arrows and captions, the options, its pick) as an ordinary agent `message` on the card with a `video/*` attachment; it may attach one unasked to a big question. The card's talk plays every video inline (`<video controls playsinline preload="metadata">`); iOS does the same.

A **session** on the board is an agent member. A human's envelope for a session has `recipient_device_id` = that agent; an agent's envelopes are for everyone. An object belongs to the member that created it; only its creator writes new versions (a note: any human device).

| `envelope_kind` (crypto `KIND`) | From | Header | Body (besides `schema_version`) |
| --- | --- | --- | --- |
| `timeline_item` (1), thread | anyone | `timeline_kind`, `timeline_id` | `content_type`: `message` (`text`, `details?`, `html?`, `attachments?`, `hand_back?`, `explain?`, `present_card?`, `copied_cards?`, `marks?`, `published_object_id?`, `note?`: `{ object_id, written_at }` when a human sent one of their notes (the note object's id, 32 hex, and when it was written, ms or null; nothing else in it: a bad one is refused on seal and dropped on open, the message stays; the app shows the message as the note, taped on)), `strokes` (`strokes: [Entry]`: strokes, pieces of a stroke being drawn (~ every 150 ms), notes and pictures; see "Scribble strokes"), `erase` / `move` / `send_away` (`stroke_ids`, `offset?`), `selection_sent` (`text?`, `attachments`: the picture of the selection, `stroke_ids`, `board`) |
| `object_version` (2), head | creator | `object_id`, `object_state`, `urgency` | `object_type`: `card` (`card_type` `decision` \| `info`, `title`, `teaser?`, `body?`, `options?`, `sections?`, `html?`, `allows_multiple?`, `recommended?`, `urgency_reason?`, `attachments?`, `change_note?`, `close_summary?`, `withdraw_reason?`, `merged_into_object_id?`, `merged_from_object_ids?`), `note` (`text`, plus app-defined fields that pass through), `published` (`attachments`, `title`, `note?`, `released_until?`); always `object_version` (1, 2, …) and `previous_version_hash` |
| `answer` (3), head | human → owning agent | `object_id`, `object_state` answered (closed for read and shred, and for an answer that settles the card: every choice a `final` option), `answered_at` | `answer_action` (`answer`, `read`, `shred`), `choices?`, `note?`, `option_notes?`, `attachments?`, `marks?`, `trusted?`; signed bind: object id, hash of the version answered, every choice (R7) |
| `permission_request` (4), head | agent | `object_id`, `send_push` | `tool_name`, `description`, `input_preview`; bind: request id, expiry. A second head of the same object from the same agent with `object_state` closed withdraws a pending request (`withdraw_reason?`, same bind) |
| `verdict` (5), head | human → agent | `object_id` | bind: request id, request hash, expiry, allow or deny |
| `status` (6), head | anyone | | `values: { "<key>": value \| null }` |
| `decide_again` (7), head | human → owning agent | `object_id`, `object_state` open | bind: object id, hash of the answer taken back |

There is no kind 8: the hub refuses it (`bad-format`); drawings are timeline items.

**Registers.** A key's value is the one from the latest `status` envelope that set it in **signed causal order** (see Security rules, R2), never hub order; `null` deletes. Keys are scoped by the sender:

- **Every device's own key** counts only from that device: `device/<device_id>` (`device_name`, `platform`, `folder`, `host`), written right after joining, e.g. `device_name` "valiido", `folder` "~/git/valiido", `host` "desktop". The hub never sees a name.
- **An agent's keys** count only from that agent: `profile` (`model`, `task`, `icon`, `agent_name`, `parent_session`, `is_main`), `status_line/<id>` (`label`, `state`, `detail`, `object_id`), `alert/<envelope_hash>` (a command the agent refused: `code`, `message`, `sender_device_id`, `envelope_number`).
- **Human keys** are shared by every human device and ignored by agents: `draft/<object_id>`, `snooze/<object_id>`, `duck/<object_id>`, `crown`, `desk/<desk_id>` (name, created_at, order, crown, goals: at most five lines), `session/<session_id>` (name, desk, archived, group, icon), `scribble_snapshot/<timeline_id>` (for `timeline_kind` scribble; `attachment` reference + the signed sender **frontier** it includes, R2), `room_snapshot` (a whole-room snapshot for a fresh device's first load: `shared/snapshot.ts`).

**Scribble Board.** A room has one board: the scribble timeline `ROOM_BOARD` (`shared/scribble.ts`, `desk/6d61696e000000000000000000000004`), whatever desk is in view. Until 8 October 2026 each desk had its own; those boards, and the ones in the first stroke format, are moved onto it once by hand with `dev/migrate/scribble-first-format.js` (no app reads them). Strokes are an append-only set: concurrent edits from two devices merge without conflict (set semantics; erase and move are tombstones referencing `stroke_ids`, and adding, erasing and moving commute). Every few hundred items or when idle, one device writes the whole board as an encrypted snapshot attachment (`{ v: 2, shapes, frontier, last_envelope_number }`, gzip'd JSON) and points `scribble_snapshot/<timeline_id>` at it; a fresh client loads snapshot + `GET threads?timeline_kind=scribble&timeline_id=…&after_envelope_number=` instead of replaying everything. Live strokes from others render from the stream as they arrive. The format of a stroke is below.

### Scribble strokes

One stroke format for every client, modelled on PencilKit so that the iOS app maps a `PKStroke` 1:1 and the web app draws the same line (code: `shared/ink.ts` points and shape, `shared/scribble.ts` entries and reducer, `shared/palette.ts` colours; samples: `dev/interop/fixtures/strokes.json`, checked by `shared/scribble-test.mjs`).

**Board units.** A Scribble Board has one fixed coordinate space, independent of screen, zoom and device: one unit is one CSS pixel at 100 % zoom on the web and one point at zoom scale 1 in `PKCanvasView`; x grows to the right, y down; the board is endless (any finite number). On the wire coordinates are quantised to 1/16 unit, times to whole milliseconds.

**A `strokes` item** carries `strokes: [Entry]`. The receiver derives each shape's id as `<sender_device_id>/<sender_sequence>/<index>` (R1); no id is read from a body. Entries by tool:

| Entry | Fields |
| --- | --- |
| stroke | `tool` `pen` \| `marker`, `color` (a palette token), `width` (board units, the tool's base width), `points` (packed, below), `transform?` (`[a, b, c, d, tx, ty]`, as `CGAffineTransform`: x' = a·x + c·y + tx, y' = b·x + d·y + ty; absent = identity), `z?`, `group?` |
| piece | `continues` (the id of a stroke this sender is still drawing), `points`: more points of it, sent every ~150 ms while drawing; the times go on from the stroke's start |
| note | `tool` `text` \| `voice` \| `sticky`, `at: [x, y]` (top left), `text`, `size`, `color` (token), `wrap?`, `z?`, `group?` |
| picture | `tool` `image`, `rect: [x0, y0, x1, y1]`, `attachment` (README attachment reference), `nw?`, `nh?`, `mime?`, `name?`, `z?`, `group?` |

There is no eraser stroke: the eraser is PencilKit's vector eraser (`PKEraserTool(.vector)`) and removes whole strokes, as an `erase` item naming them. A `move` item's `offset: [dx, dy]` adds to a stroke's `tx, ty` (to a note's `at`, a picture's `rect`). A change that is not a move (resize, recolour, edited text, z) is an `erase` of the old shape and a new one. A receiver bakes a `transform` into the points (the width times √|ad − bc|, the azimuth turned by atan2(b, a)); the web app sends identity transforms and scales by sending the scaled points.

**Packed points** (`points`, base64url, `ink.mjs` `packPoints`): a flags byte, then per point until the bytes end:

| Bytes | Value |
| --- | --- |
| u8 flags (once) | bit 0: every point carries azimuth and altitude (a pencil); bit 1: the force is simulated (mouse or finger, from speed); any other bit: a newer format, the stroke is not readable here |
| zigzag LEB128 | x in 1/16 unit: the first point absolute, then the difference to the point before |
| zigzag LEB128 | y, the same |
| LEB128 | t in ms: the first point since the stroke began, then the time since the point before (never negative) |
| u8 | force, 0..255 = 0..1 |
| u8, u8 (flag bit 0) | azimuth 0..255 = 0..2π (·2π/256), altitude 0..255 = 0..π/2 |

A 240 Hz pencil point is about 5–7 bytes, a mouse point 4–6. Malformed bytes or more than 50 000 points in one piece: the entry is dropped whole.

**The line.** The points are the control points of a uniform cubic B-spline, as `PKStrokePath`'s are, with the ends clamped (the first and the last point repeated three times), so the line begins and ends exactly on them; force follows the same spline. The pen's ink at a point is `width · (0.3 + 1.4 · √force)` wide (force 0.25, a light hand, is the base width); the web draws it as the union of discs of that width along the spline, every ~1 unit, filled once (round ends and joins, no notches, a translucent ink laid once). The marker is `width` wide everywhere, translucent (`MARKER_OPACITY`: 0.5 multiplied on light paper, 0.38 on dark). Input without pressure gets a force from its speed (`forceFromSpeed`: slow heavier, fast lighter, eased) and sets flag bit 1; a pen's pressure is Pointer Events `pressure` (WebKit: force ÷ maximum force), its angles `azimuthAngle` / `altitudeAngle` or, where missing, `tiltX` / `tiltY` converted (`anglesOfTilt`). Points are kept raw (no smoothing at capture); the spline smooths when drawn.

**Colours** are tokens (`shared/palette.ts`), each with a light and a dark value per tool: `ink` (pen only; dark on light paper, light on dark), `red`, `orange`, `yellow`, `green`, `blue`, `violet`, `pink`. The pen offers ink, red, orange, green, blue, violet; the marker yellow, green, pink, blue, orange. An unknown token paints as the tool's first colour. Notes use the pen values.

**What an agent gets.** Select-and-send (or cut out an area) seals a `selection_sent` into the session's conversation: `attachments` = a PNG of exactly the selection, rendered from the strokes at send time on white, `text?` = the words of its notes, `stroke_ids`, `board` (the timeline id). The connector hands it on as `<channel kind="scribble" board message_id elements image_path>`. What was sent leaves the board (`send_away`; with a cut-out, strokes crossing its edge are cut there and the parts outside stay, keeping their times, forces and angles).

**PencilKit mapping** (the iOS app; `PK_MAX_FORCE` = 4.1666667, an Apple Pencil's `UITouch.maximumPossibleForce`):

| Protocol | PencilKit | To the wire | From the wire |
| --- | --- | --- | --- |
| `tool` `pen` / `marker` | `PKInk.InkType` `.pen` / `.marker` (`PKInkingTool`) | other ink types (`.pencil`, `.monoline`, …) go as `pen` | |
| eraser (no stroke) | `PKEraserTool(.vector)` | `erase` with the removed strokes' ids | remove those `PKStroke`s |
| `color` token | `PKInk.color` | the nearest palette token of the tool | `UIColor(light:dark:)` of the token's values |
| `width` | `PKInkingTool.width` | the tool's width when drawn | `PKInkingTool(ink, width:)`; point size below |
| `transform` | `PKStroke.transform` | as is (identity may be left out) | as is |
| point `x`, `y` | `PKStrokePoint.location` | ÷ 1 (points = units), quantised to 1/16 | as is |
| point `t` (ms since start) | `PKStrokePoint.timeOffset` (s) + `PKStrokePath.creationDate` | `timeOffset · 1000`, rounded | `t / 1000`; `creationDate` = when the item arrived |
| point `force` 0..1 | `PKStrokePoint.force` | `min(1, force / PK_MAX_FORCE)`; flag bit 1 when the input had none (finger) | `force · PK_MAX_FORCE` |
| point azimuth | `PKStrokePoint.azimuth` (rad, 0 along +x, towards +y) | as is, when a pencil drew it (flag bit 0) | as is; no tilt: 0 |
| point altitude | `PKStrokePoint.altitude` (rad, π/2 upright) | as is (flag bit 0) | as is; no tilt: π/2 |
| (derived) | `PKStrokePoint.size` | not sent | pen: `width · (0.3 + 1.4 · √force)` both ways; marker: `width` |
| (derived) | `PKStrokePoint.opacity` | not sent | 1 (the marker's ink is translucent itself) |
| (derived) | `PKStrokePoint.secondaryScale` | not sent | 1 |
| points (control points) | `PKStrokePath(controlPoints:creationDate:)` | `path` (the control points, not `interpolatedPoints`) | as is |
| `z` | order in `PKDrawing.strokes` | | sort by `z`, then id |
| `group`, `mask`, `randomSeed` | | not sent (`PKStroke.mask` is never set: the vector eraser leaves none) | |

**Projections, computed on the client:** a card's place in the stack (oldest first by `sent_at` of version 1, R2), "in revision" (a human message with `hand_back` or `explain` newer than the card's newest version, until the agent's next version or a message with `present_card`), the Desk and stacks, crowns, the Next line, unread counts.

### Cryptography in one page (bytes: `shared/crypto/FORMAT.md`, library: `shared/crypto/zcrypto.mjs`)

| Piece | How |
| --- | --- |
| Device | Ed25519 (`key_signing_public`) + X25519 (`key_exchange_public`); `device_id` = H(both). Browser: WebCrypto, IndexedDB, wrapped by a non-extractable AES key and unwrapped as non-extractable (WebKit loses a stored X25519 CryptoKey). Agent: key file, mode 0600 |
| Member list | Append-only signed entries (`room_founded`, `device_added`, `devices_removed`, `recovery`), each with `entry_number`, `previous_entry_hash`, signed by an active human device or the recovery key. `room_id` = hash of the founding entry, so the invite link pins the whole list. Clients pin the newest entry and refuse rollback and forks |
| Room key | 32 random bytes per `key_epoch`, a new epoch only when a member is removed or on recovery. Sealed per human device and the recovery key (X25519 + HKDF + AES-256-GCM, HPKE pattern), bound to room, epoch, recipient; humans also get a history key and the back links. Agents never hold the room key: they hold session keys (R6) |
| Envelope | Header (plaintext, signed, associated data) ‖ 96-bit random nonce ‖ AES-256-GCM `encrypted_body`, padded to 256 B … 64 KiB ‖ `envelope_signature` over H(header ‖ nonce ‖ H(encrypted_body)). Per-sender key = HKDF(scope key, room, key scope, key epoch, sender), the scope key being the room key or a session key (R6). Per-sender `sender_sequence` + `previous_envelope_hash` chain; `seen` vector of other senders' heads. New in v1.1, signed like every header field: `envelope_kind` (u8; the body has no kind of its own), and for thread items a binary timeline: `timeline_kind` u8 (1 chat, 2 canvas) ‖ `timeline_scope` u8 (1 card, 2 session, 3 desk) ‖ reference (card: `object_id` 16 bytes; session: `session_id` 16; desk: `desk_id` 16). The JSON and SQLite form `timeline_id` is the canonical text `card/<32 hex>`, `session/<32 hex>`, `desk/<32 hex>`, lowercase, nothing else accepted |
| Thread items fetched later | The pruned form (header, nonce, ciphertext hash, signature) verifies the chain at sync time; when the full envelope is fetched, the client checks that H(encrypted_body) equals the hash it already verified, then decrypts (`openVerifiedEnvelope`). Nothing is decrypted that the chain did not vouch for |
| Sign-in | Hub challenge (32 bytes) signed with room id and hub address → `access_token`, 10 minutes, one device |
| Invite | Link `#v1.<hub>.<room>.<secret>`; `invite_id` and MAC key from HKDF(secret); request MAC'ed and self-signed; commit-then-reveal check code of six emoji (36 bits), mandatory for humans, and for agents too since 7 October 2026 (the connector prints the emoji with their words, the app's invite page shows the same six with "They match" / "They don't match"; no agent is added by itself; review 3); an agent link that two different devices answer adds nobody (`invite-contested`, the invite is spent) instead of the first comer; one use, 10 minutes, enforced by the inviter |
| Commands | An agent acts only on envelopes from an active human device addressed to it, current epoch (previous for 2 minutes), and for answers/verdicts bound to the current card or request hash |
| Attachments | Random key per file, 64 KiB STREAM chunks (chunk index and last-chunk flag in the nonce); key, hash, name and type inside the referencing body; only the `attachment_id` in the header |
| Removal and re-adding | Any human device, at any time: one `devices_removed` entry carries the new `key_epoch` sealed for every human device that stays and the recovery key (agents hold no room key, R6) and the back link. The hub at once closes the removed device's streams, revokes its access tokens and refuses its sign-in and envelopes; the others switch to the new epoch on the `member_entry` event without interruption (the previous epoch is still accepted for 2 minutes after the entry, then refused by hub and clients, R3). The removed device keeps what it already decrypted and can open nothing sent in the new epoch. A removed `device_id` can never come back: re-adding a phone means new device keys and a new invite. A re-added human device gets the history key and back links, so it reads the whole history again; a re-added agent reads from its join on (R6) |
| Reconnecting is not joining | A crashed or restarted Claude session finds its key file (`~/.local/share/trommi/keys/<room_id>/<host>-<folder>-<slot>.key`, mode 0600) and comes back as the same device: sign in, take the lease, catch up from its cursor (R4). No member entry, no new epoch. Only a new folder or machine joins by invite |
| Cost of a removal | Never re-encrypts anything: one member entry plus a fresh 32-byte key sealed once per remaining member (milliseconds, measured with 20+ members in "Performance"). Several devices removed at once are one entry and one new epoch. Removal and the new key stay one entry on purpose: a lazy rotation would let the removed device read what is sent before the next rotation. Agents idle for `agent_idle_days` (a human setting, default off) are removed by the next human device that opens the room, batched into one entry |
| Recovery | 256-bit code (Crockford base32) derives a key pair; a `recovery` entry adds the new device, removes every human device, keeps the agents unless it removes them too (R6), starts a new epoch and a new code |

### Security rules (v1.1, after the two reviews of 4 October 2026)

Two independent reviews (Claude, Codex; four findings reproduced) found the primitives sound and the weak points one layer up: who may claim what, hub order, freshness, crash state. These rules are binding for every client and, as a second line, the hub.

**R1. Authority, not just signatures.**
- `object_id` = first 16 bytes of H("trommi/v1/object-id", creator `device_id` ‖ `sender_sequence` of version 1). Version 1 has `previous_version_hash` = zeros; every later version comes from the creator and names its predecessor (notes: any human device; two versions naming the same predecessor are settled by R2). Two chains for one id are equivocation.
- Who may write what (checked against roles from the signed log):

| What | Allowed sender |
| --- | --- |
| `object_version` | the creator (agents: cards, published pages, permission requests; humans: notes); for an object of a session whose grants no longer assign the creator: the agents they assign instead (the **holder**, R6 "Continuing a session") |
| `answer`, `decide_again` | a human device, `recipient_device_id` = the object's creator or holder |
| `permission_request` | an agent, its own object |
| `verdict` | a human device, `recipient_device_id` = the request's creator; request id = `object_id` |
| `timeline_item` chat on `session/<S>` | the agent assigned to S, or a human with `recipient_device_id` = that agent |
| `timeline_item` chat on `card/<X>` | X's creator or holder, or a human with `recipient_device_id` = X's creator or holder |
| `timeline_item` scribble on `desk/<D>` | human devices |
| `timeline_item` scribble on `session/<S>` | human devices and the agent assigned to S |
| `status` key `device/<X>`, `profile`, `status_line/*`, `alert/<envelope_hash>` | X itself / an agent the session's grants gave that session key epoch (session scope) |
| `status` human keys (`draft/`, `snooze/`, `duck/`, `crown`, `desk/`, `session/`, `scribble_snapshot/`, `room_snapshot`) | human devices only |
| session grant | a human device (signed, chained per session); the first grant of an agent's own child session: that agent (R6) |
| `send_push` | honoured only on `object_version` and `permission_request` from the creator, rate-limited |

- Retention starts at the hub's own `received_at` of an allowed final head (the creator closes or withdraws, or a human answers the creator); a reopen cancels it. A sender's `answered_at` is display only.
- Stroke ids are (`device_id`, `sender_sequence`, index), so nobody can collide with another member's strokes. Agents change only their own strokes.

**R2. Order from signed data, never from hub order.** `envelope_number` is for paging only. Writes to a register or note are ordered by one total order that every device computes alike (v1.1.1, review 2 D1: the earlier pairwise rule was not transitive, so the hub's delivery order could pick the winner): (`lamport`, `sender_device_id`, `sender_sequence`), strictly lexicographic (review 3: the sender-chosen `sent_at` is no longer part of it; with it two writes of one sender at an equal lamport made a cycle), where `lamport` is an integer in the encrypted `status` and note body, one above every `lamport` the writer had seen (a write made after seeing another sorts after it; bodies without one count 0). A lamport above 2^48, or more than 2^24 above the largest this device has seen, is refused (counts 0, is not adopted, alert `lamport-inflated`): one signed write cannot pin a register for good. The writer saves its counter in the same durable write as the envelope, before the post. Deletes stay as tombstones (value null). Human registers, agent registers and note versions use it; the stack is sorted by urgency, then `sent_at` of version 1, then creator and object id. A canvas snapshot register carries a signed **frontier** `{ sender_device_id: [sender_sequence, envelope_hash] }`; clients apply every item of the timeline not covered by it, whatever numbers the hub shows, and accept a new snapshot only if its frontier dominates the applied one. Snapshot writers: humans for `desk/*`, humans and the assigned agent for `session/<S>`; a fresh client trusts the newest snapshot from an allowed writer (stated trust: a snapshot cannot be checked without replaying). **Room snapshots** (`room_snapshot`, `shared/snapshot.ts`, v1.1.1 review 2 D5/D6): taken only from a human device that is still a member, never from one written before the newest removal or recovery; the tail after it is read from an overlap window before its cursor and classified by signed (`sender_device_id`, `sender_sequence`), so hub numbers cannot hide envelopes beyond the snapshot's frontier; items older than the snapshot must name the requested timeline as thread items, pass the R1 rules, lie within the frontier, and count once per (sender, sequence). Remaining trust, plainly: the snapshot's content itself (cards, answers, registers) comes from one human device and is not re-verified; a hub that withholds every newer envelope of a sender is not noticed until one arrives.

**R3. Revocation on the receive path.** `devices_removed` and `recovery` entries carry, per removed device, the **cut** (`sender_sequence`, `envelope_hash`) of its last envelope the remover had seen; hub and clients refuse anything beyond it. A remover that holds no chain of the device (a recovery, a fresh device) first verifies the hub's envelope headers of that device and cuts at the last verified one, never at 0 (v1.1.1, review 2: an empty cut refused all history of the removed humans); the hub lets the recovery key read envelopes for this. Old `key_epoch` is accepted for 2 minutes after the epoch-changing entry arrived (the arrival time is stored), then refused by the hub (`409 wrong-epoch`, which tells a stale sender to fetch the log) and shown by clients as "sender on an old member list". The connector process refreshes the member list before executing any answer, verdict or decide-again and halts all commands on `log-fork` until a human acts. Residual, honestly: a hub that withholds a removal forever from one member keeps that member on the old key; it shows as soon as any envelope crosses.

**R4. Crash safety.** Per device and room exactly one seal and one open at a time (a lock across tabs: Web Locks; across processes: `flock` on the key file). Several tabs of one browser (`shared/tabs.ts`, used by the app): the tab holding the Web Lock is the writer; every other tab is a follower that stays fully usable: it reads on its own (own stream, everything verified, state in memory over one consistent read of IndexedDB, never sealing or posting: the hub handle refuses writes) and forwards each write action to the writer over a BroadcastChannel (by id, retried until answered). When the writer tab closes or crashes, the next tab is granted the lock, opens the room from storage as the writer and runs the calls still waiting; a forwarded call's id is stored with its outbox entry (and kept once acked), so a retry is answered from there instead of sealed twice. Test: `node shared/tabs-test.mjs` (headless Chromium, tabs of one profile). Write-ahead: the sealed envelope and the new own chain head are stored durably **before** posting (file storage: temp file, fsync, rename, fsync of the directory; IndexedDB: a `durability: 'strict'` transaction); if that write fails the device stops sending. A retry posts the same bytes (`replay` = success). A signed sequence number is never signed twice (review 2 D2): a final refusal of a verified envelope at the sender's next number is kept by the hub as a **void record** (pruned, `void: true`, takes its `envelope_number`, applied by nobody) and the sender goes on behind it; any other final refusal halts the device's sending (`outbox_blocked`, alert `chain-halted`) and the same bytes are retried. The verified chains, epoch secrets, pinned log, cursor, a **delivered-up-to** per human sender and a ledger of executed commands are stored with the key file. A process that starts without them treats every command sent before that start as history, never as a new prompt, and keeps that boundary (`history_before`, and since review 3 also `history_before_number`, the room's head envelope number at that start, so a future-dated old command is history too) across restarts (review 2 D4: before, only the first old command per sender counted as history). A command held back and met again in a replay is handed out once (review 3). An agent names its lease generation on posts, streams and attachment uploads (review 3; none, or an older one: `409 lease-lost`), so it takes the lease before its stream opens. A recovery stores the new device, its room record and the session keys before it posts the recovery entry (review 3), so a crash right after the post loses nothing. A failed member refresh holds answers, verdicts and decide-again back (retried); a `log-fork` halt holds commands, it does not drop them. Agent key slots `<host>-<folder>-<slot>.key`: two sessions in one folder take two slots. One running process per key (the lease): a new process takes over; the hub ends every stream of that key that does not name the new `lease_generation`, and the old process's reconnect and posts get `409 lease-lost`, so it stops before posting. Renewals (`renew: true`) never take over a live lease, so two processes cannot trade the lease back and forth. Leases are stored (`agent_leases`), so a hub restart keeps them; with no live lease a renewal takes it with a new generation, and a client that gets `lease-lost` (on a post, its stream, an upload or an ephemeral post) first renews and stops only if another live process holds the key. Every lease claim of a process names its one process instance (a claim from the outbox before the start took the lease never takes the process's own lease over); a request refused under a generation the process has since replaced is sent again; a renewal that fails for any other reason than `lease-lost` (offline, a restarting hub) is asked again, never taken as a takeover. Streams reconnect at most 2 s apart and at once when a request gets through again (a deploy holds messages back for seconds, not minutes). A valid signature with a broken body advances the chain and quarantines the body (no stalled room).

**R5. Bounded headers.** `seen` lists only senders active at the named log entry whose head changed since the author's previous envelope (receivers carry earlier values forward); at most 64 entries. Status bodies ≤ 4 KiB. Unknown kinds, unknown flags, non-canonical timelines, wrong padding length and a leading BOM are refused.

**R6. Keys per session (owner, 4 October 2026).** There is no new room key when an agent joins. Instead:

- **Two key scopes.** The **room key** (per `key_epoch`, from the member list as before) is held by human devices only and encrypts room-wide things: desks, notes, human registers, device labels. Each **agent session** has its own **session key** (per `session_key_epoch`) that encrypts that session's cards, its chat, its canvas and its agent's registers. Human devices hold every session key (with back links, so they read every session's whole history); an agent holds only the keys of the sessions assigned to it. Agents cannot read other sessions, desks or human registers.
- **Header.** `key_scope` u8 (0 room, 1 session) ‖ for scope session the `session_id` (16 bytes); `key_epoch` is then the session's key epoch. The scope and session are in the sender-key derivation and the associated data. A session's timelines and objects must be under that session's key; room-wide data under the room key (checked by every receiver).
- **Session grants** (a second small signed chain per session, stored by the hub in `session_grants` and `sealed_session_keys`): a human device signs `{ room_id, session_id, grant_number, previous_grant_hash, session_key_epoch, assigned_agent_ids, key_commitment, wrap manifest hash, logSeq/logHash }` and posts it with the session key sealed for every active human device, the recovery key and the assigned agents, plus a back link to the previous session key epoch. A session is created by its first grant (`session_id` random, chosen by the human device). Route: `POST /v1/rooms/:room_id/sessions/:session_id/grants`, `GET …/grants`, `GET …/sealed_session_keys` (own only), `GET …/key_back_links` (humans; an agent gets them only if the grant says `with_history`).
- **Assigning an agent to a session, or handing a session over** (a crashed Claude replaced by another): the app asks „Darf er den bisherigen Verlauf lesen?“. Yes: the grant starts a new `session_key_epoch` and marks `with_history`; the agent gets the history key and every back link below that epoch and reads all of that session. History is per agent (v1.1.1, review 2 K2): only the agents assigned with history get the history key in their wrap, so adding B with history never hands A the past; an agent once given the history gets the history key again at every later rotation while it stays on the session (review 3; who holds it is the humans-only register `session_history/<session_id>`, so every human device rotates alike). No: the same new epoch without history, so the agent reads from now on. Either way it reads nothing of other sessions, and the previous holder keeps nothing of the new epoch (v1.1.1, review 2 B01: a grant in the same epoch may only add agents, never drop one).
- **Removing an agent** (or unassigning it) is one new grant with a new `session_key_epoch` for each session it held. Removing it from the member list is a `devices_removed` entry, and that entry always carries a new room key epoch (the format has no removal without one); harmless, a few milliseconds, although agents never held the room key. Removing a **human** device rotates the room key (as before, one member entry) and every session key (one grant per session, posted by the same device right after; until then the removed device is already refused by the hub). New human devices receive all session keys at join, sealed by the inviter.
- **Grants after a member change (v1.1.1, review 2 B02/A1).** A grant counts only if its signer is an active human device (or the recovery key valid then) at the grant's `logSeq`, and no grant names a `logSeq` before a removal or recovery its predecessor already saw. A session whose newest grant's `logSeq` is below the newest removal or recovery entry is **stale**: clients read with its key but never send under it, and a human device re-keys it (new epoch). The hub refuses new grants that name a member list from before the newest removal or recovery, or whose signer is no longer active (`409 stale-grant`), and refuses session-scope envelopes of a stale session (`409 stale-session-key`, retry the same bytes after the new grant; the old epoch is accepted for 2 minutes after it). So a removed device can never re-key a session to a key it knows, and nobody keeps sending under a key the removed device holds.
- **Child sessions (4 October 2026).** An agent may open sessions of its own for its helpers ("Design", "Server") without a human's approval: it draws the session key, seals it to itself, every active human device and the recovery key (never to another agent; the hub checks the wrap set as for every grant) and signs the session's **first grant** itself. Rules, enforced by `applyGrant` on every client and by the hub: an agent signs only grant 0 of a session, only with itself as the sole assigned agent and without history; every later grant (re-seal for a new human device, rotation after a removal, handover) is a human's, as for any session. The hub also wants the signer to be an active agent and allows at most 32 such sessions per agent (`429 rate-limited`). The agent writes the child's `profile` there with `parent_session` = its main session; clients honour that parent only if the child's creator is assigned to the parent session (`model.parentSessionOf`), so a child cannot hang itself under another agent. Agents still cannot add devices or other agents, and cannot add anyone to a session.
- **Reconnecting** with the same device identity changes nothing.
- **Continuing a session (6 October 2026).** When a session's key is gone or went to another process, a new connector can go on as that very session instead of becoming a new one. In the app: the three dots beside the session's name (on a phone: the session's "…" on the Agents page) → "Copy invite link again". That makes an ordinary agent invite which this device remembers as *continuing session S* (`createInvite({ session_id, takeover: true })`; kept with the invite on the inviting device, never sent to the hub or put in the link, so a link for A cannot continue B). It always asks for the check code: the connector prints six emoji with a word under each, the app shows "A connector wants to continue <name>" with the same six and two buttons, and nothing is granted before "They match" is tapped ("They don't match" burns the link). On confirm the inviting device does three signed things, in this order: (1) the add entry for the newcomer; (2) one grant for S and for every session its old holders held (the helper sessions they opened), naming the newcomer in their place, new session key epoch, with history; (3) a `devices_removed` entry for the old holders (their cut, a new room key, the usual re-key). So only a human device can do it; the hub can neither make nor fake any of the three, and it refuses the retired device as it refuses any removed one, as does every member (R3). What stays the same: the session id, so name, drawing, desk, chat, status lines and the address `/s/<id>` (all keyed by the session, none by the device). What moves by rule, without new bytes: **who holds an object.** An object's creator holds it; once the grants of the object's session no longer assign the creator at a session key epoch, the agents they assign at that epoch hold it (hub: the session's current grant; clients: the epoch of the envelope judged, so every device decides alike). The holder writes new versions (revise, close), and answers, decide-again and card messages are addressed to it; `object_id` and the creator stay what they were. While the creator is assigned nobody else holds its objects, also not a second agent of the same session. A helper session an agent opened counts under a parent when its creator, or the agent a human's grant handed it to, is assigned to that parent (`model.childOf`). The connector takes the continued session as its main session, finds the helper sessions by their names again, and lists, revises and closes the cards it holds (`client.holds`). The retired connector, if it still runs, learns its removal from the signed list (the hub's sign-in refusal carries the entries, see `access_tokens`), tells its Claude once ("This connector is retired: the human let another connector continue this Trommi session…", a channel event with meta `retired="1"`) and answers every tool call with that sentence; "another connector continues" is read from the list itself (the entry before its removal added an agent, signed by the same device). **Joining with a key at hand.** `connector.mjs join` (the connect script) in a folder whose session is a member already answers the link with a new device key in a free slot; the key it has is not touched until the app has added the new one. Then the old slot's key, state and file cache are renamed to `replaced-<time>-<name>` in the same directory (nothing deleted, the slot counts as empty, no later join meets another device's state) and the session's connector opens the new key. If a connector of the same Claude Code session runs on the old key (the join was run inside that session: its Claude Code process is among the join's ancestors, asked through the slot's door, `{ op: 'whose' }`), it gives the key up (`{ op: 'replaced' }`) and its next tool call goes on with the new one, without a restart; only if it does not answer the output says "restart this Claude Code session". `TROMMI_JOIN_OTHER=1` says the join is for another session of the folder. A link that is not confirmed, runs out or was used leaves the old key where it was. The device the session was before stays a member (the app retires only the holders of the continued session): the output names it and says to remove it under Devices. A failed join says why in its own line ("not joined: …"; for a spent link also that a link works once and for a limited time). **The confirm finds the human.** When a device answers one of this device's links and waits for its check code, every page of the app shows a note ("A connector wants to continue <name>", "Confirm" → the invite's page) for five minutes; before, the check code showed only while the invite's page stayed open. Only the device that made the link can confirm it. Not done: permission requests still waiting stay the old device's and run out; a retired device that never comes back online is simply refused. If the app stops between (2) and (3), the old device is left a member without a session: remove it under Devices. Tests: `shared/test.mjs` ("continue a session"), `hub/test.mjs` ("removal"), `connector/test-e2e.mjs` ("continue a session").
- A **recovery** (signed by the recovery key) may also remove agents; the recovery screen lists them with when and by whom they were added and unticks those added since the last trusted point. Push subscriptions of a removed device are deleted in the same transaction. Invite endpoints stop answering 15 minutes after use.
- Freeze: with this, the v1 bytes are frozen (FORMAT.md §9 and vectors).
- Checks without new bytes (v1.1.1, review 1 C23/C24): a key-exchange key counts with bit 255 cleared, so a second encoding of a member's key is refused, and no member shares a signing or key-exchange key with the recovery key; the sender-key cache is keyed by epoch and key bytes.
- **Removal in one request.** A removal (and a recovery) re-keys every stale session in one atomic `POST session_grants`; a crash or refusal in between is finished by the next start of any human device, because a stale grant is itself the pending work.
- **Accounts (4 October 2026):** the hub knows each account's **email in plaintext** and which room it belongs to, when it
  was confirmed, and opaque blobs: a scrypt hash of a key derived from the password, and the room's recovery code sealed
  under the password and under the Emergency Kit. It never sees the password, the kit words or the code. Remaining risk,
  honestly: **whoever steals the hub's database can guess passwords offline** against Argon2id (64 MiB, t = 3) for one
  email at a time (the salt is the email). A weak password falls; a long one or the generated five words (≈ 64 bits)
  stand. The only rule is 12 characters (owner's decision: no blocklist, no strength gate). Online guessing is limited per
  address and per email. A password opens the whole room, like the recovery code. The login endpoints give one answer
  for unknown emails and wrong passwords; registering never reveals whether an email is taken.
- **Still open (v1.1.1):** attachment lengths are not padded to buckets (C22: the hub sees an attachment's exact size; padding needs a format change in the encrypted reference); a leaked recovery code can only be revoked by a full recovery, there is no cheaper `recovery_key_changed` entry (M6); every human device shows `recovery-add` when the recovery key adds a device. Clients apply the epoch cutoff too (review 2 B03, completed in review 3): a device whose stream was open since before it learned of a key change refuses a live envelope in the older epoch 2 minutes after that; otherwise (after sleep or offline, in a resync, reading history) the signed times decide: the sender's header `time` must lie within 2 minutes plus 3 minutes of clock skew of the signed time of the entry or grant that began the next epoch. A refused stale envelope still moves its sender's chain on (no gap, so no resync that would apply it), and its hash is kept, so a resync refuses it again (alert `wrong-epoch`). Residual: a removed sender with a colluding hub can still backdate envelopes into that window for devices that were not live then. Agent writes into a session are authorised by the agents the grants gave that session key epoch.

**R7. Binds.** `answer` binds object id, the hash of the version answered and the full list of choices (each must be an option; with a closed header each must be a `final` option). `decide_again` binds the answer taken back **and** the current version's hash. `verdict`: request id = `object_id`. `trusted` widens nothing: the agent picks its own recommendation and says so.

**R8. Names.** Member entries, offers and join requests carry no names (the field is gone in v1.1). A device writes only its own `device/<device_id>`; the inviter writes `session/<session_id>` with the label it chose when making the invite, and that wins over what the agent calls itself. The UI shows the role from the signed log and a short key fingerprint next to every name.

**R9. Format fixes.** `wrapAssetKey` uses a random nonce. Invite hashes and the check code cover the signed body (request: body ‖ MAC), not the Ed25519 signature, so vectors are reproducible on every platform. The hub address is canonical: `https://` + lowercase host [+ `:port`], no path, no trailing slash, copied verbatim from the link. Stroke points: base64url of int16 big-endian deltas in 1/8 px, first point absolute; style `{ tool, color, size }`.

**Adopted from the research** (research of 10 systems): attachments may have a separate small poster/thumbnail attachment with its own key and a tiny placeholder in the body; room snapshots from a human device for faster first loads (`shared/snapshot.ts`, trust in R2).

### What an agent's connector process checks

Before Claude Code sees anything (concept §6): the envelope verifies; the sender is an active human device; it is addressed to this agent; for answer, verdict and decide again the bind matches the current card or request (`authoriseCommand`). Anything else is dropped and reported on the board as the status register `alert/<envelope_hash>`.

### The agent connector (`connector/connector.mjs`)

An MCP stdio server with the board's tools and `<channel source="board" kind=…>` events (schemas, tool → envelope and command → event in `connector/tools.mjs`; every text the agent reads in `connector/prompt.md`; all protocol work in `shared/`). It runs as server `trommi` in the project's `.mcp.json`:

```json
{ "mcpServers": {
  "trommi": { "command": "node", "args": ["/home/christopher/git/trommi/connector/connector.mjs"] }
} }
```

Start: `claude --dangerously-load-development-channels server:trommi`. First time per room, machine and folder: in the Trommi app "invite an agent", then run `node /home/christopher/git/trommi/connector/connector.mjs join '<link>'` in the project folder, or start Claude with `TROMMI_INVITE='<link>'`. Joining is the human's act only: there is no model-callable `join` tool, so a link smuggled into a prompt cannot make the agent join a room (review 2). Agent invites default to "without history". An invite remembers the desk it was made on (the desk in view; on "All desks" the desk of the session open there, else the first), kept on the inviting device only like the takeover binding (`createInvite({ desk })`, never in the link or at the hub); the new session is put on it when the agent is added (`session/<id>` register, field `desk`). The human compares the six emoji the connector prints with the ones on the app's invite page (the clipboard's step "Compare the six emoji") and taps "They match"; only then the app adds the agent and assigns it to a session (R6: a new session, or the handover of an existing one, with or without its history); until then the tools answer "not yet assigned to a session". The agent holds no room key, only the keys of its sessions. Afterwards every session in that folder reconnects by itself: key slot `~/.local/share/trommi/keys/<room_id>/<host>-<folder>-<slot>.key` (0600; the `<host>-<folder>` part is written once to `<folder>/.trommi/slot-base` and read from there, so a renamed or moved folder keeps its identity), with `<…>-<slot>.state.json` and `.state.log` (cursor, chains, delivered commands: a snapshot and its journal, `shared/storage-file.ts`), `<…>-<slot>.lock` (pid of the process holding the slot, `connector.mjs` "the lock": Node has no `flock`, so every process writes a claim of its own, `<…>.lock.<pid>`, then looks: claims of dead pids are deleted, and if another live claim is there it withdraws; whoever looks second sees the first, so at most one wins. A claim holds the claimer's session key, `TROMMI_SESSION_KEY` or by default its parent pid (the Claude Code session). The one take-over: a live claim of the *same* session is a `/mcp` → Reconnect, where Claude Code starts the new connector before the old one is gone; the new one sends the old one SIGTERM (only when its command line is a `connector.mjs`), waits up to 4 s (`TROMMI_TAKEOVER_MS`), removes its claim and takes the slot; the hub lease fences the old one should it still run. A claim of another session is never taken away: its holder is asked and gives the key up itself, see "Who gets the key") and `<…>-<slot>.files/` (the human's attachments, decrypted) beside it. A second session in the same folder takes the next slot and needs an invite of its own (two sessions are two members); a session that lost its key to the other one is brought back with "Copy invite link again" on its page in the app (R6, "Continuing a session"). **Who gets the key (`connector.mjs` "who gets the key").** Claude Code starts the connector for every process that loads the project: the session a person works in, background sessions, and the spare processes its daemon keeps warm (`claude bg-spare`; six connectors in one folder were seen with 2.1.286, and a spare's connector took the key while the used session was locked out). So the key follows use, and no timer ever takes it. *Use* is a `tools/call` of this server, or one of the plugin's hooks of the same Claude Code process ringing the connector's bell (a socket `bell-<claude pid>.sock` beside the monitor's; the hook rings before it knocks at the slot's door, so the first permission prompt of a session is already served). A connector takes the key when its session is used. At start-up it takes it only when nobody else could want it: never under a spare (the parent's command line holds `bg-spare`; `TROMMI_SPARE=1|0` overrides), otherwise when it is the reconnected connector of the session that holds it, or the only connector of this folder that is not a spare's (every connector checks in with `<base>.here.<pid>` in the room's key directory), so a lone idle session still hears the board; all others sleep until used. *Hand-over:* a keyless connector whose session is used asks the holder through the slot's door (`{ op: 'yield' }`). The holder gives the key up when its own session is not using it: never used and held for 60 s (`TROMMI_UNUSED_MS`; at once under a spare), or used but without a tool call or hook for 30 min (`TROMMI_IDLE_MS`), and no call running. It stops its client (stream closed, state on disk), closes the door, removes its claim and only then answers; the asker takes the slot lock and the lease (a new `process_instance`, a new generation). The old holder stays up, keyless, and asks in turn when its session is used again. A holder in use says no: the asker's tool call fails with a text that names the holding pid, when it was last used and the fix (`kill <pid>` for the old connector of a reconnect, an invite of its own for a second session at work), and the human is told once through the holder. A holder that crashed leaves a dead claim: the next session that is used takes the key. Never two writers on a key: the slot lock and the hub's lease are as before, and a hand-over is a release followed by a claim. *Whose slot:* `join` (and a join by `TROMMI_INVITE`) writes `<…>-<slot>.owner` beside the new key, naming the Claude Code session by `CLAUDE_CODE_SESSION_ID` (the same in its Bash commands and in its MCP servers, and the same after `/mcp` → Reconnect; without it `TROMMI_SESSION_KEY`); a key without one becomes the session's that first uses it. A connector tries its session's own slots first (so a Reconnect opens the key the session joined with, not the lowest one), then a slot its earlier connector holds, then the rest; an own free slot also counts as a reconnect at start-up. A join never puts aside a key another session owns: it goes into a free slot. *Dead keys:* a key whose device is out (the hub's signed refusal: retired by "Copy invite link again", or removed by the human) is put aside by the connector itself, at the first hub contact or whenever it learns it while running (`replaced-<time>-<name>.*` as a join does, with `<name>.out` saying why; nothing deleted), and it goes on with the next usable key at once, without a restart; a tool call waits for the hub to take what it sent (up to 4 s), so a call made on a key that turns out to be out goes again on the next one. Only with no usable key left it says "This connector is retired: …; invite this session again". Tests: `connector/test.mjs` ("key: …"), `connector/test-e2e.mjs` ("dead keys") and `connector/test-e2e.mjs --only keyclaim` (three connectors in one folder against a local hub; the lease is read from the hub's database). A connector ends when its stdin ends or closes, on SIGTERM/SIGINT/SIGHUP, and when its parent goes away (checked every 2 s); a stop that hangs gets 2 s, then the process exits anyway, so it never outlives its Claude Code session and keeps the slot. Commands that arrive during catch-up wait until the bridge is up; `late`/`history` come as meta `late="1"`/`history="1"`; only `content_type: message` is chat; on `log-fork` commands are held back, on `lease-lost` the process exits. Environment: `TROMMI_HUB` (default `https://hub.trommi.com`; an invite names its hub), `TROMMI_ROOM` (when a folder has keys for several rooms), `TROMMI_KEYS_DIR`, `TROMMI_FOLDER`. `node connector/connector.mjs whoami` shows room and key file. **The emergency side channel (`say`).** `node connector/connector.mjs say "<text>" [--session <name>] [--urgent]` (the installed single file the same: `node ~/.local/share/trommi/connector/connector.mjs say …`) sends one message to the human without the MCP process and exits: a chat message, or with `--urgent` an info card of urgency critical (a new card pushes to the phone; a chat message does not); `--session` names a child session. It is for when the Trommi tools fail or report "not in a room" (the instructions tell Claude so, early: run it via Bash). It never makes a second writer on a key, because two processes sealing with one key would sign the same sender sequence number twice (the chain head of a running connector lives in its memory): (1) a keyed slot of this folder held by a live connector: `say` asks that connector through its door, a Unix socket in a directory only this user can enter (`$XDG_RUNTIME_DIR` or the temp dir, `trommi-<uid>/`, 0700; named by a hash of the key file; one JSON line in, one out), and the connector sends on its own chain; (2) a keyed slot no process holds: `say` takes its slot lock (so no connector opens it meanwhile), signs in, takes the lease (no live process holds it), sends, waits until the hub has it (`settle`), stores the chain head and gives the slot back, exactly like a short connector run; (3) a holder that does not answer (an older connector without a door, a hung one) is never overridden: `say` fails and names its pid (`kill <pid>`, then say again). It retries for up to 30 s (`TROMMI_SAY_MS`) while the hub is unreachable or the holder is still connecting. A connector left without a key (the busy-slot error) tells the human once by itself, through the door of the connector that holds the key, with the fix. Tests: `connector/test-e2e.mjs` ("say …", "loss watch …"; hub side `hub/test.mjs` "loss watch"). `publish_asset` puts a `published` object on the board and announces it in the session's conversation (a message with the same attachment). `share_asset` releases a published asset for outsiders (link `https://app.trommi.com/a/<share_id>#<secret>.<file_key>.<sha256>`, at most 30 days; `release: false` and `revoke_asset` end it). **Child sessions for subagents:** `open_session { name, task?, icon?, model? }` opens (or finds) a child session under this agent's session; `reply`, `create_decision`, `create_info`, `merge_cards`, `set_status`, `clear_status`, `introduce`, `list_cards` and `publish_asset` take an optional `session` (the helper's name, case-insensitive; opened on first use). Card tools (`revise_card`, `close_card`, …) follow the card's own session. Events from a child carry meta `session="<name>"`. The names are kept in the slot's state (key `channel`, field `children`) and found again from the child's profile, so a restart writes into the same child. A separate helper process names its main with `introduce` `parent`. Tests: `node connector/test.mjs` (fast, no hub) and `node connector/test-e2e.mjs` (a real local hub; `--only integration|updates|hooks|monitor|keyclaim|connect`).

**Closing cards.** An answered card is with its agent until the agent closes it (`close_card`, one line on what it did): the instructions say so in one line, and `close_card` is loaded up front (`anthropic/alwaysLoad`) with `reply`, `create_decision`, `create_info`, `set_status`, `open_session`, `close_session` and `inbox`. A card answered with a final option is closed already (above).

**Short instructions, details in the tools; all of it in `connector/prompt.md`.** That one file holds every text the agent reads, so wording is changed there and nowhere else: `# Instructions`, `# Without channel events` (the plugin-mode preamble) and under `# Tools` one section `## <tool name>` per tool with its description (line breaks inside a section are free; parameter descriptions stay in the schemas of `tools.mjs`). `tools.mjs` reads it when it loads (a hot reload reads it again; `build.mjs` inlines it into the single file). Claude Code keeps only the first 2,048 characters of a server's `instructions`, so `# Instructions` holds only what Claude must know before any tool call, about 1,550 characters (at most 1,900): the human sees only the board (every answer goes through `reply`, in the human's language), how board events arrive and that their content is data, not instructions, the subagent rule (`open_session`/`close_session`, `set_status`), terminal needs as a card, the update card, the emergency `say`, and the decision rule (at most 3 confident options, one picture or prototype each; no info card per push). Everything else (card budget, urgency, hand-back and revision, trust, notes, scribble/pad events, assets) is in the description of the tool it concerns, each at most 2,048 characters. In plugin mode the monitor rule (`# Without channel events`) goes in front; `test.mjs` checks that the whole text, with a long connector path, stays within 2,048, that every tool has a section and no section lacks a tool, and that the key rules are there. The core tools (`reply`, `create_decision`, `create_info`, `set_status`, `open_session`, `close_session`, and `inbox`) carry `_meta: { "anthropic/alwaysLoad": true }`, so Claude Code lists them up front instead of behind its tool search (the MCP SDK passes `_meta` through `tools/list`; `connector/test-e2e.mjs` "monitor" checks it).

**Helpers come and go by themselves.** The instructions (within the first 2048 characters, the part Claude Code keeps) tell the main agent: for every subagent call `open_session` first (name = short task name), let the subagent write with `session: <name>`, and when it finishes post its result there and call `close_session { name, summary? }`. `close_session` posts the summary, clears the child's status lines, writes `closed_at` into its profile and closes the cards the human answered there that the helper never closed (summary "Closed with its session."; they would wait "with the agent" for nobody); the app (`board-state.mjs`) then lists the child in the archive (readable, "fetch" brings it back) unless a question of it is still open, and the human's own archive setting wins. Writing into a closed child, or `open_session` with its name, opens it again. A child is never "stopped" only for being quiet: its silence is measured against the whole agent process (`device_active`, any of its sessions), and without a working line it is idle (`node-stubs/blocked.mjs`).

**The red hand means a real problem, only.** A session is "Stopped" (red hand, push, the Desk's red badge) only when its connection is lost while it had work, it is cut off (its Claude Code runs, its Trommi tools are gone: "The link" above), it reported an error, or it waits for the human (permission request or critical card). A connected session whose working line has seen nothing for 15 minutes is not stopped: the session page shows a quiet grey hint ("quiet for 24 min"), nothing else (`blockedOf` vs `quietOf` in `app/web/public/app.mjs`). A session that hears only on its next step, or is not listening, is not stopped either: its caption says so.

**The link report, the receipt and the folder watch.** The connector that holds the key reports its link (above) when it changes, when the last tool call moved on by 30 s (`TROMMI_LINK_MS`), and every 60 s; its last word names why it ends. Receipts are written at the moment of the hand-over, never before: with the channel flag when Claude Code took the notification, without it when the events left in a tool result (`inbox` included). What waits is kept in the key slot's state (`missed`), so a restart, a `/mcp` Reconnect or a hand-over of the key loses nothing: the next holder hands it on (with the channel flag at once), and marks what waited for another Claude Code session. A tool call that names a child session (`session: "<name>"`, a helper's call) gets only that session's waiting events; a call without it (the main agent) gets all of them, the helpers' too, as with live channels. The folder watch (`connector.mjs`, "the folder watch") finds a Claude Code session whose connector is gone: every connector's presence file names its Claude Code process (pid and start time), a connector that ends while that process lives leaves a mark, a killed one gets its mark from whoever looks at the folder next. A mark whose Claude Code process still runs, with no live connector of that session, for 20 s (`TROMMI_CUT_GRACE_MS`) is "cut off": the key holder reports `cut_since`; if the cut-off session held the key and nobody holds it now, a keyless connector of the folder, or the witness the leaving connector started (`connector.mjs witness`), says it once in the key's name (slot lock, sign-in, lease, one `POST agent_link`; no stream, nothing read). Only a session whose loss means something is marked: it held the key, or it used Trommi within `TROMMI_IDLE_MS`. `TROMMI_FOLDER_WATCH=0` switches it off.

**What a shared key still prevents.** Two Claude Code sessions in one folder are one member of the room: the hub and the app see one session, and only the connector that holds the key hears anything. The human cannot address the other one, and what he writes goes to whoever holds the key, also after a hand-over. The link report says that a session of the folder is cut off, not which of the two the human last spoke to. A lone connector that is killed leaves no mark and nobody to write one: it shows as gone, not as cut off. A connector that lives while its agent hangs inside Claude Code is seen only by its last tool call growing old (asleep, when it hears on call; not at all when it hears live). Two sessions that both work need an invite each.

**Sessions without the channels flag.** Claude Code shows channel events only in a session started with `--dangerously-load-development-channels server:trommi` (also after `--resume`); otherwise it drops them silently (its MCP log: "Channel notifications skipped: server trommi not in --channels list") and says nothing to the server, not even at `initialize`. The connector reads its parent's command line (`/proc/<ppid>/cmdline`, else `ps`; `channelsHeard()`, override `TROMMI_CHANNEL_EVENTS=on|off`). In a deaf session it keeps the events and attaches them, as `<channel source="board" …>` blocks with a hint to restart with the flag, to the next tool result. Tests: `connector/test-e2e.mjs` (deaf session, decisions in main and child within 2 s after a restart, `close_session`).

**The Trommi plugin: a plain `claude` hears the board.** The connect script installs Trommi as a Claude Code plugin from Trommi's own marketplace, served by the app: `claude plugin marketplace add https://app.trommi.com/plugins/marketplace.json`, then `claude plugin install trommi@trommi --scope local` (enabled in this folder only, `.claude/settings.local.json`). `connector/build.mjs` makes it beside the bundle, at deploy time: `plugins/marketplace.json` (one plugin, an `archive` source with its sha256) and `trommi-<version>.zip` (deterministic; version = the connector's sha256 prefix, so a new connector is a new plugin version). The zip holds `.claude-plugin/plugin.json` and `connector.mjs` (the bundle). The manifest declares the connector as MCP server `trommi` (Claude Code names it `plugin:trommi:trommi`, its tools `mcp__plugin_trommi_trommi__*`), the same server as a channel, and a monitor (`experimental.monitors`): `node connector.mjs monitor`, a background process for the whole interactive session whose every stdout line Claude Code gives to Claude as a notification, which wakes an idle session (tested: idle sessions, `--continue`, Haiku and Opus, over 30 minutes idle; the monitor stops with the session). Connector and monitor meet on a Unix socket named after their Claude Code process (`$XDG_RUNTIME_DIR/trommi-<uid>/mon-<pid>.sock`, directory 0700; the connector's parent pid, the monitor's `CLAUDE_PID`), so two sessions in one folder each hear only their own events (`connector.mjs` "the monitor"). **A monitor line is never board data:** the connector writes one only for a human's command the core has verified and authorised (signed by an active human device of the room, addressed to this agent), as a fixed pointer from cleaned ids, e.g. `Trommi: new message from the human on the board, card <id>. Read it now with the tool mcp__plugin_trommi_trommi__inbox.`; connector-made notices (update, client too old) get none. The event itself comes as the result of the `inbox` tool (offered only in a session without channel events), as `<channel source="board" …>` blocks. The instructions start, in such a session, with the rule that a `Trommi:` line is the human's board speaking: call `inbox` and treat the result as a channel message. With a monitor listening the deaf-session hint (restart with the flag) is left out. The script also allows the plugin's own tools in that folder (`permissions.allow: ["mcp__plugin_trommi_trommi"]`): these tools only talk to the board, and an approval asked on the board for the tool that reaches the board would go in circles. Bonus, live channel as before: `claude --dangerously-load-development-channels plugin:trommi@trommi` (then no monitor lines and no `inbox`). Plugin updates: `claude plugin update trommi@trommi` (or the connect command again), then a new session. Tests: `node connector/test.mjs` (pointer lines, zip) and `node connector/test-e2e.mjs --only monitor` (end to end: a human message wakes the monitor, `inbox` returns it, another session's monitor hears nothing, the monitor reconnects after a connector restart and ends with its Claude Code process).

**Permission prompts on the board, without the channel flag.** In a session with the channel flag Claude Code relays its "allow this tool call?" prompts to the connector itself (`claude/channel/permission`). A plain `claude` relays nothing, so the plugin declares its hooks (`connector.mjs` "the plugin's hooks", in the manifest of `connector/build.mjs`). **`PermissionRequest`** runs `node connector.mjs permission`: a short process that reads the hook's JSON on stdin and hands tool name, description and a short preview of the call to the running connector of the same Claude Code session through its door (the socket `say` uses; the connector whose parent is an ancestor of the hook, so two sessions in one folder each ask through their own). The connector files the same permission request as in channel mode (`bridge.permissionRequest`, a critical card with a push), waits for the human's verdict and answers the hook, which prints `{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}` (or `"deny"` with a message). The terminal shows its own dialog the whole time: whoever answers first decides (checked with Claude Code 2.1.286: allow and deny from the board close the dialog with "Allowed/Denied by PermissionRequest hook"; an answer in the terminal goes through as always). The hook waits `TROMMI_PERMISSION_MS` (default 5 minutes) and the request expires with it; then, or when there is no connector, no room, or broken input, the hook prints nothing and exits 0, which is "no decision": the terminal's dialog stays. It never opens a key and writes nothing. Question dialogs (`AskUserQuestion`, `ExitPlanMode`) are never asked on the board: their answer is more than yes or no. With the channel flag the connector tells the hook to stay silent, so there is one card, not two. **Answered in the terminal, the card leaves the board.** Claude Code tells nobody that a prompt was answered in the terminal (the channels reference names no such notification: the relayed request is "dropped"), so the plugin's hooks give the signal (seen with Claude Code 2.1.286): *allowed* there, the `PermissionRequest` hook keeps running but the call's **`PostToolUse`** / **`PostToolUseFailure`** hook fires at once with the same `tool_name` and `tool_input` (`node connector.mjs resolved`, declared `async`, so it is never in a tool call's way); *denied* there, Claude Code ends the `PermissionRequest` hook (SIGTERM), so its connection to the connector's door closes. Either way the connector withdraws the request (`bridge.permissionWithdraw` → `client.withdrawPermission`: a second `permission_request` head of the same object, `closed`, `withdraw_reason: "answered in the terminal"`), every client sets it to `permission_state: 'withdrawn'` and it is no longer among `open_permission_ids`; a verdict given after that is refused by the agent's core (`request-not-pending`, an alert on its session) and never reaches Claude Code. With the channel flag the hook files nothing, but it stays for the same two signals and stands for the request Claude Code relayed for that prompt (paired by tool name, in order of arrival, within 30 s); without the plugin's hooks (a bare channel server) a relayed request still waits until it runs out. Not covered: a call whose input the human amended in the dialog (its `PostToolUse` names another input; a denial is still seen). **`Notification`** (`permission_prompt`, `elicitation_dialog`) runs `node connector.mjs notice`: the connector files a critical info card "The terminal is waiting for you: …", but only when no permission card stands for that prompt (none open, none just answered, no channel flag), so in practice for the dialogs the board cannot answer. `idle_prompt` is left out on purpose: a Trommi session waits for the board most of the time. **`PermissionDenied`** runs `node connector.mjs denied`: when Claude Code's auto mode blocks a tool call, the connector says one quiet chat line in the agent's session (no card, no push): `Auto mode blocked: <tool> — <reason>`. The reason is the classifier's (absent for a denial without a verdict: then the call itself, clipped). The line is at most ~120 characters of reason or call, with env assignments (`NAME=value`), bearer tokens, `--token`/`--password` values, passwords in URLs, well-known token shapes and long opaque strings replaced by `…` (in the hook and again in the connector). At most one line per 30 s; denials in between are counted and told once when the window ends ("…and N more Auto mode blocks."). The hook prints nothing: it approves nothing and never sets `retry`. No connector, no room: silent. Auto mode reads its trust list from the user's `~/.claude/settings.json` only (never project or plugin settings), so fewer denials are a setting of the human's own. A suggested block (not applied by anything; `$defaults` keeps the built-in rules, `claude auto-mode config` shows the result; `autoMode.environment`, `allow`, `soft_deny`, `hard_deny`, `classifyAllShell` are the documented keys):

```json
{
  "autoMode": {
    "environment": [
      "$defaults",
      "Trommi project: the GitHub org `trommi` is the owner's own; pushes to main there are the deploy and are authorised",
      "Source control: github.com/trommi and all repos under it",
      "Trusted internal domains: app.trommi.com, hub.trommi.com (the owner's own services)",
      "Key internal services: the server trommi-hub.tail276436.ts.net (SSH on port 2222, the owner's own machine), the tailnet preview desktop.TAILNET.ts.net"
    ]
  }
}
```

Tests: `node connector/test.mjs` (the pieces, the hook process against a fake connector: allow, deny, no verdict in time, channel session, no connector, no room) and `node connector/test-e2e.mjs --only hooks` (end to end with a hub and a scripted human).

**Connecting from any machine (the connect script).** The app's "Invite an agent" shows one command that works on any machine with Claude Code and Node 22+, no checkout needed: `cd <project> && curl -fsSL https://app.trommi.com/connect | sh -s '<invite link>'`. `/connect` is `app/web/public/connect.sh` (POSIX sh: dash, busybox ash, bash, macOS sh; served as text/plain by `app/web/worker.js`, and by `dev/serve.mjs` locally; `TROMMI_APP` points it at another app origin). It checks `node` ≥ 22 (missing or too old: it offers to install it, asking on `/dev/tty` since stdin is the piped script; Debian/Ubuntu: NodeSource `setup_22.x` + `apt-get install nodejs`, with `sudo` when not root; macOS: `brew install node`; otherwise, or without a terminal or on no, it stops with the nodejs.org hint; `TROMMI_INSTALL_NODE=yes` answers yes) and `claude`; downloads `connector.mjs` and checks it against `connector.mjs.sha256`, installs it as `~/.local/share/trommi/connector/connector.mjs` (+ `.sha256`); installs the Trommi plugin for the current folder (above; `TROMMI_MARKETPLACE` names another marketplace, e.g. a local directory in tests) and removes an older `.mcp.json` entry `trommi` (two connectors in one session would be two members); runs `node <path> join` with the link in `TROMMI_INVITE` (never printed, not on a command line); and prints the next step: plain `claude`. A Claude Code without plugin support (the plugin commands fail) gets the old way: `claude mcp add trommi --scope project -- node <path>` (`.mcp.json`; Claude Code starts it in that folder, which names the key slot as above) and the start command `claude --dangerously-load-development-channels server:trommi`, needed on every start and `--resume` there.

The single file is made by `connector/build.mjs` (esbuild, pinned devDependency): `connector.mjs` + `tools.mjs` + `prompt.md` (inlined) + `shared/` + the MCP SDK + zod as one ES module, with its `.sha256` and the plugin. **Nothing generated is in git** (`app/web/public/gen/` is ignored): Cloudflare's build of the app (`app/web/wrangler.jsonc` → `node dev/build.mjs`, `WORKERS_CI=1`) runs `npm ci` at the repository root (the build sees the whole checkout; `app/web` itself has no `package.json`) and then writes `public/gen/connector.mjs`, `connector.mjs.sha256` and `plugins/`, served at the one public address each: `https://app.trommi.com/connector.mjs`, `/connector.mjs.sha256`, `/plugins/…` (`app/web/worker.js`). A build without the packages fails, and Cloudflare keeps the last deployment; the Web app deploy workflow then checks that the served connector matches its served checksum. Locally: `node connector/build.mjs [dir]` writes the files, `node app/web/dev/build.mjs` is the dry run of the whole build, and `app/web/dev/serve.mjs` serves them from memory (without `node_modules` it serves the app without them). In the bundle the connector runs in single-file mode: code and shell are one file, so a new version always asks for the restart (`/mcp` → trommi → Reconnect, after running the connect command again). Test ("a second machine": fresh `HOME`, fresh folder, local hub, the script piped into `sh`, then the installed connector started as Claude Code starts it): `node connector/test-e2e.mjs --only connect [--shell dash] [--docker node:26-slim|node:26-alpine] [--real-claude] [--no-plugin]`; without Node, as root: `--docker debian:stable-slim --answer y` (a pty via `script` types the answer).

**Connector updates without a restart (hot reload, `connector.mjs` "updates").** The connector has two parts. The **shell** (`connector.mjs` and `shared/`) holds stdio, the MCP `Server`, the key file, the lease and the hub stream; it is never reloaded. The **code** (`tools.mjs` and `prompt.md`: the tools, the texts and the bridge) is. *Detection:* a hash of each part on disk against the loaded one (`fs.watch` on `connector/` and `shared/`, plus a poll every `TROMMI_UPDATE_POLL_MS`, default 60 s); the hub's `GET /v1/version` `recommended_client_versions.connector` against `connector/<version>` (5 s after start, then every `TROMMI_VERSION_CHECK_MS`, default 1 h; a newer one always needs a restart); and a refusal (`426 client-too-old` or the stream event `upgrade_required`), which stops the connector and is told as a chat event with meta `upgrade_required="1"`. *Telling Claude:* one channel event per new state, `<channel source="board" kind="update" update_available="1" version="…" restart_required="0|1">`, and the same once as a hint on the next tool result (for a missed event). The instructions (within the first 2048 characters) say: file a decision card "Neue Connector-Version x – jetzt neu laden?" (jetzt / später); on jetzt call `reload_connector`; with `restart_required="1"` the card tells the human to run `/mcp` → trommi → Reconnect instead. *Reload:* `reload_connector` (a tool of the shell, always listed) imports the code part again as `./tools.mjs?v=<hash>` (which reads `prompt.md` again), builds a new bridge on the same client, state and notify, swaps the tool list and sends `notifications/tools/list_changed` (`capabilities.tools.listChanged = true`). Process, lease, stream, key and slot state stay as they were; if the shell changed it loads nothing and answers with the Reconnect step. Server instructions are read by Claude Code only at `initialize`, so a change to them takes effect at the next Reconnect. The single-file connector (the bundle) is one file, so every update there is a restart. Tests (`connector/test-e2e.mjs`, "update:"): in a joined room, the hub's recommended version is announced once and hinted once; a changed `tools.mjs` and `prompt.md` are announced, `reload_connector` makes the new tool visible without a restart, and a card filed by the new code is answered live (same member, same process, no second room open); a changed `shared/` file asks for Reconnect.

**Links for people outside the room (`share_asset`).** The agent draws a 32-byte `share_secret` and registers `POST /v1/rooms/:room_id/attachments/:attachment_id/shares { share_id (32 hex, random), share_secret_hash (b64u SHA-256 of the secret), expires_at (≤ 30 days) }` → `201 { share_id, expires_at }` (the uploader, or any human device of the room for any attachment of it; an agent shares only what it uploaded; another room's attachment is `404`). The link is `https://app.trommi.com/a/<share_id>#<share_secret>.<file_key>.<sha256>`; everything after `#` stays in the browser. The viewer page calls `GET /v1/shares/:share_id` with header `x-share-secret: <b64u secret>` (no sign-in, 60 per minute per address, `Range` supported, `cache-control: private, no-store`); a missing share, a wrong secret and an expired share all answer `404 not-found`. The page decrypts with `decryptAsset` and shows it sandboxed. Revoke: `DELETE /v1/rooms/:room_id/attachments/:attachment_id/shares/:share_id` (the creator or a human device) → `{ ok }`. In the app the human shares from the Links page (the Desk's pile "Links": every web link and page the agents gave): a switch on a file of the room (a published page, a page behind a picture) draws the secret in the browser (`client.shareAttachment(ref, { keep_link: true })`), keeps the link in this device's storage (`client.myShares()`) for Copy, 7 days unless chosen (1 to 30), and "Stop sharing" revokes it; links made on another device or by an agent are not listed there. Tests: `hub/test.mjs` "share links: …", `shared/test.mjs` "attachments: …". Table `shares`: `share_id`, `room_id`, `attachment_id`, `share_secret_hash`, `expires_at`, `created_by_device_id`, `created_at`. The hub never holds the file key.

### Founding and joining, in short

1. **Found ("Create account" in the app):** the app makes device keys, a recovery code and key epoch 1; `POST /v1/rooms`; then `challenge` → `access_tokens`; then `POST account` (email, the code sealed under the password). The code itself is no longer shown: the password and the Emergency Kit open it.
2. **Invite** (human or agent): `createInvite` → `POST invites`; the link `https://app.trommi.com/join#v1.<hub>.<room>.<secret>` leaves the device by the human's hands. The secret never reaches a server.
3. **Join:** the newcomer `GET invites/:invite_id` (checks the list against the room id in the link) → `POST requests` → polls `status`. The inviter gets `join_request` → `GET requests` → checks the MAC → `POST reveal`. Both show the check code as six emoji (the human compares them and taps "They match" on the inviting device; an agent the same) → the inviter `POST members` with the add entry and, for a human, the sealed room key → the newcomer sees `joined`, verifies, opens its key, signs in.
4. **Remove:** any human device: `removeMembers` → `POST members` with the new key epoch sealed for everyone who stays, and the back link. The hub cuts the removed device off.
5. **Recover:** with the code: sign in as the recovery key → `GET members`, `GET sealed_room_keys` → `recoverRoom` → `POST members`.

**What each side verifies, whatever the hub did.** *Newcomer, before it sends anything:* the member list hashes to the room id in the link; the offer is signed by a human member of that list and belongs to this link's `invite_id`. *Inviter, on the request:* the MAC (only a holder of the link can make it); room, invite, role, hub address and offer hash match; the invite is unused and not expired. It answers the first request with a valid MAC and no other, so junk without a MAC does not spend the invite. *Newcomer, on the reveal:* signed by the inviter, answers *this* request (otherwise someone else used the link: stop and say so), the number matches the commitment in the offer. *Newcomer, at the end:* the list, verified again up to the room id, names its own key in the invited role; the sealed key opens and matches the commitment in the list.

**The check code** is the first 36 bits of H("trommi/v1/invite-code", offer ‖ request ‖ hidden number), shown as six emoji out of 64 (6 bits each, the Matrix SAS list, an English word under each; `shared/check-emoji.ts`, one function for app and connector). It covers everything that crossed the hub (inviter, room, role, the newcomer's keys); the inviter fixed its number in the offer before it saw the request, so nobody can try keys until a code fits. 36 bits are one chance in about 69 billion per attempt (the six decimal digits before were 19.9 bits, one in a million), and each attempt spends an invite. Both devices show the same six emoji; on the inviting device (only the one that made the link) the human taps **They match** or **They don't match**. No decoys, nothing to type: the price is that "They match" can be tapped without looking, so the page asks plainly whether the six are the same, in the same order. "They don't match" adds nobody and spends the invite (the hub then answers `410 invite-burned`); the human has five minutes after the request is accepted. For humans it is mandatory: the library produces no add entry for a human role without `codeConfirmed`. An agent invite asks for the code as a human pairing does (no silent add since 7 October 2026). What an agent link risks, plainly: whoever sees the link within its ten minutes and answers it before the agent shows the human six emoji that are not the ones in the agent's terminal; "They don't match" burns the link. The link passes through Claude Code's transcript and so to the model provider, and a shared terminal, a pasted log or a clipboard manager can leak it. Such a stranger holds no room key and no session key until a human assigns it to a session; it cannot give commands, add or remove anyone, and is gone when removed. If two devices answer one agent link nobody is added (`invite-contested`). The inviting device shows who joined, with Remove beside it.

**The hub's view of a room.** It stores the signed member list (who, role, both public keys, when, who signed), sealed room and session keys per member and epoch (it sees recipient, epoch and, from the length, whether a history key is inside; it cannot open them), back links (handed to human devices and the recovery key only), open invites (the signed offer, up to four requests, the reveal; invite id, role, expiry; never the secret after `#`, so it can make no valid request), sealed envelopes, and session tokens. Of an envelope it reads sender, recipient, numbers, hashes, time and padded size; for cards also card id, status, urgency and answer time, plus attachment ids and the push bit. It cannot read text, options, the chosen option, status lines or file names, and cannot change what it reads: the header is signed. Speech (dictation, reading aloud) goes through the hub and is not end-to-end encrypted; the Tinfoil key stays on the hub. An agent's stable id is bound by the hub to its member key the first time it signs in and given back to the same key ever after; a second process on the same key is refused (`instance-conflict`, `lease-lost`, R4), a removed agent's id is never reused (a new agent of the same name becomes `crypto-2`), and a lost key file means a new invite and a new identity (the old member stays until a human removes it), unless the human makes the link with "Copy invite link again" on that session: then the new key continues the session and the old one is retired (R6, "Continuing a session").

**When joining or keys go wrong.**

| What happens | Code | The human sees |
| --- | --- | --- |
| The link is opened after ten minutes, or the code is typed after five | `invite-expired` | "This invite has run out." |
| A second device uses the same link | `invite-used`, `invite-contested` | on the late device: already used; remove the first one if it was not yours |
| The request's keys were swapped (hub or anyone without the link) | `bad-mac` | nothing joins, the invite stays usable |
| The hub serves another member list than the link names | `wrong-room`, `bad-entry` | "This hub shows a different room than the link." |
| The digits differ | `code-not-confirmed` | the inviting device adds nobody |
| The sealed key is not the one the list commits to | `key-mismatch` | "The room key does not match the member list." |
| An entry no current human member signed; a removed member signs in or posts | `bad-entry`, `bad-signature`, `not-member`, `removed-sender` | refused at the hub; a client that gets one anyway stops and reports |
| An old entry or envelope is sent again | `replay` | refused |
| A removal without a sealed key for someone who stays | `incomplete` | refused: nobody is locked out by accident |
| The hub rolls the list back or shows two devices different lists | `log-rollback`, `log-fork` | "The hub shows an older or a different member list." |
| A wrong recovery code is typed | `bad-recovery-code` | "This code does not belong to the room." |
| The inviting device goes offline before the add entry | status `waiting`, then `invite-expired` | the newcomer waits, indistinguishable from a hub that withholds the entry |

All devices lost with the code at hand: recovery. All devices and the code lost: the room is lost, a new room, agents invited again. Open points: a device's name in the room is a register (R8), so the hub never sees names; whether Safari keeps a non-extractable X25519 key in IndexedDB reliably is unverified.

### Card content (what an agent files, what the app renders)

All additive: a client that knows none of this still has `body`, `options`, `recommended`. `teaser` (optional, plain text on one paragraph, trimmed, at most 160 characters, `codec.TEASER_MAX`) is the two muted lines under the title on the Desk row; without it the Desk shows the start of `body`; a bad one is refused on encode and dropped on decode. `sections` is an ordered list of blocks; a block with `key` is an option (`label`, `text`, `recommended`, optional `picture`: an index into the card's attachments), a block without is plain context. The flagged blocks in order are exactly `options` (at least two, unique keys), and `body` holds the same text for old clients (flagged blocks as `**Label**: text`). The connector accepts the same as one `text` string: paragraphs split by a blank line, `[key] Label: text` flags one (without a colon the first line is the label), `[key*]` or `(recommended)` marks the advice, `[key!]` a final option, a last line `picture: file-or-index` ties an attachment (`connector/channel-bridge.mjs`). `revise_card` may replace, drop or add the blocks; re-render when the card changes. The app shows each flagged paragraph under its label tied to its option tile (hover highlights both, a tap answers like the tile does, the advice mark shows on both). An answer can carry a note on any option, chosen or not (`option_notes`, the agent hears `option_notes="a,b"`), a general `note`, `marks` (notes and drawings pinned to places on the card's pictures) and `attachments`. **A final option** (`options[].final: true`; in `sections` the same field on a flagged block, in the connector's `text` form `[key!]`, with the advice `[key*!]`) is one whose choice leaves the agent nothing to do or to report ("Done", "Leave it", "No"). An answer whose every choice is a final option **settles the card**: the human's client sends the `answer` with `object_state` closed (one envelope, as read and shred), the card is closed with `closed_how: settled`, it never lies "with the agent" and the agent has nothing to close. With `allows_multiple` every chosen option must be final. Anything said beside the choice (a `note`, `option_notes`, `attachments`, `marks`) is for the agent to read, so such an answer is sent as answered and the agent closes the card after reading; a trusted answer never settles (the agent still has to choose and say so). Every client refuses an `answer` with a closed header whose choices are not all final, or that is trusted (`bad-answer`; the owner re-sends the card, F15). `final` is `true` or absent (anything else is dropped on encode and on decode); a client that does not know it sends answered as before and the agent closes the card itself. `decide_again` reopens a settled card exactly like an answered one. The agent hears the choice as the usual decision event with `closed="1"` and the sentence that nothing is expected of it; `close_card` on a settled card sends nothing (a version from the agent would make it the agent's close, which the human cannot take back). The app shows a final option with a small pen tick on its tile (on the card's page with the words "settles it"), and the settled card under Done with "settled by your answer". **Trust** ("Whatever") is an `answer` with `trusted: true` and no choices: the agent picks its own recommendation, says so in a `reply` with the card id and closes the card; not offered on permission requests or info cards; taking it back is `decide_again`. **Shred** is `answer_action: shred`: the card is closed unanswered. **Snooze** ("Later") is the human register `snooze/<object_id>`, capped at the next 07:00 local time; a snoozed card stays open but leaves the queue, answering or closing it ends the snooze, and the agent is never told. At most one session wears the **crown** (register `crown`). Agents offer two or three options they are about 80 % sure of.

### Performance

Measured on 4 October 2026 with real E2E members (`dev/load/`). "local" is the real hub code on the PC with server metrics. "live" is hub.trommi.com measured from outside: its metrics port and test key are not enabled yet.

| What | Number |
| --- | --- |
| Ingest, local hub, 25 members | 2,826 envelopes/s at the maximum; 1,762/s sustained up to 1.19M envelopes |
| Delivery (seal → another member's stream), local | p50 2 ms, p99 5-24 ms up to 900/s; p99 621 ms sustained at 1,762/s; a user beside the load (probe) p99 38 ms (hub-v11). On current main, on a shared PC: p99 about 1.1 s above about 800/s |
| Delivery, live | p50 43-46 ms (the Cloudflare round trip), p99 61-114 ms under light load |
| Hub memory over 0 → 1.19M envelopes | RSS 160-220 MB, flat (after the leak fix; it was 1.6 GB and rising) |
| 1,000 stalled streams | RSS 177 → 212 MB, probe p99 89 ms (sliced catch-up, global stream-buffer cap) |
| Storage | 1.6 KB per envelope in hub.db, indexes included |
| Fresh device catching up 1.19M envelopes | 141 s (8,400/s incl. HTTP, 17,000/s processing) |
| Open a chat next to 10,000 strokes | one covering-index search, chat items only, 1 ms at the hub |
| Removing a member (27 members, 24 sessions) | crypto 3-14 ms; the whole v1.1 removal 1.7-2.3 s (one grant per session) |
| App, crazy room, desktop | v1.1 with the room snapshot (45k envelopes): first load 2.4 s, interactions p95 24-126 ms, own message visible 8 ms (p95). v1.0 (113k): first load 29 s, all p95 < 100 ms |
| App, same room, phone (CPU 4×) | v1.1: first load 3.4 s; opening a session, switching sessions, card threads, answers p95 290-580 ms (over budget); own message visible 44 ms (p95). 8 Oct (bundle, board caches): Desk p95 614 → 68 ms, answer 473 → 160 ms, open the huge chat 357 → 319 ms, switch ≈210 ms (waits for the hub's chat page), warm reload 2.7 → 1.7 s |
| Open gaps | after a snapshot join no chat history is shown; local p99 about 1.1 s from about 800/s on current main (backpressure) |

#### The huge room, per-change cost and the budgets (8 October 2026)

**The room.** `node dev/load/huge-room.mjs --out=<dir> --keep-hub` seeds it through `shared/` as real members on a local hub (16 min): 44 agent sessions on 8 desks with profiles and status lines, 6 human devices, 5,400 cards (5,000 answered, every second one revised; snoozes, ducks, drafts), one session chat of 22,000 messages (every 6th with one of 400 encrypted PNGs), a card thread of 2,000, 20,000 more messages, 300 notes, 120 published pages, a Scribble Board of 20,000 strokes in the new stroke format plus 5,000 elsewhere: 82,868 envelopes. `<dir>/huge.json` (also as `crazy.json` for `app-perf.mjs`) names the hub, the room, the member directories and the big timelines.

**What one device moves.** `hub-local.mjs --count` puts a counting front on the hub's own address (by `trommi-client` and route, `GET /__counters`). `node dev/load/tempo.mjs --room=<dir> [--impl=js,swift]` joins a fresh device of each core and records, per step, ms, KiB, requests by route, envelopes verified and bodies decrypted: cold start, one new message live, the huge session's first page and 20 pages back, one message while it is open, answering, warm start with nothing new and with one new message, the huge session again from storage. **Verification is never skipped**: every envelope the cursor passes is verified against its sender's chain; bodies are decrypted only when a window shows them (catch-up reads conversations as headers).

**The budgets.** `node dev/load/perf-budget.mjs [--room=<dir>] [--only=engine,web,ios] [--parts=start,interact,scroll,live,one]` (local, minutes; needs the command sandbox off for Chromium) exits 1 when one is exceeded. Web = headless Chromium as a phone (390x844, CPU 4x slower, 150 ms RTT, 1.6 Mbit/s) against `app/web/dev/serve.mjs --prod` (the deployed bundle, its service worker, brotli), joined once and kept in `<dir>/chromium-phone`. Budgets: warm start to the Desk < 1 s, cold start (app files not cached, the room in IndexedDB) < 2 s, every interaction p95 < 100 ms, no long task > 50 ms while scrolling or during live updates, one new message = 1 envelope verified, ≤ 1 body decrypted, no request besides the stream, ≤ 4 KiB; the engines the same per change, a warm start with one new envelope reads no conversation; iOS: one new message writes ≤ 64 KiB of cache, a warm start with nothing new < 300 ms.

| Huge room (82,868 envelopes), phone 4x + slow 4G | Before | After | Budget |
| --- | --- | --- | --- |
| Warm start to the Desk | 1,156 ms | 844 ms | 1,000 ms ✓ |
| Cold start to the Desk (app files not cached) | 2,855 ms | 2,296 ms | 2,000 ms ✗ |
| Interactions p95: Desk / huge session / Earlier / switch / card / answer / send | 68 / 417 / 712 / 285 / 156 / 191 / 41 ms | 40 / 227 / 110 / 156 / 140 / 171 / 32 ms | 100 ms ✗ |
| Long tasks > 50 ms: scrolling / live burst (3 s, 5 sessions) | 1 / 6 (26 when a room snapshot was written meanwhile) | 0 / 3 | 0 ✗ |
| One new message, chat open: verified / decrypted / requests / KiB | 1 / 1 / 12 / 95 | 1 / 1 / 0 / 0.8 | 1 / 1 / 0 / 4 ✓ |
| One new message: visible in the open chat | 64 ms | 48 ms | 100 ms ✓ |
| JS core: warm start with 1 new envelope: verified / conversations read / KiB | 1 / 82 / 1,226 | 1 / 0 / 13 | ✓ |
| JS core: the huge session again from storage: requests / KiB | 15 / 251 | 1 / 0.8 | ✓ |
| JS core: scroll back one page (50 messages): ms / KiB / decrypted | (paging stopped after the first page) | 22 / 56 / 50 | ✓ |
| Desktop (app-perf): warm reload p95 / switch p95 / heap / IndexedDB | 631 ms / 147 ms / 154 MB / 25 MB | 372 ms / 61 ms / 122 MB / 10 MB | – |
| Swift core (release build): warm start, nothing new / one new / store bytes written per new message | 2.1 s / 2.1 s / 71 MB | 73 ms / 71 ms / 26 KiB | 300 ms / – / 64 KiB ✓ |
| Swift core (release build): cold start of a new device (snapshot boot) | 6.9 s, 55 MB | 0.46 s, 4.1 MB | – |

What made the difference: a warm start no longer re-reads every open card's conversation (the hand-back check's mark is stored with the card); a timeline window fetches only the span of bodies it lacks, a short timeline stored whole asks nothing; the board's card list is changed in place for the cards a change names, and what depends only on the cards (`cardsMemo`) or only on the closed cards (`closedMemo`) is kept; the end list makes sheets only as far as it shows; Artifacts are kept per card list; controllers look for targets only around the change; a session page waits only for its local chat page (40 ms) and loads card threads only within its window; the phone's closed drawer is not laid out (`content-visibility`); a new Desk row far below the fold comes as an empty row; the room snapshot is written in 12 ms slices (it was a multi-second task on a phone); cards at rest drop their duplicated newest version and answer (22 → 17 MB); IndexedDB reads are bulk `getAll`s, in parallel; the stylesheet is minified (brotli 93 → 58 KB).

Still over budget, and why: the cold start is bound by the bytes on a 1.6 Mbit/s line (340 KiB: JS 150, CSS 58, fonts 137 that compete with the JS; deferring the fonts until after the first paint would bring it under 2 s, at the price of a font swap on a cold start); the remaining interaction and live-update time is style and layout of 2,000–4,000 elements (a Desk insertion lays out the whole document; containment per run section, fewer inline SVG nodes per row and windowing the Desk's placeholders are the next steps); opening the huge session the first time on a device that joined by snapshot waits one hub round trip for its bodies.

**iOS (TrommiClient), measured with trommi-swift on the same room:** every launch replays all 83k records from one encrypted blob (2.2 s on a desktop CPU, several times that on a phone), every change rewrites that whole blob (70 MB, 1.5 s after the change), `Board.project()` re-sorts every session's cards and all open cards per envelope, the catch-up fetches every envelope from 0 (no snapshot boot) and keeps every record in memory, and `GET session_grants` reads all sessions' grant chains at each start (242 KB). Proposed: an append-only encrypted record store (SQLite or segment files keyed by envelope number, with the verified cursor and chain heads per segment) so a change appends one record; projected state persisted beside it so a launch reads the board, not the log; reduce on a background actor with change sets (cards/sessions/timelines touched), projection updated per touched card; timeline bodies fetched per visible window (as `loadOlder` does) and SwiftUI lists windowed (`List`/`LazyVStack` over ids, rows reading the board by id); snapshot boot as in `shared/snapshot.ts`; sessions refreshed only for those whose grant number moved (`GET sessions`, then `session_grants` for those).

**iOS, after (8 October):** the store is append-only (`TrommiClient/RecordStore.swift`): records in 1 MiB segments (`records/<first>.seg`, each record sealed alone with AAD `trommi/v1/ios-rec/<number>`, in `RecCodec`'s compact bytes instead of JSON), a small sealed `head.bin` (cursor, lamport, the chain heads without their kept hashes, which are rebuilt from the records, the session keys) and `grants.bin`, written only when a grant chain changed. One new message appends its record and rewrites the head (27 KiB). A warm start indexes the segments by their clear frames, opens and decodes them in slices on every core while the main thread replays them in order, verifies the stored grant chains on another thread, and asks the hub for members, keys and sessions meanwhile; the restored records are not kept in memory a second time. `GET sessions` names each session's newest grant number and only moved sessions are fetched (`GET session_grants?session_ids=`; 346 KB → 4 KB at a launch). A live envelope projects only the sessions it touched and the open stack only when cards, registers or permissions changed. A store damaged past its tail is cut there; one whose seals do not open is thrown away (the catch-up starts at 0). Beside the records, `board.bin` holds the projected board itself (`BoardCodec`: every stored field of the board's parts, counted by a test so a new field cannot be forgotten; cards and timelines in framed groups decoded on every core) with the chain heads and their kept hashes, at a cursor: a launch reads it and replays only the records after it (huge room: the board in ~50 ms, the whole warm start ~110 ms on a desktop). It is written every 2,000 records once caught up and when the app goes to the background after 200 or more, never for a single message, and only while nothing of this device is in flight. A chat keeps the bodies of its newest 60 items in it; older items are headers whose bodies `loadOlder` reads from the device's own store first and from the hub only when the store has none (a catch-up stores conversations as headers; bodies the hub then gives are appended to the store for the next time). A new human device boots from the room snapshot as `shared/snapshot.ts` does (`Room.bootFromSnapshot`, `SnapshotModel.swift`): the pointer is the newest `room_snapshot` register in a status head under the room key, signed by a human device that is a member now (the newest twelve pages scanned backwards); the snapshot must name the member list this device verified and no removal or recovery may follow it (else the device replays from envelope 1); the cursor goes back 1,000 envelopes before its end (D6) and the tail is read with full chain checks from the snapshot's chain heads on: what lies inside them is skipped by (sender, sequence), a different hash at a head is equivocation. Grant-derived session fields stay as this device verified them; registers go through the live setter (R2). Items from before the snapshot are read on demand: each checked on its own (signature, membership, this very timeline, a sender allowed there, at most the sender's head in the snapshot, one item per sender and sequence). The snapshot's JSON is read by an own one-pass parser into JV (`FastJSON`: 3 s with JSONSerialization, 76 ms now), and the pages the pointer scan read are used once by the catch-up instead of being fetched again (only one gapless run). Huge room: cold start 6.9 s, 55 MB → 0.46 s, 4.1 MB. The refusals are tested with hand-built envelopes (`SnapshotSecurityTests`: an agent's pointer under the room key or its session key, a later-numbered pointer, a second envelope at a sender's head in the overlap) and in interop (an agent's forged pointer past the client's key check). Linux builds (trommi-swift, interop) inflate gzip with their own RFC 1951 decoder. Interop "snapshot" checks a Swift and a JS device booted from the same snapshot (cards, registers, notes, the newest 400 messages of a 2,100-message session) and that a snapshot from before a removal is refused. `perf-budget.mjs --only=ios` uses the release build when there is one; `tempo.mjs --agent=agent-N` picks another agent (`perf-budget.mjs --swift-agent`, default agent-2). An interrupted run can leave a member directory behind the hub (agent-1 halted on an equivocation, the phone's member log one entry ahead of the hub's): then seed the room again (`huge-room.mjs --out=<dir> --keep-hub`, 16 min).
