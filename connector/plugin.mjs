// plugin.mjs: the Trommi plugin for Claude Code and the marketplace that serves it from https://app.trommi.com.
//
//   claude plugin marketplace add https://app.trommi.com/plugins/marketplace.json
//   claude plugin install trommi@trommi --scope local
//
// The plugin is two files: .claude-plugin/plugin.json and channel.mjs (the single-file connector of bundle.mjs). It
// declares the connector as MCP server "trommi", the same server as a channel (claude --dangerously-load-development-
// channels plugin:trommi@trommi still gets live <channel> events), and a monitor (`node channel.mjs monitor`,
// connector/monitor.mjs) that wakes a plain `claude` for every verified board event.
//
// bundle.mjs writes app/web/public/gen/plugins/marketplace.json and trommi-<version>.zip (a zip archive source with its
// sha256; deterministic, so --check can compare it). The version is the connector's sha256 prefix: a new connector is
// a new plugin version, and `claude plugin update trommi@trommi` (or the auto-update of the marketplace) fetches it.
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import crypto from 'node:crypto'

export const MARKETPLACE = 'trommi'
export const PLUGIN = 'trommi'

export function pluginManifest(version) {
  return {
    name: PLUGIN,
    displayName: 'Trommi',
    version,
    description: 'Connects this Claude Code session to your Trommi board: chat, decision cards and live board events, end-to-end encrypted.',
    author: { name: 'Trommi', url: 'https://trommi.com' },
    homepage: 'https://app.trommi.com',
    mcpServers: { trommi: { command: 'node', args: ['${CLAUDE_PLUGIN_ROOT}/channel.mjs'] } },
    channels: [{ server: 'trommi', displayName: 'Trommi' }],
    experimental: {
      monitors: [{ name: 'board', command: 'node "${CLAUDE_PLUGIN_ROOT}/channel.mjs" monitor', description: 'Trommi board events' }],
    },
  }
}

/** The plugin's files: { path: Buffer }. */
export function pluginFiles(connectorText, version) {
  return {
    '.claude-plugin/plugin.json': Buffer.from(JSON.stringify(pluginManifest(version), null, 2) + '\n'),
    'channel.mjs': Buffer.from(connectorText),
  }
}

/** A zip of the files with fixed dates and order: the same input gives the same bytes. */
export function zip(files) {
  const locals = [], centrals = []
  let offset = 0
  for (const name of Object.keys(files).sort()) {
    const data = files[name], packed = zlib.deflateRawSync(data, { level: 9 }), crc = zlib.crc32(data) >>> 0
    const fname = Buffer.from(name)
    const head = Buffer.alloc(30)
    head.writeUInt32LE(0x04034b50, 0); head.writeUInt16LE(20, 4); head.writeUInt16LE(0x0800, 6); head.writeUInt16LE(8, 8)
    head.writeUInt16LE(0, 10); head.writeUInt16LE(0x21, 12) // 1980-01-01 00:00
    head.writeUInt32LE(crc, 14); head.writeUInt32LE(packed.length, 18); head.writeUInt32LE(data.length, 22)
    head.writeUInt16LE(fname.length, 26); head.writeUInt16LE(0, 28)
    const cen = Buffer.alloc(46)
    cen.writeUInt32LE(0x02014b50, 0); cen.writeUInt16LE(0x031e, 4); cen.writeUInt16LE(20, 6); cen.writeUInt16LE(0x0800, 8); cen.writeUInt16LE(8, 10)
    cen.writeUInt16LE(0, 12); cen.writeUInt16LE(0x21, 14)
    cen.writeUInt32LE(crc, 16); cen.writeUInt32LE(packed.length, 20); cen.writeUInt32LE(data.length, 24)
    cen.writeUInt16LE(fname.length, 28); cen.writeUInt32LE((0o100644 << 16) >>> 0, 38); cen.writeUInt32LE(offset, 42)
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

export const sha256 = b => crypto.createHash('sha256').update(b).digest('hex')

/** marketplace.json for a plugin source (an archive {url, sha256}, or a relative path for a local test marketplace). */
export function marketplace(source, version) {
  return {
    name: MARKETPLACE,
    owner: { name: 'Trommi', url: 'https://trommi.com' },
    description: 'Trommi for Claude Code',
    plugins: [{ name: PLUGIN, displayName: 'Trommi', version, description: pluginManifest(version).description, source }],
  }
}

/** Everything bundle.mjs writes under app/web/public/gen/plugins/: { file name: Buffer }. */
export function marketplaceFiles(connectorText, app = 'https://app.trommi.com') {
  const version = sha256(connectorText).slice(0, 12)
  const archive = zip(pluginFiles(connectorText, version))
  const name = `trommi-${version}.zip`
  const json = marketplace({ source: 'archive', url: `${app}/plugins/${name}`, sha256: sha256(archive) }, version)
  return { 'marketplace.json': Buffer.from(JSON.stringify(json, null, 2) + '\n'), [name]: archive }
}

/** A local marketplace directory with the plugin unpacked (tests; claude plugin marketplace add <dir>). */
export function writeLocalMarketplace(dir, connectorText) {
  const version = sha256(connectorText).slice(0, 12)
  for (const [f, b] of Object.entries(pluginFiles(connectorText, version))) {
    fs.mkdirSync(path.dirname(path.join(dir, 'plugins/trommi', f)), { recursive: true })
    fs.writeFileSync(path.join(dir, 'plugins/trommi', f), b)
  }
  fs.mkdirSync(path.join(dir, '.claude-plugin'), { recursive: true })
  fs.writeFileSync(path.join(dir, '.claude-plugin/marketplace.json'), JSON.stringify(marketplace('./plugins/trommi', version), null, 2) + '\n')
  return { dir, plugin: path.join(dir, 'plugins/trommi'), version }
}
