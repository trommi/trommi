// Sized variants of stored pictures (server/thumbs.mjs, server/views/picture.mjs): the size reader, the
// helper of the views, the route /files/<name>?w=… on the test hub, and the way back to the original when no
// tool is on the machine. Run by server/turbo-test.mjs on its hub; (worker F).
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import zlib from 'node:zlib'
import { imageSize, snap, createThumbs, WIDTHS } from './thumbs.mjs'
import { thumb, srcOf } from './views/picture.mjs'

// A PNG of noise (it does not compress, so the file is large), written without any tool.
function png(width, height) {
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type, 'latin1'), data]), out = Buffer.alloc(body.length + 8)
    out.writeUInt32BE(data.length, 0); body.copy(out, 4); out.writeUInt32BE(zlib.crc32(body), body.length + 4)
    return out
  }
  const head = Buffer.alloc(13)
  head.writeUInt32BE(width, 0); head.writeUInt32BE(height, 4); head.set([8, 2, 0, 0, 0], 8)   // 8 bit RGB
  const rows = Buffer.alloc(height * (1 + width * 3))
  let seed = 7
  for (let i = 0; i < rows.length; i++) rows[i] = i % (1 + width * 3) === 0 ? 0 : (seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) >>> 24
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', head), chunk('IDAT', zlib.deflateSync(rows)), chunk('IEND', Buffer.alloc(0))])
}

function units() {
  // the size of a picture from its first bytes
  assert.deepEqual(imageSize(png(31, 17)), { width: 31, height: 17, type: 'png' })
  assert.deepEqual(imageSize(Buffer.concat([Buffer.from('GIF89a'), Buffer.from([0x40, 0x01, 0xf0, 0x00]), Buffer.alloc(20)])), { width: 320, height: 240, type: 'gif' })
  const riff = (kind, body) => Buffer.concat([Buffer.from('RIFF\0\0\0\0WEBP' + kind, 'latin1'), Buffer.alloc(4), body, Buffer.alloc(16)])
  assert.deepEqual(imageSize(riff('VP8 ', Buffer.from([0, 0, 0, 0x9d, 0x01, 0x2a, 0x40, 0x01, 0xf0, 0x00]))), { width: 320, height: 240, type: 'webp' })
  assert.deepEqual(imageSize(riff('VP8X', Buffer.from([0, 0, 0, 0, 0x3f, 0x01, 0x00, 0xef, 0x00, 0x00]))), { width: 320, height: 240, type: 'webp' })
  const lossless = Buffer.alloc(5); lossless[0] = 0x2f; lossless.writeUInt32LE((319) | (239 << 14), 1)
  assert.deepEqual(imageSize(riff('VP8L', lossless)), { width: 320, height: 240, type: 'webp' })
  // a JPEG: the frame header stands behind other blocks; an EXIF orientation of 6 turns the picture
  const seg = (marker, data) => Buffer.concat([Buffer.from([0xff, marker, (data.length + 2) >> 8, (data.length + 2) & 255]), data])
  const frame = seg(0xc2, Buffer.from([8, 0x00, 0xf0, 0x01, 0x40, 3, 0, 0, 0, 0, 0, 0, 0, 0, 0]))
  const exif = n => seg(0xe1, Buffer.concat([Buffer.from('Exif\0\0MM\0\x2a\0\0\0\x08\0\x01\x01\x12\0\x03\0\0\0\x01\0', 'latin1'), Buffer.from([n, 0, 0])]))
  assert.deepEqual(imageSize(Buffer.concat([Buffer.from([0xff, 0xd8]), seg(0xe0, Buffer.alloc(14)), seg(0xdb, Buffer.alloc(65)), frame])), { width: 320, height: 240, type: 'jpeg' })
  assert.deepEqual(imageSize(Buffer.concat([Buffer.from([0xff, 0xd8]), exif(6), frame])), { width: 240, height: 320, type: 'jpeg' })
  assert.deepEqual(imageSize(Buffer.concat([Buffer.from([0xff, 0xd8]), exif(1), frame])), { width: 320, height: 240, type: 'jpeg' })
  assert.equal(imageSize(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"/>')), null)
  assert.equal(imageSize(Buffer.alloc(4)), null)
  // only the fixed widths; anything else is the nearest
  assert.deepEqual([160, 1, 239, 241, 300, 500, 961, 99999, '320'].map(snap), [160, 160, 160, 320, 320, 640, 1280, 1280, 320])
  assert.deepEqual([null, '', 'abc', '320;rm'].map(snap), [null, null, null, null])
  // the helper of the views: the variant for a plain and for a dense screen, never larger than the picture needs
  const file = { url: '/files/abc123.png', width: 2000, height: 1000 }
  assert.deepEqual(thumb(file, 56), { src: '/files/abc123.png?w=160', srcset: '', width: 56, height: 28 })
  assert.deepEqual(thumb(file, 320), { src: '/files/abc123.png?w=320', srcset: '/files/abc123.png?w=320 1x, /files/abc123.png?w=640 2x', width: 320, height: 160 })
  assert.deepEqual(thumb(file, 1280), { src: '/files/abc123.png?w=1280', srcset: '/files/abc123.png?w=1280 1x, /files/abc123.png 2x', width: 1280, height: 640 })
  assert.equal(thumb({ url: '/files/small.png', width: 400, height: 800 }, 1280).src, '/files/small.png?w=1280')   // the whole picture, only lighter
  assert.deepEqual(thumb({ url: '/files/small.png', width: 400, height: 800 }, 640), { src: '/files/small.png?w=640', srcset: '/files/small.png?w=640 1x, /files/small.png?w=1280 2x', width: 400, height: 800 })
  assert.deepEqual(thumb({ url: '/files/unknown.png' }, 320), { src: '/files/unknown.png', srcset: '', width: null, height: null })   // size not known: its own address
  assert.equal(thumb({ url: '/files/moves.gif', width: 500, height: 500 }, 160).src, '/files/moves.gif')
  assert.equal(thumb({ url: 'https://example.org/x.png', width: 500, height: 500 }, 160).src, 'https://example.org/x.png')
  assert.equal(String(srcOf({ url: '/files/a"b.png', width: 900, height: 900 }, 320)), ' src="/files/a&quot;b.png?w=320" srcset="/files/a&quot;b.png?w=320 1x, /files/a&quot;b.png?w=640 2x"')
}

// Without a tool on the machine the route answers nothing, and the caller serves the original.
async function withoutTool() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'board-thumbs-'))
  const files = path.join(dir, 'files'), cache = path.join(dir, 'thumbs')
  fs.mkdirSync(files)
  fs.writeFileSync(path.join(files, 'pic.png'), png(400, 300))
  const serving = thumbs => http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x')
    if (await thumbs.serve(req, res, path.basename(url.pathname), url.searchParams.get('w'))) return
    res.writeHead(200, { 'Content-Type': 'image/png', 'X-Served': 'original' }); res.end(fs.readFileSync(path.join(files, 'pic.png')))
  })
  for (const tools of [[{ bin: 'board-no-such-tool', args: (src, type, w, out) => [src, out] }], []]) {
    const thumbs = createThumbs({ files, cache, tools })
    const server = serving(thumbs)
    await new Promise(go => server.listen(0, '127.0.0.1', go))
    try {
      const at = `http://127.0.0.1:${server.address().port}/pic.png?w=160`
      const [a, b] = await Promise.all([fetch(at), fetch(at)])
      for (const res of [a, b, await fetch(at)]) {
        assert.equal(res.status, 200)
        assert.equal(res.headers.get('x-served'), 'original')
        assert.equal(res.headers.get('content-type'), 'image/png')
        assert.equal((await res.arrayBuffer()).byteLength, fs.statSync(path.join(files, 'pic.png')).size)
      }
      assert.deepEqual(thumbs.tools(), [])                  // the missing tool is not started again
      assert.deepEqual(fs.readdirSync(cache), [])           // nothing half-made stays behind
    } finally { server.close() }
  }
  fs.rmSync(dir, { recursive: true, force: true })
}

export async function thumbsTests({ base, tool, get, cardOf }) {
  units()
  await withoutTool()

  // ---- on the hub: a card with a picture ----
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'board-thumbs-src-'))
  try {
    const src = path.join(dir, 'entwurf.png')
    fs.writeFileSync(src, png(800, 500))
    const id = (await tool('create_decision', { title: 'Mit Bild', options: [{ key: 'a', label: 'Ja' }, { key: 'b', label: 'Nein' }], attachments: [src] })).match(/^card (\w+) /)[1]
    const picture = (await cardOf(id)).attachments[0]
    // the record knows the picture's own size
    assert.equal(picture.width, 800)
    assert.equal(picture.height, 500)
    assert.match(picture.url, /^\/files\/[\w-]+\.png$/)
    // the Desk's row and the card's page ask for the small copy
    assert.ok((await (await get('/t/')).text()).includes(`<img src="${picture.url}?w=160" alt="" loading="lazy" decoding="async" width="56" height="42">`))
    assert.ok((await (await get(`/t/q/${id}`)).text()).includes(`src="${picture.url}?w=640"`))
    // behind the login, like the file itself
    assert.equal((await fetch(`${base}${picture.url}?w=320`)).status, 401)
    assert.equal((await fetch(`${base}${picture.url}`)).status, 401)
    const original = await get(picture.url)
    const full = Buffer.from(await original.arrayBuffer())
    assert.equal(original.headers.get('content-type'), 'image/png')
    assert.equal(full.length, fs.statSync(src).size)
    // several requests at once for the same variant
    const answers = await Promise.all([320, 320, 320].map(w => get(`${picture.url}?w=${w}`)))
    const bodies = await Promise.all(answers.map(async r => Buffer.from(await r.arrayBuffer())))
    const made = answers[0].headers.get('content-type') === 'image/webp'
    if (made) {
      for (const [i, res] of answers.entries()) {
        assert.equal(res.status, 200)
        assert.equal(res.headers.get('content-type'), 'image/webp')
        assert.equal(res.headers.get('cache-control'), 'private, max-age=604800, immutable')
        assert.equal(res.headers.get('x-content-type-options'), 'nosniff')
        assert.ok(res.headers.get('etag'))
        assert.deepEqual(imageSize(bodies[i]), { width: 320, height: 200, type: 'webp' })   // the asked width, the picture's ratio
        assert.ok(bodies[i].equals(bodies[0]))
      }
      assert.ok(bodies[0].length < full.length / 4, `the variant (${bodies[0].length} bytes) is much smaller than the original (${full.length})`)
      assert.equal(Number(answers[0].headers.get('content-length')), bodies[0].length)
      // an unknown width is the nearest allowed one: the same variant
      for (const w of [300, 399, '320.4']) {
        const res = await get(`${picture.url}?w=${w}`)
        assert.equal(res.headers.get('etag'), answers[0].headers.get('etag'))
        assert.ok(Buffer.from(await res.arrayBuffer()).equals(bodies[0]))
      }
      assert.equal(imageSize(Buffer.from(await (await get(`${picture.url}?w=1`)).arrayBuffer())).width, WIDTHS[0])
      // never larger than the picture itself
      assert.deepEqual(imageSize(Buffer.from(await (await get(`${picture.url}?w=5000`)).arrayBuffer())), { width: 800, height: 500, type: 'webp' })
      // the browser's copy is still good: nothing is sent again
      const again = await get(`${picture.url}?w=320`, { 'If-None-Match': answers[0].headers.get('etag') })
      assert.equal(again.status, 304)
      assert.equal((await again.arrayBuffer()).byteLength, 0)
    } else {
      // No vipsthumbnail and no magick on this machine: every request got the original, with the original's headers.
      console.log('note: turbo thumbnails: no tool on this machine (vipsthumbnail, magick); only the way back to the original was checked')
      for (const [i, res] of answers.entries()) { assert.equal(res.headers.get('content-type'), 'image/png'); assert.ok(bodies[i].equals(full)) }
    }
    // what is no width, no stored picture, or not there: the original's answer, never a tool
    const plain = await get(`${picture.url}?w=abc`)
    assert.equal(plain.headers.get('content-type'), 'image/png')
    assert.equal(plain.headers.get('cache-control'), 'private, max-age=604800, immutable')
    assert.equal((await plain.arrayBuffer()).byteLength, full.length)
    assert.equal((await get('/files/nothing-here.png?w=320')).status, 404)
    assert.equal((await get(`/files/..%2F..%2Fstate.json?w=320`)).status, 404)
    assert.equal((await get(`/files/$(id).png?w=320`)).status, 404)
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
}
