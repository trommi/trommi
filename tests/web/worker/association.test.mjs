// app/web/worker.js and the iOS app's site association: `/.well-known/apple-app-site-association` answers
// public/apple-app-site-association.json itself, as JSON, with no redirect and never the app's page (the worker's
// single-page fallback), and the file's two blocks name the same apps: `applinks` (universal links) and
// `webcredentials` (the app may use the site's passkeys). The worker runs here as it is, in Node, with a stand-in for
// the one thing Cloudflare gives it: `env.ASSETS`, answered from public/ on disk, with the app's page for any
// address that is no file, as the deployed asset binding does.
//
//   node --test tests/web/worker/
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import worker, { SITE_ASSOCIATION } from '../../../app/web/worker.js'

const PUBLIC = new URL('../../../app/web/public/', import.meta.url)
const PAGE = '<!doctype html><title>the app\'s page</title>'
/** The asset binding: a file of public/ as it is, else the app's page (the single-page fallback). */
const ASSETS = {
  asked: [],
  async fetch(request) {
    const { pathname } = new URL(request.url)
    ASSETS.asked.push(pathname)
    const bytes = await readFile(new URL(`.${pathname}`, PUBLIC)).catch(() => null)
    return bytes && pathname !== '/' ? new Response(bytes, { headers: { 'Content-Type': 'application/octet-stream' } }) : new Response(PAGE, { headers: { 'Content-Type': 'text/html; charset=utf-8' } })
  },
}
const ask = (path, init) => worker.fetch(new Request(`https://app.trommi.com${path}`, init), { ASSETS })

test('the association address answers the JSON file: 200, application/json, no redirect, not the app\'s page', async () => {
  assert.equal(SITE_ASSOCIATION.address, '/.well-known/apple-app-site-association')
  const res = await ask(SITE_ASSOCIATION.address)
  assert.equal(res.status, 200)
  assert.equal(res.redirected, false)
  assert.equal(res.headers.get('location'), null)
  assert.equal(res.headers.get('content-type'), 'application/json')
  const body = await res.text()
  assert.notEqual(body, PAGE)
  assert.equal(body, await readFile(new URL('apple-app-site-association.json', PUBLIC), 'utf8'), 'the file of public/, byte for byte')
  assert.deepEqual(ASSETS.asked.at(-1), SITE_ASSOCIATION.file)
  const head = await ask(SITE_ASSOCIATION.address, { method: 'HEAD' })
  assert.deepEqual([head.status, head.headers.get('content-type')], [200, 'application/json'])
})

test('both blocks list the same apps; applinks keeps its paths', async () => {
  const json = await (await ask(SITE_ASSOCIATION.address)).json()
  assert.deepEqual(Object.keys(json).sort(), ['applinks', 'webcredentials'])
  const linked = json.applinks.details.flatMap(d => d.appIDs)
  assert.deepEqual(json.webcredentials, { apps: ['NL9YA3V25N.com.trommi.ios', 'NL9YA3V25N.XTL-70CB783D.com.trommi.ios'] })
  assert.deepEqual([...json.webcredentials.apps].sort(), [...linked].sort())
  assert.deepEqual(json.applinks.details[0].components.map(c => c['/']), ['/card/*', '/s/*', '/settings', '/settings/*'])
})

test('the stand-in does fall back to the app\'s page for another address: the check above is not empty', async () => {
  const res = await ask('/settings/account')
  assert.equal(res.headers.get('content-type'), 'text/html; charset=utf-8')
  assert.equal(await res.text(), PAGE)
})
