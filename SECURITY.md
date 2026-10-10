# Security

How Trommi protects content, releases, server and repository.

## App / E2E
- MLS (RFC 9420) with OpenMLS `=0.9.1`, one Rust core on every platform.
- One suite only: `MLS_128_DHKEMX25519_CHACHA20POLY1305_SHA256_Ed25519`.
- The hub cannot read content, files or keys.
- The hub sees: e-mail, members, sizes, times, push tokens.
- Sign-in: password or passkey. The hub keeps no passwords.
- Wrong passwords slow the source down. No lockout.
- Recovery code: stored only sealed, AES-256-GCM under Argon2id and HKDF.
- Nobody can reset an account.
- An invite link binds its offer by a MAC and carries its deadline.
- Links expire: device 10 min, agent session 15 min.
- A new device is confirmed by six emoji on both screens.
- A removed device loses access at once.
- A removed device verifies its removal before it wipes anything.
- At most 1000 devices per room.
- Files are encrypted on the device. Pushes carry no content.
- History has no forward secrecy: your devices and code read it.

## Signing
- One signed release `v<N>` per change: manifest of all file hashes, Ed25519.
- Public key: `release/public-key.pem`, pinned on the server. Private key: 1Password.
- The server verifies a release before it swaps and refuses older ones.
- The connector installs from `install.sh` with the same check.
- The connector verifies updates against its built-in key.
- Release and web files carry build attestations.
- iOS builds are signed by Apple and ship through TestFlight.
- iOS: standard algorithms only, declared exempt; not distributed in France.

## Deployment
- Secrets live in 1Password, read at run time.
- Pull requests get no secrets and deploy nothing.
- CI has no SSH and sends no code, only a release name.
- CI joins the private network by OIDC, no stored key.
- The server fetches releases itself.
- Failed health check: the previous release runs again.
- The hub runs as `trommi`, the updater as `trommi-updater`.
- Root runs only `hub-ctl`: it starts or stops the hub when asked.
- Hub: systemd sandbox, `127.0.0.1` only.
- Public traffic enters only through a Cloudflare tunnel.

## Repository
- Secret scanning and push protection are on.
- Deploys only from `main` and `v*` tags.
- Actions pinned to commit SHAs, no default permissions.
- Pinned toolchain and lockfiles.
- Rust dependencies checked against RustSec daily.

## Known limits and planned
- The connector checks updates, not its own start.
- Browser keys are only as safe as the server of the app.
- A rollback does not roll back the database.
- Rulesets (signed commits, no force push, tags): off for now.
- Web and iOS read history whole; the core's paged calls are unused.
- iOS: recovery and new code not yet run against a real hub.
- Planned: a post-quantum suite once OpenMLS ships one.
- Planned: deleted content really gone, also on devices and backups.

Report a vulnerability: trommi@mail101.de
