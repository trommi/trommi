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
| `device` | `Device<S: Storage>`, the one stateful object a client holds: `create`, `open`, `id`, `room`, `cursor`, `groups`, `content_key`; `key_packages_to_upload`, `key_package`; `found_room`, `found_session`, `found_helper`, `add_human_device`, `add_to_session`, `change_agents`, `remove_human_devices`, `clean_session`, `readmit_helper`, `update`, `archive`; `join_welcome`, `observe_room`, `observe_session`, `join_from_outside`; `process_log_entry`; `send_handover`, `send_stroke_piece`, `send_work_trail`, `send_recovery_auth`; `outbox`, `outbox_accepted`, `outbox_refused` | 3 to 7, 13 | built for groups and messages; envelopes, recovery and joining by link are being wired in |
| `mls::observer`, `mls::rules`, `mls::profile`, `mls::key_package` | following a group from its public messages, the rules on Commits shared by members and the hub, `TrommiRoom`, `TrommiSession`, `CommitNote`, `Cut`, KeyPackage checks | 3, 4, 5, 14 | built |
| `mls::message` | `TrommiMessage`: key handover, stroke piece, work trail, recovery auth | 7 | built |
| `recovery` | keys from the code, `SealedKey`, `RecoveryAuth`, `RecoveryLink`, the checks of joining with the code | 8 | planned |
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
log to `process_log_entry` in the hub's order.

## Building

`cargo test --workspace --locked` · `core/wasm/build.sh` · `core/swift/build.sh`. Compiler and targets:
`rust-toolchain.toml`. Dependencies and licences: [`THIRD-PARTY.md`](../THIRD-PARTY.md).
