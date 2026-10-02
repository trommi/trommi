// Development only: drive the pad in headless Chromium with real pointer, touch,
// wheel and key input (DevTools protocol), check what it did, and save screenshots.
//   node client/web/pad/dev-check.mjs http://localhost:8871/pad/index.html OUT_DIR
// Needs the command sandbox disabled (Chromium), like dev/cdp.mjs. Exit code 1 if a check fails.
import fs from 'node:fs'
import path from 'node:path'
import { launchChromium } from '../../../dev/cdp.mjs'

const [url, outDir = process.env.TMPDIR || '/tmp'] = process.argv.slice(2)
if (!url) { console.error('usage: dev-check.mjs URL OUT_DIR'); process.exit(2) }
fs.mkdirSync(outDir, { recursive: true })
const sleep = ms => new Promise(r => setTimeout(r, ms))
const results = []
const check = (name, ok, detail = '') => { results.push({ name, ok: Boolean(ok), detail }); console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? `  (${detail})` : ''}`) }

async function session(width, height, { mobile = false, hash = '' } = {}) {
  // a fake microphone, so that a board with a speech key can start a real recording
  const browser = await launchChromium({ width, height, args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] })
  const page = await browser.page()
  const errors = []
  await page.send('Runtime.enable')
  page.on('Runtime.exceptionThrown', e => errors.push(e.exceptionDetails?.exception?.description ?? e.exceptionDetails?.text))
  page.on('Runtime.consoleAPICalled', e => { if (e.type === 'error') errors.push(e.args.map(a => a.value ?? a.description).join(' ')) })
  await page.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: mobile ? 2 : 1, mobile })
  if (mobile) await page.send('Emulation.setTouchEmulationEnabled', { enabled: true })
  await page.send('Page.enable')
  const go = async () => { await page.send('Page.navigate', { url: url + hash }); await sleep(3200) }
  await go()
  const js = async expr => {
    const res = await page.send('Runtime.evaluate', { expression: `(async () => { ${expr} })()`, awaitPromise: true, returnByValue: true })
    if (res.exceptionDetails) throw new Error(res.exceptionDetails.exception?.description ?? res.exceptionDetails.text)
    return res.result.value
  }
  const mouse = (type, x, y, extra = {}) => page.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', buttons: type === 'mouseReleased' ? 0 : 1, clickCount: 1, ...extra })
  return {
    page, js, errors, go,
    close: () => browser.close(),
    shot: async name => {
      await sleep(350)
      const shot = await page.send('Page.captureScreenshot', { format: 'png' })
      const file = path.join(outDir, `${name}.png`)
      fs.writeFileSync(file, Buffer.from(shot.data, 'base64'))
      return file
    },
    click: async (x, y, modifiers = 0) => { await mouse('mousePressed', x, y, { modifiers }); await sleep(30); await mouse('mouseReleased', x, y, { modifiers }); await sleep(120) },
    drag: async (points, { modifiers = 0, hold = 0 } = {}) => {
      const [[x0, y0], ...rest] = points
      await mouse('mousePressed', x0, y0, { modifiers })
      if (hold) await sleep(hold)
      let [px, py] = [x0, y0]
      for (const [x, y] of rest) {
        for (let i = 1; i <= 6; i++) { await mouse('mouseMoved', px + ((x - px) * i) / 6, py + ((y - py) * i) / 6, { modifiers }); await sleep(8) }
        ;[px, py] = [x, y]
      }
      await mouse('mouseReleased', px, py, { modifiers })
      await sleep(150)
    },
    move: (x, y) => page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none', buttons: 0 }),
    wheel: (x, y, deltaX, deltaY, modifiers = 0) => page.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX, deltaY, modifiers }),
    key: async (key, { modifiers = 0, code, vk } = {}) => {
      const base = { key, code: code ?? (key.length === 1 ? `Key${key.toUpperCase()}` : key), windowsVirtualKeyCode: vk ?? (key.length === 1 ? key.toUpperCase().charCodeAt(0) : { Escape: 27, Enter: 13, Delete: 46, Backspace: 8, ArrowRight: 39, ArrowLeft: 37 }[key] ?? 0), modifiers }
      await page.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...base })
      await page.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base })
      await sleep(120)
    },
    type: async text => { await page.send('Input.insertText', { text }); await sleep(120) },
    touch: (type, points) => page.send('Input.dispatchTouchEvent', { type, touchPoints: points.map(([x, y], id) => ({ x, y, id })) }),
  }
}
const CTRL = 2, SHIFT = 8
const summary = `return { n: pad.elements().length, types: pad.elements().map(e => e.type), sel: pad.selection().length, ...pad.state(), view: pad.view() }`

// ── desktop, light ──────────────────────────────────────────────────────────
{
  const s = await session(1440, 900)
  let st = await s.js(summary)
  check('page loads empty and without errors', st.n === 0 && !s.errors.length, `${st.store}, board=${st.board.board}, sessions=${st.board.sessions.map(x => x.name).join('/')}, errors=${s.errors.join(' | ')}`)
  check('the hint shows on an empty pad', await s.js(`return document.getElementById('hint').dataset.show === 'true'`))
  await s.shot('01-empty')

  // click, then type
  await s.click(300, 250)
  st = await s.js(summary)
  check('a click on empty paper opens a cursor', st.editing && await s.js(`return document.activeElement.id === 'editor' && !document.getElementById('caret-tip').hidden`))
  await s.shot('02-cursor')
  await s.type('Ship the pad prototype')
  await s.key('Enter')
  await s.page.send('Input.insertText', { text: '\n' })
  await s.type('one element = one record')
  await s.key('Escape')
  st = await s.js(summary)
  const note = await s.js(`return pad.elements()[0]`)
  check('typing makes one text element', st.n === 1 && note.type === 'text' && note.data.text.startsWith('Ship the pad prototype') && note.data.text.includes('one element'), JSON.stringify(note.data.text))

  // drag to draw
  await s.click(1200, 700)   // drop the selection; this opens a cursor …
  await s.key('Escape')      // … which closes empty and leaves nothing behind
  await s.drag([[640, 220], [700, 180], [780, 260], [860, 200], [930, 250]])
  st = await s.js(summary)
  check('a drag draws one stroke; an empty cursor leaves nothing', st.n === 2 && st.types[1] === 'stroke', st.types.join(','))
  // highlighter over the note
  await s.key('h')
  await s.drag([[290, 262], [520, 262]])
  await s.key('p')

  // hold to speak. With a speech key on the board the microphone really records (a fake
  // device here); that audio is discarded instead of being sent to the speech service.
  const real = st.board.speech
  await s.page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: 330, y: 430, button: 'left', buttons: 1, clickCount: 1 })
  await sleep(1000)
  const held = await s.js(`return { rec: pad.state().recording, shown: !document.getElementById('rec').hidden, label: document.getElementById('rec-label').textContent }`)
  await s.shot('03-recording')
  if (real) await s.key('Escape')
  await s.page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 330, y: 430, button: 'left', buttons: 0, clickCount: 1 })
  await sleep(1300)
  st = await s.js(summary)
  const voice = await s.js(`return pad.elements().find(e => e.type === 'voice')`)
  if (real) check('holding still starts a real recording (discarded, not sent to the speech service)', held.rec === 'recording' && held.shown && held.label.startsWith('Recording') && !voice && !st.recording, held.label)
  else check('holding still records (stub) and lands a marked voice element at that spot', held.rec === 'recording' && Boolean(voice) && voice.data.stub === true && Math.abs(voice.x - (330 - st.view.x)) < 2, voice ? voice.data.text.slice(0, 40) + '…' : 'none')
  let n = st.n

  // M key: record at the middle, Esc discards
  await s.key('Escape')
  await s.key('m')
  await sleep(600)
  const recShown = await s.js(`return !document.getElementById('rec').hidden && pad.state().recording`)
  await s.key('Escape')
  await sleep(200)
  check('M starts a recording, Esc discards it', recShown === 'recording' && (await s.js(summary)).n === n && !(await s.js(summary)).recording, String(recShown))

  // paste a picture
  await s.js(`
    const cv = document.createElement('canvas'); cv.width = 320; cv.height = 200
    const c = cv.getContext('2d'); const g = c.createLinearGradient(0, 0, 320, 200)
    g.addColorStop(0, '#1b6a57'); g.addColorStop(1, '#f2c14e'); c.fillStyle = g; c.fillRect(0, 0, 320, 200)
    c.fillStyle = '#fff'; c.font = '600 28px sans-serif'; c.fillText('screenshot.png', 40, 110)
    const blob = await new Promise(r => cv.toBlob(r, 'image/png'))
    const dt = new DataTransfer(); dt.items.add(new File([blob], 'screenshot.png', { type: 'image/png' }))
    const drop = new DragEvent('drop', { bubbles: true, cancelable: true, clientX: 1000, clientY: 520, dataTransfer: dt })
    document.getElementById('pad').dispatchEvent(drop)
    await new Promise(r => setTimeout(r, 700))`)
  st = await s.js(summary)
  const img = await s.js(`return pad.elements().find(e => e.type === 'image')`)
  check('a dropped picture becomes an image element with its bytes in the blob store', Boolean(img) && st.sel === 1 && await s.js(`return (await (await import('./db.js')).openStore()).getBlob('${img?.data.blob}').then(b => b.blob.size > 100)`), img ? `${img.w}x${img.h} at ${img.x},${img.y}` : '')
  // draw over the picture: it is selected, so first let go of it
  await s.key('Escape')
  await s.drag([[900, 470], [1000, 440], [1100, 480], [1090, 580], [920, 590], [900, 470]])
  await s.shot('04-content')

  // select: click, shift-click, marquee
  await s.key('v')
  await s.click(1000, 560)
  const afterClick = await s.js(`return pad.selection()`)
  check('a click selects the element under it', afterClick.length === 1)
  await s.click(380, 250, SHIFT)
  check('shift-click adds to the selection', (await s.js(`return pad.selection().length`)) === 2)
  await s.click(380, 250, SHIFT)
  check('shift-click again takes it out', (await s.js(`return pad.selection().length`)) === 1)
  await s.key('Escape')
  await s.drag([[200, 150], [1300, 720]])
  st = await s.js(summary)
  check('a marquee selects everything it touches', st.sel === st.n && st.n === n + 2, `${st.sel} of ${st.n}`)
  await s.shot('05-marquee-selection')

  // move, resize, undo, redo
  await s.key('Escape')
  await s.click(420, 284)   // the second line of the note, clear of the highlighter stroke
  const before = await s.js(`return pad.elements().find(e => e.type === 'text')`)
  await s.drag([[420, 284], [480, 334]])
  const moved = await s.js(`return pad.elements().find(e => e.type === 'text')`)
  check('dragging a selected element moves it', Math.abs(moved.x - before.x - 60) < 1 && Math.abs(moved.y - before.y - 50) < 1 && moved.rev === before.rev + 1, `dx=${moved.x - before.x} dy=${moved.y - before.y} rev ${before.rev}→${moved.rev}`)
  const corner = await s.js(`const e = pad.elements().find(e => e.type === 'text'), v = pad.view(); return [(e.x + e.w) * v.z + v.x + 3, (e.y + e.h) * v.z + v.y + 3]`)
  await s.drag([corner, [corner[0] + 120, corner[1] + 60]])
  const big = await s.js(`return pad.elements().find(e => e.type === 'text')`)
  check('dragging a corner handle resizes (text scales its size)', big.w > moved.w * 1.2 && big.data.size > moved.data.size, `w ${moved.w}→${big.w}, size ${moved.data.size}→${big.data.size}`)
  await s.key('z', { modifiers: CTRL })
  await s.key('z', { modifiers: CTRL })
  const undone = await s.js(`return pad.elements().find(e => e.type === 'text')`)
  check('undo twice puts it back, as a new revision', undone.x === before.x && undone.w === before.w && undone.rev > big.rev, `rev ${undone.rev}`)
  await s.key('z', { modifiers: CTRL | SHIFT })
  check('redo moves it again', (await s.js(`return pad.elements().find(e => e.type === 'text').x`)) === moved.x)

  // order, group, duplicate, delete
  const zBefore = await s.js(`return pad.elements().map(e => e.type)`)
  await s.key(']', { code: 'BracketRight', vk: 221 })
  const zAfter = await s.js(`return pad.elements().map(e => e.type)`)
  check('] brings the selection to the front', zAfter.at(-1) === 'text' && zBefore.at(-1) !== 'text', zAfter.join(','))
  await s.key('a', { modifiers: CTRL })
  await s.key('g', { modifiers: CTRL })
  const groups = await s.js(`return [...new Set(pad.elements().map(e => e.group))]`)
  check('Ctrl+G groups the selection', groups.length === 1 && groups[0])
  await s.key('Escape')
  await s.click(1000, 560)
  check('clicking one member selects the group', (await s.js(`return pad.selection().length`)) === n + 2)
  await s.key('g', { modifiers: CTRL | SHIFT })
  await s.key('Escape')
  await s.click(1000, 520)
  await s.key('d', { modifiers: CTRL })
  check('Ctrl+D duplicates', (await s.js(summary)).n === n + 3)
  await s.key('Delete')
  st = await s.js(summary)
  const recs = await s.js(`return pad.records()`)
  check('Delete removes it and leaves a tombstone record', st.n === n + 2 && recs.filter(r => r.deleted).length >= 1 && recs.length > st.n, `${recs.length} records, ${recs.filter(r => r.deleted).length} tombstones`)

  // eraser
  const strokesBefore = (await s.js(summary)).types.filter(t => t === 'stroke').length
  await s.key('e')
  await s.drag([[760, 150], [770, 330]])
  await s.key('p')
  check('the eraser removes the stroke it crosses', (await s.js(summary)).types.filter(t => t === 'stroke').length === strokesBefore - 1)
  await s.key('z', { modifiers: CTRL })

  // pan and zoom
  const v0 = await s.js(`return pad.view()`)
  await s.wheel(700, 400, 0, 120)
  await sleep(100)
  const v1 = await s.js(`return pad.view()`)
  await s.wheel(700, 400, 0, -200, CTRL)
  await sleep(100)
  const v2 = await s.js(`return pad.view()`)
  check('wheel pans, ctrl-wheel (trackpad pinch) zooms about the pointer', v1.y === v0.y - 120 && v2.z > v1.z * 1.3 && Math.abs((700 - v2.x) / v2.z - (700 - v1.x) / v1.z) < 0.01, `z ${v1.z}→${v2.z.toFixed(2)}`)
  await s.page.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: ' ', code: 'Space', windowsVirtualKeyCode: 32 })
  await s.drag([[700, 400], [760, 450]])
  await s.page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: ' ', code: 'Space', windowsVirtualKeyCode: 32 })
  const v3 = await s.js(`return pad.view()`)
  check('space-drag pans and draws nothing', Math.abs(v3.x - v2.x - 60) < 0.01 && Math.abs(v3.y - v2.y - 50) < 0.01 && (await s.js(summary)).n === n + 2, `dx=${v3.x - v2.x} dy=${v3.y - v2.y}`)
  await s.shot('06-zoomed-grid')
  await s.key('f')
  await sleep(500)

  // send
  await s.key('v')
  await s.key('a', { modifiers: CTRL })
  await s.shot('07-selection-bar')
  await s.key('s')
  const menu = await s.js(`return [...document.querySelectorAll('#send-menu .pad-menu-item')].map(b => b.textContent)`)
  check('S lists the sessions to send to', menu.length >= 1, menu.join(' | '))
  await s.shot('08-send-menu')
  await s.js(`document.querySelector('#send-menu .pad-menu-item').click(); await new Promise(r => setTimeout(r, 500))`)
  const payload = await s.js(`const p = await pad.payload(); return { ...p, png: p.png.slice(0, 22) + '… ' + p.png.length + ' chars' }`)
  check('the payload has a PNG, the plain text and the element ids', payload.png.startsWith('data:image/png') && payload.text.includes('Ship the pad prototype') && (real || payload.text.includes('Sample transcript')) && payload.elements.length === n + 2 && payload.bbox.w > 0, JSON.stringify({ text: payload.text.slice(0, 60), bbox: payload.bbox, n: payload.elements.length }))
  fs.writeFileSync(path.join(outDir, 'payload.json'), JSON.stringify(payload, null, 2))
  await s.shot('09-send-dialog')
  await s.js(`document.getElementById('send-go').click(); await new Promise(r => setTimeout(r, 900))`)
  const result = await s.js(`return { open: document.getElementById('send-dialog').open, note: document.getElementById('send-result').hidden ? null : document.getElementById('send-result').textContent, sent: pad.elements().filter(e => e.sent.length).length }`)
  check('with no /pad/send (or no board), sending says so and marks nothing as sent', result.open && /Not sent/.test(result.note ?? '') && result.sent === 0, result.note ?? 'no note')
  await s.shot('10-send-not-sent')
  await s.js(`document.getElementById('send-dialog').close()`)

  // persistence: reload, same records
  const ids = await s.js(`return pad.elements().map(e => e.id + ':' + e.rev).join(',')`)
  await s.go()
  const ids2 = await s.js(`return pad.elements().map(e => e.id + ':' + e.rev).join(',')`)
  check('after a reload the same records come back from IndexedDB', ids === ids2 && ids.length > 0, `${ids2.split(',').length} elements`)
  const rec0 = await s.js(`return pad.records().then(r => r.find(x => x.type === 'stroke'))`)
  check('a stored record has the documented fields', ['id', 'pad', 'type', 'x', 'y', 'w', 'h', 'rotation', 'z', 'group', 'author', 'created', 'updated', 'rev', 'data', 'sent'].every(k => k in rec0), Object.keys(rec0).join(','))
  fs.writeFileSync(path.join(outDir, 'record.json'), JSON.stringify(rec0, null, 2))

  await s.key('?', { modifiers: SHIFT, code: 'Slash', vk: 191 })
  check('? opens the shortcut list', await s.js(`return document.getElementById('help').open`))
  await s.shot('11-help')
  await s.js(`document.getElementById('help').close(); document.getElementById('theme').click(); await new Promise(r => setTimeout(r, 300))`)
  await s.key('a', { modifiers: CTRL })
  check('the theme switch sets data-theme="dark"', await s.js(`return document.documentElement.dataset.theme === 'dark'`))
  await s.shot('12-dark')
  check('no script errors on desktop', !s.errors.length, s.errors.join(' | '))
  await s.close()
}

// ── phone, touch ────────────────────────────────────────────────────────────
for (const [name, hash] of [['light', ''], ['dark', '#dark']]) {
  const s = await session(400, 860, { mobile: true, hash })
  await s.touch('touchStart', [[120, 240]]); await sleep(40); await s.touch('touchEnd', [])
  await sleep(300)
  check(`phone ${name}: a tap opens a cursor`, (await s.js(summary)).editing)
  await s.type('Tap, type, done')
  await s.touch('touchStart', [[300, 600]]); await sleep(40); await s.touch('touchEnd', [])
  await sleep(250)
  await s.js(`document.activeElement.blur?.(); await new Promise(r => setTimeout(r, 100))`)
  // one finger draws
  await s.touch('touchStart', [[80, 380]])
  for (let i = 1; i <= 12; i++) { await s.touch('touchMove', [[80 + i * 20, 380 + Math.sin(i / 2) * 40]]); await sleep(12) }
  await s.touch('touchEnd', [])
  await sleep(200)
  let st = await s.js(summary)
  check(`phone ${name}: one finger draws, a tap elsewhere keeps the note`, st.types.includes('text') && st.types.includes('stroke'), st.types.join(','))
  // two fingers pinch
  const z0 = st.view.z
  await s.touch('touchStart', [[150, 500]]); await sleep(20)
  await s.touch('touchStart', [[150, 500], [250, 500]]); await sleep(20)
  for (let i = 1; i <= 8; i++) { await s.touch('touchMove', [[150 - i * 8, 500], [250 + i * 8, 500]]); await sleep(12) }
  await s.touch('touchEnd', [])
  await sleep(200)
  st = await s.js(summary)
  check(`phone ${name}: two fingers zoom and draw nothing`, st.view.z > z0 * 1.5 && st.types.filter(t => t === 'stroke').length === 1, `z ${z0}→${st.view.z.toFixed(2)}`)
  await s.js(`document.getElementById('fit').click(); await new Promise(r => setTimeout(r, 500))`)
  // hold to speak
  await s.touch('touchStart', [[200, 620]]); await sleep(1000)
  const held = await s.js(`return pad.state().recording`)
  if (st.board.speech) await s.js(`document.getElementById('rec-cancel').click()`)
  await s.touch('touchEnd', [])
  await sleep(1300)
  st = await s.js(summary)
  check(`phone ${name}: a held finger records`, held === 'recording' && !st.recording && (st.board.speech || st.types.includes('voice')), st.types.join(','))
  if (!st.sel) await s.key('a', { modifiers: CTRL })
  await s.shot(`20-phone-${name}`)
  await s.js(`document.getElementById('send-to').click(); await new Promise(r => setTimeout(r, 200)); document.querySelector('#send-menu .pad-menu-item').click(); await new Promise(r => setTimeout(r, 500))`)
  await s.shot(`21-phone-${name}-send`)
  const fits = await s.js(`return [...document.querySelectorAll('.pad-top, .pad-tools, #send-dialog')].every(n => { const r = n.getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth + 0.5 })`)
  check(`phone ${name}: bars and dialog fit the 400 px screen, no errors`, fits && !s.errors.length, s.errors.join(' | '))
  await s.close()
}

const failed = results.filter(r => !r.ok)
console.log(`\n${results.length - failed.length} of ${results.length} checks passed; screenshots in ${outDir}`)
process.exit(failed.length ? 1 : 0)
