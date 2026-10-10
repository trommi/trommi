#!/usr/bin/env node
// build-plugin.mjs: the connector's release files: one static binary per target. Nothing of this is committed, and
// nothing here signs: releases are built and signed in CI (release/manifest.sh, release/sign.sh), and whoever
// takes a release checks it against the release key (install.sh, connector/src/update.rs).
//
//   node connector/build-plugin.mjs [dir] [--targets <t>,<t>,…] [--no-build]
//
// Targets (default all four): x86_64-unknown-linux-musl, aarch64-unknown-linux-musl (static, `cargo build` with
// rust-lld and clang), aarch64-apple-darwin, x86_64-apple-darwin (`cargo zigbuild` with zig as linker, no Apple SDK:
// nothing links an Apple framework; macOS 11 and newer). Each is written into dir (default connector/dist) under
// the name it has in a release: trommi-connector-<target>.
//
// The plugin for Claude Code is not built: it is the folder connector/plugin of the repository, which names the
// installed connector, and Claude Code reads it from the repository's marketplace (.claude-plugin/marketplace.json).
// macOS needs cargo-zigbuild (`cargo install --locked cargo-zigbuild`) and zig 0.14 (ZIG, else `zig` on PATH, else
// the newest under ~/.local/share/mise/installs/zig; `mise install zig@0.14.1`); see connector/README.md.
import fs from 'node:fs'
import path from 'node:path'
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
const CARGO = process.env.CARGO ?? path.join(process.env.HOME, '.cargo/bin/cargo')
// The workspace's target directory: the crate is a member of the repository's workspace.
const TARGET_DIR = process.env.CARGO_TARGET_DIR ?? path.join(here, '..', 'target')
export const sha256 = b => crypto.createHash('sha256').update(b).digest('hex')
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
  fs.mkdirSync(out, { recursive: true })
  for (const [t, data] of Object.entries(built)) fs.writeFileSync(path.join(out, `trommi-connector-${t}`), data, { mode: 0o755 })
  console.log(`wrote ${Object.keys(built).map(t => `trommi-connector-${t}`).join(', ')} into ${path.relative(process.cwd(), out) || '.'}`)
}
