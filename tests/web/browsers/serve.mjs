// serve.mjs: one small server for the pages that test an ENGINE (not the app): the bindings' test page
// (tests/bindings/web/page.mjs, at /) and the probe (pages/probe.mjs, at /probe), with the files they import, under
// the web app's own Content-Security-Policy read from app/web/public/_headers. `policy.page` and `policy.worker` may
// be bent by a test (to prove what 'wasm-unsafe-eval' is needed for), as tests/bindings/browser.mjs does.
// /v1/stream answers as a hub's live stream does: server-sent events, one every `gap` milliseconds, never ended.
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const headers = fs.readFileSync(path.join(REPO, 'app/web/public/_headers'), 'utf8')
export const APP_CSP = headers.split('\n').find(line => line.trim().startsWith('Content-Security-Policy:')).trim().slice('Content-Security-Policy:'.length).trim()
if (!APP_CSP.includes("script-src 'self' 'wasm-unsafe-eval'")) throw new Error("the app's policy with 'wasm-unsafe-eval' was not found in _headers")
export const CSP_WITHOUT_WASM = APP_CSP.replace(" 'wasm-unsafe-eval'", '')

const TYPES = { '.mjs': 'text/javascript', '.js': 'text/javascript', '.json': 'application/json', '.wasm': 'application/wasm' }
const SERVED = /^\/(core\/wasm\/pkg|tests\/bindings|tests\/web\/browsers\/pages|spec\/vectors)\//
const WORKERS = new Set(['/tests/bindings/web/worker.mjs', '/tests/web/browsers/pages/probe-worker.mjs'])
const PAGES = { '/': '/tests/bindings/web/page.mjs', '/probe': '/tests/web/browsers/pages/probe-page.mjs' }

export async function serveEngine({ gap = 250 } = {}) {
  const policy = { page: APP_CSP, worker: APP_CSP }
  const server = http.createServer((request, response) => {
    const url = new URL(request.url, 'http://x').pathname
    const head = { 'Content-Security-Policy': WORKERS.has(url) ? policy.worker : policy.page, 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store' }
    if (PAGES[url]) {
      response.writeHead(200, { ...head, 'Content-Type': 'text/html; charset=utf-8' })
      response.end(`<!doctype html><meta charset="utf-8"><title>trommi-core</title><script type="module" src="${PAGES[url]}"></script>`)
      return
    }
    if (url === '/v1/stream') {
      response.writeHead(200, { ...head, 'Content-Type': 'text/event-stream' })
      response.flushHeaders()
      let n = 0
      const send = () => response.write(`id: ${++n}\nevent: tick\ndata: {"n":${n},"auth":${JSON.stringify(request.headers.authorization ?? null)}}\n\n`)
      send()
      const timer = setInterval(send, gap)
      response.on('close', () => clearInterval(timer))
      return
    }
    const file = path.join(REPO, url)
    if (!SERVED.test(url) || !file.startsWith(REPO + path.sep) || !fs.existsSync(file)) { response.writeHead(404, head); response.end(); return }
    response.writeHead(200, { ...head, 'Content-Type': TYPES[path.extname(file)] ?? 'application/octet-stream' })
    response.end(fs.readFileSync(file))
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  return {
    // (by name and by number: an engine may treat `localhost` and 127.0.0.1 differently as a secure context)
    origin: `http://localhost:${port}`, numeric: `http://127.0.0.1:${port}`, policy,
    close: () => new Promise(resolve => { server.closeAllConnections(); server.close(resolve) }),
  }
}
