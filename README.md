# Trommi

**A board for you and your AI agents, end-to-end encrypted**

Your Claude Code and Codex sessions ask, you answer: chat, decision cards and a Scribble Board, on the web and on
the iPhone. Everything is encrypted on the devices with MLS (RFC 9420); the server only passes sealed messages on.
One Rust core does the cryptography for the web app, the iOS app and the connector.

- 💬 **Chat** with every agent session, the terminal mirrored
- 🃏 **Decision cards**: the agent asks, you tap an answer
- ✏️ **Scribble Board**: draw, write, stick notes, send them to an agent
- 🗂 **Desks** to sort your agents, with their helpers under them
- 🔒 **End-to-end encrypted**: the server never holds a key or reads content

**[→ Open Trommi](https://app.trommi.com)**

## Install

1. **The app:** [app.trommi.com](https://app.trommi.com) in any browser. The iOS app is on TestFlight for testers
   for now.
2. **An agent**, on a Linux or macOS computer with Claude Code or Codex. Once per machine:

   ```sh
   curl -fsSL https://raw.githubusercontent.com/trommi/trommi/main/install.sh | sh
   ```

3. In the app: **Invite an agent**. In the project folder start `claude` and paste the line it shows:

   ```
   /trommi:connect '<link>'
   ```

   Six emoji appear in the terminal and in the app; tap "They match". In Codex, ask the agent to connect with the
   link.

Updates: `trommi-connector update`.

## How it works

- **Room:** everything of one account, shared by all of your devices.
- **Sessions:** each agent session is its own encrypted group: your devices and that agent, nobody else.
- **Hub:** the server stores ciphertext and who is in which group, and pushes to your devices. It cannot read a
  message, a card, a file or a key.
- **Connector:** one signed program that joins a Claude Code or Codex session to your room.

## Under the hood

<details>
<summary><b>Security</b> · MLS, signed releases, server</summary>

MLS (RFC 9420) with OpenMLS, one suite, one Rust core on every platform. Every release is signed (Ed25519) and
checked before it is installed or deployed. The hub runs without root and sees no content.

The whole list, with known limits: [SECURITY.md](SECURITY.md).

</details>

<details>
<summary><b>Protocol</b> · spec, deviations, hub API</summary>

| | |
|---|---|
| [`spec/v1.md`](spec/v1.md) | the protocol: groups, content, recovery, joining, what a hub must do and sees |
| [`spec/v1-deviations.md`](spec/v1-deviations.md) | the five places where plain MLS is not enough, and why |
| [`spec/hub-api.md`](spec/hub-api.md) | the hub's routes and tables |
| `spec/vectors/` | known answers the core must produce |

The code follows the specification, not the other way round. More: [`spec/README.md`](spec/README.md).

</details>

<details>
<summary><b>Releases and deployment</b> · one signed release per change</summary>

- Every commit on `main` runs `build.yml`: it tests and builds the parts whose files changed.
- A change makes **one release `v<N>`** with every part and one `manifest.json` (each file's size and SHA-256),
  signed with Ed25519. Public key: [`release/public-key.pem`](release/public-key.pem).
- Each part is delivered only when it changed:

| Part | Delivered to |
|---|---|
| Web app | the Cloudflare worker at app.trommi.com, every file with a GitHub build attestation |
| Connector | the release itself: `install.sh` and `trommi-connector update` check the signature first |
| iOS app | a TestFlight build |
| Hub | the server fetches the release, checks the signature, swaps, and rolls back if the new hub is not well |

Check a release:

```sh
release/sign.sh verify manifest.json   # the signature
release/sign.sh files manifest.json    # each file against the manifest
```

Check a file the web app serves:

```sh
curl -fsS https://app.trommi.com/index.html -o index.html
gh attestation verify index.html --repo trommi/trommi
```

The hub's installation: `hub/deploy/install.sh`.

</details>

## Development

<details>
<summary><b>Repository layout</b> · core, hub, apps, connector</summary>

| | |
|---|---|
| `core/` | the shared Rust core on OpenMLS; `core/wasm` for the browser, `core/swift` for iOS |
| `hub/` | the hub (the server) and its updater; `hub/deploy/` installs it |
| `app/web/` | the web app |
| `ios/` | the iOS app (Swift, SwiftUI) |
| `connector/` | the connector: the program and the Claude Code plugin |
| `demo/` | the demo room, built into the web app and the iOS app |
| `tests/` | every part's tests, one folder per part |
| `spec/` | the protocol, the hub's API, the test vectors |
| `release/` | the signed release: manifest, signature, public key |
| `.github/` | the workflows and their scripts |

Each part has its own README with the details.

</details>

<details>
<summary><b>Build and tests</b> · Rust, Node, Swift</summary>

Rust is pinned in `rust-toolchain.toml`, Node in `.node-version`.

```sh
# Core, hub, connector
cargo test --locked -p trommi-core
cargo test --locked -p trommi-tests          # core, hub, connector and deploy tests
cargo build --release -p trommi-hub -p trommi-connector

# Web app
npm ci
npm run build:core                            # the core as WebAssembly
npm test
node app/web/dev/serve.mjs 8900               # the app; ?mock=1 for the demo room

# iOS
core/swift/build.sh                           # the core for Swift
(cd tests/ios && swift test)
```

More: [`app/web/README.md`](app/web/README.md), [`ios/README.md`](ios/README.md),
[`connector/README.md`](connector/README.md), [`core/README.md`](core/README.md).

</details>

## License

[O'Saasy](LICENSE.md). Third-party licences: [THIRD-PARTY.md](THIRD-PARTY.md) (the web app's own:
[`app/web/THIRD-PARTY.md`](app/web/THIRD-PARTY.md)).

Found a vulnerability? Write to trommi@mail101.de.
