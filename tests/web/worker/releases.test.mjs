// app/web/worker.js and the connector's install: the app serves no connector binaries, no plugin and no connect script
// (the connector is a signed GitHub release, installed by install.sh). The worker runs here in Node with a stand-in for
// `env.ASSETS` (as in association.test.mjs) and no R2 bucket.
//
//   node --test tests/web/worker/
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import worker from '../../../app/web/worker.js'

const PUBLIC = new URL('../../../app/web/public/', import.meta.url)
const PAGE = '<!doctype html><title>the app\'s page</title>'
const ASSETS = {
  async fetch(request) {
    const { pathname } = new URL(request.url)
    const bytes = await readFile(new URL(`.${pathname}`, PUBLIC)).catch(() => null)
    return bytes && pathname !== '/' ? new Response(bytes, { headers: { 'Content-Type': 'application/octet-stream' } }) : new Response(PAGE, { headers: { 'Content-Type': 'text/html; charset=utf-8' } })
  },
}
const ask = (path, init) => worker.fetch(new Request(`https://app.trommi.com${path}`, init), { ASSETS })

test('the old release addresses are gone: no release route, no connect script, no R2 binding in wrangler.jsonc', async () => {
  // a file address that is not in public/ is a 404; any other address is the app's page, never a release file
  const json = await ask('/plugins/marketplace.json')
  assert.equal(json.status, 404)
  assert.notEqual(await json.text(), PAGE)
  for (const path of ['/connector/release-key.pub', '/connector/trommi-connector-x86_64-unknown-linux-musl.sha256']) assert.equal(await (await ask(path)).text(), PAGE, path)
  assert.equal(await (await ask('/connect')).text(), PAGE, '/connect is the app\'s page, no script')
  const source = await readFile(new URL('../worker.js', PUBLIC), 'utf8')
  assert.doesNotMatch(source, /RELEASES|releaseKey|connect\.sh/)
  const config = await readFile(new URL('../wrangler.jsonc', PUBLIC), 'utf8')
  assert.doesNotMatch(config, /r2_buckets|RELEASES/)
})
