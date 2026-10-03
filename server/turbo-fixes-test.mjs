// Fixes from the code review of the server-rendered board, called from server/turbo-test.mjs with that suite's hub
// and helpers: the revised stamp travels with the live options, a version before stays read-only, the "N more" of
// every stack, and a page that stops reading its stream is held back and let go.
import assert from 'node:assert/strict'
import net from 'node:net'

const sleep = ms => new Promise(r => setTimeout(r, ms))

export async function fixesTests({ base, cookie, tool, ask, get, post, STREAM, cardOf, eventually, listen, clogMs }) {
  const revOf = async () => /stream\?rev=([0-9a-f]+-\d+)/.exec(await (await get('/t/')).text())[1]

  // ---- the revised stamp stands with the options, so a rewrite brings the new one along ----
  const id = await ask('Stempel prüfen')
  const nr = (await cardOf(id)).number
  const live = listen(`/t/stream?rev=${await revOf()}&view=card&card=${id}`)
  const old = listen(`/t/stream?rev=${await revOf()}&view=card&card=${id}&old=1`)
  await eventually(() => live.heard.length > 0 && old.heard.length > 0, 'the two card streams')
  const mark = live.heard.length, oldMark = old.heard.length
  await tool('revise_card', { card_id: id, title: 'Stempel neu', options: [{ key: 'a', label: 'Ja' }, { key: 'c', label: 'Neu' }] })
  const stamp = (await cardOf(id)).revised
  await eventually(() => live.since(mark).includes(`target="card-answer-${id}"`), 'the new options on the stream')
  assert.ok(live.since(mark).includes(`<input type="hidden" name="revised" value="${stamp}" form="card-form-${id}">`), `the new stamp comes with the new options: ${stamp} ${live.since(mark).slice(0, 1500)}`)
  // the page answers the newly shown option with that stamp: taken
  await sleep(300)   // (an answer right after a rewrite is refused for a moment)
  let res = await post(`/t/cards/${id}/decide`, { key: 'c', revised: String(stamp) })
  assert.equal(res.status, 303)
  assert.equal((await cardOf(id)).choice, 'c')

  // ---- a version before (?v=n) is read-only: its stream says so and gets no live face or options ----
  let page = await (await get(`/t/q/${nr}?v=1`)).text()
  assert.match(page, new RegExp(`src="/t/stream\\?rev=[\\w-]+(&amp;|&)view=card(&amp;|&)(bar=1(&amp;|&))?card=${id}(&amp;|&)old=1"`))
  page = await (await get(`/t/q/${nr}`)).text()
  assert.doesNotMatch(page, /&old=|&amp;old=/)
  await sleep(150)
  assert.doesNotMatch(old.since(oldMark), new RegExp(`target="card-(lead|body|answer)-${id}"`))

  // ---- every stack's "N more" leads to the whole stack, not only Later and Done ----
  for (let i = 0; i < 2; i++) await post(`/t/cards/${await ask(`Weg ${i}`)}/shred`, {})
  page = await (await get('/t/?pile=trash')).text()
  assert.match(page, /<section class="[^"]*inbox-group-trash is-open[^"]*" data-stack="trash"/)
  page = await (await get('/t/?pile=bogus')).text()
  assert.doesNotMatch(page, /is-open" data-stack=/)

  // ---- a page that stops reading is not written to while clogged, and is let go when it stays so ----
  const slow = await ask('Langsamer Leser')
  const socket = net.connect(new URL(base).port, '127.0.0.1')
  await new Promise(r => socket.once('connect', r))
  let bytes = 0, ended = false
  socket.on('data', c => { bytes += c.length })
  socket.on('close', () => { ended = true })
  socket.on('error', () => {})
  socket.write(`GET /t/stream?rev=${await revOf()}&view=card&card=${slow} HTTP/1.1\r\nHost: 127.0.0.1\r\nCookie: ${cookie}\r\n\r\n`)
  await eventually(() => bytes > 0, 'the slow stream to open')
  socket.pause()
  // a second one stops reading too, but only for a while: once it reads again it is told to fetch itself anew
  const nap = net.connect(new URL(base).port, '127.0.0.1')
  await new Promise(r => nap.once('connect', r))
  let napped = ''
  nap.setEncoding('utf8')
  nap.on('data', c => { napped += c })
  nap.on('error', () => {})
  nap.write(`GET /t/stream?rev=${await revOf()}&view=card&card=${slow} HTTP/1.1\r\nHost: 127.0.0.1\r\nCookie: ${cookie}\r\n\r\n`)
  await eventually(() => napped.length > 0, 'the napping stream to open')
  nap.pause()
  const t0 = Date.now()
  // every message grows the card's feed, and the feed is sent whole: far more than the socket's buffers hold
  const big = 'x'.repeat(200000)
  let sent = 0
  for (let i = 0; i < 25; i++) {
    await post(`/t/cards/${slow}/message`, { note: `${i} ${big}` }, STREAM)
    sent += 200000 * (i + 1)
  }
  assert.ok(Date.now() - t0 < clogMs - 500, `the flood took ${Date.now() - t0} ms, longer than the test's clog time`)
  nap.resume()
  await eventually(() => napped.includes('<turbo-stream action="refresh"></turbo-stream>'), 'the refresh after catching up')
  nap.destroy()
  await sleep(clogMs + 200)
  await post(`/t/cards/${slow}/message`, { note: 'noch eins' }, STREAM)   // the next change finds it clogged too long
  socket.resume()
  await eventually(() => ended, 'the clogged stream to be let go')
  assert.ok(bytes < sent / 3, `held back: ${bytes} bytes of ${sent}`)
  // a reading page goes on as before
  const fresh = listen(`/t/stream?rev=${await revOf()}&view=card&card=${slow}`)
  await eventually(() => fresh.heard.length > 0, 'a new stream')
  const at = fresh.heard.length
  await post(`/t/cards/${slow}/message`, { note: 'danach' }, STREAM)
  await eventually(() => fresh.since(at).includes(`target="card-thread-${slow}"`), 'the feed on the new stream')
}
