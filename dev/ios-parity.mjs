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
let human, agent, agent2, swiftId
const commands = []
try {
  await test('JS: the human founds a room on a local hub, an agent joins (check code confirmed) and files cards', async () => {
    ;({ client: human } = await core.foundRoom({ hub_url: hub.hub_url, storage: core.memoryStorage(), device_name: 'Phone' }))
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
  for (const c of [human, agent, agent2]) await c?.stop?.().catch?.(() => {})
  hub.stop()
  console.log(`\n${passed} passed, ${failed} failed`)
  fs.rmSync(tmp, { recursive: true, force: true })
  process.exit(failed ? 1 : 0)
}
