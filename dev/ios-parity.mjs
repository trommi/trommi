// ios-parity.mjs: the Swift client (ios/TrommiCore, `trommi-swift`) against the JS core on a LOCAL hub, both directions.
//
//   (cd ios/TrommiCore && swift build) && node dev/ios-parity.mjs        TROMMI_SWIFT_BIN=… for another binary
//
// A local hub (hub/server.mjs on a free port, throwaway data, as connector/test-e2e.mjs starts it), a JS human device
// (the app's core) and a JS agent (the connector's core) that files cards. Then trommi-swift joins as a human device by
// an invite link the JS human made: it prints six emoji, the "human" compares them with the app's and taps "They match"
// (as the connector e2e confirms an invite). Checked:
//   JS -> Swift   log entries, offer, reveal, room key wrap, session grants and wraps, back links, every envelope's
//                 signature and chain, card bodies (session keys of two epochs): the open cards Swift prints are the app's.
//   Swift -> JS   join request (MAC, signature), hub sign-in, the device register (room key), an answer (session key,
//                 bind): the app's core and the agent open and verify them, the agent gets the decision; the Ed25519
//                 signature of the Swift envelope checked once more by hand with zcrypto.verify.
//   account       email + password: the JS core adds a login to the room (account.mjs), `trommi-swift login` signs in
//                 (Argon2id, auth key, the recovery code unwrapped), adds itself with the recovery key and re-seals every
//                 session key; the app's core sees the new human device and Swift reads the app's open cards. A wrong
//                 password: "wrong-login", nobody added.
//   board         what Swift's Desk model reads (cards, numbers, status, answers, the stack, the registers) is the JS model's;
//                 a Swift message reaches the agent, a Swift note and register reach the app's core.
//   pairing       Swift makes the invite ("Pair a device" on the iPhone), a JS device joins, both show the same six emoji,
//                 Swift confirms, adds it and re-seals every session key: the new device reads the room's cards.
//   agents        Swift invites an agent (its link, the emoji, a session of its own), removes it (new room key, every
//                 session re-keyed: the other agent still reaches both), and a Swift device logs out (removes itself).
//   refusals      "They don't match" in the app: the Swift join stops, nobody is added.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { startHub } from '../connector/test-e2e.mjs'
import * as core from '../shared/index.mjs'
import * as z from '../shared/crypto/zcrypto.mjs'
import { CHECK_EMOJI } from '../shared/check-emoji.mjs'
import * as A from '../shared/account.mjs'

const here = path.dirname(new URL(import.meta.url).pathname)
const BIN = process.env.TROMMI_SWIFT_BIN ?? path.join(here, '../ios/TrommiCore/.build/debug/trommi-swift')
if (!fs.existsSync(BIN)) { console.error(`no ${BIN}: build it first (cd ios/TrommiCore && swift build)`); process.exit(2) }
const sleep = ms => new Promise(r => setTimeout(r, ms))
async function until(what, fn, ms = 20000) {
  const end = Date.now() + ms
  for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) throw new Error(`timed out waiting for ${what}`); await sleep(50) }
}
/** The check code the Swift client printed ("check code 🐶 … (dog, …)"), read back from its words. */
const codeIn = text => {
  const m = /check code [^(\n]*\(([a-z ,]+)\)/.exec(text)
  if (!m) return null
  const idx = m[1].split(', ').map(w => CHECK_EMOJI.findIndex(e => e.word === w))
  return idx.length === 6 && idx.every(i => i >= 0) ? idx.map(i => String(i).padStart(2, '0')).join('-') : null
}
/** trommi-swift as a child; the invite link goes in on stdin (never on a command line). */
function swift(args, { home, stdin = null } = {}) {
  const p = spawn(BIN, [...args, '--home', home], { stdio: ['pipe', 'pipe', 'pipe'] })
  const out = { stdout: '', stderr: '', code: null }
  p.stdout.on('data', d => { out.stdout += d })
  p.stderr.on('data', d => { out.stderr += d })
  out.done = new Promise(r => p.on('exit', c => { out.code = c; r(out) }))
  if (stdin != null) p.stdin.end(stdin + '\n'); else p.stdin.end()
  return out
}
const run = async (args, opts) => { const r = await swift(args, opts).done; if (r.code !== 0) throw new Error(`trommi-swift ${args[0]} failed (${r.code}): ${r.stderr}`); return r }

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'trommi-ios-parity-'))
const results = []
let passed = 0, failed = 0
const test = async (name, fn) => {
  const t0 = Date.now()
  try { await fn(); passed++; results.push(`ok   ${name} (${Date.now() - t0} ms)`) } catch (err) { failed++; results.push(`FAIL ${name}\n     ${err.stack?.split('\n').slice(0, 5).join('\n     ')}`) }
  console.log(results.at(-1))
}

const hub = await startHub(tmp)
const home = path.join(tmp, 'swift-home')
let human, agent, agent2, agent3, swiftId, recoveryCode
const commands = []
try {
  await test('JS: the human founds a room on a local hub, an agent joins (check code confirmed) and files cards', async () => {
    ;({ client: human, recovery_code: recoveryCode } = await core.foundRoom({ hub_url: hub.hub_url, storage: core.memoryStorage(), device_name: 'Phone' }))
    await human.start()
    const addAgent = async name => {
      const inv = await human.createInvite({ device_role: 'agent' })
      const j = core.joinRoom({ link: inv.link, storage: core.memoryStorage(), device_name: name, device_info: { device_name: name, platform: 'node' }, poll_ms: 50 })
      const code = await j.check_code
      await until('confirm state', () => human.model.invites.get(inv.invite_id).invite_state === 'confirm_code')
      await human.confirmInvite(inv.invite_id, human.model.invites.get(inv.invite_id).check_code === code)
      const c = await j.client
      await c.start()
      await c.whenSession()
      return c
    }
    agent = await addAgent('Agent')
    agent.on('command', c => commands.push(c))
    await agent.sendCard({ title: 'Deploy tonight?', body: 'Locks orders 40 s.', options: [{ key: 'tonight', label: 'Tonight' }, { key: 'now', label: 'Now' }], urgency: 'high' })
    await agent.sendCard({ card_type: 'info', title: 'How the cache works' })
    const answered = await agent.sendCard({ title: 'Already answered', options: [{ key: 'y', label: 'Yes' }] })
    await until('cards at the human', () => human.model.cards.get(answered)?.object_state === 'open' && human.model.cards.size === 3)
    await human.answer({ object_id: answered, choices: ['y'] })
    await until('answered', () => human.model.cards.get(answered).object_state !== 'open')
  })

  await test('Swift joins by the human\'s invite: six emoji, nothing added before "They match", then a member', async () => {
    const inv = await human.createInvite({ device_role: 'human' })
    const p = swift(['join', '--name', 'Swift CLI'], { home, stdin: inv.link })
    const code = await until('the check code in the Swift terminal', () => codeIn(p.stdout))
    await until('the app waits for the code', () => human.model.invites.get(inv.invite_id).invite_state === 'confirm_code')
    assert.equal(human.model.invites.get(inv.invite_id).check_code, code, 'the app shows the code the Swift terminal shows')
    await sleep(500)
    assert.equal([...human.model.members.values()].filter(m => m.device_role === 'human').length, 1, 'nobody added before "They match"')
    await human.confirmInvite(inv.invite_id, true)
    const r = await p.done
    assert.equal(r.code, 0, r.stderr)
    assert.match(r.stdout, /Joined\. This device is a member/)
    assert.ok(!r.stdout.includes(inv.link.split('#')[1]) && !r.stderr.includes(inv.link.split('#')[1]), 'the link is never printed')
    const room = fs.readdirSync(home)[0]
    assert.equal(room, human.model.room.room_id)
    assert.equal((fs.statSync(path.join(home, room, 'device.key')).mode & 0o777).toString(8), '600', 'key file 0600')
    swiftId = (await run(['whoami'], { home })).stdout.match(/device ([0-9a-f]{64})/)[1]
    await until('the Swift device in the member list', () => human.model.members.get(swiftId)?.device_role === 'human')
    console.log('     ' + r.stdout.trim().split('\n').join('\n     '))
  })

  await test('Swift -> JS: the device register (room key, Swift signature) opens in the app\'s core', async () => {
    await until('the device name from Swift', () => human.model.members.get(swiftId)?.device_name === 'Swift CLI')
  })

  const jsOpen = () => [...human.model.cards.values()].filter(c => c.object_state === 'open').map(c => ({ id: c.object_id, title: c.title, options: (c.options ?? []).map(o => ({ key: o.key, label: o.label })) })).sort((a, b) => a.id.localeCompare(b.id))
  const swiftOpen = async () => JSON.parse((await run(['cards', '--json'], { home })).stdout).map(c => ({ id: c.id, title: c.title, options: c.options })).sort((a, b) => a.id.localeCompare(b.id))

  await test('JS -> Swift: the open cards Swift reads (every chain and signature verified) are the app\'s', async () => {
    const mine = await swiftOpen()
    assert.equal(mine.length, 2)
    assert.deepEqual(mine, jsOpen())
    const text = (await run(['cards'], { home })).stdout
    console.log('     ' + text.trim().split('\n').join('\n     '))
  })

  await test('Swift -> JS: Swift answers a card under the session key; the agent gets the decision, the app sees it answered', async () => {
    const card = (await swiftOpen()).find(c => c.title === 'Deploy tonight?')
    const r = JSON.parse((await run(['answer', card.id.slice(0, 10), 'now', '--json'], { home })).stdout)
    const cmd = await until('the decision at the agent', () => commands.find(c => c.object_id === card.id && c.command === 'answer'))
    assert.deepEqual(cmd.choices, ['now'])
    assert.equal(cmd.sender_device_id, swiftId)
    assert.equal(cmd.envelope_hash, r.envelope_hash)
    await until('answered at the human', () => human.model.cards.get(card.id).object_state === 'answered')
    // The signature once more by hand: the Swift envelope as the hub serves it, verified with zcrypto.
    const { envelopes } = await human.hub.envelopes({ after_envelope_number: r.envelope_number - 1, limit: 1 })
    const bytes = z.unb64u(envelopes[0].envelope)
    const p = z.peekEnvelope(bytes)
    assert.equal(z.hex(p.header.sender), swiftId)
    const h = await z.hash(z.LABEL.envelope, p.headerBytes, p.nonce, await z.sha256(p.ciphertext))
    assert.equal(z.hex(h), r.envelope_hash)
    assert.ok(await z.verify(human.state.members.get(z.b64u(z.unhex(swiftId))).signPub, z.LABEL.envelopeSig, h, p.signature), 'the Swift Ed25519 signature verifies in zcrypto')
  })

  await test('epochs: a removal rotates the room key and the session keys; Swift reads old and new cards (wraps, back links)', async () => {
    const inv = await human.createInvite({ device_role: 'agent' })
    const j = core.joinRoom({ link: inv.link, storage: core.memoryStorage(), device_name: 'Agent 2', poll_ms: 50 })
    const code = await j.check_code
    await until('confirm', () => human.model.invites.get(inv.invite_id).invite_state === 'confirm_code')
    await human.confirmInvite(inv.invite_id, human.model.invites.get(inv.invite_id).check_code === code)
    agent2 = await j.client
    await agent2.start(); await agent2.whenSession()
    await human.removeDevices([agent2.my_device_id])
    await until('epoch 2', () => human.model.room.key_epoch === 2)
    await until('the agent\'s session re-keyed', async () => { await agent.catchUp().catch(() => {}); return [...agent.sessionKeys.values()].some(k => k.state.epoch === 2) })
    const id = await agent.sendCard({ title: 'After the removal', options: [{ key: 'ok', label: 'OK' }] })
    await until('new card at the human', () => human.model.cards.get(id)?.title === 'After the removal')
    const mine = await swiftOpen()
    assert.deepEqual(mine, jsOpen())
    assert.ok(mine.some(c => c.title === 'After the removal') && mine.some(c => c.title === 'How the cache works'), 'cards of both session key epochs')
  })

  await test('account: JS adds email + password, `trommi-swift login` adds itself and re-seals the session keys; wrong password refused', async () => {
    const email = 'parity@example.org', password = 'correct horse battery staple'
    await A.addAccount(human, { email, password, recovery_code: recoveryCode })
    const lhome = path.join(tmp, 'swift-login')
    const before = human.model.members.size
    const bad = await swift(['login', email, '--hub', hub.hub_url], { home: lhome, stdin: 'a wrong password 1' }).done
    assert.notEqual(bad.code, 0)
    assert.match(bad.stderr, /wrong-login/)
    assert.equal(human.model.members.size, before, 'nobody added with a wrong password')
    const r = await run(['login', email, '--hub', hub.hub_url, '--name', 'Swift login'], { home: lhome, stdin: password })
    assert.match(r.stdout, /Logged in\. This device is a member/)
    assert.ok(!r.stdout.includes(password) && !r.stderr.includes(password), 'the password is never printed')
    const id = (await run(['whoami'], { home: lhome })).stdout.match(/device ([0-9a-f]{64})/)[1]
    await until('the logged-in Swift device in the app', () => human.model.members.get(id)?.device_role === 'human' && human.model.members.get(id)?.device_name === 'Swift login')
    const cards = JSON.parse((await run(['cards', '--json'], { home: lhome })).stdout).map(c => ({ id: c.id, title: c.title, options: c.options })).sort((a, b) => a.id.localeCompare(b.id))
    assert.deepEqual(cards, jsOpen(), 'the open cards (session keys re-sealed for the new device, older epochs by back links)')
    console.log('     ' + r.stdout.trim().split('\n').join('\n     '))
  })

  await test('account from Swift: status, a new password, the Emergency Kit; "Forgot password" with its words on a new Swift device', async () => {
    const email = 'parity@example.org'
    assert.match((await run(['account'], { home })).stdout, /account parity@example\.org/)
    const kit = await run(['kit'], { home, stdin: 'correct horse battery staple' })
    const words = kit.stdout.match(/Emergency Kit for parity@example\.org: ([a-z ]+)/)[1].trim()
    assert.equal(words.split(' ').length, 12)
    await run(['passwd'], { home, stdin: 'correct horse battery staple\nanother good password 2' })
    const a = await A.loginWithPassword({ hub_url: hub.hub_url, email, password: 'another good password 2', storage: core.memoryStorage(), device_name: 'JS after Swift passwd' })
    assert.ok(a.client.my_device_id, 'the JS core logs in with the password Swift set')
    await a.client.stop?.().catch?.(() => {})
    const fhome = path.join(tmp, 'swift-forgot')
    const f = await run(['forgot', email, '--hub', hub.hub_url, '--name', 'Swift forgot'], { home: fhome, stdin: `${words}\nthe newest password 3` })
    assert.match(f.stdout, /New password set/)
    const b = await A.loginWithPassword({ hub_url: hub.hub_url, email, password: 'the newest password 3', storage: core.memoryStorage(), device_name: 'JS after Swift forgot' })
    assert.ok(b.client.my_device_id)
    await b.client.stop?.().catch?.(() => {})
  })

  await test('board: what Swift\'s Desk reads (cards, status, stack, registers) is what the app\'s core holds', async () => {
    await human.setRegisters({ [`snooze/${[...human.model.cards.keys()][0]}`]: { until: Date.now() + 3600_000 } })
    await until('the snooze at the hub', () => human.model.human.raw.has(`snooze/${[...human.model.cards.keys()][0]}`) && !human.model.human.raw.get(`snooze/${[...human.model.cards.keys()][0]}`).pending)
    await human.settle?.().catch?.(() => {})
    const d = JSON.parse((await run(['dump'], { home })).stdout)
    const status = c => (c.object_state === 'open' ? 'open' : c.closed_how === 'shredded' ? 'shredded' : c.closed_how === 'answered' && c.object_state === 'answered' ? 'decided' : 'done')
    const js = [...human.model.cards.values()].sort((a, b) => a.first_envelope_number - b.first_envelope_number).map((c, i) => ({ id: c.object_id, number: i + 1, status: status(c), title: c.title, choices: c.answer?.choices ?? [] }))
    const sw = d.cards.filter(c => c.kind !== 'permission').map(c => ({ id: c.id, number: c.number, status: c.status, title: c.title, choices: c.choices }))
    assert.deepEqual(sw, js, 'every card, its number, status and answer')
    assert.deepEqual(d.stack, human.model.stack, 'the stack (urgency, age, snoozes)')
    assert.deepEqual(d.registers, [...human.model.human.raw.keys()].sort(), 'the human registers')
  })

  await test('Swift writes: a message reaches the agent, a note and a register reach the app\'s core', async () => {
    const before = commands.length
    const to = JSON.parse((await run(['dump'], { home })).stdout).agents.find(a => a.name === 'Agent')
    const r = await run(['say', to.id], { home, stdin: 'Hello from the iPhone engine' })
    assert.match(r.stdout, /sent/)
    const cmd = await until('the message at the agent', () => commands.slice(before).find(c => c.command === 'message' && c.content?.text === 'Hello from the iPhone engine'))
    assert.equal(cmd.sender_device_id, swiftId)
    const n = await run(['note'], { home, stdin: 'a note from Swift' })
    const id = n.stdout.match(/note ([0-9a-f]{32})/)[1]
    await until('the note in the app', () => human.model.notes.get(id)?.text === 'a note from Swift')
    await run(['register', 'desk/parity', '{"name":"Parity","created_at":1}'], { home })
    await until('the desk register in the app', () => human.model.human.desks.get('parity')?.name === 'Parity')
  })

  await test('pairing from Swift: a new JS device joins with the link, the six emoji match, it gets the room and every session key', async () => {
    const linkFile = path.join(tmp, 'pair-link')
    const p = swift(['pair', '--link-out', linkFile, '--yes'], { home })
    const link = await until('the link file', () => { try { return fs.readFileSync(linkFile, 'utf8') } catch { return null } })
    const j = core.joinRoom({ link: link.replace('http://127.0.0.1/join', 'http://127.0.0.1/join'), storage: core.memoryStorage(), device_name: 'Laptop via Swift', poll_ms: 50 })
    const code = await j.check_code
    const swiftCode = await until('the check code in Swift', () => codeIn(p.stdout))
    assert.equal(swiftCode, code, 'both show the same six emoji')
    const c = await j.client
    const r = await p.done
    assert.equal(r.code, 0, r.stderr)
    assert.ok(!r.stdout.includes(link.split('#')[1]), 'the link is never printed')
    await c.start()
    await until('the new device holds the session keys', () => [...c.sessionKeys.values()].some(k => k.secrets.has(k.state.epoch)))
    await until('it reads the open cards', () => [...c.model.cards.values()].some(x => x.title === 'After the removal'))
    await c.stop()
  })

  await test('agent invite from Swift: a JS agent joins with the link, the emoji match, it gets a session of its own and its card reaches Swift', async () => {
    const linkFile = path.join(tmp, 'agent-link')
    const p = swift(['invite-agent', '--link-out', linkFile, '--yes', '--name', 'Helper from Swift'], { home })
    const link = await until('the link file', () => { try { return fs.readFileSync(linkFile, 'utf8') } catch { return null } })
    const j = core.joinRoom({ link, storage: core.memoryStorage(), device_name: 'Agent 3', device_info: { device_name: 'Agent 3', platform: 'node' }, poll_ms: 50 })
    const code = await j.check_code
    assert.equal(await until('the code in Swift', () => codeIn(p.stdout)), code)
    agent3 = await j.client
    const r = await p.done
    assert.equal(r.code, 0, r.stderr)
    await agent3.start(); await agent3.whenSession()
    const id = await agent3.sendCard({ title: 'From the agent Swift invited', options: [{ key: 'y', label: 'Yes' }, { key: 'n', label: 'No' }] })
    await until('the card in Swift', async () => (await swiftOpen()).some(c => c.id === id))
    await until('the session name in the app', () => [...human.model.sessions.values()].some(s => s.settings?.name === 'Helper from Swift'))
  })

  await test('removal from Swift: the agent is out, a new room key, every session re-keyed; the other agent still reaches both', async () => {
    const epoch = human.model.room.key_epoch
    const sessionEpoch = Math.max(...[...agent.sessionKeys.values()].map(k => k.state.epoch))
    await run(['remove', agent3.my_device_id], { home })
    await until('the agent removed in the app', () => human.model.members.get(agent3.my_device_id)?.is_active === false)
    await until('a new room key epoch', () => human.model.room.key_epoch === epoch + 1)
    await until('the other agent\'s session re-keyed (A1)', async () => { await agent.catchUp().catch(() => {}); return Math.max(...[...agent.sessionKeys.values()].map(k => k.state.epoch)) > sessionEpoch })
    const id = await agent.sendCard({ title: 'After the Swift removal', options: [{ key: 'ok', label: 'OK' }] })
    await until('the new card in the app', () => human.model.cards.get(id)?.title === 'After the Swift removal')
    await until('the new card in Swift', async () => (await swiftOpen()).some(c => c.id === id))
  })

  await test('log out from Swift: the device removes itself, the app sees it gone, nothing is left in its folder', async () => {
    const lhome = path.join(tmp, 'swift-login')
    const id = (await run(['whoami'], { home: lhome })).stdout.match(/device ([0-9a-f]{64})/)[1]
    const r = await run(['leave'], { home: lhome })
    assert.match(r.stdout, /Logged out/)
    await until('the device removed in the app', () => human.model.members.get(id)?.is_active === false)
    assert.equal(fs.readdirSync(lhome).filter(f => /^[0-9a-f]{64}$/.test(f)).length, 0, 'the room folder is gone')
  })

  await test('"They don\'t match" in the app: the Swift join stops, nobody is added', async () => {
    const inv = await human.createInvite({ device_role: 'human' })
    const p = swift(['join'], { home: path.join(tmp, 'swift-other'), stdin: inv.link })
    await until('the check code', () => codeIn(p.stdout))
    await until('confirm state', () => human.model.invites.get(inv.invite_id).invite_state === 'confirm_code')
    const before = human.model.members.size
    await human.confirmInvite(inv.invite_id, false).catch(() => {})
    const r = await p.done
    assert.notEqual(r.code, 0)
    assert.match(r.stderr, /code-mismatch|invite-burned/)
    assert.equal(human.model.members.size, before)
  })
} finally {
  for (const c of [human, agent, agent2, agent3]) await c?.stop?.().catch?.(() => {})
  hub.stop()
  console.log(`\n${passed} passed, ${failed} failed`)
  fs.rmSync(tmp, { recursive: true, force: true })
  process.exit(failed ? 1 : 0)
}
