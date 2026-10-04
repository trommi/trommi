# zcrypto

The cryptographic core of Trommi as one standalone ES module. It implements the design in the README ("Cryptography in one page", Security rules): device keys, a signed membership log, invites with a check code, one room key per epoch, signed and chained message envelopes, command authorisation for agents, asset keys and the recovery code.

**Status:** tested library, not wired into the product, not audited. Wire formats: [FORMAT.md](FORMAT.md).

| File | What |
| --- | --- |
| `zcrypto.mjs` | the library; no dependencies, WebCrypto only |
| `test.mjs` | tests, hostile-hub simulation, micro-benchmark: `node core/crypto-test.mjs` |
| `hub.mjs` | the hub's side of pairing and keys, without HTTP and without a database: member list, sign-in, invites, sealed keys, envelopes. Protocol: README, "Founding and joining" |
| `hub-test.mjs` | real clients against the hub module, and everything a hub must refuse: `node core/hub-crypto-test.mjs` |
| `vectors.json` | deterministic vectors for other implementations; `test.mjs` regenerates and compares them (`--write-vectors` rewrites) |
| `FORMAT.md` | exact bytes, labels, key schedule, deviations from the concept |
| `demo.html` | invite → join → send → tamper → detect, in a browser |

## Runtime

Needs `crypto.subtle` with Ed25519, X25519, AES-GCM, HKDF and HMAC. `requireRuntime()` probes for them and names what is missing. There is no JavaScript fallback for any primitive, on purpose.

| Runtime | State |
| --- | --- |
| Node 26.8.1 | all primitives present, all tests pass (tested here) |
| Chromium 152 | all primitives present, `demo.html` passes (tested here, headless) |
| Node 22 to 25 | expected to work (same WebCrypto interface); not tested here |
| Chrome, Firefox, Safari | Ed25519 in WebCrypto is reported from Chrome 137, Firefox 129 and Safari 17. X25519 is reported from about the same releases but was not verified per version; rely on `requireRuntime()`. |
| Swift, native Linux | not this file. Build against FORMAT.md and `vectors.json` with CryptoKit, or libsodium / OpenSSL 3. |

Browsers expose WebCrypto in secure contexts only (https, localhost, file). Chromium refuses to import a module from `file://`, so serve the demo: `python3 -m http.server -d crypto 8000`, then open `http://localhost:8000/demo.html`.

## API by area

All byte values are `Uint8Array`. Failures throw `ZError` with a stable `code` (`bad-signature`, `replay`, `gap`, `log-fork`, …). Functions that draw randomness accept a test-only `_rng`.

```js
import * as z from './zcrypto.mjs'

// Identity
const phone = await z.generateDevice()                    // non-extractable Ed25519 + X25519 keys
const sig = await z.sign(phone, 'my/label', z.utf8('hi'))
await z.verify(phone.signPub, 'my/label', z.utf8('hi'), sig)       // true
z.encodeDevicePublic(phone)                               // 66 bytes; exportDeviceSecret() for an agent key file

// Sealed box to a member's X25519 key (X25519 + HKDF + AES-256-GCM, HPKE-style)
const box = await z.seal(phone.kexPub, z.utf8('secret'), z.utf8('context'))
await z.openSealed(phone, box, z.utf8('context'))

// Recovery code and room
const code = z.generateRecoveryCode()                     // 'XXXX-XXXX-…', 256 bits
const room = await z.createRoom({ device: phone, name: 'Phone', recovery: await z.recoveryDevice(code) })
let log = [room.entry]                                    // what the hub stores
let state = room.state                                    // verified view: members, epoch, head
let secret = room.secret                                  // { epoch: 1, key, hist }
const pin = z.pinOf(state)                                // store it; later: z.checkLogAgainstPin(newState, pin)

// Invite (inviter: phone, new device: agent)
const agent = await z.generateDevice({ extractable: true })
const { link, offer, invite } = await z.createInvite({ state, inviter: phone, hub: 'https://hub.example', role: z.ROLE.AGENT })
const { request, join } = await z.createJoinRequest({ link, offer, log, device: agent, name: 'Builder' })
const { reveal, code: shown } = await z.acceptJoinRequest({ invite, request, inviter: phone })
await z.checkReveal({ join, reveal, log }) === shown      // both devices show the same six digits
const added = await z.finalizeInvite({ invite, state, inviter: phone, secret, codeConfirmed: true })
log.push(added.entry); state = added.state
const joined = await z.completeJoin({ join, device: agent, log, wrap: added.wrap })

// Messages
const phoneChains = z.newChains(), agentChains = z.newChains()
const env = await z.sealEnvelope({ device: phone, state, secret, chains: phoneChains,
  kind: z.KIND.CHAT, payload: z.utf8('run the tests'), recipient: agent.id })
const got = await z.openEnvelope(env.bytes, { state: joined.state, chains: agentChains,
  secrets: new Map([[1, joined.secret]]), self: agent.id })
z.authoriseCommand(got, { state: joined.state, agentId: agent.id })     // throws unless a human device addressed this agent

// Commands bound to what they answer
z.encodeAnswerBind({ cardId, cardHash: cardEnvelope.hash, choice: 'yes' })                 // kind ANSWER
z.encodeVerdictBind({ requestId, requestHash: requestEnvelope.hash, expiresAt, allow: true }) // kind VERDICT
// agent side: z.authoriseCommand(opened, { state, agentId, now, card: { id, hash, open, options }, request: { id, hash, expiresAt, pending } })

// Removal rotates the room key in the same log entry
const r = await z.removeMembers(state, phone, { ids: [agent.id], previous: secret })
// r.entry -> hub log, r.wraps -> one sealed key per remaining member and the recovery key, r.backLink -> history for humans
// Removal (and recovery) is the only thing that changes the room key: there is no rotation on a schedule.

// Assets
const a = await z.encryptAsset(fileBytes)                 // { blob, key, blobId, sha256, size }
await z.decryptAsset(a.blob, a.key, a.sha256)
await z.wrapAssetKey(state.roomId, secret, a.blobId, a.key)
z.assetLink('https://hub.example/blob/1', a.blobId, a.key)

// All devices lost: the code enrols the new device, removes every human device and keeps the agents
await z.recoverRoom({ state, code, newCode: z.generateRecoveryCode(), newDevice, recoveryWrap })
```

Also exported: `verifyLog`, `applyEntry`, `addMember`, `signHubAuth`, `verifyHubAuth`, `verifyInviteOffer`, `verifyInviteRequest`, `verifyInviteReveal` (what a hub checks), `CARD_STATE`, `URGENCY`, `activeMembers`, `memberAt`, `epochAt`, `wrapEpochKey`, `unwrapEpochKey`, `wrapForAll`, `makeBackLink`, `openBackLink`, `deriveSenderKey`, `verifyEnvelope` (no key needed; also for pruned envelopes), `pruneEnvelope`, `peekEnvelope` (what a hub reads), `decodeBind`, `decryptAssetChunk`, `unwrapAssetKey`, `parseInviteLink`, `parseAssetLink`, `parseRecoveryCode`, `b64u` / `unb64u`, `hex` / `unhex`.

## What the caller must do

The library holds no state and stores nothing. The client must keep, durably: the device keys, the pinned log head (`pinOf`), the per-sender chains (`newChains()`; they include the device's own chain), the epoch secrets, and the invite record until it is finalized. Compare every newly fetched log with the pin before using it. Feed envelopes in the order the hub delivers them and treat every `ZError` as a finding to show, not to swallow.

## Covered

Device identity; sealed box; membership log with genesis, add, remove with a new room key, recovery that keeps the agents, full verification, rollback and fork detection; invites with HMAC proof, commit-then-reveal check code, expiry and single use enforced by the inviter; room key epochs with commitments, wraps and back links; per-sender keys; envelopes with padding, per-sender numbers, hash chain, `seen`, pruned form, card status and urgency readable on the outside; sign-in to the hub by signed challenge; command authorisation; chunked asset encryption, wrapped asset keys, asset links; recovery code.

## Not covered, known limits

- No forward secrecy and no post-compromise security (decided: no ratchet). All members of an epoch, agents included, can read all its messages.
- Canvas versioning, snapshots and asset streaming are not implemented.
- An epoch lasts until a member is removed (decided: no rotation on a schedule). A new agent can read back to the last removal.
- Room keys are bytes in memory; only device private keys can be non-extractable.
- A device that loses its chain state cannot keep sending under the same identity.
- A hub can always withhold the newest entries and envelopes; the library reports that as soon as any other evidence arrives (`log-behind`, `withheld`), not before.
- Whoever serves the page's JavaScript can use the keys. See concept section 9.
- The full list with reasons is in FORMAT.md, sections 14 and 15; the decisions of 2 October 2026 in section 16.
