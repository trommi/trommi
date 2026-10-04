// Writes <link rel="modulepreload"> for the app's whole static module graph (from boot.mjs and the core's index.mjs)
// into public/index.html between <!-- preload --> and <!-- /preload -->, so a cold start fetches every module at
// once instead of level by level. Run by dev/release.sh.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
const pub = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public')
const seen = new Set(), queue = ['/js/app/boot.mjs', '/gen/vendor/index.mjs']
while (queue.length) {
  const f = queue.shift()
  if (seen.has(f) || !fs.existsSync(path.join(pub, f))) continue
  seen.add(f)
  const src = fs.readFileSync(path.join(pub, f), 'utf8')
  for (const m of src.matchAll(/^\s*(?:import|export)\s+(?:[^'"]*?from\s+)?['"]([^'"]+)['"]/gm)) queue.push(m[1].startsWith('/') ? m[1] : path.posix.join(path.posix.dirname(f), m[1]))
}
// The release's mark: a hash of every tracked file of the app (the service worker revalidates index.html only).
const tracked = (await import('node:child_process')).execSync('git ls-files .', { cwd: pub, encoding: 'utf8' }).split('\n').filter(f => f && !/^(index\.html|sw\.js|mock\/)/.test(f) && fs.existsSync(path.join(pub, f)))
const version = (await import('node:crypto')).createHash('sha256').update(tracked.map(f => fs.readFileSync(path.join(pub, f))).join('')).digest('hex').slice(0, 12)
const block = [`<!-- preload ${version} -->`, ...[...seen].map(f => `<link rel="modulepreload" href="${f}">`), '<!-- /preload -->'].join('\n')
const file = path.join(pub, 'index.html')
let html = fs.readFileSync(file, 'utf8')
html = /<!-- preload[^>]*-->[\s\S]*<!-- \/preload -->/.test(html) ? html.replace(/<!-- preload[^>]*-->[\s\S]*<!-- \/preload -->/, block) : html.replace(/<link rel="modulepreload"[^>]*>\n/g, '').replace('<script type="module"', `${block}\n<script type="module"`)
fs.writeFileSync(file, html)
console.log(`index.html: ${seen.size} modules preloaded`)
