# Trommi

Chat and decision cards between a person and their Claude Code sessions, end-to-end encrypted.

## How the data is organised

```
Room
├── Member log (signed, chained)              who belongs: readable by the hub, no names in it
│   ├── human devices, agent devices          a role and two public keys each
│   ├── the recovery key                      its public keys
│   └── the commitments of each room key epoch
├── Invites (beside the log)                  signed offer, request and reveal; the link's secret never reaches
│                                             the hub; both devices compute the check code and show it
├── Room key per epoch                        key + history key; human devices and the recovery key only
│   ├── one sealed copy per holder
│   └── back link                             a new epoch opens the one before; a new epoch only when a
│                                             device is removed or the room is recovered
├── Files                                     encrypted blobs, uploaded on their own; one random key per file;
│                                             key, hash, name and type only inside the body that names the file
│
├── ROOM LEVEL                                envelopes under the room key; agents read none of it
│   ├── registers written by human devices    a current value each
│   │   crown, kit, room_snapshot, desk/<id>, session/<session>, session_history/<session>,
│   │   draft/<card>, snooze/<card>, duck/<card>, scribble_snapshot/<timeline>
│   ├── device/<id> of each human device      only that device writes it (its name, platform)
│   ├── notes                                 objects; any human device writes a version, a closed one deletes
│   └── Scribble Board                        one timeline per desk, one for "All desks"
│       └── items: strokes (a stroke, a piece of a stroke still being drawn, a text, sticky or voice
│           note, a picture), move, erase, send_away
│
└── SESSION                                   its own key per epoch; made by its first grant: by a human
    │                                         device, or by an agent for itself alone (a child session)
    ├── grants (signed chain)                 readable by the hub: which agents hold the session (one or
    │                                         several), with or without history
    ├── sealed session key per holder         every human device, the recovery key, the assigned agents
    ├── goals/<session>                       a register human devices write: the desk's goals for the agent
    ├── the agent's registers                 profile, heard, status_line/<id>, alert/<envelope>, its device/<id>
    ├── the session's chat (timeline)         messages (also a sent note's words and files), the mirrored
    │                                         terminal turn, a selection sent from the Scribble Board (a picture)
    └── objects
        ├── card                              versions (question, options, revisions; its agent only)
        │   ├── answer                        the choice, notes, drawings
        │   ├── decide again                  an answer taken back
        │   └── the card's chat (timeline)
        ├── permission request + verdict
        └── published                         files an agent releases

Account (email)                               kept by the hub beside the room, not part of its content
├── sealed copy under the password
├── sealed copy under the Emergency Kit words
└── sealed copy per passkey
        each opens the room's recovery code → the recovery key → a new device adds itself to the member log
```

Everything marked "envelopes" above is one unit: a signed, encrypted envelope, chained per sender, of seven kinds
(timeline item, object version, answer, permission request, verdict, status, decide again). A register is the current
value of a key written with status envelopes. A timeline is chat or scribble and belongs to a card, a session or a
desk. Log entries, invites, grants, sealed keys, back links and files are not envelopes.

**What a hub reads of an envelope** (its cleartext header): the room, whether it is under the room key or a session
key (and which session), the key epoch, the sender with its running number and chain link, the position in the member
log, the recipient, the sender's time, the kind, what the sender had seen, an object's id, state, urgency and answer
time, a timeline's kind and id, the ids of the files it names, and whether it asks for a push. Beside the header: the
nonce, the padded size, the signature and when it arrived.

**What a hub never reads**: the body. Texts, card content, choices, verdicts, register keys and values, strokes, file
keys, file names and types.

**What a hub keeps of its own**, outside the tree: the account (email, a slow hash of the login key, the sealed copies,
passkey public keys), push registrations, Live Activity tokens, one lease per running agent process, share links for
files (file id, a hash of the link's secret, expiry; the file's key stays in the link) and usage figures.

**What goes away**: thirty days after an object is answered or closed, a hub keeps of its envelopes and of its card's
chat only header, nonce, hash and signature, and deletes its files. Registers, session chats and Scribble Board items
are kept.

The bytes are in [`spec/FORMAT.md`](spec/FORMAT.md).
