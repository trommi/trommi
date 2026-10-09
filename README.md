# Trommi

Chat and decision cards between a person and their Claude Code sessions, end-to-end encrypted.

## How the data is organised

The protocol is version 2: MLS (RFC 9420) distributes the keys, content is Trommi's own signed envelope. The whole of
it is [`spec/v2.md`](spec/v2.md); why it leaves the standard in five places is
[`spec/v2-deviations.md`](spec/v2-deviations.md). The web app in `app/web` still speaks version 1
([`spec/v1.md`](spec/v1.md)) until it has moved onto the shared core.

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
trails after thirty days. The table per stored thing is in `spec/v2.md`, section 14.

## How the hub is deployed

From a commit to the running server, nobody logs in and no code is handed to the server by CI.

```
commit on main
└── build.yml          finds the changed parts; for the hub: tests, builds two static programs (hub, updater)
    └── deploy_hub.yml
        ├── sign       signs the manifest of the build (Ed25519, key from the 1Password Environment)
        ├── publish    GitHub release hub-v<N>: the programs, the hub's systemd unit, manifest.json, manifest.json.sig
        └── deliver    joins the tailnet as tag:trommi-ci and says to the server: "take hub-v<N>"
                       │
server (updater, port 9443, tailnet address only)
        ├── fetches hub-v<N> from GitHub itself
        ├── checks the signature against the public key pinned on the server, then each file against the manifest
        ├── refuses anything older than what it once accepted
        ├── stops the hub, copies the database and the hub's keys, swaps, starts, asks the hub whether it is well
        ├── not well: puts the release before back and starts it
        └── answers with what happened; the run shows it and fails unless the release runs
```

**The release.** One form for every part that is signed (the hub now, the connector next): `release/manifest.sh`
writes `manifest.json` (product, repository, version, tag, commit, and each file with size and SHA-256);
`release/sign.sh` signs its exact bytes and checks signatures; `release/public-key.pem` is the public key. A release
never brings a key. The hub is released as static programs, not as an image: one file each, hashable, no registry
and nothing to unpack; the server says the SHA-256 of what it runs, to compare with the manifest of the release. The
version is the build's run number (plus `RELEASE_BASE` in `build.yml`): a whole number that only grows. A published
release is never replaced.

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
| the new hub does not become well in 60 s, or says another commit | the release before is put back and started; `rolled-back`; the copy of the database made before the swap is named in the answer and is not restored by itself |
| the disk is full | a fetch that cannot be written changes nothing; if the copy of the database cannot be made, nothing is swapped and the hub is started again |
| the machine or the updater goes down in the middle | a note written before the swap is found at the next start: the release before is put back and started |
| two calls at once | one after the other; the second finds its release running (`unchanged`) or older (`refused`) |
| the server restarts (it reboots by itself for updates) | both services start at boot; a call that finds no connection is tried again for three minutes, then the run fails without having changed anything |
| a new updater does not come up | systemd starts it once more, the pre-start script puts the previous updater back, and that one says so in its answers |

**The updater updates itself.** Every release brings the updater too. When it differs from the one that runs, the
deploy puts it in place beside the old one, answers its caller, and ends; systemd starts the new one, which has to
say that it is up. If it ends instead, or does not say so in time, the previous one is put back
(`hub/deploy/updater-prestart.sh`) and reports which release's updater did not come up. The pinned key, the
settings in `/etc/trommi` and the version floor are no part of a release and stay. The updater's own unit and the
pre-start script are installed once and are the fixed point; the hub's unit comes with each release.

**On the server.**

```
/srv/trommi/releases/hub-v<N>/   the files of a release as they were proved
/srv/trommi/current, previous    links: the hub that runs, the one before
/srv/trommi/updater, updater-previous   the same for the updater
/srv/trommi/data/                the hub's database (hub.db), its own keys (vapid.key, push-ticket.key), files/
/srv/trommi/backups/             the three newest copies of database and keys, made before each swap
/srv/trommi/state.json           the highest version ever accepted
/etc/trommi/                     release-public-key.pem (pinned), hub.env, hub-secrets.env, apns-key.p8, updater.env
```

Which hub and which updater run: `ssh root@<server> trommi-hub-updater status`, and the summary of every
`deploy_hub` run. A backup of the server must hold `/srv/trommi/data` whole (the two key files with the database:
without `vapid.key` every web push subscription is lost) and `/etc/trommi`.

Rules that follow from this: a hub release must be able to run on the database of the release before it and leave
it usable for that one, because that is what a rollback starts; renaming `build.yml` restarts the run number, so
`RELEASE_BASE` is raised then; HSTS is off until `HUB_HSTS=on` is set in `/etc/trommi/hub.env`.

**The first installation** is `hub/deploy/install.sh` on the owner's laptop (`inventory` reads the server and
changes nothing, `install` puts the first updater and hub in place and moves the old stack aside, `secrets` sends
the push credentials from the 1Password Environment). Afterwards the repository variable `HUB_SERVER_READY` is set
to `true`; until then `deploy_hub` publishes releases without calling the server.
