# The v2 hub: routes and tables

Short and normative for a hub and its clients; the rules a hub enforces are in [`v2.md`](v2.md) (sections 5, 8, 9,
12, 14). Every route is under `/v2/`. Bodies are JSON; byte strings are base64url; an MLS message, a GroupInfo, a
KeyPackage, an envelope and every struct of v2.md travel as their TLS-encoded bytes in one string. A refusal is
`{ "error": code, "message": text }` with the status of v2.md section 16. Every route but the first block needs
`authorization: Bearer <token>`; `Trommi-Client: <kind>/<major>.<minor>.<patch>` is sent always (`client-too-old`).
An id in a path is base64url; a 16-byte id may also be written as 32 hex digits (as timelines are). Where this file
leaves a body or a rule open, "Decided for the first hub" at the end says what the hub does.

## Routes

| Route | Body → answer | Notes |
| --- | --- | --- |
| **No token** | | |
| `POST /v2/account/login` · `/recover` · `/passkey/challenge` · `/passkey/login` | see "The account" below | answers with the account's `rooms` (a list; one for now) |
| `POST /v2/rooms` | `{ group_info, sealed_key, account? }` → `{ room_id }` | founding (5.1.1, 8.2); `room-exists`; `account`: the body of `POST /v2/account`, made in the same transaction |
| `GET /v2/rooms/{room}/challenge` | → `{ challenge }` | 12.3 |
| `POST /v2/rooms/{room}/tokens` | `{ auth, signature }` (`auth`: the `HubAuth` bytes) → `{ token, expires_at }` | 12.3; the challenge is used up |
| `GET /v2/invites/{invite_id}`, `POST …/request`, `GET …/reveal` | Offer; Request + mac + signature; Reveal | by `invite_id` only (12.1); 4 requests per invite |
| `GET /v2/shares/{share_id}` | header `x-share-secret` → the file's bytes (`Range` honoured) | 11.5; every refusal is the same `not-found` |
| `GET /v2/push-envelope?ticket=` | → one envelope | 15.2 |
| **Groups (MLS delivery service)** | | |
| `POST /v2/groups` | `{ group_info_0, sealed_key_0, commit, group_info, welcome?, sealed_key }` → `{ group_id }` | founding of a session group (5.2.5) |
| `POST /v2/groups/{group}/commits` | `{ epoch, commit, group_info, welcome?, sealed_key, recovery_auth? }` → `{ epoch, change }` | `epoch` = the epoch it builds on; `epoch-taken`, `room-behind`, `bad-commit`, `incomplete` |
| `POST /v2/rooms/{room}/recovery` → `{ recovery_id, expires_at }` · `POST …/recovery/{id}/commits` (a body as above with `group_id`, one per call) → `{ epoch, kept }` · `POST …/recovery/{id}/finish` (`{ recovery_link, account }`) → `{ published, first_change, change, device }` · `DELETE` | recovery key's token | 8.7: the room is locked for ten minutes; nothing is visible to others until `finish`, which publishes all or nothing |
| `POST /v2/rooms/{room}/recovery-code` | `{ epoch, commit, group_info, sealed_key, recovery_link, account }` → `{ epoch, change }` | 8.6: one room Commit, all or nothing; a human device |
| `POST /v2/groups/{group}/reject` | `{ n }` | 14.7 |
| `POST /v2/groups/{group}/archive` | | 5.2.10; human devices |
| `GET /v2/groups/{group}/log?after=&limit=&kind=commit` | → `{ items: [ { n, change, epoch, at, kind: "commit", bytes, recovery_auth? } \| { n, change, epoch, at, kind: "message", bytes } ], more }` | the ordered log (5.4.1, 7.0); `gone` when `after` is older than what is kept |
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
| `GET /v2/cards/{object}?after=&limit=` (and `/notes/`, `/permission-requests/`, `/artifacts/`) | → `{ items, more, state, owner, … }`: every envelope of the object | pruned ones in pruned form |
| `GET /v2/groups/{group}/chains/{sender}?after=&limit=` | → envelopes in pruned form, by `seq` | chain checks (9.0.5, 10.3) |
| `GET /v2/changes?after=&limit=` | → `{ items, change, more }` | catch-up: everything the asker may see with a change number above `after` |
| `GET /v2/stream?after=` | server-sent events: `envelope`, `log`, `relay`, `welcome`, `request`, `presence`, `file_evicted`, `ping` | live; resumes by change number (`after`, or `Last-Event-ID`) |
| **Files, shares, push, presence** | | |
| `PUT /v2/files/{file_id}` · `GET` (with `Range`) · `DELETE` | bytes | 11; `quota-exceeded` |
| `POST /v2/shares` · `DELETE /v2/shares/{share_id}` | `{ share_id, secret_hash, file_id, expires_at }` | 11.5 |
| `POST /v2/invites` · `PUT /v2/invites/{id}/reveal` · `DELETE` | Offer + signature; Reveal + signature | human devices |
| `POST /v2/push` · `GET` · `DELETE` | `{ web_push: { endpoint, keys: { p256dh, auth } } \| apns: { token, key, environment, topic }, level }`; `GET` → `{ subscriptions, vapid_public_key, apns }` | 15; human devices |
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
  envelopes, files and registers of the groups it is a leaf of (a file: while it is a leaf, v2.md 11.3; a file no
  envelope names yet: its uploader only); the recovery key what 8.4 to 8.7 need: the list of
  groups, every GroupInfo and Commit, the sealed keys and links, and envelopes in pruned form.
- A recovery (8.7) is a transaction of its own: each posted part advances a copy of the public state of the groups
  it touches, later parts are checked against that copy, every other reader sees the state from before. `finish`
  checks that the room group and every live session group were joined and cleaned, then publishes all parts under
  consecutive change numbers; repeated, it gives the same answer. At expiry or `DELETE` the copy is dropped.
- The log route gives a join from outside together with its `RecoveryAuth`. The chain route marks envelopes beyond
  a Cut `cut`. Nothing in a log is ever withdrawn.
- A repeated post of the same bytes gets the first answer again. Every read route serves a void record with its
  `void_code`.

## The account

v1 §16 says what the device derives; these are the routes. Byte strings are base64url. `sealed_copy` is 61 bytes
beginning with 0x02; `auth_key` is 32 bytes; `kdf` is the pinned record of v1 §16.6.

| Route | Body → answer | Notes |
| --- | --- | --- |
| `POST /v2/account` | `{ email, user_handle?, kit: { auth_key, sealed_copy }, password?: { auth_key, sealed_copy, kdf }, passkey?: { attestation_object, client_data_json, sealed_copy, transports? } }` → the account | a human device of the room, or inside `POST /v2/rooms`; at least one way in; `user_handle` (v1 §16.7) comes with a passkey; `bad-email`, `account-exists`, `bad-passkey` |
| `GET /v2/account` | → `{ email, revision, has_password, kdf, password_copy, kit_copy, user_handle, passkeys: [ { credential_id, sealed_copy, … } ], rooms }` | a human device; no hash leaves the hub |
| `PUT /v2/account/password` · `PUT /v2/account/kit` | `{ auth_key, sealed_copy, kdf?, revision }` → `{ revision }` | `account-changed` when `revision` is not the current one |
| `POST /v2/account/passkeys/challenge` · `POST /v2/account/passkeys` · `DELETE /v2/account/passkeys/{credential_id}` | a passkey body as above | a human device; the challenge is for that account; `last-way-in` |
| `POST /v2/account/login` | `{ email, auth_key }` → `{ rooms: [ { room_id, sealed_copy, challenge } ], kdf }` | no token; `wrong-login` for an unknown e-mail and a wrong key alike, at one cost; `challenge` is a sign-in challenge of that room (12.3) |
| `POST /v2/account/recover` | `{ email, auth_key }` (the kit's) → the same with the kit's copy | `wrong-recovery` |
| `POST /v2/account/passkey/challenge` · `POST /v2/account/passkey/login` | → `{ challenge }` · `{ credential_id, authenticator_data, client_data_json, signature, user_handle? }` → as login | every failure is `wrong-login` |

- The hub keeps a slow hash (Argon2id) of each login key, never the key. There is no account session: a login
  answers with sealed copies and sign-in challenges, and the device signs in to the room with the recovery key
  (8.4).
- With new recovery keys (8.6, 8.7) `account` is `{ kit: { auth_key, sealed_copy }, password: { sealed_copy } }` or
  `{ kit, passkey: { credential_id, sealed_copy } }`: the copy under the way in used just now and a new kit; every
  other way in is removed in the same transaction. A room without an account sends `null`.
- Sign-up is instant: there is no e-mail confirmation and the hub sends no mail (owner, 9 October 2026). Signing
  up with an e-mail that has an account is `account-exists`.
- **Failed logins slow down whoever guesses wrong and lock nobody** (owner, 9 October 2026). The source is the
  client's address (the forwarded one only when the hub is configured to trust its proxy, and only if it is an
  address). Per source and e-mail: after each failure that source waits 1 s, 2 s, 4 s … up to 15 minutes before
  its next attempt at that e-mail (`rate-limited` with `retry-after`); a success ends it. That is at most 13
  guesses in the first hour and 4 an hour after, per source and account. Per account: 100 attempts an hour from
  sources that never signed in to it; past that, such sources are served one every two seconds in the order they
  came (each is told its turn by `retry-after` and is checked when it comes back then): at most 1 900 guesses an
  hour per account from unknown sources, however many they are. A source the account knows (one of the last 16
  it was signed in to from; the hub keeps a keyed hash, not the address) is never put in that line, and a
  correct credential is never refused on account of others: it is checked at once, or in its turn. The password
  and the Emergency Kit are counted apart; an e-mail without an account behaves the same. One answer and one
  cost for every failure, as before.
- Other limits: 30 logins per address in ten minutes; 20 passkeys per account. A passkey challenge of an account
  is bound to the account's revision.

## Decided for the first hub

Where v2.md or this file left room, the hub does the following. None of it changes a byte that is signed or
encrypted.

**Delivery service**

1. A Commit's `SealedKey` names the note's `room_epoch`; in the room group it is sealed to the recovery key the
   room has after the Commit, in a session group to the room's current one. A human writer sets `mac` (32 bytes),
   another writer leaves it empty; the hub checks the length, it cannot check the tag.
2. A main session is founded with exactly one agent device (5.2.5). A helper session keeps its opener: it is
   stale also while it lacks the opener its main session has now. While the main session has no agent leaf, human
   devices only add human devices and remove the leaves the room's state does not allow (a recovery may remove
   human devices).
3. A join from outside may enter a stale group, which stays stale (8.4); every other Commit in a stale group must
   leave it not stale, and only a human device repairs one.
4. A key has one role in a room for ever (human, agent or helper device). A recovery key is never a key that has
   or had a role, and no device comes in under the room's recovery signature key.
5. A key that left a group is added to it again only if nothing it wrote lies beyond its Cut (3.7: the device
   whose Welcome failed); its chain goes on where it was cut.
6. One room Commit holds at most one Add. New recovery keys are taken only on `…/recovery-code` or in a recovery;
   on `…/commits` they are `incomplete`.
7. An archived group answers every write with `gone` (410); an envelope for it takes no chain number. Archiving
   again, and a repeated post of what was accepted before, get their first answer.
8. A removed device's token is answered `not-member` until it runs out; its streams end with the Commit.
9. Every write of an agent device except `POST /v2/link` carries `Trommi-Lease`.
10. `GET …/log?kind=commit` gives the Commits alone, for any reader; application messages are deleted after 30
    days and leave holes in `n`, Commits never. `GET …/info?epoch=0` is kept as long as the group is.
11. A Welcome is deleted when its device first writes in the group or leaves it. Requests: a device keeps its 16
    newest for seven days; a `reject` (14.7) is a leaf's and appears among them with its `committer`.
12. A single-use KeyPackage that was handed out is never handed out again, also when it is uploaded again (its
    reference is kept for good). A claim
    names a device once. A helper device claims none. Leaves and KeyPackages carry exactly the capabilities of
    v2.md section 3; a GroupInfo is at most 96 KiB.
13. A repeated post of the same bytes gets the first answer for: a founding, a Commit, an application message, an
    envelope, a SealedKey, a file, an Offer, a Reveal, a share. A claim of KeyPackages is not repeatable.

**Recovery**

14. While a recovery is open every other write to the room is answered `overloaded` (503) with `retry-after`;
    an agent's lease renewal is still taken. A recovery has at most 8 192 parts and 64 MiB; each is checked
    against the state the parts before it leave (those of the room group, of its own group and of its main
    session's group); the same part twice is kept once; its last part is the room Commit with the new
    recovery keys. The recovery key that ran a finished recovery may ask for the answer of that `finish` again
    until the ten minutes are over, and for nothing else.

**Content**

15. An object begins open. Answers and take backs are for cards, verdicts for permission requests.
16. A human device's Chat message is addressed to the session's agent device (helper session: its opener), or to
    zeros while there is none.
17. A file id in a header that the hub holds no file for claims nothing. The object of a Chat message on
    `card/<X>` is X, for its files. A deleted file's id is never used again (`gone`).
18. A register's body is at most 8 KiB padded (9.3.5).

**Reading**

19. `GET /v2/changes` items: `{ change, kind: "commit" | "message", group_id, n, epoch, at, bytes, sender,
    recovery_auth? }` and `{ change, kind: "envelope", envelope, received_at, void_code? }`, ascending by
    `change`; the answer's `change` is the cursor for the next call. Change numbers are given to Commits,
    messages, envelopes, SealedKeys and RecoveryLinks; sealed keys are read on their own route; invites, requests,
    Welcomes, files and shares are read by their own routes and announced live.
20. `GET /v2/stream` events: `envelope` and `log` carry the item of `/v2/changes` and its change number as the
    event id; `relay` `{ group_id, epoch, sender, message }`; `welcome` `{ group_id }`; `request`; `presence`
    `{ device, online, hears?, working?, last_call_at? }`; `file_evicted` `{ file_id }`. Events without a change
    number are not replayed.
21. A void record and an envelope beyond a Cut are served in pruned form; the latter only on the chain route,
    marked `cut` (not by a push ticket either). What a Cut cannot bring back stays as it is: the files of an
    Artifact whose closing version was cut are deleted.
22. An answer holds at most 8 MiB of envelopes: the list routes say `more`, the Desk `truncated` (then the rest
    comes by `/v2/changes`). A stream ends when the token it was opened with runs out, and the device resumes
    with a new one by change number.
23. `epoch-full` counts the accepted envelopes of a group and epoch. An envelope whose ciphertext is not a
    padded size of 9 is `bad-format` and takes no number; `too-large` is the void of a register over its size.

**Operations**

24. `GET /healthz` (outside `/v2/`, for the container) answers `{ ok, commit, protocol_version }`.
    Founding a room is open to anyone, ten an hour per address (owner, 9 October 2026). A hub can be set
    otherwise: `HUB_FOUND_TOKEN` (unset by default) must then come as `x-found-token`; `HUB_FOUNDING=closed`
    founds none.
25. A Share link expires within 180 days (owner, 9 October 2026; v2.md 11.5 and section 16 follow on the core's
    branch). A room has at most 1 000 Share links, a device ten push registrations.
26. A Web Push carries a `Topic` (one waiting notification per room). The ticket of 15.2 is the hub's own
    `room ‖ device ‖ change ‖ expiry ‖ HMAC`; only the hub reads it. One device's envelopes cause at most ten
    pushes a minute (owner, 9 October 2026); a push service is called on port 443 and no redirect is followed.
27. Uploads in progress count against the room's quota; a room has at most 16 at a time.
29. **What a room may hold besides its files' bytes** (`hub/src/quota.rs`; counts of things ever made, since a
    deleted file's id, an archived group and a void record stay): 50 000 file ids, zero-byte and deleted ones too
    (`quota-exceeded`); 20 000 register ids (`too-many`, the envelope takes no number); 100 000 void records
    (past that, a refusal that would be a void comes without `voided` and uses no number); 5 000 groups,
    archived ones too (`too-many`); 10 000 helper devices ever seen (`too-many`). Nothing is deleted to make
    room.
30. **Busy.** Verifying a Commit or a GroupInfo, validating KeyPackages and the slow hash of a login key run on a
    bounded pool outside the database's write lock; the write then takes their result only if the group, the
    asker's standing and the account stand where they stood, else it answers `overloaded` (503) with
    `retry-after` and the client sends the same bytes again. The same answer when the pool's queue or the hub's
    number of requests at work (256) is full. One device makes at most ten such requests a second (bursts of
    60, `rate-limited`).
31. An agent's lease that ran out is noticed by a timer, not by its stream closing: it no longer counts as
    working, and after a further minute without a stream the human devices are told once ("An agent lost its
    connection.", `presence` with `lost`).
32. `GET /v2/changes` looks at most 20 000 change numbers ahead per call; `more` says that the cursor has not
    reached the room's newest change.
28. Codes beside v2.md section 16: `account-changed` (409), `bad-email`, `bad-passkey` (400), `range` (416).
