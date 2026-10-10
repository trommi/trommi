// app/web/worker.js and the connector's install: the app serves no connector binaries and no plugin any more (the
// connector is a signed GitHub release, installed by install.sh); `/connect` still answers public/connect.sh as plain
// text, the older one-line way, which runs install.sh, `trommi-connector setup` and `connect`. The worker runs here in
// Node with a stand-in for `env.ASSETS` (as in association.test.mjs) and no R2 bucket.
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
const INSTALL = 'https://raw.githubusercontent.com/trommi/trommi/main/install.sh'

test('/connect answers connect.sh as plain text, and the script runs install.sh, setup and connect', async () => {
  const res = await ask('/connect')
  assert.equal(res.status, 200)
  assert.equal(res.headers.get('content-type'), 'text/plain; charset=utf-8')
  const script = await res.text()
  assert.equal(script, await readFile(new URL('connect.sh', PUBLIC), 'utf8'))
  assert.ok(script.includes(`INSTALL=${INSTALL}\n`), 'it downloads the connector\'s install.sh from the repository')
  assert.match(script, /"\$CONNECTOR" setup claude/)
  assert.match(script, /"\$CONNECTOR" setup codex/)
  assert.match(script, /TROMMI_INVITE="\$LINK" "\$CONNECTOR" connect/)
  assert.doesNotMatch(script, /\/plugins\/|\/connector\/|marketplace/, 'nothing of the old release addresses')
})

test('the old release addresses are gone: no release route, no R2 binding in wrangler.jsonc', async () => {
  // a file address that is not in public/ is a 404; any other address is the app's page, never a release file
  const json = await ask('/plugins/marketplace.json')
  assert.equal(json.status, 404)
  assert.notEqual(await json.text(), PAGE)
  for (const path of ['/connector/release-key.pub', '/connector/trommi-connector-x86_64-unknown-linux-musl.sha256']) assert.equal(await (await ask(path)).text(), PAGE, path)
  const source = await readFile(new URL('../worker.js', PUBLIC), 'utf8')
  assert.doesNotMatch(source, /RELEASES|releaseKey/)
  const config = await readFile(new URL('../wrangler.jsonc', PUBLIC), 'utf8')
  assert.doesNotMatch(config, /r2_buckets|RELEASES/)
})
