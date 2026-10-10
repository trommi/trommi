// Drive a page in headless Chromium over the DevTools protocol, without any package.
//
// As a command: run a script in a page, print the result, optionally save a screenshot afterwards.
//   node site/dev/cdp.mjs URL WIDTH,HEIGHT 'async js returning a value' [OUT.png]
// Exit code 1 when the script throws (the error goes to stderr), 2 on wrong usage.
// As a module:
//   const browser = await launchChromium({ width, height })
//   const page = await browser.page()          // { send(method, params), on(event, fn), close() }
//   await browser.close()                      // stops Chromium and removes its profile
// Chromium is `chromium` on the PATH, or the program CHROMIUM names. It cannot run inside a command sandbox.
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const sleep = ms => new Promise(r => setTimeout(r, ms))

/** One DevTools session on a target. send() resolves with the result and rejects on a protocol error. */
async function connect(wsUrl) {
  const ws = new WebSocket(wsUrl)
  await new Promise((resolve, reject) => {
    ws.onopen = resolve
    ws.onerror = () => reject(new Error(`DevTools socket ${wsUrl} did not open`))
  })
  let seq = 0
  const pending = new Map()
  const listeners = new Map()   // event name -> Set of functions
  ws.onmessage = e => {
    const msg = JSON.parse(e.data)
    if (msg.id != null) {
      const call = pending.get(msg.id)
      if (!call) return
      pending.delete(msg.id)
      if (msg.error) call.reject(new Error(`${call.method}: ${msg.error.message}`))
      else call.resolve(msg.result)
      return
    }
    for (const fn of listeners.get(msg.method) ?? []) fn(msg.params)
  }
  ws.onclose = () => {
    for (const call of pending.values()) call.reject(new Error(`${call.method}: the browser went away`))
    pending.clear()
  }
  return {
    send: (method, params = {}) => new Promise((resolve, reject) => {
      const id = ++seq
      pending.set(id, { resolve, reject, method })
      ws.send(JSON.stringify({ id, method, params }))
    }),
    on(event, fn) {
      if (!listeners.has(event)) listeners.set(event, new Set())
      listeners.get(event).add(fn)
      return () => listeners.get(event).delete(fn)
    },
    close: () => ws.close(),
  }
}

// ---- nothing started here outlives the tool that started it -------------------------------------
// A browser left behind by a test costs the machine a core for hours. Every child a dev tool starts is handed to
// guard(): it is stopped when the tool ends (also on an error that was not caught), when the tool is
// interrupted (SIGINT, SIGTERM, SIGHUP), and, by a small watcher process of its own, when the tool is killed outright
// (SIGKILL, a timeout of whoever ran it), which no handler in the tool can see. The folders named go with it.
const guarded = new Set()
function reap() {
  for (const { proc, group, dirs } of guarded) {
    try { process.kill(group ? -proc.pid : proc.pid, 'SIGKILL') } catch {}
    for (const dir of dirs) { try { fs.rmSync(dir, { recursive: true, force: true }) } catch {} }
  }
  guarded.clear()
}
let hooked = false
/** Guard a child process: group = it leads a process group of its own (spawned detached), dirs = folders that go with it. */
function guard(proc, { group = false, dirs = [] } = {}) {
  if (!proc?.pid) return proc
  const entry = { proc, group, dirs }
  guarded.add(entry)
  proc.once('exit', () => guarded.delete(entry))
  if (!hooked) {
    hooked = true
    process.on('exit', reap)
    for (const [sig, code] of [['SIGINT', 130], ['SIGTERM', 143], ['SIGHUP', 129]]) {
      // A tool with a handler of its own for the signal ends itself; alone, this one does.
      process.on(sig, () => { const alone = process.listenerCount(sig) === 1; reap(); if (alone) process.exit(code) })
    }
  }
  // The watcher: waits until the tool or the child is gone; if it was the tool, the child and its folders go too.
  const target = group ? `-${proc.pid}` : `${proc.pid}`
  const script = `while kill -0 ${process.pid} 2>/dev/null && kill -0 ${proc.pid} 2>/dev/null; do sleep 1; done
kill -0 ${process.pid} 2>/dev/null && exit 0
kill -s TERM -- ${target} 2>/dev/null; sleep 2; kill -s KILL -- ${target} 2>/dev/null
[ $# -gt 0 ] && rm -rf -- "$@"
exit 0`
  try { spawn('sh', ['-c', script, 'guard', ...dirs], { detached: true, stdio: 'ignore' }).unref() } catch {}
  return proc
}

/** Start one headless Chromium with its own throwaway profile (or a kept one: keep = a directory that outlives close()). */
export async function launchChromium({ width = 1440, height = 900, args = [], keep = null } = {}) {
  const profile = keep ?? fs.mkdtempSync(path.join(os.tmpdir(), 'cdp-'))
  if (keep) { fs.mkdirSync(keep, { recursive: true }); fs.rmSync(path.join(keep, 'DevToolsActivePort'), { force: true }) }
  // Its own process group, so that close() takes the renderer and helper processes along. No extensions: a
  // chromium-flags.conf (--load-extension) or an external extension of the system (a password manager) would otherwise
  // come along, and one of them opens a page of its own in front of ours, after which ours gets about one frame a second.
  const proc = spawn(process.env.CHROMIUM || 'chromium', [
    '--headless=new', '--disable-gpu', '--no-proxy-server', '--disable-extensions', '--disable-component-extensions-with-background-pages', '--hide-scrollbars', '--no-first-run',
    `--user-data-dir=${profile}`, '--remote-debugging-port=0', `--window-size=${width},${height}`, ...args, 'about:blank',
  ], { stdio: 'ignore', detached: true })
  guard(proc, { group: true, dirs: keep ? [] : [profile] })
  let gone = false
  let failure = null
  proc.on('error', err => { failure = err; gone = true })
  proc.on('exit', () => { gone = true })

  const sessions = []
  async function close() {
    for (const s of sessions) { try { s.close() } catch {} }
    const signal = sig => { try { process.kill(-proc.pid, sig) } catch {} }
    if (proc.pid && !gone) {
      signal('SIGTERM')
      for (let i = 0; i < 30 && !gone; i++) await sleep(100)
      if (!gone) signal('SIGKILL')
    }
    // Chromium may still be writing while it shuts down.
    for (let i = 0; i < 5 && !keep; i++) {
      try { fs.rmSync(profile, { recursive: true, force: true }); break } catch { await sleep(200) }
    }
  }

  // Chromium picks a free port and writes it into its profile.
  let port = 0
  const portFile = path.join(profile, 'DevToolsActivePort')
  for (let i = 0; i < 100 && !port && !gone; i++) {
    await sleep(100)
    try { port = Number(fs.readFileSync(portFile, 'utf8').split('\n')[0]) || 0 } catch {}
  }
  if (!port) {
    await close()
    throw new Error(`Chromium did not start${failure ? `: ${failure.message}` : ''}. It cannot run inside the command sandbox.`)
  }

  async function page() {
    let target
    for (let i = 0; i < 50 && !target; i++) {
      try { target = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).find(t => t.type === 'page') } catch {}
      if (!target) await sleep(100)
    }
    if (!target) throw new Error('Chromium shows no page to attach to')
    const session = await connect(target.webSocketDebuggerUrl)
    sessions.push(session)
    // On a desktop whose compositor reports the headless window as covered, the page turns "hidden" after a
    // moment and its animation frames stop. Focus emulation keeps it visible and painting.
    await session.send('Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => {})
    await session.send('Page.bringToFront').catch(() => {})
    return session
  }

  /** A new tab of the same profile (same origin storage, Web Locks, BroadcastChannel): { session, id, close() }. */
  async function tab(url = 'about:blank') {
    const target = await (await fetch(`http://127.0.0.1:${port}/json/new?${encodeURI(url)}`, { method: 'PUT' })).json()
    const session = await connect(target.webSocketDebuggerUrl)
    sessions.push(session)
    await session.send('Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => {})
    return { session, id: target.id, close: () => fetch(`http://127.0.0.1:${port}/json/close/${target.id}`).then(r => r.text()) }
  }

  return { pid: proc.pid, port, profile, page, tab, close }
}

// ---- the command ---------------------------------------------------------------

async function main() {
  const [url, size = '1440,900', script = 'null', out] = process.argv.slice(2)
  const [width, height] = size.split(',').map(Number)
  if (!url || !width || !height) {
    console.error("usage: node site/dev/cdp.mjs URL WIDTH,HEIGHT 'async js returning a value' [OUT.png]")
    return 2
  }
  const browser = await launchChromium({ width, height })
  let failed = false
  try {
    const page = await browser.page()
    await page.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: width < 600 })
    await page.send('Page.enable')
    await page.send('Page.navigate', { url })
    await sleep(2500)
    const res = await page.send('Runtime.evaluate', { expression: `(async () => { ${script} })()`, awaitPromise: true, returnByValue: true })
    if (res.exceptionDetails) {
      // The script threw: say what, still take the screenshot (it shows the state it failed in), and fail.
      failed = true
      console.error(res.exceptionDetails.exception?.description ?? res.exceptionDetails.text)
    } else {
      console.log(JSON.stringify(res.result?.value ?? null, null, 2))
    }
    if (out) {
      await sleep(900)
      const shot = await page.send('Page.captureScreenshot', { format: 'png' })
      fs.writeFileSync(out, Buffer.from(shot.data, 'base64'))
    }
  } finally {
    await browser.close()
  }
  return failed ? 1 : 0
}

const isMain = process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) process.exit(await main())
