// app/web/public/sw.js, its fetch handler run in Node with a stand-in for the service worker's global: which requests
// it answers (respondWith) and which it leaves to the network. The hub's API, the live stream above all, is never
// its own, also where the hub answers on the app's origin (a local stack); only the app's files and pages are.
//
//   node --test tests/web/worker/
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'

const SHELL = ['/', '/index.html', '/gen/app/app-abc.mjs', '/gen/bundle.abc.css']
/** sw.js as built (a VERSION and a SHELL written in), in a context of its own; returns its fetch listener. */
async function handler() {
  const text = (await readFile(new URL('../../../app/web/public/sw.js', import.meta.url), 'utf8'))
    .replace(/^const VERSION = .*$/m, 'const VERSION = "built"').replace(/^const SHELL = .*$/m, `const SHELL = ${JSON.stringify(SHELL)}`)
  const listeners = {}
  const self = { location: new URL('https://app.example'), addEventListener: (k, fn) => { listeners[k] = fn }, clients: {}, registration: {}, skipWaiting() {} }
  vm.runInNewContext(text, { self, URL, Response, caches: {}, fetch: () => { throw new Error('no network here') }, console, setTimeout, clearTimeout, MessageChannel })
  return listeners.fetch
}
/** Whether the handler answers a request itself. */
function answers(fetchListener, path, { method = 'GET', mode = 'cors', origin = 'https://app.example' } = {}) {
  let taken = false
  fetchListener({ request: { url: `${origin}${path}`, method, mode, headers: new Headers() }, respondWith: p => { taken = true; p?.catch?.(() => {}) }, waitUntil() {}, clientId: '' })
  return taken
}

test('the hub\'s API on the app\'s own origin is left to the network: the stream, the reads, the writes', async () => {
  const on = await handler()
  for (const path of ['/v1/stream', '/v1/stream?after=12', '/v1/changes?after=0', '/v1/rooms/abc/challenge', '/v1/account'])
    assert.equal(answers(on, path), false, path)
  assert.equal(answers(on, '/v1/stream', { mode: 'navigate' }), false, 'even as a navigation')
  assert.equal(answers(on, '/v1/envelopes', { method: 'POST' }), false)
})

test('a hub on another origin is not touched', async () => {
  const on = await handler()
  assert.equal(answers(on, '/v1/stream', { origin: 'https://hub.example' }), false)
})

test('the app\'s files and pages are answered; any other address on the origin is not', async () => {
  const on = await handler()
  for (const path of SHELL) assert.equal(answers(on, path), true, path)
  assert.equal(answers(on, '/settings/account', { mode: 'navigate' }), true, 'a page of the app gets the shell')
  assert.equal(answers(on, '/att/0123456789abcdef0123456789abcdef'), true, 'an attachment, from an open page')
  for (const path of ['/healthz', '/something.json', '/frame', '/demo/x.json']) assert.equal(answers(on, path), false, path)
})
