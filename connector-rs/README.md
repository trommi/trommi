# connector-rs

The Trommi connector: one static binary, `trommi-connector`. It is what the connect script installs and what the
Trommi plugin for Claude Code runs (the JavaScript connector it was ported from is gone; its history is in git).

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

## Sources of the texts

`connector/prompt.md` holds every text the agent reads (the instructions, the plugin-mode preamble, one `## <tool>`
section per tool); `tools.json` here holds the tools' schemas (parameter descriptions included), one example per tool,
the session tools, and, for the app's help page only, the events, `retention_days` and `max_asset`. Both are edited by
hand and compiled in (`src/prompt.rs`); `build.rs` refuses a build where a tool has no section, a section has no tool,
a description is over 2048 characters or the instructions over 1900. The app's build reads the same two files for the
help page (`app/web/dev/build.mjs`, `gen/vendor/tools-reference.mjs`).

## Build

`cargo` is `~/.cargo/bin/cargo`.

```
cargo build --release                         # the binary the tests run (npm test builds it first)
node connector-rs/build-plugin.mjs [dir]      # the release: four binaries, sha256, optional signature, plugin, marketplace
```

`build-plugin.mjs` builds four targets, all on this Linux machine:

- `x86_64-unknown-linux-musl` and `aarch64-unknown-linux-musl` (`rustup target add` both) with `rust-lld` as linker
  and `clang --target=…` for ring's C code (no cross gcc needed): static, about 7.6 MiB and 6.3 MiB;
- `aarch64-apple-darwin` and `x86_64-apple-darwin` (`rustup target add` both) with `cargo zigbuild`
  (`cargo install --locked cargo-zigbuild`) and zig 0.14 as C compiler and linker (`ZIG`, else a `zig` on `PATH` that
  answers, else the newest under `~/.local/share/mise/installs/zig`: `mise install zig@0.14.1`). No Apple SDK: the
  binary links only `libSystem`, `libiconv` and `libcharset` (zig and cargo-zigbuild bring their stubs), because the
  macOS keychain goes through `/usr/bin/security` instead of Security.framework (Device keys, below). Minimum macOS 11:
  zig ignores `MACOSX_DEPLOYMENT_TARGET` and would stamp 13.0, so a small shim (`target/zig-macos/zig`) puts the
  version into the zig target (`aarch64-macos.11.0-none`). The arm64 binary carries the linker's ad-hoc signature (as
  Apple's linker makes it; macOS on arm64 runs nothing unsigned); no Developer ID, no notarization: files that command-line
  tools write (`curl`, Claude Code's plugin install) carry no quarantine flag, so Gatekeeper should not ask. About 5.0 MiB and 5.6 MiB. Rust warns that
  `xcrun` is missing: harmless here. **Not yet run on a real Mac** (the unit tests drive a stand-in `security`).

It writes into `dir` (default `connector-rs/dist/`, kept out of the repository), each file at its address under the app:

- `connector/<sha256>/trommi-connector-<target>`: the binary, named by its content (with `.sig` when
  `TROMMI_RELEASE_KEY` names a file with a 32-byte Ed25519 seed: the signature is over
  `"trommi-release/v1\0" ‖ sha256(binary)`; the public key goes to `connector/release-key.pub`);
- `connector/trommi-connector-<target>.sha256`: `<sha256>  trommi-connector-<target>`, the pointer at the newest;
- `plugins/trommi-<version>.zip` and `plugins/marketplace.json`: the plugin (marketplace `trommi`, plugin `trommi`),
  whose `bin/trommi-connector` is a POSIX `sh` launcher picking `bin/<target>/trommi-connector` by `uname -s`/`-m`
  (`Linux/x86_64`, `Linux/aarch64`, `Darwin/arm64`, `Darwin/x86_64`); MCP server, hooks and monitor run it. Version:
  the first 12 hex of the SHA-256 over all binaries; the zip is deterministic.

## Release

`dev/deploy/connector.sh [--dry-run]` builds the release and uploads it into the R2 bucket `trommi-releases`
(binding `RELEASES` in `app/web/wrangler.jsonc`), named files first, pointers last; `app/web/worker.js` serves it at
`https://app.trommi.com/connector/…` and `/plugins/…` (README.md "The release"). Cloudflare's build of the app has no
Rust toolchain, so the release never comes from an app deploy, and no binary is in git.

## Updates

One file is code and shell, so there is no hot reload: a new binary in place of the running one (polled,
`TROMMI_UPDATE_POLL_MS`) and a newer version the hub recommends (`TROMMI_VERSION_CHECK_MS`) are announced once as
`kind="update"` with `restart_required="1"`, hinted once on the next tool result, and `reload_connector` answers
with the restart line (/mcp, then trommi, then Reconnect). The running process goes on until then. A plugin install
gets a new release through Claude Code's marketplace update (`claude plugin update trommi@trommi`).

## Device keys

`TROMMI_KEYSTORE=auto|file|keychain` (default `auto`). With the keychain (Secret Service on Linux, the login keychain
on macOS) the device secret goes there and the slot's key file holds only `trommi-keychain v1 <account>`; without one,
or with `file`, the key file holds the secret (66 bytes, 0600).

On macOS the connector talks to the login keychain through Apple's `/usr/bin/security` (absolute path, not `PATH`;
`src/keychain/security_cli.rs`), a generic password with service `trommi-connector` and the random account of the
reference. The secret never goes on a command line (`ps` shows argv to every user): it is written as hex on the stdin
of `security -i`, which reads the `add-generic-password -U … -w <hex>` command from there; it is read back with
`find-generic-password -w` into a pipe of ours, and every add is read back, because `security -i` can exit 0 after a
failed command. Account and service are checked to be `[A-Za-z0-9-]` before they reach a command line or that line.
Each call has a deadline and a `security` that does not answer (a locked keychain asking for its password, e.g. over
SSH) is killed; the probe then fails and `auto` takes the key file. The item's access list is the one `security`
gives it (`security` may read it without a prompt), so any process of the user can read it through `security` while
the keychain is unlocked: the same as the Secret Service on Linux and the key file. (Security.framework would bind the
item to the binary, and every update would ask again.)

`auto` takes the keychain only when it answers a probe and the room's slot folder has no key file with a secret in
it, so one folder keeps one kind of key. `keychain` fails the join when no keychain answers. Build without the
`keychain` feature for a file-only binary.

## Tests

```
cargo test                                     # crypto vectors, session grants, the macOS keychain (a fake security)
node connector/test.mjs                        # prompt.md + tools.json, the binary outside a room, hooks, the release
node connector/test-e2e.mjs [--only integration|updates|hooks|monitor|keyclaim|link|connect] [--as-mac]
node dev/interop/run.mjs --pairs js-js --agent rust            # the interop scenarios with the Rust agent device
sh connector-rs/test-keychain.sh                               # the keychain, in a throwaway D-Bus session and keyring
```

Both `connector/` suites run `connector-rs/target/release/trommi-connector`, built first (`connector/binary.mjs`;
`TROMMI_CONNECTOR_CMD` names another binary). The e2e scenarios run with `TROMMI_KEYSTORE=file` (they read key files
directly and never touch this machine's keychain). `test-keychain.sh` starts a D-Bus session and a gnome-keyring of its own and refuses to run on the real
session bus. Run the e2e parts one at a time on a busy machine (each starts a hub and several connectors).
