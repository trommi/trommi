# zcrypto format, version 1

The exact bytes that `zcrypto.mjs` and `session-grants.mjs` read and write, and what `hub.mjs` refuses, so that a Swift (CryptoKit) and a native Linux client can be built against `vectors.json`. Design and threat model: `docs/krypto-konzept.md`; how hub and clients speak during pairing: `docs/pairing.md`; routes and JSON: README, "Hub v1: the wire protocol". Deviations from the concept are listed in section 14, the decisions of 2 October 2026 in section 16, session keys in section 19, the hub's checks in section 20.

This text describes format version 1 as amended by the security rules v1.1 and v1.1.1 (README, "Security rules"). If this file and the code disagree, the code is right and this file is a bug.

Status: implemented and tested, used by the hub (`hub/`), the app and the agent channel (`client/core`), not audited.

## 1. Primitives

| Purpose | Primitive | Notes |
| --- | --- | --- |
| Signature | Ed25519 (RFC 8032) | 32-byte public key, 64-byte signature |
| Key agreement | X25519 (RFC 7748) | 32-byte public key; an all-zero shared secret is rejected |
| AEAD | AES-256-GCM | 96-bit nonce, 128-bit tag appended to the ciphertext |
| KDF | HKDF-SHA-256 (RFC 5869) | extract and expand, always both |
| MAC | HMAC-SHA-256 | invite request only |
| Hash | SHA-256 | |

Nothing else is used. No primitive is implemented in JavaScript.

## 2. Canonical encoding

Everything that is signed, hashed or used as associated data is a byte string built by these rules. There is exactly one encoding of a value. Decoders reject anything else: unknown versions, types, roles, kinds, scopes or flags, unsorted lists, trailing bytes, truncated input.

| Notation | Meaning |
| --- | --- |
| `u8`, `u16`, `u32`, `u64` | unsigned integer, big-endian. `u64` values must be at most 2^53 - 1 (JavaScript's safe integers). |
| `bytes(n)` | exactly n raw bytes |
| `var16`, `var32` | a `u16` or `u32` length, then that many bytes |
| `str16(max)` | `var16` holding well-formed UTF-8, at most `max` bytes, not starting with U+FEFF (a byte order mark is refused, never stripped). No Unicode normalisation: the bytes are authoritative. |
| `a ‖ b` | concatenation |

Fields appear in the fixed order given below. There are no optional fields except where a flag, a count, a kind or a scope says so. Lists of ids are sorted ascending by their bytes (lexicographic, unsigned) and contain no duplicates.

Every top-level object starts with the version byte `0x01` and an object type byte:

| Type | Object | Type | Object |
| --- | --- | --- | --- |
| `0x01` | log entry | `0x08` | back link (room) |
| `0x02` | envelope | `0x09` | asset blob |
| `0x03` | pruned envelope | `0x0a` | wrapped asset key |
| `0x04` | sealed box | `0x0b` | device public keys |
| `0x05` | invite offer | `0x0c` | device secret file |
| `0x06` | invite request | `0x0d` | hub sign-in |
| `0x07` | invite reveal | `0x0e` | session grant (section 19) |
| | | `0x0f` | session back link (section 19) |

The envelope header (section 9) and the envelope body start with the version byte only; they have no type byte.

Text forms (links, JSON transport, `vectors.json`): byte strings travel as **base64url without padding** (RFC 4648 section 5). The decoder rejects padding, foreign characters and non-zero trailing bits. `vectors.json` uses lower-case hex instead, for readability. There is no signed JSON anywhere: JSON only carries finished byte strings.

## 3. Domain separation

A label is the ASCII string below followed by one `0x00` byte. No label contains `0x00`, so no label is a prefix of another label's use.

- `H(label, data…)` = SHA-256(label ‖ 0x00 ‖ data…)
- `Sign(key, label, message)` = Ed25519 over label ‖ 0x00 ‖ message
- `KDF(ikm, salt, label, context, n)` = HKDF-SHA-256 with `info` = label ‖ 0x00 ‖ context, n output bytes

`zcrypto.mjs` (`LABEL`):

| Label | Used for |
| --- | --- |
| `trommi/v1/device-id` | H: device id |
| `trommi/v1/log-entry` | H: hash of a log entry; the room id |
| `trommi/v1/log-sig` | Sign: log entry |
| `trommi/v1/sealed-box` | KDF: sealed box key and nonce |
| `trommi/v1/epoch-wrap` | associated data prefix of a wrapped room epoch secret |
| `trommi/v1/epoch-commit/key` | KDF: commitment to a room key |
| `trommi/v1/epoch-commit/hist` | KDF: commitment to a history key |
| `trommi/v1/back-link` | KDF: room back link key and nonce |
| `trommi/v1/sender-key` | KDF: per-sender message key (room and session scope) |
| `trommi/v1/envelope` | H: hash of an envelope |
| `trommi/v1/envelope-sig` | Sign: envelope |
| `trommi/v1/invite-id` | KDF: invite id from the link secret |
| `trommi/v1/invite-mac` | KDF: MAC key from the link secret; also the prefix of the MAC input |
| `trommi/v1/invite-commit` | H: commitment to the inviter's nonce |
| `trommi/v1/invite-offer` | H: hash of an offer body |
| `trommi/v1/invite-offer-sig` | Sign: offer |
| `trommi/v1/invite-request` | H: hash of a request body ‖ MAC |
| `trommi/v1/invite-request-sig` | Sign: request |
| `trommi/v1/invite-reveal-sig` | Sign: reveal |
| `trommi/v1/invite-code` | H: check code |
| `trommi/v1/asset-wrap` | KDF: asset key wrap key (the nonce is random, section 11) |
| `trommi/v1/recovery/sign` | KDF: recovery Ed25519 seed |
| `trommi/v1/recovery/kex` | KDF: recovery X25519 private key |
| `trommi/v1/hub-auth` | Sign: sign-in to the hub |
| `trommi/v1/object-id` | H: object id (section 9) |

`session-grants.mjs` (`LABEL`):

| Label | Used for |
| --- | --- |
| `trommi/v1/session-commit/key` | KDF: commitment to a session key |
| `trommi/v1/session-commit/hist` | KDF: commitment to a session history key |
| `trommi/v1/session-grant-sig` | Sign: session grant |
| `trommi/v1/session-grant` | H: grant hash |
| `trommi/v1/session-wrap` | associated data prefix of a wrapped session key |
| `trommi/v1/session-manifest` | H: manifest of a grant's wraps |
| `trommi/v1/session-back-link` | KDF: session back link key and nonce |

## 4. Device identity

A device (human device or agent) has an Ed25519 key pair and an X25519 key pair.

```
deviceId       = H("trommi/v1/device-id", signPub(32) ‖ kexPub(32))            32 bytes
device public  = 0x01 0x0b ‖ signPub(32) ‖ kexPub(32)                          66 bytes
device secret  = 0x01 0x0c ‖ signSeed(32) ‖ kexPrivate(32)                     66 bytes, agent key file only
```

`signSeed` is the RFC 8032 seed, `kexPrivate` the RFC 7748 scalar before clamping. In browsers the private keys are generated as non-extractable WebCrypto keys and never exist as bytes; the secret file form is for the agent's key file (mode 0600) and for the recovery key.

X25519 ignores bit 255 of a public key, so two keys that differ only there are the same key. Wherever exchange keys are compared (section 6), bit 255 is cleared first.

## 5. Sealed box (ZSEAL1)

X25519 + HKDF-SHA-256 + AES-256-GCM, in the pattern of HPKE base mode (RFC 9180). **Not** wire-compatible with RFC 9180.

```
sealed = 0x01 0x04 ‖ ephPub(32) ‖ ciphertext ‖ tag(16)

shared     = X25519(ephPrivate, recipientKexPub)          reject all-zero, reject invalid or small-order keys
okm        = KDF(shared, salt = ephPub ‖ recipientKexPub, "trommi/v1/sealed-box", context = empty, 44)
key, nonce = okm[0..32], okm[32..44]
ciphertext = AES-256-GCM(key, nonce, aad, plaintext)
```

The ephemeral key is fresh per box, so key and nonce are used once. `aad` is supplied by the caller and not transmitted.

A sealed box says nothing about who sealed it. Anyone can seal to a public key. Wherever a sealed box carries a key, the receiver checks the key against a commitment in a signed structure: the membership log (section 7) or the session's grant chain (section 19).

## 6. Membership log

An append-only list of entries. Wire form of an entry: `body ‖ signature(64)`.

```
body = 0x01 0x01 ‖ type u8 ‖ seq u32 ‖ prev bytes(32) ‖ time u64 ‖ signerKind u8 ‖ signer bytes(32) ‖ payload

entryHash = H("trommi/v1/log-entry", body)                 the signature is not part of the hash
signature = Sign(signer, "trommi/v1/log-sig", body)
roomId    = entryHash of entry 0 (genesis)
```

`seq` counts from 0. `prev` is the `entryHash` of the entry before (32 zero bytes for genesis). `time` is milliseconds since the Unix epoch as claimed by the signer; it is not checked. `signerKind`: 1 = device (`signer` = device id), 2 = recovery key (`signer` = device id of the recovery key pair). Any other value is refused.

```
member  = role u8 ‖ signPub(32) ‖ kexPub(32)                                   role: 1 human, 2 agent. 65 bytes, no name
epoch   = epoch u32 ‖ keyCommit(32) ‖ histCommit(32)
removed = count u16 ‖ ( deviceId(32) ‖ cutSeq u64 ‖ cutHash(32) ) × count       ascending by id, no duplicates
```

A member carries **no name** (v1.1, R8). Names are encrypted registers (`device/<device_id>`), never in the log.

Each removed device carries its **cut** (v1.1, R3): `cutSeq` and `cutHash` are the `seq` and `envelopeHash` (section 9) of that device's last envelope the remover had seen; `0` and 32 zero bytes if none. A `cutSeq` of 0 with a non-zero `cutHash` is refused. The cut is signed with the entry.

| Type | Payload | Signed by |
| --- | --- | --- |
| 1 genesis | `roomNonce(16) ‖ member ‖ recSignPub(32) ‖ recKexPub(32) ‖ epoch` | the founding device, which is `member` (role human); epoch is 1 |
| 2 add | `member ‖ inviteId(16)` (zeros if not by invite) | an active human device; or the recovery key, for a human device with `inviteId` zeros (the passphrase sign-in) |
| 3 remove | `removed ‖ epoch` (at least one device) | an active human device |
| 4 | retired, refused | (was: a new epoch on a schedule) |
| 5 recover | `member ‖ removed ‖ epoch ‖ newRecSignPub(32) ‖ newRecKexPub(32)` | the current recovery key |

Rules a verifier enforces, entry by entry (`applyEntry`):

- `seq` is the predecessor's plus one, `prev` matches, the signature verifies under the key the log itself gives the signer.
- Device signers must be active (added, not removed) and human **before** the entry is applied. **Any** human device may sign; there is no main device, and the founding device has no special standing after entry 0. Agents sign nothing. The recovery key signs type 5, and type 2 for a human device without an invite; nothing else.
- A new `epoch` number is the current one plus one. Removal always carries the new epoch: removal without rotation cannot be expressed. **Nothing else starts an epoch:** there is no rotation on a schedule, and an add does not change the key.
- An added device must be new: its id must not appear in the log before, removed members included, and neither its signing key nor its exchange key (compared with bit 255 cleared) may be used by any member before or by the recovery key. Removed devices cannot return. The recovery key can never be a member.
- In genesis, the recovery key must differ from the founding device's id and share neither half with it.
- Removed ids must be active.
- A non-zero `inviteId` appears in one add entry only.
- A recover entry enrols one human device and installs a new recovery key that differs from the old one and shares no key with any member. Its removed list contains **every active human device** and may also contain active agents (v1.1, R6: those a thief added). Agents not in the list stay members.

A log is trusted only relative to a room id that came from somewhere else: the invite link, or the device's own storage.

**Rollback and fork.** A device pins `{ seq, hash }` of the newest entry it accepted, the hashes of all entries and the position of the last recover entry (`pinOf`). A newly served log that is a shorter prefix is a rollback (`log-rollback`). A log that differs at some entry is a fork (`log-fork`), with one exception: if the first differing entry of the new log is a recover entry and the pinned branch holds no recover entry at or after that position, the result is `recovery-override` and the client must tell the user. Without the pinned hashes the exception cannot be judged and the result is a fork.

## 7. Room key epochs

An epoch secret is two independent random 32-byte values:

- `key`: the room key. **Human devices and the recovery key hold it; agents never do** (v1.1, R6). Agents hold session keys (section 19).
- `hist`: the history key. Same holders.

```
keyCommit  = KDF(key,  salt = empty, "trommi/v1/epoch-commit/key",  context = epoch u32, 32)
histCommit = KDF(hist, salt = empty, "trommi/v1/epoch-commit/hist", context = epoch u32, 32)
```

Both commitments stand in the signed log entry that starts the epoch.

**Wrap** (one per active human device and one for the recovery key, per epoch): a sealed box to the recipient's `kexPub`.

```
plaintext = 0x02 ‖ key(32) ‖ hist(32)
aad       = "trommi/v1/epoch-wrap" ‖ 0x00 ‖ roomId(32) ‖ epoch u32 ‖ recipientId(32)
```

The decoder also accepts `0x01 ‖ key(32)` (a key without history), but no room key wrap is made that way: `wrapEpochKey` refuses an agent as recipient. An agent's add entry comes with no wrap at all. After opening, the receiver recomputes the commitments and compares them with the log. A key that does not match is refused (`key-mismatch`).

**Back link** (one per epoch from 2 on): the previous epoch secret under the new history key.

```
okm        = KDF(hist_n, salt = roomId, "trommi/v1/back-link", context = n u32, 44)
key, nonce = okm[0..32], okm[32..44]
backLink   = 0x01 0x08 ‖ n u32 ‖ AES-256-GCM(key, nonce, aad, key_{n-1}(32) ‖ hist_{n-1}(32))       86 bytes
aad        = 0x01 0x08 ‖ roomId(32) ‖ n u32
```

`hist_n` encrypts exactly one message, so the derived nonce is used once. The opened secret is checked against the commitments of epoch n-1.

**Per-sender key.** Nobody encrypts messages with a scope key itself.

```
senderKey = KDF(scopeKey, salt = roomId, "trommi/v1/sender-key", context = scope ‖ epoch u32 ‖ senderId(32), 32)
scope     = 0x00                       key scope 0: scopeKey = the room key, epoch = the room key epoch
          | 0x01 ‖ sessionId(16)       key scope 1: scopeKey = that session's key, epoch = the session key epoch
```

## 8. Invite

```
link     = <app url> "#v1." b64u(utf8(hub address)) "." b64u(roomId) "." b64u(secret)      secret: 32 random bytes
inviteId = KDF(secret, salt = roomId, "trommi/v1/invite-id",  context = empty, 16)
macKey   = KDF(secret, salt = roomId, "trommi/v1/invite-mac", context = empty, 32)
```

The hub address is canonical (v1.1, R9): `https://` + lowercase host [+ `:port`], no path, no trailing slash; plain `http://` only for `localhost` and `127.0.0.1`. Anything else is refused, never normalised, in the link, the request and the hub sign-in.

Three signed messages cross the hub:

```
offer   = body ‖ Sign(inviter, "trommi/v1/invite-offer-sig", body)
  body  = 0x01 0x05 ‖ roomId(32) ‖ inviteId(16) ‖ role u8 ‖ expiresAt u64 ‖ commit(32) ‖ inviterId(32) ‖ logSeq u32 ‖ logHash(32)
  commit = H("trommi/v1/invite-commit", inviteId ‖ nonce(32))                nonce: 32 random bytes, kept by the inviter

request = body ‖ mac(32) ‖ Sign(newDevice, "trommi/v1/invite-request-sig", body ‖ mac)
  body  = 0x01 0x06 ‖ roomId(32) ‖ inviteId(16) ‖ hub str16(512) ‖ role u8 ‖ signPub(32) ‖ kexPub(32) ‖ offerHash(32)
  mac   = HMAC-SHA-256(macKey, "trommi/v1/invite-mac" ‖ 0x00 ‖ body)
  offerHash = H("trommi/v1/invite-offer", offer body)                         the body, without the signature

reveal  = body ‖ Sign(inviter, "trommi/v1/invite-reveal-sig", body)
  body  = 0x01 0x07 ‖ inviteId(16) ‖ nonce(32) ‖ requestHash(32)
  requestHash = H("trommi/v1/invite-request", request body ‖ mac)             without the signature

checkCode = decimal, six digits, zero-padded:
            (first 8 bytes of H("trommi/v1/invite-code", offer body ‖ request body ‖ mac ‖ nonce) as u64) mod 1 000 000
```

The request carries no name (v1.1, R8). The hashes and the check code cover the signed bodies, never an Ed25519 signature (R9), so they are the same on every platform.

Order: the inviter publishes the offer (which commits to the nonce) and hands over the link. The new device verifies the log against the room id in the link, verifies the offer against the log (signed by a human member, not expired, and its `logSeq`/`logHash` present in the served log), and sends the request. The inviter accepts the **first request with a valid MAC**, marks the invite used, and only then reveals the nonce. The new device checks the reveal against commitment and request hash. Both show the code. After the human confirmed it, the inviter writes the add entry (with `inviteId`) and, **for a human only**, seals the current epoch secret to the new device. An agent gets no room key; its session keys come with a session grant (section 19). The new device checks that the add entry that enrolled it names this invite and was signed by the inviter.

Enforced by the inviter's device, not the hub: expiry (`expiresAt`, ten minutes by default) at the time the request arrives; single use; five minutes between accepting the request and the confirmation; the confirmation is bound to the request whose code was shown. **The check code is mandatory for the human role;** the library offers no way around it. An agent that joins by a link has nobody to read a code, so the inviter passes `skipCheckCode` for the agent role (reasons and risk: `docs/pairing.md`). The code is still computed and can be shown.

## 9. Envelope

```
full   = 0x01 0x02 ‖ header var16 ‖ nonce(12) ‖ ciphertext var32 ‖ signature(64)
pruned = 0x01 0x03 ‖ header var16 ‖ nonce(12) ‖ ciphertextHash(32) ‖ signature(64)

header = 0x01 ‖ flags u8 ‖ roomId(32) ‖ epoch u32 ‖ keyScope u8 ‖ [ sessionId(16) ]          sessionId iff keyScope = 1
         ‖ sender(32) ‖ seq u64 ‖ prev(32) ‖ logSeq u32 ‖ logHash(32) ‖ recipient(32) ‖ time u64 ‖ kind u8
         ‖ seenCount u16 ‖ ( sender(32) ‖ seq u64 ‖ hash(32) ) × seenCount
         ‖ [ objectId(16) ‖ objectState u8 ‖ urgency u8 ‖ answeredAt u64 ]                    iff flags bit 1
         ‖ [ timelineKind u8 ‖ timelineScope u8 ‖ timelineRef(16) ]                           iff kind = 1
         ‖ blobCount u8 ‖ blobId(16) × blobCount

ciphertext     = AES-256-GCM(senderKey, nonce, aad = header, paddedBody)     includes the 16-byte tag
ciphertextHash = SHA-256(ciphertext)
envelopeHash   = H("trommi/v1/envelope", header ‖ nonce ‖ ciphertextHash)
signature      = Sign(sender, "trommi/v1/envelope-sig", envelopeHash)
```

**Header fields.**

- `flags`: bit 0 = "send a push", bit 1 = object block present. **No other bit is defined; any other set bit is refused** (`bad-format`). There is no `is_head` bit: whether an envelope is a head follows from its kind.
- `epoch`: the key epoch of the key scope: the room key epoch for scope 0, the session key epoch for scope 1.
- `keyScope`: 0 = the room key (human senders only), 1 = a session key, followed by the 16-byte `sessionId`. Other values are refused. Scope and session id are in the sender key (section 7), in the associated data and under the signature.
- `seq` starts at 1 per sender and room (0 is refused). `prev` is the `envelopeHash` of the sender's previous envelope, zeros for the first. One chain per sender covers all scopes.
- `logSeq`, `logHash` name the newest log entry the sender knew.
- `recipient` is a device id, or zeros for everyone. `time` is the sender's clock in milliseconds (a claim).
- `kind` (`KIND`): 1 timeline item, 2 object version, 3 answer, 4 permission request, 5 verdict, 6 status, 7 decide again. **Kind 0 and kinds above 7 are refused** (`KIND_MAX` = 7; the former kind 8 "scribble" no longer exists). Kind 1 is the only thread kind; every other kind is a head.
- `seen` lists, sorted by sender id, the newest envelope of each other sender the author had accepted, bounded (v1.1, R5): only senders active at `logSeq` whose head changed since the author's own previous envelope, **at most 64**. Receivers carry earlier values forward. A sender never lists itself.
- Object block, iff `kind` is 2, 3, 4, 5 or 7 (flags bit 1 must say exactly that; status and timeline items have none): `objectId`; `objectState` 1 open, 2 answered, 3 closed (withdrawn, expired or closed without an answer); `urgency` 0 low, 1 normal, 2 high, 3 critical; `answeredAt` milliseconds, 0 while open (display only, see section 20). Other values are refused. For a verdict, the request id is the `objectId`.
- Timeline, iff `kind` = 1, **binary** (v1.1): `timelineKind` 1 chat, 2 canvas (any value 1 to 255 is accepted, so a new timeline kind needs no hub change; 0 is refused); `timelineScope` 1 card, 2 session, 3 desk (others refused); `timelineRef` the 16-byte object id, session id or desk id. The JSON and SQLite text form is `card/<32 hex>`, `session/<32 hex>`, `desk/<32 hex>`, lowercase, nothing else accepted (`parseTimelineId`). A session timeline must be sent under key scope 1 with `sessionId` = `timelineRef`; a desk timeline under key scope 0.
- `blobCount` at most 255; each `blobId` is an attachment id.

Sizes: the fixed part from the version byte to `seenCount` is 190 bytes with key scope 0 and 206 with scope 1; each `seen` entry 72, the object block 26, the timeline 18, then `blobCount` 1 and 16 per blob.

**Object id.** `objectId` = first 16 bytes of `H("trommi/v1/object-id", creatorId(32) ‖ seq u64)`, where `seq` is the creator's envelope number of version 1 (`objectIdOf`).

The block and the timeline are in the header, so they are signed and are associated data: the hub reads them and cannot change them. Title, text, options and the chosen options are in the ciphertext. The nonce is 96 random bits.

**What is signed, what is associated data.** The whole header is the associated data of the encryption. The signature covers header, nonce and the hash of the ciphertext, through `envelopeHash`. The same hash links the chain. A pruned envelope (ciphertext deleted by retention, or a void record, section 20) therefore still verifies and still carries the chain.

**Body** (the plaintext). **The body has no kind byte** (v1.1): the kind is in the signed header, which is the associated data, so a body cannot claim another kind and there is no separate kind check.

```
body       = 0x01 ‖ bind var16 ‖ payload var32
paddedBody = body ‖ 0x00 …      up to the next size of: 256, 512, 1024, … 65536 bytes, then multiples of 65536
```

The padded length must be exactly the size the rule gives for the used length, and the padding must be all zero. `payload` is opaque to this layer (the application's UTF-8 JSON); a payload starting with a UTF-8 byte order mark (`EF BB BF`) is refused.

`bind` by kind (empty for the others):

```
answer (3)             = 0x01 ‖ objectId(16) ‖ versionHash(32) ‖ count u8 ‖ choice str16(256) × count        count ≤ 64
permission request (4) = 0x01 ‖ requestId(16) ‖ expiresAt u64
verdict (5)            = 0x01 ‖ requestId(16) ‖ requestHash(32) ‖ expiresAt u64 ‖ verdict u8                 1 allow, 2 deny
decide again (7)       = 0x01 ‖ objectId(16) ‖ previousHash(32) ‖ versionHash(32)
```

`versionHash` is the `envelopeHash` of the object version the human answered (it covers the options and everything else the human saw); an answer binds every chosen option (v1.1, R7). `requestId` is the permission request's object id; `requestHash` is the `envelopeHash` of the request. `previousHash` is the `envelopeHash` of the answer being taken back; decide again also binds the current version's hash.

**Thread items fetched later** (`openVerifiedEnvelope`). At sync time a client may receive only the pruned form of a thread item; `verifyEnvelope` checks it and advances the chain with its `envelopeHash`. When the full envelope is fetched later, `openVerifiedEnvelope(bytes, { state, secrets, envelopeHash })` recomputes `envelopeHash` from header, nonce and SHA-256 of the ciphertext, refuses anything else (`hash-mismatch`), verifies the signature under the sender's key from the log, and decrypts. It never touches the chains: nothing is decrypted that the chain did not vouch for.

**Receiver checks, in this order** (`verifyEnvelope`, then `openEnvelope`):

1. Format, versions, flags, kind, key scope, the object block and timeline grammar above, `seen` ≤ 64 and ascending, `seq` ≥ 1, room id.
2. `logSeq` is not beyond the receiver's log (`log-behind`: fetch the log first) and `logHash` equals the receiver's entry at `logSeq` (`log-fork` otherwise).
3. The sender was an active member once entry `logSeq` was applied (`not-member`). Key scope 0: the sender is human (`forbidden`) and `epoch` is the room epoch in force at `logSeq` (`wrong-epoch`). Key scope 1: the epoch is checked against the session's grant chain through the key the caller supplies (section 19).
4. Live acceptance (`freshness`, R3): an envelope in an older key epoch of its scope is refused (`wrong-epoch`) once the receiver learned of the current epoch more than two minutes ago. Clients use this wall-clock rule only for live envelopes on a device that stayed connected since it learned of the change; otherwise (catch-up after sleep, resync, history) the signed times decide: header `time` minus the signed `time` of the log entry or session grant that began epoch `h.epoch + 1` must be at most two minutes plus three minutes of skew (review 3). A stale envelope still advances its sender's chain; its body is never applied.
5. The sender is not removed in the receiver's current log (`removed-sender`). When reading history on purpose (`allowRemovedSender`), a removed sender is accepted only up to its cut: `seq` above `cutSeq` is `removed-sender`, and at `cutSeq` the `envelopeHash` must equal `cutHash` (`equivocation`, checked right after the signature).
6. Every sender in `seen` was active at `logSeq`, and is not the sender itself (`bad-format`).
7. The signature verifies under the sender's key from the log (`bad-signature`).
8. Chain: `seq` is the receiver's last accepted number for this sender plus one and `prev` matches. Otherwise `replay` (already accepted), `equivocation` (same number, other hash), `gap` (numbers missing; the error says which), `chain-break` (right number, wrong predecessor). A sender never seen before must start at 1 (or the caller allows a chain start).
9. `seen`: a hash that differs from the one the receiver holds under the same number is `equivocation`. A higher number than the receiver has is reported as withheld, not as an error.
10. Decrypt with the sender key of the named scope and epoch (`no-key` if the receiver has none: nothing advances). A pruned envelope is `pruned`. A body that fails to decrypt or decode under a valid signature and chain is **quarantined** (v1.1, R4): the chain advances, the result carries `quarantined` and no payload, so one broken body cannot stall a room. Only now does the receiver's chain advance.

## 10. Commands (the agent's gate)

After an envelope opened, an agent executes it only if all of this holds (`authoriseCommand`):

- The body was not quarantined.
- The sender is an active **human** device in the agent's current log.
- `recipient` is this agent's device id.
- The envelope's epoch is the current one of its key scope (for scope 1 the session's current key epoch), or the previous one and the agent learned of the new epoch at most two minutes ago. Optionally, `time` is not older than a caller-given maximum (`stale`).
- Timeline item: only on a chat timeline (`timelineKind` 1); it is a message, never refused for staleness, and marked late if the sender's `seen` of the agent (carried forward) is behind the agent's own last envelope.
- Only kinds 1, 3, 5 and 7 are commands; everything else is `not-a-command`.
- Answer: the object in `bind` exists and equals the header's `objectId`, `versionHash` equals its current version hash, it is open, at least one choice is named if it has options, and every choice is one of its options.
- Verdict: the request with `requestId` is still pending, `requestId` equals the header's `objectId`, its hash and expiry equal `requestHash` and `expiresAt`, and the agent's clock is not past `expiresAt`.
- Decide again: the object matches as for an answer, `versionHash` equals its current version hash, and `previousHash` is the hash of the answer currently in force.

Whether the terminal or the remote answer came first stays Claude Code's decision; this layer only says whether the remote one is authentic and fresh.

## 11. Assets (attachments)

```
blob    = head ‖ chunk_0 ‖ chunk_1 ‖ …
head    = 0x01 0x09 ‖ blobId(16) ‖ chunkSize u32 (= 65536)                              22 bytes
chunk_i = AES-256-GCM(assetKey, nonce_i, aad = head, plaintext[i × 65536 …])            up to 65536 + 16 bytes
nonce_i = 0x00 0x00 0x00 ‖ i u64 ‖ last u8                                              last = 1 for the final chunk, else 0
```

`assetKey` is 32 fresh random bytes per asset and is used for nothing else, so counter nonces are safe (STREAM construction, as in age and Tink). An empty asset has one empty chunk. Every chunk but the last is full. A blob cut at a chunk boundary fails because its last chunk does not carry the final mark. `assetKey`, SHA-256 of the blob, name and type belong in the encrypted message payload; the header only lists `blobId`.

**Asset key under the room key** (for blobs that live outside a message, such as the canvas):

```
wrapKey = KDF(roomKey, salt = roomId, "trommi/v1/asset-wrap", context = epoch u32 ‖ blobId(16), 32)
nonce   = 12 RANDOM bytes, fresh per wrap
wrapped = 0x01 0x0a ‖ epoch u32 ‖ blobId(16) ‖ nonce(12) ‖ AES-256-GCM(wrapKey, nonce, aad, assetKey(32))      82 bytes
aad     = 0x01 0x0a ‖ roomId(32) ‖ epoch u32 ‖ blobId(16)
```

> **The wrap nonce is random and travels in the wrap. It is not derived.** The wrap key depends only on room key, epoch and blob id, so wrapping the same blob twice (a re-wrap, a retry, two devices) uses the same key. A nonce derived from the same inputs would then repeat under that key and break AES-GCM. Never derive this nonce from the KDF (v1.1, R9, C12). The derived nonces elsewhere (sealed box, back links) are safe only because their key encrypts exactly one message.

Link form: `<blob url> "#a1." b64u(blobId) "." b64u(assetKey)`. Whoever has the link reads the asset.

## 12. Recovery code

32 random bytes, shown as 52 Crockford base32 characters (`0123456789ABCDEFGHJKMNPQRSTVWXYZ`) in thirteen groups of four, joined by `-`. The bits are read most significant first; the last character holds one data bit followed by four zero bits. Input is accepted in any case, with spaces or hyphens, with `O` read as `0` and `I`, `L` as `1`; a last character with non-zero padding bits is refused. There is no checksum: a mistyped code yields a key pair that the log does not know.

```
recovery signSeed   = KDF(code(32), salt = empty, "trommi/v1/recovery/sign", context = empty, 32)
recovery kexPrivate = KDF(code(32), salt = empty, "trommi/v1/recovery/kex",  context = empty, 32)
```

No password stretching: the input has 256 bits of entropy. The code is mandatory: a room cannot be founded without one (`createRoom` refuses with `recovery-required`; the genesis entry has no encoding for "none").

Recovery (`recoverRoom`): derive the key pair, open the recovery key's wrap of the current epoch, sign a recover entry (section 6) that enrols the new device, removes every human device and any agents the human chose to remove, wrap the new epoch for the new device and the new recovery key, write the back link. Agents that stay hold no room key and need no wrap; their sessions are stale until a human device re-keys them (section 19).

## 13. Key schedule at a glance

```
link secret ──KDF──▶ invite id, MAC key
recovery code ──KDF──▶ recovery Ed25519 seed, recovery X25519 key
room epoch n:  key_n  (random) ──KDF──▶ keyCommit_n (in the log)
                                ──KDF──▶ senderKey(scope 0, n, device) ──▶ AES-256-GCM over bodies, random nonce
                                ──KDF──▶ asset wrap key (n, blobId)     ──▶ AES-256-GCM, random nonce
               hist_n (random) ──KDF──▶ histCommit_n (in the log)
                                ──KDF──▶ back link key and nonce ──▶ encrypts key_{n-1} ‖ hist_{n-1}
               (key_n, hist_n) ──sealed box──▶ each human device and the recovery key
session S, epoch m:  key_m (random) ──KDF──▶ keyCommit (in the grant)
                                     ──KDF──▶ senderKey(scope 1 ‖ S, m, device)
                     hist_m (random) ──KDF──▶ histCommit (in the grant), session back link
                     (key_m, hist_m) ──sealed box──▶ humans, recovery key, agents with history
                     key_m           ──sealed box──▶ agents without history
asset:    assetKey (random) ──▶ AES-256-GCM over 64 KiB chunks, counter nonce
```

## 14. Deviations from `docs/krypto-konzept.md`, and choices where it was open

Deviations:

1. **A history key beside each scope key.** The concept lets each new room key encrypt its predecessor and relies on the hub not handing that chain to the wrong members. Here the back link is encrypted under a second key that only its intended holders receive.
2. **Key commitments in signed structures.** A sealed box does not name its sender, so the hub could seal a key of its own to a member. Each room epoch entry and each session grant therefore commits to its keys and receivers check.
3. **Removal carries the rotation.** One entry removes and starts the new epoch, instead of two entries that a hub could separate.
4. **The signature covers the hash of the ciphertext,** not the ciphertext, so that pruned envelopes stay verifiable. Equivalent while SHA-256 is collision resistant.
5. **Command bindings are inside the ciphertext.** The bindings are still signed, through the ciphertext hash.
6. **An answer is bound to the hash of the object version** rather than to a separate hash of the options. That hash covers the options and the text. The chosen options are additionally checked against the object's option keys.
7. **Invite link:** the hub address is base64url-encoded inside the fragment, because addresses contain dots. The role is not in the link; it is in the signed offer and under the request's MAC.
8. **A signed invite offer** is an added message. It carries the commitment that commit-then-reveal needs, and lets the new device check who invites before it sends its keys.
9. **Sealed box nonce** is derived by HKDF together with the key instead of being transmitted; the key is single-use.
10. **Device ids are 32 bytes** (hash of both public keys). The concept does not fix a size.
11. **Recovery removes every human device** and may remove agents (v1.1); agents not removed stay members.
12. **Wrapped asset key and asset link** are additions. In the concept an asset key only travels inside a message.
13. **Kind and timeline are in the cleartext header** (4 October 2026), and the body has no kind (v1.1). The hub sees whether an envelope is a head, its kind, and for thread items which timeline it belongs to, so it can page timelines and keep chat apart from strokes without reading content.
14. **Agents hold no room key** (v1.1, R6). Each agent session has its own key in a signed grant chain (section 19); agents read only the sessions assigned to them.
15. **No names in signed structures** (v1.1, R8). Member entries and join requests carry none.

Choices where the concept was open or ambiguous:

- "An entry of the recovery key beats any entry of a device" is implemented as the `recovery-override` rule in section 6, surfaced to the user, never applied silently.
- "The previous epoch counts for two more minutes" is measured from the moment the receiver learned of the new epoch (hub: the arrival of the entry or grant). The sender's `time` is not trusted for this.
- A sender that was removed is refused by default even for envelopes it sent before the removal; reading them as history is an explicit option, bounded by the signed cut.
- Padding sizes (section 9).
- Expiry of an invite applies when the request arrives; the human then has five minutes to compare the code.
- The recovery key signs recover entries and the add of a human device without an invite. Changing the recovery code without a recovery is not expressible in version 1.
- The genesis entry is not countersigned by the recovery key.

Not covered by version 1: the canvas version counter, encrypted snapshots as a format, a streaming interface for assets (there is whole-buffer encryption and per-chunk decryption), any ratchet (decided against).

## 15. Assumptions and limits

- **No forward secrecy, no post-compromise security,** by decision. Whoever holds a scope key and the ciphertexts reads that epoch; with a history key, all earlier epochs of that scope. Whoever holds a device's X25519 key opens every future key sealed to it until the device is removed.
- **Every holder of a scope key can read every message of that scope and epoch.** Per-sender keys separate nonces, not readers. Only signatures separate senders. Agents hold only their sessions' keys.
- **Keys exist as bytes in the client's memory** (they must be wrapped for others). Device private keys can be non-extractable; seeds imported from a key file or a recovery code pass through memory as bytes. JavaScript cannot wipe memory.
- **State is the caller's:** the pinned log head, the per-sender chains, the invite record, the grant chains and the secrets must be stored durably and atomically. A device that loses its chain state and sends again produces `equivocation` at every receiver; it then needs a new identity.
- **A fork is only noticed when forked devices exchange a message** or a log. The hub can always withhold the end of a log or of a chain; that shows through `log-behind` and `seen`, not earlier.
- **The cut is the remover's view.** It fixes which envelopes of a removed device count as history; envelopes the remover had not seen are beyond it and refused.
- **Clocks:** expiry and freshness use the local clock of the device that enforces them. Header `time` and `answeredAt` are claims.
- **GCM limits:** random 96-bit nonces under one sender key per epoch; the library does not count messages. Stay far below 2^32 per sender and epoch.
- **Ed25519 verification rules** (non-canonical encodings, small-order keys) differ slightly between libraries. Hashes never include signatures, so a re-encoded signature cannot change a chain; implementations should still be compared on the vectors.
- **The X25519 key in an invite request is not proven to be owned.** A wrong key only locks the new device out.
- **Long room epochs.** Without rotation on a schedule a room epoch lasts until someone is removed. A leaked room key opens everything from the last removal to the next.
- **Six digits** bound an active attacker with a stolen link to a one-in-a-million chance per attempt; each attempt burns an invite.
- **Whoever serves the JavaScript can use the keys** (concept section 9). This library does not change that.

## 16. Decisions of 2 October 2026, and where they are in the format

| Decision | In the format |
| --- | --- |
| Curve25519 on all devices | Section 1: Ed25519 and X25519 only. No P-256 anywhere, no algorithm field to negotiate. |
| Any of the human's devices may change members; the recovery code stands above all | Section 6: any active human device signs add and remove. Only the recovery key signs recover, and a recover entry overrides a device branch (`recovery-override`). |
| ONE room key per epoch, no ratchet, renewed only on removal | Sections 6 and 7: entry type 4 is retired and refused; remove and recover are the only entries that carry a new epoch. |
| Recovery removes the human's devices and keeps the agents | Section 6: the removed list of a recover entry holds every active human device. Amended by v1.1 (R6): it may also hold agents. |
| Recovery code mandatory; check code mandatory for humans | Section 12 and section 8. |
| Urgency and card status readable for the hub, contents ciphertext; answered cards deleted after 30 days | Section 9: object block with id, state, urgency, answer time; pruned envelope. Section 20: retention. |
| Web client from a fixed address of its own | Not a wire format. The invite link's `<app url>` is that address; the hub address travels inside the fragment. |
| Speech goes through the hub | Not in this format: speech is not end-to-end encrypted. The hub sees the audio and the text of what is dictated or read aloud. |

## 17. Signing in to the hub

```
signed = body ‖ Sign(device, "trommi/v1/hub-auth", body)
  body = 0x01 0x0d ‖ roomId(32) ‖ hub str16(512) ‖ deviceId(32) ‖ challenge(32)
```

The hub hands out `challenge` (32 random bytes, two minutes, one use). `deviceId` names an active member, or the current recovery key pair of the room. The hub verifies the signature under the key the membership log gives that id and issues a token for ten minutes, bound to the device. A removed device is refused (`not-member`); a token of a replaced recovery key stops working. The room id and the canonical hub address are under the signature, so a signature made for one hub is useless at another.

## 18. Vectors

`vectors.json` is generated by `node crypto/test.mjs --write-vectors` from fixed seeds and compared byte for byte on every test run. One room is played through, in this order:

| Part | What a second implementation checks |
| --- | --- |
| `encoding`, `signature` | base64url, one labelled hash, one HKDF, one labelled signature |
| `devices` | key pairs from fixed seeds (phone, laptop, agent, tablet, helper): public keys, device id, public form, key file |
| `recovery` | code → raw bytes → key pair and id |
| `sealedBox` | a sealed box with a fixed ephemeral key |
| `room` | genesis entry, room id, epoch 1 secret and commitments, one wrap for the phone and one for the recovery key |
| `invites` | three invites: laptop (human, check code compared, with wrap and the room key it opens), agent (no check code, no wrap), helper (agent, invited by the laptop, no wrap). Each with link, secret, invite id, offer, offer hash, request, request hash, reveal, check code, add entry |
| `envelopes` | a fixed session id and session key; sender keys (phone room scope, phone and agent session scope); chat (phone 1, session scope, timeline `session/5e…5e`), card (agent 1, session scope, object block, urgency high, one blob, push), answer (phone 2, session scope, chained to phone 1), desk (phone 3, room scope, canvas timeline `desk/d5…d5`); each with header, nonce, ciphertext, ciphertext hash, signature, hash, bytes and `hubSees`; two pruned forms; `afterRecovery`: the tablet's first envelope, session scope, opened by the agent |
| `binds` | answer, verdict, decide again, permission request |
| `hubAuth` | a signed hub sign-in by the agent |
| `epochChanges.remove` | the laptop removes the helper: entry (with an empty cut), epoch 2 secret, wraps for phone, laptop and the recovery key, back link |
| `epochChanges.recover` | the recovery: phone and laptop out, tablet in, agent kept; the wrap the code opened, epoch 3 secret, wraps for the tablet and the new recovery key, back link, the new code |
| `log` | all six entries with body, signature and hash; three entries that must be refused (retired type 4, an entry signed by an agent, a replay) |
| `assets` | a small and a two-chunk asset, a wrapped asset key (random nonce from the seeded generator), an asset link |

Session grants, session wraps and session back links (section 19) have no vectors in `vectors.json`; they are covered by `crypto/session-grants-test.mjs`.

Randomness in the vectors comes from the generator described in the file's `rng` field; `rngCalls` in a section lists what is drawn, in order.

## 19. Session keys: grants, wraps, manifest, back links (`session-grants.mjs`)

Each agent session has its own key, independent of the room key (v1.1, R6). Holders: every active human device and the recovery key, always; and the agents the newest grant assigns. A session is created by its first grant; `sessionId` is 16 random bytes chosen by the granting device. Session-scope envelopes (key scope 1) are encrypted under sender keys derived from it (section 7).

**Secret and commitments.** A session secret has the shape of a room epoch secret: `{ epoch, key(32), hist(32) }`, both random.

```
keyCommit  = KDF(key,  salt = empty, "trommi/v1/session-commit/key",  context = sessionId(16) ‖ epoch u32, 32)
histCommit = KDF(hist, salt = empty, "trommi/v1/session-commit/hist", context = sessionId(16) ‖ epoch u32, 32)
```

**Grant.**

```
grant = body ‖ Sign(signer, "trommi/v1/session-grant-sig", body)
  body = 0x01 0x0e ‖ roomId(32) ‖ sessionId(16) ‖ grantNumber u32 ‖ previousGrantHash(32) ‖ sessionKeyEpoch u32
         ‖ flags u8 ‖ agentCount u16 ‖ agentId(32) × agentCount ‖ keyCommit(32) ‖ histCommit(32)
         ‖ manifestHash(32) ‖ logSeq u32 ‖ logHash(32) ‖ time u64 ‖ signerId(32)
grantHash = H("trommi/v1/session-grant", body)
```

`flags`: bit 0 = `with_history` (some assigned agent got the history key in this grant); other bits are refused. Agent ids ascending, no duplicates. `logSeq`, `logHash` name the log entry the signer built the grant on.

**Wrap** (one per recipient): a sealed box (section 5) to the recipient's `kexPub`.

```
plaintext = 0x02 ‖ key(32) ‖ hist(32)     human devices, the recovery key, agents given the history
plaintext = 0x01 ‖ key(32)                agents without history
aad       = "trommi/v1/session-wrap" ‖ 0x00 ‖ roomId(32) ‖ sessionId(16) ‖ epoch u32 ‖ recipientId(32)
```

After opening, the receiver checks the key (and the history key if present) against the commitments of that epoch in the grant chain (`key-mismatch`).

**Manifest.** The grant commits to exactly which wraps were made:

```
manifestHash = H("trommi/v1/session-manifest", for each recipient ascending by id: recipientId(32) ‖ SHA-256(sealed))
```

**Session back link** (with every grant that raises the epoch, from epoch 2 on):

```
okm        = KDF(hist_n, salt = roomId ‖ sessionId, "trommi/v1/session-back-link", context = n u32, 44)
key, nonce = okm[0..32], okm[32..44]
backLink   = 0x01 0x0f ‖ sessionId(16) ‖ n u32 ‖ AES-256-GCM(key, nonce, aad, key_{n-1}(32) ‖ hist_{n-1}(32))     102 bytes
aad        = 0x01 0x0f ‖ roomId(32) ‖ sessionId(16) ‖ n u32
```

The opened secret is checked against the commitments of epoch n-1.

**Validity rules** (`applyGrant`, each grant against the session's state before it and the verified log):

- Room id matches; `logSeq` is in the verifier's log (`log-behind`) and `logHash` equals that entry (`log-fork`).
- The signer is an active human device at `logSeq`, or the recovery key valid at `logSeq` (the one installed by the newest genesis or recover entry at or before `logSeq`). The signature verifies under that key.
- The first grant has `grantNumber` 0, `previousGrantHash` zeros and epoch 1. Each later grant has the same `sessionId`, `grantNumber` + 1 and `previousGrantHash` = the predecessor's `grantHash`.
- The epoch is the predecessor's (a re-seal) or the predecessor's + 1 (a rotation). A re-seal must carry the same commitments, and **may only add agents**: if an assigned agent loses the session, the key must change (v1.1.1, B01).
- **No backdating across a member change** (v1.1.1, B02/A1). A member change is a remove or recover entry. If one lies between the predecessor's `logSeq` and this grant's, this grant's `logSeq` must not be the lower one, and **the grant must rotate** (a new epoch).
- Every assigned agent is an active agent at `logSeq`.
- **Stale sessions.** A session whose newest grant's `logSeq` is below the newest member change the verifier knows is stale (`grantIsStale`): its keys still read, but **nobody sends under them**; a human device re-keys the session with a new grant on the current log (a new epoch). A removed device can only name a log position before its own removal, so any grant it makes is stale on arrival.

The hub checks the same, and more (section 20).

## 20. The hub (`hub.mjs`)

The hub holds no key and decides nothing about content. It verifies what it can from signed headers and the log, as the second line behind every client. Every refusal is a `ZError` with a stable `code` (HTTP status: README, "Errors").

**Log entries** (`postEntry`, `found`): the entry must apply (`applyEntry`: `bad-entry`, `bad-signature`, `bad-format`) and not be in the log already (`replay`); a room is founded once (`room-exists`). The wraps must be exactly one per wanted recipient, of the size of a `0x02` room key wrap (`incomplete`, `bad-format`): for genesis and remove and recover, every active human device after the entry and the recovery key; for a human's add, that device; for an agent's add, none. A remove or recover must bring the 86-byte back link of the new epoch (`incomplete`); any other entry must not. An add naming an invite must be its outcome: the device whose request the inviter revealed, the invited role, signed by the inviter (`bad-invite`). A removal ends the removed devices' tokens, streams and leases at once.

**Grants** (`acceptGrant`): the grant must apply (section 19: `bad-grant`, `bad-signature`, `log-behind`, `log-fork`). Then `stale-grant` if the signer is no longer an active human device and not the current recovery key, or if the grant is stale (it names a log from before the newest removal or recovery); `bad-grant` if an assigned agent is no longer a member. The sealed session keys must be exactly one per active human device, the recovery key and each assigned agent, with the `0x02` size for humans and the recovery key, the `0x01` size for agents (either, per agent, if the history flag is set), and their manifest hash must equal the grant's (`bad-grant`). A grant that raises the epoch must bring the 102-byte session back link of that session and epoch (`incomplete`); any other must not.

**Envelopes** (`postEnvelope`): posted full, by the signed-in device itself (`wrong-sender`); an agent only with its current lease generation (`lease-lost`). Then `verifyEnvelope` (section 9, without committing). Then the write rules:

- Key scope 1: the session exists and an agent sender is assigned to it (`forbidden`); the session is not stale (`stale-session-key`: retry the same bytes after the new grant); the epoch is known and, if older, within two minutes of the next epoch's arrival at the hub (`wrong-epoch`). Key scope 0: human senders only (`forbidden`); an older epoch within two minutes of the next epoch's arrival (`wrong-epoch`).
- Who may write what (R1): a new object's id must be `objectIdOf(sender, seq)`; permission requests come from agents; an object keeps its kind and its key scope; only its creator writes new versions (memos: any human device). Answers, decide again and verdicts come from human devices, addressed to the object's creator, under the object's key, a verdict to a permission request and an answer or decide again to an object version. Timeline items: a human's chat on a session goes to its assigned agent; a card's chat comes from its creator or from a human writing to the creator, under the card's key; desks are for human devices. Status bodies are at most 4 KiB (`too-large`). An unknown kind is `bad-format`.
- `send_push` is honoured only on object versions and permission requests.

**Void records** (v1.1.1, review 2 #5). If an envelope passed `verifyEnvelope` (signature, membership, and exactly the sender's next `seq` with the right `prev`) and is then refused with a code in `VOIDABLE` = { `forbidden`, `wrong-epoch`, `too-large`, `bad-format` }, the hub stores its pruned form (`0x01 0x03`: header, nonce, ciphertext hash, signature) as a void record that takes the next envelope number, advances the sender's chain, and refuses with `voided: true`. Void records are served like pruned envelopes, with their `voidCode`; they bind no object, timeline or attachment. Receivers verify the header chain and apply nothing. The void flag is unsigned (the hub's word): a receiver accepts another sender's void silently only when it can re-check the code from the signed header (`wrong-epoch`: the header epoch is not the scope's current one; `forbidden`: an agent under the room key, or in a session it was not assigned to at that epoch), and otherwise raises `hub-voided-other` (review 3). A device never signs a second envelope under a number it used. Retryable refusals (`unauthorised`, `gap`, `stale-session-key`, `lease-lost`, rate limits) take no number.

**Ephemeral envelopes** (`checkEphemeral`): relayed only if signed by the signed-in device, from an active member, under a key it may use now; the chain is neither checked nor advanced, and nothing is stored.

**Retention** (`prune`, 30 days): an object's retention clock is the **hub's own arrival time (`received_at`) of the object's newest head**, if that head's state is answered or closed; a newer open head (a reopen) cancels it. The sender's `answeredAt` is display only and never moves the clock. 30 days later, every envelope whose object block names that object is replaced by its pruned form; chains still verify.
