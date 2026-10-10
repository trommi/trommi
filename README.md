# Trommi

Chat and decision cards between a person and their Claude Code sessions, end-to-end encrypted.

## How the data is organised

The protocol is version 2: MLS (RFC 9420) distributes the keys, content is Trommi's own signed envelope. The whole of
it is [`spec/v2.md`](spec/v2.md); why it leaves the standard in five places is
[`spec/v2-deviations.md`](spec/v2-deviations.md). The web app in `app/web` speaks it through the shared Rust core
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
trails after thirty days. The table per stored thing is in `spec/v2.md`, section 14.
