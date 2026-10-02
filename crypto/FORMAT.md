# zcrypto format, version 1

The exact bytes that `zcrypto.mjs` reads and writes, so that a Swift (CryptoKit) and a native Linux client can be built against `vectors.json`. Design and threat model: `docs/krypto-konzept.md`. Deviations from that concept are listed in section 14.

Status: implemented and tested, not wired into the product, not audited.

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

Everything that is signed, hashed or used as associated data is a byte string built by these rules. There is exactly one encoding of a value. Decoders reject anything else: unknown versions, types, roles or flags, unsorted lists, trailing bytes, truncated input.

| Notation | Meaning |
| --- | --- |
| `u8`, `u16`, `u32`, `u64` | unsigned integer, big-endian. `u64` values must be at most 2^53 - 1 (JavaScript's safe integers). |
| `bytes(n)` | exactly n raw bytes |
| `var16`, `var32` | a `u16` or `u32` length, then that many bytes |
| `str16(max)` | `var16` holding well-formed UTF-8, at most `max` bytes. No Unicode normalisation: the bytes are authoritative. |
| `a ‖ b` | concatenation |

Fields appear in the fixed order given below. There are no optional fields except where a flag or a count says so. Lists of ids are sorted ascending by their bytes (lexicographic, unsigned) and contain no duplicates.

Every top-level object starts with the version byte `0x01` and an object type byte:

| Type | Object | Type | Object |
| --- | --- | --- | --- |
| `0x01` | log entry | `0x07` | invite reveal |
| `0x02` | envelope | `0x08` | back link |
| `0x03` | pruned envelope | `0x09` | asset blob |
| `0x04` | sealed box | `0x0a` | wrapped asset key |
| `0x05` | invite offer | `0x0b` | device public keys |
| `0x06` | invite request | `0x0c` | device secret file |

Text forms (links, JSON transport, `vectors.json`): byte strings travel as **base64url without padding** (RFC 4648 section 5). The decoder rejects padding, foreign characters and non-zero trailing bits. `vectors.json` uses lower-case hex instead, for readability. There is no signed JSON anywhere: JSON only carries finished byte strings.

## 3. Domain separation

A label is the ASCII string below followed by one `0x00` byte. No label contains `0x00`, so no label is a prefix of another label's use.

- `H(label, data…)` = SHA-256(label ‖ 0x00 ‖ data…)
- `Sign(key, label, message)` = Ed25519 over label ‖ 0x00 ‖ message
- `KDF(ikm, salt, label, context, n)` = HKDF-SHA-256 with `info` = label ‖ 0x00 ‖ context, n output bytes

| Label | Used for |
| --- | --- |
| `trommi/v1/device-id` | H: device id |
| `trommi/v1/log-entry` | H: hash of a log entry; the room id |
| `trommi/v1/log-sig` | Sign: log entry |
| `trommi/v1/sealed-box` | KDF: sealed box key and nonce |
| `trommi/v1/epoch-wrap` | associated data prefix of a wrapped epoch secret |
| `trommi/v1/epoch-commit/key` | KDF: commitment to a room key |
| `trommi/v1/epoch-commit/hist` | KDF: commitment to a history key |
| `trommi/v1/back-link` | KDF: back link key and nonce |
| `trommi/v1/sender-key` | KDF: per-sender message key |
| `trommi/v1/envelope` | H: hash of an envelope |
| `trommi/v1/envelope-sig` | Sign: envelope |
| `trommi/v1/invite-id` | KDF: invite id from the link secret |
| `trommi/v1/invite-mac` | KDF: MAC key from the link secret; also the prefix of the MAC input |
| `trommi/v1/invite-commit` | H: commitment to the inviter's nonce |
| `trommi/v1/invite-offer` | H: hash of an offer |
| `trommi/v1/invite-offer-sig` | Sign: offer |
| `trommi/v1/invite-request` | H: hash of a request |
| `trommi/v1/invite-request-sig` | Sign: request |
| `trommi/v1/invite-reveal-sig` | Sign: reveal |
| `trommi/v1/invite-code` | H: check code |
| `trommi/v1/asset-wrap` | KDF: asset key wrap key and nonce |
| `trommi/v1/recovery/sign` | KDF: recovery Ed25519 seed |
| `trommi/v1/recovery/kex` | KDF: recovery X25519 private key |

## 4. Device identity

A device (human device or agent) has an Ed25519 key pair and an X25519 key pair.

```
deviceId       = H("trommi/v1/device-id", signPub(32) ‖ kexPub(32))            32 bytes
device public  = 0x01 0x0b ‖ signPub(32) ‖ kexPub(32)                          66 bytes
device secret  = 0x01 0x0c ‖ signSeed(32) ‖ kexPrivate(32)                     66 bytes, agent key file only
```

`signSeed` is the RFC 8032 seed, `kexPrivate` the RFC 7748 scalar before clamping. In browsers the private keys are generated as non-extractable WebCrypto keys and never exist as bytes; the secret file form is for the agent's key file (mode 0600) and for the recovery key.

## 5. Sealed box (ZSEAL1)

X25519 + HKDF-SHA-256 + AES-256-GCM, in the pattern of HPKE base mode (RFC 9180). **Not** wire-compatible with RFC 9180.

```
sealed = 0x01 0x04 ‖ ephPub(32) ‖ ciphertext ‖ tag(16)

shared     = X25519(ephPrivate, recipientKexPub)          reject all-zero
okm        = KDF(shared, salt = ephPub ‖ recipientKexPub, "trommi/v1/sealed-box", context = empty, 44)
key, nonce = okm[0..32], okm[32..44]
ciphertext = AES-256-GCM(key, nonce, aad, plaintext)
```

The ephemeral key is fresh per box, so key and nonce are used once. `aad` is supplied by the caller and not transmitted.

A sealed box says nothing about who sealed it. Anyone can seal to a public key. Wherever a sealed box carries a key, the receiver checks the key against a commitment in the signed membership log (section 7).

## 6. Membership log

An append-only list of entries. Wire form of an entry: `body ‖ signature(64)`.

```
body = 0x01 0x01 ‖ type u8 ‖ seq u32 ‖ prev bytes(32) ‖ time u64 ‖ signerKind u8 ‖ signer bytes(32) ‖ payload

entryHash = H("trommi/v1/log-entry", body)                 the signature is not part of the hash
signature = Sign(signer, "trommi/v1/log-sig", body)
roomId    = entryHash of entry 0 (genesis)
```

`seq` counts from 0. `prev` is the `entryHash` of the entry before (32 zero bytes for genesis). `time` is milliseconds since the Unix epoch as claimed by the signer; it is not checked. `signerKind`: 1 = device (`signer` = device id), 2 = recovery key (`signer` = device id of the recovery key pair).

```
member = role u8 ‖ signPub(32) ‖ kexPub(32) ‖ name str16(128)        role: 1 human, 2 agent
epoch  = epoch u32 ‖ keyCommit(32) ‖ histCommit(32)
ids    = count u16 ‖ deviceId(32) × count                            ascending, no duplicates
```

| Type | Payload | Signed by |
| --- | --- | --- |
| 1 genesis | `roomNonce(16) ‖ member ‖ recSignPub(32) ‖ recKexPub(32) ‖ epoch` | the founding device, which is `member` (role human); epoch is 1 |
| 2 add | `member ‖ inviteId(16)` (zeros if not by invite) | an active human device |
| 3 remove | `ids ‖ epoch` (at least one id) | an active human device |
| 4 epoch | `epoch` | an active human device |
| 5 recover | `member ‖ ids ‖ epoch ‖ newRecSignPub(32) ‖ newRecKexPub(32)` | the current recovery key |

Rules a verifier enforces, entry by entry:

- `seq` is the predecessor's plus one, `prev` matches, the signature verifies under the key the log itself gives the signer.
- Device signers must be active (added, not removed) and human **before** the entry is applied. Agents sign nothing. The recovery key signs type 5 and nothing else.
- A new `epoch` number is the current one plus one. Removal always carries the new epoch: removal without rotation cannot be expressed.
- An added device must be new: its id, its signing key and its exchange key must not appear in the log before, removed members included. Removed devices cannot return.
- Removed ids must be active. In a recover entry the list may be empty.
- A recover entry enrols one human device and installs a new recovery key that differs from the old one.

A log is trusted only relative to a room id that came from somewhere else: the invite link, or the device's own storage.

**Rollback and fork.** A device pins `{ seq, hash }` of the newest entry it accepted, and the hashes of all entries. A newly served log that is a shorter prefix is a rollback. A log that differs at some entry is a fork, with one exception: if the first differing entry of the new log is a recover entry and the pinned branch holds no recover entry at or after that position, the result is `recovery-override` and the client must tell the user. Without the pinned hashes the exception cannot be judged and the result is a fork.

## 7. Room key epochs

An epoch secret is two independent random 32-byte values:

- `key`: the room key. Every member holds it.
- `hist`: the history key. Human devices and the recovery key hold it. Agents never receive it.

```
keyCommit  = KDF(key,  salt = empty, "trommi/v1/epoch-commit/key",  context = epoch u32, 32)
histCommit = KDF(hist, salt = empty, "trommi/v1/epoch-commit/hist", context = epoch u32, 32)
```

Both commitments stand in the signed log entry that starts the epoch.

**Wrap** (one per member and one for the recovery key, per epoch): a sealed box to the recipient's `kexPub`.

```
plaintext = 0x01 ‖ key(32)                for agents
plaintext = 0x02 ‖ key(32) ‖ hist(32)     for human devices and the recovery key
aad       = "trommi/v1/epoch-wrap" ‖ 0x00 ‖ roomId(32) ‖ epoch u32 ‖ recipientId(32)
```

After opening, the receiver recomputes the commitments and compares them with the log. A key that does not match is refused (`key-mismatch`).

**Back link** (one per epoch from 2 on): the previous epoch secret under the new history key.

```
okm        = KDF(hist_n, salt = roomId, "trommi/v1/back-link", context = n u32, 44)
key, nonce = okm[0..32], okm[32..44]
backLink   = 0x01 0x08 ‖ n u32 ‖ AES-256-GCM(key, nonce, aad, key_{n-1}(32) ‖ hist_{n-1}(32))
aad        = 0x01 0x08 ‖ roomId(32) ‖ n u32
```

The opened secret is checked against the commitments of epoch n-1.

**Per-sender key.** Nobody encrypts messages with the room key itself.

```
senderKey = KDF(key, salt = roomId, "trommi/v1/sender-key", context = epoch u32 ‖ senderId(32), 32)
```

## 8. Invite

```
link     = <app url> "#v1." b64u(utf8(hub address)) "." b64u(roomId) "." b64u(secret)      secret: 32 random bytes
inviteId = KDF(secret, salt = roomId, "trommi/v1/invite-id",  context = empty, 16)
macKey   = KDF(secret, salt = roomId, "trommi/v1/invite-mac", context = empty, 32)
```

Three signed messages cross the hub. Each is `body ‖ …`:

```
offer   = body ‖ Sign(inviter, "trommi/v1/invite-offer-sig", body)
  body  = 0x01 0x05 ‖ roomId(32) ‖ inviteId(16) ‖ role u8 ‖ expiresAt u64 ‖ commit(32) ‖ inviterId(32) ‖ logSeq u32 ‖ logHash(32)
  commit = H("trommi/v1/invite-commit", inviteId ‖ nonce(32))                nonce: 32 random bytes, kept by the inviter

request = body ‖ mac(32) ‖ Sign(newDevice, "trommi/v1/invite-request-sig", body ‖ mac)
  body  = 0x01 0x06 ‖ roomId(32) ‖ inviteId(16) ‖ hub str16(512) ‖ role u8 ‖ name str16(128) ‖ signPub(32) ‖ kexPub(32) ‖ offerHash(32)
  mac   = HMAC-SHA-256(macKey, "trommi/v1/invite-mac" ‖ 0x00 ‖ body)
  offerHash = H("trommi/v1/invite-offer", offer)

reveal  = body ‖ Sign(inviter, "trommi/v1/invite-reveal-sig", body)
  body  = 0x01 0x07 ‖ inviteId(16) ‖ nonce(32) ‖ requestHash(32)
  requestHash = H("trommi/v1/invite-request", request)

checkCode = decimal, six digits, zero-padded:
            (first 8 bytes of H("trommi/v1/invite-code", offer ‖ request ‖ nonce) as u64) mod 1 000 000
```

Order: the inviter publishes the offer (which commits to the nonce) and hands over the link. The new device verifies the log against the room id in the link, verifies the offer against the log, and sends the request. The inviter accepts the **first request with a valid MAC**, marks the invite used, and only then reveals the nonce. The new device checks the reveal against commitment and request hash. Both show the code. After the human confirmed it, the inviter writes the add entry (with `inviteId`) and seals the current epoch secret to the new device.

Enforced by the inviter's device, not the hub: expiry (`expiresAt`, ten minutes by default) at the time the request arrives; single use; five minutes between accepting the request and the confirmation; the check code is mandatory for the human role and can be skipped for agents only on explicit request.

## 9. Envelope

```
full   = 0x01 0x02 ‖ header var16 ‖ nonce(12) ‖ ciphertext var32 ‖ signature(64)
pruned = 0x01 0x03 ‖ header var16 ‖ nonce(12) ‖ ciphertextHash(32) ‖ signature(64)

header = 0x01 ‖ flags u8 ‖ roomId(32) ‖ epoch u32 ‖ keyId u32 ‖ sender(32) ‖ seq u64 ‖ prev(32)
         ‖ logSeq u32 ‖ logHash(32) ‖ recipient(32) ‖ time u64
         ‖ seenCount u16 ‖ ( sender(32) ‖ seq u64 ‖ hash(32) ) × seenCount
         ‖ [ cardId(16) ‖ cardState u8 ‖ answeredAt u64 ]          present iff flags bit 1
         ‖ blobCount u8 ‖ blobId(16) × blobCount

ciphertext     = AES-256-GCM(senderKey, nonce, aad = header, paddedBody)     includes the 16-byte tag
ciphertextHash = SHA-256(ciphertext)
envelopeHash   = H("trommi/v1/envelope", header ‖ nonce ‖ ciphertextHash)
signature      = Sign(sender, "trommi/v1/envelope-sig", envelopeHash)
```

Header fields: `flags` bit 0 = "send a push", bit 1 = card fields present, other bits must be zero. `keyId` is 0 (the room key; reserved for a key per agent session). `seq` starts at 1 per sender and room. `prev` is the `envelopeHash` of the sender's previous envelope, zeros for the first. `logSeq`, `logHash` name the newest log entry the sender knew. `recipient` is a device id, or zeros for everyone. `time` is the sender's clock in milliseconds. `seen` lists, per other sender and sorted by sender id, the newest envelope of that sender the author had accepted. The fixed part is 192 bytes, each `seen` entry 72.

The nonce is 96 random bits. The room id, epoch and sender are in the key (section 7), in the associated data and under the signature.

**What is signed, what is associated data.** The whole header is the associated data of the encryption. The signature covers header, nonce and the hash of the ciphertext, through `envelopeHash`. The same hash links the chain. A pruned envelope (the hub deleted the ciphertext after 30 days) therefore still verifies and still carries the chain.

**Body** (the plaintext):

```
body       = 0x01 ‖ kind u8 ‖ bind var16 ‖ payload var32
paddedBody = body ‖ 0x00 …      up to the next size of: 256, 512, 1024, … 65536 bytes, then multiples of 65536
```

Padding must be all zero. `payload` is opaque to this layer (the application's JSON). `kind`: 1 chat, 2 card, 3 answer, 4 permission request, 5 verdict, 6 status, 7 decide again, 8 scribble.

`bind` by kind (empty for the others):

```
answer (3)             = 0x01 ‖ cardId(16) ‖ cardHash(32) ‖ choice str16(256)
permission request (4) = 0x01 ‖ requestId(16) ‖ expiresAt u64
verdict (5)            = 0x01 ‖ requestId(16) ‖ requestHash(32) ‖ expiresAt u64 ‖ verdict u8      1 allow, 2 deny
decide again (7)       = 0x01 ‖ cardId(16) ‖ previousHash(32) ‖ choice str16(256)
```

`cardHash` is the `envelopeHash` of the agent's envelope that created or last changed the card: it covers the options and everything else the human saw. `requestHash` is the `envelopeHash` of the agent's permission request. `previousHash` is the `envelopeHash` of the answer being taken back.

**Receiver checks, in this order** (`verifyEnvelope`, then `openEnvelope`):

1. Format, versions, room id, `keyId` = 0.
2. `logSeq` is not beyond the receiver's log (`log-behind`: fetch the log first) and `logHash` equals the receiver's entry at `logSeq` (`log-fork` otherwise).
3. The sender was an active member once entry `logSeq` was applied, and `epoch` is the epoch in force at `logSeq`.
4. The sender is not removed in the receiver's current log (`removed-sender`), unless the caller reads history on purpose.
5. The signature verifies under the sender's key from the log.
6. Chain: `seq` is the receiver's last accepted number for this sender plus one and `prev` matches. Otherwise `replay` (already accepted), `equivocation` (same number, other hash), `gap` (numbers missing; the error says which), `chain-break` (right number, wrong predecessor). A sender never seen before must start at 1.
7. `seen`: a hash that differs from the one the receiver holds under the same number is `equivocation`. A higher number than the receiver has is reported as withheld, not as an error.
8. Decrypt with the sender key of the named epoch; check body version and padding. Only now does the receiver's chain advance.

## 10. Commands (the agent's gate)

After an envelope opened, an agent executes it only if all of this holds (`authoriseCommand`):

- The sender is an active **human** device in the agent's current log.
- `recipient` is this agent's device id.
- The envelope's epoch is the current one, or the previous one and the agent learned of the new epoch at most two minutes ago.
- Answer: the card with `cardId` exists, is open, its current hash equals `cardHash`, `choice` is one of its options, and the card id in the header (if present) equals the one in `bind`.
- Verdict: the request with `requestId` is still pending, its hash and expiry equal `requestHash` and `expiresAt`, and the agent's clock is not past `expiresAt`.
- Decide again: `previousHash` is the hash of the answer currently in force.
- Chat and scribble are never refused for staleness; they are marked late if the `seen` entry for the agent is behind the agent's own last envelope.

Whether the terminal or the remote answer came first stays Claude Code's decision; this layer only says whether the remote one is authentic and fresh.

## 11. Assets

```
blob   = head ‖ chunk_0 ‖ chunk_1 ‖ …
head   = 0x01 0x09 ‖ blobId(16) ‖ chunkSize u32 (= 65536)                              22 bytes
chunk_i = AES-256-GCM(assetKey, nonce_i, aad = head, plaintext[i × 65536 …])            up to 65536 + 16 bytes
nonce_i = 0x00 0x00 0x00 ‖ i u64 ‖ last u8                                              last = 1 for the final chunk, else 0
```

`assetKey` is 32 fresh random bytes per asset and is used for nothing else, so counter nonces are safe (STREAM construction, as in age and Tink). An empty asset has one empty chunk. Every chunk but the last is full. A blob cut at a chunk boundary fails because its last chunk does not carry the final mark. `assetKey`, SHA-256 of the blob, name and type belong in the encrypted message payload; the header only lists `blobId`.

Asset key under the room key (for blobs that live outside a message, such as the canvas):

```
okm        = KDF(roomKey, salt = roomId, "trommi/v1/asset-wrap", context = epoch u32 ‖ blobId(16), 44)
key, nonce = okm[0..32], okm[32..44]
wrapped    = 0x01 0x0a ‖ epoch u32 ‖ blobId(16) ‖ AES-256-GCM(key, nonce, aad, assetKey(32))       70 bytes
aad        = 0x01 0x0a ‖ roomId(32) ‖ epoch u32 ‖ blobId(16)
```

Link form: `<blob url> "#a1." b64u(blobId) "." b64u(assetKey)`. Whoever has the link reads the asset.

## 12. Recovery code

32 random bytes, shown as 52 Crockford base32 characters (`0123456789ABCDEFGHJKMNPQRSTVWXYZ`) in thirteen groups of four, joined by `-`. The bits are read most significant first; the last character holds one data bit followed by four zero bits. Input is accepted in any case, with spaces or hyphens, with `O` read as `0` and `I`, `L` as `1`; a last character with non-zero padding bits is refused. There is no checksum: a mistyped code yields a key pair that the log does not know.

```
recovery signSeed   = KDF(code(32), salt = empty, "trommi/v1/recovery/sign", context = empty, 32)
recovery kexPrivate = KDF(code(32), salt = empty, "trommi/v1/recovery/kex",  context = empty, 32)
```

No password stretching: the input has 256 bits of entropy. Recovery: derive the key pair, open the recovery key's wrap of the current epoch, sign a recover entry (section 6), wrap the new epoch for everyone who remains and for the new recovery key, write the back link.

## 13. Key schedule at a glance

```
link secret ──KDF──▶ invite id, MAC key
recovery code ──KDF──▶ recovery Ed25519 seed, recovery X25519 key
epoch n:  key_n  (random) ──KDF──▶ keyCommit_n (in the log)
                           ──KDF──▶ senderKey(n, device)  ──▶ AES-256-GCM over message bodies, random nonce
                           ──KDF──▶ asset wrap key and nonce (n, blobId)
          hist_n (random) ──KDF──▶ histCommit_n (in the log)
                           ──KDF──▶ back link key and nonce ──▶ encrypts key_{n-1} ‖ hist_{n-1}
          (key_n [, hist_n]) ──sealed box──▶ each member [humans and recovery key with hist_n]
asset:    assetKey (random) ──▶ AES-256-GCM over 64 KiB chunks, counter nonce
```

## 14. Deviations from `docs/krypto-konzept.md`, and choices where it was open

Deviations:

1. **A history key beside the room key.** The concept lets each new room key encrypt its predecessor and relies on the hub not handing that chain to agents. An agent holds the room key, so a hub colluding with an agent would give it all history. Here the back link is encrypted under a second key that agents never receive. There is still ONE room key for content.
2. **Key commitments in the log.** The concept seals the room key per member. A sealed box does not name its sender, so the hub could seal a key of its own to a member. Each epoch entry therefore commits to its keys and receivers check.
3. **Removal carries the rotation.** One entry removes and starts the new epoch, instead of two entries that a hub could separate.
4. **The signature covers the hash of the ciphertext,** not the ciphertext, so that pruned envelopes stay verifiable. Equivalent while SHA-256 is collision resistant.
5. **Kind and command bindings are inside the ciphertext.** The cleartext header carries only what the concept lists for the hub (card id, card state, answer time, blob ids, push bit). The bindings are still signed, through the ciphertext hash.
6. **An answer is bound to the hash of the card's envelope** rather than to a separate hash of the options. That hash covers the options and the text. The chosen option is additionally checked against the card's option keys.
7. **Invite link:** the hub address is base64url-encoded inside the fragment, because addresses contain dots. The role is not in the link; it is in the signed offer and under the request's MAC.
8. **A signed invite offer** is an added message. It carries the commitment that commit-then-reveal needs, and lets the new device check who invites before it sends its keys.
9. **Sealed box nonce** is derived by HKDF together with the key instead of being transmitted; the key is single-use.
10. **Device ids are 32 bytes** (hash of both public keys). The concept does not fix a size.
11. **Recovery keeps agents by default** and removes every human device; the list is a parameter. The concept says "removes all old ones".
12. **Wrapped asset key and asset link** are additions asked for by the task. In the concept an asset key only travels inside a message.

Choices where the concept was open or ambiguous:

- "An entry of the recovery key beats any entry of a device" is implemented as the `recovery-override` rule in section 6, surfaced to the user, never applied silently.
- "The previous epoch counts for two more minutes" is measured from the moment the agent learned of the new epoch (the caller supplies it). The sender's `time` is not trusted for this.
- A sender that was removed is refused by default even for envelopes it sent before the removal; reading them as history is an explicit option.
- Padding sizes (section 9) and the 128-byte limit for names.
- Expiry of an invite applies when the request arrives; the human then has five minutes to compare the code.
- The recovery key signs recover entries only. Changing the recovery code without a recovery is not expressible in version 1.
- The genesis entry is not countersigned by the recovery key.

Not covered by version 1: sign-in to the hub by challenge (concept section 8), the canvas version counter, encrypted snapshots, a streaming interface for assets (there is whole-buffer encryption and per-chunk decryption), any ratchet (decided against).

## 15. Assumptions and limits

- **No forward secrecy, no post-compromise security,** by decision. Whoever holds a room key and the ciphertexts reads the epoch; with a history key, all earlier epochs. Whoever holds a device's X25519 key opens every future epoch until the device is removed.
- **Every member can read every message of an epoch,** agents included. Per-sender keys separate nonces, not readers. Only signatures separate senders.
- **The room key exists as bytes in the client's memory** (it must be wrapped for others). Device private keys can be non-extractable; seeds imported from a key file or a recovery code pass through memory as bytes. JavaScript cannot wipe memory.
- **State is the caller's:** the pinned log head, the per-sender chains, the invite record and the epoch secrets must be stored durably and atomically. A device that loses its chain state and sends again produces `equivocation` at every receiver; it then needs a new identity.
- **A fork is only noticed when forked devices exchange a message** or a log. The hub can always withhold the end of a log or of a chain; that shows through `log-behind` and `seen`, not earlier.
- **The cut between a removed member's last honest envelope and later ones is not fixed cryptographically.** A hub colluding with a removed device can feed old-epoch envelopes to a client that reads history with removed senders allowed. They never count as commands.
- **Clocks:** expiry and freshness use the local clock of the device that enforces them. Header `time` is a claim.
- **GCM limits:** random 96-bit nonces under one sender key per epoch; the library does not count messages. Stay far below 2^32 per sender and epoch.
- **Ed25519 verification rules** (non-canonical encodings, small-order keys) differ slightly between libraries. Hashes never include signatures, so a re-encoded signature cannot change a chain; implementations should still be compared on the vectors.
- **The X25519 key in an invite request is not proven to be owned.** A wrong key only locks the new device out.
- **Six digits** bound an active attacker with a stolen link to a one-in-a-million chance per attempt; each attempt burns an invite.
- **Whoever serves the JavaScript can use the keys** (concept section 9). This library does not change that.
