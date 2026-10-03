// Development only: drive the pad in headless Chromium with real pointer, touch,
// wheel and key input (DevTools protocol), check what it did, and save screenshots.
//   dev/trio.sh 8861 600 &   then   node client/web/pad/dev-check.mjs "http://localhost:8861/pad/?t=demo" OUT_DIR
//   On a board it goes on to the board itself, where the whole Desk is paper: the pen in hand, an area sent to a
//   demo agent (what was sent leaves the paper, undo restores, a failed send removes nothing), a second device.
//   without a board:  (cd client/web && python3 -m http.server 8872)  and  …/dev-check.mjs http://localhost:8872/pad/ OUT_DIR
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

const origin = new URL(url).origin
const token = new URL(url).search   // "?t=demo" on a demo board
async function session(width, height, { mobile = false, hash = '', at = url, wipe = true } = {}) {
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
  const go = async (to = at) => { await page.send('Page.navigate', { url: to + hash }); await sleep(3200) }
  await go()
  const js = async expr => {
    const res = await page.send('Runtime.evaluate', { expression: `(async () => { ${expr} })()`, awaitPromise: true, returnByValue: true })
    if (res.exceptionDetails) throw new Error(res.exceptionDetails.exception?.description ?? res.exceptionDetails.text)
    return res.result.value
  }
  // The pad of a board is one and it lasts: start every run from an empty one.
  if (wipe) {
    const had = await js(`
      const res = await fetch('/pad/elements?pad=global').catch(() => null)
      if (!res?.ok) return 0
      const all = (await res.json()).elements ?? []
      for (const e of all) await fetch('/pad/elements/' + e.id, { method: 'DELETE' })
      return all.length`)
    if (had) await go()
  }
  const mouse = (type, x, y, extra = {}) => page.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', buttons: type === 'mouseReleased' ? 0 : 1, clickCount: 1, ...extra })
  return {
    page, js, errors, go,
    reload: async () => { await page.send('Page.reload'); await sleep(3200) },
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
const summary = `await pad.settled?.(3000); return { n: pad.elements().length, types: pad.elements().map(e => e.type), sel: pad.selection().length, ...pad.state(), view: pad.view() }`

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
  check('a dropped picture becomes an image element with its bytes in the blob store', Boolean(img) && st.sel === 1 && await s.js(`return (await (await import('./db.js')).openStore()).getBlob('${img?.blob}').then(b => b.blob.size > 100)`), img ? `${img.w}x${img.h} at ${img.x},${img.y}` : '')
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
  await sleep(500)
  await s.click(380, 250)   // on the first line of the note, where the highlighter stroke lies over it
  check('a click on a note under a highlighter stroke selects the note, not the stroke', (await s.js(`const [id] = pad.selection(); return pad.elements().find(e => e.id === id)?.type`)) === 'text')
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
  // (Wait for the answer rather than a fixed time: the send goes to the board and back.)
  await s.js(`document.getElementById('send-go').click(); for (let i = 0; i < 40 && document.getElementById('send-dialog').open && document.getElementById('send-result').hidden; i++) await new Promise(r => setTimeout(r, 100)); await new Promise(r => setTimeout(r, 400))`)
  const result = await s.js(`return { open: document.getElementById('send-dialog').open, note: document.getElementById('send-result').hidden ? null : document.getElementById('send-result').textContent, sent: pad.elements().filter(e => e.sent.length).length, left: pad.elements().length, toast: document.getElementById('toast').textContent }`)
  if (st.sync.mode === 'local') {
    check('with no board behind the page, sending says so and marks nothing as sent', result.open && /Not sent/.test(result.note ?? '') && result.sent === 0, result.note ?? 'no note')
    await s.shot('10-send-not-sent')
    await s.js(`document.getElementById('send-dialog').close()`)
  } else {
    // What was sent leaves the paper (it is with the session now); one undo brings it back.
    check('on a board, Send delivers: the dialog closes and what was sent leaves the paper', !result.open && result.left === 0 && /^Sent to /.test(result.toast), `${result.toast}; ${result.left} left on the paper${result.note ? `; the panel says: ${result.note}` : ''}`)
    await s.shot('10-sent')
    const server = await s.js(`await pad.settled?.(3000); return (await (await fetch('/pad/elements?pad=global')).json()).elements.length`)
    check('the server no longer holds the elements that were sent', server === 0, `${server} on the server`)
    await s.key('z', { modifiers: CTRL })
    await sleep(300)
    const back = await s.js(`await pad.settled?.(3000); return { here: pad.elements().length, server: (await (await fetch('/pad/elements?pad=global')).json()).elements.length }`)
    check('one undo puts everything that was sent back on the paper', back.here === n + 2 && back.server === n + 2, `${back.here} on the paper, ${back.server} on the server, expected ${n + 2}`)
  }

  // persistence: reload, same records
  const ids = await s.js(`return pad.elements().map(e => e.id + ':' + e.rev).join(',')`)
  await s.go()
  const ids2 = await s.js(`return pad.elements().map(e => e.id + ':' + e.rev).join(',')`)
  check('after a reload the same records come back', ids === ids2 && ids.length > 0, `${ids2.split(',').length} elements, ${(await s.js(summary)).sync.mode}`)
  const rec0 = await s.js(`return pad.records().then(r => r.find(x => x.type === 'stroke'))`)
  check('a stored record has the documented fields', ['id', 'pad', 'type', 'x', 'y', 'w', 'h', 'rotation', 'z', 'group', 'author', 'created', 'updated', 'rev', 'blob', 'data', 'sent'].every(k => k in rec0), Object.keys(rec0).join(','))
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
  if (!st.board.speech) {
    // spoken at the very foot of the screen, beside the toolbar: the note must not end up under it
    await s.key('Escape')
    await s.touch('touchStart', [[18, 806]]); await sleep(900); await s.touch('touchEnd', [])
    await sleep(1500)
    const low = await s.js(`const e = pad.elements().filter(e => e.type === 'voice').at(-1), v = pad.view(); return e ? { bottom: (e.y + e.h) * v.z + v.y, top: e.y * v.z + v.y, n: pad.elements().filter(e => e.type === 'voice').length } : null`)
    check(`phone ${name}: a note spoken at the foot of the screen is moved clear of the toolbar`, Boolean(low) && low.n === 2 && low.bottom <= 860 - 96 + 1 && low.top >= 60, low ? `bottom at ${Math.round(low.bottom)} of 860` : 'no voice element')
    st = await s.js(summary)
  }
  if (!st.sel) await s.key('a', { modifiers: CTRL })
  await s.shot(`20-phone-${name}`)
  await s.js(`document.getElementById('send-to').click(); await new Promise(r => setTimeout(r, 200)); document.querySelector('#send-menu .pad-menu-item').click(); await new Promise(r => setTimeout(r, 500))`)
  await s.shot(`21-phone-${name}-send`)
  const fits = await s.js(`return [...document.querySelectorAll('.pad-top, .pad-tools, #send-dialog')].every(n => { const r = n.getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth + 0.5 })`)
  check(`phone ${name}: bars and dialog fit the 400 px screen, no errors`, fits && !s.errors.length, s.errors.join(' | '))
  await s.close()
}

// ── inside the board: the whole Desk is paper ───────────────────────────────
// Only on a board (the address carries its login). The pad's page lies under the Desk's list in a frame
// (#deskpad, js/padlink.js): P or the pen switch puts the paper in front of the cards; what is framed and sent
// leaves the paper, one undo brings it back; a send that fails removes nothing.
// (The pad as a layer over the page, behind ?deskpad=0, is no longer checked here.)
const onBoard = await fetch(`${origin}/healthz`).then(r => r.ok && r.headers.get('content-type')?.includes('json'), () => false)
if (onBoard) {
  const FRAME = `const frame = document.querySelector('#deskpad iframe'); const pad = frame?.contentWindow?.pad; const doc = frame?.contentDocument;`
  const app = `${origin}/${token}`
  const where = `const box = document.getElementById('inbox'); return { path: location.pathname, front: box?.hasAttribute('data-paper-front') ?? false, hidden: box?.hasAttribute('data-cards-hidden') ?? false, first: box?.firstElementChild?.id ?? null, bar: Boolean(document.getElementById('pad-open')?.getClientRects().length) }`
  const padSummary = `${FRAME} await pad.settled?.(3000); return { n: pad.elements().length, types: pad.elements().map(e => e.type), ...pad.state() }`
  const onServer = s => s.js(`return (await (await fetch('/pad/elements?pad=global')).json()).elements.length`)
  const messages = s => s.js(`return (await import('/js/store.js')).getState().all.messages.length`)
  // A place on the paper beside the cards (the list stands in a column; its right margin is free on a wide screen).
  const X = 1300

  const s = await session(1440, 900, { at: app })
  let at = await s.js(where)
  let st = await s.js(padSummary)
  check('board: the paper is the first thing in the Desk, the pad runs in it, and the bar has no pad control', at.path === '/' && at.first === 'deskpad' && st.embed && !at.bar && !at.front, JSON.stringify(at))
  await s.shot('30-board-desk')

  // P picks up the pen: the paper is in front; typing and drawing land on it and reach the server
  await s.js(`document.activeElement?.blur?.()`)
  await s.key('p')
  await sleep(400)
  at = await s.js(where)
  check('board: P picks up the pen, the paper comes in front of the cards', at.front, JSON.stringify(at))
  await s.click(X, 300)
  await s.type('Thought on the Desk')
  await s.key('Escape')
  await s.drag([[X - 60, 420], [X - 20, 380], [X + 40, 460], [X + 90, 400]])
  st = await s.js(padSummary)
  check('board: typing and drawing land on the paper and reach the server', st.n === 2 && st.types.includes('text') && st.types.includes('stroke') && st.sync.mode === 'online' && st.sync.pending === 0 && (await onServer(s)) === 2, `${st.types.join(',')}, ${st.sync.mode}`)
  await s.shot('31-board-paper-in-front')

  // send an area: frame it, pick the session; what was in the frame leaves the paper
  const frameAll = async () => {
    await s.key('a')
    const b = await s.js(`${FRAME} const v = pad.view(), e = pad.elements(); return { x0: Math.min(...e.map(e => e.x)) * v.z + v.x, y0: Math.min(...e.map(e => e.y)) * v.z + v.y, x1: Math.max(...e.map(e => e.x + e.w)) * v.z + v.x, y1: Math.max(...e.map(e => e.y + e.h)) * v.z + v.y, top: frame.getBoundingClientRect().top, left: frame.getBoundingClientRect().left }`)
    await s.drag([[b.left + b.x0 - 14, b.top + b.y0 - 14], [b.left + b.x1 + 14, b.top + b.y1 + 14]])
    await sleep(300)
    return s.js(`${FRAME} const a = pad.area(); const items = [...doc.querySelectorAll('#area-menu .pad-menu-item')]; return { tool: pad.state().tool, ids: a?.ids.length ?? 0, items: items.map(i => i.textContent), open: !doc.getElementById('area-menu').hidden }`)
  }
  let chooser = await frameAll()
  check('area: A, then a drag frames what lies there and the chooser lists the sessions', chooser.tool === 'area' && chooser.ids === 2 && chooser.open && chooser.items.length === 3, `${chooser.ids} framed; ${chooser.items.join(' | ')}`)
  await s.shot('32-board-area-chooser')

  // a send that fails removes nothing
  await s.js(`${FRAME} const w = frame.contentWindow; w.__fetch = w.fetch; w.fetch = (u, o) => (String(u).includes('/pad/send') ? Promise.reject(new TypeError('Failed to fetch')) : w.__fetch(u, o))`)
  const before0 = await messages(s)
  await s.key('Enter')
  await sleep(2500)
  st = await s.js(padSummary)
  const failedSend = await s.js(`${FRAME} return { toast: doc.getElementById('toast').textContent, area: Boolean(pad.area()) }`)
  check('area: a send that fails removes nothing from the paper and says so', st.n === 2 && (await onServer(s)) === 2 && (await messages(s)) === before0 && !/^Sent to /.test(failedSend.toast), `${st.n} on the paper; note: "${failedSend.toast}"`)
  await s.js(`${FRAME} const w = frame.contentWindow; w.fetch = w.__fetch`)
  await s.key('Escape')

  chooser = await frameAll()
  const before1 = await messages(s)
  const target = chooser.items[0] ?? ''
  await s.key('Enter')
  await sleep(2500)
  st = await s.js(padSummary)
  const sent = await s.js(`${FRAME} return { toast: doc.getElementById('toast').textContent, area: Boolean(pad.area()), menu: !doc.getElementById('area-menu').hidden }`)
  check('area: sent, what was in the frame leaves the paper and the server; a note says where it went', st.n === 0 && (await onServer(s)) === 0 && /^Sent to /.test(sent.toast) && !sent.area && !sent.menu, `${st.n} left; "${sent.toast}"`)
  await s.shot('33-board-area-sent')
  await sleep(3500)   // the demo agent answers after a moment
  const talk = await s.js(`const st = (await import('/js/store.js')).getState(); return st.all.messages.slice(${before1}).map(m => ({ from: m.from, text: m.text, att: (m.attachments ?? []).map(a => a.name + ' ' + a.url) }))`)
  const mine = talk.find(m => m.from === 'user' && m.att.some(a => /\/files\/pad-/.test(a)))
  const reply = talk.find(m => m.from === 'agent' && /Pad erhalten|image_path|pad-[0-9a-f]+\.png/.test(m.text))
  check('board: the conversation shows what was sent, with its picture', Boolean(mine) && mine.text.includes('Thought on the Desk'), JSON.stringify(mine ?? talk).slice(0, 200))
  const png = reply?.text.match(/`([^`]+\.png)`/)?.[1]
  check('board: the demo agent received it, and the PNG it was pointed to exists and is a PNG', Boolean(reply) && Boolean(png) && fs.existsSync(png) && fs.readFileSync(png).subarray(1, 4).toString() === 'PNG', reply ? reply.text.slice(0, 120) : 'no reply: ' + JSON.stringify(talk).slice(0, 200))
  if (png && fs.existsSync(png)) fs.copyFileSync(png, path.join(outDir, '34-what-the-agent-got.png'))
  // one undo puts it back
  await s.click(X, 700); await s.key('Escape')
  await s.key('z', { modifiers: CTRL })
  await sleep(600)
  st = await s.js(padSummary)
  check('area: one undo puts what was sent back on the paper', st.n === 2 && (await onServer(s)) === 2, `${st.n} on the paper, ${await onServer(s)} on the server (sent to ${target.slice(0, 20)})`)

  // a stroke that crosses the frame's edge is cut there: the part outside stays
  await s.key('p')
  await s.drag([[X - 200, 600], [X - 100, 600], [X, 600], [X + 100, 600]])
  await s.key('a')
  await s.drag([[X - 220, 570], [X - 60, 630]])
  await sleep(300)
  await s.key('Enter')
  await sleep(2500)
  const cut = await s.js(`${FRAME} await pad.settled?.(3000); const v = pad.view(), fl = frame.getBoundingClientRect().left; return pad.elements().filter(e => e.type === 'stroke').map(e => [Math.round(e.x * v.z + v.x + fl), Math.round((e.x + e.w) * v.z + v.x + fl)])`)
  check('area: a stroke crossing the frame is cut at its edge, the part outside stays on the paper', cut.some(([x0, x1]) => x0 >= X - 70 && x1 >= X + 80) && !cut.some(([x0]) => x0 < X - 190 && x0 > X - 210), JSON.stringify(cut))
  await s.shot('35-board-stroke-cut')

  // a second device: another browser with its own profile sees the change as it happens
  const other = await session(1100, 800, { wipe: false })
  const seen0 = (await other.js(summary)).n
  await s.key('p')
  await s.drag([[X - 80, 760], [X, 800], [X + 80, 750]])
  await sleep(1200)
  const seen1 = await other.js(summary)
  check('two devices: what is drawn on the Desk appears on the other without a reload', seen1.n === seen0 + 1 && seen1.sync.mode === 'online', `${seen0} → ${seen1.n}`)
  const mineBefore = (await s.js(padSummary)).n
  await other.key('p')
  await other.drag([[500, 380], [560, 420], [640, 370]])
  await sleep(1200)
  const theirs = await other.js(summary)
  await sleep(1500)
  st = await s.js(padSummary)
  check('two devices: and the other way round, onto the paper of the Desk', st.n === mineBefore + 1, `${mineBefore} → ${st.n}; the other device has ${theirs.n} (${theirs.types.join(',')}), ${theirs.sync.mode}, pending ${theirs.sync.pending}; server ${await onServer(s)}`)
  await other.close()

  // Escape puts the pen down: the cards answer again. The eye hides the cards, also over an opened card's way back.
  await s.key('Escape'); await s.key('Escape')
  await sleep(300)
  if ((await s.js(where)).front) await s.js(`document.getElementById('deskpad-pen').click()`)
  await sleep(300)
  at = await s.js(where)
  check('board: the pen put down, the cards are in front again', !at.front, JSON.stringify(at))
  await s.js(`document.getElementById('deskpad-eye').click(); await new Promise(r => setTimeout(r, 300))`)
  const hid = await s.js(where)
  await s.shot('36-board-cards-hidden')
  await s.js(`document.getElementById('deskpad-eye').click(); await new Promise(r => setTimeout(r, 300))`)
  at = await s.js(where)
  check('board: the eye hides the cards and shows them again', hid.hidden && !at.hidden, `${hid.hidden} → ${at.hidden}`)

  // arriving on the address itself
  await s.go(`${origin}/pad`)
  at = await s.js(where)
  check('board: /pad lands on the Desk with the pen in hand', at.path === '/' && at.first === 'deskpad' && at.front, JSON.stringify(at))
  check('board: no script errors on desktop', !s.errors.length, s.errors.join(' | '))
  await s.close()
}

const failed = results.filter(r => !r.ok)
console.log(`\n${results.length - failed.length} of ${results.length} checks passed; screenshots in ${outDir}`)
process.exit(failed.length ? 1 : 0)
