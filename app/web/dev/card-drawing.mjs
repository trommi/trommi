// Drawing on a card, in the demo (no hub): a quick stroke keeps its samples, the picture of the card is made with the
// app's fonts and pictures in it, and the mode has one bar with one Send. Exits 1 on a failure.
//   node dev/card-drawing.mjs [--app http://127.0.0.1:8900]
import { launchChromium } from './cdp.mjs'
import { guard } from './guard.mjs'
const { app: APP = 'http://127.0.0.1:8900' } = guard({ usage: 'node dev/card-drawing.mjs [--app URL]', values: ['app'], targets: ['app'] })
const sleep = ms => new Promise(r => setTimeout(r, ms))
let failed = 0
const check = (ok, what) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`); if (!ok) failed++ }
const b = await launchChromium({ width: 1440, height: 900 })
try {
  const page = await b.page()
  await page.send('Runtime.enable'); await page.send('Page.enable')
  // (the picture's markup, as it is handed to the image that paints it)
  await page.send('Page.addScriptToEvaluateOnNewDocument', { source: "window.__svg = null; const d = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, 'src'); Object.defineProperty(HTMLImageElement.prototype, 'src', { get() { return d.get.call(this) }, set(v) { if (String(v).startsWith('data:image/svg+xml') && String(v).length > 20000) window.__svg = v; d.set.call(this, v) } })" })
  const js = async code => { const r = await page.send('Runtime.evaluate', { expression: `(async () => { ${code} })()`, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text); return r.result.value }
  const until = async (code, what, ms = 30000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await js(`return Boolean(${code})`).catch(() => false)) return; await sleep(50) } throw new Error(`timed out waiting for ${what}`) }
  const mouse = (type, x, y, buttons = 1) => page.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', buttons, clickCount: 1 })
  await page.send('Page.navigate', { url: `${APP}/?mock=1` })
  await until("document.documentElement.hasAttribute('data-ready') && window.trommi", 'the demo', 60000)
  const nr = await js("const m = trommi.model(); return [...m.fresh, ...m.open].find(c => (c.attachments ?? []).filter(a => a.image).length >= 2 && c.options?.length)?.number")
  await js(`await trommi.router.visit('/card/${nr}')`)
  await until("document.querySelector('.tc-card') && document.querySelector('.tc-draw')", 'a card with pictures')
  await js('await document.fonts.ready'); await sleep(1200)
  await js("document.querySelector('.tc-draw').click()")
  await until("document.querySelector('.tc-trace')", 'the sheet')
  check(await js("const t = document.querySelector('.tc-trace-tools'); return t.classList.contains('is-docked') && t.parentElement.classList.contains('tc-ask') && [...document.querySelectorAll('.tc-send, .tc-trace-send')].filter(e => e.getBoundingClientRect().width).length === 1 && document.querySelector('.tc-send').getAttribute('aria-label') === 'Send with the card'"), 'the tools are the top row of the field: one bar, one Send ("Send with the card")')
  // 600 samples in about 0.6 s, faster than frames come: the browser hands them over a few per event
  const pt = i => { const a = i / 40, r = 60 + (i % 300) * 0.8; return [800 + Math.cos(a) * r * 1.5, 380 + Math.sin(a * 1.3) * r * 0.8] }
  await js("window.__n = [0, 0]; addEventListener('pointermove', e => { if (e.buttons) { __n[0]++; __n[1] += e.getCoalescedEvents().length } }, true)")
  await mouse('mousePressed', ...pt(0))
  const sent = []
  for (let i = 1; i <= 600; i++) { sent.push(mouse('mouseMoved', ...pt(i))); if (i % 4 === 0) await sleep(4) }
  await Promise.all(sent)
  await mouse('mouseReleased', ...pt(600), 0); await sleep(200)
  const [events, samples] = await js('return __n')
  const pts = await js("return JSON.parse(document.querySelector('[data-card-target=marks]').value)[0].strokes[0].pts.length / 2")
  // (samples nearer than 1.5 px to the one before are left out; of the rest every one is kept)
  check(pts >= 300 && pts > events, `a quick stroke keeps the samples between two events: ${pts} points from ${samples} samples in ${events} events`)
  check(await js("return /Q/.test(document.querySelector('.tc-trace-ink path').getAttribute('d'))"), 'the line on the sheet is a curve through its points')
  await js("document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))")
  await until('window.__svg', 'the picture of the card', 20000)
  const svg = await js('return decodeURIComponent(window.__svg.slice(window.__svg.indexOf(",") + 1))')
  check((svg.match(/@font-face/g) ?? []).length >= 8 && /url\(data:font\/woff2|url\(data:application\/(font-woff2|octet-stream)/.test(svg) && !/url\(\/fonts\//.test(svg), "the picture carries the app's fonts as data")
  check((svg.match(/<img[^>]*src="data:image/g) ?? []).length >= 2 && !/<img(?![^>]*src="data:)[^>]*src=/.test(svg), "the card's pictures are in it as data, none by address")
  check(await js("return !document.querySelector('.tc-trace') && !document.querySelector('.tc-trace-tools') && document.querySelector('.tc-draw[data-inked]') && document.querySelector('.tc-send').getAttribute('aria-label') !== 'Send with the card'"), 'the sheet off: the drawing waits (the pen is marked), the field is the plain field again')
} catch (e) { console.error(e.message); failed++ } finally { await b.close() }
console.log(failed ? `${failed} FAILED` : 'all ok')
process.exit(failed ? 1 : 0)
