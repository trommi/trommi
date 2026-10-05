#!/usr/bin/env node
// connect-test.mjs: "a second machine". The connect script (app/web/public/connect.sh) run as a person runs it,
//   curl -fsSL <app>/connect | sh -s '<invite link>'
// in a fresh HOME and a fresh project folder, against a local hub and a local copy of the app's files. Then the
// installed single-file connector is started as Claude Code starts it (MCP over stdio, in that folder) and must be in
// the room.
//
//   node connector/connect-test.mjs [--shell sh|dash|bash] [--docker IMAGE] [--real-claude] [--answer y] [--no-plugin]
//
// The script installs the Trommi plugin (claude plugin marketplace add + install --scope local) and starts plain
// `claude`; --no-plugin: a Claude Code without plugin support, the script falls back to .mcp.json + the channel flag.
// With --real-claude, TROMMI_MARKETPLACE may name a local marketplace directory (an https archive cannot be loopback).
//
// Without Node (--docker debian:stable-slim --answer y, as root): the script offers to install Node 22 (NodeSource) and
// goes on after the yes; --answer n: it stops with the hint.
//
// --docker runs the script inside a container (host network): node:26-slim has dash as /bin/sh, node:26-alpine
// busybox ash. Without --real-claude a stub `claude` on PATH stands in for Claude Code's `mcp add/remove` (it writes
// .mcp.json the same way), so the test needs no Claude Code login.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { spawn, execFileSync } from 'node:child_process'
import { startHub, startChannel } from './channel-test-e2e.mjs'
import { assetPath } from '../app/web/worker.js'

const here = path.dirname(new URL(import.meta.url).pathname)
const pub = path.join(here, '../app/web/public')
const arg = (name, dflt) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : dflt }
const SHELL = arg('--shell', 'sh'), IMAGE = arg('--docker', null), REAL = process.argv.includes('--real-claude'), ANSWER = arg('--answer', null), NOPLUGIN = process.argv.includes('--no-plugin')

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'trommi-connect-'))
const home = path.join(tmp, 'home'), project = path.join(tmp, 'my project'), bin = path.join(tmp, 'bin')
for (const d of [home, project, bin]) fs.mkdirSync(d, { recursive: true })

// The stub Claude Code: `claude mcp add NAME --scope project -- CMD ARGS...`, `claude mcp remove NAME --scope project`,
// and `claude plugin ...` (logged to $HOME/plugin.log; install writes enabledPlugins; fails with STUB_NO_PLUGIN=1).
fs.writeFileSync(path.join(bin, 'claude'), `#!/usr/bin/env node
const fs = require('fs'), a = process.argv.slice(2), f = '.mcp.json'
if (a[0] === 'plugin') {
  if (process.env.STUB_NO_PLUGIN) process.exit(1)
  fs.appendFileSync(process.env.HOME + '/plugin.log', a.join(' ') + '\\n')
  if (a[1] === 'install') { fs.mkdirSync('.claude', { recursive: true }); const s = '.claude/settings.local.json'; const j = fs.existsSync(s) ? JSON.parse(fs.readFileSync(s, 'utf8')) : {}; j.enabledPlugins = { [a[2]]: true }; fs.writeFileSync(s, JSON.stringify(j)) }
  process.exit(0)
}
const cfg = fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : { mcpServers: {} }
if (a[0] === 'mcp' && a[1] === 'add') { const i = a.indexOf('--'); cfg.mcpServers[a[2]] = { type: 'stdio', command: a[i + 1], args: a.slice(i + 2), env: {} } }
else if (a[0] === 'mcp' && a[1] === 'remove') { if (!cfg.mcpServers[a[2]]) process.exit(1); delete cfg.mcpServers[a[2]] }
else process.exit(2)
fs.writeFileSync(f, JSON.stringify(cfg, null, 2) + '\\n')
`, { mode: 0o755 })
// An earlier install's .mcp.json entry: the plugin install takes it away (two connectors would be two members).
fs.writeFileSync(path.join(project, '.mcp.json'), JSON.stringify({ mcpServers: { trommi: { type: 'stdio', command: 'node', args: ['/old/channel.mjs'], env: {} } } }))

// The app's three files, at the addresses app/web/worker.js serves them.
const app = http.createServer((req, res) => {
  const p = new URL(req.url, 'http://x').pathname
  const file = p === '/connect' ? 'connect.sh' : ['/connector.mjs', '/connector.mjs.sha256'].includes(p) ? assetPath(p) : null
  if (!file) { res.writeHead(404); return res.end() }
  res.writeHead(200, { 'content-type': 'text/plain' }); res.end(fs.readFileSync(path.join(pub, file)))
})
await new Promise(r => app.listen(0, '127.0.0.1', r))
const APP = `http://127.0.0.1:${app.address().port}`

const core = await import('../shared/index.mjs')
const hub = await startHub(tmp)
let human, channel
const run = (cmd, args, opts) => new Promise((resolve) => {
  const p = spawn(cmd, args, opts)
  let out = '', err = ''
  p.stdout.on('data', d => { out += d }); p.stderr.on('data', d => { err += d })
  p.on('close', code => resolve({ code, out, err }))
})
try {
  ;({ client: human } = await core.foundRoom({ hub_url: hub.hub_url, device_name: '', storage: core.memoryStorage() }))
  await human.start()
  const invite = await human.createInvite({ device_role: 'agent', app_url: 'https://app.trommi.com/join' })
  // The link is a secret: given by environment to the outer shell, never on a command line we print.
  let line = `curl -fsSL "$APP/connect" | ${IMAGE ? 'sh' : SHELL} -s "$LINK"`
  // --answer y: a terminal (script(1)) that types the answer to the script's question (install Node?) into /dev/tty.
  if (ANSWER) line = `printf '%s\\n' '${ANSWER}' | script -qec '${line}' /dev/null`
  const env = { PATH: `${REAL ? `${path.dirname(execFileSync('sh', ['-c', 'command -v claude'], { encoding: 'utf8' }).trim())}` : bin}:${path.dirname(process.execPath)}:/usr/bin:/bin`, HOME: home, APP, LINK: invite.link, TROMMI_APP: APP, ...(NOPLUGIN ? { STUB_NO_PLUGIN: '1' } : {}), ...(process.env.TROMMI_MARKETPLACE ? { TROMMI_MARKETPLACE: process.env.TROMMI_MARKETPLACE } : {}) }
  const r = IMAGE
    ? await run('docker', ['run', '--rm', '--network', 'host', '-e', 'APP', '-e', 'LINK', '-e', 'TROMMI_APP', '-e', `HOME=${home}`, ...(NOPLUGIN ? ['-e', 'STUB_NO_PLUGIN=1'] : []), '-v', `${tmp}:${tmp}`, '-w', project,
      '-e', `PATH=${bin}:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`, IMAGE, 'sh', '-c', `command -v curl >/dev/null || (apk add -q curl 2>/dev/null || (apt-get -qq update && apt-get -qq install -y curl >/dev/null)) >/dev/null 2>&1; echo "/bin/sh is $(readlink -f /bin/sh)"; ${line}; rc=$?; chown -R ${process.getuid()}:${process.getgid()} '${tmp}'; exit $rc`], { env: { ...process.env, APP, LINK: invite.link, TROMMI_APP: APP } })
    : await run('/bin/sh', ['-c', line], { cwd: project, env })
  process.stdout.write(r.out.replace(invite.link, '<link>'))
  if (r.code || !/Joined/.test(r.out)) process.stderr.write(r.err.replace(invite.link, '<link>'))
  assert.equal(r.code, 0, 'the connect script succeeds')
  assert.ok(!(r.out + r.err).includes(invite.link.split('#')[1] ?? invite.link), 'the invite secret is never printed')
  if (NOPLUGIN) assert.match(r.out, /claude --dangerously-load-development-channels server:trommi/)
  else {
    assert.match(r.out, /\n  claude\n/, 'the start command is plain claude')
    assert.match(r.out, /plugin:trommi@trommi/)
    if (!REAL) assert.deepEqual(fs.readFileSync(path.join(home, 'plugin.log'), 'utf8').trim().split('\n'), [`plugin marketplace add ${APP}/plugins/marketplace.json`, 'plugin marketplace update trommi', 'plugin install trommi@trommi --scope local', 'plugin update trommi@trommi'])
    const local = JSON.parse(fs.readFileSync(path.join(project, '.claude/settings.local.json'), 'utf8'))
    assert.equal(local.enabledPlugins['trommi@trommi'], true)
    assert.deepEqual(local.permissions.allow, ['mcp__plugin_trommi_trommi'], 'the plugin\'s board tools are allowed in this folder')
    assert.equal(JSON.parse(fs.readFileSync(path.join(project, '.mcp.json'), 'utf8')).mcpServers.trommi, undefined, 'the old .mcp.json entry is gone')
  }
  const installed = path.join(home, '.local/share/trommi/connector/channel.mjs')
  assert.ok(fs.existsSync(installed), 'the connector is installed')
  assert.equal(fs.readFileSync(`${installed}.sha256`, 'utf8').split(' ')[0], fs.readFileSync(path.join(pub, 'gen/connector.mjs.sha256'), 'utf8').trim())
  if (NOPLUGIN) {
    const mcp = JSON.parse(fs.readFileSync(path.join(project, '.mcp.json'), 'utf8')).mcpServers.trommi
    assert.deepEqual([mcp.command, ...mcp.args], ['node', installed], '.mcp.json in the project runs the installed connector')
  }
  const keys = fs.readdirSync(path.join(home, '.local/share/trommi/keys', human.model.room.room_id))
  assert.ok(keys.some(f => /^[\w-]*my-project-1\.key$/.test(f)), `a key slot named after the folder (${keys.join(', ')})`)
  // As Claude Code starts it: in the project folder, with nothing but HOME.
  channel = await startChannel({ script: installed, cwd: project, env: { HOME: home, TROMMI_KEYS_DIR: '', TROMMI_FOLDER: '', TROMMI_HUB: '' } })
  await channel.ready()
  const tools = (await channel.client.listTools()).tools.map(t => t.name)
  assert.ok(tools.includes('reply') && tools.includes('reload_connector'))
  await channel.call('reply', { text: 'hello from the second machine' })
  console.log(`ok: connect script via ${IMAGE ?? SHELL}${NOPLUGIN ? ' (no plugin support)' : ' (plugin)'}, ${tools.length} tools, connector in the room`)
} finally {
  await channel?.close().catch(() => {})
  await human?.stop().catch(() => {})
  hub.stop(); app.close()
  fs.rmSync(tmp, { recursive: true, force: true })
}
process.exit(0)
