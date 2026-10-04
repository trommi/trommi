// rotation.mjs: the cost of removing a member (one member entry, a new key epoch sealed for everyone who stays)
// in a room with 20+ members, all live (streams open). Measures, per removal: the crypto part alone
// (z.removeMembers), the whole call (removeDevices: refresh, seal, POST, refresh), and the time until every remaining
// member works in the new epoch; then a card in the new epoch reaching a human.
//
//   node dev/e2e/rotation.mjs --hub=local|<url> --agents=24 --humans=3 --removals=3 [--test-key=<file>] [--out=<file.json>]
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { z } from '../../client/core/index.mjs'
import { arg, until, pct, found, addAgent, addHuman, startLocalHub, useTestKey, deleteTestRoom, writeJson } from './lib.mjs'

const HUB = arg('hub', 'local')
const AGENTS = Number(arg('agents', 24)), HUMANS = Number(arg('humans', 3)), REMOVALS = Number(arg('removals', 3))
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trommi-rotation-'))
await useTestKey(arg('test-key', null))
let hubUrl = HUB, local = null
if (HUB === 'local') { local = await startLocalHub({ data: path.join(dir, 'hub'), metrics: path.join(dir, 'm.jsonl') }); hubUrl = local.hub_url }
const { client: phone } = await found({ hub_url: hubUrl, dir })
const members = [phone]
for (let i = 1; i < HUMANS; i++) { const { client } = await addHuman(phone, { dir: path.join(dir, `h${i}`), name: `h${i}` }); await client.start(); members.push(client) }
const agents = []
for (let i = 0; i < AGENTS; i++) { const { client } = await addAgent(phone, { dir: path.join(dir, `a${i}`), name: `a${i}` }); await client.start(); agents.push(client); members.push(client) }
await until(() => members.every(c => c.model.members.size === members.length), 'everyone sees everyone', 120_000)
const out = { hub: HUB, members_at_start: members.length, removals: [] }
console.log(`${members.length} members live`)
let alive = [...members]
for (let r = 0; r < REMOVALS; r++) {
  const victim = agents[r]
  const epoch0 = phone.model.room.key_epoch
  // the crypto part alone, on the current state (not posted)
  const tc = performance.now()
  const dry = await z.removeMembers(phone.state, phone.device, { ids: [victim.device.id], previous: phone.secrets.get(phone.state.epoch) })
  const cryptoMs = performance.now() - tc
  const t = performance.now()
  await phone.removeDevices([victim.my_device_id])
  const callMs = performance.now() - t
  alive = alive.filter(c => c !== victim)
  await until(() => alive.every(c => c.model.room.key_epoch === epoch0 + 1), 'all in the new epoch', 60_000)
  const allMs = performance.now() - t
  const sender = agents[REMOVALS + r]
  const ts = performance.now()
  const id = await sender.sendCard({ title: `after removal ${r}`, options: [{ key: 'a', label: 'A' }] })
  await until(() => members[1]?.model.cards.get(id)?.title === `after removal ${r}` || phone.model.cards.get(id)?.title === `after removal ${r}`, 'card in the new epoch', 30_000)
  const cardMs = performance.now() - ts
  const rec = { members_staying: alive.length, wraps: dry.wraps.length, crypto_ms: +cryptoMs.toFixed(1), remove_call_ms: Math.round(callMs), all_members_switched_ms: Math.round(allMs), first_card_after_ms: Math.round(cardMs) }
  out.removals.push(rec)
  console.log(JSON.stringify(rec))
}
out.summary = { crypto_ms: pct(out.removals.map(x => x.crypto_ms)), remove_call_ms: pct(out.removals.map(x => x.remove_call_ms)), all_members_switched_ms: pct(out.removals.map(x => x.all_members_switched_ms)) }
for (const c of members) await c.stop().catch(() => {})
out.deleted = await deleteTestRoom(hubUrl, phone.model.room.room_id).catch(e => ({ error: e.message }))
if (arg('out', null)) writeJson(arg('out'), out)
if (local) await local.stop()
fs.rmSync(dir, { recursive: true, force: true })
console.log(JSON.stringify(out.summary))
process.exit(0)
