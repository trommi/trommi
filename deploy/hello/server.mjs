// Hello-world stand-in for the hub, used to test the deploy chain end to end.
// It answers every path; /healthz reports the commit it was built from.
import http from 'node:http'

const commit = process.env.COMMIT || 'unknown'

http.createServer((req, res) => {
  if (req.url === '/healthz') {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ok: true, commit }))
    return
  }
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
  res.end(`<!doctype html><title>Trommi hub</title><p>Hello, world — Trommi hub, commit ${commit}</p>`)
}).listen(8790, '0.0.0.0')
