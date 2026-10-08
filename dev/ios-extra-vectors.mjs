// ios-extra-vectors.mjs: vectors for ios/TrommiCore beyond shared/crypto/vectors.json, written by the JS core so the Swift
// tests check that Swift reads what JS writes: session grants (not in vectors.json, FORMAT.md section 18), the account
// KDF (Argon2id, hash-wasm), the check emoji table, and a pruned/answered envelope round.
//
//   node dev/ios-extra-vectors.mjs            writes ios/TrommiCore/Tests/TrommiCoreTests/Fixtures/extra-vectors.json
//
// The JS core is only imported, never changed. Randomness (session keys, sealed boxes) is the system's: the file is
// regenerated as a whole, and the Swift tests check relations (open, verify, recompute), not fixed bytes.
import fs from 'node:fs'
import path from 'node:path'
import * as z from '../shared/crypto/zcrypto.mjs'
import * as G from '../shared/crypto/session-grants.mjs'
import { masterKey, passwordKeys, wrapCode, ACCOUNT_KDF } from '../shared/account.mjs'
import { CHECK_EMOJI } from '../shared/check-emoji.ts'

const here = path.dirname(new URL(import.meta.url).pathname)
const vectors = JSON.parse(fs.readFileSync(path.join(here, '../shared/crypto/vectors.json'), 'utf8'))
const { hex, unhex, b64u } = z
const dev = name => z.deviceFromSeeds(unhex(vectors.devices[name].signSeed), unhex(vectors.devices[name].kexSeed))

// The room of vectors.json up to entry 3 (phone, laptop, agent, helper; epoch 1).
const entries = vectors.log.entries.slice(0, 4).map(e => unhex(e.bytes))
const state = await z.verifyLog(entries, unhex(vectors.room.roomId))
const phone = await dev('phone'), agent = await dev('agent')
const sessionId = unhex('a1'.repeat(16))
const g0 = await G.createSessionGrant({ state, signer: phone, sessionId, agentIds: [agent.id], withHistory: false, time: 1790000000100 })
const g1 = await G.createSessionGrant({ state, signer: phone, sessionState: g0.sessionState, current: g0.secret, agentIds: [agent.id], rotate: true, time: 1790000000200 })
const wraps = g => g.wraps.map(w => ({ id: hex(w.id), sealed: hex(w.sealed) }))
const secret = s => ({ epoch: s.epoch, key: hex(s.key), hist: s.hist ? hex(s.hist) : null })

// A card from the agent under the session key, read by the phone (session scope, epoch 2).
const chains = z.newChains()
const card = await z.sealEnvelope({ device: agent, state, secret: g1.secret, chains, kind: z.KIND.OBJECT_VERSION, keyScope: z.KEY_SCOPE.SESSION, sessionId,
  payload: new TextEncoder().encode(JSON.stringify({ schema_version: 1, object_type: 'card', object_version: 1, card_type: 'decision', title: 'Ship it?', options: [{ key: 'yes', label: 'Yes' }, { key: 'no', label: 'No' }] })),
  card: { id: await z.objectIdOf(agent.id, 1), state: 1, urgency: 2, answeredAt: 0 }, push: true, time: 1790000000300 })

// Account: the KDF with the real parameters (64 MiB) and a key_wrapped blob.
const email = 'Owner@Example.com ', password = 'correct horse battery staple'
const keys = await passwordKeys(email, password)
const roomIdHex = vectors.room.roomId
const out = {
  about: 'Written by dev/ios-extra-vectors.mjs from the JS core. Hex unless named b64u.',
  sessions: {
    log: vectors.log.entries.slice(0, 4).map(e => e.bytes),
    sessionId: hex(sessionId),
    grants: [
      { grant: hex(g0.grant), grantHash: hex(g0.sessionState.grantHash), manifestHash: hex(g0.sessionState.manifestHash), epoch: 1, secret: secret(g0.secret), wraps: wraps(g0), backLink: null },
      { grant: hex(g1.grant), grantHash: hex(g1.sessionState.grantHash), manifestHash: hex(g1.sessionState.manifestHash), epoch: 2, secret: secret(g1.secret), wraps: wraps(g1), backLink: hex(g1.backLink) },
    ],
    keyCommit: hex((await G.sessionCommits(sessionId, g1.secret)).keyCommit),
    card: { bytes: hex(card.bytes), hash: hex(card.hash), title: 'Ship it?' },
  },
  account: {
    email, normalisedEmail: 'owner@example.com', password, kdf: ACCOUNT_KDF,
    salt: hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode('trommi/v1/account-salt\0owner@example.com')).then(b => new Uint8Array(b))),
    master: hex(await masterKey('owner@example.com', password)),
    authKey: keys.auth_key,
    roomId: roomIdHex,
    code: vectors.recovery.code,
    keyWrapped: await wrapCode(keys.wrap_key, roomIdHex, vectors.recovery.code),
  },
  checkEmoji: CHECK_EMOJI.map(e => [e.emoji, e.word]),
}
const file = path.join(here, '../ios/TrommiCore/Tests/TrommiCoreTests/Fixtures/extra-vectors.json')
fs.writeFileSync(file, JSON.stringify(out, null, 1) + '\n')
console.log('wrote', path.relative(process.cwd(), file))
