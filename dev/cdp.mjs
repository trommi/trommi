// Drive a page in headless Chromium: run a script in it, print the result,
// optionally save a screenshot afterwards.
//   node dev/cdp.mjs URL WIDTH,HEIGHT 'async js returning a value' [OUT.png]
// Needs the command sandbox disabled, like dev/shot.sh.
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const [url, size = '1440,900', script = 'null', out] = process.argv.slice(2)
const [width, height] = size.split(',').map(Number)
const port = 9300 + Math.floor(Math.random() * 500)
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'cdp-'))
const chrome = spawn('chromium', [
  '--headless=new', '--disable-gpu', '--no-proxy-server', '--hide-scrollbars',
  `--user-data-dir=${profile}`, `--remote-debugging-port=${port}`, `--window-size=${width},${height}`, 'about:blank',
], { stdio: 'ignore' })

const sleep = ms => new Promise(r => setTimeout(r, ms))
let target
for (let i = 0; i < 50 && !target; i++) {
  await sleep(200)
  try {
    target = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).find(t => t.type === 'page')
  } catch {}
}
const ws = new WebSocket(target.webSocketDebuggerUrl)
await new Promise(r => { ws.onopen = r })
let seq = 0
const pending = new Map()
ws.onmessage = e => {
  const msg = JSON.parse(e.data)
  if (pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id) }
}
const send = (method, params = {}) => new Promise(resolve => {
  const id = ++seq
  pending.set(id, resolve)
  ws.send(JSON.stringify({ id, method, params }))
})

await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: width < 600 })
await send('Page.enable')
await send('Page.navigate', { url })
await sleep(2500)
const res = await send('Runtime.evaluate', { expression: `(async () => { ${script} })()`, awaitPromise: true, returnByValue: true })
console.log(JSON.stringify(res.result?.result?.value ?? res.result?.exceptionDetails ?? null, null, 2))
if (out) {
  await sleep(900)
  const shot = await send('Page.captureScreenshot', { format: 'png' })
  fs.writeFileSync(out, Buffer.from(shot.result.data, 'base64'))
}
ws.close()
chrome.kill()
await sleep(300)
fs.rmSync(profile, { recursive: true, force: true })
process.exit(0)
