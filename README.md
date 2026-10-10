# Trommi

Chat and decision cards between a person and their Claude Code sessions, end-to-end encrypted.

Security in one page: [SECURITY.md](SECURITY.md).

## What lies where

| | |
|---|---|
| `core/` | the shared Rust core (keys, envelopes, account) and its bindings: `core/wasm` for the browser, `core/swift` for iOS |
| `hub/` | the hub (the server) and its updater; `hub/deploy/` is how it is installed |
| `app/web/` | the web app |
| `connector/` | the connector: the program and plugin that join a Claude Code session to a room |
| `ios/` | the iOS app |
| `demo/` | the demo room: shared data built into both the web app and the iOS app, so it belongs to neither |
| `tests/` | every part's tests, one folder per part |
| `spec/` | the protocol, the hub's API, the test vectors |
| `release/` | the form of a signed release: manifest, signature, the public key |
| `.github/` | the workflows and what only they use (`scripts/`, `tools/`) |

`THIRD-PARTY.md` lists the licences of the Rust crates the clients ship (the web app's own material:
`app/web/THIRD-PARTY.md`).

## How the data is organised

The protocol is version 2: MLS (RFC 9420) distributes the keys, content is Trommi's own signed envelope. The whole of
it is [`spec/v1.md`](spec/v1.md); why it leaves the standard in five places is
[`spec/v1-deviations.md`](spec/v1-deviations.md). The web app in `app/web` speaks it through the shared Rust core
(`core/`, as WebAssembly).

**Content: what a person or an agent has.** Sorting is not encryption: which Desk an Agent is on, the order, the
crown and which Helper hangs under which Agent are register values; moving changes no key and moves no data.

```
Room                                          everything of one account (an account has a list of rooms; one for now)
├── Desk                                      a register (name, order, crown, Goals)               room group
│   ├── Goals                                 in the Desk's register; copied into each Agent's session for the agent
│   └── Scribble Board (one per Desk,         items: stroke, text, sticky, voice note, picture,    room group
│       one for "All desks")                  move, erase, send away; snapshot = a file
│       └── piece of a stroke in progress     relayed live, never stored (an MLS message)
├── Note                                      versions; sending it makes a Chat message             room group
├── per-card markers                          Later (snooze), duck, drafts, read marks: registers   room group
├── Agent (a session)                         everything below is that one session                  its session group
│   ├── Chat                                  messages, attachments; the terminal's input and final answer
│   ├── work trail                            "Working · 3 steps": MLS messages, kept 30 days
│   ├── Decision card, Info card              versions; answer, take back; the card's own Chat
│   ├── permission request + verdict
│   ├── Artifact                              a published Page or Media: versions, files; Share link
│   ├── Status line, agent profile, Goals     registers
│   └── Helper (a child session)              the same again, in a session group of its own
└── Push, Live Activity                       no content: how the hub reaches a device
```

**Keys: what only protects.**

```
Account (e-mail; password or passkey)         the hub checks the login; no key here
└── sealed copies of the recovery code        under the password, the Emergency Kit words, each passkey        
    └── recovery code → recovery key          public halves in the room group's context; not a member

Device                                        one Ed25519 signature key = its id; KeyPackages at the hub

Room group (MLS)                              all of the person's devices. Not a Desk.
└── content key, per epoch                    MLS exporter; protects Desks, Goals, Scribble Boards, Notes, markers

Session group (MLS), one per Agent/Helper     the person's devices + that session's agent device(s)
└── content key, per epoch                    MLS exporter; protects Chat, cards, permission requests, Artifacts,
                                              Status lines

Old content keys                              kept by every device that had them; handed to a new device or to an
                                              agent taking a session over in an MLS message; one sealed copy per
                                              group and epoch at the hub for the recovery key                  
File key                                      random, one per file; inside the encrypted body that names the file,
                                              and after the # of a Share link                                  
```

- Two boundaries only: the room (the person's devices) and each single session (those devices and its agent devices).
- The hub stores public group state, ordered group messages and ciphertext; it never holds a key or reads content.
- Not forward secret for history, by decision: whoever holds a human device's state or the recovery code reads the
  whole history. After a device's next update or its removal, a copied group state opens nothing new.

**What a hub reads**: who is in which group and every change to it; of each stored item the signed header (sender,
group and epoch, the sender's running number and chain link, recipient, time, kind, the Chat or board it belongs to,
a card's id, type, state and urgency, a register's opaque id, file ids, the push flag) and its padded size. **What a
hub never reads**: a body: texts, card content, choices, verdicts, register names and values, strokes, file keys,
file names and types. **What goes away**: thirty days after a card is answered or closed its bodies and files; work
trails after thirty days. The table per stored thing is in `spec/v1.md`, section 14.

## Delivery

Every commit on `main` runs `.github/workflows/build.yml`. It tests and builds the parts whose folders changed, and
then decides whether there is a release: `.github/scripts/inputs.sh` hashes, per part (web, connector, ios, hub,
updater), the files its build reads (as git lists them for the commit: mode, object, path; `build.yml` and `core/`
count for every part, tests for none). When one hash differs from the newest release's manifest, the run makes **one
release `v<N>`** (`release.yml`): every part's files, also the unchanged ones (built again from the same inputs, so
every release is complete), and one signed `manifest.json` that names each file and says per part its `inputs` hash
and whether it `changed`. When nothing changed, nothing is released. N is the build's run number (plus
`RELEASE_BASE`): it only grows.

Each part is then delivered only when it changed:

| Part | Build makes | In the release | Delivered when it changed |
| --- | --- | --- | --- |
| Web app | `web-release`: the files the worker serves, the worker, its settings, `manifest.json`, `checksums.txt` | `web.tar.gz` | `deploy_web.yml`: the Cloudflare worker `trommi-app` at https://app.trommi.com |
| Connector | `connector-release`: four binaries | the four binaries | the release is the delivery: `install.sh` and `trommi-connector update` take the newest `v<N>`, and keep the installed program when its SHA-256 is the same |
| iOS app | `ios-release`: the Rust core for iOS and its Swift bindings | nothing (inputs and changed only) | `deploy_ios.yml`: a TestFlight build in the group "Intern" |
| Hub | `hub-release`: the hub and its updater as static programs | both programs | `deploy_hub.yml` (hub or updater changed): the server takes `v<N>` (below) and restarts the hub only when the hub's inputs changed |

A release is published by one run at a time; a run whose release number is not above the newest published one
publishes nothing. A delivery that failed is not repeated by the next run (that compares with the release before,
not with what is live): start the deploy workflow by hand.

Secrets: each part has a GitHub environment of its name (`web`, `connector`, `ios`, `hub`) that holds only the way
into a 1Password Environment; every other secret is read from there by the one command that needs it (`op run`).
Pull requests run the build jobs and reach no secret, no release and no deploy workflow.

**The release is signed.** `release/manifest.sh` writes `manifest.json`: product (`trommi`), repository, version,
tag, commit, per part `inputs` and `changed`, and every file with its size and SHA-256. `release/sign.sh sign` signs the exact
bytes of the manifest with Ed25519 (`manifest.json.sig`, 64 raw bytes); the public key is `release/public-key.pem`.
To check a release: `release/sign.sh verify manifest.json`, then that the manifest names the product, tag and
version you asked for, then `release/sign.sh files manifest.json`.

**The web app** cannot be signed for a browser, so it is attested instead. `.github/scripts/web_release.mjs` lists
every delivered file with its SHA-256 (`manifest.json`, `checksums.txt`), and the deploy creates GitHub's build
provenance attestation for each file and for the manifest: a public statement of which workflow run built these
bytes from which commit. To check a file the site serves:

```bash
curl -fsSO https://app.trommi.com/gen/build.txt          # the commit the site says it serves
curl -fsS https://app.trommi.com/index.html -o index.html
gh attestation verify index.html --repo trommi/trommi    # fails for bytes no build of this repository made
```

A monitor that does this for every file the site serves, on a schedule and after each delivery, is planned and not
built: it would read the file list from `sw.js`, verify each file's attestation, check that all of them name the
commit of `gen/build.txt`, and raise an alarm on the first file that no build of this repository made.

`Strict-Transport-Security` with preload is prepared and off: `WEB_HSTS` in `build.yml`.

## How the hub is deployed

From a commit to the running server, nobody logs in and no code is handed to the server by CI.

```
commit on main
└── build.yml          finds the changed parts; for the hub: tests, builds two static programs (hub, updater)
    ├── release.yml    the release v<N> of every part, its manifest signed (Ed25519, key from the 1Password Environment)
    └── deploy_hub.yml (the hub or its updater changed)
        └── deliver    joins the tailnet as tag:trommi-ci and says to the server: "take v<N>"
                       │
server (updater, as its own user without root, port 9443, tailnet address only)
        ├── fetches v<N> from GitHub itself
        ├── checks the signature against the public key pinned on the server, then each file against the manifest
        ├── refuses anything older than what it once accepted
        ├── the same hub inputs as the running release: notes v<N> as accepted, the hub keeps running
        ├── has the hub stopped, swaps, has it started (its unit copies the database and the hub's keys first),
        │   asks the hub whether it is well
        ├── not well: puts the release before back and starts it
        └── answers with what happened; the run shows it and fails unless the release runs
```

**The release** has the form of every signed release (above); a release never brings a key. The hub is released as static programs, not as an image: one file each, hashable, no registry
and nothing to unpack; the server says the SHA-256 of what it runs, to compare with the manifest of the release. The
version is the build's run number (plus `RELEASE_BASE` in `build.yml`): a whole number that only grows. A published
release is never replaced.

The manifest may carry fields an updater does not know (they are signed all the same and ignored), so a later
release can say more without an older updater refusing it. Its `"inputs"` name, per part, a SHA-256 over what the
build reads; whether a program is started anew is decided in one place (`changes` in `hub/updater/src/lib.rs`), by
the inputs when both releases name them, otherwise by the SHA-256 of the program in the two manifests. That decides
whether the updater is replaced and whether the hub is swapped. A hub that was not restarted keeps running the
binary of the release it started from (the server's status names that release).

**Why the deploy call needs no secret.** The call carries no code and no address, only the name of a release. What
the server then runs must be signed with the release key, be the hub of this repository, and not be older than what
it already accepted; a caller can therefore at most ask for the newest release a little earlier than CI would
have. Who may ask is decided by the tailnet: the policy lets only `tag:trommi-ci` reach port 9443, and the updater
asks the machine's own tailscaled who the caller is and serves only devices with that tag or the owner's own
devices. If tailscaled cannot be asked, nobody is served.

**When something goes wrong.**

| | what the server does |
|---|---|
| GitHub does not answer, or has no such release | nothing is touched; the hub runs on; the call answers `fetch-failed` |
| signature or a file does not match | nothing is touched; `not-verified`; what was fetched is deleted |
| older release | refused before anything is fetched |
| the new hub does not become well in 60 s, or says another commit | the release before is put back and started; `rolled-back`; the copy of the database made before the new release started lies in `/srv/trommi/backups` and is not restored by itself |
| the disk is full | a fetch that cannot be written changes nothing; if the copy of the database cannot be made, the new release is not started and the release before is put back |
| the machine or the updater goes down in the middle | a note written before the swap is found at the next start (the hub is started by the updater, never by itself, so a release whose health was never known does not serve): if the new release is in place, proves, runs and is well, it stays; otherwise (also after a reboot, when it does not run) the release before is put back: a recovery never starts a release whose health was never known; if not even that can be written (a full disk), the hub stays stopped until the next start of the updater or the next deploy |
| two calls at once | one after the other; the second finds its release running (`unchanged`) or older (`refused`) |
| the server restarts (it reboots by itself for updates) | the updater starts at boot and starts the hub; a call that finds no connection is tried again for three minutes, then the run fails without having changed anything |
| a new updater is on trial, or another deploy runs | `busy`; the run tries again for three minutes |
| a new updater does not come up | systemd starts it once more, the pre-start script puts the previous updater back, and that one says so in its answers |

**Nothing here runs as root.** The hub runs as the user `trommi`, the updater as the user `trommi-updater`; neither
can log in. The updater owns one folder, `/srv/trommi/deploy`, and can write nowhere else. What it decides is which
program the hub's unit runs; the unit itself is fixed on the server (`trommi-hub.service`, installed by
`hub/deploy/install.sh`, no part of a release) and runs that program as `trommi` inside its limits. So a release
that passed the signature check, or an updater that was taken over, gets what the hub has (its data, its push
credentials), can stop the hub and can refuse further updates, and does not get root or anything else on the
machine. Three things remain root's and are named here so that the claim can be checked:

- `hub/deploy/hub-ctl.sh` behind `trommi-hub-ctl.socket`: the updater cannot start or stop a unit, so it asks this
  helper through a socket only its user can open. The helper takes one word, `start` or `stop`, and does that to
  the hub's unit; nothing else, and nothing the caller sends reaches a command.
- `hub/deploy/install.sh`, run by the owner over SSH: users, units, scripts, settings, the pinned key.
- systemd, which starts the units as their users.

The hub's data is not the updater's to read either: the copy of the database before another release starts is
made by the hub's unit (`hub/deploy/hub-prestart.sh`, as `trommi`, while the hub stands still, so `hub.db` and its
`-wal` and `-shm` files are one consistent state). The rest rests on the machine: on users being kept apart by the
kernel, and on tailscaled telling any local user who a tailnet address is (`tailscale whois`).

**The updater updates itself.** Every release brings the updater too. When it differs from the one that runs, the
deploy puts it in place beside the old one, answers its caller, and ends; systemd starts the new one, which has to
say that it is up. If it ends instead, or does not say so in time, the previous one is put back
(`hub/deploy/updater-prestart.sh`) and reports which release's updater did not come up. The pinned key, the
settings in `/etc/trommi` and the version floor are no part of a release and stay. The units, the helper and the
pre-start scripts are installed once and are the fixed point; a change to one of them is a run of `install.sh`.

**On the server.**

```
/srv/trommi/                     root's; nothing is written here after the installation
/srv/trommi/deploy/              trommi-updater's:
    releases/v<N>/                   the files of a release as they were proved
    current, previous                links: the hub that runs, the one before
    updater, updater-previous        the same for the updater
    state.json                       the highest version ever accepted
/srv/trommi/data/                trommi's: the database (hub.db), the hub's own keys (vapid.key, push-ticket.key), files/
/srv/trommi/backups/             trommi's: the three newest copies of database and keys, one before each newer release starts
/etc/trommi/                     root's: release-public-key.pem (pinned), hub.env, hub-secrets.env, apns-key.p8, updater.env
/etc/systemd/system/             trommi-hub.service, trommi-hub-updater.service, trommi-hub-ctl.socket, trommi-hub-ctl@.service
/usr/local/lib/trommi/           hub-ctl.sh, hub-prestart.sh, updater-prestart.sh
```

Which hub and which updater run: `ssh root@<server> trommi-hub-updater status`, and the summary of every
`deploy_hub` run. A backup of the server must hold `/srv/trommi/data` whole (the two key files with the database:
without `vapid.key` every web push subscription is lost) and `/etc/trommi`.

Rules that follow from this: a hub release must be able to run on the database of the release before it and leave
it usable for that one, because that is what a rollback starts; renaming `build.yml` restarts the run number, so
`RELEASE_BASE` is raised then; HSTS is off until `HUB_HSTS=on` is set in `/etc/trommi/hub.env`.

**The installation** is `hub/deploy/install.sh` on the owner's laptop: `inventory` reads the server and changes
nothing; `install` puts the users, the fixed units and scripts, the pinned key and a first release in place (run
again, it renews the fixed parts; on a server whose updater still runs as root it converts the installation in
place and moves everything back if a step fails); `secrets` sends the push credentials from the 1Password
Environment. Until the server is installed, `deploy_hub` publishes each release and then fails saying that nothing
answers on the server's deploy port.
