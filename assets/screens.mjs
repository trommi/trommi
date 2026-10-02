// The product screenshots in assets/screens/, taken from a demo board of their own.
// Called by  node assets/build.mjs --screens [PORT]  (needs the command sandbox disabled, like dev/cdp.mjs).
// It starts dev/trio.sh (three scripted sessions) on PORT unless a board already answers there, drives the
// page it is given, and stops what it started.
import { spawn } from 'node:child_process'
import path from 'node:path'

export async function takeScreens({ page, evaluate, shoot, sleep, port, root }) {
  const base = `http://localhost:${port}`
  const answers = async () => { try { return (await fetch(`${base}/healthz`)).ok } catch { return false } }
  let board = null
  if (!(await answers())) {
    board = spawn(path.join(root, 'dev', 'trio.sh'), [String(port), '300'], { stdio: 'ignore', detached: true })
    for (let i = 0; i < 100 && !(await answers()); i++) await sleep(200)
    if (!(await answers())) throw new Error(`no demo board came up on port ${port}`)
    await sleep(9000)   // the three sessions come one after the other and ask their questions
  }
  const wait = async (expression, what) => {
    for (let i = 0; i < 60; i++) { if (await evaluate(`return Boolean(${expression})`)) return; await sleep(150) }
    throw new Error(`the page never showed ${what}`)
  }
  /** The board at this size and theme, loaded and settled. */
  async function open(theme, { width = 1280, height = 800, scale = 1, mobile = false } = {}) {
    await page.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: scale, mobile })
    await page.send('Page.navigate', { url: `${base}/?t=demo` })
    await wait(`document.querySelector('html[data-loaded]')`, 'the board')
    await evaluate(`localStorage.setItem('agent-board-theme', '${theme}'); return 1`)
    await page.send('Page.navigate', { url: `${base}/inbox?t=demo` })
    await wait(`document.querySelector('html[data-loaded]') && document.querySelectorAll('#inbox .inbox-row').length`, 'the inbox')
    await sleep(1200)
  }
  const mouse = (type, x, y) => page.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', buttons: type === 'mouseReleased' ? 0 : 1, clickCount: 1 })
  /** One stroke of the pen through these points. */
  async function stroke(points) {
    await mouse('mousePressed', ...points[0])
    for (let i = 1; i < points.length; i++) {
      const [ax, ay] = points[i - 1], [bx, by] = points[i]
      for (let t = 1; t <= 6; t++) { await mouse('mouseMoved', ax + (bx - ax) * t / 6, ay + (by - ay) * t / 6); await sleep(8) }
    }
    await mouse('mouseReleased', ...points.at(-1))
    await sleep(120)
  }

  try {
    let drawn = false
    for (const theme of ['light', 'dark']) {
      await open(theme)
      await shoot(`screens/inbox-${theme}.png`)

      await evaluate(`document.querySelector('#focus-open').click(); return 1`)
      await wait(`document.querySelector('.focus .focus-opt')`, 'the question window')
      await sleep(900)
      await shoot(`screens/question-${theme}.png`)

      // The sidebar alone, at twice the size: the marks, the hands, the sweeps.
      await open(theme, { scale: 2 })
      const side = await evaluate(`const r = document.querySelector('#agents').getBoundingClientRect(), last = [...document.querySelectorAll('#agents .agent-row')].at(-1).getBoundingClientRect(); return [r.x, r.y, r.width, Math.min(r.height, last.bottom - r.y + 16)]`)
      await shoot(`screens/sidebar-${theme}.png`, { x: side[0], y: side[1], width: side[2], height: side[3] })

      await open(theme)
      await evaluate(`document.querySelector('#pad-open').click(); return 1`)
      await wait(`document.querySelector('iframe[src*="/pad/"]')`, 'the pad')
      await sleep(2200)
      if (!drawn) {
        // A small sketch, as one would leave it for a session: a window, two lines in it, an arrow to a circle.
        await stroke([[330, 250], [560, 244], [566, 420], [334, 428], [328, 256]])
        await stroke([[362, 300], [450, 296], [530, 302]])
        await stroke([[364, 342], [430, 346], [490, 340]])
        await stroke([[600, 334], [690, 322], [770, 330]])
        await stroke([[738, 302], [774, 330], [742, 360]])
        await stroke([[900, 250], [840, 280], [826, 340], [860, 400], [930, 410], [984, 366], [986, 300], [940, 256], [892, 252]])
        await stroke([[872, 330], [900, 362], [952, 300]])
        drawn = true
        await sleep(1500)
      }
      await mouse('mouseMoved', 640, 620)
      await sleep(600)
      await shoot(`screens/pad-${theme}.png`)
    }
    await open('light', { width: 390, height: 844, scale: 2, mobile: true })
    await shoot('screens/phone-inbox-light.png')
    await open('dark', { width: 390, height: 844, scale: 2, mobile: true })
    await evaluate(`(document.querySelector('.inbox-walk-go') ?? document.querySelector('#focus-open')).click(); return 1`)
    await wait(`document.querySelector('.focus .focus-opt')`, 'the question window')
    await sleep(900)
    await shoot('screens/phone-question-dark.png')
  } finally {
    if (board?.pid) { try { process.kill(-board.pid, 'SIGTERM') } catch {} }
  }
}
