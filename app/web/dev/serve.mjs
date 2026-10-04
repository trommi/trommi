// Local static server for the app with the SPA fallback Cloudflare gives (assets.not_found_handling) and the headers
// of public/_headers, and the build of dev/build.mjs made in memory on every request of the shell (as deployed).
//   node dev/serve.mjs [port=8900] [--raw]   (--raw: the source shell, each stylesheet its own <link>)
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { bundle } from './build.mjs'
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public')
const port = Number(process.argv.slice(2).find(a => /^\d+$/.test(a)) || 8900)
const RAW = process.argv.includes('--raw')
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.webmanifest': 'application/manifest+json', '.csv': 'text/csv', '.log': 'text/plain', '.txt': 'text/plain' }
// Read on every request: a dev server left running must not serve an old CSP (it once blocked the Argon2 WASM).
const readHeaders = () => { const headers = {}
try { let cur = null; for (const line of fs.readFileSync(path.join(root, '_headers'), 'utf8').split('\n')) { if (!line.trim() || line.startsWith('#')) continue; if (!/^\s/.test(line)) { cur = line.trim(); headers[cur] = {} } else if (line.trim().startsWith('!')) headers[cur][line.trim().slice(1).trim()] = null; else { const [k, ...v] = line.trim().split(':'); headers[cur][k.trim()] = v.join(':').trim() } } } catch {}
  return headers }
http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x')
  let file = path.join(root, decodeURIComponent(url.pathname))
  if (!file.startsWith(root)) { res.writeHead(403); return res.end() }
  if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, 'index.html')
  // Like Cloudflare's html_handling: /a/frame serves /a/frame.html.
  if (!fs.existsSync(file) && fs.existsSync(`${file}.html`)) file = `${file}.html`
  const isBundle = !RAW && /^\/css\/bundle\.\w+\.css$/.test(url.pathname)
  if (!fs.existsSync(file) && !isBundle) {
    // Like Cloudflare's single-page-application handling: navigations get the app, anything else a 404.
    if (req.headers['sec-fetch-mode'] !== 'navigate' && /\.\w+$/.test(url.pathname)) { res.writeHead(404, { 'Content-Type': 'text/plain' }); return res.end('not found') }
    file = path.join(root, 'index.html')
  }
  const h = { 'Content-Type': TYPES[path.extname(file)] ?? 'application/octet-stream', 'Cache-Control': 'no-cache' }
  for (const [pat, hs] of Object.entries(readHeaders())) { const re = new RegExp(`^${pat.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`); if (re.test(url.pathname) || re.test(url.pathname + '.html')) for (const [k, v] of Object.entries(hs)) { if (v === null) delete h[k]; else h[k] = v } }
  // Local hubs for development (the deployed CSP names only https://hub.trommi.com).
  if (h['Content-Security-Policy'] && !h['Content-Security-Policy'].includes('sandbox')) h['Content-Security-Policy'] = h['Content-Security-Policy'].replace('connect-src ', 'connect-src http://127.0.0.1:* http://localhost:* ')
  res.writeHead(200, h)
  // The built shell: index.html, sw.js and the bundle come from the build, everything else from public/.
  const built = !RAW && (file === path.join(root, 'index.html') || file === path.join(root, 'sw.js') || isBundle) && bundle(root)
  if (built) return res.end(file.endsWith('index.html') ? built.html : file.endsWith('sw.js') ? built.sw : built.css)
  fs.createReadStream(file).pipe(res)
}).listen(port, '127.0.0.1', () => console.log(`app on http://127.0.0.1:${port}`))
