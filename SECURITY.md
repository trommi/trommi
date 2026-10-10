# Security

How Trommi protects your content, its releases, its servers and this repository. The hub is the server that
stores and relays encrypted data; the web app is delivered separately, by Cloudflare at app.trommi.com.

## App / E2E
- Encryption is MLS (RFC 9420, with OpenMLS `=0.9.1`), in one Rust core shared by web, iOS, connector and hub.
- One fixed set of algorithms, never negotiated: `MLS_128_DHKEMX25519_CHACHA20POLY1305_SHA256_Ed25519`.
- Everything is encrypted on your device. The hub stores only encrypted data and never has the keys to read it.
- The hub does see: your e-mail, which devices are in which group, when something is written, sizes, push tokens.
- Your password never leaves your device; the hub keeps only a slow hash of a key derived from it.
- Each wrong password makes that guesser wait longer (up to 15 minutes); no account is ever locked.
- A recovery code opens everything. The hub keeps it only encrypted under your password or Emergency Kit words.
- Nobody, not even we, can reset an account: without password, Emergency Kit and devices, the content is gone.
- An invite link holds a secret the hub never sees, so the hub cannot slip in an invite of its own.
- Invite links work once and expire: 10 minutes for a device, 15 for an agent.
- A new device gets in only after you compare six emoji on both screens; this stops the hub adding its own.
- A removed device loses access at once.
- A device deletes its data only after checking the signed removal itself, never on the hub's word alone.
- A room holds at most 1000 devices.
- Files are encrypted on the device. Push notifications carry no content.
- No forward secrecy for history, on purpose: a new device of yours reads everything, and so does anyone who
  holds one of your devices or the recovery code.

## Signing
- Every change becomes one release `v<N>`: a list of all files with their hashes, signed with Ed25519.
- Public key: `release/public-key.pem`, also pinned on the hub server. The private key stays in 1Password.
- The hub server installs a release only if its signature checks out, and never one older than it accepted before.
- The connector's `install.sh` and `trommi-connector update` check the same signature, with the key built in.
- Release files and web app files carry GitHub build attestations: a public record of which build made them.
- The iOS app is signed by Apple and ships through TestFlight.
- iOS uses only standard algorithms and is declared exempt from export paperwork; it is not offered in France,
  which would need an extra filing.

## Deployment
- Secrets live in 1Password and are read only by the step that needs them.
- Pull requests get no secrets and deploy nothing.
- CI never logs into the hub server and sends it no code, only "take release `v<N>`".
- CI reaches the hub server over a private network (Tailscale) with a short-lived GitHub login, no stored key.
- The hub server downloads and checks the release itself.
- If the new hub is not healthy within 60 seconds, the previous release runs again.
- Hub and updater run as their own users (`trommi`, `trommi-updater`), neither with root rights.
- Root runs only a tiny helper (`hub-ctl`) that starts or stops the hub when the updater asks; nothing else.
- The hub runs in a systemd sandbox and listens only on its own machine (`127.0.0.1`).
- Public traffic reaches the hub only through a Cloudflare tunnel.
- CI deploys the web app (app.trommi.com) and the website (trommi.com) to Cloudflare with a token from 1Password.

## Repository
- GitHub secret scanning is on and blocks pushes that contain secrets.
- Only `main` and `v*` tags can deploy.
- Workflows start with no permissions, and outside actions are pinned to exact commits.
- Toolchain and dependency versions are pinned (lockfiles).
- Rust dependencies are checked daily against RustSec, the list of known vulnerabilities.

## Known limits and planned
- The connector checks signatures when it installs or updates, not each time it starts: whoever can write to
  your home folder could replace it.
- In the browser, the app's code is loaded from Cloudflare (app.trommi.com) each time; whoever controls that
  delivery (our Cloudflare account or the deploy pipeline) could ship code that reads your keys. The hub cannot.
  The iOS app and the connector do not have this risk: they are installed signed releases.
- Going back to the previous hub keeps the current database; the copy made before the update is not restored.
- Rulesets (signed commits, no force push, protected tags): being turned on.
- iOS: account recovery and replacing the recovery code are tested only against a stand-in hub, not a real one.
- Passkeys: built, but off, because they need the PRF extension, which some password managers lack.
- Planned: post-quantum encryption once OpenMLS supports it.
- Planned: deleted content really gone, also on devices and in backups.

Report a vulnerability: trommi@mail101.de
