// Development only: drive the pad in headless Chromium with real pointer, touch,
// wheel and key input (DevTools protocol), check what it did, and save screenshots.
//   dev/trio.sh 8861 600 &   then   node client/web/pad/dev-check.mjs "http://localhost:8861/pad/?t=demo" OUT_DIR
//   On a board it goes on to the board itself: the pad opened from the inbox, a session, a pair, the agents page
//   and the Focus window, closed again, reloaded, a selection sent to a demo agent, a second browser as another device.
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
  await s.js(`document.getElementById('send-go').click(); await new Promise(r => setTimeout(r, 900))`)
  const result = await s.js(`return { open: document.getElementById('send-dialog').open, note: document.getElementById('send-result').hidden ? null : document.getElementById('send-result').textContent, sent: pad.elements().filter(e => e.sent.length).length, toast: document.getElementById('toast').textContent }`)
  if (st.sync.mode === 'local') {
    check('with no board behind the page, sending says so and marks nothing as sent', result.open && /Not sent/.test(result.note ?? '') && result.sent === 0, result.note ?? 'no note')
    await s.shot('10-send-not-sent')
    await s.js(`document.getElementById('send-dialog').close()`)
  } else {
    check('on a board, Send delivers: the dialog closes and every element carries where it went', !result.open && result.sent === n + 2 && /^Sent to /.test(result.toast), `${result.toast}; ${result.sent} marked`)
    await s.shot('10-sent')
    const server = await s.js(`return (await (await fetch('/pad/elements?pad=global')).json()).elements.map(e => e.sent.length)`)
    check('the server keeps the elements and their "sent"', server.length === n + 2 && server.every(k => k === 1), server.join(','))
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

// ── inside the board: the pad from anywhere ─────────────────────────────────
// Only on a board (the address carries its login). The board is driven like a human would:
// the control in the bar, the key, Esc, Back, a reload.
const onBoard = await fetch(`${origin}/healthz`).then(r => r.ok && r.headers.get('content-type')?.includes('json'), () => false)
if (onBoard) {
  const FRAME = `const frame = document.querySelector('#padlink iframe'); const pad = frame?.contentWindow?.pad; const doc = frame?.contentDocument;`
  const app = `${origin}/${token}`
  const where = `return { path: location.pathname + location.search, open: document.getElementById('padlink')?.hasAttribute('data-open') ?? false, pressed: document.getElementById('pad-open')?.getAttribute('aria-pressed'), scope: document.body.dataset.scope, page: document.body.dataset.page ?? null, focus: Boolean(document.querySelector('.focus')) }`
  const rectOf = (s, sel, inFrame = false) => s.js(`${FRAME} const n = (${inFrame} ? doc : document).querySelector(${JSON.stringify(sel)}); if (!n) return null; const r = n.getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2, r.width, r.height]`)
  const clickOn = async (s, sel, inFrame = false) => { const r = await rectOf(s, sel, inFrame); if (!r) throw new Error(`nothing matches ${sel}`); await s.click(r[0], r[1]); await sleep(350) }
  const padSummary = `${FRAME} await pad.settled?.(3000); return { n: pad.elements().length, types: pad.elements().map(e => e.type), sel: pad.selection().length, sent: pad.elements().filter(e => e.sent.length).length, ...pad.state() }`

  const s = await session(1440, 900, { at: app })
  let at = await s.js(where)
  const btn = await rectOf(s, '#pad-open')
  check('board: the control is in the bar, on every page', Boolean(btn) && btn[1] > 840 && at.path === '/' && !at.open, btn ? `at ${Math.round(btn[0])},${Math.round(btn[1])}` : 'missing')
  await s.shot('30-board-inbox')

  // from the inbox
  await clickOn(s, '#pad-open')
  at = await s.js(where)
  let st = await s.js(padSummary)
  check('board: the control lays the pad over the inbox, at /pad', at.open && at.path === '/pad' && at.pressed === 'true' && st.embed && st.host.open && st.board.sessions.length === 3, `${at.path}, sessions=${st.board.sessions.map(x => x.name).join('/')}`)
  await s.click(420, 300)
  await s.type('Thought in the inbox')
  await s.key('Escape')
  await s.click(1200, 760); await s.key('Escape')
  await s.drag([[640, 420], [720, 380], [800, 460], [900, 400]])
  st = await s.js(padSummary)
  check('board: typing and drawing land on the pad and reach the server', st.n === 2 && st.sync.mode === 'online' && st.sync.pending === 0 && (await s.js(`return (await (await fetch('/pad/elements?pad=global')).json()).elements.length`)) === 2, `${st.types.join(',')}, ${st.sync.mode}`)
  await s.shot('31-board-pad-over-inbox')
  await s.key('Escape')
  at = await s.js(where)
  check('board: Esc closes it, back in the inbox', !at.open && at.path === '/' && at.scope === 'all' && at.pressed === 'false', at.path)

  // from a session: the key, Back, and the session is where sending goes
  await s.js(`[...document.querySelectorAll('#agents .agent-entry')][1].click(); await new Promise(r => setTimeout(r, 400))`)
  const sessionPath = (await s.js(where)).path
  await s.js(`document.activeElement?.blur?.()`)
  const t0 = Date.now()
  await s.key('p')
  at = await s.js(where)
  st = await s.js(padSummary)
  const label = await s.js(`${FRAME} return [...pad.elements()].length && doc.getElementById('send-to-label').textContent`)
  check('board: P opens it from a session; nothing is fetched again', at.open && at.path === '/pad' && st.n === 2 && /^\/s\/[^/+]+$/.test(sessionPath), `${sessionPath} → ${at.path} in ${Date.now() - t0} ms incl. checks`)
  await s.key('a', { modifiers: CTRL })
  await sleep(200)
  const direct = await s.js(`${FRAME} return { label: doc.getElementById('send-to-label').textContent, other: !doc.getElementById('send-other').hidden, prefer: pad.state().host.prefer }`)
  check('board: from a session, "Send to" names that session', /^Send to Web-Frontend$/.test(direct.label) && direct.other && direct.prefer.length === 1, `${direct.label} ${JSON.stringify(direct.prefer)}`)
  await s.shot('32-board-pad-from-session')
  await s.js(`history.back(); await new Promise(r => setTimeout(r, 500))`)
  at = await s.js(where)
  check('board: browser Back closes it, back in that session', !at.open && at.path === sessionPath, at.path)

  // a reload on the pad stays on the pad; closing then still goes back to the session
  await s.key('p')
  await s.reload()
  at = await s.js(where)
  st = await s.js(padSummary)
  check('board: a reload stays on the pad with everything on it', at.open && at.path === '/pad' && st.n === 2 && st.host.prefer.length === 1, `${st.n} elements, prefer ${JSON.stringify(st.host.prefer)}`)
  await clickOn(s, '#back', true)
  at = await s.js(where)
  check('board: the pad\'s close button goes back to the session, also after the reload', !at.open && at.path === sessionPath && at.scope !== 'all', at.path)

  // send the selection to the session: the agent gets it, the conversation shows it
  const before = await s.js(`const m = (await import('/js/store.js')).getState().all.messages; return m.length`)
  await s.key('p')
  await s.key('v')
  await s.key('a', { modifiers: CTRL })
  await sleep(200)
  await clickOn(s, '#send-to', true)
  await sleep(500)
  const dialog = await s.js(`${FRAME} return { open: doc.getElementById('send-dialog').open, title: doc.getElementById('send-title').textContent }`)
  await s.shot('33-board-send-dialog')
  await clickOn(s, '#send-go', true)
  await sleep(1200)
  st = await s.js(padSummary)
  check('board: Send delivers the selection to that session and marks the elements', dialog.open && dialog.title === 'Send to Web-Frontend' && st.sent === 2, `${dialog.title}; ${st.sent} marked`)
  await s.shot('34-board-sent')
  await s.key('Escape'); await s.key('Escape')
  await sleep(3500)   // the demo agent answers after a moment
  const talk = await s.js(`const st = (await import('/js/store.js')).getState(); return st.all.messages.slice(${before}).map(m => ({ from: m.from, agent: m.agent, text: m.text, att: (m.attachments ?? []).map(a => a.name + ' ' + a.url) }))`)
  const mine = talk.find(m => m.from === 'user' && m.att.some(a => a.startsWith('From the pad /files/pad-')))
  const reply = talk.find(m => m.from === 'agent' && /Pad erhalten|image_path|pad-[0-9a-f]+\.png/.test(m.text))
  check('board: the conversation shows what was sent, with its picture', Boolean(mine) && mine.text.includes('Thought in the inbox'), JSON.stringify(mine ?? talk).slice(0, 200))
  check('board: the demo agent received it: it names the elements and the PNG it was given', Boolean(reply), reply ? reply.text : 'no reply: ' + JSON.stringify(talk).slice(0, 200))
  const png = reply?.text.match(/`([^`]+\.png)`/)?.[1]
  check('board: the PNG the agent was pointed to exists on disk and is a PNG', Boolean(png) && fs.existsSync(png) && fs.readFileSync(png).subarray(1, 4).toString() === 'PNG', png ?? '')
  if (png) fs.copyFileSync(png, path.join(outDir, '35-what-the-agent-got.png'))
  at = await s.js(where)
  check('board: after sending and closing, the session is still where the human is', !at.open && at.path === sessionPath, at.path)
  await s.shot('36-board-conversation-after-send')

  // a second device: another browser with its own profile sees the change as it happens
  const other = await session(1100, 800, { wipe: false })
  const seen0 = (await other.js(summary)).n
  await s.key('p')
  await s.key('p')   // inside the pad, P is the pen
  await s.drag([[300, 600], [380, 640], [460, 590]])
  await sleep(1200)
  const seen1 = (await other.js(summary))
  check('two devices: what is drawn on one appears on the other without a reload', seen0 === 2 && seen1.n === 3 && seen1.sync.mode === 'online', `${seen0} → ${seen1.n}`)
  await other.click(550, 400); await other.type('from the second device'); await other.key('Escape')
  await sleep(1200)
  st = await s.js(padSummary)
  check('two devices: and the other way round, into the pad inside the board', st.n === 4 && st.types.filter(t => t === 'text').length === 2, st.types.join(','))
  // delete there, undo there: the tombstone and its undo both travel
  await other.key('Delete')
  await sleep(1000)
  const gone = (await s.js(padSummary)).n
  await other.key('z', { modifiers: CTRL })
  await sleep(1000)
  st = await s.js(padSummary)
  check('two devices: a delete travels, and so does its undo', gone === 3 && st.n === 4, `${gone} → ${st.n}`)
  await other.close()
  await s.key('Escape'); await s.key('Escape')

  // a pair
  await s.js(`const store = await import('/js/store.js'); const a = store.getState().all.agents; await store.pair(a[1].id, a[2].id); await new Promise(r => setTimeout(r, 600))`)
  await s.js(`[...document.querySelectorAll('#agents .agent-entry')].find(n => n.querySelector('.agent-pair'))?.click(); await new Promise(r => setTimeout(r, 400))`)
  const pairPath = (await s.js(where)).path
  await clickOn(s, '#pad-open')
  await s.key('v'); await s.key('a', { modifiers: CTRL })
  await sleep(200)
  await clickOn(s, '#send-to', true)
  const menu = await s.js(`${FRAME} return [...doc.querySelectorAll('#send-menu .pad-menu-item')].map(b => b.textContent)`)
  check('board: from a pair, the menu lists its two sessions first', pairPath.includes('+') && menu.length === 3 && menu.slice(0, 2).every(t => t.includes('where you were')) && !menu[2].includes('where you were'), `${pairPath}: ${menu.join(' | ')}`)
  await s.shot('37-board-pad-from-pair')
  await s.key('Escape'); await s.key('Escape'); await s.key('Escape')
  at = await s.js(where)
  check('board: closed, back in the pair', !at.open && at.path === pairPath, at.path)
  await s.js(`const store = await import('/js/store.js'); await store.unpair(store.getState().members[0]); await new Promise(r => setTimeout(r, 500))`)

  // the agents page, and over the Focus window
  await s.js(`document.getElementById('nav-roster').click(); await new Promise(r => setTimeout(r, 300))`)
  await clickOn(s, '#pad-open')
  at = await s.js(where)
  await s.key('Escape')
  const back = await s.js(where)
  check('board: from the agents page and back', at.open && back.path === '/agents' && back.page === 'roster' && !back.open, back.path)
  await s.js(`document.getElementById('focus-open').click(); await new Promise(r => setTimeout(r, 700))`)
  const inFocus = await s.js(where)
  await s.js(`document.activeElement?.blur?.()`)
  await s.key('p')
  at = await s.js(where)
  const onTop = await s.js(`const n = document.elementFromPoint(700, 450); return n?.tagName`)
  await s.shot('38-board-pad-over-focus')
  await s.key('Escape')
  const after = await s.js(where)
  check('board: P opens it over the Focus window, Esc returns into Focus', inFocus.focus && at.open && onTop === 'IFRAME' && !after.open && after.focus && after.path === inFocus.path, `${inFocus.path} → ${at.path} → ${after.path}`)
  await s.key('Escape')

  // send an area: frame a part of the paper, pick the session, and it is cut out and flies there
  await s.js(`[...document.querySelectorAll('#agents .agent-entry')][1].click(); await new Promise(r => setTimeout(r, 400))`)
  await clickOn(s, '#pad-open')
  await s.js(`${FRAME}
    const w = frame.contentWindow
    const cv = doc.createElement('canvas'); cv.width = 320; cv.height = 200
    const c = cv.getContext('2d'); const g = c.createLinearGradient(0, 0, 320, 200)
    g.addColorStop(0, '#1b6a57'); g.addColorStop(1, '#f2c14e'); c.fillStyle = g; c.fillRect(0, 0, 320, 200)
    c.fillStyle = '#fff'; c.font = '600 28px sans-serif'; c.fillText('screenshot.png', 40, 110)
    const blob = await new Promise(r => cv.toBlob(r, 'image/png'))
    const dt = new w.DataTransfer(); dt.items.add(new w.File([blob], 'screenshot.png', { type: 'image/png' }))
    doc.getElementById('pad').dispatchEvent(new w.DragEvent('drop', { bubbles: true, cancelable: true, clientX: 1050, clientY: 560, dataTransfer: dt }))
    await new Promise(r => setTimeout(r, 900))`)
  await s.key('Escape')
  await s.key('f')
  await sleep(600)
  const toolBefore = (await s.js(padSummary)).tool
  await s.key('a')
  const box = await s.js(`${FRAME} const v = pad.view(), e = pad.elements(); const x0 = Math.min(...e.map(e => e.x)) * v.z + v.x, y0 = Math.min(...e.map(e => e.y)) * v.z + v.y, x1 = Math.max(...e.map(e => e.x + e.w)) * v.z + v.x, y1 = Math.max(...e.map(e => e.y + e.h)) * v.z + v.y; return { x0, y0, x1, y1, n: e.length, types: e.map(e => e.type), z: v.z }`)
  // the frame takes the upper left three quarters: some elements whole, some cut by its edge
  const fx0 = box.x0 - 14, fy0 = box.y0 - 14, fx1 = box.x0 + (box.x1 - box.x0) * 0.8, fy1 = box.y0 + (box.y1 - box.y0) * 0.86
  await s.page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: fx0, y: fy0, button: 'left', buttons: 1, clickCount: 1 })
  for (let i = 1; i <= 8; i++) { await s.page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: fx0 + ((fx1 - fx0) * i) / 8, y: fy0 + ((fy1 - fy0) * i) / 8, button: 'left', buttons: 1 }); await sleep(10) }
  await s.shot('50-area-dragging')
  await s.page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: fx1, y: fy1, button: 'left', buttons: 0, clickCount: 1 })
  await sleep(300)
  const chooser = await s.js(`${FRAME} const a = pad.area(); const items = [...doc.querySelectorAll('#area-menu .pad-menu-item')]; return { tool: pad.state().tool, area: a, items: items.map(i => i.textContent), marks: items.filter(i => i.querySelector('.pad-mark svg')).length, focus: doc.activeElement?.id, types: a ? a.ids.map(id => pad.elements().find(e => e.id === id).type) : [] }`)
  check('area: A, then a drag frames a part of the paper and the chooser lists the sessions with their marks, the one you came from first', chooser.tool === 'area' && chooser.area && chooser.items.length === 3 && chooser.marks === 3 && /^Web-Frontendwhere you were.*Enter$/.test(chooser.items[0]) && chooser.focus === 'area-menu', `${chooser.area?.ids.length} of ${box.n} elements: ${chooser.types.join(',')}; ${chooser.items.join(' | ')}`)
  check('area: what lies in the frame, whole or in part, goes: strokes, a note and a picture', ['stroke', 'text', 'image'].every(t => chooser.types.includes(t)), chooser.types.join(','))
  await s.shot('51-area-chooser')
  const beforeArea = await s.js(`return (await import('/js/store.js')).getState().all.messages.length`)
  // slow the animations down to look at them
  await s.page.send('Animation.enable')
  await s.page.send('Animation.setPlaybackRate', { playbackRate: 0.1 })
  await s.key('Enter')
  await sleep(1100)
  const strip = await s.js(`const n = document.querySelector('.padlink-strip'); const t = n?.querySelector('.is-target'); const sh = document.querySelector('.padlink-fly > div:not(.padlink-strip)'); return { strip: Boolean(n), marks: n?.children.length, target: Boolean(t), sheet: Boolean(sh) }`)
  await s.shot('52-swoosh-cut-out')
  await sleep(3200)
  await s.shot('53-swoosh-in-flight')
  await sleep(1700)
  await s.shot('54-swoosh-at-the-mark')
  await s.page.send('Animation.setPlaybackRate', { playbackRate: 1 })
  await sleep(2500)
  check('area: the board shows a strip of the sessions\' marks at the left edge and the cut-out piece flies above the pad', strip.strip && strip.marks === 3 && strip.target && strip.sheet, JSON.stringify(strip))
  st = await s.js(padSummary)
  const aft = await s.js(`${FRAME} return { layer: Boolean(document.querySelector('.padlink-fly')), area: pad.area(), menu: !doc.getElementById('area-menu').hidden, toast: doc.getElementById('toast').textContent, sentIds: pad.elements().filter(e => e.sent.some(l => l.session === 'web-frontend')).length }`)
  check('area: afterwards nothing is lost: the elements stay, marked as sent; a note says where it went; the tool in hand is the one from before', !aft.layer && !aft.area && !aft.menu && aft.toast === 'Sent to Web-Frontend' && st.n === box.n && aft.sentIds >= chooser.area.ids.length && st.tool === toolBefore, `${aft.toast}; ${aft.sentIds} marked; tool ${st.tool}`)
  await sleep(2500)
  const talk2 = await s.js(`const st = (await import('/js/store.js')).getState(); return st.all.messages.slice(${beforeArea}).map(m => ({ from: m.from, text: m.text, att: (m.attachments ?? []).map(a => a.name + ' ' + a.url) }))`)
  const reply2 = talk2.find(m => m.from === 'agent' && /Vom Pad erhalten/.test(m.text))
  const png2 = reply2?.text.match(/`([^`]+\.png)`/)?.[1]
  const said = Number(reply2?.text.match(/erhalten: (\d+)/)?.[1])
  let dims = null
  if (png2 && fs.existsSync(png2)) { const b = fs.readFileSync(png2); dims = [b.readUInt32BE(16), b.readUInt32BE(20)]; fs.copyFileSync(png2, path.join(outDir, '55-area-what-the-agent-got.png')) }
  const want = chooser.area ? [Math.round(chooser.area.w * Math.min(2, 2000 / Math.max(chooser.area.w, chooser.area.h))), Math.round(chooser.area.h * Math.min(2, 2000 / Math.max(chooser.area.w, chooser.area.h)))] : null
  check('area: the demo agent received the element list and a PNG of exactly that rectangle', Boolean(reply2) && said === chooser.area.ids.length && dims && Math.abs(dims[0] - want[0]) <= 1 && Math.abs(dims[1] - want[1]) <= 1, `${said} elements, PNG ${dims?.join('x')} (frame ${want?.join('x')})`)
  // an empty frame sends nothing; Esc puts the tool away
  await s.key('a')
  await s.drag([[60, 700], [200, 800]])
  const empty = await s.js(`${FRAME} return { area: pad.area(), toast: doc.getElementById('toast').textContent, menu: !doc.getElementById('area-menu').hidden }`)
  await s.key('Escape')
  check('area: a frame around nothing says so and sends nothing; Esc puts the tool away', !empty.area && !empty.menu && /Nothing in that area/.test(empty.toast) && (await s.js(padSummary)).tool === toolBefore, empty.toast)
  await s.key('Escape')

  // arriving on the address itself
  await s.go(`${origin}/pad`)
  at = await s.js(where)
  await s.key('Escape')
  const home = await s.js(where)
  check('board: /pad opened directly shows the pad; closing lands in the inbox', at.open && at.path === '/pad' && !home.open && home.path === '/', `${at.path} → ${home.path}`)

  // dark, through the board's own switch, and through the pad's
  await s.js(`document.getElementById('theme-toggle').click()`)
  await clickOn(s, '#pad-open')
  const darkIn = await s.js(`${FRAME} return doc.documentElement.dataset.theme`)
  await s.shot('39-board-pad-dark')
  await clickOn(s, '#theme', true)
  const lightOut = await s.js(`${FRAME} return [doc.documentElement.dataset.theme ?? 'light', document.documentElement.dataset.theme ?? 'light']`)
  check('board: the theme is one: the board\'s switch darkens the pad, the pad\'s switch lightens the board', darkIn === 'dark' && lightOut.join() === 'light,light', `${darkIn} → ${lightOut}`)
  await s.key('Escape')
  check('board: no script errors on desktop', !s.errors.length, s.errors.join(' | '))
  await s.close()

  // phone
  for (const [name, hash] of [['light', ''], ['dark', '#dark']]) {
    const p = await session(400, 860, { mobile: true, hash, at: app, wipe: false })
    const tap = async (x, y) => { await p.touch('touchStart', [[x, y]]); await sleep(40); await p.touch('touchEnd', []); await sleep(350) }
    const b = await rectOf(p, '#pad-open')
    const fitsBar = await p.js(`return [...document.querySelectorAll('.topbar > *')].every(n => { const r = n.getBoundingClientRect(); return !r.width || (r.left >= 0 && r.right <= innerWidth + 0.5) })`)
    check(`board phone ${name}: the control is in the top bar, thumb-sized, and the bar still fits`, Boolean(b) && b[2] >= 40 && b[3] >= 40 && fitsBar, b ? `${Math.round(b[2])}x${Math.round(b[3])} at ${Math.round(b[0])},${Math.round(b[1])}` : 'missing')
    await p.js(`[...document.querySelectorAll('#agents .agent-entry')][1].click(); await new Promise(r => setTimeout(r, 400))`)
    const from = (await p.js(where)).path
    await p.shot(`40-phone-${name}-session`)
    await tap(b[0], b[1])
    let w = await p.js(where)
    const n0 = (await p.js(padSummary)).n
    await p.touch('touchStart', [[80, 520]])
    for (let i = 1; i <= 10; i++) { await p.touch('touchMove', [[80 + i * 22, 520 + Math.sin(i / 2) * 30]]); await sleep(12) }
    await p.touch('touchEnd', [])
    await sleep(400)
    const pst = await p.js(padSummary)
    check(`board phone ${name}: a tap opens the pad over the session, a finger draws`, w.open && w.path === '/pad' && pst.n === n0 + 1 && pst.sync.pending === 0, `${n0} → ${pst.n}`)
    await p.shot(`41-phone-${name}-pad`)
    // send an area on a phone: the piece flies into the chooser's row
    const areaBtn = await rectOf(p, '.pad-tool[data-tool="area"]', true)
    const toolsFit = await p.js(`${FRAME} const r = doc.querySelector('.pad-tools').getBoundingClientRect(); return r.left >= 0 && r.right <= frame.contentWindow.innerWidth + 0.5`)
    await tap(areaBtn[0], areaBtn[1])
    const pb = await p.js(`${FRAME} const v = pad.view(), e = pad.elements().at(-1); return [e.x * v.z + v.x, e.y * v.z + v.y, (e.x + e.w) * v.z + v.x, (e.y + e.h) * v.z + v.y]`)
    await p.touch('touchStart', [[pb[0] - 12, pb[1] - 12]])
    for (let i = 1; i <= 8; i++) { await p.touch('touchMove', [[pb[0] - 12 + ((pb[2] - pb[0] + 24) * i) / 8, pb[1] - 12 + ((pb[3] - pb[1] + 24) * i) / 8]]); await sleep(12) }
    await p.touch('touchEnd', [])
    await sleep(350)
    const pm = await p.js(`${FRAME} const m = doc.getElementById('area-menu'), r = m.getBoundingClientRect(); return { open: !m.hidden, fits: r.left >= 0 && r.right <= frame.contentWindow.innerWidth + 0.5 && r.bottom <= frame.contentWindow.innerHeight, first: m.querySelector('.pad-menu-item')?.textContent, n: pad.area()?.ids.length }`)
    await p.shot(`42-phone-${name}-area-chooser`)
    await p.page.send('Animation.enable')
    await p.page.send('Animation.setPlaybackRate', { playbackRate: 0.1 })
    const row = await rectOf(p, '#area-menu .pad-menu-item', true)
    await tap(row[0], row[1])
    await sleep(3000)
    const local = await p.js(`${FRAME} return { sheet: doc.getElementById('fly').children.length, strip: Boolean(document.querySelector('.padlink-strip')) }`)
    await p.shot(`43-phone-${name}-swoosh`)
    await p.page.send('Animation.setPlaybackRate', { playbackRate: 1 })
    await sleep(2500)
    const after = await p.js(`${FRAME} return { toast: doc.getElementById('toast').textContent, sheet: doc.getElementById('fly').children.length, area: pad.area(), sent: pad.elements().at(-1).sent.length }`)
    check(`board phone ${name}: Send area fits the toolbar, the chooser fits the screen, the piece flies into the chooser's row and it is sent`, toolsFit && pm.open && pm.fits && pm.n >= 1 && /^Web-Frontend/.test(pm.first) && local.sheet === 1 && !local.strip && after.toast === 'Sent to Web-Frontend' && after.sheet === 0 && !after.area && after.sent >= 1, `${pm.first}; ${after.toast}; ${JSON.stringify(local)}`)
    const close = await rectOf(p, '#back', true)
    await tap(close[0], close[1])
    w = await p.js(where)
    check(`board phone ${name}: its close button goes back to the session, no errors`, !w.open && w.path === from && !p.errors.length, `${w.path} ${p.errors.join(' | ')}`)
    await p.close()
  }
}

const failed = results.filter(r => !r.ok)
console.log(`\n${results.length - failed.length} of ${results.length} checks passed; screenshots in ${outDir}`)
process.exit(failed.length ? 1 : 0)
