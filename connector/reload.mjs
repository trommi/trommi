// reload.mjs: connector updates without losing the session.
//
// The connector has two parts:
//   shell   channel.mjs, channel-lock.mjs, reload.mjs and the core (../core): stdio, the MCP server, the key, the lease,
//           the stream. A change here needs a real restart (in Claude Code: /mcp -> trommi -> Reconnect).
//   code    channel-tools.mjs, channel-bridge.mjs, richhtml.mjs: tool definitions, instructions and the bridge between
//           tools/commands and the core. A change here is hot-reloaded: imported again as ./<file>?v=<hash>, the
//           tool list is swapped and Claude Code is told (notifications/tools/list_changed).
//
// Detection: the hashes of both parts on disk are compared with the loaded ones (fs.watch on the folders, and every
// TROMMI_UPDATE_POLL_MS, default 60 s); the hub's GET /v1/version names a recommended channel version (hourly,
// TROMMI_VERSION_CHECK_MS); a hub that refuses this client (426 client-too-old, stream event upgrade_required) stops it.
//
// The single-file connector (connector/bundle.mjs -> app/web/public/connector.mjs, installed by the connect script as
// ~/.local/share/trommi/connector/channel.mjs) has no sibling files: code and shell are one file there, so any new
// version of it needs the restart, and loadCode is never used.
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { registerHooks } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
// Set by connector/bundle.mjs (esbuild define): this module runs inside the single-file connector.
const BUNDLED = typeof __TROMMI_BUNDLE__ !== 'undefined'
const SELF = fileURLToPath(import.meta.url)
const CORE = path.join(HERE, '../core')
export const CODE_FILES = ['channel-tools.mjs', 'channel-bridge.mjs', 'richhtml.mjs']
const SHELL_FILES = ['channel.mjs', 'channel-lock.mjs', 'reload.mjs', 'monitor.mjs']
const isTest = f => /(^test|-test|test-)[\w-]*\.mjs$/.test(f) || f === 'load.mjs'

const hashOf = files => {
  const h = crypto.createHash('sha256')
  for (const f of files) { h.update(f); try { h.update(fs.readFileSync(f)) } catch { h.update('missing') } }
  return h.digest('hex').slice(0, 12)
}
const coreFiles = () => { try { return fs.readdirSync(CORE).filter(f => f.endsWith('.mjs') && !isTest(f)).sort().map(f => path.join(CORE, f)) } catch { return [] } }
/** Hashes of the two parts as they are on disk now. */
export const diskVersion = () => (BUNDLED ? { code: hashOf([SELF]), shell: hashOf([SELF]) } : {
  code: hashOf(CODE_FILES.map(f => path.join(HERE, f))),
  shell: hashOf([...SHELL_FILES.map(f => path.join(HERE, f)), ...coreFiles()]),
})

// A module of the code part imported as <file>?v=X imports its siblings of the code part as <sibling>?v=X too, so one
// reload brings a consistent set (Node caches modules by URL, query included).
const CODE_URLS = new Set(CODE_FILES.map(f => pathToFileURL(path.join(HERE, f)).href))
let hooked = false
function hook() {
  if (hooked) return
  hooked = true
  registerHooks({
    resolve(specifier, context, next) {
      const r = next(specifier, context)
      const v = context.parentURL && /[?&]v=([\w-]+)/.exec(context.parentURL)?.[1]
      if (v && CODE_URLS.has(r.url)) return { ...r, url: `${r.url}?v=${v}` }
      return r
    },
  })
}

/** Imports the code part at version `v` (a hash). Returns { TOOLS, INSTRUCTIONS, createBridge }. */
export async function loadCode(v) {
  if (BUNDLED) throw new Error('the single-file connector reloads only by a restart')
  hook()
  const tools = await import(`./channel-tools.mjs?v=${v}`)
  const bridge = await import(`./channel-bridge.mjs?v=${v}`)
  return { TOOLS: tools.TOOLS, INSTRUCTIONS: tools.INSTRUCTIONS, createBridge: bridge.createBridge }
}

const newer = (a, b) => {
  const pa = String(a).split('.').map(Number), pb = String(b).split('.').map(Number)
  for (let i = 0; i < 3; i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0)
  return false
}

/**
 * Watches for updates. `onUpdate({ version, restart, reason })` is called once per new state on disk (or new
 * recommended version at the hub). `loaded()` returns the hashes in use. Returns { check(), stop() }.
 */
export function watchUpdates({ loaded, onUpdate, hubUrl, clientVersion, log = () => {}, pollMs = Number(process.env.TROMMI_UPDATE_POLL_MS || 60000), versionMs = Number(process.env.TROMMI_VERSION_CHECK_MS || 3600000) }) {
  let told = null, toldHub = null, timer = null
  const check = () => {
    const disk = diskVersion(), now = loaded()
    if (disk.code === now.code && disk.shell === now.shell) return null
    const key = `${disk.code}/${disk.shell}`
    if (key === told) return null
    told = key
    const u = { version: disk.code, restart: disk.shell !== now.shell, reason: 'disk' }
    onUpdate(u)
    return u
  }
  const checkHub = async () => {
    try {
      const r = await fetch(new URL('/v1/version', hubUrl), { headers: { accept: 'application/json' } })
      if (!r.ok) return
      const rec = (await r.json())?.recommended_client_versions?.channel
      if (rec && rec !== toldHub && newer(rec, clientVersion)) { toldHub = rec; onUpdate({ version: rec, restart: true, reason: 'hub' }) }
    } catch (err) { log(`version check: ${err.message}`) }
  }
  let debounce = null
  const watchers = []
  for (const dir of BUNDLED ? [HERE] : [HERE, CORE]) {
    try { watchers.push(fs.watch(dir, () => { clearTimeout(debounce); debounce = setTimeout(check, 1500); debounce.unref?.() })) } catch {}
  }
  timer = setInterval(check, pollMs); timer.unref?.()
  const hubTimer = setInterval(checkHub, versionMs); hubTimer.unref?.()
  if (hubUrl) setTimeout(checkHub, Math.min(5000, versionMs)).unref?.()
  return { check, checkHub, stop: () => { clearInterval(timer); clearInterval(hubTimer); clearTimeout(debounce); for (const w of watchers) w.close() } }
}
