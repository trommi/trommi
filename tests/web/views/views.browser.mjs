// views.browser.mjs: two view bugs, checked in headless Chromium on the built app, with pictures.
//   node tests/web/views/views.browser.mjs        (needs Chromium and the built core; one browser at a time)
//   TROMMI_E2E_SHOTS=<folder> for the pictures (default: the system's temporary folder), TROMMI_E2E_TMP for profiles.
//
// 1. An open note takes the files the note gets elsewhere: one tab attaches a picture and a file to the note while a
//    second tab of the same device has that note open; the second tab draws both tiles without a reload (the live
//    stream does not replace an open note, sidebar.mjs corner-note#takeFiles). The device is real (the built app's
//    worker with the Rust core); the hub is the FAKE hub, as in tests/web/e2e/standin.mjs, whose setUp this reuses.
// 2. The menu's + (New Desk…) keeps clear of the desk row's rename pen: the demo room (`?mock=1`, one desk, no All
//    Desks row) at 1440×900; headless Chromium has no hover, so the pen is always shown there, as on a touch screen.
//    The phone (390×844) hides the pen; its picture is taken too.
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import { fileURLToPath } from 'node:url'
import { setUp, tearDown } from '../e2e/standin.mjs'
import { main, openProfile, sleep, TMP } from '../e2e/harness.mjs'
import * as ui from '../e2e/ui.mjs'

const tiles = P => P.js("return [...document.querySelectorAll('#corner-note-box .corner-note-file')].map(c => c.dataset.url)")

/** A red square as a PNG (8 bit RGB, one IDAT). */
function redPng(n) {
  const chunk = (type, data) => { const len = Buffer.alloc(4), crc = Buffer.alloc(4); len.writeUInt32BE(data.length); crc.writeUInt32BE(zlib.crc32(Buffer.concat([Buffer.from(type), data]))); return Buffer.concat([len, Buffer.from(type), data, crc]) }
  const head = Buffer.alloc(13); head.writeUInt32BE(n, 0); head.writeUInt32BE(n, 4); head.set([8, 2, 0, 0, 0], 8)
  const row = Buffer.concat([Buffer.from([0]), Buffer.from(Array.from({ length: n }, () => [220, 40, 40]).flat())])
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', head), chunk('IDAT', zlib.deflateSync(Buffer.concat(Array(n).fill(row)))), chunk('IEND', Buffer.alloc(0))])
}
/** A small red PNG and a text file on disk, for the file field. */
function files() {
  const dir = path.join(TMP, 'view-files')
  fs.mkdirSync(dir, { recursive: true })
  const png = path.join(dir, 'red.png'), txt = path.join(dir, 'readme.txt')
  fs.writeFileSync(png, redPng(48))
  fs.writeFileSync(txt, 'hello')
  return { png, txt }
}

const steps = [
  ['an open note draws the files attached in another tab, without a reload', async ctx => {
    const { check } = ctx.run
    const { png, txt } = files()
    const A = await ctx.profile('A')
    ctx.password = await ui.signUp(A, ctx.app.start(), ctx.email)
    await ui.takeKit(A)
    await ui.live(A)
    const url = await A.js('return location.href')
    await A.click('#corner-note-box .corner-note-head')
    await A.until("document.querySelector('#corner-note-box.is-open')", 'the note open on tab 1')
    await A.type('#corner-note-box .corner-note-field', 'Pictures')
    await A.until("document.querySelector('#corner-note-box').dataset.cornerNoteIdValue", 'the note made')
    const T = await ctx.profiles.A.tab(url)
    await ui.live(T, 'the room live on tab 2')
    await T.until("document.querySelector('#corner-note-box.has-words')", 'the note on tab 2')
    await T.click('#corner-note-box .corner-note-head')
    await T.until("document.querySelector('#corner-note-box.is-open')", 'the note open on tab 2')
    await A.js("document.querySelector('#corner-note-box .corner-note-clip').click()")
    await A.attach('#corner-note-box input[type=file]', [png, txt])
    await A.until("document.querySelectorAll('#corner-note-box .corner-note-file:not(.is-uploading)').length === 2", 'two tiles on tab 1')
    try { await T.until("document.querySelectorAll('#corner-note-box .corner-note-file').length === 2", 'two tiles on the open note of tab 2', 8000) } catch {}
    const there = await tiles(T), here = await tiles(A)
    await T.shot('note-files-other-tab-1440')
    check(there.length === 2 && there.every(u => here.includes(u)), 'the open note of tab 2 shows the two files of tab 1', { there, here })
    check(await T.js("return document.querySelector('#corner-note-box').classList.contains('is-open') && document.querySelector('#corner-note-box .corner-note-field').value === 'Pictures'"), 'tab 2\'s note stayed open with its words')
    check(await T.js("return document.querySelector('#corner-note-box .corner-note-file.is-pic img')?.getAttribute('src')?.startsWith('/att/')"), 'the picture is drawn from its /att/ address')
    // (the same open note on a phone's width, for the picture)
    await T.session.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true })
    await sleep(600)
    await T.shot('note-files-other-tab-390')
  }],

  ['the menu\'s + (New Desk…) lies over no rename pen (one desk, 1440×900); pictures at 1440×900 and 390×844', async ctx => {
    const { check } = ctx.run
    for (const [width, height] of [[1440, 900], [390, 844]]) {
      const P = await openProfile(`menu-${width}`, ctx.seen, { width, height })
      try {
        const page = P.page
        await page.go(`${ctx.app.origin}/?mock=1`)
        await page.until("document.documentElement.hasAttribute('data-ready') && document.querySelector('#brand-menu, #desk-pill')", 'the demo room')
        await page.js("(document.querySelector('.desk-switch-open') ?? document.querySelector('#desk-pill') ?? document.querySelector('#brand-menu')).click()")
        await page.until("!document.querySelector('#brand-doors').hidden", 'the menu open')
        await sleep(400)
        const got = await page.js(`const box = e => { if (!e) return null; const r = e.getBoundingClientRect(); return r.width && r.height && getComputedStyle(e).display !== 'none' && getComputedStyle(e).visibility !== 'hidden' ? { l: r.left, t: r.top, r: r.right, b: r.bottom } : null }
          const add = box(document.querySelector('#desk-add'))
          const hit = (a, b) => a && b && a.l < b.r && b.l < a.r && a.t < b.b && b.t < a.b
          const rows = [...document.querySelectorAll('#brand-doors .menu-desk-row')]
          return { add, rows: rows.length, all: !!document.querySelector('#brand-doors .menu-desk-row.is-all'), pens: rows.map(r => hit(add, box(r.querySelector('.menu-desk-pen')))), counts: rows.map(r => hit(add, box(r.querySelector('.menu-n')))) }`)
        await page.shot(`menu-plus-${width}`)
        check(got.add, `the + is shown (${width})`, got)
        check(!got.pens.some(Boolean), `the + lies over no rename pen (${width})`, got)
        check(!got.counts.some(Boolean), `the + lies over no count (${width})`, got)
      } finally { await P.close() }
    }
  }],
  ['the page curl stays inside the window and its margin on a phone (390×844); its box on a wide window as before', async ctx => {
    const { check } = ctx.run
    for (const [width, height] of [[390, 844], [1440, 900]]) {
      const P = await openProfile(`curl-${width}`, ctx.seen, { width, height })
      try {
        const page = P.page
        await page.go(`${ctx.app.origin}/?mock=1`)
        await page.until("document.documentElement.hasAttribute('data-ready') && document.querySelector('.curl')?.style.width", 'the demo room with its curl')
        await sleep(300)
        const got = await page.js("const r = document.querySelector('.curl').getBoundingClientRect(), vw = document.documentElement.clientWidth; return { right: r.right, top: r.top, vw }")
        await page.shot(`curl-${width}`)
        if (width < 860) check(got.right <= got.vw - 10 && got.top >= 10, `the curl's corner keeps 10 px from the right and top edges (${width})`, got)
        else check(got.right <= got.vw, `the curl's box ends inside the window (${width})`, got)
      } finally { await P.close() }
    }
  }],
]

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) await main('views', { setUp, steps, tearDown }, {})
