#!/usr/bin/env node
// Side by side: for every state and profile, the Turbo board's shot on the left, the new app's on the right, in one
// PNG with labels; plus an index.html that shows them all. A shot that is missing on one side is drawn as a gap.
//   node dev/verify/sbs.mjs --left DIR/turbo --right DIR/app --out DIR/sbs [--only a,b] [--profiles p1,p2]
//   node dev/verify/sbs.mjs --left DIR/turbo --out DIR/sheet           (no right: a contact sheet of one target)
// Needs the command sandbox disabled (Chromium renders the composite).
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { STATES } from './states.mjs'
import { PROFILES, arg, openPage, sleep } from './lib.mjs'

const left = path.resolve(arg('left'))
const right = arg('right') ? path.resolve(arg('right')) : null
const out = path.resolve(arg('out', path.join(path.dirname(left), right ? 'sbs' : 'sheet')))
const only = (arg('only') ?? '').split(',').filter(Boolean)
const profiles = (arg('profiles') ?? Object.keys(PROFILES).join(',')).split(',')
fs.mkdirSync(out, { recursive: true })
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c])
const side = (dir, profile, name, label) => {
  const f = dir && path.join(dir, profile, `${name}.png`)
  return `<figure><figcaption>${esc(label)}</figcaption>${f && fs.existsSync(f) ? `<img src="${pathToFileURL(f).href}">` : '<div class="gap">missing</div>'}</figure>`
}
const css = `body{margin:0;background:#e9ece9;font:14px system-ui;color:#222}.row{display:flex;gap:16px;padding:16px;align-items:flex-start}
figure{margin:0;background:#fff;border:1px solid #bbb}figcaption{padding:6px 10px;font-weight:600;background:#f4f4f4;border-bottom:1px solid #ccc}
img{display:block;max-width:100%}.gap{display:grid;place-items:center;font-size:28px;color:#a33;background:repeating-linear-gradient(45deg,#fff,#fff 10px,#fbeaea 10px,#fbeaea 20px)}
h1{font-size:16px;margin:16px 16px 0}`
const made = []
for (const profile of profiles) {
  const p = PROFILES[profile]
  const scale = p.width > 1000 ? 0.5 : 1
  const w = Math.round(p.width * scale), hgt = Math.round(p.height * scale)
  const h = await openPage({ profile: { width: (right ? 2 : 1) * w + (right ? 16 : 0) + 34, height: hgt + 84 }, base: 'file://' })
  try {
    for (const { name, see } of STATES.filter(s => !only.length || only.includes(s.name))) {
      if (!fs.existsSync(path.join(left, profile, `${name}.png`)) && !(right && fs.existsSync(path.join(right, profile, `${name}.png`)))) continue
      const page = `<!doctype html><meta charset="utf-8"><style>${css}.gap,img{width:${w}px;height:${hgt}px}</style><h1>${esc(name)} · ${esc(profile)} — ${esc(see)}</h1><div class="row">${side(left, profile, name, `Turbo (today)`)}${right ? side(right, profile, name, 'New app') : ''}</div>`
      const file = path.join(out, profile, `${name}.html`)
      fs.mkdirSync(path.dirname(file), { recursive: true })
      fs.writeFileSync(file, page)
      await h.go(pathToFileURL(file).href)
      await sleep(250)
      made.push(await h.shot(path.join(out, profile, `${name}.png`)))
      fs.rmSync(file)
    }
  } finally { await h.close() }
}
fs.writeFileSync(path.join(out, 'index.html'), `<!doctype html><meta charset="utf-8"><style>body{font:14px system-ui;margin:16px}img{max-width:100%;border:1px solid #ccc;margin:0 0 24px}</style>${made.map(f => `<img src="${path.relative(out, f)}" loading="lazy">`).join('\n')}`)
console.log(`${made.length} images in ${out} (index.html)`)
process.exit(0)
