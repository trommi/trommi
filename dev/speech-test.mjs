// Live dictation in the question window, end to end in headless Chromium with a WAV file as
// the microphone. Needs a board with a speech key (it talks to the real service) and the
// command sandbox disabled.
//   node dev/speech-test.mjs PORT CLIP.wav [WIDTH,HEIGHT] [light|dark] [OUT-PREFIX]
// The board is expected on 127.0.0.1:PORT with the token "demo" (dev/serve.sh or dev/trio.sh,
// with data/tinfoil.key copied into its data folder). The clip should be 48 kHz.
// Prints what it saw as JSON; exit code 1 when a step fails. With OUT-PREFIX it saves
// OUT-PREFIX-live.png (while the words arrive) and OUT-PREFIX-done.png (after the stop).
import fs from 'node:fs'
import { launchChromium } from './cdp.mjs'

const [port, clip, size = '1440,900', theme = 'light', out] = process.argv.slice(2)
const [width, height] = size.split(',').map(Number)
if (!port || !clip || !width || !height) {
  console.error('usage: node dev/speech-test.mjs PORT CLIP.wav [WIDTH,HEIGHT] [light|dark] [OUT-PREFIX]')
  process.exit(2)
}
const sleep = ms => new Promise(r => setTimeout(r, ms))
const base = `http://127.0.0.1:${port}`
const browser = await launchChromium({
  width, height,
  args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', `--use-file-for-fake-audio-capture=${clip}%noloop`, '--autoplay-policy=no-user-gesture-required'],
})
// The board's own state, read the way a page gets it: the first frame of /events.
const login = await fetch(`${base}/?t=demo`, { redirect: 'manual' })
const cookie = login.headers.getSetCookie().map(c => c.split(';')[0]).join('; ')
async function cardOnBoard(id) {
  const ctl = new AbortController()
  const res = await fetch(`${base}/events`, { headers: { Cookie: cookie }, signal: ctl.signal })
  let buf = ''
  for await (const chunk of res.body) {
    buf += Buffer.from(chunk).toString()
    if (buf.includes('\n\n')) break
  }
  ctl.abort()
  return JSON.parse(buf.slice(0, buf.indexOf('\n\n')).replace(/^data: /, '')).cards.find(c => c.id === id)
}
const seen = { steps: [] }
let failed = false
try {
  const page = await browser.page()
  const ev = async expression => {
    const res = await page.send('Runtime.evaluate', { expression: `(async () => { ${expression} })()`, awaitPromise: true, returnByValue: true })
    if (res.exceptionDetails) throw new Error(res.exceptionDetails.exception?.description ?? res.exceptionDetails.text)
    return res.result?.value
  }
  const until = async (what, expression, ms = 15000) => {
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
  await page.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: width < 600 })
  await page.send('Page.enable')
  await page.send('Page.navigate', { url: `${base}/?t=demo#${theme}` })
  await until('the board loads', `!!document.querySelector('#focus-open')`)
  await sleep(800)
  await ev(`document.querySelector('#focus-open').click()`)
  const card = await until('the question window opens with a microphone', `(() => { const c = document.querySelector('.focus-card[data-shown]'); return c && c.querySelector('.dictate-mic:not([hidden])') ? c.dataset.id : null })()`)
  seen.card = card
  const FIELD = `document.querySelector('.focus-card[data-shown] .focus-ask-field')`
  const MIC = `document.querySelector('.focus-card[data-shown] .dictate-mic')`
  seen.focusBefore = await ev(`return document.activeElement === ${FIELD}`)
  const t0 = Date.now()
  await ev(`${MIC}.click()`)
  await until('the microphone listens', `${MIC}.dataset.rec === 'listening'`)
  await until('the first words stand in the field', `${FIELD}.value.trim().length > 0`, 20000)
  seen.firstTextMs = Date.now() - t0
  // The text grows while the clip is still playing: sample it.
  seen.growth = []
  let level = 0
  for (let i = 0; i < 17; i++) {
    await sleep(500)
    seen.growth.push(await ev(`return ${FIELD}.value.length`))
    level = Math.max(level, Number(await ev(`return ${MIC}.style.getPropertyValue('--level') || 0`)))
    if (i === 6) {
      seen.live = await ev(`return { value: ${FIELD}.value, ghost: document.querySelector('.dictate-ghost')?.textContent ?? null, provisional: document.querySelector('.dictate-live')?.textContent ?? null, lighter: getComputedStyle(document.querySelector('.dictate-live')).color !== getComputedStyle(document.querySelector('.dictate-ghost')).color, hidden: getComputedStyle(${FIELD}).webkitTextFillColor }`)
      await shot('live')
    }
  }
  seen.maxLevel = level
  // Stop with Escape: the window must stay open and the text stay.
  const provisional = await ev(`return ${FIELD}.value`)
  const tStop = Date.now()
  await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
  await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
  await until('the final reading replaces the provisional words', `!${MIC}.dataset.rec`, 20000)
  seen.finalMs = Date.now() - tStop
  seen.provisional = provisional
  seen.final = await ev(`return ${FIELD}.value`)
  seen.after = await ev(`return { open: !!document.querySelector('.focus-card[data-shown]'), ghost: !!document.querySelector('.dictate-ghost'), dictating: ${FIELD}.classList.contains('is-dictating'), editable: !${FIELD}.disabled && !${FIELD}.readOnly }`)
  await shot('done')
  // Nothing was sent by itself: the card is still open on the board.
  seen.stillOpen = (await cardOnBoard(card)).status
  if (seen.stillOpen !== 'open') throw new Error('the card was answered by the dictation itself')
  // Answer with the first tile: the dictated words go along as the note.
  await ev(`document.querySelector('.focus-card[data-shown] .focus-opt').click()`)
  for (let i = 0; i < 50 && !seen.answered; i++) {
    await sleep(200)
    const c = await cardOnBoard(card)
    if (c.status !== 'open') seen.answered = { status: c.status, choice: c.choice, note: c.note }
  }
  if (!seen.answered) throw new Error('the answer did not arrive on the board')
  if (!seen.answered.note || seen.answered.note !== seen.final.trim()) throw new Error(`the note on the board is not the dictated text: ${JSON.stringify(seen.answered)}`)
} catch (err) {
  failed = true
  seen.error = err.message
} finally {
  await browser.close()
}
console.log(JSON.stringify(seen, null, 2))
process.exit(failed ? 1 : 0)
