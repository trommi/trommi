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

await t('handover WITH history: a new epoch (the old agent loses it), the new agent walks back through the back link', async () => {
  const r = await g.createSessionGrant({ state, signer: phone, sessionState: s2, current: sec2, agentIds: [a1.id], withHistory: true, rotate: true })
  grants.push(r.grant)
  assert(r.sessionState.epoch === 3 && r.sessionState.withHistory, 'rotated, with history')
  const k = await g.unwrapSessionKey({ roomId: state.roomId, sessionState: r.sessionState, device: a1, sealed: wrapFor(r.wraps, a1), epoch: 3 })
  assert(k.hist, 'history key for the agent')
  const prev = await g.openSessionBackLink({ roomId: state.roomId, sessionState: r.sessionState, secret: k, link: r.backLink })
  assert(z.bytesEqual(prev.key, sec2.key), 'the agent reads epoch 2 through the back link')
  assert(!r.wraps.some(w => z.bytesEqual(w.id, a2.id)), 'agent 2 holds nothing of epoch 3')
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

await t('B01: a same-epoch grant that drops an agent is refused (handover must rotate)', async () => {
  const r0 = await g.createSessionGrant({ state, signer: phone, agentIds: [a1.id] })
  await throwsCode(() => g.createSessionGrant({ state, signer: phone, sessionState: r0.sessionState, current: r0.secret, agentIds: [a2.id], withHistory: true }), 'bad-grant')
  const add = await g.createSessionGrant({ state, signer: phone, sessionState: r0.sessionState, current: r0.secret, agentIds: [a1.id, a2.id], withHistory: true })
  assert(add.sessionState.epoch === 1 && add.sessionState.agentIds.length === 2, 'adding an agent may re-seal')
})

// review 2 #1 (B02) and #3 (A1): grants of a removed human, and the member change between grants
await t('B02: a removed human\'s grant (backdated to before its removal) is stale; after the honest re-key it is refused', async () => {
  const laptop = await z.generateDevice()
  let st = (await z.addMember(state, phone, { member: { role: z.ROLE.HUMAN, signPub: laptop.signPub, kexPub: laptop.kexPub } })).state
  const s0 = await g.createSessionGrant({ state: st, signer: phone, agentIds: [a1.id] })
  const before = st                                                 // the laptop's frozen view
  const epochSecret = room.secret
  const rm = await z.removeMembers(st, phone, { ids: [laptop.id], previous: epochSecret }); st = rm.state
  assert(g.grantIsStale(s0.sessionState, st) && g.lastMemberChange(st) === st.head.seq, 'the removal makes the session stale')
  // The PoC: the laptop rotates on its old view, before the honest re-key lands.
  const forged = await g.createSessionGrant({ state: before, signer: laptop, sessionState: s0.sessionState, agentIds: [a1.id], rotate: true })
  const fs = await g.applyGrant(s0.sessionState, forged.grant, st)
  assert(fs.stale === true && g.grantIsStale(fs, st), 'accepted only as stale: read, never send')
  // The honest re-key after the removal is not stale ...
  const honest = await g.createSessionGrant({ state: st, signer: phone, sessionState: s0.sessionState, current: s0.secret, agentIds: [a1.id], rotate: true })
  assert(!honest.sessionState.stale && !g.grantIsStale(honest.sessionState, st), 'honest re-key is current')
  // ... and once it is in the chain the laptop cannot follow it: it can only name a log position before its removal.
  const forged2 = await g.createSessionGrant({ state: before, signer: laptop, sessionState: honest.sessionState, agentIds: [a1.id], rotate: true })
  await throwsCode(() => g.applyGrant(honest.sessionState, forged2.grant, st), 'bad-grant')
  // A re-seal (same epoch) across the removal is refused as well: after a member change the key must change.
  await throwsCode(() => g.createSessionGrant({ state: st, signer: phone, sessionState: s0.sessionState, current: s0.secret, agentIds: [a1.id] }), 'bad-grant')
  // History stays verifiable: the old grant of the (since removed) laptop, followed by the honest re-key.
  const lg = await g.createSessionGrant({ state: before, signer: laptop, agentIds: [] })
  const lg2 = await g.createSessionGrant({ state: st, signer: phone, sessionState: lg.sessionState, current: lg.secret, rotate: true })
  const v = await g.verifyGrants([lg.grant, lg2.grant], st)
  assert(v.grantNumber === 1 && !v.stale, 'a removed human\'s old grants stay valid history')
})

await t('recovery: grants signed by the recovery key are checked against the key valid at their log position', async () => {
  const code2 = z.generateRecoveryCode()
  const rec1 = await z.recoveryDevice(code)
  const s0 = await g.createSessionGrant({ state, signer: rec1, agentIds: [] })
  assert(s0.sessionState.signerId === z.hex(rec1.id), 'recovery key signs')
  const keys = room.wraps.find(w => z.bytesEqual(w.id, state.recovery.id))
  void keys
  const nd = await z.generateDevice()
  const r = await z.recoverRoom({ state, code, newCode: code2, newDevice: nd, name: '', recoveryWrap: room.wraps.find(w => z.bytesEqual(w.id, state.recovery.id)).sealed, cuts: {} })
  const v = await g.verifyGrants([s0.grant], r.state)
  assert(v.stale, 'the old recovery key\'s grant is history now, stale')
  const s1 = await g.createSessionGrant({ state: r.state, signer: nd, sessionState: v, current: s0.secret, rotate: true })
  assert(!s1.sessionState.stale, 're-keyed by the new device')
})

await t('per-agent history (PoC p4): adding agent 2 with history does not hand the history key to agent 1', async () => {
  const p1 = await g.createSessionGrant({ state, signer: phone, agentIds: [] })
  const p2 = await g.createSessionGrant({ state, signer: phone, sessionState: p1.sessionState, current: p1.secret, agentIds: [a1.id], rotate: true })
  const p3 = await g.createSessionGrant({ state, signer: phone, sessionState: p2.sessionState, current: p2.secret, agentIds: [a1.id, a2.id], historyAgentIds: [a2.id], rotate: true })
  assert(p3.sessionState.withHistory, 'flag: some agent got history')
  const kA = await g.unwrapSessionKey({ roomId: state.roomId, sessionState: p3.sessionState, device: a1, sealed: wrapFor(p3.wraps, a1), epoch: 3 })
  assert(kA.hist === null, 'agent 1 gets the key only')
  await throwsCode(() => g.openSessionBackLink({ roomId: state.roomId, sessionState: p3.sessionState, secret: kA, link: p3.backLink }), 'no-key')
  const kB = await g.unwrapSessionKey({ roomId: state.roomId, sessionState: p3.sessionState, device: a2, sealed: wrapFor(p3.wraps, a2), epoch: 3 })
  const prev = await g.openSessionBackLink({ roomId: state.roomId, sessionState: p3.sessionState, secret: kB, link: p3.backLink })
  assert(z.bytesEqual(prev.key, p2.secret.key), 'agent 2 reads back')
})

console.log(`\n${passed} ok, ${failed} failed`)
process.exit(failed ? 1 : 0)
