// A session's files (server/views/session.mjs filesChip, filesList, filesDrawer; card Nr. 204, "Zähler plus
// Seitenleiste"): called from server/turbo-test.mjs with that suite's hub and helpers. Only what no card shows is
// counted and listed (a card keeps its own pictures); the drawer's list comes as a frame, grouped by question or
// message, each with its Jump; /files is the conversation with the drawer open; the live stream keeps the list current.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export async function filesTests({ agent, tool, ask, get, stateOnce, eventually, listen }) {
  const id = agent.id, here = `/t/s/${id}`
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'turbo-files-'))
  const file = (name, bytes) => { const p = path.join(dir, name); fs.writeFileSync(p, bytes); return p }
  const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex')
  const count = async () => {
    const st = await stateOnce()
    const onCards = new Set(st.cards.filter(c => c.agent === id).flatMap(c => (c.attachments ?? []).map(a => a.url)))
    const seen = new Set()
    for (const m of st.messages) if (m.agent === id && m.from !== 'event') {
      if (m.asset) seen.add(`asset ${m.asset.id}`)
      for (const a of m.attachments ?? []) if (a?.url && !onCards.has(a.url)) seen.add(a.url)
    }
    return seen.size
  }
  try {
    // a question with its own picture, a message about it with a file, a message with a picture of its own
    const card = await ask('Mit Bild', { attachments: [file('karte.png', png)] })
    const cardPic = (await stateOnce()).cards.find(c => c.id === card).attachments[0].url
    await tool('reply', { text: 'Dazu die Tabelle.', card_id: card, attachments: [file('tabelle <x>.txt', 'a;b')] })
    await tool('reply', { text: 'Ein Bild für sich.', attachments: [file('lose.png', png)] })
    const n = await count()
    const msgs = (await stateOnce()).messages.filter(m => m.agent === id)
    const lone = msgs.findLast(m => m.text === 'Ein Bild für sich.')
    const about = msgs.findLast(m => m.text === 'Dazu die Tabelle.')

    // ---- the conversation: the chip beside the quiet line, the drawer closed, its frame empty ----
    let page = await (await get(here)).text()
    assert.match(page, new RegExp(`<p class="pane-now" id="session-now-${id}">.*<a class="files-chip" href="${here}/files" data-turbo-frame="files-frame-${id}" data-action="files#toggle" aria-controls="files-drawer-${id}"[^>]*>.*<span>${n} files</span></a></p>`))
    assert.match(page, new RegExp(`<main id="session" aria-label="[^"]*" data-controller="files" data-action="keydown@document->files#key click@document->files#outside">`))
    assert.match(page, new RegExp(`<aside class="files-drawer" id="files-drawer-${id}" data-files-target="drawer" aria-label="Files of this session" hidden><header class="files-head"><h3>Files</h3><a class="files-close" data-nav href="${here}" data-action="files#close"`))
    assert.match(page, new RegExp(`<turbo-frame class="files-frame" id="files-frame-${id}" target="_top" data-files-target="frame"></turbo-frame>`))
    // the filter menu: no Files as a filter; "Files (N)" stands there for the phone and opens the drawer
    assert.match(page, new RegExp(`<a href="${here}/files" data-nav id="filter-files" class="session-filter-files" data-turbo-frame="files-frame-${id}" data-action="files#open">.*?<span>Files \\(${n}\\)</span></a></nav>`))

    // ---- the frame: only the list, grouped, escaped, without the card's own picture ----
    let res = await get(`${here}/files`, { 'Turbo-Frame': `files-frame-${id}` })
    assert.equal(res.status, 200)
    let list = await res.text()
    assert.match(list, new RegExp(`^<turbo-frame id="files-frame-${id}" target="_top"><div class="files-list" id="session-files-${id}"><p class="files-sum">${n} files<span>`))
    assert.doesNotMatch(list, /<html|turbo-stream-source/)
    assert.ok(!list.includes(cardPic), 'a card keeps its own picture: not in the files')
    // the message about the question: under the question's number, its title a link to the card's page
    assert.match(list, new RegExp(`<a class="files-where" data-nav href="${here}/q/\\d+"><b>Nr\\. \\d+</b><span>Mit Bild</span></a><a class="files-jump" data-nav href="${here}[^"]*#msg-${about.id}" data-action="files#jump" data-files-msg-param="${about.id}">`))
    assert.match(list, /title="tabelle &lt;x&gt;\.txt"/)
    assert.doesNotMatch(list, /tabelle <x>/)
    // a picture of a message opens large at /files/<n>, its way back the message; the newest message's jump is plain
    assert.match(list, new RegExp(`<span class="files-where"><b>Agent · <time class="files-time"[^>]*>\\d\\d:\\d\\d</time></b><span>lose\\.png</span></span><a class="files-jump" data-nav href="${here}#msg-${lone.id}"`))
    assert.match(list, new RegExp(`<a class="files-thumb" data-nav href="${here}/files/\\d+\\?from=${lone.id}" title="lose\\.png"><img src="/files/\\w+\\.png[^"]*" alt="" loading="lazy" decoding="async" width="64" height="44"></a>`))
    // an older message's jump loads the window that ends with it
    assert.match(list, new RegExp(`href="${here}\\?before=\\w+#msg-${about.id}"`))

    // ---- /files as an address: the conversation with the drawer open and filled, no filter on ----
    page = await (await get(`${here}/files`)).text()
    assert.doesNotMatch(page, / data-filter=/)
    assert.match(page, / data-files-open>/)
    assert.match(page, /class="log"/)
    assert.match(page, new RegExp(`<aside class="files-drawer" id="files-drawer-${id}" data-files-target="drawer" aria-label="Files of this session"><header`))
    assert.match(page, new RegExp(`<turbo-frame class="files-frame" id="files-frame-${id}" target="_top" data-files-target="frame"><div class="files-list" id="session-files-${id}">`))
    assert.doesNotMatch(page, /session-filter-dot/)

    // ---- live: a new file changes the chip, the menu's count and the list ----
    const rev = /stream\?rev=([0-9a-f]+-\d+)/.exec(page)[1]
    const live = listen(`/t/stream?rev=${rev}&view=session&session=${id}&mode=files`)
    await eventually(() => live.heard.length > 0, 'the files stream to open')
    const mark = live.heard.length
    await tool('reply', { text: 'Noch eins.', attachments: [file('neu.png', png)] })
    await eventually(() => /target="session-files-/.test(live.since(mark)), 'the list on the stream')
    const frame = live.since(mark)
    assert.match(frame, new RegExp(`<turbo-stream action="replace" target="session-now-${id}"><template>.*<span>${n + 1} files</span>`, 's'))
    assert.match(frame, new RegExp(`<turbo-stream action="replace" target="session-filters-${id}"><template>.*Files \\(${n + 1}\\)`, 's'))
    assert.match(frame, new RegExp(`<turbo-stream action="replace" target="session-files-${id}"><template><div class="files-list" id="session-files-${id}"><p class="files-sum">${n + 1} files`))
    assert.match(frame, /title="neu\.png"/)
    assert.doesNotMatch(frame, /action="refresh"/)
    // (the question is closed again: the suites after this one count on the open ones they made)
    await tool('close_card', { card_id: card, summary: 'erledigt' })
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}
