// stack.mjs: a local stand for remote.mjs: the normal build of the app and the REAL hub's binary, on one origin, kept
// running until Ctrl-C. It is what `run.mjs real --app … --hub …` is pointed at before it is pointed at a deployed
// app and hub.
//   TROMMI_HUB_BIN=/path/to/trommi-hub node tests/web/e2e/stack.mjs
// It prints `app: http://localhost:<port>` once both are up; the hub is reached through that same origin (/v2/ is
// passed on, as in real.mjs), so the remote run is given that address twice:
//   node tests/web/e2e/run.mjs real --app http://localhost:<port> --hub http://localhost:<port>
// Unlike real.mjs the hub keeps its production settings: failed logins are throttled, founding is open within its
// per-address limit. Its data lies in a fresh folder under TMP and is removed when it stops.
import { buildApp, missing, serveApp } from './harness.mjs'
import { startHub } from './real.mjs'

const lacking = missing({ hub: true }).filter(l => !l.startsWith('Chromium'))
if (lacking.length) { console.error(lacking.map(l => `stack: cannot run: ${l}`).join('\n')); process.exit(2) }
const dir = await buildApp('stack-dist')
let hubUrl = null
const app = await serveApp(dir, () => hubUrl)
const hub = await startHub(app.origin, { HUB_LOGIN_THROTTLE: 'on' })
hubUrl = hub.url
console.log(`app: ${app.origin}\nhub: ${app.origin} (the binary at ${hub.url}, passed on under /v2/)`)
const stop = async () => { await app.close().catch(() => {}); await hub.close().catch(() => {}); const e = hub.stderr().trim(); if (e) console.log(`the hub wrote to stderr: ${e.split('\n').slice(-5).join(' | ').slice(0, 600)}`); process.exit(0) }
process.on('SIGINT', stop)
process.on('SIGTERM', stop)
