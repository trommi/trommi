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
| `device` | `Device<S: Storage>`, the one stateful object a client holds: `create`, `open`, `is_owner`, `id`, `room`, `cursor`, `room_history`, `is_human`, `groups`, `group`, `content_key`; `key_packages_to_upload`, `key_package`, `key_package_info`; `found_room` (from a recovery code's keys), `found_session`, `found_helper`, `add_human_device`, `add_to_session`, `change_agents`, `remove_human_devices`, `clean_session`, `readmit_helper`, `update`, `archive`; `join_welcome` (`WelcomeExpectation` → `Joined`), `verify_founding`, `observe_room`, `observe_session`; with the recovery code: `join_room_with_code`, `join_session_with_code` (`CodeJoin`), `replace_code`, `recover`; `post_sealed_key`, `holds_recovery_mac`, `key_is_confirmed`; `process_log_entry` (`LogEntry`, `LogKind` → `Processed`: `Commit`, `OwnCommit`, `Observed`, `JoinSuperseded`, `Message(Received)`, `Skipped`; `Received`: `Keys`, `StrokePiece`, `WorkTrail`, `RecoveryAuth`, `Dropped`, `NewerVersion`), `log_finding` → `LogFinding`; `send_handover`, `handovers_sent`, `handover_read`, `send_stroke_piece`, `send_work_trail`, `send_recovery_auth`; `outbox`, `outbox_accepted`, `outbox_refused` | 3 to 7, 13 | built for groups, messages and recovery; envelopes and joining by link are being wired in |
| `mls::observer`, `mls::rules`, `mls::profile`, `mls::key_package` | following a group from its public messages (`Observer`: `follow_room`, `follow_session`, `found_room`, `found_session`, `follow_founding`, `fork`, `check_posted_commit`, `process_commit`, `check_group_info`, `group_info_signer`, `disallowed_leaves`, `load`, `take_changes`; `PostedCommit`, `Context`, `NoSessions`), the rules on Commits shared by members and the hub (`CommitFacts`, `RoomState`, `RoomHistory`, `Verifier`, `Judged`, `SessionBefore`, `SessionFacts`, `Parent`, `RecoveryRules` with `JoinClaim` and `SealedKeyClaim`, `NoRecovery`; `check_room_commit`, `check_session_commit`, `check_room_founding`, `disallowed_leaves`, `helper_devices`), `TrommiRoom`, `TrommiSession`, `CommitNote`, `Cut`, the limits of section 16, KeyPackage checks (`verify_key_package`, `verify_key_package_of`, `KeyPackageInfo`) | 3, 4, 5, 14 | built |
| `mls::message` | `TrommiMessage`: key handover, stroke piece, work trail, recovery auth | 7 | built |
| `recovery` | `RecoveryKeys` (from a code; `public`, `authorise`, `replace`, `finish`), `SealedKey`, `RecoveryJoin`, `RecoveryAuth`, `RecoveryLink`, `OldRecovery`, `MacKeys`; the public checks of members and the hub (`PublicRules`, `check_posted_row`); what a device with the code makes of what a hub serves (`ServedRoom`, `check_room`, `check_session`, `select_anchor`, `check_agreement`, `open_links`, `select_keys`, `removals`); the rule of a `recovery_auth` message (`take_recovery_auth`) | 7.4, 8 | built |
| `envelope`, `chain`, `objects`, `registers`, `board` | the stored-content envelope (`Draft`, `Envelope`), per-sender chains and the receiver's checks (`seal_next`, `receive`, `hub_take`, `provisional`, `heads`), object state and the command gate (`judge`, `replay`, `command_gate`), registers, Scribble Board loading (`verify_load`); group facts come in through `chain::GroupFacts` | 9, 10 | built; being wired into `device` |
| `board_items`, `trail` | Scribble Board item bodies, packed points, the merge of items (`Board::apply`), the snapshot file; the bodies of a work-trail step and a stroke piece (`WorkStep`, `StrokePiece`) | 7.2, 7.3, 10 | built |
| `files` | chunked file encryption (`Encryptor`, `Decryptor`, `encrypt_file`, `decrypt_file`, `open_chunk`, `Layout`), `FileRef`, `ShareLink` | 11 | built |
| `invite` | joining by link: `InviteLink`, `Inviter`, `Joiner`, `CheckCode`, `ConfirmedInvite`, the hub's checks | 12.1 | built |
| `hub_auth`, `push` | `HubAddress`, `HubAuth`, `sign`, `verify`; `ApnsPush`, `WebPush`, `seal`, `open` | 12.3, 15.2 | built |
| `account` | the account's sealed copies of the recovery code (password, Emergency Kit words, passkey), the code's display form | 8.8 | built |

**How a client uses it.** Open the device over its store (`Device::open`, one owner per stored state). Every
operation writes its new state and everything to send in one batch; nothing is handed back for sending except
through `outbox()`. Post each outbox entry, then report the hub's answer with `outbox_accepted` or
`outbox_refused`; after a restart the same entries are there again and are sent again unchanged. Feed the hub's
log to `process_log_entry` in the hub's order, each entry once: an entry at or below `cursor()` is a duplicate,
except the next Commit of a group the device holds or follows. Take a Welcome at its place in that order, with
the Commit that made it; one taken later is caught up by handing the group's entries again from that place.

What a client must expect of the device:

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

## Building

`cargo test --workspace --locked` · `core/wasm/build.sh` · `core/swift/build.sh`. Compiler and targets:
`rust-toolchain.toml`. Dependencies and licences: [`THIRD-PARTY.md`](../THIRD-PARTY.md).
