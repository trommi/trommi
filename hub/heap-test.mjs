// Memory stays flat while one room takes many envelopes (regression for the per-chain hash map).
// Run: node --expose-gc hub/heap-test.mjs [envelopes, default 50000]
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import assert from 'node:assert/strict'
import * as z from '../crypto/zcrypto.mjs'
import { createHub } from '../crypto/hub.mjs'
import { openDb, roomStorage } from './store.mjs'

const N = Number(process.argv[2] || 50000)
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trommi-heap-'))
const HUB = 'http://127.0.0.1:1'
const db = openDb(dir)
const dev = await z.generateDevice()
const room = await z.createRoom({ device: dev, recovery: await z.recoveryDevice(z.generateRecoveryCode()) })
const hub = await createHub({ hubUrl: HUB, storage: roomStorage(db, z.hex(room.roomId)) })
await hub.found({ entry: room.entry, wraps: room.wraps })
const tok = (await hub.signIn(await z.signHubAuth({ device: dev, roomId: room.roomId, hub: HUB, challenge: hub.challenge() }))).token
const chains = z.newChains()
const heap = () => { globalThis.gc?.(); return process.memoryUsage().heapUsed / 1e6 }
const marks = []
const t0 = performance.now()
for (let i = 1; i <= N; i++) {
  const e = await z.sealEnvelope(sealArgs(i))
  await hub.postEnvelope(tok, e.bytes)
  // The sender's own chain map would grow too: keep the test client bounded like a real one.
  const own = chains.get(z.b64u(dev.id)); if (own.hashes.size > 64) own.hashes = new Map([[own.seq, own.hash]])
  if (i % Math.floor(N / 4) === 0) marks.push(heap())
}
function sealArgs(i) {
  return { device: dev, state: room.state, secret: room.secret, chains, payload: z.utf8(`message ${i}`), kind: 1, timelineKind: 1, timelineId: 'desk/' + '0d'.repeat(16) }
}
const growth = marks.at(-1) - marks[0]
console.log(`${N} envelopes in ${((performance.now() - t0) / 1000).toFixed(1)} s; heap MB at 25/50/75/100 %: ${marks.map(m => m.toFixed(1)).join(' / ')}; growth ${growth.toFixed(1)} MB`)
db.close(); fs.rmSync(dir, { recursive: true, force: true })
assert.ok(growth < 20, `heap grew by ${growth.toFixed(1)} MB from 25 % to 100 %`)
console.log('ok    heap stays flat')
