// The card of an artifact a session published (server/views/session.mjs assetCard), card Nr. 197: always a picture
// of it, "Artifact · kind · size", Open and one Copy link that releases the outside link (controller "share"), no
// separate Share or panel; "Shared · Stop" while a release stands. Run alone: node server/turbo-asset-test.mjs
import assert from 'node:assert/strict'
import { assetCard } from './views/session.mjs'

const key = 'k'.repeat(43), id = 'A'.repeat(22)
const url = `/a/${id}#${key}`
const card = (asset, assets = [], outside = 'https://board.example') => String(assetCard({ id, url, title: 'Plan <b>', note: 'Eine Zeile', size: 47000, ...asset }, '', assets, outside))

// a picture: the preview decrypts it (assetthumb), the drawn kind stands until then
let out = card({ type: 'image' })
assert.match(out, /<div class="asset-card has-preview" data-controller="share" data-share-id-value="A{22}" data-share-key-value="k{43}"/)
assert.match(out, new RegExp(`<a class="asset-preview" data-kind="image" href="/a/${id}#${key}" target="_blank" rel="noopener" tabindex="-1" aria-hidden="true" data-controller="assetthumb" data-assetthumb-kind-value="image"><svg viewBox="0 0 24 24" class="asset-glyph"`))
assert.match(out, /<span class="caps">Artifact · Picture · 47 kB<\/span><strong>Plan &lt;b&gt;<\/strong><span class="asset-note">Eine Zeile<\/span>/)
assert.match(out, /<a class="asset-open" href="\/a\/A{22}#k{43}" target="_blank" rel="noopener">Open<\/a><button type="button" class="asset-copy" data-action="share#copy" data-share-target="copy"[^>]*>Copy link<\/button><\/div>/)
// one action besides Open: no Share button, no panel, no second copy controller
assert.doesNotMatch(out, /asset-share|data-controller="copy"|>Share</)
assert.doesNotMatch(out, /data-share-link-value|asset-shared/)
assert.doesNotMatch(out, /Plan <b>/)

// a page: its first screen (assetthumb) and a quiet "Page" on it
out = card({ type: 'html' })
assert.match(out, /data-kind="html"[^>]*data-assetthumb-kind-value="html">.*<span class="asset-page-label">Page<\/span><\/a>/)
assert.match(out, /Artifact · Page · 47 kB/)

// any other kind: always a picture, the drawn kind; nothing to decrypt
for (const [type, label] of [['video', 'Video'], ['audio', 'Audio'], ['file', 'File'], ['weird', 'File']]) {
  out = card({ type })
  assert.match(out, new RegExp(`<a class="asset-preview" data-kind="${type === 'weird' ? 'file' : type}"[^>]*aria-hidden="true"><svg `))
  assert.doesNotMatch(out, /assetthumb/)
  assert.match(out, new RegExp(`Artifact · ${label} · 47 kB`))
}

// released: the card holds the outside link, says so quietly and can stop it
const now = Date.now()
out = card({ type: 'image' }, [{ id, share: { at: now, expires: null, opens: 2 } }])
assert.match(out, new RegExp(`data-share-link-value="https://board.example/r/${id}#${key}"`))
assert.match(out, /<span class="asset-shared" title="Anyone with the link can open it, without a login. Opened 2 times.">Shared · <button type="button" class="asset-stop" data-action="share#stop">Stop<\/button><\/span>/)
// a release that ran out is none: copying releases it again
out = card({ type: 'image' }, [{ id, share: { at: now - 9e6, expires: now - 1000, opens: 0 } }])
assert.doesNotMatch(out, /data-share-link-value|asset-shared/)

// without a key there is nothing to decrypt or release: the card still has its picture and copies the link it holds
out = String(assetCard({ id, url: `/a/${id}`, title: 'X', type: 'image', size: 10 }, '', [], ''))
assert.match(out, /data-share-key-value=""/)
assert.doesNotMatch(out, /assetthumb/)
assert.match(out, /class="asset-glyph"/)

// gone: the picture of its kind, faded, and why
out = String(assetCard({ id, gone: true, title: 'Alt', type: 'html' }, '', [], ''))
assert.match(out, /<div class="asset-card has-preview is-gone"><span class="asset-preview" data-kind="html"><svg[^]*<span class="caps">Artifact · Page<\/span><strong>Alt<\/strong><span class="asset-note">No longer available.<\/span>/)
assert.doesNotMatch(out, /asset-open|asset-copy/)

console.log('turbo asset card: ok')
