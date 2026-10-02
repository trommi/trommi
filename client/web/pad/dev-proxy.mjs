// Development only: look at the pad on a board whose server does not serve /pad/ yet.
// Serves this folder under /pad/ and passes everything else through to the board,
// signed in with the board's token, so /css, /js, /events and /speech behave as
// they will once the server serves the folder itself.
//   node client/web/pad/dev-proxy.mjs LISTEN_PORT BOARD_PORT [TOKEN]     token defaults to "demo"
//   node client/web/pad/dev-proxy.mjs LISTEN_PORT -                      no board: /css and /js from disk, nothing else
// Binds to localhost only. Not part of the product; delete it when server.mjs serves /pad/.
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const [listen, board = '-', token = 'demo'] = process.argv.slice(2)
if (!listen) { console.error('usage: dev-proxy.mjs LISTEN_PORT BOARD_PORT|- [TOKEN]'); process.exit(2) }
const HERE = path.dirname(fileURLToPath(import.meta.url))
const WEB = path.join(HERE, '..')
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml' }

function file(res, base, rel) {
  const full = path.join(base, path.normalize(rel))
  if (!full.startsWith(base + path.sep) || !fs.existsSync(full) || !fs.statSync(full).isFile()) {
    res.writeHead(404, { 'Content-Type': 'application/json' })
    return res.end('{"error":"not found"}')
  }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(full)] ?? 'application/octet-stream', 'Cache-Control': 'no-store' })
  res.end(fs.readFileSync(full))
}

http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x')
  if (req.method === 'GET' && url.pathname.startsWith('/pad/')) {
    const rel = url.pathname.slice('/pad/'.length) || 'index.html'
    if (/\.(html|js|css)$/.test(rel) || rel === 'index.html') return file(res, HERE, rel)
  }
  if (board === '-') {
    if (req.method === 'GET' && /^\/(css|js)\//.test(url.pathname)) return file(res, WEB, url.pathname.slice(1))
    res.writeHead(404, { 'Content-Type': 'application/json' })
    return res.end('{"error":"not found"}')
  }
  // The board checks that a POST comes from its own page: present the request as local to it.
  const headers = { ...req.headers, host: `127.0.0.1:${board}`, cookie: `board=${token}` }
  if (headers.origin) headers.origin = `http://127.0.0.1:${board}`
  const up = http.request({ host: '127.0.0.1', port: board, method: req.method, path: req.url, headers }, back => {
    res.writeHead(back.statusCode, back.headers)
    back.pipe(res)
  })
  up.on('error', err => { res.writeHead(502, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: `board unreachable: ${err.message}` })) })
  req.pipe(up)
}).listen(Number(listen), '127.0.0.1', () => console.log(`pad on http://localhost:${listen}/pad/index.html (${board === '-' ? 'no board' : `board on ${board}`})`))
