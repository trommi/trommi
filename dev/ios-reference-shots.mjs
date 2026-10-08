// ios-reference-shots.mjs: every screen of the web app's demo (/screens, demo.mjs SCREENS) as a phone and a tablet
// screenshot, light and dark: the reference picture set for the iOS app.
//   node app/web/dev/serve.mjs 8900 &  node dev/ios-reference-shots.mjs OUT_DIR [BASE=http://127.0.0.1:8900]
import fs from 'node:fs'
import path from 'node:path'
import { launchChromium } from './cdp.mjs'

const [out = 'ios-ref', base = 'http://127.0.0.1:8900'] = process.argv.slice(2)
const src = fs.readFileSync(new URL('../app/web/public/demo/demo.mjs', import.meta.url), 'utf8')
const SCREENS = new Function(`return ${/const SCREENS = (\[[\s\S]*?\n\])\n/.exec(src)[1]}`)()
const sleep = ms => new Promise(r => setTimeout(r, ms))
const slug = s => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
fs.mkdirSync(out, { recursive: true })
const sizes = (process.env.SIZES ?? 'phone').split(',')
const SIZE = { phone: [390, 844, true], tablet: [1180, 820, false] }
const browser = await launchChromium({ width: 1180, height: 900 })
try {
  for (const size of sizes) for (const dark of [false, true]) {
    const [width, height, mobile] = SIZE[size]
    for (const [title, p, states, first = ''] of SCREENS) {
      for (const [label, sp, st, mock] of [['', p, first], ...states]) {
        const page = await browser.page()
        await page.send('Page.enable'); await page.send('Runtime.enable')
        await page.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 2, mobile })
        if (dark) await page.send('Page.addScriptToEvaluateOnNewDocument', { source: "try{localStorage.setItem('agent-board-theme','dark')}catch(e){}" })
        const at = sp || p
        const url = `${base}${at}${at.includes('?') ? '&' : '?'}mock=${mock || '1'}${st ? `&state=${st}` : ''}`
        await page.send('Page.navigate', { url })
        for (let i = 0; i < 60; i++) { const r = await page.send('Runtime.evaluate', { expression: "document.documentElement.hasAttribute('data-ready')", returnByValue: true }).catch(() => null); if (r?.result?.value) break; await sleep(100) }
        await sleep(st ? 900 : 500)
        const shot = await page.send('Page.captureScreenshot', { format: 'png' })
        const name = `${size}-${dark ? 'dark' : 'light'}-${slug(title)}${label ? `--${slug(label)}` : ''}.png`
        fs.writeFileSync(path.join(out, name), Buffer.from(shot.data, 'base64'))
        console.log(name)
        page.close()
      }
    }
  }
} finally { await browser.close() }
