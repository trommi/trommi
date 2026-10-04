# Trommi

Chat and decision cards between a person and their Claude Code sessions, end-to-end encrypted. The app
(https://app.trommi.com) runs on every device of the person; each Claude Code session joins through the connector, an
MCP server with its own device key; the hub (https://hub.trommi.com) is a thin mailbox that stores and forwards sealed
envelopes and can read none of them. Formerly "Trommi". License: O'Saasy (`LICENSE.md`).

## Repository

| Path | What | Deployed |
| --- | --- | --- |
| `core/` | the one client core and crypto library: `zcrypto.mjs` (bytes: `FORMAT.md`, design: `CRYPTO.md`), `hub.mjs` (the hub's checks), room model, sync, storage (`README.md`) | imported by the hub and the connector; copied into the app by its build |
| `app/web/` | the app, static, no framework (`app/web/README.md`); `dev/build.mjs` copies `core/` into `public/vendor/` and bundles the stylesheets | Cloudflare Workers Builds on every push to `main` (watch paths `app/web/*`, `core/*`, `connector/*`) |
| `connector/` | the agent connector `channel.mjs` (MCP stdio server `trommi`), its tools (`channel-tools.mjs`), bridge, slot lock, hot reload (`reload.mjs`), tests | runs on the agent's machine from this checkout |
| `hub/` | the hub server (`server.mjs`, `store.mjs`, `accounts.mjs`, `ops/`, `Dockerfile`) | GitHub Action "Hub deploy" on every push to `main` touching `hub/**` or the hub's three `core/` files |
| `fuzz/` | model-based fuzzing of hub and clients (`fuzz/README.md`); the quick run blocks the hub deploy | |
| `dev/` | `cdp.mjs` (headless Chromium), `e2e/` (load generator with real members) | |
| `assets/` | brand sources (logo, bell marks, fonts, palette, icons) | |
| `docs/` | the crypto concept, pairing, performance notes, open wishes | |

The old board (plaintext server `server/`, Turbo and SPA clients `client/web/`, the iOS and Linux clients, their tools
and docs) was removed on 4 October 2026; its history is in git and in
`~/Nextcloud/Christopher/Backups/trommi-hub-legacy-2026-10-04.bundle`.

## Tests

```bash
node core/crypto-test.mjs --no-bench && node core/hub-crypto-test.mjs && node core/session-grants-test.mjs
node hub/test.mjs && node hub/ops/test.mjs && node hub/accounts-test.mjs && node hub/admin-test.mjs
node core/test.mjs && node connector/channel-test.mjs
node fuzz/run.mjs --quick
(cd app/web && node dev/serve.mjs 8900)     # the app as deployed (build in memory); e2e: app/web/README.md
```

Each suite starts its own hubs on free ports with throwaway data directories. A local hub for the app:
`HUB_PORT=8890 HUB_DATA=/tmp/trommi-dev node hub/server.mjs`.

## Hub v1: the wire protocol (hub.trommi.com)

> **The hub** (`hub/`, deployed to `https://hub.trommi.com`) is a thin, hostile mailbox: it stores what members signed and sealed and serves no UI. The app is a static site (`app/web`, `https://app.trommi.com`); agents join through the channel process (`connector/channel.mjs`). This section is the contract between the three. Crypto design: `docs/krypto-konzept.md`; exact bytes: `core/FORMAT.md`; pairing: `docs/pairing.md`.

### Principles

1. **Everyone is a member.** A phone, a laptop, a Claude Code session: each has its own Ed25519 + X25519 keys and an entry in the room's signed member list. There are no client-specific routes; an agent uses exactly the routes a browser uses.
2. **One envelope format** (`core/FORMAT.md` §9) for everything said in a room: messages, cards, answers, status lines, shared board state. Signed by the sender, chained per sender, encrypted with the sender's key of the key epoch.
3. **One sync mechanism, two depths.** Every client keeps one number: the `envelope_number` (the hub's arrival number) of the last envelope it processed. `GET envelopes?after_envelope_number=` and `GET stream?after_envelope_number=` deliver the same records in the same order to every client, app and agent alike. Every record carries the **signed header in full** (small; every client verifies every sender's whole chain) and the **encrypted body only for heads**. Threads are fetched when opened, newest first, in pages. Clients build all state locally; the hub never sends "state".
4. **Heads and threads.** The signed `envelope_kind` says whether an envelope belongs to the overview (every kind except `timeline_item` is a head: object versions, answers, registers). Messages and strokes are thread items: each carries a signed plaintext `timeline_kind` (`chat`, `canvas`; later `media` …) and `timeline_id` (`card/<object_id>`, `session/<session_id>`, `desk/<desk_id>`), so the hub pages one timeline with one index hit and never mixes chat with strokes. New timeline kinds need no hub change. The `envelope_kind` is in the signed header and is checked before anything else. A revision is a new object version that names the previous one; no envelope ever holds a whole conversation. Long text, HTML pages and pictures are attachments, fetched only when shown.
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
- **CORS:** `Access-Control-Allow-Origin` echoes `https://app.trommi.com`, `http://localhost:<any port>` and `http://127.0.0.1:<any port>` (only when `NODE_ENV` is not `production`; the image sets production, so a local app against hub.trommi.com needs `HUB_ORIGINS`) and the origins in `HUB_ORIGINS` (comma list); methods `GET, POST, PUT, DELETE`; request headers `authorization, content-type, range, last-event-id, x-found-token, x-test-signature, x-lease-generation, x-share-secret, trommi-client, trommi-protocol`; exposed `content-range, content-length, retry-after`; no cookies; preflight cached 86400 s.
- **Sign-in:** `Authorization: Bearer <access_token>`. An access token comes from a signed challenge, is bound to one device and lasts 10 minutes. A client signs in again on `401 unauthorised` or a minute before `expires_at`. Writes need nothing more: member entries and envelopes are signed themselves.
- **Client version:** every request carries `Trommi-Client: <app|channel|ios>/<semver>` and `Trommi-Protocol: 1` (below, "Versions and upgrades").
- Ids: `room_id` and `device_id` 64 hex characters (32 bytes), `invite_id`, `object_id`, `attachment_id` 32 hex characters (16 bytes). Times are milliseconds since 1970 (`…_at`).

### Versions and upgrades

Three version numbers, independent of each other:

| What | Where | Who reads it |
| --- | --- | --- |
| Protocol (`Trommi-Protocol: 1`) | request header; routes and JSON of this section | the hub |
| Format version byte | first byte of every signed structure (`core/FORMAT.md`) | every client (the hub checks headers only) |
| `schema_version` | inside the encrypted body | app and channel only |

- `GET /v1/version` (public) → `{ protocol_versions_supported: [1], minimum_client_versions: { app?, channel?, ios? }, recommended_client_versions: { … }, message? }`, from `HUB_MIN_APP`, `HUB_MIN_CHANNEL`, `HUB_MIN_IOS`, `HUB_RECOMMENDED_APP|CHANNEL|IOS`, `HUB_UPGRADE_MESSAGE`. A kind without a minimum is not checked.
- A client below the minimum of its kind gets `426 { error: "client-too-old", minimum_version, message }` on **every** route. An open stream of a client that becomes too old while connected (minimum raised at run time) gets `event: upgrade_required` `{ minimum_version, message }` and is closed. A request without `Trommi-Client` is served for now (counted in the log once a minute); a later protocol version may require it.
- `Trommi-Protocol` naming a version the hub does not speak → `400 bad-version` with the versions it does speak.
- **The rule for every reader** (hub, app, channel): ignore unknown optional fields; refuse unknown *required* versions (format byte, protocol, a higher `schema_version`) with a clear message ("needs a newer app"), never guess.
- **A v2 migration** would run like this: the hub serves `/v1` and `/v2` side by side and lists `[1, 2]`; clients that know v2 switch, `minimum_client_versions` rises in steps while the share of old clients (log, metrics) falls; when it is zero or the window (announced in `message`) ends, the hub drops v1. Stored data never needs a big-bang rewrite: rows keep their format byte, and new rows get the new one.

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
| `POST /v1/rooms/:room_id/access_tokens` | a device or the recovery key | `{ signed_challenge }` (`signHubAuth` for this room and `HUB_URL`) | `{ access_token, device_id, signer: device \| recovery, device_role, expires_at }` |
| `GET /v1/rooms/:room_id/members?after_entry_number=-1` | member, recovery, or `invite_id=` of an open invite | | `{ room_id, last_entry_number, signed_entries: [b64u] }` |
| `POST /v1/rooms/:room_id/members` | signed itself (a recovering human has no device yet) | `{ signed_entry, sealed_room_keys, key_back_link? }` | `{ entry_number, entry_hash, key_epoch, entry_action }` |
| `GET /v1/rooms/:room_id/devices` | member | | `{ last_entry_number, devices: [{ device_id, device_role, is_active, is_online }] }` |
| `GET /v1/rooms/:room_id/sealed_room_keys?after_key_epoch=0` | member, recovery | | `{ sealed_room_keys: [{ key_epoch, key_sealed }] }` (the caller's own only) |
| `GET /v1/rooms/:room_id/key_back_links` | human, recovery | | `{ key_back_links: [{ key_epoch, key_back_link }] }` |
| `POST /v1/rooms/:room_id/invites` | human | `{ signed_offer }` | `{ invite_id, device_role, expires_at }` |
| `GET /v1/rooms/:room_id/invites/:invite_id` | anyone with the id | | `{ signed_offer, device_role, expires_at, room_id, signed_entries }` |
| `POST /v1/rooms/:room_id/invites/:invite_id/requests` | the newcomer | `{ signed_request }` | `{ request_hash }` |
| `GET /v1/rooms/:room_id/invites/:invite_id/requests` | inviter | | `{ signed_requests: [b64u] }` |
| `POST /v1/rooms/:room_id/invites/:invite_id/reveal` | inviter | `{ signed_reveal }` | `{ request_hash }` |
| `GET /v1/rooms/:room_id/invites/:invite_id/status?request_hash=` | the newcomer | | `{ join_status: waiting \| revealed \| joined \| taken, signed_reveal?, signed_entries?, key_sealed? }` (`key_sealed` for a human only: agents get no room key) |
| `DELETE /v1/rooms/:room_id/invites/:invite_id` | inviter | | `{ ok }`: the invite is called off (a wrong check code was typed); its routes answer `410 invite-burned` from then on |
| `GET /v1/rooms/:room_id/sessions` | member | | `{ sessions: [{ session_id, last_grant_number, session_key_epoch }] }` |
| `POST /v1/rooms/:room_id/sessions/:session_id/grants` | signed itself (a human device or the recovery key; an agent only for the first grant of its own child session, R6) | `{ signed_grant, sealed_session_keys: [{ device_id, key_sealed }], key_back_link? }` | `{ grant_number, grant_hash, session_key_epoch }`; the sealed keys must be exactly one per active human device, the recovery key and each assigned agent (manifest hash in the grant); a back link exactly when the session key epoch rises. Every stream of the room gets `event: session_grant` |
| `POST /v1/rooms/:room_id/session_grants` | each grant signed itself | `{ grants: [{ session_id, signed_grant, sealed_session_keys, key_back_link? }] }` (1–1024, one per session) | `{ grants: [{ session_id, grant_number, grant_hash, session_key_epoch }] }`; every grant is checked like the single route, then all are stored in one transaction or none is (a removal re-keys every session in one request). One `event: session_grant` per grant |
| `GET /v1/rooms/:room_id/sessions/:session_id/grants?after_grant_number=-1` | member | | `{ signed_grants: [b64u] }` |
| `GET /v1/rooms/:room_id/sessions/:session_id/sealed_session_keys?after_session_key_epoch=0` | member, recovery | | `{ sealed_session_keys: [{ session_key_epoch, key_sealed }] }` (own only) |
| `GET /v1/rooms/:room_id/sessions/:session_id/key_back_links` | human, recovery; an assigned agent for epochs granted `with_history` | | `{ key_back_links: [{ session_key_epoch, key_back_link }] }` |
| `POST /v1/rooms/:room_id/ephemeral` | member | `{ envelope }` (≤ 16 KiB, sealed, own) | `{ ok }`: relayed to the room's other open streams as `event: ephemeral { device_id, envelope }`, never stored |
| `POST /v1/rooms/:room_id/envelopes` | member | `{ envelope }` | `{ envelope_number }` |
| `GET /v1/rooms/:room_id/envelopes?after_envelope_number=0&limit=1000` | member; the recovery key gets every envelope in the pruned form (for the cuts of a recovery) | | `{ last_envelope_number, envelopes: [{ envelope_number, envelope }] }` in hub order: the full envelope for heads, the pruned form (header, ciphertext hash, signature) for thread items and pruned cards |
| `GET /v1/rooms/:room_id/threads?timeline_kind=chat&timeline_id=card/<object_id>&before_envelope_number=&limit=50` (newest first) or `&after_envelope_number=` (oldest first, for a canvas tail after a snapshot) | member | | `{ envelopes: [{ envelope_number, envelope }], has_more }`: full items of exactly that timeline (index `room_id, timeline_kind, timeline_id, envelope_number`) |
| `GET /v1/rooms/:room_id/stream?after_envelope_number=` | member | `fetch` with the Bearer header (not `EventSource`) | `text/event-stream`, below |
| `POST /v1/rooms/:room_id/agent_lease` | agent | `{ process_instance }` | `{ lease_generation, expires_at }`: one running process per key. A new sign-in with a new `process_instance` takes the lease over and closes the old process's streams; the lease also ends when its stream closes or after 60 s without a stream. Posts carry the `lease_generation` (header `x-lease-generation`); an older generation gets `409 lease-lost`. The board id of an agent is `hex(device_id)[0..16]`; its readable name is in encrypted registers |
| `PUT /v1/rooms/:room_id/attachments/:attachment_id` | member | raw encrypted bytes, `application/octet-stream`, ≤ 64 MiB | `201 { attachment_id, total_size }`; written once, immutable |
| `GET /v1/rooms/:room_id/attachments/:attachment_id` | member | `Range` supported | the encrypted bytes |
| `POST /v1/rooms/:room_id/push_subscriptions` | human | `{ subscription }` (Web Push), or `{ subscription, remove: true }` | `{ ok }` |
| `GET /v1/push_key` | anyone | | `{ vapid_public_key }` |
| `GET /v1/version` | anyone | | above, "Versions and upgrades" |
| `GET /v1/rooms/:room_id/usage` | member | | `{ attachment_bytes, quota_bytes }` |
| `PUT /v1/rooms/:room_id/escrow` | human | `{ escrow_version: 2, escrow_id, key_escrow, replaces }`: `escrow_id` 32 hex, derived by the client from the slow passphrase KDF; the password escrow, opaque (format: `client/core`), ≤ 4 KiB; `replaces` = the revision it replaces (0 when there is none; absent = 0, create only, for clients before review 3). `escrow_version` 1 is retired: `400 escrow-v1-retired` | `{ escrow_version, updated_at, revision }`; compare-and-swap: another revision → `409 escrow-changed`. One escrow per room. Announced as `event: escrow_changed` `{ escrow_version, revision, updater_device_id }`; other human devices show the alert `escrow-changed` |
| `GET /v1/rooms/:room_id/escrow/:escrow_id` | anyone; 10 per hour per address; the room's 10 per hour count misses only | | the v2 escrow with that id, else `404 not-found`: every passphrase guess costs a slow derivation and an online, rate-limited request; a read with the right id is never refused for the room's budget, so nobody can lock the owner out |
| `GET /v1/rooms/:room_id/escrow` | human (token) | | `{ has_escrow, revision, escrow_version, updated_at, updater_device_id }`, plus `key_escrow` only for a v1 escrow stored before review 3 (the migration path: `client.migratePassphrase`). Without a token: always `404 not-found` (no blob is served by room id any more) |
| `DELETE /v1/rooms/:room_id/escrow?revision=` | human | | `{ ok, revision }`; compare-and-swap like PUT; announced as `escrow_changed` with `escrow_version: null` |
| `POST /v1/rooms/:room_id/account` | human | `{ email, auth_key, key_wrapped, kdf }` (Accounts, below) | `201 { email, email_verified_at: null, revision: 1 }`, and a six-digit code is mailed. One account per room (`409 account-exists`). Never says whether the email is in use elsewhere |
| `GET /v1/rooms/:room_id/account` | human | | `{ email, email_verified_at, created_at, updated_at, revision, key_wrapped, kdf, has_recovery, claim_expires_at? }`, else `404` |
| `PUT /v1/rooms/:room_id/account/password` | human | `{ auth_key, key_wrapped, kdf, revision }` | `{ revision }`; compare-and-swap (`409 account-changed`) |
| `PUT /v1/rooms/:room_id/account/recovery` | human | `{ recovery_auth, recovery_wrapped, revision }` (the Emergency Kit) | `{ revision }`; compare-and-swap |
| `POST /v1/rooms/:room_id/account/verify` | human | `{ code }` | `{ email, email_verified_at }`; `400 wrong-code` (five tries per code, 30 minutes). Confirming deletes every other room's claim on that email |
| `POST /v1/rooms/:room_id/account/code` | human | | a new code (once a minute; at most 5 mails per address and hour) |
| `POST /v1/accounts/login` | anyone, rate-limited | `{ email, auth_key }` | `{ room_id, key_wrapped, kdf }`, else `401 wrong-login` for an unknown email and a wrong password alike |
| `POST /v1/accounts/recover` | anyone, rate-limited | `{ email, recovery_auth }` | `{ room_id, recovery_wrapped }`, else `401 wrong-recovery` |
| `DELETE /v1/rooms/:room_id` | a signed test request, test rooms only | | `{ ok }`: every row of the room and its attachments are gone |

### Accounts (email + password)

A person signs up with an email and a password of their own (at least 12 characters; the app offers a generated
five-word one). The first device founds the room as before; the account only maps the email to that room and keeps,
opaque to the hub, what lets a new device in. Format and code: `core/account.mjs`; hub: `hub/accounts.mjs`.

- **In the browser:** `salt = SHA-256("trommi/v1/account-salt" 0 ‖ email)`, `master = Argon2id(password, salt, 64 MiB, t = 3, p = 1)`
  (hash-wasm, vendored as `core/argon2.mjs`, checked against `node:crypto` and RFC 9106 in `hub/accounts-test.mjs`;
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
event: ephemeral      data: {"device_id":"<hex>","envelope":"<b64u>"}                (never stored; typing, cursors, pen preview)
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
| `objects` (derived) | `room_id`, `object_id`, `object_state`, `urgency`, `answered_at`, `owner_device_id`, `first_envelope_number`, `latest_head_envelope_number` (cards, memos, permission requests: everything with an `object_id`) |
| `timelines` (derived) | `room_id`, `timeline_kind`, `timeline_id`, `last_envelope_number`, `item_count` |
| `attachments` | `room_id`, `attachment_id`, `object_id`, `uploader_device_id`, `total_size`, `chunk_count`, `stored_at` |
| `access_tokens` | `access_token_hash`, `room_id`, `device_id`, `expires_at` (kept in memory; listed for completeness) |
| `push_subscriptions` | `room_id`, `device_id`, `endpoint`, `subscription`, `created_at` |

**Truth: `envelopes` and `member_entries`. Derived: `objects`, `timelines`.** The two derived tables are written from signed header fields in the same transaction as the envelope and can be dropped and rebuilt from `envelopes` at any time (the hub's tests do exactly that). The hub uses them for fast answers (open cards by urgency, counts, later the admin page). They are never a source of truth for a client: clients verify everything against signatures. Card options and all content stay inside `encrypted_body`.

hub.db uses incremental auto-vacuum (pages freed by deleted rooms are returned every 30 s in small steps). Backups before each deploy: an online copy (`VACUUM INTO` in the running container) gzipped to `/srv/trommi/backups/hub-<stamp>.db.gz`, attachments mirrored to `backups/attachments/`; kept: 7 newest plus the newest of each of the last 7 days (`hub/deploy-backup.sh`).

Attachments are not in SQLite: encrypted client-side with `encryptAsset` (64 KiB STREAM chunks, a random key per file), stored as files `/data/attachments/<room_id>/<attachment_id>`, served with `Range`. The store is a four-method interface (`put`, `get` with range, `size`, `delete`) so it can move to object storage later.

**Retention.** 30 days after an object's newest head is answered or closed, every envelope of that object and of its chat timeline `card/<object_id>` is pruned to header, ciphertext hash and signature (`pruneEnvelope`) and its attachments are deleted; chains still verify. Envelopes without a card stay for now (whether chat goes after 30 days is a pending decision).

**Push.** For an envelope with `send_push`, the hub sends a Web Push to every human device of the room except the sender, with `{ room_id, envelope_number, urgency }` and nothing else. The app's service worker shows "Trommi: neue Frage" or, when it can open the room locally, the title.

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
| Password escrow reads | 10 per hour per address (`HUB_LIMIT_ESCROW_READS_PER_HOUR`); per room the same number of misses (wrong escrow ids); a hit is never refused for the room's budget; "no room" and "no escrow" are one `404 not-found` |
| Writes in flight | `HUB_WRITE_QUEUE` (512) POST/PUT/DELETE at once, at most `HUB_WRITE_PER_IP` (16) from one address; beyond: `503 overloaded`, `retry-after: 1`. Member entries, session grants and the batch re-key (`POST session_grants`) may also use a reserved pool of `HUB_WRITE_QUEUE_MEMBERSHIP` (32), so a full queue never blocks a removal or its re-key |
| Slow requests | A JSON body arrives whole within 15 s; an upload within 60 s + size / 16 KiB/s; any request with no bytes moving for 30 s is closed (streams live on their pings). Routes with a token check it before reading the body; uploads, ephemeral posts, share and escrow writes check it again after the body (a device removed meanwhile stores nothing) |
| Client address | The socket address. `cf-connecting-ip` counts only with `HUB_TRUST_CF=1` (set in `hub/Dockerfile`) **and** a loopback or private peer (cloudflared on the host, through Docker's port proxy); never from the tailnet or the internet |
| Pending uploads | An attachment no envelope of its uploader names within an hour is deleted. Only the uploader's own envelopes bind an attachment to an object (deleted with it) |
| Stream send buffer | `HUB_STREAM_BUFFER_BYTES` (4 MiB) per stream; beyond: dropped, resume by cursor |
| All stream buffers together | `HUB_STREAM_BUFFER_TOTAL_BYTES` (256 MiB); beyond: the fattest streams are dropped until 80 % remain, they resume by cursor. Catch-up is sent in slices of 64 envelopes and waits for the socket above 256 KiB |

Every rate limit of the table is configurable: `HUB_LIMIT_<NAME>` for each key of `LIMITS` in `hub/server.mjs` (`HUB_LIMIT_ENVELOPES_PER_SECOND`, `HUB_LIMIT_ENVELOPE_BURST`, `HUB_LIMIT_FOUND_PER_IP_HOUR`, `HUB_LIMIT_OPEN_REQUESTS_PER_IP_MINUTE`, `HUB_LIMIT_STREAMS_PER_DEVICE`, …).

**Attachment quota.** The bytes of a room's attachments are summed from `attachments.total_size`. An upload that would pass the quota first evicts, oldest first: attachments of answered or closed objects (cards, published pages no longer released), and attachments only thread items name. Never evicted: attachments of open objects (a released published page is open), anything a human's `status` envelope names (canvas snapshot pointers), what an agent's newest attachment-naming `status` in a scope names, and attachments no envelope names yet (an upload whose envelope is still to come). Review 3: only the uploader's own envelopes count as references (naming someone else's attachment neither protects it nor makes it evictable); an agent's upload evicts only that agent's attachments, never another device's; agents together hold at most a quarter of the quota (beyond: `413 quota-exceeded` with the agents' share as `quota`), so an agent cannot pin the room's quota with a status. Evictions are announced on the stream as `attachment_evicted`. If even that is not enough: `413 { error: "quota-exceeded", used, quota }` (before the upload when `content-length` is given). Honest gap: an old canvas snapshot that a newer one replaced is kept too, because the hub cannot tell registers apart.

**Test rooms.** Off unless `HUB_TEST_PUBLIC_KEY` is set (no key is baked into the image; unset, empty or `off` = off; **keep it off before launch**; a live load test needs someone with server access to set it in `/srv/trommi` for the run). A load harness signs its requests with the private half (Ed25519, never leaves the harness): header `x-test-signature: v1.<timestamp>.<nonce>.<signature>` over `trommi-test-request/v1`, method, path with query, timestamp and nonce; valid for 60 s and once (`signTestRequest()` in the same file). Such a request may found a room with `test_room: true` (standing in for `x-found-token` and the per-address founding limit; a signed founding without `test_room: true` is refused) and may `DELETE /v1/rooms/:room_id` a test room (rows of every table with a `room_id`, its attachment folder). The rate limits are lifted for the routes of test rooms only, never for a real room and never for the escrow. A test room expires after 24 hours.

**Metrics** are never served on the public port. With `METRICS_PORT` set (server: 8792, mapped to the host's 127.0.0.1 only; `METRICS_HOST` 0.0.0.0 inside the container), `GET /metrics` gives Prometheus text: requests and latency histograms per route, envelopes ingested, write queue depth and refusals, open streams, bytes waiting per stream (sum and fullest), dropped streams, SQLite and WAL size and checkpoint lag, heap, RSS, event-loop lag, GC pauses, open files, host load, memory and data-disk space (`/proc/loadavg`, `/proc/meminfo`, `statfs`); `GET /metrics/history` the last hour in 10-second samples, for the admin page. The WAL is checkpointed every 10 s (passive; truncating above `HUB_WAL_TRUNCATE_BYTES`, 64 MiB).

### The data model: objects, timelines, registers, projections

Everything in a room is one of three things, and the board is a fourth thing computed from them:

| | What | Examples | How it travels |
| --- | --- | --- | --- |
| **Objects** | things placed into the room, with versions | a card (decision, info), a permission request, a memo, a published page | envelope kind `object_version`, a head. Each version is a new envelope naming the previous one (`previous_version_hash`). The newest version is the object. An object has an `object_id` (16 bytes) in the header |
| **Timelines** | append-only, small items, paged | the conversation under a card, a session's chat, the strokes on a canvas | envelope kind `timeline_item`, a thread item, carrying `timeline_kind` (`chat`, `canvas`) and `timeline_id` (`card/<object_id>`, `session/<session_id>`, `desk/<desk_id>`) |
| **Registers** | "the current value of something" | status lines, an agent's profile, drafts, snooze, duck, crown, desks, session settings, read markers, a canvas snapshot pointer | envelope kind `status`, a head: `{ values: { "<key>": value \| null } }`, last writer wins |
| **Projections** | computed on every client, never stored or sent | the Desk, stacks, crowns, the Next line, counters, "in revision", queue order | — |

Four command kinds bind a human's decision to exactly the object version it answers (the crypto layer checks the bind, concept §6): `answer`, `decide_again`, `verdict` (to a permission request), and the agent's `permission_request` itself, which is an object with an expiry. That is all: **seven kinds, and none of them knows a content type.** A new content type (video, a new card type, a poll) is a new `object_type` or `content_type` inside the encrypted body, with big media as attachments (STREAM chunks, Range, thumbnails or posters as separate small attachments). The hub never needs a new kind.

### Inside the envelope: the body

The hub never reads this; app and channel agree on it. The body's payload is UTF-8 JSON: `{ "schema_version": 1, … }`. A client ignores fields it does not know and shows a body with a higher `schema_version` as "needs a newer app". An attachment reference:

```json
{ "attachment_id": "<hex>", "file_key": "<b64u>", "sha256": "<b64u>", "file_name": "plan.png", "media_type": "image/png",
  "total_size": 48213, "width": 1440, "height": 900, "caption": "…", "page": "…", "poster_attachment_id": "<hex>",
  "marks": [{ "x": 0.1, "y": 0.2, "width": 0.3, "height": 0.1, "label": "…" }] }
```

A **session** on the board is an agent member. A human's envelope for a session has `recipient_device_id` = that agent; an agent's envelopes are for everyone. An object belongs to the member that created it; only its creator writes new versions (a memo: any human device).

| `envelope_kind` (crypto `KIND`) | From | Header | Body (besides `schema_version`) |
| --- | --- | --- | --- |
| `timeline_item` (1), thread | anyone | `timeline_kind`, `timeline_id` | `content_type`: `message` (`text`, `details?`, `html?`, `attachments?`, `hand_back?`, `explain?`, `present_card?`, `copied_cards?`, `marks?`, `published_object_id?`), `strokes` (`strokes: [{ stroke_id, points (quantised, delta-encoded), style }]`, sent every ~150 ms while drawing), `erase` / `move` / `send_away` (`stroke_ids`, `offset?`), `selection_sent` (`text?`, `attachments`: the picture of the selection, `stroke_ids`) |
| `object_version` (2), head | creator | `object_id`, `object_state`, `urgency` | `object_type`: `card` (`card_type` `decision` \| `info`, `title`, `body?`, `options?`, `sections?`, `html?`, `allows_multiple?`, `recommended?`, `urgency_reason?`, `attachments?`, `change_note?`, `close_summary?`, `withdraw_reason?`, `merged_into_object_id?`, `merged_from_object_ids?`), `memo` (`text`, `x`, `y`, `color`, `desk_id`), `published` (`attachments`, `title`, `note?`, `released_until?`); always `object_version` (1, 2, …) and `previous_version_hash` |
| `answer` (3), head | human → owning agent | `object_id`, `object_state` answered (closed for read and shred), `answered_at` | `answer_action` (`answer`, `read`, `shred`), `choices?`, `note?`, `option_notes?`, `attachments?`, `marks?`, `trusted?`; signed bind: object id, hash of the version answered, every choice (R7) |
| `permission_request` (4), head | agent | `object_id`, `send_push` | `tool_name`, `description`, `input_preview`; bind: request id, expiry |
| `verdict` (5), head | human → agent | `object_id` | bind: request id, request hash, expiry, allow or deny |
| `status` (6), head | anyone | | `values: { "<key>": value \| null }` |
| `decide_again` (7), head | human → owning agent | `object_id`, `object_state` open | bind: object id, hash of the answer taken back |

There is no kind 8: the hub refuses it (`bad-format`); drawings are timeline items.

**Registers.** A key's value is the one from the latest `status` envelope that set it in **signed causal order** (see Security rules, R2), never hub order; `null` deletes. Keys are scoped by the sender:

- **Every device's own key** counts only from that device: `device/<device_id>` (`device_name`, `platform`, `folder`, `host`), written right after joining, e.g. `device_name` "valiido", `folder` "~/git/valiido", `host` "desktop". The hub never sees a name.
- **An agent's keys** count only from that agent: `profile` (`model`, `task`, `icon`, `agent_name`, `parent_session`, `is_main`), `status_line/<id>` (`label`, `state`, `detail`, `object_id`), `alert/<envelope_hash>` (a command the agent refused: `code`, `message`, `sender_device_id`, `envelope_number`).
- **Human keys** are shared by every human device and ignored by agents: `draft/<object_id>`, `snooze/<object_id>`, `duck/<object_id>`, `crown`, `desk/<desk_id>`, `session/<session_id>` (name, desk, archived, group, icon), `read_up_to/<session_id>`, `canvas_snapshot/<timeline_id>` (for `timeline_kind` canvas; `attachment` reference + the signed sender **frontier** it includes, R2), `room_snapshot` (a whole-room snapshot for a fresh device's first load: `core/snapshot.mjs`).

**Canvases.** Strokes are an append-only set: concurrent edits from two devices merge without conflict (set semantics, ordered by `envelope_number`; erase and move are tombstones referencing `stroke_ids`). Every few hundred strokes or when idle, one device writes the whole canvas as an encrypted snapshot attachment and points `canvas_snapshot/<timeline_id>` at it; a fresh client loads snapshot + `GET threads?timeline_kind=canvas&timeline_id=…&after_envelope_number=` instead of replaying everything. Live strokes from others render from the stream as they arrive.

**Projections, computed on the client:** a card's place in the stack (oldest first by `sent_at` of version 1, R2), "in revision" (a human message with `hand_back` or `explain` newer than the card's newest version, until the agent's next version or a message with `present_card`), the Desk and stacks, crowns, the Next line, unread counts.

### Cryptography in one page (bytes: `core/FORMAT.md`, library: `core/zcrypto.mjs`)

| Piece | How |
| --- | --- |
| Device | Ed25519 (`key_signing_public`) + X25519 (`key_exchange_public`); `device_id` = H(both). Browser: WebCrypto, IndexedDB, wrapped by a non-extractable AES key and unwrapped as non-extractable (WebKit loses a stored X25519 CryptoKey). Agent: key file, mode 0600 |
| Member list | Append-only signed entries (`room_founded`, `device_added`, `devices_removed`, `recovery`), each with `entry_number`, `previous_entry_hash`, signed by an active human device or the recovery key. `room_id` = hash of the founding entry, so the invite link pins the whole list. Clients pin the newest entry and refuse rollback and forks |
| Room key | 32 random bytes per `key_epoch`, a new epoch only when a member is removed or on recovery. Sealed per human device and the recovery key (X25519 + HKDF + AES-256-GCM, HPKE pattern), bound to room, epoch, recipient; humans also get a history key and the back links. Agents never hold the room key: they hold session keys (R6) |
| Envelope | Header (plaintext, signed, associated data) ‖ 96-bit random nonce ‖ AES-256-GCM `encrypted_body`, padded to 256 B … 64 KiB ‖ `envelope_signature` over H(header ‖ nonce ‖ H(encrypted_body)). Per-sender key = HKDF(scope key, room, key scope, key epoch, sender), the scope key being the room key or a session key (R6). Per-sender `sender_sequence` + `previous_envelope_hash` chain; `seen` vector of other senders' heads. New in v1.1, signed like every header field: `envelope_kind` (u8; the body has no kind of its own), and for thread items a binary timeline: `timeline_kind` u8 (1 chat, 2 canvas) ‖ `timeline_scope` u8 (1 card, 2 session, 3 desk) ‖ reference (card: `object_id` 16 bytes; session: `session_id` 16; desk: `desk_id` 16). The JSON and SQLite form `timeline_id` is the canonical text `card/<32 hex>`, `session/<32 hex>`, `desk/<32 hex>`, lowercase, nothing else accepted |
| Thread items fetched later | The pruned form (header, nonce, ciphertext hash, signature) verifies the chain at sync time; when the full envelope is fetched, the client checks that H(encrypted_body) equals the hash it already verified, then decrypts (`openVerifiedEnvelope`). Nothing is decrypted that the chain did not vouch for |
| Sign-in | Hub challenge (32 bytes) signed with room id and hub address → `access_token`, 10 minutes, one device |
| Invite | Link `#v1.<hub>.<room>.<secret>`; `invite_id` and MAC key from HKDF(secret); request MAC'ed and self-signed; commit-then-reveal six-digit check code, mandatory for humans, and for agents when the invite says `confirm_code` (the channel prints the code; review 3); an agent link that two different devices answer adds nobody (`invite-contested`, the invite is spent) instead of the first comer; one use, 10 minutes, enforced by the inviter |
| Commands | An agent acts only on envelopes from an active human device addressed to it, current epoch (previous for 2 minutes), and for answers/verdicts bound to the current card or request hash |
| Attachments | Random key per file, 64 KiB STREAM chunks (chunk index and last-chunk flag in the nonce); key, hash, name and type inside the referencing body; only the `attachment_id` in the header |
| Removal and re-adding | Any human device, at any time: one `devices_removed` entry carries the new `key_epoch` sealed for every human device that stays and the recovery key (agents hold no room key, R6) and the back link. The hub at once closes the removed device's streams, revokes its access tokens and refuses its sign-in and envelopes; the others switch to the new epoch on the `member_entry` event without interruption (the previous epoch is still accepted for 2 minutes after the entry, then refused by hub and clients, R3). The removed device keeps what it already decrypted and can open nothing sent in the new epoch. A removed `device_id` can never come back: re-adding a phone means new device keys and a new invite. A re-added human device gets the history key and back links, so it reads the whole history again; a re-added agent reads from its join on (R6) |
| Reconnecting is not joining | A crashed or restarted Claude session finds its key file (`~/.local/share/trommi/keys/<room_id>/<host>-<folder>-<slot>.key`, mode 0600) and comes back as the same device: sign in, take the lease, catch up from its cursor (R4). No member entry, no new epoch. Only a new folder or machine joins by invite |
| Cost of a removal | Never re-encrypts anything: one member entry plus a fresh 32-byte key sealed once per remaining member (milliseconds, measured with 20+ members in "Performance"). Several devices removed at once are one entry and one new epoch. Removal and the new key stay one entry on purpose: a lazy rotation would let the removed device read what is sent before the next rotation. Agents idle for `agent_idle_days` (a human setting, default off) are removed by the next human device that opens the room, batched into one entry |
| Recovery | 256-bit code (Crockford base32) derives a key pair; a `recovery` entry adds the new device, removes every human device, keeps the agents unless it removes them too (R6), starts a new epoch and a new code |

### Security rules (v1.1, after the two reviews of 4 October 2026)

Two independent reviews (Claude, Codex; four findings reproduced) found the primitives sound and the weak points one layer up: who may claim what, hub order, freshness, crash state. These rules are binding for every client and, as a second line, the hub.

**R1. Authority, not just signatures.**
- `object_id` = first 16 bytes of H("trommi/v1/object-id", creator `device_id` ‖ `sender_sequence` of version 1). Version 1 has `previous_version_hash` = zeros; every later version comes from the creator and names its predecessor (memos: any human device; two versions naming the same predecessor are settled by R2). Two chains for one id are equivocation.
- Who may write what (checked against roles from the signed log):

| What | Allowed sender |
| --- | --- |
| `object_version` | the creator (agents: cards, published pages, permission requests; humans: memos) |
| `answer`, `decide_again` | a human device, `recipient_device_id` = the object's creator |
| `permission_request` | an agent, its own object |
| `verdict` | a human device, `recipient_device_id` = the request's creator; request id = `object_id` |
| `timeline_item` chat on `session/<S>` | the agent assigned to S, or a human with `recipient_device_id` = that agent |
| `timeline_item` chat on `card/<X>` | X's creator, or a human with `recipient_device_id` = X's creator |
| `timeline_item` canvas on `desk/<D>` | human devices |
| `timeline_item` canvas on `session/<S>` | human devices and the agent assigned to S |
| `status` key `device/<X>`, `profile`, `status_line/*`, `alert/<envelope_hash>` | X itself / an agent the session's grants gave that session key epoch (session scope) |
| `status` human keys (`draft/`, `snooze/`, `duck/`, `crown`, `desk/`, `session/`, `read_up_to/`, `canvas_snapshot/`, `room_snapshot`) | human devices only |
| session grant | a human device (signed, chained per session); the first grant of an agent's own child session: that agent (R6) |
| `send_push` | honoured only on `object_version` and `permission_request` from the creator, rate-limited |

- Retention starts at the hub's own `received_at` of an allowed final head (the creator closes or withdraws, or a human answers the creator); a reopen cancels it. A sender's `answered_at` is display only.
- Stroke ids are (`device_id`, `sender_sequence`, index), so nobody can collide with another member's strokes. Agents change only their own strokes.

**R2. Order from signed data, never from hub order.** `envelope_number` is for paging only. Writes to a register or memo are ordered by one total order that every device computes alike (v1.1.1, review 2 D1: the earlier pairwise rule was not transitive, so the hub's delivery order could pick the winner): (`lamport`, `sender_device_id`, `sender_sequence`), strictly lexicographic (review 3: the sender-chosen `sent_at` is no longer part of it; with it two writes of one sender at an equal lamport made a cycle), where `lamport` is an integer in the encrypted `status` and memo body, one above every `lamport` the writer had seen (a write made after seeing another sorts after it; bodies without one count 0). A lamport above 2^48, or more than 2^24 above the largest this device has seen, is refused (counts 0, is not adopted, alert `lamport-inflated`): one signed write cannot pin a register for good. The writer saves its counter in the same durable write as the envelope, before the post. Deletes stay as tombstones (value null). Human registers, agent registers and memo versions use it; the stack is sorted by urgency, then `sent_at` of version 1, then creator and object id. A canvas snapshot register carries a signed **frontier** `{ sender_device_id: [sender_sequence, envelope_hash] }`; clients apply every item of the timeline not covered by it, whatever numbers the hub shows, and accept a new snapshot only if its frontier dominates the applied one. Snapshot writers: humans for `desk/*`, humans and the assigned agent for `session/<S>`; a fresh client trusts the newest snapshot from an allowed writer (stated trust: a snapshot cannot be checked without replaying). **Room snapshots** (`room_snapshot`, `core/snapshot.mjs`, v1.1.1 review 2 D5/D6): taken only from a human device that is still a member, never from one written before the newest removal or recovery; the tail after it is read from an overlap window before its cursor and classified by signed (`sender_device_id`, `sender_sequence`), so hub numbers cannot hide envelopes beyond the snapshot's frontier; items older than the snapshot must name the requested timeline as thread items, pass the R1 rules, lie within the frontier, and count once per (sender, sequence). Remaining trust, plainly: the snapshot's content itself (cards, answers, registers) comes from one human device and is not re-verified; a hub that withholds every newer envelope of a sender is not noticed until one arrives.

**R3. Revocation on the receive path.** `devices_removed` and `recovery` entries carry, per removed device, the **cut** (`sender_sequence`, `envelope_hash`) of its last envelope the remover had seen; hub and clients refuse anything beyond it. A remover that holds no chain of the device (a recovery, a fresh device) first verifies the hub's envelope headers of that device and cuts at the last verified one, never at 0 (v1.1.1, review 2: an empty cut refused all history of the removed humans); the hub lets the recovery key read envelopes for this. Old `key_epoch` is accepted for 2 minutes after the epoch-changing entry arrived (the arrival time is stored), then refused by the hub (`409 wrong-epoch`, which tells a stale sender to fetch the log) and shown by clients as "sender on an old member list". The channel process refreshes the member list before executing any answer, verdict or decide-again and halts all commands on `log-fork` until a human acts. Residual, honestly: a hub that withholds a removal forever from one member keeps that member on the old key; it shows as soon as any envelope crosses.

**R4. Crash safety.** Per device and room exactly one seal and one open at a time (a lock across tabs: Web Locks; across processes: `flock` on the key file). Write-ahead: the sealed envelope and the new own chain head are stored durably **before** posting (file storage: temp file, fsync, rename, fsync of the directory; IndexedDB: a `durability: 'strict'` transaction); if that write fails the device stops sending. A retry posts the same bytes (`replay` = success). A signed sequence number is never signed twice (review 2 D2): a final refusal of a verified envelope at the sender's next number is kept by the hub as a **void record** (pruned, `void: true`, takes its `envelope_number`, applied by nobody) and the sender goes on behind it; any other final refusal halts the device's sending (`outbox_blocked`, alert `chain-halted`) and the same bytes are retried. The verified chains, epoch secrets, pinned log, cursor, a **delivered-up-to** per human sender and a ledger of executed commands are stored with the key file. A process that starts without them treats every command sent before that start as history, never as a new prompt, and keeps that boundary (`history_before`, and since review 3 also `history_before_number`, the room's head envelope number at that start, so a future-dated old command is history too) across restarts (review 2 D4: before, only the first old command per sender counted as history). A command held back and met again in a replay is handed out once (review 3). An agent names its lease generation on posts, streams, attachment uploads and ephemeral posts (review 3; `none` or an older one: `409 lease-lost`), so it takes the lease before its stream opens. Cores before review 3 send no header on streams and uploads and keep the old rule until every app carries the new core; then that path goes. A recovery stores the new device, its room record and the session keys before it posts the recovery entry (review 3), so a crash right after the post loses nothing. A failed member refresh holds answers, verdicts and decide-again back (retried); a `log-fork` halt holds commands, it does not drop them. Agent key slots `<host>-<folder>-<slot>.key`: two sessions in one folder take two slots. One running process per key (the lease): a new process takes over; the hub ends every stream of that key that does not name the new `lease_generation`, and the old process's reconnect and posts get `409 lease-lost`, so it stops before posting. Renewals (`renew: true`) never take over a live lease, so two processes cannot trade the lease back and forth. Leases are stored (`agent_leases`), so a hub restart keeps them; with no live lease a renewal takes it with a new generation, and a client that gets `lease-lost` (on a post, its stream, an upload or an ephemeral post) first renews and stops only if another live process holds the key. Every lease claim of a process names its one process instance (a claim from the outbox before the start took the lease never takes the process's own lease over); a request refused under a generation the process has since replaced is sent again; a renewal that fails for any other reason than `lease-lost` (offline, a restarting hub) is asked again, never taken as a takeover. Streams reconnect at most 2 s apart and at once when a request gets through again (a deploy holds messages back for seconds, not minutes). A valid signature with a broken body advances the chain and quarantines the body (no stalled room).

**R5. Bounded headers.** `seen` lists only senders active at the named log entry whose head changed since the author's previous envelope (receivers carry earlier values forward); at most 64 entries. Status bodies ≤ 4 KiB. Unknown kinds, unknown flags, non-canonical timelines, wrong padding length and a leading BOM are refused.

**R6. Keys per session (owner, 4 October 2026).** There is no new room key when an agent joins. Instead:

- **Two key scopes.** The **room key** (per `key_epoch`, from the member list as before) is held by human devices only and encrypts room-wide things: desks, memos, human registers, device labels. Each **agent session** has its own **session key** (per `session_key_epoch`) that encrypts that session's cards, its chat, its canvas and its agent's registers. Human devices hold every session key (with back links, so they read every session's whole history); an agent holds only the keys of the sessions assigned to it. Agents cannot read other sessions, desks or human registers.
- **Header.** `key_scope` u8 (0 room, 1 session) ‖ for scope session the `session_id` (16 bytes); `key_epoch` is then the session's key epoch. The scope and session are in the sender-key derivation and the associated data. A session's timelines and objects must be under that session's key; room-wide data under the room key (checked by every receiver).
- **Session grants** (a second small signed chain per session, stored by the hub in `session_grants` and `sealed_session_keys`): a human device signs `{ room_id, session_id, grant_number, previous_grant_hash, session_key_epoch, assigned_agent_ids, key_commitment, wrap manifest hash, logSeq/logHash }` and posts it with the session key sealed for every active human device, the recovery key and the assigned agents, plus a back link to the previous session key epoch. A session is created by its first grant (`session_id` random, chosen by the human device). Route: `POST /v1/rooms/:room_id/sessions/:session_id/grants`, `GET …/grants`, `GET …/sealed_session_keys` (own only), `GET …/key_back_links` (humans; an agent gets them only if the grant says `with_history`).
- **Assigning an agent to a session, or handing a session over** (a crashed Claude replaced by another): the app asks „Darf er den bisherigen Verlauf lesen?“. Yes: the grant starts a new `session_key_epoch` and marks `with_history`; the agent gets the history key and every back link below that epoch and reads all of that session. History is per agent (v1.1.1, review 2 K2): only the agents assigned with history get the history key in their wrap, so adding B with history never hands A the past; an agent once given the history gets the history key again at every later rotation while it stays on the session (review 3; who holds it is the humans-only register `session_history/<session_id>`, so every human device rotates alike). No: the same new epoch without history, so the agent reads from now on. Either way it reads nothing of other sessions, and the previous holder keeps nothing of the new epoch (v1.1.1, review 2 B01: a grant in the same epoch may only add agents, never drop one).
- **Removing an agent** (or unassigning it) is one new grant with a new `session_key_epoch` for each session it held. Removing it from the member list is a `devices_removed` entry, and that entry always carries a new room key epoch (the format has no removal without one); harmless, a few milliseconds, although agents never held the room key. Removing a **human** device rotates the room key (as before, one member entry) and every session key (one grant per session, posted by the same device right after; until then the removed device is already refused by the hub). New human devices receive all session keys at join, sealed by the inviter.
- **Grants after a member change (v1.1.1, review 2 B02/A1).** A grant counts only if its signer is an active human device (or the recovery key valid then) at the grant's `logSeq`, and no grant names a `logSeq` before a removal or recovery its predecessor already saw. A session whose newest grant's `logSeq` is below the newest removal or recovery entry is **stale**: clients read with its key but never send under it, and a human device re-keys it (new epoch). The hub refuses new grants that name a member list from before the newest removal or recovery, or whose signer is no longer active (`409 stale-grant`), and refuses session-scope envelopes of a stale session (`409 stale-session-key`, retry the same bytes after the new grant; the old epoch is accepted for 2 minutes after it). So a removed device can never re-key a session to a key it knows, and nobody keeps sending under a key the removed device holds.
- **Child sessions (4 October 2026).** An agent may open sessions of its own for its helpers ("Design", "Server") without a human's approval: it draws the session key, seals it to itself, every active human device and the recovery key (never to another agent; the hub checks the wrap set as for every grant) and signs the session's **first grant** itself. Rules, enforced by `applyGrant` on every client and by the hub: an agent signs only grant 0 of a session, only with itself as the sole assigned agent and without history; every later grant (re-seal for a new human device, rotation after a removal, handover) is a human's, as for any session. The hub also wants the signer to be an active agent and allows at most 32 such sessions per agent (`429 rate-limited`). The agent writes the child's `profile` there with `parent_session` = its main session; clients honour that parent only if the child's creator is assigned to the parent session (`model.parentSessionOf`), so a child cannot hang itself under another agent. Agents still cannot add devices or other agents, and cannot add anyone to a session.
- **Reconnecting** with the same device identity changes nothing.
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
- **Still open (v1.1.1):** attachment lengths are not padded to buckets (C22: the hub sees an attachment's exact size; padding needs a format change in the encrypted reference); a leaked recovery code can only be revoked by a full recovery, there is no cheaper `recovery_key_changed` entry (M6); the password escrow uses PBKDF2 (v2: 2,000,000 iterations, addressed by a passphrase-derived id, so guesses are online unless someone holds the hub's database), not a memory-hard KDF: WebCrypto has no Argon2 and no small vetted pure-JS Argon2id is in the tree. Therefore only a generated passphrase (`generatePassphrase`, 120 bits) is accepted (review 3: a human's own phrase, a lyric or quote, falls offline to the database holder and unlocks the whole room); every human device shows `recovery-add` when the recovery key adds a device. Clients apply the epoch cutoff too (review 2 B03, completed in review 3): a device whose stream was open since before it learned of a key change refuses a live envelope in the older epoch 2 minutes after that; otherwise (after sleep or offline, in a resync, reading history) the signed times decide: the sender's header `time` must lie within 2 minutes plus 3 minutes of clock skew of the signed time of the entry or grant that began the next epoch. A refused stale envelope still moves its sender's chain on (no gap, so no resync that would apply it), and its hash is kept, so a resync refuses it again (alert `wrong-epoch`). Residual: a removed sender with a colluding hub can still backdate envelopes into that window for devices that were not live then. Agent writes into a session are authorised by the agents the grants gave that session key epoch.

**R7. Binds.** `answer` binds object id, the hash of the version answered and the full list of choices (each must be an option). `decide_again` binds the answer taken back **and** the current version's hash. `verdict`: request id = `object_id`. `trusted` widens nothing: the agent picks its own recommendation and says so.

**R8. Names.** Member entries, offers and join requests carry no names (the field is gone in v1.1). A device writes only its own `device/<device_id>`; the inviter writes `session/<session_id>` with the label it chose when making the invite, and that wins over what the agent calls itself. The UI shows the role from the signed log and a short key fingerprint next to every name.

**R9. Format fixes.** `wrapAssetKey` uses a random nonce. Invite hashes and the check code cover the signed body (request: body ‖ MAC), not the Ed25519 signature, so vectors are reproducible on every platform. The hub address is canonical: `https://` + lowercase host [+ `:port`], no path, no trailing slash, copied verbatim from the link. Stroke points: base64url of int16 big-endian deltas in 1/8 px, first point absolute; style `{ tool, color, size }`.

**Adopted from the research** (`docs/` research notes, 10 systems): ephemeral events that are never stored (typing, cursors, a pen preview) go over `POST /v1/rooms/:room_id/ephemeral` as sealed envelopes relayed to open streams only (`event: ephemeral`); attachments may have a separate small poster/thumbnail attachment with its own key and a tiny placeholder in the body; room snapshots from a human device for faster first loads (`core/snapshot.mjs`, trust in R2).

### What an agent's channel process checks

Before Claude Code sees anything (concept §6): the envelope verifies; the sender is an active human device; it is addressed to this agent; for answer, verdict and decide again the bind matches the current card or request (`authoriseCommand`). Anything else is dropped and reported on the board as the status register `alert/<envelope_hash>`.

### The agent channel (`connector/channel.mjs`)

An MCP stdio server with today's tools and today's `<channel source="board" kind=…>` events (copied in `connector/channel-tools.mjs`; tool → envelope and command → event in `connector/channel-bridge.mjs`; all protocol work in `client/core`). It runs as server `trommi` in the project's `.mcp.json`:

```json
{ "mcpServers": {
  "trommi": { "command": "node", "args": ["/home/christopher/git/trommi/connector/channel.mjs"] }
} }
```

(`hub/channel.mjs` is kept as a forwarder for older entries.) Start: `claude --dangerously-load-development-channels server:trommi`. First time per room, machine and folder: in the Trommi app "invite an agent", then run `node /home/christopher/git/trommi/connector/channel.mjs join '<link>'` in the project folder, or start Claude with `TROMMI_INVITE='<link>'`. Joining is the human's act only: there is no model-callable `join` tool, so a link smuggled into a prompt cannot make the agent join a room (review 2). Agent invites default to "without history". The app adds the agent without a check code and then assigns it to a session (R6: a new session, or the handover of an existing one, with or without its history); until then the tools answer "not yet assigned to a session". The agent holds no room key, only the keys of its sessions. Afterwards every session in that folder reconnects by itself: key slot `~/.local/share/trommi/keys/<room_id>/<host>-<folder>-<slot>.key` (0600; the `<host>-<folder>` part is written once to `<folder>/.trommi/slot-base` and read from there, so a renamed or moved folder keeps its identity), with `<…>-<slot>.state.json` (cursor, chains, delivered commands), `<…>-<slot>.lock` (pid of the process holding the slot, `connector/channel-lock.mjs`: Node has no `flock`, so every process writes a claim of its own, `<…>.lock.<pid>`, then looks: claims of dead pids are deleted, and if another live claim is there it withdraws; whoever looks second sees the first, so at most one wins, and nothing is ever taken over) and `<…>-<slot>.files/` (the human's attachments, decrypted) beside it. A second session in the same folder takes the next slot and needs an invite of its own (two sessions are two members). Commands that arrive during catch-up wait until the bridge is up; `late`/`history` come as meta `late="1"`/`history="1"`; only `content_type: message` is chat; on `log-fork` commands are held back, on `lease-lost` the process exits. Environment: `TROMMI_HUB` (default `https://hub.trommi.com`; an invite names its hub), `TROMMI_ROOM` (when a folder has keys for several rooms), `TROMMI_KEYS_DIR`, `TROMMI_FOLDER`. `node connector/channel.mjs whoami` shows room and key file. `publish_asset` puts a `published` object on the board and announces it in the session's conversation (a message with the same attachment). `share_asset` releases a published asset for outsiders (link `https://app.trommi.com/a/<share_id>#<secret>.<file_key>.<sha256>`, at most 30 days; `release: false` and `revoke_asset` end it). **Child sessions for subagents:** `open_session { name, task?, icon?, model? }` opens (or finds) a child session under this agent's session; `reply`, `create_decision`, `create_info`, `merge_cards`, `set_status`, `clear_status`, `introduce`, `list_cards` and `publish_asset` take an optional `session` (the helper's name, case-insensitive; opened on first use). Card tools (`revise_card`, `close_card`, …) follow the card's own session. Events from a child carry meta `session="<name>"`. The names are kept in the slot's state (`channel.children`) and found again from the child's profile, so a restart writes into the same child. Not ported yet: `create_voiceover`, `adopt_session` (a separate helper process names its main with `introduce` `parent`), silent `publish_asset`. Tests: `node connector/channel-test.mjs`.

**Connector updates.** The connector is a shell (`channel.mjs`, `channel-lock.mjs`, `reload.mjs` and `core/`: stdio, MCP server, key, lease, stream) and code (`channel-tools.mjs`, `channel-bridge.mjs`, `richhtml.mjs`: tools, instructions, bridge). It compares the hashes of both parts on disk with the loaded ones (`fs.watch` and every 60 s, `TROMMI_UPDATE_POLL_MS`) and asks the hub's `GET /v1/version` hourly for `recommended_client_versions.channel`; a `426` stays `upgrade_required`. A new version reaches Claude as `<channel kind="update" update_available="1" version="…" restart_required="0|1">` and once more as a hint under the next tool result. The instructions tell Claude to file a decision card "Neue Connector-Version … – jetzt neu laden?" (jetzt / später). On "jetzt" Claude calls `reload_connector`: the code part is imported again as `./<file>?v=<hash>` (a resolve hook carries the version to its siblings), the bridge is rebuilt on the same client and state, and `notifications/tools/list_changed` goes out (`tools: { listChanged: true }`); session, key, lease and stream stay. A change of the shell needs a real restart, and the card says so: in the terminal `/mcp` → trommi → Reconnect. Tests: `connector/channel-test.mjs` ("update: …").

**Links for people outside the room (`share_asset`).** The agent draws a 32-byte `share_secret` and registers `POST /v1/rooms/:room_id/attachments/:attachment_id/shares { share_id (32 hex, random), share_secret_hash (b64u SHA-256 of the secret), expires_at (≤ 30 days) }` → `201 { share_id, expires_at }` (uploader only). The link is `https://app.trommi.com/a/<share_id>#<share_secret>.<file_key>.<sha256>`; everything after `#` stays in the browser. The viewer page calls `GET /v1/shares/:share_id` with header `x-share-secret: <b64u secret>` (no sign-in, 60 per minute per address, `Range` supported, `cache-control: private, no-store`); a missing share, a wrong secret and an expired share all answer `404 not-found`. The page decrypts with `decryptAsset` and shows it sandboxed. Revoke: `DELETE /v1/rooms/:room_id/attachments/:attachment_id/shares/:share_id` (the creator or a human device) → `{ ok }`. Table `shares`: `share_id`, `room_id`, `attachment_id`, `share_secret_hash`, `expires_at`, `created_by_device_id`, `created_at`. The hub never holds the file key.

### Founding and joining, in short

1. **Found ("Create account" in the app):** the app makes device keys, a recovery code and key epoch 1; `POST /v1/rooms`; then `challenge` → `access_tokens`; then `POST account` (email, the code sealed under the password). The code itself is no longer shown: the password and the Emergency Kit open it.
2. **Invite** (human or agent): `createInvite` → `POST invites`; the link `https://app.trommi.com/join#v1.<hub>.<room>.<secret>` leaves the device by the human's hands. The secret never reaches a server.
3. **Join:** the newcomer `GET invites/:invite_id` (checks the list against the room id in the link) → `POST requests` → polls `status`. The inviter gets `join_request` → `GET requests` → checks the MAC → `POST reveal`. Both show the six-digit check code (a human types it on the inviting device; an agent needs none) → the inviter `POST members` with the add entry and, for a human, the sealed room key → the newcomer sees `joined`, verifies, opens its key, signs in.
4. **Remove:** any human device: `removeMembers` → `POST members` with the new key epoch sealed for everyone who stays, and the back link. The hub cuts the removed device off.
5. **Recover:** with the code: sign in as the recovery key → `GET members`, `GET sealed_room_keys` → `recoverRoom` → `POST members`.

### Performance

Measured on 4 October 2026 with real E2E members (`dev/e2e/`, method and all tables in `docs/perf-night.md`). "local" is the real hub code on the PC with server metrics. "live" is hub.trommi.com measured from outside: its metrics port and test key are not enabled yet.

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
| App, same room, phone (CPU 4×) | v1.1: first load 3.4 s; opening a session, switching sessions, card threads, answers p95 290-580 ms (over budget); own message visible 44 ms (p95) |
| Open gaps | after a snapshot join no chat history is shown; local p99 about 1.1 s from about 800/s on current main (backpressure) |
