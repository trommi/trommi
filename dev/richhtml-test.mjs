// Rich content on a demo board, checked in headless Chromium: markdown tables and HTML blocks in a
// conversation and in a question, the frame's walls, its height, dark mode, phone width.
//   dev/trio.sh 8861 &                              (the API persona of dev/fake-agent.mjs sends one of each)
//   node dev/richhtml-test.mjs [http://127.0.0.1:8861] [OUT_DIR]
// Needs the command sandbox disabled, like dev/cdp.mjs. Never point it at a live board: it writes nothing,
// but it is a test. Screenshots go to OUT_DIR (default: the temp folder).
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { launchChromium } from './cdp.mjs'

const base = (process.argv[2] || 'http://127.0.0.1:8861').replace(/\/$/, '')
const out = process.argv[3] || path.join(os.tmpdir(), 'richhtml-shots')
fs.mkdirSync(out, { recursive: true })
const sleep = ms => new Promise(r => setTimeout(r, ms))
let checks = 0
const ok = (value, what) => { assert.ok(value, what); checks++ }
const equal = (a, b, what) => { assert.deepEqual(a, b, what); checks++ }

// Frames without an origin would otherwise live in a process of their own, out of this session's reach.
const browser = await launchChromium({ width: 1440, height: 900, args: ['--disable-features=IsolateSandboxedIframes'] })
try {
  const page = await browser.page()
  const contexts = new Map()   // execution context id -> { frameId, origin }
  page.on('Runtime.executionContextCreated', ({ context }) => { if (context.auxData?.isDefault) contexts.set(context.id, { frameId: context.auxData.frameId, origin: context.origin }) })
  page.on('Runtime.executionContextDestroyed', ({ executionContextId }) => contexts.delete(executionContextId))
  page.on('Runtime.executionContextsCleared', () => contexts.clear())
  await page.send('Page.enable')
  await page.send('Runtime.enable')

  const size = (width, height) => page.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: width < 600 })
  const run = async (script, contextId) => {
    const res = await page.send('Runtime.evaluate', { expression: `(async () => { ${script} })()`, awaitPromise: true, returnByValue: true, ...(contextId ? { contextId } : {}) })
    if (res.exceptionDetails) throw new Error(res.exceptionDetails.exception?.description ?? res.exceptionDetails.text)
    return res.result?.value
  }
  const go = async url => { await page.send('Page.navigate', { url: `${base}${url}` }); await sleep(2600) }
  const shot = async name => {
    await sleep(500)
    const file = path.join(out, `${name}.png`)
    fs.writeFileSync(file, Buffer.from((await page.send('Page.captureScreenshot', { format: 'png' })).data, 'base64'))
    return file
  }
  // Run a script inside every agent frame on the page.
  const inFrames = async script => {
    // The agent's frames are the ones written from a string; the board has frames of its own (the pad).
    const ours = new Set(((await page.send('Page.getFrameTree')).frameTree.childFrames ?? []).filter(f => f.frame.url === 'about:srcdoc').map(f => f.frame.id))
    const found = []
    for (const [id, c] of contexts) if (ours.has(c.frameId)) found.push(await run(script, id).catch(err => ({ error: String(err.message).split('\n')[0] })))
    return found
  }
  const frames = () => run(`return [...document.querySelectorAll('.rh-frame')].filter(f => f.getClientRects().length).map(f => ({ sandbox: f.getAttribute('sandbox'), height: f.getBoundingClientRect().height, width: Math.round(f.getBoundingClientRect().width), cls: f.parentElement.className, src: f.getAttribute('src'), policy: /Content-Security-Policy" content="([^"]*)"/.exec(f.srcdoc)?.[1].replace(/nonce-[0-9a-f]+/, 'nonce-N') }))`)

  await go('/?t=demo')

  // ---- a conversation: a markdown table and an HTML block --------------------------------------
  await size(1440, 900)
  await go('/s/api')
  const table = await run(`
    const t = [...document.querySelectorAll('#chat .rich-table')].at(-1)
    if (!t) return null
    const cell = (r, c) => t.rows[r].cells[c]
    return { rows: t.rows.length, cols: t.rows[0].cells.length, head: [...t.rows[0].cells].map(c => c.textContent),
      align: [...t.rows[1].cells].map(c => getComputedStyle(c).textAlign), headAlign: [...t.rows[0].cells].map(c => getComputedStyle(c).textAlign),
      rule: parseFloat(getComputedStyle(cell(0, 0)).borderBottomWidth), pipes: /\\|/.test(t.closest('.rich').textContent),
      under: t.closest('.rich').firstElementChild.tagName, fits: t.parentElement.scrollWidth <= t.parentElement.clientWidth }`)
  ok(table, 'the markdown table in the conversation is a table')
  equal([table.rows, table.cols, table.head], [4, 4, ['Weg', 'Sperre', 'Umbau', 'Deploy']], 'its head and rows')
  equal(table.align, ['left', 'right', 'right', 'left'], 'columns of numbers stand right-aligned, words left')
  equal(table.headAlign, table.align, 'a head stands over its column')
  equal([table.rule, table.pipes, table.under, table.fits], [2, false, 'P', true], 'a heavier rule under the head, no pipes left, the sentence above it a paragraph, no sideways scroll on a wide screen')

  let seen = await frames()
  equal(seen.length, 1, 'one HTML block in the conversation')
  equal(seen[0].sandbox, 'allow-scripts', 'the frame is sandboxed, with scripts only: no same-origin, no forms, no popups, no top navigation')
  equal(seen[0].src, null, 'it is written into the frame, not fetched')
  equal(seen[0].policy, "default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; script-src 'nonce-N'; base-uri 'none'; form-action 'none'", 'the policy inside the frame')
  ok(!/allow-same-origin|allow-forms|allow-popups|allow-top-navigation/.test(seen[0].sandbox), 'nothing else is allowed')

  // The walls, from the inside.
  const walls = `
    const tried = {}
    try { tried.parentDocument = String(parent.document.title) } catch (e) { tried.parentDocument = e.name }
    try { tried.topLocation = String(top.location.href) } catch (e) { tried.topLocation = e.name }
    try { tried.cookie = 'read: ' + document.cookie } catch (e) { tried.cookie = e.name }
    try { tried.storage = 'read: ' + localStorage.length } catch (e) { tried.storage = e.name }
    try { tried.fetch = 'status ' + (await fetch(${JSON.stringify(`${base}/events`)})).status } catch (e) { tried.fetch = e.name }
    tried.picture = await new Promise(done => { const i = new Image(); i.onload = () => done('loaded'); i.onerror = () => done('blocked'); i.src = ${JSON.stringify(`${base}/favicon.svg`)} + '?' + Math.random() })
    // a script added later has no nonce
    const s = document.createElement('script'); s.textContent = 'window.__late = 1'; document.body.append(s); s.remove(); tried.lateScript = window.__late === 1 ? 'ran' : 'blocked'
    document.body.insertAdjacentHTML('beforeend', '<img src="data:image/gif;base64,R0lGODlhAQABAAAAACw=" onerror="window.__handler = 1" onload="window.__handler = 1">')
    await new Promise(r => setTimeout(r, 200)); document.body.lastElementChild.remove(); tried.handler = window.__handler === 1 ? 'ran' : 'blocked'
    try { const w = window.open('about:blank'); tried.popup = w ? 'opened' : 'blocked' } catch (e) { tried.popup = 'blocked' }
    try { top.location = 'about:blank'; tried.topNavigation = 'asked' } catch (e) { tried.topNavigation = e.name }
    tried.origin = origin
    return tried`
  const inside = (await inFrames(walls))[0]
  equal(inside, { parentDocument: 'SecurityError', topLocation: 'SecurityError', cookie: 'SecurityError', storage: 'SecurityError', fetch: 'TypeError', picture: 'blocked', lateScript: 'blocked', handler: 'blocked', popup: 'blocked', topNavigation: 'SecurityError', origin: 'null' }, 'the frame reaches neither the board nor its cookies nor the network')
  await sleep(300)
  equal(await run('return location.pathname'), '/s/api', 'the page around it stayed where it was')

  // Height: as tall as its content, nothing cut, nothing left over.
  const measure = `return { content: Math.ceil(document.documentElement.getBoundingClientRect().height), view: innerHeight, scrolls: document.documentElement.scrollHeight > innerHeight + 1, color: getComputedStyle(document.body).color, font: getComputedStyle(document.body).fontFamily, cards: document.querySelectorAll('.card').length, scripts: document.scripts.length }`
  let m = (await inFrames(measure))[0]
  seen = await frames()
  equal([m.view, m.scrolls, seen[0].height], [m.content, false, m.content], `the frame is as tall as its content (${m.content}px)`)
  equal([m.cards, m.scripts], [3, 1], 'the layout is there, and the only script is the board\'s own')
  const light = await run('return getComputedStyle(document.documentElement).getPropertyValue("--fg").trim()')
  ok(m.color.replace(/\s/g, '') === await run('const p = document.createElement("p"); p.style.color = "var(--fg)"; document.body.append(p); const c = getComputedStyle(p).color; p.remove(); return c.replace(/\\s/g, "")'), 'the text in the frame has the board\'s ink')
  ok(/IBM Plex Sans/.test(m.font), 'and the board\'s font stack')
  // The fonts are handed in as data (the frame fetches nothing); where this machine has no way to the font files, the frame stands in the system's face.
  const faces = [await run('await document.fonts.ready; return document.fonts.check("16px \\"IBM Plex Sans\\"")'), (await inFrames('await new Promise(r => setTimeout(r, 400)); await document.fonts.ready; return [...document.fonts].filter(f => f.status === "loaded").map(f => f.family.replace(/"/g, ""))'))[0]]
  if (faces[0]) ok(faces[1].includes('IBM Plex Sans'), `the frame shows the board's own face (${faces[1].join(', ')})`)
  else console.error('note: the board itself has no web font here, so the frame was not checked for it')
  await run(`[...document.querySelectorAll('#chat .rich-table')].at(-1).closest('.msg').scrollIntoView({ block: 'start' })`)
  const chatShot = await shot('chat-light')

  // ---- hostile HTML that reaches the client uncleaned (old state, another sender) ----------------
  await run(`
    const { rich } = await import('/js/ui.js')
    const evil = '<p id="shown">shown</p><script>parent.postMessage({ ran: "script" }, "*"); document.title = "ran"; window.__agent = 1<\\/script>'
      + '<img src="x" onerror="window.__agent = 2"><svg><script>window.__agent = 3<\\/script></svg><iframe src="/"></iframe><meta http-equiv="refresh" content="0;url=/">'
      + '<form action="/message" method="post"><input name="text" value="x"><button id="send">send</button></form><a id="js" href="javascript:window.__agent=4">js</a><a id="out" href="https://example.org/">out</a><base href="https://evil.example/">'
    window.__heard = []
    addEventListener('message', e => { if (e.data && e.data.ran) window.__heard.push(e.data.ran) })
    const node = rich('Hostile:\\n\\n\`\`\`html\\n' + evil + '\\n\`\`\`')
    node.id = 'hostile'
    document.querySelector('#chat .log, #chat').append(node)`)
  await sleep(900)
  const hostileAll = (await inFrames(`if (!document.getElementById('shown')) return null
    document.getElementById('js').click(); document.getElementById('send')?.click()
    await new Promise(r => setTimeout(r, 300))
    return { agent: window.__agent ?? null, title: document.title, scripts: document.scripts.length, frames: document.querySelectorAll('iframe, meta[http-equiv=refresh], base, form').length, js: document.getElementById('js').getAttribute('href'), target: document.getElementById('out').target, here: location.href }`))
  const hostile = hostileAll.find(Boolean)
  equal(hostile, { agent: null, title: '', scripts: 1, frames: 0, js: '#', target: '_blank', here: 'about:srcdoc' }, 'a script, a handler, a frame, a redirect and a form in agent HTML do nothing')
  equal(await run('return [window.__heard, document.title.includes("ran"), location.pathname]'), [[], false, '/s/api'], 'and the board heard nothing of it')
  await run('document.getElementById("hostile").remove()')

  // ---- a tall block is capped and opens large -----------------------------------------------------
  await run(`
    const { rich } = await import('/js/ui.js')
    const rows = Array.from({ length: 80 }, (_, i) => '<tr><td>Row ' + (i + 1) + '</td><td>' + (i * 17) + '</td></tr>').join('')
    const node = rich('\`\`\`html\\n<table><tr><th>Name</th><th>Value</th></tr>' + rows + '</table>\\n\`\`\`')
    node.id = 'tall'
    document.querySelector('#chat .log, #chat').append(node)
    node.scrollIntoView()`)
  await sleep(900)
  const tall = await run(`const f = document.querySelector('#tall .rh-frame'); return { h: Math.round(f.getBoundingClientRect().height), cap: Math.round(innerHeight * .7), capped: f.parentElement.classList.contains('is-capped'), kind: f.parentElement.dataset.rich, open: getComputedStyle(f.parentElement.querySelector('.rh-open')).opacity }`)
  equal(tall, { h: tall.cap, cap: 630, capped: true, kind: 'table', open: '1' }, 'a long table stops at 70% of the screen, scrolls inside, and offers "Open large"')
  const numeric = (await inFrames(`const t = document.querySelector('table'); return t && t.rows.length === 81 ? [...t.rows[5].cells].map(c => getComputedStyle(c).textAlign) : null`)).find(Boolean)
  equal(numeric, ['left', 'right'], 'numbers in an HTML table stand right-aligned too')
  await run(`document.querySelector('#tall .rh-open').click()`)
  await sleep(900)
  const big = await run(`const d = document.querySelector('dialog.rh-large'); const f = d.querySelector('.rh-frame'); return { open: d.open, sandbox: f.getAttribute('sandbox'), h: Math.round(f.getBoundingClientRect().height) > 700, w: Math.round(d.getBoundingClientRect().width) }`)
  equal(big, { open: true, sandbox: 'allow-scripts', h: true, w: 1100 }, 'the big view shows the same block in the same kind of frame')
  await shot('large')
  await run(`document.querySelector('dialog.rh-large .rh-large-close').click(); document.getElementById('tall').remove()`)

  // ---- dark: the frame follows without being loaded again -----------------------------------------
  await run(`window.__frame = document.querySelector('.rh-frame').contentWindow; document.documentElement.dataset.theme = 'dark'`)
  await sleep(700)
  const dark = (await inFrames(measure))[0]
  const darkInk = await run('const p = document.createElement("p"); p.style.color = "var(--fg)"; document.body.append(p); const c = getComputedStyle(p).color; p.remove(); return [c.replace(/\\s/g, ""), getComputedStyle(document.documentElement).getPropertyValue("--fg").trim(), window.__frame === document.querySelector(".rh-frame").contentWindow]')
  ok(darkInk[1] !== light, 'the board went dark')
  equal([dark.color.replace(/\s/g, ''), darkInk[2]], [darkInk[0], true], 'the frame took the dark ink, and it is the same frame')
  const cardGround = (await inFrames(`return getComputedStyle(document.querySelector('.card')).backgroundColor.replace(/\\s/g, '')`))[0]
  ok(cardGround !== 'rgb(255,255,255)', 'a card in the frame stands on the dark surface')
  const tableDark = await run(`const t = [...document.querySelectorAll('#chat .rich-table')].at(-1); return [getComputedStyle(t.rows[1].cells[0]).color.replace(/\\s/g, ''), getComputedStyle(t.rows[0].cells[0]).borderBottomColor.replace(/\\s/g, '')]`)
  equal(tableDark, [darkInk[0], darkInk[0]], 'the markdown table is drawn in the dark ink')
  const chatDark = await shot('chat-dark')

  // ---- the inbox row only names it ------------------------------------------------------------------
  await run(`document.documentElement.dataset.theme = 'light'`)
  await go('/')
  const rows = await run(`return [...document.querySelectorAll('.inbox-row')].filter(r => /Hoster|Lasttests/.test(r.textContent)).map(r => ({ title: r.querySelector('.inbox-question').textContent, carries: r.querySelector('.inbox-carries')?.textContent ?? '', text: r.querySelector('.inbox-body-text')?.textContent ?? '', frames: r.querySelectorAll('iframe, table').length, h: Math.round(r.getBoundingClientRect().height) }))`)
  equal(rows.map(r => [r.title, r.carries, r.frames]).sort(), [['Welcher Hoster für Staging?', 'a table', 0], ['Wie oft sollen die Lasttests laufen?', 'a table', 0]], 'a row names what the card carries and draws none of it')
  ok(rows.every(r => !/[|<]|```/.test(r.text)), `no pipes and no markup in a row's line of text: ${JSON.stringify(rows.map(r => r.text))}`)
  equal(new Set(rows.map(r => r.h)).size, 1, 'rows keep their one height')
  await shot('inbox')

  // ---- a question: HTML beside the body, and a markdown table in a body ------------------------------
  const ids = await run(`const { getState } = await import('/js/store.js'); const cards = getState().all.cards; return ['Welcher Hoster', 'Lasttests'].map(t => cards.find(c => c.title.includes(t) && c.status === 'open')?.id)`)
  ok(ids.every(Boolean), 'both demo questions are open')
  const question = async (id, name) => {
    await go(`/?q=${id}`)
    const found = await run(`
      const root = document.querySelector('.focus') ?? document.body
      const f = [...root.querySelectorAll('.rh-frame')].find(x => x.getClientRects().length)
      const t = [...root.querySelectorAll('.rich-table')].find(x => x.getClientRects().length)
      return { focus: Boolean(document.querySelector('.focus')), frame: f ? { h: Math.round(f.getBoundingClientRect().height), w: Math.round(f.getBoundingClientRect().width), sandbox: f.getAttribute('sandbox'), inView: f.getBoundingClientRect().top < innerHeight } : null,
        table: t ? { align: [...t.rows[1].cells].map(c => getComputedStyle(c).textAlign), w: Math.round(t.getBoundingClientRect().width), inWrap: t.parentElement.scrollWidth <= t.parentElement.clientWidth + 1 } : null }`)
    return { found, file: await shot(name) }
  }
  let q = await question(ids[0], 'question-html')
  ok(q.found.focus && q.found.frame, 'the question window shows the HTML block of a card')
  equal(q.found.frame.sandbox, 'allow-scripts', 'in the same kind of frame')
  m = (await inFrames(`return { content: Math.ceil(document.documentElement.getBoundingClientRect().height), view: innerHeight, rows: document.querySelectorAll('tr').length, details: document.querySelectorAll('details').length, align: [...document.querySelectorAll('tr')[1].cells].map(c => getComputedStyle(c).textAlign) }`)).find(x => x.rows === 4)
  equal([m.view, m.rows, m.details, m.align], [m.content, 4, 1, ['left', 'right', 'right', 'left', 'left']], 'as tall as its content, prices and sizes right-aligned')
  // Opening the details makes the frame grow with it.
  const before = m.view
  await inFrames(`document.querySelector('details')?.setAttribute('open', '')`)
  await sleep(600)
  m = (await inFrames(`return { content: Math.ceil(document.documentElement.getBoundingClientRect().height), view: innerHeight, rows: document.querySelectorAll('tr').length }`)).find(x => x.rows === 4)
  ok(m.view === m.content && m.view > before, `the frame grew with what was unfolded in it (${before} -> ${m.view})`)
  const questionShot = await shot('question-html-open')
  // The big view over the question window: Escape closes it, and only it.
  await run(`[...document.querySelectorAll('.focus .rh-open')].find(b => b.getClientRects().length).click()`)
  await sleep(700)
  ok(await run(`return document.querySelector('dialog.rh-large').open`), '"Open large" works from the question window')
  await shot('question-large')
  for (const type of ['keyDown', 'keyUp']) await page.send('Input.dispatchKeyEvent', { type, key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
  await sleep(500)
  equal(await run(`return [document.querySelector('dialog.rh-large').open, Boolean(document.querySelector('.focus')?.getClientRects().length), new URLSearchParams(location.search).has('q')]`), [false, true, true], 'Escape closes the big view and leaves the question open')
  const q2 = await question(ids[1], 'question-table')
  ok(q2.found.focus && q2.found.table, 'the question window shows a markdown table in a body')
  equal(q2.found.table.align, ['left', 'right', 'right'], 'with its numbers right-aligned')

  // ---- phone width -------------------------------------------------------------------------------
  await size(400, 860)
  await go('/s/api')
  await run(`[...document.querySelectorAll('#chat .rich-table')].at(-1)?.scrollIntoView({ block: 'center' })`)
  const phone = await run(`
    const t = [...document.querySelectorAll('#chat .rich-table')].at(-1), f = [...document.querySelectorAll('#chat .rh-frame')].at(-1)
    return { page: document.documentElement.scrollWidth <= innerWidth, table: Math.round(t.parentElement.getBoundingClientRect().right) <= innerWidth, frame: Math.round(f.getBoundingClientRect().right) <= innerWidth, fw: Math.round(f.getBoundingClientRect().width) }`)
  equal([phone.page, phone.table, phone.frame], [true, true, true], 'on a phone nothing reaches past the screen: a wide table scrolls inside its own box')
  m = (await inFrames(`return { content: Math.ceil(document.documentElement.getBoundingClientRect().height), view: innerHeight, cols: getComputedStyle(document.querySelector('.grid')).gridTemplateColumns.split(' ').length }`))[0]
  equal([m.view >= m.content, m.cols], [true, 1], 'the three cards stand under each other, and the frame is as tall as that')
  await shot('phone-table')
  await run(`[...document.querySelectorAll('#chat .rh-frame')].at(-1)?.scrollIntoView({ block: 'center' })`)
  await shot('phone-html')
  q = await question(ids[0], 'phone-question')
  ok(q.found.frame && q.found.frame.w <= 400, 'the question window on a phone shows the block inside the screen')
  const wide = await run(`const f = [...document.querySelectorAll('.rh-frame')].find(x => x.getClientRects().length); return { wide: f.parentElement.classList.contains('is-wide'), open: getComputedStyle(f.parentElement.querySelector('.rh-open')).opacity, page: document.documentElement.scrollWidth <= innerWidth }`)
  equal(wide, { wide: true, open: '1', page: true }, 'a table wider than the phone scrolls inside its frame and offers "Open large"')

  await browser.close()

  // ---- a frame scrolled out under the head of the conversation takes no click there ------------------
  // As browsers run it: the frame in a process of its own (the first browser above keeps it in the page's,
  // to look inside it), where the click is placed by asking that process.
  const real = await launchChromium({ width: 1440, height: 900 })
  try {
    const tab = await real.page()
    await tab.send('Page.enable')
    await tab.send('Runtime.enable')
    const eval2 = async script => {
      const res = await tab.send('Runtime.evaluate', { expression: `(async () => { ${script} })()`, awaitPromise: true, returnByValue: true })
      if (res.exceptionDetails) throw new Error(res.exceptionDetails.exception?.description ?? res.exceptionDetails.text)
      return res.result?.value
    }
    for (const url of ['/?t=demo', '/s/api']) { await tab.send('Page.navigate', { url: `${base}${url}` }); await sleep(2600) }
    const under = await eval2(`
      const f = document.querySelector('#chat .rh-frame')
      let box = f; while (box && !/auto|scroll/.test(getComputedStyle(box).overflowY)) box = box.parentElement
      // room below, so that the frame can be scrolled out at the top
      const pad = document.createElement('div'); pad.style.height = '1500px'; f.closest('.msg').parentElement.append(pad)
      const top = box.getBoundingClientRect().top
      box.scrollTop += f.getBoundingClientRect().top + f.getBoundingClientRect().height / 2 - (top - 40)
      await new Promise(r => setTimeout(r, 600))
      window.__clicked = []
      addEventListener('click', e => window.__clicked.push(e.target.closest('button, a')?.textContent.trim() ?? e.target.tagName), true)
      const r = f.getBoundingClientRect()
      return { frame: [Math.round(r.top), Math.round(r.bottom)], top: Math.round(top), controls: [...document.querySelectorAll('button, a')].filter(b => b.getClientRects().length && !box.contains(b)).map(b => { const q = b.getBoundingClientRect(); return { name: b.textContent.trim(), x: q.left + q.width / 2, y: q.top + q.height / 2, over: q.right > r.left && q.left < r.right && q.bottom > r.top && q.top < r.bottom } }).filter(c => c.over && c.name) }`)
    ok(under.frame[0] < under.top && under.frame[1] > under.top && under.controls.length, `the frame lies under the head of the conversation (${under.frame.join('..')}, the log starts at ${under.top}), behind ${under.controls.map(c => c.name).join(', ')}`)
    for (const c of under.controls) {
      for (const type of ['mousePressed', 'mouseReleased']) await tab.send('Input.dispatchMouseEvent', { type, x: c.x, y: c.y, button: 'left', clickCount: 1 })
      await sleep(350)
      equal(await eval2('return window.__clicked.splice(0)'), [c.name], `a click on "${c.name}" reaches it, not the frame scrolled out behind it`)
    }
    // and where the frame shows, it still takes the click itself
    const shown = await eval2(`const f = document.querySelector('#chat .rh-frame'); f.scrollIntoView({ block: 'center' }); await new Promise(r => setTimeout(r, 500)); const r = f.getBoundingClientRect(); for (let y = r.top + 8; y < r.bottom; y += 12) if (document.elementFromPoint(r.left + r.width / 2, y) === f) return { x: r.left + r.width / 2, y }; return null`)
    ok(shown, 'the frame shows again')
    for (const type of ['mousePressed', 'mouseReleased']) await tab.send('Input.dispatchMouseEvent', { type, x: shown.x, y: shown.y, button: 'left', clickCount: 1 })
    await sleep(350)
    equal(await eval2('return window.__clicked.splice(0)'), [], 'a click on the visible frame goes into the frame')
  } finally {
    await real.close()
  }

  console.log(JSON.stringify({ ok: true, checks, shots: out, chat: chatShot, dark: chatDark, question: questionShot }))
} finally {
  await browser.close()
}
