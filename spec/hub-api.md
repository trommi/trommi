# The v2 hub: routes and tables

Short and normative for a hub and its clients; the rules a hub enforces are in [`v2.md`](v2.md) (sections 5, 8, 9,
12, 14). Every route is under `/v2/`. Bodies are JSON; byte strings are base64url; an MLS message, a GroupInfo, a
KeyPackage, an envelope and every struct of v2.md travel as their TLS-encoded bytes in one string. A refusal is
`{ "error": code, "message": text }` with the status of v2.md section 16. Every route but the first block needs
`authorization: Bearer <token>`; `Trommi-Client: <version>` is sent always (`client-too-old`).

## Routes

| Route | Body → answer | Notes |
| --- | --- | --- |
| **No token** | | |
| `POST /v2/account/…` | sign-up, login, passkeys, the sealed copies: v1 §16 and the old hub's "Accounts", moved under `/v2/` | answers with the account's `rooms` (a list; one for now) |
| `POST /v2/rooms` | `{ group_info, sealed_key, account }` → `{ room_id }` | founding (5.1.1, 8.2); `room-exists` |
| `GET /v2/rooms/{room}/challenge` | → `{ challenge }` | 12.3 |
| `POST /v2/rooms/{room}/tokens` | `{ auth, signature }` (`auth`: the `HubAuth` bytes) → `{ token, expires_at }` | 12.3; the challenge is used up |
| `GET /v2/invites/{invite_id}`, `POST …/request`, `GET …/reveal` | Offer; Request + mac + signature; Reveal | by `invite_id` only (12.1); 4 requests per invite |
| `GET /v2/shares/{share_id}` | header `x-share-secret` → the file's bytes (`Range` honoured) | 11.5 |
| `GET /v2/push-envelope?ticket=` | → one envelope | 15.2 |
| **Groups (MLS delivery service)** | | |
| `POST /v2/groups` | `{ group_info_0, sealed_key_0, commit, group_info, welcome?, sealed_key }` → `{ group_id }` | founding of a session group (5.2.5) |
| `POST /v2/groups/{group}/commits` | `{ epoch, commit, group_info, welcome?, sealed_key, recovery_auth? }` → `{ epoch, change }` | `epoch` = the epoch it builds on; `epoch-taken`, `room-behind`, `bad-commit`, `incomplete` |
| `POST /v2/rooms/{room}/recovery` → `{ recovery_id, expires_at }` · `POST …/recovery/{id}/commits` (a body as above, one per call) · `POST …/recovery/{id}/finish` (`{ recovery_link, account }`) · `DELETE` | recovery key's token | 8.7: the room is locked for ten minutes; nothing is visible to others until `finish`, which publishes all or nothing |
| `POST /v2/rooms/{room}/recovery-code` | `{ commit bodies as above, recovery_link, account }` | 8.6: all or nothing |
| `POST /v2/groups/{group}/reject` | `{ n }` | 14.7 |
| `POST /v2/groups/{group}/archive` | | 5.2.10; human devices |
| `GET /v2/groups/{group}/log?after=&limit=` | → `{ items: [ { n, change, epoch, at, kind: "commit", bytes, recovery_auth? } \| { n, change, epoch, at, kind: "message", bytes } ], more }` | the ordered log (5.4.1, 7.0); `gone` when `after` is older than what is kept |
| `POST /v2/groups/{group}/messages` | `{ epoch, message, relay? }` → `{ n }` | application message; `relay: true`: passed on, not stored (7.2); `wrong-epoch` |
| `GET /v2/groups/{group}/info?epoch=` | → `{ epoch, group_info }` | current, and epoch 0 (the founding) of every group; for the room group every epoch is kept |
| `GET /v2/welcomes` | → `[ { group_id, welcome, at } ]` | for the asking device; deleted when it has joined |
| `PUT /v2/key-packages` | `{ single_use: [..], last_resort? }` → `{ unused }` | 14.2; `bad-key-package` |
| `POST /v2/key-packages/claim` | `{ devices: [..] }` → `{ key_packages: { device: bytes } }` | one each, all or nothing; the last-resort one when none is left; none uploaded more than 90 days ago |
| `GET /v2/rooms/{room}/groups` | → `[ { group_id, kind, session_id, parent, epoch, live, stale, leaves } ]` | what the asker may see: a human device all, another device its own groups and the room group |
| `PUT /v2/sealed-keys` · `GET /v2/sealed-keys?after=` | `SealedKey` · → `{ rows, links, more }` | 8.3; reading: human devices and the recovery key |
| `POST /v2/requests` · `GET /v2/requests` | `{ kind: readmit \| handover \| session, group?, key_package? }` | an unsigned wish of the signed-in device to the human devices (5.2.7, 5.3.5, 7.1, 13.4); nothing follows from it without a Commit |
| **Content** | | |
| `POST /v2/envelopes` | `{ envelope }` → `{ change }` or a refusal with `voided` | every stored item (9); the hub files it by its header |
| `GET /v2/desk` | → `{ cards, permission_requests, notes, artifacts, registers, groups, change }` | open objects' newest envelopes, every writer's newest value per register, in the asker's groups |
| `GET /v2/chats/{timeline}/items?before=&limit=` | → envelopes, newest first | `timeline` = `session/<hex>` or `card/<hex>` |
| `GET /v2/boards/{board}?after_change=` | → `{ items, more }` | the board's items after the given change (10.3) |
| `GET /v2/cards/{object}` (and `/notes/`, `/permission-requests/`, `/artifacts/`) | → every envelope of the object | pruned ones in pruned form |
| `GET /v2/groups/{group}/chains/{sender}?after=&limit=` | → envelopes in pruned form, by `seq` | chain checks (9.0.5, 10.3) |
| `GET /v2/changes?after=&limit=` | → `{ items, change, more }` | catch-up: everything the asker may see with a change number above `after` |
| `GET /v2/stream?after=` | server-sent events: `envelope`, `log` (group, n), `relay`, `welcome`, `request`, `presence`, `file_evicted` | live; resumes by change number |
| **Files, shares, push, presence** | | |
| `PUT /v2/files/{file_id}` · `GET` (with `Range`) · `DELETE` | bytes | 11; `quota-exceeded` |
| `POST /v2/shares` · `DELETE /v2/shares/{share_id}` | `{ share_id, secret_hash, file_id, expires_at }` | 11.5 |
| `POST /v2/invites` · `PUT /v2/invites/{id}/reveal` · `DELETE` | Offer + signature; Reveal + signature | human devices |
| `POST /v2/push` · `GET` · `DELETE` | `{ web_push \| apns, level }` | 15 |
| `POST /v2/live-activity` | `{ kind: start \| activity, token, tag, environment, topic }` | 15.3 |
| `POST /v2/link` | `{ process, generation?, hears, working, last_call_at }` → `{ generation, expires_at }` | 13.7; every later write of that device carries `Trommi-Lease: <generation>` (`lease-lost`) |

## Tables

`change` is one counter per room; every stored row that a client can fetch carries the change at which it was last
written. Catch-up is "everything above N".

| Table | Columns the hub reads | Ciphertext | Index for |
| --- | --- | --- | --- |
| `accounts`, `passkeys`, `account_rooms` | e-mail, login hashes, KDF record, passkey public keys; account → room | sealed copies of the code | login by e-mail |
| `rooms` | `room_id`, `founded_at`, `change` | | |
| `devices` | `room_id`, `device`, `role` (human, agent, helper), `added_epoch`, `removed_epoch`, per group the Cut | | role checks; "never returns" (4.2) |
| `key_packages` | `device`, `ref`, `last_resort`, `expires_at`, `bytes` | | claim: (`device`, `last_resort`, oldest) |
| `groups` | `group_id`, `room_id`, `kind` (room, main, helper), `session_id`, `parent`, `epoch`, `room_epoch`, `live`, `archived_at`, `log_n`, the serialised public group | | by room |
| `group_log` | `group_id`, `n`, `epoch`, `kind`, `bytes` (a Commit: readable; a message: opaque), `sender` (the posting device), `at`, `change` | messages | **catch up a group**: (`group_id`, `n`) |
| `group_infos` | `group_id`, `epoch`, `bytes` | | current; room group: all |
| `welcomes` | `device`, `group_id`, `at` | `bytes` | by device |
| `sealed_keys`, `recovery_links` | `group_id`, `epoch`, `writer`, `recovery_hpke_key` | `sealed` | (`room_id`, `change`) |
| `envelopes` | `change`, `group_id`, `epoch`, `sender`, `seq`, `prev`, `hash`, `recipient`, `kind`, `flags`, `time`, `received_at`, `timeline` (kind, scope, ref), `object_id`, `object_type`, `object_state`, `urgency`, `answered_at`, `object_ref`, `register_id`, `file_ids`, `padded_size`, `header`, `nonce`, `body_hash`, `signature`, `void_code` | `body` (null once pruned) | truth for all stored content. **Chain**: unique (`group_id`, `sender`, `seq`). **Catch-up**: (`room_id`, `change`). **Page a chat, load a board**: (`timeline`, `change`) |
| `cards`, `notes`, `permission_requests`, `artifacts` | `object_id`, `group_id`, `state`, `urgency`, `answered_at`, `owner`, `first_change`, `head_change`, `closed_at` | | **the Desk**: partial index on `state = open` by (`urgency` desc, `first_change`). Derived from `envelopes`, rebuildable |
| `chats`, `boards` | `timeline`, `group_id`, `item_count`, `last_change` | | derived |
| `registers` | `group_id`, `writer`, `register_id`, `head_change` | | **all current values**: (`group_id`); derived |
| `files` | `file_id`, `room_id`, `uploader`, `object_id`, `size`, `stored_at`, `referenced_at` | bytes beside the database | by object; pending uploads by `stored_at` |
| `shares` | `share_id`, `file_id`, `secret_hash`, `expires_at`, `created_by` | | by id |
| `invites`, `invite_requests` | signed Offer, Requests, Reveal, `expires_at`, `used_at`, `burned_at` | | by `invite_id` |
| `requests` | `room_id`, `device`, `kind`, `group_id`, `at` | | by room |
| `push_subscriptions`, `live_activities` | endpoints, tokens, `level`, the counts last sent | | by device |
| `agent_leases` | `device`, `process`, `generation`, `expires_at` | | |

- The four object tables, `chats`, `boards` and `registers` are indexes over `envelopes`, written in the same
  transaction from signed header fields, and can be dropped and rebuilt. One write route, one truth table; the app's
  names are on what is read.
- Retention: `group_log` messages 30 days; Commits and the founding GroupInfo of a group as long as any envelope of
  it is kept (the room group: for ever); `envelopes.body` per v2.md 9.4; `welcomes` until joined; relay-only messages never.
- Who may read: a human device everything of its room; an agent or helper device the Commits and GroupInfo of the
  room group and, for a helper session, of its main session's group (public state only, no messages), and the log,
  envelopes, files and registers of the groups it is a leaf of; the recovery key what 8.4 to 8.7 need: the list of
  groups, every GroupInfo and Commit, the sealed keys and links, and envelopes in pruned form.
- A recovery (8.7) is a transaction of its own: each posted part advances a copy of the public state of the groups
  it touches, later parts are checked against that copy, every other reader sees the state from before. `finish`
  checks that the room group and every live session group were joined and cleaned, then publishes all parts under
  consecutive change numbers; repeated, it gives the same answer. At expiry or `DELETE` the copy is dropped.
- The log route gives a join from outside together with its `RecoveryAuth`. The chain route marks envelopes beyond
  a Cut `cut`. Nothing in a log is ever withdrawn.
- A repeated post of the same bytes gets the first answer again. Every read route serves a void record with its
  `void_code`.
