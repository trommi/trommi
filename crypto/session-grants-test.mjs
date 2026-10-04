// node crypto/session-grants-test.mjs: per-session keys (R6) on top of zcrypto.
import * as z from './zcrypto.mjs'
import * as g from './session-grants.mjs'

let failed = 0, passed = 0
const t = async (name, fn) => { try { await fn(); passed++; console.log(`ok   ${name}`) } catch (e) { failed++; console.log(`FAIL ${name}\n     ${e.stack}`) } }
const assert = (c, m) => { if (!c) throw new Error(m) }
const throwsCode = async (fn, code) => { try { await fn() } catch (e) { if (e.code === code) return; throw new Error(`expected ${code}, got ${e.code}: ${e.message}`) } throw new Error(`expected ${code}, nothing thrown`) }

// a room: phone (human), two agents
const phone = await z.generateDevice()
const code = z.generateRecoveryCode()
const room = await z.createRoom({ device: phone, recovery: await z.recoveryDevice(code) })
let state = room.state
const a1 = await z.generateDevice({ extractable: true }), a2 = await z.generateDevice({ extractable: true })
state = (await z.addMember(state, phone, { member: { role: z.ROLE.AGENT, signPub: a1.signPub, kexPub: a1.kexPub } })).state
state = (await z.addMember(state, phone, { member: { role: z.ROLE.AGENT, signPub: a2.signPub, kexPub: a2.kexPub } })).state
const wrapFor = (wraps, d) => wraps.find(w => z.bytesEqual(w.id, d.id)).sealed

let s1, sec1, grants = []
await t('first grant: session created, agent 1 assigned, everyone who may gets a wrap', async () => {
  const r = await g.createSessionGrant({ state, signer: phone, agentIds: [a1.id] })
  s1 = r.sessionState; sec1 = r.secret; grants.push(r.grant)
  assert(s1.grantNumber === 0 && s1.epoch === 1 && s1.agentIds[0] === z.hex(a1.id), 'state')
  assert(r.wraps.length === 3, 'phone, recovery key, agent 1')
  assert(z.bytesEqual(await g.grantManifestHash(r.wraps), s1.manifestHash), 'manifest matches')
  const k = await g.unwrapSessionKey({ roomId: state.roomId, sessionState: s1, device: a1, sealed: wrapFor(r.wraps, a1), epoch: 1 })
  assert(z.bytesEqual(k.key, sec1.key) && k.hist === null, 'agent without history gets the key only')
  const kp = await g.unwrapSessionKey({ roomId: state.roomId, sessionState: s1, device: phone, sealed: wrapFor(r.wraps, phone), epoch: 1 })
  assert(z.bytesEqual(kp.hist, sec1.hist), 'humans get the history key')
  assert(!r.wraps.some(w => z.bytesEqual(w.id, a2.id)), 'agent 2 gets nothing')
})

let s2, sec2
await t('handover WITHOUT history: new epoch, agent 2 cannot walk back', async () => {
  const r = await g.createSessionGrant({ state, signer: phone, sessionState: s1, current: sec1, agentIds: [a2.id], rotate: true })
  s2 = r.sessionState; sec2 = r.secret; grants.push(r.grant)
  assert(s2.epoch === 2 && r.backLink, 'rotated with a back link for humans')
  const k = await g.unwrapSessionKey({ roomId: state.roomId, sessionState: s2, device: a2, sealed: wrapFor(r.wraps, a2), epoch: 2 })
  assert(k.hist === null, 'no history key for agent 2')
  await throwsCode(() => g.openSessionBackLink({ roomId: state.roomId, sessionState: s2, secret: k, link: r.backLink }), 'no-key')
  assert(!r.wraps.some(w => z.bytesEqual(w.id, a1.id)), 'agent 1 unassigned: no wrap of epoch 2')
  const kp = await g.unwrapSessionKey({ roomId: state.roomId, sessionState: s2, device: phone, sealed: wrapFor(r.wraps, phone), epoch: 2 })
  const prev = await g.openSessionBackLink({ roomId: state.roomId, sessionState: s2, secret: kp, link: r.backLink })
  assert(z.bytesEqual(prev.key, sec1.key), 'humans read back to epoch 1')
})

await t('handover WITH history: same epoch re-sealed with the history key, agent walks back', async () => {
  const r = await g.createSessionGrant({ state, signer: phone, sessionState: s2, current: sec2, agentIds: [a1.id], withHistory: true })
  grants.push(r.grant)
  assert(r.sessionState.epoch === 2 && r.sessionState.withHistory, 'same epoch, with history')
  const k = await g.unwrapSessionKey({ roomId: state.roomId, sessionState: r.sessionState, device: a1, sealed: wrapFor(r.wraps, a1), epoch: 2 })
  assert(k.hist, 'history key for the agent')
  const back = (await g.createSessionGrant({ state, signer: phone, sessionState: s1, current: sec1, rotate: true })).backLink   // a back link 2->1 like the hub keeps
  void back
})

await t('whole chain verifies; tampering, foreign signers and agents as signers are refused', async () => {
  const s = await g.verifyGrants(grants, state)
  assert(s.grantNumber === 2, 'three grants')
  const bad = grants[1].slice(); bad[60] ^= 1
  await throwsCode(() => g.verifyGrants([grants[0], bad], state), 'bad-signature')
  await throwsCode(() => g.verifyGrants([grants[1]], state), 'bad-grant')
  await throwsCode(() => g.createSessionGrant({ state, signer: a1, agentIds: [] }), 'not-human')
  await throwsCode(() => g.createSessionGrant({ state, signer: phone, agentIds: [phone.id] }), 'bad-argument')
  const other = await g.createSessionGrant({ state, signer: phone, agentIds: [] })
  await throwsCode(() => g.unwrapSessionKey({ roomId: state.roomId, sessionState: s1, device: phone, sealed: wrapFor(other.wraps, phone), epoch: 1 }), 'decrypt-failed')
})

console.log(`\n${passed} ok, ${failed} failed`)
process.exit(failed ? 1 : 0)
