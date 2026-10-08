# connector-rs

The Trommi connector (`connector/*.mjs`) rebuilt in Rust as one static binary, `trommi-connector`. The JS connector
stays in production until the switch; this one opens the same key slots and speaks the same protocol, so either can
take over a folder from the other.

```
trommi-connector                     MCP stdio server "trommi" (what Claude Code starts)
trommi-connector join <link>         join a room with an agent invite link (or TROMMI_INVITE)
trommi-connector say "<text>" [--session <name>] [--urgent]
trommi-connector permission|notice|denied|resolved    the plugin's hooks (JSON on stdin)
trommi-connector monitor             the plugin's monitor (pointer lines)
trommi-connector witness <session>   (spawned by the connector itself: the folder watch's last word)
trommi-connector whoami
trommi-connector driver --home <dir> the interop driver (dev/interop)
trommi-connector --version
```

## Build

`cargo` is `~/.cargo/bin/cargo`. `build.rs` checks `connector/prompt.md` (sections, the 2048-character limits);
`gen-tools.mjs` makes `tools.json` (the tool schemas) from the JS connector, `node connector-rs/gen-tools.mjs --check`
says whether it is current. The binary embeds both: tool names, descriptions and schemas are byte for byte the JS ones.

```
cargo build                                   # debug, for the tests below
node connector-rs/build-plugin.mjs [dir]      # release binaries, sha256, optional signature, plugin zip, marketplace.json
```

`build-plugin.mjs` builds `x86_64-unknown-linux-musl` and `aarch64-unknown-linux-musl` with `rust-lld` as linker and
`clang --target=…` for ring's C code (no cross gcc needed): static, 7.6 MiB and 6.3 MiB. `aarch64-apple-darwin` needs
the Apple SDK: build it on a Mac (`cargo build --release --target aarch64-apple-darwin`) or with cargo-zigbuild and a
macOS SDK, then run `build-plugin.mjs --no-build`; without it the target is skipped with a note. The plugin carries a
POSIX `sh` launcher (`bin/trommi-connector`) that picks `bin/<target>/trommi-connector` by `uname`. With
`TROMMI_RELEASE_KEY=<file with a 32-byte Ed25519 seed>` every binary gets a `.sig` (Ed25519 over
`"trommi-release/v1\0" ‖ sha256(binary)`) and `release-key.pub`.

## Device keys

`TROMMI_KEYSTORE=auto|file|keychain` (default `auto`). With the keychain (Secret Service on Linux, Keychain on macOS)
the device secret goes there and the slot's key file holds only `trommi-keychain v1 <account>`; without one, or with
`file`, the key file is the JS connector's format. Existing JS slots (file keys) are opened as they are and stay file
keys. A slot written with a keychain key cannot be opened by the JS connector: use `TROMMI_KEYSTORE=file` while both
connectors may share a folder. Build without the `keychain` feature for a file-only binary.

## Tests

```
cargo test                                                     # crypto vectors (shared/crypto/vectors.json), session grants
node dev/interop/run.mjs --pairs js-js --agent rust            # the interop scenarios with the Rust agent device
TROMMI_KEYSTORE=file TROMMI_CONNECTOR_CMD=$PWD/connector-rs/target/debug/trommi-connector \
  node connector/test-e2e.mjs --only integration|hooks|monitor|keyclaim|link
```

`TROMMI_CONNECTOR_CMD` makes `connector/test-e2e.mjs` start that command wherever it starts `node connector.mjs …`.
Set `TROMMI_KEYSTORE=file`: the scenarios read key files directly (and keychain entries of test rooms would otherwise
land in the real keychain).

## Parity

| Area | State | Checked by |
| --- | --- | --- |
| zcrypto v1 (log, epochs, wraps, invites, envelopes, binds, assets, grants) | done | `cargo test`: vectors rebuilt byte for byte, opened from bytes |
| Client core (sync, chains, outbox, lease, resync, ledger, receipts, history) | done | interop 19/19 with `--agent rust` (JS baseline 19/19) |
| Persisted state (`state.json`/`state.log`, all record shapes) | done | slots opened by JS after Rust and back in the e2e restarts |
| MCP server: initialize, instructions, tools/list | done | tools/list identical to JS; instructions differ only in the `say` command's path |
| All 18 tools + reload_connector + inbox (no channels) | done | e2e integration |
| Channel notifications (`notifications/claude/channel`, meta keys, permission relay) | done | e2e integration, link |
| Key slots, owner records, take-over, spare, dead keys, retire, folder watch | done (see below) | e2e keyclaim 7/7, integration |
| `join`, `say`, hooks, `monitor`, `witness`, `whoami` | done | e2e hooks 7/7, integration (say, join) |
| Versioning (`Trommi-Client: connector/0.1.0`, 426 too-old, update watch) | done | `updates` part is JS-only (hot reload of .mjs files) |
| `reload_connector` | a new binary on disk: asks for a restart (no in-process hot reload as the JS code file reload) | — |
| Keychain (Secret Service / Keychain), file fallback | done | manual; e2e runs with `file` |
| Plugin build (linux x86_64/aarch64 musl, launcher, zip, marketplace, sha256, signature) | done; macOS needs a Mac | `build-plugin.mjs` |
| `connect` script (installs connector.mjs) | JS only: the script installs the JS file | not ported |

Last e2e run against the Rust binary: hooks 7/7, keyclaim 7/7, monitor 2/3, link 8/9, integration 29/31 (two fixes
made after it: the "put aside as …" line of a join under a retired connector, and a call on a removed key going again
on the next key; not yet re-run). Open: monitor "reconnects after a connector restart" (the pointer after the restart
does not bring the event through `inbox`), link "a reconnect within the grace is no loss" (one push too many).
