# trommi-core

The one implementation of Trommi's protocol ([`spec/v2.md`](../spec/v2.md)) on OpenMLS, used by the web app
(WASM, `core/wasm`), the iOS app (UniFFI, `core/swift`), the connector (Rust) and the hub (as observer).
Production code only; every scenario, conformance and vector test lives in [`tests/`](../tests) at the repository
root.

## API at a glance

Bytes, ids and plain structs cross the edge; no OpenMLS type does. Every call that needs time takes `now_ms`.
The full text of every call is its doc comment (`cargo doc -p trommi-core --open`). The interface grows by
adding; what exists is kept.

| Module | What it gives | Spec | State |
| --- | --- | --- | --- |
| `error` | `Error`, one variant per stable code; `code()`, `from_code()` | 16 | built |
| `ids` | `DeviceId`, `RoomId`, `SessionId`, `GroupId`, `Hash32`, `ObjectId`, `FileId`, `RegisterId`, `BoardId`, `InviteId`, `ShareId`, `TurnId`; strict base64url | 2, 3.2 | built |
| `codec` | TLS presentation encoding: `Writer`, `Reader`, `encode`, strict `decode` | 2 | built |
| `crypto` | `ref_hash`, `expand_with_label`, `sign_with_label`, `verify_with_label`, `encrypt_with_label`, `decrypt_with_label`, `aead_seal`, `aead_open`, `hmac_sha256`, `sha256`; `Secret<N>`, `SigningKey`, `Entropy`, `SystemEntropy` | 2, 3 | built |
| `store` | `Storage` (`load`, `apply(expected_revision, batch)`: all or nothing, durable on return, one owner), `Entry`, `Batch`, `OutboxEntry`, `OutboxKind` | 13.2 | built |
| `device` | `Device<S: Storage>`, the one stateful object a client holds: `create`, `open`, `is_owner`, `id`, `room`, `cursor`, `room_history`, `is_human`, `groups`, `group`, `content_key`; `key_packages_to_upload`, `key_package`, `key_package_info`; `found_room` (from a recovery code's keys), `found_session`, `found_helper`, `add_to_session`, `remove_agents`, `remove_human_devices`, `clean_session`, `readmit_helper`, `update`, `archive`; `join_welcome` (`WelcomeExpectation` → `Joined`), `verify_founding`, `observe_room`, `observe_session`; with the recovery code: `join_room_with_code`, `join_session_with_code` (`CodeJoin`), `replace_code`, `recover`; `post_sealed_key`, `holds_recovery_mac`, `key_is_confirmed`; `process_log_entry` (`LogEntry`, `LogKind` → `Processed`: `Commit`, `OwnCommit`, `Observed`, `JoinSuperseded`, `Message(Received)`, `Skipped`; `Received`: `Keys`, `StrokePiece`, `WorkTrail`, `RecoveryAuth`, `Dropped`, `NewerVersion`), `log_finding` → `LogFinding`; `send_handover`, `handovers_sent`, `handover_read`, `send_stroke_piece`, `send_work_trail`, `send_recovery_auth`; `outbox`, `outbox_accepted`, `outbox_refused`, `refusal_is_passing`. Stored content: `seal` (`Draft` → `Sealed`), `outbox_voided`, `envelope_abandon`, `receive_relay`, `receive_envelope` (→ `ReceivedEnvelope`: `EnvelopeOutcome` `Applied`, `Chained`, `Void`, `Provisional`, `Refused`; `Confirmation`, `RegisterChange`), `heads_due`, `compare_heads`, `cut_of`, `chain_head`, `chain_cut`, `object`, `objects`, `object_owner`, `register`, `register_of`, `findings`, `findings_read`; the command gate `command`, `command_finished`, `commands_pending`, `commands_uncertain`; the Scribble Board `board_load`, `board_reduce` (`BoardItem`, `BoardSnapshot`). Joining by link: `invite_open`, `invite_accept`, `invite_confirm`, `invite_steps` (`InviteStep`), `invite_recommit`, `invite_handover`, `invite_forget`, `invite_checked`; `join_request`, `join_reveal`, `join_invited`, `join_observe`; `hub_sign_in`. Only under the cargo feature `vectors`, for tests: `add_human_device`, `change_agents` | 3 to 7, 9, 10, 12, 13 | built; a device holds a group's epochs from the one it joined at (an envelope of an earlier epoch is `group-behind`) |
| `mls::observer`, `mls::rules`, `mls::profile`, `mls::key_package` | following a group from its public messages (`Observer`: `follow_room`, `follow_session`, `found_room`, `found_session`, `follow_founding`, `fork`, `check_posted_commit`, `process_commit`, `check_group_info`, `group_info_signer`, `disallowed_leaves`, `load`, `take_changes`; `PostedCommit`, `Context`, `NoSessions`), the rules on Commits shared by members and the hub (`CommitFacts`, `RoomState`, `RoomHistory`, `Verifier`, `Judged`, `SessionBefore`, `SessionFacts`, `Parent`, `RecoveryRules` with `JoinClaim` and `SealedKeyClaim`, `NoRecovery`; `check_room_commit`, `check_session_commit`, `check_room_founding`, `disallowed_leaves`, `helper_devices`), `TrommiRoom`, `TrommiSession`, `CommitNote`, `Cut`, the limits of section 16, KeyPackage checks (`verify_key_package`, `verify_key_package_of`, `KeyPackageInfo`) | 3, 4, 5, 14 | built |
| `mls::message` | `TrommiMessage`: key handover, stroke piece, work trail, recovery auth | 7 | built |
| `recovery` | `RecoveryKeys` (from a code; `public`, `authorise`, `replace`, `finish`), `SealedKey`, `RecoveryJoin`, `RecoveryAuth`, `RecoveryLink`, `OldRecovery`, `MacKeys`; the public checks of members and the hub (`PublicRules`, `check_posted_row`); what a device with the code makes of what a hub serves (`ServedRoom`, `check_room`, `check_session`, `select_anchor`, `check_agreement`, `open_links`, `select_keys`, `removals`); the rule of a `recovery_auth` message (`take_recovery_auth`) | 7.4, 8 | built |
| `envelope`, `chain`, `objects`, `registers`, `board` | the stored-content envelope (`Draft`, `Envelope`), per-sender chains and the receiver's checks (`seal_next`, `receive`, `hub_take`, `provisional`, `heads`), object state and the command gate (`judge`, `replay`, `command_gate`), registers, Scribble Board loading (`verify_load`); group facts come in through `chain::GroupFacts` | 9, 10 | built |
| `board_items`, `trail` | Scribble Board item bodies, packed points, the merge of items (`Board::apply`), the snapshot file; the bodies of a work-trail step and a stroke piece (`WorkStep`, `StrokePiece`) | 7.2, 7.3, 10 | built |
| `files` | chunked file encryption (`Encryptor`, `Decryptor`, `encrypt_file`, `decrypt_file`, `open_chunk`, `Layout`), `FileRef`, `ShareLink` | 11 | built |
| `invite` | joining by link: `InviteLink`, `Inviter`, `Joiner`, `CheckCode`, `ConfirmedInvite`, the hub's checks | 12.1 | built |
| `hub_auth`, `push` | `HubAddress`, `HubAuth`, `sign`, `verify`; `ApnsPush`, `WebPush`, `seal`, `open` | 12.3, 15.2 | built |
| `account` | the account's sealed copies of the recovery code (password, Emergency Kit words, passkey), the code's display form | 8.8 | built |

**How a client uses it.** Open the device over its store (`Device::open`, one owner per stored state). Every
operation writes its new state and everything to send in one batch; nothing is handed back for sending except
through `outbox()`. Post each outbox entry, then report the hub's answer with `outbox_accepted` or
`outbox_refused`; after a restart the same entries are there again and are sent again unchanged. An accepted
Commit is not merged by the answer: it stays pending, the group stands in its old epoch (`busy` for more), and
the Commit is merged when `process_log_entry` is handed it, at its place in the hub's order. Feed the hub's
log to `process_log_entry` in the hub's order, across groups, each entry once: an entry at or below `cursor()`
is a duplicate. Take a Welcome at its place in that order and hand the Commit that made it again after joining:
it gives the join its place. A Welcome taken later is caught up by handing the group's entries again from that
Commit on; nothing else is taken behind the cursor but the device's own pending Commit. A session Commit must
name the room epoch that was current at its change number, so the room group's log is processed up to there
first (`room-behind`). A helper session is joined, judged and written only by a device that is a leaf of its
main session or follows it (`observe_session`): `room-behind` until then.

**Stored content.** `seal` signs the device's next envelope in a group and writes it into the outbox with the
advanced chain; what it does to the device's own view happens when it comes back from the hub. Hand every
envelope to `receive_envelope` with the hub's change number: above `cursor()` in the hub's order, among the
entries of the log (one cursor for both); at or below it along its sender's chain; `ordered: false` for one
fetched out of order, which is at most provisional. An agent or helper device acts on an envelope only after
`command` answered `Act`, and calls `command_finished` afterwards. Without state, for a binding to list:
`invite::InviteLink::parse`, `invite::CHECK_EMOJI`, `hub_auth::HubAddress::parse`, `device::board_reduce`,
`board::verify_load`.

What a client must expect of the device:

- An envelope the hub refused with `voided: true` is reported with `outbox_voided`; refused otherwise it stays in
  the outbox and is sent again unchanged, since the device signs no second envelope under a number
  (`envelope_abandon` gives it up, and with it writing in that group, unless the hub holds it after all).
- A refusal that does not judge the request (`refusal_is_passing`) leaves any entry in the outbox.
- `ReceivedEnvelope::replayed` says that the group's objects and registers were built again (an envelope came
  behind later ones): read them again. A Cut does the same when a Commit is processed; `chain_cut` names
  where a removed device's chain ends, and `findings` what was found on the way.
- A human device is added, and an agent device enrolled, only by `invite_confirm`, which takes the code and
  request hash the person confirmed; `invite_steps` lists everything that is left, from the state of the groups
  (so also after a restart), until the invite is finished.

- A write that meets another owner (`StorageError::Conflict`) ends this object: `is_owner()` is false, `outbox()`
  is empty and every operation returns the storage error, until the state is opened again.
- A Commit or a join from outside that the hub refuses with `epoch-taken` stays, out of `outbox()`, until the
  log shows the Commit that took the epoch: `Processed::OwnCommit` if it was the device's own, otherwise the
  outbox id comes back as `superseded` (`Processed::Commit`, `Processed::JoinSuperseded`) and the change is built
  again. While a Commit of a group is pending, sending a message in that group is `busy`.
- A device follows the room group either as a leaf or as an observer, never both: joining (Welcome or join from
  outside) takes the observer's record over, and a device that processes its own removal from the room group
  becomes an observer of it (`is_human()` false). A Welcome that is `room-behind` is taken again after the log;
  one into the room group for an epoch the observer has left behind is `wrong-epoch` and lost.
- A group that failed its first contact (`Joined::offending` not empty) hands out no key, opens no message
  (`Processed::Skipped`) and takes only the Commit that removes leaves.
- `Received::NewerVersion` and `Error::NewerVersion` are the finding `newer-version`: shown, never swallowed.

**With the recovery code.** The code is opened from the account's sealed copies (`account`) and turned into
`RecoveryKeys`; the caller holds them while it signs in, recovers or replaces the code, and drops them after:
the device keeps `recovery_mac` and nothing else of the code. To sign in, fetch the room group's founding
GroupInfo, its Commits, the current GroupInfo, the sealed rows and links (`ServedRoom`; `select_anchor` names
the epoch whose GroupInfo is the anchor's), call `join_room_with_code`, post, and then
`join_session_with_code` for each live session group, main sessions first. A join is built on a copy of the
state and replaces the real one only when the hub accepted it. To recover with every device lost, open the
recovery at the hub, fetch the same with every live session group, make the replacement
(`RecoveryKeys::replace`) and the account's new sealed copies, verify the chains of the devices that
`recovery::removals` names and hand their Cuts to `recover`: its outbox entries are the recovery's Commits and
its finish, and the device's state changes only when the hub accepted the finish.

## Changes a caller must follow

Newest first. The interface grows by adding; these are the additions that an exhaustive `match` or a caller's
assumptions have to take in.

- Joining by link: `invite_steps` takes `&mut self`, lists every step left (not only the next), and drops an
  invite with nothing left. `InviteStep::TakeOver::key_package` is an `Option`: `Some` for the main session (the
  confirmed Request's), `None` for a helper session, where a fresh KeyPackage of the agent device is claimed at
  the hub; a `TakeOver` without Cuts adds the new opener to a helper session that has none. `invite_forget`
  drops only the handovers. `invite_handover` sends the first `Handover` step. `hub_sign_in` works for a
  joining device once `join_reveal` returned the code (room and hub of the stored invite; another hub is
  `bad-invite`). A takeover ends with `InviteStep::CheckHelpers`, answered by `invite_checked` with the helper
  sessions the hub lists (5.3.1 c). The `recovery_mac` for a device added by link is no step: it is in the outbox once the Add
  was merged.
- Recovery is in the device: `Device::create(store, entropy)` and `Device::open(store, entropy)` take no third
  parameter; `found_room(&RecoveryKeys, now_ms)`; `send_recovery_auth(&recipient) -> Option<u64>`;
  `join_from_outside`, `DeviceRecovery`, `SealRequest`, `Authorise` are gone, replaced by
  `join_room_with_code`, `join_session_with_code`, `replace_code`, `recover`; `Received::RecoveryAuth` carries
  `new` instead of the key, and there is `Received::RecoveryAuthConflict`; `OutboxKind::RecoveryCommit` (11) and
  `RecoveryFinish` (12). A human device without the current `recovery_mac` gets `no-key` from every call that
  commits.
- `Received::NewerVersion`, `Processed::JoinSuperseded`, the field `CommitFacts::newer_version`; `Device::is_owner`,
  `mls::profile::MAX_STORED_EPOCH`, `mls::rules::helper_devices`.
- `process_log_entry` refuses an entry at or below the cursor (`wrong-epoch`), except the next Commit of a group
  the device holds back or follows.
- `join_welcome` can also return `too-large`, `too-many`, `room-behind`, `wrong-epoch`, `bad-group`.
- `Error::Busy` (code `busy`, local): a request on this group still waits for the hub; send the outbox, process
  the log, then call again.

## Building

`cargo test --workspace --locked` · `core/wasm/build.sh` · `core/swift/build.sh`. Compiler and targets:
`rust-toolchain.toml`. Dependencies and licences: [`THIRD-PARTY.md`](../THIRD-PARTY.md).
