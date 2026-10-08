// test.mjs: the connector's fast tests, without a hub.   node connector/test.mjs
//
//   prompt.md and connector-rs/tools.json: limits, a section per tool, an example per tool, the key rules
//   the binary (connector-rs, connector/binary.mjs) as Claude Code starts it outside a room: the handshake's
//     instructions and tools/list are prompt.md + tools.json; its version
//   the plugin's hooks: the hook process against a fake connector (a claimed slot with a door in this process)
//   the release (connector-rs/build-plugin.mjs): plugin manifest, launcher, deterministic zip, marketplace, addresses
// With a real hub: test-e2e.mjs (and connector-rs's own cargo test).

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import net from 'node:net'
import path from 'node:path'
import zlib from 'node:zlib'
import crypto from 'node:crypto'
import { spawn, execFileSync } from 'node:child_process'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { connectorCmd, parsePrompt } from './binary.mjs'
import { releaseFiles, pluginManifest, zip, LAUNCHER, ALL_TARGETS, zigShimScript } from '../connector-rs/build-plugin.mjs'
import { releaseKey, releaseHeaders } from '../app/web/worker.js'

let passed = 0, failed = 0
const results = []
async function test(name, fn) {
  try { await fn(); passed++; results.push(`ok   ${name}`) } catch (err) { failed++; results.push(`FAIL ${name}\n     ${err.stack?.split('\n').slice(0, 4).join('\n     ')}`) }
}
const here = path.dirname(new URL(import.meta.url).pathname)
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'trommi-connector-'))
const sleep = ms => new Promise(r => setTimeout(r, ms))
async function until(what, fn, ms = 15000) {
  const end = Date.now() + ms
  for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) throw new Error(`timed out waiting for ${what}`); await sleep(40) }
}
const BIN = connectorCmd()
const PROMPT = parsePrompt(fs.readFileSync(path.join(here, 'prompt.md'), 'utf8'))
const INSTRUCTIONS = PROMPT['# Instructions']
const DESCRIPTIONS = Object.fromEntries(Object.entries(PROMPT).filter(([k]) => k.startsWith('## ')).map(([k, v]) => [k.slice(3), v]))
const T = JSON.parse(fs.readFileSync(path.join(here, '../connector-rs/tools.json'), 'utf8'))
const ALL = [...T.tools, T.reload, T.inbox]
const monitorNote = tool => PROMPT['# Without channel events'].replace('<inbox>', tool)

// ---- prompt.md and tools.json ------------------------------------------------------------------------------

await test('tools.json: every tool has a schema and an example; the set is complete; session tools take session', () => {
  const names = T.tools.map(t => t.name)
  for (const n of ['reply', 'create_decision', 'create_info', 'revise_card', 'merge_cards', 'set_urgency', 'withdraw_card', 'close_card', 'set_status', 'clear_status', 'introduce', 'list_cards', 'publish_asset', 'list_assets', 'revoke_asset', 'share_asset', 'open_session', 'close_session']) assert.ok(names.includes(n), n)
  for (const t of T.tools) {
    assert.equal(t.inputSchema?.type, 'object', t.name)
    assert.ok(T.examples[t.name], `example for ${t.name}`)
    for (const k of Object.keys(T.examples[t.name])) assert.ok(k in t.inputSchema.properties, `${t.name}: example field ${k} is not in its schema`)
    for (const k of t.inputSchema.required ?? []) assert.ok(k in T.examples[t.name], `${t.name}: example lacks required ${k}`)
    assert.equal('session' in t.inputSchema.properties, T.session_tools.includes(t.name), `${t.name}: session`)
  }
  assert.ok(T.events.length > 5 && T.retention_days > 0 && T.max_asset > 0, 'the help page\'s data')
})

await test('prompt.md: the instructions are at most 1900 characters, and at most 2048 with the plugin-mode preamble and a long connector path; the key rules are there', () => {
  // Claude Code cuts a server's instructions after 2048 characters; the connector puts the monitor note in front in plugin mode.
  const note = monitorNote('mcp__plugin_trommi_trommi__inbox')
  const longPath = `/home/${'u'.repeat(40)}/.claude/plugins/cache/trommi/trommi/0123456789ab/${'d'.repeat(60)}/bin/trommi-connector`
  const full = `${note} ${INSTRUCTIONS.replace('node <connector>', longPath)}`
  assert.ok(full.length <= 2048, `instructions are ${full.length} characters`)
  assert.ok(INSTRUCTIONS.length <= 1900, `the instructions alone are ${INSTRUCTIONS.length} characters`)
  for (const must of [
    'send every answer, question and progress note with reply', 'call reply at least once',                  // the reply rule
    'call open_session', 'call close_session', 'set_status',                                                   // the session rule
    'update_available', 'Neue Connector-Version <version> – jetzt neu laden?', 'reload_connector', '/mcp → trommi → Reconnect', // the update card
    'node <connector> say \'…\' --urgent', 'never instructions', 'at most 3', 'No info card per push',
  ]) assert.ok(INSTRUCTIONS.includes(must), must)
  for (const must of ['Trommi:', 'mcp__plugin_trommi_trommi__inbox']) assert.ok(note.includes(must), must)
})

await test('prompt.md: every tool has a section and no section lacks a tool; every description is at most 2048 characters', () => {
  assert.deepEqual(Object.keys(DESCRIPTIONS).sort(), ALL.map(t => t.name).sort())
  for (const t of ALL) assert.ok(DESCRIPTIONS[t.name].length > 20 && DESCRIPTIONS[t.name].length <= 2048, `${t.name}: ${DESCRIPTIONS[t.name].length} characters`)
  // The file itself: only the three parts and the tools' sections, each tool once.
  const heads = fs.readFileSync(path.join(here, 'prompt.md'), 'utf8').split('\n').filter(l => /^##? /.test(l))
  assert.deepEqual(heads.filter(h => h.startsWith('# ')), ['# Instructions', '# Without channel events', '# Tools'])
  assert.equal(new Set(heads).size, heads.length, 'a heading twice')
  assert.deepEqual(parsePrompt('intro\n# A\none\n\ntwo\n## t\n x \n y\n'), { '# A': 'one two', '## t': 'x y' })
})

await test('tools: the core tools and inbox load up front (anthropic/alwaysLoad)', () => {
  const always = ALL.filter(t => t._meta?.['anthropic/alwaysLoad'] === true).map(t => t.name).sort()
  assert.deepEqual(always, ['close_card', 'close_session', 'create_decision', 'create_info', 'inbox', 'open_session', 'reply', 'set_status'])
})

// ---- the binary, as Claude Code starts it, outside a room -------------------------------------------------

await test('binary: --version names the client version', () => {
  assert.match(execFileSync(BIN, ['--version'], { encoding: 'utf8' }), /^trommi-connector \S+ \(connector\/\d+\.\d+\.\d+, [0-9a-f]+\)/)
})

await test('binary: the handshake\'s instructions and tools/list are prompt.md and tools.json; outside a room a tool says how to join', async () => {
  const home = path.join(tmp, 'bare-home'), folder = path.join(tmp, 'bare-project')
  for (const d of [home, folder]) fs.mkdirSync(d, { recursive: true })
  const { TROMMI_SESSION_KEY: _, CLAUDE_CODE_SESSION_ID: __, ...base } = process.env
  const transport = new StdioClientTransport({ command: BIN, args: [], cwd: folder, stderr: 'pipe',
    env: { ...base, HOME: home, TROMMI_KEYS_DIR: path.join(home, 'keys'), TROMMI_FOLDER: folder, TROMMI_CHANNEL_EVENTS: 'off', CLAUDE_PLUGIN_ROOT: '/x', TROMMI_FOLDER_WATCH: '0', TROMMI_INVITE: '', TROMMI_HUB: '', BOARD_MAX_HTML_KB: '' } })
  const client = new Client({ name: 'connector-test', version: '1' }, { capabilities: {} })
  await client.connect(transport)
  try {
    assert.equal(client.getInstructions(), `${monitorNote('mcp__plugin_trommi_trommi__inbox')} ${INSTRUCTIONS.replace('node <connector>', BIN)}`)
    const listed = (await client.listTools()).tools
    assert.deepEqual(listed.map(t => t.name), ALL.map(t => t.name), 'the tools, reload_connector, and inbox (no channel events)')
    for (const t of ALL) {
      const got = listed.find(x => x.name === t.name)
      assert.equal(got.description, DESCRIPTIONS[t.name], t.name)
      assert.deepEqual(got.inputSchema, t.inputSchema, t.name)
      assert.deepEqual(got._meta, t._meta, t.name)
    }
    const r = await client.callTool({ name: 'list_cards', arguments: {} })
    assert.equal(r.isError, true)
    assert.match(r.content[0].text, /not in a Trommi room yet.*join '<link>'/)
  } finally { await client.close() }
})

// ---- the hook as Claude Code runs it (`trommi-connector permission`, hook JSON on stdin) against a fake
// connector: a claimed slot with a door in this process ------------------------------------------------------

const ALLOW = '{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}'
const DENY = '{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"deny","message":"Denied by the human on the Trommi board."}}}'
const BASH = { hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: { command: 'rm -rf build', description: 'Remove the build folder' }, tool_use_id: 'toolu_1' }

/** The hook as Claude Code runs it: its JSON on stdin; resolves { code, out, err, ms }. */
function hook(kind, input, env, cwd) {
  return new Promise(resolve => {
    const t = Date.now()
    const p = spawn(BIN, [kind], { env: { ...process.env, ...env }, cwd, stdio: ['pipe', 'pipe', 'pipe'] })
    let out = '', err = ''
    p.stdout.on('data', d => { out += d })
    p.stderr.on('data', d => { err += d })
    p.on('exit', code => resolve({ code, out: out.trim(), err, ms: Date.now() - t }))
    p.stdin.end(typeof input === 'string' ? input : JSON.stringify(input))
  })
}

/** A slot's door as the connector opens it (src/connector/door.rs): one JSON line in, one out; `gone` when the caller hangs up. */
function openDoor(keyFile, run, handler) {
  const file = path.join(run, `trommi-${process.getuid()}`, `${crypto.createHash('sha256').update(path.resolve(keyFile)).digest('hex').slice(0, 20)}.sock`)
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  fs.rmSync(file, { force: true })
  const server = net.createServer(sock => {
    let buf = '', asked = false
    const gone = new Promise(resolve => sock.on('close', resolve))
    sock.setEncoding('utf8')
    sock.on('error', () => {})
    sock.on('data', async d => {
      if (asked) return
      buf += d
      const nl = buf.indexOf('\n')
      if (nl < 0) return
      asked = true
      const answer = await handler(JSON.parse(buf.slice(0, nl)), gone)
      if (!sock.destroyed) sock.end(JSON.stringify(answer) + '\n')
    })
  })
  server.listen(file)
  return () => { server.close(); fs.rmSync(file, { force: true }) }
}

{
  const run = path.join(tmp, 'run'), keys = path.join(tmp, 'keys'), project = path.join(tmp, 'project'), room = 'ab'.repeat(16)
  for (const d of [run, path.join(keys, room), path.join(project, '.trommi'), path.join(project, 'sub')]) fs.mkdirSync(d, { recursive: true })
  fs.chmodSync(run, 0o700)
  fs.writeFileSync(path.join(project, '.trommi/slot-base'), 'fake\n')
  const keyFile = path.join(keys, room, 'fake-1.key'), claim = path.join(keys, room, `fake-1.lock.${process.pid}`)
  fs.writeFileSync(keyFile, '')
  fs.writeFileSync(claim, 'fake', { mode: 0o600 })   // this process holds slot 1 (a live claim)
  const env = { TROMMI_KEYS_DIR: keys, XDG_RUNTIME_DIR: run, CLAUDE_PROJECT_DIR: project, TROMMI_FOLDER: '', TROMMI_ROOM: '', TROMMI_INVITE: '', TROMMI_PERMISSION_MS: '' }
  let reply = () => ({ ok: false, error: 'unset' })
  const got = []
  const close = openDoor(keyFile, run, (req, gone) => { got.push(req); return reply(req, gone) })
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
    await test('hook: answered in the terminal (PostToolUse): the call goes to the connector as resolved, nothing printed', async () => {
      reply = () => ({ ok: true, withdrawn: true })
      const r = await hook('resolved', { ...BASH, hook_event_name: 'PostToolUse', tool_response: { stdout: '' } }, env, project)
      assert.deepEqual({ code: r.code, out: r.out }, { code: 0, out: '' })
      assert.deepEqual({ ...got.at(-1), ancestors: null }, { op: 'resolved', ancestors: null, tool_name: 'Bash', description: 'Remove the build folder', input_preview: 'rm -rf build' })
    })
    await test('hook: notice hands the notification on and prints nothing; other notifications ask nothing', async () => {
      reply = () => ({ ok: true, said: true })
      const r = await hook('notice', { hook_event_name: 'Notification', notification_type: 'permission_prompt', message: 'Claude needs your permission to use Bash' }, env, project)
      assert.deepEqual({ code: r.code, out: r.out }, { code: 0, out: '' })
      assert.deepEqual({ ...got.at(-1), ancestors: null }, { op: 'notice', ancestors: null, notification_type: 'permission_prompt', message: 'Claude needs your permission to use Bash' })
      const n = got.length
      await hook('notice', { hook_event_name: 'Notification', notification_type: 'idle_prompt', message: 'x' }, env, project)
      assert.equal(got.length, n)
    })
    await test('hook: a denial goes to the connector as one line, secrets taken out, and prints nothing (no retry)', async () => {
      reply = () => ({ ok: true, said: true })
      const r = await hook('denied', { hook_event_name: 'PermissionDenied', permission_mode: 'auto', tool_name: 'Bash', tool_input: { command: 'DB_PASS=hunter2 psql prod' }, reason: 'Production Deploy' }, env, project)
      assert.deepEqual({ code: r.code, out: r.out }, { code: 0, out: '' })
      assert.deepEqual({ ...got.at(-1), ancestors: null }, { op: 'denied', ancestors: null, text: 'Auto mode blocked: Bash — Production Deploy' })
      await hook('denied', { tool_name: 'Bash', tool_input: { command: 'DB_PASS=hunter2 psql prod' } }, env, project)
      assert.equal(got.at(-1).text, 'Auto mode blocked: Bash — DB_PASS=… psql prod')
    })
    await test('hook: the connector hears when the hook is ended while it waits', async () => {
      let hungUp = false
      reply = (req, gone) => gone.then(() => { hungUp = true; return { ok: true, timeout: true } })
      const p2 = spawn(BIN, ['permission'], { env: { ...process.env, ...env }, cwd: project, stdio: ['pipe', 'ignore', 'ignore'] })
      const n = got.length
      p2.stdin.end(JSON.stringify(BASH))
      await until('the request', () => got.length > n)
      p2.kill()
      await until('the door to hear it', () => hungUp)
    })
  } finally { close(); fs.rmSync(claim, { force: true }) }
  await test('hook: no connector running: nothing printed, at once', async () => {
    const r = await hook('permission', BASH, env, project)
    assert.deepEqual({ code: r.code, out: r.out }, { code: 0, out: '' })
    assert.ok(r.ms < 3000, `${r.ms} ms`)
  })
  await test('hook: a denial with no connector: silent, at once', async () => {
    const r = await hook('denied', { tool_name: 'Bash', reason: 'x' }, env, project)
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

// ---- the release: plugin, marketplace, addresses ----------------------------------------------------------

await test('plugin: the manifest runs the launcher as MCP server, channel, monitor and the five hooks', () => {
  const man = pluginManifest('v1'), bin = '"${CLAUDE_PLUGIN_ROOT}/bin/trommi-connector"'
  assert.deepEqual(man.mcpServers.trommi, { command: '${CLAUDE_PLUGIN_ROOT}/bin/trommi-connector', args: [] })
  assert.deepEqual(man.channels, [{ server: 'trommi', displayName: 'Trommi' }])
  assert.equal(man.experimental.monitors[0].command, `${bin} monitor`)
  assert.deepEqual(man.hooks.PermissionDenied[0].hooks[0], { type: 'command', command: `${bin} denied`, timeout: 30 })
  const perm = man.hooks.PermissionRequest[0].hooks[0], note = man.hooks.Notification[0]
  assert.equal(perm.command, `${bin} permission`)
  assert.ok(perm.timeout * 1000 > 3600_000, 'the hook\'s own limit is above the longest wait (TROMMI_PERMISSION_MS, at most an hour)')
  assert.equal(note.matcher, 'permission_prompt|elicitation_dialog')
  assert.equal(note.hooks[0].command, `${bin} notice`)
  for (const ev of ['PostToolUse', 'PostToolUseFailure']) assert.deepEqual(man.hooks[ev][0].hooks[0], { type: 'command', command: `${bin} resolved`, timeout: 30, async: true })
})

await test('plugin: the launcher picks this machine\'s binary and passes the arguments on', () => {
  const dir = path.join(tmp, 'plugin/bin'), target = `${process.arch === 'arm64' ? 'aarch64' : 'x86_64'}-unknown-linux-musl`
  fs.mkdirSync(path.join(dir, target), { recursive: true })
  fs.writeFileSync(path.join(dir, 'trommi-connector'), LAUNCHER, { mode: 0o755 })
  fs.writeFileSync(path.join(dir, target, 'trommi-connector'), '#!/bin/sh\necho "ran $*"\n', { mode: 0o755 })
  assert.equal(execFileSync(path.join(dir, 'trommi-connector'), ['monitor', 'x y'], { encoding: 'utf8' }), 'ran monitor x y\n')
})

await test('plugin: the launcher picks the binary by uname on Linux and macOS (both arches) and refuses others', () => {
  const dir = path.join(tmp, 'plugin-uname'), bin = path.join(dir, 'bin'), fake = path.join(dir, 'fake')
  fs.mkdirSync(fake, { recursive: true })
  fs.mkdirSync(bin, { recursive: true })
  fs.writeFileSync(path.join(bin, 'trommi-connector'), LAUNCHER, { mode: 0o755 })
  for (const t of ALL_TARGETS) {
    fs.mkdirSync(path.join(bin, t), { recursive: true })
    fs.writeFileSync(path.join(bin, t, 'trommi-connector'), `#!/bin/sh\necho "${t} $*"\n`, { mode: 0o755 })
  }
  fs.writeFileSync(path.join(fake, 'uname'), '#!/bin/sh\ncase "$1" in -s) echo "$FAKE_S" ;; -m) echo "$FAKE_M" ;; esac\n', { mode: 0o755 })
  const run = (s, m) => execFileSync(path.join(bin, 'trommi-connector'), ['whoami'], { encoding: 'utf8', env: { ...process.env, PATH: `${fake}:${process.env.PATH}`, FAKE_S: s, FAKE_M: m }, stdio: ['ignore', 'pipe', 'pipe'] })
  assert.equal(run('Linux', 'x86_64'), 'x86_64-unknown-linux-musl whoami\n')
  assert.equal(run('Linux', 'aarch64'), 'aarch64-unknown-linux-musl whoami\n')
  assert.equal(run('Darwin', 'arm64'), 'aarch64-apple-darwin whoami\n')
  assert.equal(run('Darwin', 'x86_64'), 'x86_64-apple-darwin whoami\n')
  assert.throws(() => run('FreeBSD', 'amd64'), /no connector binary for FreeBSD\/amd64/)
})

await test('release: the zig shim puts the macOS minimum into the zig target and passes everything else on', () => {
  const dir = path.join(tmp, 'zigshim')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, "real zig's"), '#!/bin/sh\nfor a do printf "[%s]" "$a"; done\n', { mode: 0o755 })
  fs.writeFileSync(path.join(dir, 'zig'), zigShimScript(path.join(dir, "real zig's"), '11.0'), { mode: 0o755 })
  const out = execFileSync(path.join(dir, 'zig'), ['cc', '-target', 'aarch64-macos-none', 'a b', '-target', 'x86_64-linux-musl'], { encoding: 'utf8' })
  assert.equal(out, '[cc][-target][aarch64-macos.11.0-none][a b][-target][x86_64-linux-musl]')
  assert.deepEqual(ALL_TARGETS, ['x86_64-unknown-linux-musl', 'aarch64-unknown-linux-musl', 'aarch64-apple-darwin', 'x86_64-apple-darwin'])
  for (const t of ALL_TARGETS) assert.equal(releaseKey(`/connector/trommi-connector-${t}.sha256`), `connector/trommi-connector-${t}.sha256`)
})

await test('release: binaries named by content, pointers at the newest; the zip is deterministic; the marketplace names its sha256', () => {
  const built = { 'x86_64-unknown-linux-musl': Buffer.from('x86 binary'), 'aarch64-unknown-linux-musl': Buffer.from('arm binary') }
  const a = releaseFiles(built), b = releaseFiles(built)
  const h = crypto.createHash('sha256').update(built['x86_64-unknown-linux-musl']).digest('hex')
  assert.ok(a[`connector/${h}/trommi-connector-x86_64-unknown-linux-musl`].equals(built['x86_64-unknown-linux-musl']))
  assert.equal(a['connector/trommi-connector-x86_64-unknown-linux-musl.sha256'], `${h}  trommi-connector-x86_64-unknown-linux-musl\n`)
  const name = Object.keys(a).find(f => f.endsWith('.zip'))
  assert.match(name, /^plugins\/trommi-[0-9a-f]{12}\.zip$/)
  assert.ok(a[name].equals(b[name]))
  const m = JSON.parse(a['plugins/marketplace.json'])
  assert.deepEqual([m.name, m.plugins[0].name], ['trommi', 'trommi'])
  assert.equal(m.plugins[0].source.sha256, crypto.createHash('sha256').update(a[name]).digest('hex'))
  assert.equal(m.plugins[0].source.url, `https://app.trommi.com/${name}`)
  // Every file is at an address the worker serves from R2; named by content: cached for good, pointers: no-cache.
  for (const f of Object.keys(a)) assert.equal(releaseKey(`/${f}`), f, f)
  assert.equal(releaseHeaders(name)['Cache-Control'], 'public, max-age=31536000, immutable')
  assert.equal(releaseHeaders('plugins/marketplace.json')['Cache-Control'], 'no-cache')
  assert.equal(releaseHeaders('connector/trommi-connector-x86_64-unknown-linux-musl.sha256')['Cache-Control'], 'no-cache')
  for (const p of ['/connector/../x', '/plugins/x.json', '/connector/abc/trommi-connector-x', '/connector.mjs']) assert.equal(releaseKey(p), null, p)
  // Read the zip back: local headers in name order, deflated data inflates to the input, modes kept.
  const z = zip({ 'b.txt': { data: Buffer.from('bee') }, 'a.txt': { data: Buffer.from('ay'), mode: 0o755 } })
  assert.equal(z.readUInt32LE(0), 0x04034b50)
  const n1 = z.readUInt16LE(26), c1 = z.readUInt32LE(18)
  assert.equal(z.subarray(30, 30 + n1).toString(), 'a.txt')
  assert.equal(zlib.inflateRawSync(z.subarray(30 + n1, 30 + n1 + c1)).toString(), 'ay')
  const cen = z.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]))
  assert.equal((z.readUInt32LE(cen + 38) >>> 16) & 0o777, 0o755)
})

console.log(results.join('\n'))
console.log(`\n${passed} passed, ${failed} failed`)
fs.rmSync(tmp, { recursive: true, force: true })
process.exit(failed ? 1 : 0)
