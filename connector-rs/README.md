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
trommi-connector allow-tools         the plugin's board tools allowed in .claude/settings.local.json (connect.sh)
trommi-connector driver --home <dir> the interop driver (dev/interop)
trommi-connector --version
```

## Build

`cargo` is `~/.cargo/bin/cargo`. `build.rs` checks `connector/prompt.md` (sections, the 2048-character limits);
`gen-tools.mjs` makes `tools.json` (the tool schemas) from the JS connector, `node connector-rs/gen-tools.mjs --check`
says whether it is current. The binary embeds both: tool names, descriptions and schemas are byte for byte the JS ones.

```
cargo build --release                         # the binary the tests below run
node connector-rs/build-plugin.mjs [dir]      # release binaries, sha256, optional signature, plugin, marketplace
```

`build-plugin.mjs` builds `x86_64-unknown-linux-musl` and `aarch64-unknown-linux-musl` with `rust-lld` as linker and
`clang --target=…` for ring's C code (no cross gcc needed): static, 7.6 MiB and 6.3 MiB. `aarch64-apple-darwin` needs
the Apple SDK: build it on a Mac (`cargo build --release --target aarch64-apple-darwin`) or with cargo-zigbuild and a
macOS SDK, then run `build-plugin.mjs --no-build`; without it the target is skipped with a note.

It writes what the app serves (`binaryFiles()`, the counterpart of `connector/build.mjs`'s `connectorFiles()`;
`app/web/worker.js` maps these paths to `gen/`):

- `connector/trommi-connector-<target>` with `.sha256` (and `.sig` plus `connector/release-key.pub` when
  `TROMMI_RELEASE_KEY` names a file with a 32-byte Ed25519 seed: the signature is over
  `"trommi-release/v1\0" ‖ sha256(binary)`);
- `plugins/rs/marketplace.json` and `plugins/rs/trommi-rs-<version>.zip`: the plugin, whose `bin/trommi-connector` is a
  POSIX `sh` launcher picking `bin/<target>/trommi-connector` by `uname`; hooks and monitor run the binary.

`connect.sh` with `TROMMI_CONNECTOR=binary` installs this instead of `connector.mjs` (no Node needed): it downloads
the binary of the machine, checks its SHA-256, installs the plugin from `plugins/rs/marketplace.json` (or registers
the binary in `.mcp.json` where Claude Code has no plugins) and joins with it. Without the variable nothing changes.

## Updates

One file is code and shell, so there is no hot reload: a new binary in place of the running one (polled,
`TROMMI_UPDATE_POLL_MS`) and a newer version the hub recommends (`TROMMI_VERSION_CHECK_MS`) are announced once as
`kind="update"` with `restart_required="1"`, hinted once on the next tool result, and `reload_connector` answers
with the restart line (/mcp, then trommi, then Reconnect). The running process goes on until then.

## Device keys

`TROMMI_KEYSTORE=auto|file|keychain` (default `auto`). With the keychain (Secret Service on Linux, Keychain on macOS)
the device secret goes there and the slot's key file holds only `trommi-keychain v1 <account>`; without one, or with
`file`, the key file is the JS connector's format. Existing JS slots (file keys) are opened as they are.

`auto` takes the keychain only when it answers a probe and the room's slot folder has no key file with a secret in
it: a folder shared with a JS connector (which cannot read the keychain) keeps key files, so either connector can open
every slot. `keychain` fails the join when no keychain answers. Build without the `keychain` feature for a file-only
binary.

## Tests

```
cargo test                                                     # crypto vectors (shared/crypto/vectors.json), session grants
node dev/interop/run.mjs --pairs js-js --agent rust            # the interop scenarios with the Rust agent device
TROMMI_KEYSTORE=file TROMMI_CONNECTOR_CMD=$PWD/connector-rs/target/release/trommi-connector \
  node connector/test-e2e.mjs --only integration|updates|hooks|monitor|keyclaim|link|connect
sh connector-rs/test-keychain.sh                               # the keychain, in a throwaway D-Bus session and keyring
```

`TROMMI_CONNECTOR_CMD` makes `connector/test-e2e.mjs` start that command wherever it starts `node connector.mjs …`;
`updates` and `connect` then run their binary variants. Set `TROMMI_KEYSTORE=file` for the e2e scenarios: they read
key files directly. `test-keychain.sh` starts a D-Bus session and a gnome-keyring of its own and refuses to run on the
real session bus. Run the e2e parts one at a time on a busy machine (each starts a hub and several connectors).

## Parity

| Area | State | Checked by |
| --- | --- | --- |
| zcrypto v1 (log, epochs, wraps, invites, envelopes, binds, assets, grants) | done | `cargo test`: vectors rebuilt byte for byte, opened from bytes |
| Client core (sync, chains, outbox, lease, resync, ledger, receipts, history) | done | interop 19/19 with `--agent rust` (JS baseline 19/19) |
| Persisted state (`state.json`/`state.log`, all record shapes) | done | JS opens Rust slots and back (integration, test-keychain) |
| MCP server: initialize, instructions, tools/list | done | tools/list identical to JS; instructions differ only in the `say` command's path |
| All 18 tools + reload_connector + inbox (no channels) | done | e2e integration 31/31, monitor 3/3 |
| Channel notifications (meta keys, permission relay, missed events, receipts) | done | e2e integration, link 9/9 |
| Key slots, owner records, take-over, spare, dead keys, retire, folder watch, witness | done | e2e keyclaim 7/7, link 9/9, integration |
| `join`, `say`, hooks, `monitor`, `witness`, `whoami` | done | e2e hooks 7/7, integration, monitor |
| Versioning (`Trommi-Client: connector/0.1.0`, 426 too-old) and update notices | done; restart instead of hot reload | e2e updates 2/2 (binary variant) |
| Keychain (Secret Service / Keychain), file fallback, shared-folder rule | done (Linux; macOS Keychain untested) | `test-keychain.sh` 5/5 |
| Plugin build, connect script | done (Linux targets; macOS needs a Mac) | e2e connect (plugin and `--no-plugin`) |
