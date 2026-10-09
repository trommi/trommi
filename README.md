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

## Delivery

Every commit on `main` runs `.github/workflows/build.yml`. It finds which parts changed (a part's own folder, or
`core/`, or what pins the build), tests and builds those, and hands each built part to its deploy workflow. A deploy
workflow delivers the files the build made and tested; it builds nothing again. Each can also be started by hand with
the id of an earlier build run, to deliver that build once more.

| Part | Build makes | Deploy workflow | What it changes |
| --- | --- | --- | --- |
| Web app | `web-release`: the files the worker serves, the worker, its settings, `manifest.json`, `checksums.txt` | `deploy_web.yml` | the Cloudflare worker `trommi-app` at https://app.trommi.com |
| Connector | `connector-release`: four binaries, the plugin's archive, `manifest.json` | `deploy_connector.yml` | a GitHub release `connector-v<N>`, signed |
| iOS app | `ios-release`: the Rust core for iOS and its Swift bindings | `deploy_ios.yml` | a TestFlight build in the group "Intern" |

Secrets: each part has a GitHub environment of its name (`web`, `connector`, `ios`, `hub`) that holds only the way
into a 1Password Environment; every other secret is read from there by the one command that needs it (`op run`).
Pull requests run the build jobs and reach no secret and no deploy workflow.

**Signed releases** (connector, hub) have one form. `release/manifest.sh` writes `manifest.json`: product,
repository, version, tag, commit, and every file with its size and SHA-256. `release/sign.sh sign` signs the exact
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
