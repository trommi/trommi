// Drive a page in headless Chromium over the DevTools protocol, without any package.
//
// As a command: run a script in a page, print the result, optionally save a screenshot afterwards.
//   node dev/cdp.mjs URL WIDTH,HEIGHT 'async js returning a value' [OUT.png]
// Exit code 1 when the script throws (the error goes to stderr), 2 on wrong usage.
// As a module (see dev/ui-test.mjs):
//   const browser = await launchChromium({ width, height })
//   const page = await browser.page()          // { send(method, params), on(event, fn), close() }
//   await browser.close()                      // stops Chromium and removes its profile
// Needs the command sandbox disabled, like dev/shot.sh.
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

/** Start one headless Chromium with its own throwaway profile. */
export async function launchChromium({ width = 1440, height = 900, args = [] } = {}) {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'cdp-'))
  // Its own process group, so that close() takes the renderer and helper processes along. No extensions: a
  // chromium-flags.conf (--load-extension) or an external extension of the system (1Password) would otherwise come
  // along, and one of them opens a page of its own in front of ours, after which ours gets about one frame a second.
  const proc = spawn(process.env.CHROMIUM || 'chromium', [
    '--headless=new', '--disable-gpu', '--no-proxy-server', '--disable-extensions', '--disable-component-extensions-with-background-pages', '--hide-scrollbars', '--no-first-run',
    `--user-data-dir=${profile}`, '--remote-debugging-port=0', `--window-size=${width},${height}`, ...args, 'about:blank',
  ], { stdio: 'ignore', detached: true })
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
    for (let i = 0; i < 5; i++) {
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

  return { pid: proc.pid, port, profile, page, close }
}

// ---- the command ---------------------------------------------------------------

async function main() {
  const [url, size = '1440,900', script = 'null', out] = process.argv.slice(2)
  const [width, height] = size.split(',').map(Number)
  if (!url || !width || !height) {
    console.error("usage: node dev/cdp.mjs URL WIDTH,HEIGHT 'async js returning a value' [OUT.png]")
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
