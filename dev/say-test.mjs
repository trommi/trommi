// Read aloud on every message, end to end in headless Chromium. Needs a board with a speech key
// (it talks to the real service) and the command sandbox disabled.
//   node dev/say-test.mjs PORT SESSION [WIDTH,HEIGHT] [light|dark] [OUT-PREFIX]
// The board is expected on 127.0.0.1:PORT with the token "demo" (dev/serve.sh, with data/tinfoil.key
// copied into its data folder) and SESSION is the id of a session with a few messages of both
// sides and an open question. Prints what it saw as JSON; exit code 1 when a step fails.
// With OUT-PREFIX it saves OUT-PREFIX-chat.png and OUT-PREFIX-focus.png (while something is read).
import fs from 'node:fs'
import { launchChromium } from './cdp.mjs'

const [port, session, size = '1440,900', theme = 'light', out] = process.argv.slice(2)
const [width, height] = size.split(',').map(Number)
if (!port || !session || !width || !height) {
  console.error('usage: node dev/say-test.mjs PORT SESSION [WIDTH,HEIGHT] [light|dark] [OUT-PREFIX]')
  process.exit(2)
}
const sleep = ms => new Promise(r => setTimeout(r, ms))
const base = `http://127.0.0.1:${port}`
const browser = await launchChromium({ width, height, args: ['--autoplay-policy=no-user-gesture-required'] })
const seen = { steps: [] }
let failed = false
try {
  const page = await browser.page()
  const ev = async expression => {
    const res = await page.send('Runtime.evaluate', { expression: `(async () => { ${expression} })()`, awaitPromise: true, returnByValue: true })
    if (res.exceptionDetails) throw new Error(res.exceptionDetails.exception?.description ?? res.exceptionDetails.text)
    return res.result?.value
  }
  const until = async (what, expression, ms = 20000) => {
    const t = Date.now()
    while (Date.now() - t < ms) {
      const got = await ev(`return ${expression}`)
      if (got) { seen.steps.push(`${what} (${Date.now() - t} ms)`); return got }
      await sleep(100)
    }
    throw new Error(`timed out waiting for: ${what}`)
  }
  const shot = async name => {
    if (!out) return
    const png = await page.send('Page.captureScreenshot', { format: 'png' })
    fs.writeFileSync(`${out}-${name}.png`, Buffer.from(png.data, 'base64'))
  }
  const mobile = width < 600
  await page.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile })
  if (mobile) await page.send('Emulation.setTouchEmulationEnabled', { enabled: true })
  await page.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: theme }] })
  await page.send('Page.enable')
  await page.send('Page.navigate', { url: `${base}/?t=demo` })
  await until('the board loads', `!!document.querySelector('html[data-loaded]')`)
  await ev(`try { localStorage.setItem('agent-board-theme', '${theme}') } catch {}`)
  await page.send('Page.navigate', { url: `${base}/s/${encodeURIComponent(session)}` })
  await until('the conversation stands with its speakers', `document.querySelectorAll('.log-inner .msg .say').length > 2`)
  // count what goes to the board, and when
  await ev(`window.__said = []; const f = window.fetch; window.fetch = (u, o) => { if (String(u).includes('/speech/say')) window.__said.push(JSON.parse(o.body)); return f(u, o) }`)
  const SAY = sel => `document.querySelector('.log-inner ${sel} .say')`
  const state = sel => `${SAY(sel)}?.dataset.say`
  const said = sel => `parseFloat(${SAY(sel)}.style.getPropertyValue('--said') || 0)`
  const pick = async (what, kind, nth = 'last') => ev(`const all = [...document.querySelectorAll('.log-inner ${kind}')].filter(n => n.querySelector('.say')); const n = all.at(${nth === 'last' ? -1 : nth}); if (!n) throw new Error('no ${what}'); return n.dataset.id ?? n.querySelector('[data-id]')?.dataset.id`)

  seen.controls = await ev(`return { messages: document.querySelectorAll('.log-inner .msg').length, speakers: document.querySelectorAll('.log-inner .msg .say').length, questions: document.querySelectorAll('.log-inner .ask-open .say').length, atRest: getComputedStyle(${SAY('.msg')}).opacity, mic: !!document.querySelector('.composer .dictate-mic:not([hidden])') }`)

  // an agent's message: one click, the sound comes and moves on
  const agent = await pick('agent message', '.msg-agent')
  const A = `.msg[data-id="${agent}"]`
  let t0 = Date.now()
  await ev(`${SAY(A)}.click()`)
  await until('the agent message plays', `${state(A)} === 'playing'`)
  seen.agentFirstSoundMs = Date.now() - t0
  const a1 = await ev(`return ${said(A)}`)
  await until('its sound moves on', `${said(A)} > ${a1} + 0.02`)
  seen.agentText = await ev(`return (await import('/js/speech.js')).spokenText(document.querySelector('.log-inner ${A}'))`)
  await shot('chat')

  // the human's own message: a click there takes over
  const mine = await pick('own message', '.msg-user')
  const U = `.msg[data-id="${mine}"]`
  await ev(`${SAY(U)}.click()`)
  await until('the own message plays and the first is silent', `${state(U)} === 'playing' && !${state(A)}`)
  // the same control stops
  await ev(`${SAY(U)}.click()`)
  await until('a second click stops it', `!${state(U)}`)
  await sleep(600)
  seen.silentAfterStop = await ev(`return !(await import('/js/speech.js')).isReading()`)

  // a question in the conversation, and Esc
  const hasAsk = await ev(`return !!${SAY('.ask-open')}`)
  if (hasAsk) {
    await ev(`${SAY('.ask-open')}.click()`)
    await until('the question plays', `${state('.ask-open')} === 'playing'`)
    await ev(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))`)
    await until('Esc stops it', `!${state('.ask-open')}`)
  }

  // from here on: the message, then the one after it
  const order = await ev(`return [...document.querySelectorAll('.log-inner .msg, .log-inner .ask-open')].filter(n => n.querySelector('.say')).slice(-2).map(n => n.dataset.id)`)
  if (order.length === 2) {
    const [one, two] = order.map(id => `[data-id="${id}"]`)
    await ev(`${SAY(one)}.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, shiftKey: true }))`)
    await until('"from here" reads the first', `${state(one)} === 'playing'`)
    await until('and goes on with the next', `${state(two)} === 'playing' && !${state(one)}`, 90000)
    await ev(`(await import('/js/speech.js')).stopReading()`)
    await until('stopReading() silences it', `!${state(two)}`)
  }
  seen.pieces = await ev(`return window.__said.map(p => [p.lang, p.text.length])`)

  // the question window: the question itself and what was said about it
  await ev(`[...document.querySelectorAll('.log-inner .ask-open .inbox-text')].at(-1)?.click()`)
  const CARD = `document.querySelector('.focus-card[data-shown]')`
  const inFocus = await until('the question window opens with a speaker on the title', `!!${CARD}?.querySelector('.focus-title .say')`).catch(() => false)
  if (inFocus) {
    const T = `${CARD}.querySelector('.focus-title .say')`
    await ev(`${T}.click()`)
    await until('the question is read in its window', `${T}.dataset.say === 'playing'`)
    seen.focusThread = await ev(`return ${CARD}.querySelectorAll('.focus-thread .msg .say').length`)
    if (seen.focusThread) {
      const M = `${CARD}.querySelector('.focus-thread .msg .say')`
      await ev(`${M}.click()`)
      await until('a message of its conversation takes over', `${M}.dataset.say === 'playing' && !${T}.dataset.say`)
    }
    await shot('focus')
    await ev(`(await import('/js/speech.js')).stopReading()`)
  } else seen.steps.push('the question window did not open from the row: not checked')
} catch (err) {
  failed = true
  seen.error = err.message
} finally {
  await browser.close()
}
console.log(JSON.stringify(seen, null, 1))
process.exit(failed ? 1 : 0)
