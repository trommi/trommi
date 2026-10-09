#!/usr/bin/env node
// build-plugin.mjs: the connector's release: the static binaries, the Trommi plugin for Claude Code and its
// marketplace, at the addresses the app serves them under. Nothing of this is committed, and nothing here signs:
// releases are built and signed in CI, and a connector checks a new binary against the release key that is
// compiled in (connector/src/update.rs).
//
//   node connector/build-plugin.mjs [dir] [--targets <t>,<t>,…] [--no-build] [--app https://app.trommi.com]
//
// Targets (default all four): x86_64-unknown-linux-musl, aarch64-unknown-linux-musl (static, `cargo build` with
// rust-lld and clang), aarch64-apple-darwin, x86_64-apple-darwin (`cargo zigbuild` with zig as linker, no Apple SDK:
// nothing links an Apple framework; macOS 11 and newer). Each
// built into dir (default connector/dist), each file at its address under the app:
//
//   connector/<sha256>/trommi-connector-<target>    the binary, named by its content (what connect.sh downloads)
//   connector/trommi-connector-<target>.sha256      "<sha256>  trommi-connector-<target>": the newest binary
//   plugins/trommi-<version>.zip, plugins/marketplace.json
//       the plugin: .claude-plugin/plugin.json, bin/trommi-connector (a POSIX sh launcher that picks the binary of the
//       machine by `uname -s`/`uname -m`) and bin/<target>/trommi-connector for every target built. Version: the first
//       12 hex of the SHA-256 over all binaries. The zip is deterministic and keeps the mode (0755) of the launcher
//       and the binaries.
//
// The files named by their content never change; the .sha256 files and marketplace.json point at the newest.
// macOS needs cargo-zigbuild (`cargo install --locked cargo-zigbuild`) and zig 0.14 (ZIG, else `zig` on PATH, else
// the newest under ~/.local/share/mise/installs/zig; `mise install zig@0.14.1`); see connector/README.md.
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import crypto from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const argv = process.argv.slice(2)
const opt = name => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : null }
const out = path.resolve(argv.find((a, i) => !a.startsWith('--') && !argv[i - 1]?.startsWith('--')) ?? path.join(here, 'dist'))
export const ALL_TARGETS = ['x86_64-unknown-linux-musl', 'aarch64-unknown-linux-musl', 'aarch64-apple-darwin', 'x86_64-apple-darwin']
const TARGETS = opt('--targets')?.split(',') ?? ALL_TARGETS
const MACOS_MIN = '11.0'
const APP = opt('--app') ?? 'https://app.trommi.com'
const CARGO = process.env.CARGO ?? path.join(process.env.HOME, '.cargo/bin/cargo')
// The workspace's target directory: the crate is a member of the repository's workspace.
const TARGET_DIR = process.env.CARGO_TARGET_DIR ?? path.join(here, '..', 'target')
export const sha256 = b => crypto.createHash('sha256').update(b).digest('hex')
// As connector/src/hooks.rs: the permission hook waits up to an hour for the human; the notices it relays.
const HOOK_TIMEOUT_S = 3700
const NOTICE_TYPES = ['permission_prompt', 'elicitation_dialog']
// The terminal mirror's hooks (src/mirror.rs) hand one line to the connector and end: they give up after 2 s themselves.
const MIRROR_TIMEOUT_S = 5

/** The plugin manifest: the connector as MCP server "trommi" (and its channel), the hooks and the monitor. */
export function pluginManifest(version) {
  const bin = '"${CLAUDE_PLUGIN_ROOT}/bin/trommi-connector"'
  const TRAIL = { type: 'command', command: `${bin} trail`, timeout: MIRROR_TIMEOUT_S }
  const TRAIL_ASYNC = { ...TRAIL, async: true }
  return {
    name: 'trommi',
    displayName: 'Trommi',
    version,
    description: 'Connects this Claude Code session to your Trommi board: chat, decision cards and live board events, end-to-end encrypted.',
    author: { name: 'Trommi', url: 'https://trommi.com' },
    homepage: 'https://app.trommi.com',
    mcpServers: { trommi: { command: '${CLAUDE_PLUGIN_ROOT}/bin/trommi-connector', args: [] } },
    channels: [{ server: 'trommi', displayName: 'Trommi' }],
    hooks: {
      PermissionRequest: [{ hooks: [{ type: 'command', command: `${bin} permission`, timeout: HOOK_TIMEOUT_S }] }],
      PostToolUse: [{ hooks: [{ type: 'command', command: `${bin} resolved`, timeout: 30, async: true }, TRAIL_ASYNC] }],
      PostToolUseFailure: [{ hooks: [{ type: 'command', command: `${bin} resolved`, timeout: 30, async: true }, TRAIL_ASYNC] }],
      PermissionDenied: [{ hooks: [{ type: 'command', command: `${bin} denied`, timeout: 30 }] }],
      Notification: [{ matcher: NOTICE_TYPES.join('|'), hooks: [{ type: 'command', command: `${bin} notice`, timeout: 60 }] }],
      // the terminal mirror: what the human types and the agent's final text of a turn go into the session's chat
      UserPromptSubmit: [{ hooks: [{ type: 'command', command: `${bin} prompt`, timeout: MIRROR_TIMEOUT_S }] }],
      Stop: [{ hooks: [{ type: 'command', command: `${bin} stop`, timeout: MIRROR_TIMEOUT_S }] }],
      // a turn's trail (src/connector/trail.rs): the agent's words between its steps, each step, helpers, how a turn broke off.
      // PreToolUse cannot run async (it may decide): the hook hands its line over and ends, like the two above.
      PreToolUse: [{ hooks: [TRAIL] }],
      MessageDisplay: [{ hooks: [TRAIL_ASYNC] }],
      SubagentStart: [{ hooks: [TRAIL_ASYNC] }],
      SubagentStop: [{ hooks: [TRAIL_ASYNC] }],
      StopFailure: [{ hooks: [TRAIL] }],
      SessionEnd: [{ hooks: [TRAIL] }],
    },
    experimental: { monitors: [{ name: 'board', command: `${bin} monitor`, description: 'Trommi board events' }] },
  }
}

/** The launcher: picks bin/<target>/trommi-connector by the machine. */
export const LAUNCHER = `#!/bin/sh
# Trommi connector launcher: runs the binary of this machine (made by connector/build-plugin.mjs).
here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
case "$(uname -s)/$(uname -m)" in
  Linux/x86_64|Linux/amd64) t=x86_64-unknown-linux-musl ;;
  Linux/aarch64|Linux/arm64) t=aarch64-unknown-linux-musl ;;
  Darwin/arm64|Darwin/aarch64) t=aarch64-apple-darwin ;;
  Darwin/x86_64) t=x86_64-apple-darwin ;;
  *) echo "trommi: no connector binary for $(uname -s)/$(uname -m)" >&2; exit 1 ;;
esac
[ -x "$here/$t/trommi-connector" ] || { echo "trommi: this plugin has no connector for $t" >&2; exit 1; }
exec "$here/$t/trommi-connector" "$@"
`

/** A zip with fixed dates and order, keeping each file's mode: { name: { data, mode } }. */
export function zip(files) {
  const locals = [], centrals = []
  let offset = 0
  for (const name of Object.keys(files).sort()) {
    const { data, mode = 0o644 } = files[name]
    const packed = zlib.deflateRawSync(data, { level: 9 }), crc = zlib.crc32(data) >>> 0
    const fname = Buffer.from(name)
    const head = Buffer.alloc(30)
    head.writeUInt32LE(0x04034b50, 0); head.writeUInt16LE(20, 4); head.writeUInt16LE(0x0800, 6); head.writeUInt16LE(8, 8)
    head.writeUInt16LE(0, 10); head.writeUInt16LE(0x21, 12)
    head.writeUInt32LE(crc, 14); head.writeUInt32LE(packed.length, 18); head.writeUInt32LE(data.length, 22)
    head.writeUInt16LE(fname.length, 26); head.writeUInt16LE(0, 28)
    const cen = Buffer.alloc(46)
    cen.writeUInt32LE(0x02014b50, 0); cen.writeUInt16LE(0x031e, 4); cen.writeUInt16LE(20, 6); cen.writeUInt16LE(0x0800, 8); cen.writeUInt16LE(8, 10)
    cen.writeUInt16LE(0, 12); cen.writeUInt16LE(0x21, 14)
    cen.writeUInt32LE(crc, 16); cen.writeUInt32LE(packed.length, 20); cen.writeUInt32LE(data.length, 24)
    cen.writeUInt16LE(fname.length, 28); cen.writeUInt32LE(((0o100000 | mode) << 16) >>> 0, 38); cen.writeUInt32LE(offset, 42)
    locals.push(head, fname, packed)
    centrals.push(cen, fname)
    offset += head.length + fname.length + packed.length
  }
  const cdir = Buffer.concat(centrals)
  const end = Buffer.alloc(22)
  const n = Object.keys(files).length
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(n, 8); end.writeUInt16LE(n, 10); end.writeUInt32LE(cdir.length, 12); end.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, cdir, end])
}

function build(target) {
  if (argv.includes('--no-build')) return
  const env = { ...process.env }
  // static musl with the Rust toolchain's own linker; clang compiles ring's C/assembly for the target (no cross gcc)
  if (target.endsWith('-linux-musl')) {
    env[`CARGO_TARGET_${target.toUpperCase().replace(/-/g, '_')}_LINKER`] ??= 'rust-lld'
    env[`CC_${target.replace(/-/g, '_')}`] ??= `clang --target=${target.replace('-unknown-', '-')}`
  }
  if (target.endsWith('-apple-darwin')) {
    env.MACOSX_DEPLOYMENT_TARGET = MACOS_MIN
    env.CARGO_ZIGBUILD_ZIG_PATH = zigShim()
    execFileSync(CARGO, ['zigbuild', '--release', '--locked', '-p', 'trommi-connector', '--target', target], { cwd: here, env, stdio: 'inherit' })
    return
  }
  execFileSync(CARGO, ['build', '--release', '--locked', '-p', 'trommi-connector', '--target', target], { cwd: here, env, stdio: 'inherit' })
}

/** zig for macOS links: ZIG, a `zig` on PATH that answers, or the newest zig mise installed. */
function findZig() {
  if (process.env.ZIG) return process.env.ZIG
  const mise = path.join(process.env.HOME, '.local/share/mise/installs/zig')
  const installed = fs.existsSync(mise) ? fs.readdirSync(mise).filter(x => /^\d+\.\d+\.\d+$/.test(x)).sort((a, b) => b.localeCompare(a, 'en', { numeric: true })) : []
  const candidates = [...(process.env.PATH ?? '').split(':').filter(Boolean).map(d => path.join(d, 'zig')), ...installed.map(v => path.join(mise, v, 'zig'))]
  for (const z of candidates) {
    try { if (/^\d+\.\d+/.test(execFileSync(z, ['version'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }))) return z } catch {}
  }
  throw new Error('no zig for the macOS targets (ZIG=<path>, or `mise install zig@0.14.1`)')
}

/**
 * A zig that puts the deployment target into cargo-zigbuild's `<arch>-macos-none` (zig ignores
 * MACOSX_DEPLOYMENT_TARGET and -mmacosx-version-min and would stamp its own minimum, macOS 13).
 */
export const zigShimScript = (zig, min) => `#!/bin/sh
for a do
  shift
  case "$a" in *-macos-none) a="\${a%-macos-none}-macos.${min}-none" ;; esac
  set -- "$@" "$a"
done
exec '${zig.replace(/'/g, "'\\''")}' "$@"
`
function zigShim() {
  const file = path.join(TARGET_DIR, 'zig-macos', 'zig')
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, zigShimScript(findZig(), MACOS_MIN), { mode: 0o755 })
  return file
}

/**
 * The release: { 'path under the app': Buffer or text } (see the top of this file). `built` is { target: Buffer }.
 */
export function releaseFiles(built, { app = 'https://app.trommi.com' } = {}) {
  const files = {}
  for (const [t, data] of Object.entries(built)) {
    const name = `trommi-connector-${t}`, hash = sha256(data)
    files[`connector/${hash}/${name}`] = data
    files[`connector/${name}.sha256`] = `${hash}  ${name}\n`
  }
  const version = sha256(Buffer.concat(Object.keys(built).sort().map(t => built[t]))).slice(0, 12)
  const archive = zip({
    '.claude-plugin/plugin.json': { data: Buffer.from(JSON.stringify(pluginManifest(version), null, 2) + '\n') },
    'bin/trommi-connector': { data: Buffer.from(LAUNCHER), mode: 0o755 },
    ...Object.fromEntries(Object.entries(built).map(([t, data]) => [`bin/${t}/trommi-connector`, { data, mode: 0o755 }])),
  })
  const zipName = `trommi-${version}.zip`
  files[`plugins/${zipName}`] = archive
  files['plugins/marketplace.json'] = JSON.stringify({ name: 'trommi', owner: { name: 'Trommi', url: 'https://trommi.com' }, description: 'Trommi for Claude Code',
    plugins: [{ name: 'trommi', displayName: 'Trommi', version, description: pluginManifest(version).description, source: { source: 'archive', url: `${app}/plugins/${zipName}`, sha256: sha256(archive) } }] }, null, 2) + '\n'
  return files
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const built = {}
  for (const t of TARGETS) {
    try { build(t) } catch (e) { console.error(`skipped ${t}: the build failed (${e.message.split('\n')[0]})`); continue }
    const bin = path.join(TARGET_DIR, t, 'release', 'trommi-connector')
    if (!fs.existsSync(bin)) { console.error(`skipped ${t}: no ${path.relative(process.cwd(), bin)}`); continue }
    built[t] = fs.readFileSync(bin)
    console.log(`trommi-connector-${t}: ${(built[t].length / 1048576).toFixed(1)} MiB, sha256 ${sha256(built[t]).slice(0, 12)}`)
  }
  if (!Object.keys(built).length) { console.error('nothing built'); process.exit(1) }
  const files = releaseFiles(built, { app: APP })
  for (const d of ['connector', 'plugins']) fs.rmSync(path.join(out, d), { recursive: true, force: true })
  for (const [f, data] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(out, f)), { recursive: true })
    fs.writeFileSync(path.join(out, f), data, { mode: /trommi-connector-[\w-]+$/.test(f) ? 0o755 : 0o644 })
  }
  console.log(`wrote ${Object.keys(files).join(', ')} into ${path.relative(process.cwd(), out) || '.'}`)
}
