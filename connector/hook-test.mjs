// hook-test.mjs: the plugin's hooks (connector/hook.mjs): permission prompts of a plain `claude` on the board.
//
//   node connector/hook-test.mjs
//
// Part 1: the pieces (request, output, manifest) and the connector's desk against a scripted bridge.
// Part 2: the hook as Claude Code runs it (`node channel.mjs permission`, hook JSON on stdin) against a fake connector:
// a claimed slot with a door in this process. Allow, deny, no verdict in time, a session with the channel flag,
// no connector, no room.
// Part 3: a real hub, a scripted human and the real connector: the hook's request is the permission request of channel
// mode, the human's verdict is the hook's decision; a connector with channel events keeps the hook silent.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { createHookDesk, hookRequest, hookOutput, previewOf, ancestors, waitMs, NOTICE_TYPES } from './hook.mjs'
import { lockSlot, unlockSlot, openDoor, knock } from './channel-lock.mjs'
import { pluginManifest, pluginFiles } from './plugin.mjs'

const here = path.dirname(new URL(import.meta.url).pathname)
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'trommi-hook-'))
const results = []
let passed = 0, failed = 0
async function test(name, fn) {
  try { await fn(); passed++; results.push(`ok   ${name}`) } catch (err) { failed++; results.push(`FAIL ${name}\n     ${err.stack?.split('\n').slice(0, 4).join('\n     ')}`) }
}
const sleep = ms => new Promise(r => setTimeout(r, ms))
async function until(what, fn, ms = 15000) {
  const end = Date.now() + ms
  for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) throw new Error(`timed out waiting for ${what}`); await sleep(40) }
}
const ALLOW = '{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}'
const DENY = '{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"deny","message":"Denied by the human on the Trommi board."}}}'
const BASH = { hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: { command: 'rm -rf build', description: 'Remove the build folder' }, tool_use_id: 'toolu_1' }

/** The hook as Claude Code runs it: its JSON on stdin; resolves { code, out, err, ms }. */
function hook(kind, input, env, cwd) {
  return new Promise(resolve => {
    const t = Date.now()
    const p = spawn(process.execPath, [path.join(here, 'channel.mjs'), kind], { env: { ...process.env, ...env }, cwd, stdio: ['pipe', 'pipe', 'pipe'] })
    let out = '', err = ''
    p.stdout.on('data', d => { out += d })
    p.stderr.on('data', d => { err += d })
    p.on('exit', code => resolve({ code, out: out.trim(), err, ms: Date.now() - t }))
    p.stdin.end(typeof input === 'string' ? input : JSON.stringify(input))
    resolve.kill = () => p.kill()
  })
}

// ---- part 1 ----------------------------------------------------------------------------------------
await test('request: a tool call becomes a permission request; question dialogs and other notifications ask nothing', () => {
  const r = hookRequest('permission', BASH, {})
  assert.deepEqual({ ...r, ancestors: null }, { op: 'permission', ancestors: null, tool_name: 'Bash', description: 'Remove the build folder', input_preview: 'rm -rf build', wait_ms: 300000 })
  assert.ok(r.ancestors.includes(process.ppid))
  assert.equal(hookRequest('permission', { tool_name: 'AskUserQuestion', tool_input: {} }), null)
  assert.equal(hookRequest('permission', { tool_name: 'ExitPlanMode', tool_input: {} }), null)
  assert.equal(hookRequest('permission', null), null)
  assert.equal(hookRequest('notice', { notification_type: 'idle_prompt', message: 'x' }), null)
  assert.equal(hookRequest('notice', { notification_type: 'permission_prompt', message: 'Claude needs your permission to use Bash' }).message, 'Claude needs your permission to use Bash')
  assert.equal(previewOf({ file_path: '/a', content: 'x'.repeat(2000) }).input_preview.length, 600)
  assert.equal(waitMs({ TROMMI_PERMISSION_MS: '2000' }), 2000)
  assert.equal(waitMs({ TROMMI_PERMISSION_MS: '5' }), 1000)
  assert.ok(ancestors(process.pid)[0] === process.pid)
})
await test('output: allow and deny are Claude Code\'s decision JSON; anything else is no decision (nothing printed)', () => {
  assert.equal(hookOutput('permission', { ok: true, behavior: 'allow' }), ALLOW)
  assert.equal(hookOutput('permission', { ok: true, behavior: 'deny' }), DENY)
  for (const a of [{ ok: true, timeout: true }, { ok: true, silent: true }, { ok: false, error: 'x' }, { ok: true, behavior: 'ask' }, null]) assert.equal(hookOutput('permission', a), '')
  assert.equal(hookOutput('notice', { ok: true, behavior: 'allow' }), '')
})
await test('plugin: the manifest declares both hooks, and the zip still holds two files', () => {
  const man = pluginManifest('v1')
  const perm = man.hooks.PermissionRequest[0].hooks[0], note = man.hooks.Notification[0]
  assert.deepEqual({ type: perm.type, command: perm.command }, { type: 'command', command: 'node "${CLAUDE_PLUGIN_ROOT}/channel.mjs" permission' })
  assert.ok(perm.timeout * 1000 > waitMs({ TROMMI_PERMISSION_MS: '99999999' }), 'the hook\'s own limit is above the longest wait')
  assert.equal(note.matcher, NOTICE_TYPES.join('|'))
  assert.equal(note.hooks[0].command, 'node "${CLAUDE_PLUGIN_ROOT}/channel.mjs" notice')
  assert.deepEqual(Object.keys(pluginFiles('// c', 'v1')).sort(), ['.claude-plugin/plugin.json', 'channel.mjs'])
  assert.ok(JSON.parse(pluginFiles('// c', 'v1')['.claude-plugin/plugin.json']).hooks.PermissionRequest)
})

function scripted({ heard = false, inRoom = true } = {}) {
  const asked = [], said = []
  const bridge = { permissionRequest: async p => { asked.push(p); return 'obj' } }
  const desk = createHookDesk({ heard, bridge: () => (inRoom ? bridge : null), say: async (_, m) => { said.push(m) }, ppid: 4242, settle_ms: 60 })
  const perm = (extra = {}, gone) => desk.handle({ op: 'permission', ancestors: [7, 4242], tool_name: 'Bash', description: 'd', input_preview: 'ls', wait_ms: 1000, ...extra }, gone)
  const notice = (type = 'permission_prompt', message = 'Claude needs your permission to use Bash') => desk.handle({ op: 'notice', ancestors: [4242], notification_type: type, message })
  return { desk, asked, said, perm, notice }
}
await test('desk: the request goes out as channel mode\'s permission request and the verdict answers it', async () => {
  for (const behavior of ['allow', 'deny']) {
    const s = scripted()
    const answer = s.perm()
    await until('the request', () => s.asked.length)
    const { request_id, ...rest } = s.asked[0]
    assert.deepEqual(rest, { tool_name: 'Bash', description: 'd', input_preview: 'ls', expires_in_ms: 1000 })
    assert.match(request_id, /^hook:[0-9a-f]{16}$/)
    assert.equal(s.desk.verdict({ request_id, behavior }), true)
    assert.deepEqual(await answer, { ok: true, behavior })
    assert.equal(s.desk.verdict({ request_id, behavior }), true, 'a late verdict of a hook is still the desk\'s: never a channel notification')
    assert.equal(s.desk.verdict({ request_id: 'req1', behavior }), false, 'a verdict of channel mode is not')
  }
})
await test('desk: no verdict in time, or a hook that hung up, is a timeout; another session is refused; no room is an error', async () => {
  const s = scripted()
  assert.deepEqual(await s.perm(), { ok: true, timeout: true })
  assert.deepEqual(await s.perm({ wait_ms: 60000 }, sleep(50)), { ok: true, timeout: true })
  assert.deepEqual(await s.perm({ ancestors: [7, 8] }), { ok: false, error: 'another session' })
  assert.equal(s.asked.length, 2)
  assert.deepEqual(await scripted({ inRoom: false }).perm(), { ok: false, error: 'not in a room' })
})
await test('desk: with the channel flag both hooks of a permission prompt stay silent', async () => {
  const s = scripted({ heard: true })
  assert.deepEqual(await s.perm(), { ok: true, silent: true })
  assert.deepEqual(await s.notice(), { ok: true, silent: true })
  assert.equal(s.asked.length + s.said.length, 0)
  assert.deepEqual(await s.notice('elicitation_dialog', 'A server asks for input'), { ok: true, said: true })
})
await test('desk: "the terminal is waiting" only when no permission card stands for the prompt', async () => {
  const s = scripted()
  const open = s.perm({ wait_ms: 60000 })
  assert.deepEqual(await s.notice(), { ok: true, silent: true }, 'a card is open')
  s.desk.verdict({ request_id: s.asked[0].request_id, behavior: 'allow' })
  await open
  assert.deepEqual(await s.notice(), { ok: true, silent: true }, 'just answered on the board')
  assert.equal(s.said.length, 0)
  const t = scripted()
  assert.deepEqual(await t.perm({ wait_ms: 1000 }), { ok: true, timeout: true })
  assert.deepEqual(await t.notice(), { ok: true, said: true })
  assert.deepEqual(t.said, [{ urgent: true, text: 'The terminal is waiting for you: Claude needs your permission to use Bash' }])
  assert.deepEqual(await t.notice('idle_prompt'), { ok: true, silent: true })
})

// ---- part 2: the hook process against a fake connector ----------------------------------------------
{
  const run = path.join(tmp, 'run'), keys = path.join(tmp, 'keys'), project = path.join(tmp, 'project'), room = 'ab'.repeat(16)
  for (const d of [run, path.join(keys, room), path.join(project, '.trommi'), path.join(project, 'sub')]) fs.mkdirSync(d, { recursive: true })
  fs.chmodSync(run, 0o700)
  fs.writeFileSync(path.join(project, '.trommi/slot-base'), 'fake\n')
  const p = { dir: path.join(keys, room), key_file: path.join(keys, room, 'fake-1.key'), lock_file: path.join(keys, room, 'fake-1.lock') }
  fs.writeFileSync(p.key_file, '')
  // The door's directory comes from XDG_RUNTIME_DIR of whoever asks: this process and the hooks use the same.
  process.env.XDG_RUNTIME_DIR = run
  const env = { TROMMI_KEYS_DIR: keys, XDG_RUNTIME_DIR: run, CLAUDE_PROJECT_DIR: project, TROMMI_FOLDER: '', TROMMI_ROOM: '', TROMMI_INVITE: '', TROMMI_PERMISSION_MS: '' }
  let reply = () => ({ ok: false, error: 'unset' }), got = []
  assert.ok(lockSlot(p, 'fake'))
  const close = openDoor(p, (req, gone) => { got.push(req); return reply(req, gone) })
  await sleep(100)
  try {
    await test('hook: allow and deny from the connector are printed as the decision; exit 0', async () => {
      reply = () => ({ ok: true, behavior: 'allow' })
      const a = await hook('permission', { ...BASH, cwd: path.join(project, 'sub') }, env, path.join(project, 'sub'))
      assert.deepEqual({ code: a.code, out: a.out }, { code: 0, out: ALLOW })
      assert.deepEqual({ ...got.at(-1), ancestors: null }, { op: 'permission', ancestors: null, tool_name: 'Bash', description: 'Remove the build folder', input_preview: 'rm -rf build', wait_ms: 300000 })
      assert.ok(got.at(-1).ancestors.includes(process.pid), 'the hook names its Claude Code process (here: this test)')
      reply = () => ({ ok: true, behavior: 'deny' })
      const d = await hook('permission', BASH, { ...env, TROMMI_PERMISSION_MS: '4000' }, project)
      assert.deepEqual({ code: d.code, out: d.out }, { code: 0, out: DENY })
      assert.equal(got.at(-1).wait_ms, 4000)
    })
    await test('hook: no verdict in time, a channel session, another session: nothing printed, exit 0 (the terminal decides)', async () => {
      for (const answer of [{ ok: true, timeout: true }, { ok: true, silent: true }, { ok: false, error: 'another session' }]) {
        reply = () => answer
        const r = await hook('permission', BASH, env, project)
        assert.deepEqual({ code: r.code, out: r.out }, { code: 0, out: '' }, JSON.stringify(answer))
      }
    })
    await test('hook: a question dialog and broken input never reach the connector', async () => {
      const n = got.length
      for (const input of [{ ...BASH, tool_name: 'AskUserQuestion' }, 'not json', '']) {
        const r = await hook('permission', input, env, project)
        assert.deepEqual({ code: r.code, out: r.out }, { code: 0, out: '' })
      }
      assert.equal(got.length, n)
    })
    await test('hook: notice hands the notification on and prints nothing', async () => {
      reply = () => ({ ok: true, said: true })
      const r = await hook('notice', { hook_event_name: 'Notification', notification_type: 'permission_prompt', message: 'Claude needs your permission to use Bash' }, env, project)
      assert.deepEqual({ code: r.code, out: r.out }, { code: 0, out: '' })
      assert.deepEqual({ ...got.at(-1), ancestors: null }, { op: 'notice', ancestors: null, notification_type: 'permission_prompt', message: 'Claude needs your permission to use Bash' })
    })
    await test('hook: the connector hears when the hook is ended while it waits', async () => {
      let hungUp = false
      reply = (req, gone) => gone.then(() => { hungUp = true; return { ok: true, timeout: true } })
      const p2 = spawn(process.execPath, [path.join(here, 'channel.mjs'), 'permission'], { env: { ...process.env, ...env }, cwd: project, stdio: ['pipe', 'ignore', 'ignore'] })
      const n = got.length
      p2.stdin.end(JSON.stringify(BASH))
      await until('the request', () => got.length > n)
      p2.kill()
      await until('the door to hear it', () => hungUp)
    })
  } finally { close(); unlockSlot(p) }
  await test('hook: no connector running: nothing printed, at once', async () => {
    const r = await hook('permission', BASH, env, project)
    assert.deepEqual({ code: r.code, out: r.out }, { code: 0, out: '' })
    assert.ok(r.ms < 3000, `${r.ms} ms`)
  })
  await test('hook: a folder that is in no room: nothing printed, and nothing written into the folder', async () => {
    const bare = path.join(tmp, 'bare')
    fs.mkdirSync(bare)
    const r = await hook('permission', BASH, { ...env, CLAUDE_PROJECT_DIR: bare }, bare)
    assert.deepEqual({ code: r.code, out: r.out }, { code: 0, out: '' })
    assert.deepEqual(fs.readdirSync(bare), [])
  })
}

// ---- part 3: real hub, real connector ----------------------------------------------------------------
const haveHub = fs.existsSync(path.join(here, '../hub/server.mjs')) && fs.existsSync(path.join(here, '../core/index.mjs'))
if (haveHub) {
  const { startHub, startChannel } = await import('./channel-test-e2e.mjs')
  const core = await import('../core/index.mjs')
  const hub = await startHub(tmp)
  const run = path.join(tmp, 'run3'), project = path.join(tmp, 'project3')
  for (const d of [run, project]) fs.mkdirSync(d, { recursive: true })
  fs.chmodSync(run, 0o700)
  const env = { TROMMI_KEYS_DIR: path.join(tmp, 'keys3'), TROMMI_FOLDER: project, TROMMI_HUB: hub.hub_url, TROMMI_CHANNEL_EVENTS: 'off', XDG_RUNTIME_DIR: run, CLAUDE_PLUGIN_ROOT: '/plugin', CLAUDE_PROJECT_DIR: project, TROMMI_ROOM: '', TROMMI_INVITE: '' }
  let human, channel
  const pending = () => [...human.model.permissions.values()].filter(p => p.permission_state === 'pending')
  const infos = () => [...human.model.cards.values()].filter(c => /terminal is waiting/.test(c.title ?? ''))
  try {
    await test('e2e: the hook\'s prompt is a permission request at the human; allow on the board is the hook\'s decision', async () => {
      ;({ client: human } = await core.foundRoom({ hub_url: hub.hub_url, device_name: '', storage: core.memoryStorage() }))
      await human.start()
      const invite = await human.createInvite({ device_role: 'agent', app_url: 'https://app.trommi.com/join' })
      channel = await startChannel({ env: { ...env, TROMMI_INVITE: invite.link }, cwd: project })
      await channel.ready()
      const asked = hook('permission', BASH, env, project)
      const p = await until('the permission request at the human', () => pending()[0])
      assert.deepEqual({ tool_name: p.tool_name, description: p.description, input_preview: p.input_preview }, { tool_name: 'Bash', description: 'Remove the build folder', input_preview: 'rm -rf build' })
      assert.ok(p.expires_at - Date.now() < 301000 && p.expires_at - Date.now() > 200000, 'the request expires when the hook stops waiting')
      // The notification of the same prompt, while the card is open: no second line.
      const n = await hook('notice', { notification_type: 'permission_prompt', message: 'Claude needs your permission to use Bash' }, env, project)
      assert.deepEqual({ code: n.code, out: n.out }, { code: 0, out: '' })
      assert.equal(infos().length, 0)
      await human.verdict({ object_id: p.object_id, allow: true })
      const r = await asked
      assert.deepEqual({ code: r.code, out: r.out }, { code: 0, out: ALLOW })
      assert.ok(!channel.events.some(e => e.method === 'notifications/claude/channel/permission'), 'a hook\'s verdict is not sent to Claude Code as a channel verdict')
    })
    await test('e2e: deny on the board is a deny with a message', async () => {
      const asked = hook('permission', { ...BASH, tool_name: 'Write', tool_input: { file_path: '/etc/hosts', content: 'x' } }, env, project)
      const p = await until('the request', () => pending().find(x => x.tool_name === 'Write'))
      assert.equal(p.input_preview, '{"file_path":"/etc/hosts","content":"x"}')
      await human.verdict({ object_id: p.object_id, allow: false })
      assert.equal((await asked).out, DENY)
    })
    await test('e2e: no verdict in time: no decision, the request is over, and the notification then says the terminal waits', async () => {
      const r = await hook('permission', { ...BASH, tool_name: 'Edit' }, { ...env, TROMMI_PERMISSION_MS: '1500' }, project)
      assert.deepEqual({ code: r.code, out: r.out }, { code: 0, out: '' })
      assert.ok(r.ms >= 1500 && r.ms < 8000, `${r.ms} ms`)
      await sleep(12000)   // "just answered on the board" (the test before) has passed
      await hook('notice', { notification_type: 'permission_prompt', message: 'Claude needs your permission to use Edit' }, env, project)
      const card = await until('the info card', () => infos()[0])
      assert.equal(card.title, 'The terminal is waiting for you: Claude needs your permission to use Edit')
      assert.equal(card.urgency, 'critical')
    })
    await test('e2e: a hook of another Claude Code process is not answered by this connector', async () => {
      const paths = fs.readdirSync(path.join(env.TROMMI_KEYS_DIR, human.model.room.room_id)).find(f => f.endsWith('.key'))
      const p = { key_file: path.join(env.TROMMI_KEYS_DIR, human.model.room.room_id, paths) }
      process.env.XDG_RUNTIME_DIR = run
      assert.deepEqual(await knock(p, { op: 'permission', ancestors: [1], tool_name: 'Bash' }, 5000), { ok: false, error: 'another session' })
    })
    await test('e2e: in a session with channel events the hook stays silent and files nothing (Claude Code relays the prompt itself)', async () => {
      await channel.close()
      await until('the connector to exit', () => channel.exited)
      channel = await startChannel({ env: { ...env, TROMMI_CHANNEL_EVENTS: 'on' }, cwd: project })
      await channel.ready()
      const before = human.model.permissions.size
      const r = await hook('permission', { ...BASH, tool_name: 'NotebookEdit' }, env, project)
      assert.deepEqual({ code: r.code, out: r.out }, { code: 0, out: '' })
      assert.ok(r.ms < 5000, `${r.ms} ms`)
      await sleep(500)
      assert.equal(human.model.permissions.size, before)
    })
  } finally {
    await channel?.close().catch(() => {})
    await human?.stop().catch(() => {})
    hub.stop()
  }
} else results.push('skip part 3: hub/ or core/ missing')

console.log(results.join('\n'))
console.log(`\n${passed} passed, ${failed} failed`)
fs.rmSync(tmp, { recursive: true, force: true })
process.exit(failed ? 1 : 0)
