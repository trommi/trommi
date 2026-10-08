#!/usr/bin/env node
// build-plugin.mjs: the Rust connector as the Trommi plugin for Claude Code, beside connector/build.mjs (which makes
// the JS single-file connector's plugin). Nothing of this is committed.
//
//   node connector-rs/build-plugin.mjs [dir] [--targets x86_64-unknown-linux-musl,aarch64-unknown-linux-musl,aarch64-apple-darwin]
//                                            [--no-build] [--app https://app.trommi.com]
//
// For every target: `cargo build --release --target <t>` (static: musl on Linux), then
//
//   trommi-connector-<target>             the binary
//   trommi-connector-<target>.sha256      its SHA-256
//   trommi-connector-<target>.sig         its signature (Ed25519 over "trommi-release/v1" 0x00 sha256), when TROMMI_RELEASE_KEY
//                                         names a file with the 32-byte seed (hex or base64url); the public key goes to
//                                         release-key.pub.
//   plugins/marketplace.json, plugins/trommi-rs-<version>.zip
//       the plugin: .claude-plugin/plugin.json, bin/trommi-connector (a POSIX sh launcher that picks the binary of the
//       machine by `uname -s`/`uname -m`) and bin/<target>/trommi-connector for every target built. The manifest is
//       connector/build.mjs's, with `${CLAUDE_PLUGIN_ROOT}/bin/trommi-connector …` for `node connector.mjs …`.
//       Version: the first 12 hex of the SHA-256 over all binaries. The zip is deterministic and keeps the mode
//       (0755) of the launcher and the binaries.
//
// A target whose toolchain is missing is skipped with a note (macOS needs the Apple SDK: build it on a Mac with
// `cargo build --release --target aarch64-apple-darwin`, or with cargo-zigbuild; see connector-rs/README.md).
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import crypto from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { HOOK_TIMEOUT_S, NOTICE_TYPES } from '../connector/connector.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const argv = process.argv.slice(2)
const opt = name => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : null }
const out = path.resolve(argv.find((a, i) => !a.startsWith('--') && !argv[i - 1]?.startsWith('--')) ?? path.join(here, 'dist'))
const TARGETS = (opt('--targets') ?? 'x86_64-unknown-linux-musl,aarch64-unknown-linux-musl,aarch64-apple-darwin').split(',')
const APP = opt('--app') ?? 'https://app.trommi.com'
const CARGO = process.env.CARGO ?? path.join(process.env.HOME, '.cargo/bin/cargo')
export const sha256 = b => crypto.createHash('sha256').update(b).digest('hex')

/** The plugin manifest: connector/build.mjs's, with the binary for `node connector.mjs`. */
export function pluginManifest(version) {
  const bin = '"${CLAUDE_PLUGIN_ROOT}/bin/trommi-connector"'
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
      PostToolUse: [{ hooks: [{ type: 'command', command: `${bin} resolved`, timeout: 30, async: true }] }],
      PostToolUseFailure: [{ hooks: [{ type: 'command', command: `${bin} resolved`, timeout: 30, async: true }] }],
      PermissionDenied: [{ hooks: [{ type: 'command', command: `${bin} denied`, timeout: 30 }] }],
      Notification: [{ matcher: NOTICE_TYPES.join('|'), hooks: [{ type: 'command', command: `${bin} notice`, timeout: 60 }] }],
    },
    experimental: { monitors: [{ name: 'board', command: `${bin} monitor`, description: 'Trommi board events' }] },
  }
}

/** The launcher: picks bin/<target>/trommi-connector by the machine. */
export const LAUNCHER = `#!/bin/sh
# Trommi connector launcher: runs the binary of this machine (made by connector-rs/build-plugin.mjs).
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

/** Ed25519 over utf8("trommi-release/v1") 0x00 sha256(binary): the release signature. */
export function signRelease(seed, binary) {
  const der = Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), seed])
  const key = crypto.createPrivateKey({ key: der, format: 'der', type: 'pkcs8' })
  const msg = Buffer.concat([Buffer.from('trommi-release/v1\0'), crypto.createHash('sha256').update(binary).digest()])
  const pub = crypto.createPublicKey(key).export({ format: 'der', type: 'spki' }).subarray(-32)
  return { signature: crypto.sign(null, msg, key), publicKey: pub }
}
function releaseSeed() {
  const f = process.env.TROMMI_RELEASE_KEY
  if (!f) return null
  const t = fs.readFileSync(f, 'utf8').trim()
  const b = /^[0-9a-f]{64}$/i.test(t) ? Buffer.from(t, 'hex') : Buffer.from(t, 'base64url')
  if (b.length !== 32) throw new Error('TROMMI_RELEASE_KEY: a 32-byte Ed25519 seed (hex or base64url)')
  return b
}

function build(target) {
  if (argv.includes('--no-build')) return
  const env = { ...process.env }
  // static musl with the Rust toolchain's own linker; clang compiles ring's C/assembly for the target (no cross gcc)
  if (target.endsWith('-linux-musl')) {
    env[`CARGO_TARGET_${target.toUpperCase().replace(/-/g, '_')}_LINKER`] ??= 'rust-lld'
    env[`CC_${target.replace(/-/g, '_')}`] ??= `clang --target=${target.replace('-unknown-', '-')}`
  }
  execFileSync(CARGO, ['build', '--release', '--target', target], { cwd: here, env, stdio: 'inherit' })
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  fs.mkdirSync(out, { recursive: true })
  const seed = releaseSeed()
  const built = {}
  for (const t of TARGETS) {
    try { build(t) } catch (e) { console.error(`skipped ${t}: the build failed (${e.message.split('\n')[0]})`); continue }
    const bin = path.join(here, 'target', t, 'release', 'trommi-connector')
    if (!fs.existsSync(bin)) { console.error(`skipped ${t}: no ${path.relative(process.cwd(), bin)}`); continue }
    const data = fs.readFileSync(bin)
    built[t] = data
    const name = `trommi-connector-${t}`
    fs.writeFileSync(path.join(out, name), data, { mode: 0o755 })
    fs.writeFileSync(path.join(out, `${name}.sha256`), `${sha256(data)}  ${name}\n`)
    if (seed) {
      const { signature, publicKey } = signRelease(seed, data)
      fs.writeFileSync(path.join(out, `${name}.sig`), signature.toString('base64url') + '\n')
      fs.writeFileSync(path.join(out, 'release-key.pub'), publicKey.toString('base64url') + '\n')
    }
    console.log(`${name}: ${(data.length / 1048576).toFixed(1)} MiB, sha256 ${sha256(data).slice(0, 12)}${seed ? ', signed' : ''}`)
  }
  if (!Object.keys(built).length) { console.error('nothing built'); process.exit(1) }
  const version = sha256(Buffer.concat(Object.keys(built).sort().map(t => built[t]))).slice(0, 12)
  const files = {
    '.claude-plugin/plugin.json': { data: Buffer.from(JSON.stringify(pluginManifest(version), null, 2) + '\n') },
    'bin/trommi-connector': { data: Buffer.from(LAUNCHER), mode: 0o755 },
    ...Object.fromEntries(Object.entries(built).map(([t, data]) => [`bin/${t}/trommi-connector`, { data, mode: 0o755 }])),
  }
  const archive = zip(files)
  const zipName = `trommi-rs-${version}.zip`
  fs.mkdirSync(path.join(out, 'plugins'), { recursive: true })
  fs.writeFileSync(path.join(out, 'plugins', zipName), archive)
  const market = { name: 'trommi', owner: { name: 'Trommi', url: 'https://trommi.com' }, description: 'Trommi for Claude Code',
    plugins: [{ name: 'trommi', displayName: 'Trommi', version, description: pluginManifest(version).description, source: { source: 'archive', url: `${APP}/plugins/${zipName}`, sha256: sha256(archive) } }] }
  fs.writeFileSync(path.join(out, 'plugins', 'marketplace.json'), JSON.stringify(market, null, 2) + '\n')
  console.log(`plugin ${zipName} (${(archive.length / 1048576).toFixed(1)} MiB) and marketplace.json in ${path.relative(process.cwd(), out) || '.'}`)
}
