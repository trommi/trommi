// static.mjs: a static server for a BUILT app folder (built.mjs, or public/ after build.mjs --write), for tests. It
// answers as the deployed app does where the tests depend on it: the headers of the folder's own _headers (so the
// Content-Security-Policy is the built one, word for word), the right MIME types (application/wasm), index.html for
// an address that is no file. Tests may bend it in three named ways, each off by default:
//   policy(csp, address)   the policy sent with that address instead (to prove what a keyword is needed for)
//   body(address, bytes)   the bytes sent instead (to prove a tampered file is refused)
//   pages                  { address: html } served beside the app, under the app's headers (an empty page to start from)
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.webmanifest': 'application/manifest+json', '.txt': 'text/plain', '.wasm': 'application/wasm' }

/** _headers as [[pattern as a RegExp, { header: value | null (removed) }]]. */
function readHeaders(text) {
  const rules = []
  for (const line of text.split('\n')) {
    if (!line.trim() || line.startsWith('#')) continue
    if (!/^\s/.test(line)) rules.push([new RegExp(`^${line.trim().replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`), {}])
    else if (line.trim().startsWith('!')) rules.at(-1)[1][line.trim().slice(1).trim()] = null
    else { const [k, ...v] = line.trim().split(':'); rules.at(-1)[1][k.trim()] = v.join(':').trim() }
  }
  return rules
}

/** The app's own policy: the Content-Security-Policy of the rule for every address. */
export function appPolicy(dir) {
  const csp = readHeaders(fs.readFileSync(path.join(dir, '_headers'), 'utf8')).find(([re]) => re.test('/anything'))?.[1]['Content-Security-Policy']
  if (!csp) throw new Error(`${dir}/_headers has no Content-Security-Policy for /*`)
  return csp
}

/** Serve `dir` on a free port of 127.0.0.1: { origin, close() }. */
export async function serveStatic(dir, { policy = csp => csp, body = (_address, bytes) => bytes, pages = {} } = {}) {
  const rules = readHeaders(fs.readFileSync(path.join(dir, '_headers'), 'utf8'))
  const server = http.createServer((req, res) => {
    const address = decodeURIComponent(new URL(req.url, 'http://x').pathname)
    let rel = address.replace(/^\/+/, '')
    const isFile = f => { const p = path.join(dir, f); return p.startsWith(dir + path.sep) && fs.existsSync(p) && fs.statSync(p).isFile() }
    const page = pages[address]
    if (page == null && !isFile(rel)) {
      if (isFile(`${rel}.html`)) rel += '.html'
      else if (/\.\w+$/.test(rel)) { res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('not found\n'); return }
      else rel = 'index.html'
    }
    const head = { 'Content-Type': page != null ? TYPES['.html'] : TYPES[path.extname(rel)] ?? 'application/octet-stream' }
    for (const [re, set] of rules) if (re.test(`/${rel}`) || re.test(address)) for (const [k, v] of Object.entries(set)) { if (v === null) delete head[k]; else head[k] = v }
    if (head['Content-Security-Policy']) head['Content-Security-Policy'] = policy(head['Content-Security-Policy'], address)
    head['Cache-Control'] = 'no-store'   // (every run fetches: a test never reads what an earlier one cached)
    res.writeHead(200, head)
    res.end(page != null ? page : body(address, fs.readFileSync(path.join(dir, rel))))
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  return { origin: `http://127.0.0.1:${server.address().port}`, close: () => new Promise(resolve => { server.closeAllConnections(); server.close(resolve) }) }
}
