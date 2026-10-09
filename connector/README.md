# trommi-connector

The Trommi connector: one static binary through which a Claude Code session talks to the human's board. It is an
**agent device** of a room on protocol v2 ([`spec/v2.md`](../spec/v2.md)): every key, every check and every byte on
the wire comes from [`trommi-core`](../core); nothing of the first protocol is in it.

```
trommi-connector                     MCP stdio server "trommi" (what Claude Code starts)
trommi-connector connect <link>      join a room with an agent invite link (also: join; or TROMMI_INVITE)
trommi-connector say "<text>" [--session <name>] [--urgent]
trommi-connector permission|notice|denied|resolved    the plugin's hooks (JSON on stdin)
trommi-connector prompt|stop         the terminal mirror's hooks (UserPromptSubmit, Stop)
trommi-connector trail               the work trail's hooks (PreToolUse, PostToolUse, …)
trommi-connector monitor             the plugin's monitor: one line per board event
trommi-connector whoami | allow-tools | --version
```

## What is where

| File | What |
| --- | --- |
| `src/store.rs` | the state on disk: one directory per slot (0700), a lock, a snapshot and a log of checksummed records; one record per step |
| `src/vault.rs`, `src/keeper.rs` | the core's `Device` over that journal on a thread of its own; the content chains, objects and registers beside it (`ContentDevice`); what it knows of each group's past (`learn_past`) |
| `src/hub.rs` | the hub's routes (`spec/hub-api.md`): JSON, sign-in by signed challenge, the lease header, the stream |
| `src/client.rs` | the device at work: the hub's order, Welcomes, the command gate, the outbox, lease, removal, the rollback guard |
| `src/agent.rs` | what an agent writes: Chat, cards, registers, permission requests, Artifacts and files, helper sessions, the work trail |
| `src/join.rs` | joining by link with the six emoji |
| `src/model.rs` | what this agent knows of the board |
| `src/bridge.rs`, `src/html.rs` | every tool, and a human's command as a channel event |
| `src/server.rs`, `src/mcp.rs`, `src/member.rs`, `src/slots.rs`, `src/slotstore.rs`, `src/door.rs` | the MCP server, this process as a member, key slots per folder, the sockets hooks reach it through |
| `src/line.rs`, `src/mirror.rs`, `src/trail.rs`, `src/hooks.rs` | the monitor's line, the terminal mirror, the work trail, the permission hooks |
| `src/update.rs` | the check a new binary must pass |
| `prompt.md`, `tools.json` | every text the agent reads and every tool's schema: the one source, compiled in and checked by `build.rs` |

`prompt.md` and `tools.json` are also what the web app's help page is built from. They used to be read at
`connector/prompt.md` and `connector-rs/tools.json`; both are here now (`connector/prompt.md`,
`connector/tools.json`), and the app's build (`app/web/dev/build.mjs`) names the second one at its new place.

## State and restarts

A slot's state is `~/.local/share/trommi/keys/<room>/<host>-<folder>-<n>.state/` (`TROMMI_KEYS_DIR` moves it): the
device's key, its MLS groups, its content keys, its chains, the cursor in the hub's order and the outbox. A restart
of Claude Code on the same machine opens it, signs in and catches up: it is the same member. Two processes never
own one state (an OS lock on the directory, the core's revision behind it, the hub's lease behind that). A state
that does not read, or that is older than what the device already sent, is said so and never replaced by a new key:
the human reconnects the session in the app. When the human reconnects the session on another machine, the
connector here learns it from the Commit, wipes the slot and says that it is retired.

## Updates and releases

Nothing is loaded into a running process. A new binary at the connector's path is announced once
(`kind="update"`); `reload_connector` answers with the restart line.

Releases are built and signed in CI: GitHub releases `connector-v<N>` of `trommi/trommi` with the four binaries,
the plugin's archive, `manifest.json` and `manifest.json.sig` (`release/manifest.sh`, `release/sign.sh`: Ed25519 over
the manifest's exact bytes). The connector holds the public key (`release/public-key.pem`, compiled in by
`build.rs`) and checks a binary against a manifest that lies beside it (`src/update.rs`): the signature, then
product, repository, tag and version (never older than the one running; CI compiles the release number in with
`TROMMI_RELEASE_VERSION`), then the binary's size and SHA-256 under its release name. `--version` says where a
binary stands: verified with its release, not verified (no manifest beside it), or refused. A refused binary is
never announced as an update.

## Build and tests

```
cargo build --release -p trommi-connector
node connector/build-plugin.mjs [dir]      # four targets, the plugin's zip and its marketplace file
cargo test -p trommi-tests                 # tests/connector/*: units, and scenarios against the real v2 hub
```

The four targets are static Linux (`x86_64`, `aarch64`, musl, linked with `rust-lld`, ring's C compiled by clang)
and macOS (`aarch64`, `x86_64`, `cargo zigbuild`, no Apple SDK). The scenario tests start this repository's hub as a child process (built beside the tests, or `TROMMI_HUB_BIN`)
and the built connector over MCP.
