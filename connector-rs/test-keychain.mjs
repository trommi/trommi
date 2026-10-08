// The keychain path of the binary connector against a throwaway Secret Service: run through test-keychain.sh only
// (it starts a D-Bus session and a gnome-keyring of its own; this file refuses to run on the session's real bus).
//
//   sh connector-rs/test-keychain.sh            (after cargo build --release)
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import assert from 'node:assert/strict'
import { execFile, execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const BIN = process.env.TROMMI_CONNECTOR_CMD || path.join(REPO, 'connector-rs/target/release/trommi-connector')
if (!process.env.OUTER_DBUS || process.env.OUTER_DBUS === process.env.DBUS_SESSION_BUS_ADDRESS) { console.error('not in a D-Bus session of its own: run test-keychain.sh'); process.exit(2) }
const { startHub, startConnector, confirmAgents } = await import(path.join(REPO, 'connector/test-e2e.mjs'))
const core = await import(path.join(REPO, 'shared/index.mjs'))

const secrets = () => execFileSync('secret-tool', ['search', '--all', 'service', 'trommi-connector'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).split('\n').filter(l => l.startsWith('label')).length
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'trommi-keychain-'))
const hub = await startHub(tmp)
const { client: human } = await core.foundRoom({ hub_url: hub.hub_url, device_name: '', storage: core.memoryStorage() })
await human.start()
confirmAgents(human)
const keys = path.join(tmp, 'keys')
const base = dir => ({ TROMMI_KEYS_DIR: keys, TROMMI_FOLDER: dir, TROMMI_HUB: hub.hub_url, TROMMI_FOLDER_WATCH: '0' })
const join = async (dir, env) => {
  const inv = await human.createInvite({ device_role: 'agent' })
  return new Promise((res, rej) => execFile(BIN, ['join', inv.link], { cwd: dir, env: { ...process.env, ...base(dir), ...env } }, (e, so, se) => (e ? rej(Object.assign(new Error(`${e.message}\n${se}`), { stderr: se })) : res(so))))
}
const folder = name => { const d = path.join(tmp, name); fs.mkdirSync(d); return d }
let passed = 0, failed = 0
const test = async (name, fn) => { try { await fn(); passed++; console.log(`ok   ${name}`) } catch (e) { failed++; console.log(`FAIL ${name}\n     ${e.stack?.split('\n').slice(0, 4).join('\n     ')}`) } }
let alpha, beta
try {
  await test('keychain: join puts the secret into the Secret Service, the key file (0600) names it, the server opens the slot', async () => {
    alpha = folder('alpha')
    const before = secrets()
    const keyFile = /key file (\S+)/.exec(await join(alpha, { TROMMI_KEYSTORE: 'keychain' }))[1]
    assert.match(fs.readFileSync(keyFile, 'utf8'), /^trommi-keychain v1 [0-9a-f]+\n$/)
    assert.equal((fs.statSync(keyFile).mode & 0o777).toString(8), '600')
    assert.equal(secrets(), before + 1, 'one entry in the Secret Service')
    const c = await startConnector({ command: BIN, cwd: alpha, env: { ...base(alpha), TROMMI_KEYSTORE: 'auto' } })
    try { await c.ready(); await c.call('reply', { text: 'from the keychain' }) } finally { await c.close() }
  })
  await test('auto: the keychain when it answers and the slot folder has no key file with a secret in it', async () => {
    beta = folder('beta')
    const keyFile = /key file (\S+)/.exec(await join(beta, { TROMMI_KEYSTORE: 'auto' }))[1]
    assert.match(fs.readFileSync(keyFile, 'utf8'), /^trommi-keychain v1 /)
  })
  await test('auto: key files in a slot folder shared with the JS connector; the JS connector opens such a slot', async () => {
    const room = path.join(keys, human.model.room.room_id)
    fs.writeFileSync(path.join(room, 'other-host-js-folder-1.key'), Buffer.alloc(66, 1), { mode: 0o600 })   // (a JS connector's key file)
    const gamma = folder('gamma')
    const keyFile = /key file (\S+)/.exec(await join(gamma, { TROMMI_KEYSTORE: 'auto' }))[1]
    assert.equal(fs.readFileSync(keyFile).length, 66, 'the secret in the key file')
    const c = await startConnector({ cwd: gamma, env: base(gamma) })
    try { await c.ready(); await c.call('reply', { text: 'JS on the Rust slot' }) } finally { await c.close() }
  })
  await test('file: never the keychain', async () => {
    const delta = folder('delta')
    const before = secrets()
    const keyFile = /key file (\S+)/.exec(await join(delta, { TROMMI_KEYSTORE: 'file' }))[1]
    assert.equal(fs.readFileSync(keyFile).length, 66)
    assert.equal(secrets(), before)
  })
  await test('an entry that is gone: the tools say so plainly', async () => {
    execFileSync('secret-tool', ['clear', 'service', 'trommi-connector'])
    const c = await startConnector({ command: BIN, cwd: alpha, env: base(alpha) })
    try { await assert.rejects(c.call('list_cards'), /the key is not in the keychain/) } finally { await c.close() }
  })
} finally {
  await human.stop().catch(() => {})
  hub.stop()
  fs.rmSync(tmp, { recursive: true, force: true })
}
console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed ? 1 : 0)
