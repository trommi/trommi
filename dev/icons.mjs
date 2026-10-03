// The app icons for the Home Screen and the notification, drawn from client/web/icons/trommi.svg by headless Chromium.
//   node dev/icons.mjs        (needs the command sandbox disabled, like dev/cdp.mjs)
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { launchChromium } from './cdp.mjs'

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'client', 'web', 'icons')
const svg = fs.readFileSync(path.join(dir, 'trommi.svg'), 'utf8')
for (const size of [180, 192, 512]) {
  const browser = await launchChromium({ width: size + 200, height: size + 200 })   // the window is larger than the picture cut out of it
  try {
    const page = await browser.page()
    await page.send('Page.navigate', { url: `data:text/html,${encodeURIComponent(`<style>html,body{margin:0}svg{display:block;width:${size}px;height:${size}px}</style>${svg}`)}` })
    await new Promise(r => setTimeout(r, 400))
    const { data } = await page.send('Page.captureScreenshot', { format: 'png', clip: { x: 0, y: 0, width: size, height: size, scale: 1 } })
    fs.writeFileSync(path.join(dir, `trommi-${size}.png`), Buffer.from(data, 'base64'))
  } finally { await browser.close() }
}
