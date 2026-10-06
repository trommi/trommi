// A session's page: its heading, the conversation, the composer, the filter ("Questions only"), the
// files drawer and a picture as a page of its own. The markup is the one app.css and session.css style (the old
// client built it in js/chat.js, js/beside.js, js/history.js and app.js paintTitle); what is new stands in
// app.css under "the session page".
//
//   GET  <base>/s/<id>                  the conversation: the latest PAGE messages; ?before=<message> the ones before
//                                       that one (the "Earlier" link at the top loads them into a Turbo Frame)
//   GET  <base>/s/<id>?only=questions   its questions only
//   GET  <base>/s/<id>/files            the conversation with the files drawer open; asked from the drawer's frame
//                                       (header Turbo-Frame), only the drawer's list
//   GET  <base>/s/<id>/files/<n>        one picture, large (n counts the session's pictures, the oldest is 1)
//   POST <base>/s/<id>/message          the composer: text, files, copied cards (a FormData of this page)
//
// Windowed: the conversation in memory is the newest page(s) of the session's timeline (the core loads 50 at a time)
// and what the heads say about its questions. Only what is at least as new as the oldest loaded item of the
// session's own chat is shown (the "floor"), so paging up never leaves holes; "Earlier" first shows what memory
// holds, then asks the core for the next older page (t.hub.loadOlder).
//
// A question never unfolds here: an open one stands in the conversation as its Desk row, whose text links to the
// card's page; every other one is a quiet line that links there too.
import { BASE, UNHEARD_MS, blockedOf, linkOf, quietOf } from './app.mjs'
import { Controller, WORDS, advisedLabels, agoSpan, assetGlyph, controller, copyText, deskRow, handSvg, html, kindOf, linkNote, mq, pageChip, raw, rich, ringSvg, runSection, sessionHeadEdit, sk, srcOf, thumb, toast } from './ui.mjs'
const LIVE = 80               // so many of the newest messages are kept up to date by the live stream
const PAGE = 40               // messages of one render: the page shows the latest, "Earlier" (or scrolling up) brings as many again
const GROUP_GAP = 5 * 60000          // messages of one side closer than this stand as one run
const WORKING_WINDOW = 10 * 60000    // so long after the human's last word the session counts as answering
const MAX_FILES = 12                 // as the hub takes them in one message

// ---- small pieces ----
const ICONS = {
  asked: ['M12 3.5a8.5 8.5 0 1 0 0 17 8.5 8.5 0 0 0 0-17z', 'M9.6 9.7a2.5 2.5 0 1 1 3.7 2.2c-.8.45-1.3 1-1.3 1.9', 'M12 16.7v.1'],
  decided: ['M5 12.5l4.5 4.5L19 7.5'],
  done: ['M2.5 12.5l4 4 8-9', 'M12 16l.5.5 9-9.5'],
  urgency: ['M13 3 5.5 13.5H11L10 21l8.5-10.5H13L13 3z'],
  reopened: ['M9 7 4.5 11.5 9 16', 'M4.5 11.5H14a5.5 5.5 0 0 1 0 11h-2'],
  prev: ['M14.5 5.5 8 12l6.5 6.5'],
  next: ['M9.5 5.5 16 12l-6.5 6.5'],
  file: ['M7 3.5h7l4.5 4.5V19a1.5 1.5 0 0 1-1.5 1.5H7A1.5 1.5 0 0 1 5.5 19V5A1.5 1.5 0 0 1 7 3.5z', 'M13.5 3.5V8.5H18.5'],
  external: ['M14 5h5v5', 'M19 5l-8 8', 'M11 6.5H6.5A1.5 1.5 0 0 0 5 8v9.5A1.5 1.5 0 0 0 6.5 19H16a1.5 1.5 0 0 0 1.5-1.5V13'],
  spark: ['M12 3.5c.7 4.5 4 7.8 8.5 8.5-4.5.7-7.8 4-8.5 8.5-.7-4.5-4-7.8-8.5-8.5 4.5-.7 7.8-4 8.5-8.5z'],
  send: ['M12 19V5M5.5 11.5 12 5l6.5 6.5'],
  down: ['M12 5v14M5.5 12.5 12 19l6.5-6.5'],
  close: ['M6 6l12 12M18 6 6 18'],
  filter: ['M4 5.5h16l-6.2 7.3v5.4l-3.6 1.8v-7.2L4 5.5z'],
  clip: ['M8 12.5l6.2-6.2a3 3 0 0 1 4.3 4.3l-7.6 7.6a5 5 0 0 1-7.1-7.1L11 3.9'],
  copy: ['M10.5 8.5h7a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2h-7a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2z', 'M15.5 5.5v-.5a2 2 0 0 0-2-2h-7a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2H7'],
}
const made = new Map()
const ico = (name, cls = 'ico') => raw(made.get(`${name} ${cls}`) ?? made.set(`${name} ${cls}`, `<svg viewBox="0 0 24 24" class="${cls}" aria-hidden="true">${(ICONS[name] ?? ICONS.asked).map(d => `<path d="${d}"/>`).join('')}</svg>`).get(`${name} ${cls}`))
const AGENT_MARK = html`<span class="agent-mark">${ico('spark')}</span>`

const two = n => String(n).padStart(2, '0')
const clock = ts => { const d = new Date(ts); return `${two(d.getHours())}:${two(d.getMinutes())}` }
const FULL = new Intl.DateTimeFormat('en-GB', { dateStyle: 'full', timeStyle: 'short' })
const DAY = new Intl.DateTimeFormat('en-GB', { weekday: 'long', day: 'numeric', month: 'long' })
const dayKey = ts => { const d = new Date(ts); return d.getFullYear() * 400 + d.getMonth() * 32 + d.getDate() }
function dayLabel(ts, now = Date.now()) {
  if (dayKey(ts) === dayKey(now)) return 'Today'
  if (dayKey(ts) === dayKey(now - 86400000)) return 'Yesterday'
  return DAY.format(ts)
}
const timeNode = (ts, cls) => html`<time class="${cls}" datetime="${new Date(ts).toISOString()}" title="${FULL.format(ts)}">${clock(ts)}</time>`
const sizeText = n => (n >= 1e6 ? `${(n / 1e6).toFixed(1)} MB` : n >= 1e3 ? `${Math.round(n / 1e3)} kB` : `${n} B`)

const sessionPath = (id, base) => `${base}/s/${encodeURIComponent(id)}`
const questionPath = (card, base) => `${sessionPath(card.agent, base)}/q/${encodeURIComponent(card.number ?? card.id)}`
const choiceLabel = card => { const keys = card.choices?.length ? card.choices : card.choice != null ? [card.choice] : []; return keys.map(key => (card.options ?? []).find(o => o.key === key)?.label ?? key).join(', ') }
const isPicture = a => kindOf(a) === 'image' && a.url

// ---- what a render of one session needs, worked out once ----
/** model: app.mjs. Returns null when the session is not on the board. */
function sessionOf(model, id, { floor = 0, more = false } = {}) {
  const agent = model.byAgent.get(id)
  if (!agent) return null
  const { state } = model
  const all = state.messagesOf ? state.messagesOf(id) : state.messages.filter(m => m.agent === id)
  let messages = floor > 0 ? all.filter(m => m.seq >= floor) : all
  const cards = state.cards.filter(c => c.agent === id)
  // An approval it waits for stands at the end of the conversation, as its Desk row (it has no thread of its own).
  const asks = model.fresh.filter(c => c.agent === id && c.kind === 'permission')
  if (asks.length) messages = [...messages, ...asks.map(c => ({ id: `p${c.id}`, seq: Number.MAX_SAFE_INTEGER - 1, agent: id, from: 'event', kind: 'asked', card_id: c.id, text: c.title, ts: c.created }))]
  // The session's pictures, oldest first: what it sent and was sent, then what its questions carry.
  const pictures = [], nr = new Map()
  const add = list => { for (const a of list ?? []) if (isPicture(a) && !nr.has(a.url)) { pictures.push(a); nr.set(a.url, pictures.length) } }
  for (const m of messages) add(m.attachments)
  for (const c of cards) add(c.attachments)
  // Where a question stands in the conversation: at the last time it was put there.
  const askAt = new Map()
  for (const m of messages) if (m.from === 'event' && m.kind === 'asked' && m.card_id) askAt.set(m.card_id, m.id)
  const fresh = model.open.filter(c => c.agent === id && !c.with_agent)   // (its infos too: on its own page they stand as rows)
  return { id, agent, model, messages, cards, pictures, nr, askAt, fresh, tasks: state.tasks.filter(t => t.agent === id), floor, more }
}

// ---- attachments ----
function attachments(list, s, base, from) {
  list = (list ?? []).filter(a => a?.url)
  const media = list.filter(a => kindOf(a) === 'video' || kindOf(a) === 'audio')
  const images = list.filter(isPicture)
  const files = list.filter(a => kindOf(a) === 'file')
  return html`${media.map(a => (kindOf(a) === 'video'
    ? html`<figure class="media media-video"><video src="${a.url}#t=0.001" controls preload="metadata" playsinline></video><figcaption>${a.name}</figcaption></figure>`
    : html`<figure class="media media-audio"><audio src="${a.url}" controls preload="metadata"></audio><figcaption>${a.name}</figcaption></figure>`))}${images.length ? html`<div class="shots${images.length === 1 ? ' shots-one' : ''}">${images.map(a => html`<a class="shot" data-nav href="${sessionPath(s.id, base)}/files/${s.nr.get(a.url) ?? 1}?from=${from}" aria-label="Enlarge ${a.name}"><img${srcOf(a, images.length === 1 ? 416 : 272)} alt="${a.name}" loading="lazy" decoding="async" width="320" height="240"></a>${pageChip(a.page)}`)}</div>` : ''}${files.length ? html`<div class="files">${files.map(a => html`<a class="file-chip" href="${a.url}" target="_blank" rel="noopener">${ico('file')}<span>${a.name}</span></a>`)}</div>` : ''}`
}

// ---- one line for something that happened to a question ----
const EVENT_LABEL = { asked: 'New question', decided: 'Answered', done: 'Done', urgency: 'Urgency', reopened: 'Taken back', revised: 'Question revised', trusted: WORDS.trust, snoozed: WORDS.later, handed: 'With the agent', shredded: 'Shredded' }
function eventLine({ id, kind, text, ts }, card, base, { cont = false, echo = false, wrap = false } = {}) {
  const cls = `event event-${/^[a-z_]+$/.test(kind ?? '') ? kind : 'board'}${cont ? ' cont' : ''}${echo ? ' event-echo' : ''}`
  const inner = html`<span class="event-ico">${ico(ICONS[kind] ? kind : 'asked')}</span><span class="event-body"><span class="event-kind">${EVENT_LABEL[kind] ?? 'Board'}</span>${card && (card.title !== text || !text) ? html`<span class="event-about">${card.title}</span>` : ''}${text ? html`<span class="event-text">${text}</span>` : ''}</span>${timeNode(ts, 'event-time')}`
  const at = wrap ? '' : html` id="msg-${id}"`
  return card ? html`<a class="${cls}"${at} data-nav href="${questionPath(card, base)}" title="Nr. ${card.number}: open it">${inner}</a>` : html`<div class="${cls}"${at}>${inner}</div>`
}

// A question where it was asked. Open and waiting for the human: its Desk row (the tiles answer, the text links to
// the card's page). Anything else: one quiet line saying what became of it, a link to the card's page.
function ask(m, s, base) {
  const { model } = s
  const card = model.byCard.get(m.card_id)
  if (!card) return eventLine(m, null, base)
  const here = s.askAt.get(card.id) === m.id
  if (here && s.fresh.includes(card)) {
    // (The row's own links go to <base>/q/<n>; inside a session they keep the session in the address.)
    const row = String(deskRow(card, model, base)).replaceAll(`href="${base}/q/`, `href="${sessionPath(s.id, base)}/q/`)
    return html`<div class="ask ask-card" id="msg-${m.id}">${raw(row)}</div>`
  }
  const over = card.status !== 'open'
  const [kind, text] = !here ? ['asked', '']
    : card.status === 'decided' || card.settled ? [card.trusted ? 'trusted' : 'decided', choiceLabel(card) || (card.trusted ? advisedLabels(card) || 'your call' : '')]
    : card.status === 'shredded' ? ['shredded', '']
    : over ? ['done', card.summary ?? '']
    : card.with_agent ? ['handed', ''] : ['snoozed', '']
  return html`<div class="ask" id="msg-${m.id}">${eventLine({ kind, text: text === card.title ? '' : text, ts: m.ts }, { ...card, title: card.title || m.text }, base, { wrap: true })}</div>`
}

// Something the session published (a published object, announced in its conversation): the card shows a picture
// of it (a picture itself; a page's first screen, drawn by controller "assetthumb" in the sandboxed frame), what it
// is, Open (the app's own viewer, /s/<id>/a/<object>) and "Copy link": that address, for the people of this room.
// (The contents are end-to-end encrypted; a link for someone outside the room needs a release the hub does not have.)
const ASSET_LABEL = { html: 'Page', image: 'Picture', video: 'Video', audio: 'Audio', file: 'File' }
const assetPath = (s, id, base) => `${sessionPath(s.id, base)}/a/${id}`
/** The published object a message announces, or a stand-in when it was taken back (or is not known here). */
function assetOf(m, s) {
  const found = s.model.state.assets.find(a => a.id === m.published)
  if (found) return found
  const title = String(m.text ?? '').split('\n')[0].replace(/^\*\*(.*)\*\*$/, '$1').trim()
  return { id: m.published, gone: true, type: 'file', title }
}
/** A preview: a picture as itself (decrypted when it comes into view), a page by controller "assetthumb". */
const preview = (asset, type, inner = '') => (type === 'image' && asset.att?.url
  ? html`<img src="${asset.att.url}" alt="" loading="lazy" decoding="async">${inner}`
  : html`${assetGlyph(type)}${inner}`)
const thumbAttrs = (asset, type) => (type === 'html' && asset.att?.url ? html` data-controller="assetthumb" data-assetthumb-src-value="${asset.att.url}"` : '')
function assetCard(asset, s, base) {
  const type = ASSET_LABEL[asset.type] ? asset.type : 'file'
  const kind = ['Artifact', ASSET_LABEL[type], !asset.gone && asset.size ? sizeText(asset.size) : ''].filter(Boolean).join(' · ')
  if (asset.gone) return html`<div class="asset-slot"><div class="asset-card has-preview is-gone"><span class="asset-preview" data-kind="${type}">${assetGlyph(type)}</span><div class="asset-text"><span class="caps">${kind}</span><strong>${asset.title || 'Untitled'}</strong><span class="asset-note">No longer available.</span></div></div></div>`
  const view = assetPath(s, asset.id, base), title = asset.title || 'Untitled'
  return html`<div class="asset-slot"><div class="asset-card has-preview" data-controller="share" data-share-link-value="${view}" data-share-title-value="${title}"><a class="asset-preview${type === 'image' ? ' is-shown' : ''}" data-kind="${type}" data-nav href="${view}" tabindex="-1" aria-hidden="true"${thumbAttrs(asset, type)}>${preview(asset, type, type === 'html' ? raw('<span class="asset-page-label">Page</span>') : '')}</a><div class="asset-text"><span class="caps">${kind}</span><strong>${title}</strong>${asset.note ? html`<span class="asset-note">${asset.note}</span>` : ''}</div><div class="asset-actions"><a class="asset-open" data-nav href="${view}">Open</a><button type="button" class="asset-copy" data-action="share#copy" title="Copy a link to it: it opens for the people of this room">Copy link</button></div></div></div>`
}

/** The viewer: the published thing at its own address, as large as the page lets it be. */
function assetPage(s, asset, base, from = '') {
  const type = ASSET_LABEL[asset.type] ? asset.type : 'file'
  const back = from && s.messages.some(m => m.id === from) ? `${sessionPath(s.id, base)}#msg-${from}` : sessionPath(s.id, base)
  const arrow = raw('<svg viewBox="0 0 24 24" class="focus-icon" aria-hidden="true"><path d="M19 12H5M11 6l-6 6 6 6"/></svg>')
  const url = asset.att?.url ?? ''
  const stage = asset.gone || !url ? html`<p class="as-problem">This is no longer available.</p>`
    : type === 'html' ? html`<div class="as-frame-box" data-controller="assetthumb" data-assetthumb-src-value="${url}" data-assetthumb-full-value="true"><p class="as-wait">Opening the page…</p></div>`
      : type === 'image' ? html`<img class="as-media" src="${url}" alt="${asset.title}" decoding="async">`
        : type === 'video' ? html`<video class="as-media" src="${url}#t=0.001" controls playsinline preload="metadata"></video>`
          : type === 'audio' ? html`<audio class="as-media" src="${url}" controls preload="metadata"></audio>`
            : html`<div class="as-file"><span class="as-file-name">${asset.att?.name ?? asset.title}</span>${asset.size ? html`<span class="caps">${sizeText(asset.size)}</span>` : ''}<a class="as-btn" href="${url}" download="${asset.att?.name ?? ''}">Download</a></div>`
  return html`<div class="t-picture as-view" data-controller="share" data-share-link-value="${assetPath(s, asset.id, base)}" data-share-title-value="${asset.title || 'Untitled'}">
<header class="t-picture-bar"><a class="focus-back-desk t-picture-back" data-nav href="${back}" aria-label="Back to the conversation">${arrow}<span>${s.agent.name}</span></a><span class="t-picture-where"><b>${ASSET_LABEL[type]}</b> ${asset.title || 'Untitled'}</span>${asset.gone ? '' : html`<button type="button" class="asset-copy as-copy" data-action="share#copy" title="Copy a link to it: it opens for the people of this room">Copy link</button>`}</header>
${asset.note ? html`<p class="as-note">${asset.note}</p>` : ''}<div class="as-stage" data-type="${type}">${stage}</div>
</div>`
}

// The agent's words (ui.mjs rich), with its code blocks dressed: a head with the button that copies (controller "copy").
// (What rich() returns is escaped: a literal <pre><code> in it is one this code made.)
const CODE_HEAD = `<div class="code" data-controller="copy"><div class="code-head"><span class="code-lang">Code</span><button type="button" class="code-copy" data-action="copy#copy">${ico('copy')}<span data-copy-target="label">Copy</span></button></div><pre data-copy-target="source"><code>`
const words = (text, opts) => raw(String(rich(text, opts)).replaceAll('<pre><code>', CODE_HEAD).replaceAll('</code></pre>', '</code></pre></div>'))

// ---- one message ----
// Messages do not change once they are sent, so what was rendered is kept by the message's id (the board state makes
// new message objects after every change); only what can change (pending, the words once loaded) and what depends
// on something else (a question's state, a published link that was withdrawn, the card a message is about) is in the key.
const kept = new Map()
const OUTCOME = new Set(['decided', 'done', 'shredded'])
function message(m, prev, s, base) {
  if (m.from === 'event' && m.kind === 'asked') {
    // A question's line or row: made again only when its card changed (the board state keeps a card's object until then).
    const card = s.model.byCard.get(m.card_id), k = `${s.id} ${m.id}`, had = kept.get(k)
    const key = `${base}|${s.askAt.get(m.card_id) === m.id}|${s.fresh.includes(card)}|${m.ts}`
    if (had && had.card === card && had.key === key) return had.out
    const out = ask(m, s, base)
    kept.set(k, { card, key, out })
    return out
  }
  const cont = Boolean(prev && prev.from === m.from && dayKey(prev.ts) === dayKey(m.ts) && (m.from === 'event' || m.ts - prev.ts < GROUP_GAP))
  const about = m.card_id ? s.model.byCard.get(m.card_id) : null
  const firstPic = (m.attachments ?? []).find(isPicture)
  const key = `${m.note ? 'n' : ''}${m.pending ? 'p' : ''}|${m.text?.length ?? 0}|${m.attachments?.length ?? 0}|${m.ts}|${base}|${cont}|${about?.title ?? ''}|${about?.number ?? ''}|${m.published ? Boolean(s.model.state.assets.find(a => a.id === m.published)) : ''}|${firstPic ? s.nr.get(firstPic.url) : ''}|${m.from === 'event' && s.askAt.has(m.card_id)}`
  const k = `${s.id} ${m.id}`, had = kept.get(k)
  if (had?.key === key) return had.out
  const out = build(m, cont, about, s, base)
  if (kept.size > 20000) kept.clear()
  kept.set(k, { key, out })
  return out
}
function build(m, cont, about, s, base) {
  const assets = s.model.state.assets
  // What became of a question (answered, done, shredded) is said by its line where it was asked: the event is an echo.
  if (m.from === 'event') return eventLine(m, about, base, { cont, echo: OUTCOME.has(m.kind) && s.askAt.has(m.card_id) })
  const aboutNode = about ? html`<a class="msg-about" data-nav href="${questionPath(about, base)}"><span class="caps">About</span><span>${about.title}</span></a>` : ''
  // A note he sent from the Notes stack: in the conversation where it was sent, on his side, as the slip of yellow
  // paper it was, stuck on with one strip of tape (the one hand-made thing in a conversation). No bubble around it.
  if (m.from === 'user' && m.note) return html`<article class="msg msg-user msg-note-at" id="msg-${m.id}"><figure class="msg-note"><i class="msg-note-tape" aria-hidden="true"></i><figcaption class="msg-note-cap">${sk('page')}<span>Note</span>${m.note.written ? html`<span class="msg-note-when">written ${clock(m.note.written)}</span>` : ''}</figcaption><p>${m.text}</p>${attachments(m.attachments ?? [], s, base, m.id)}</figure>${timeNode(m.ts, 'msg-time')}</article>`
  if (m.from === 'user') {
    const list = m.attachments ?? []
    return html`<article class="msg msg-user${cont ? ' cont' : ''}" id="msg-${m.id}">${list.filter(a => a.kind === 'scribble' && a.url).map(a => html`<a class="scribble-card" href="${a.url}" target="_blank" rel="noopener" aria-label="Scribble sent: open the picture"><img${srcOf(a, 280)} alt="" loading="lazy" decoding="async" width="280" height="210"><span>Scribble</span></a>`)}${attachments(list.filter(a => a.kind !== 'scribble'), s, base, m.id)}${aboutNode}${m.cards?.length ? html`<div class="cardclip-row">${m.cards.map(c => html`<a class="cardclip-chip is-link" data-nav href="${sessionPath(s.id, base)}/q/${encodeURIComponent(c.number)}" title="Nr. ${c.number} · ${c.title}${c.choice_label ? ` → ${c.choice_label}` : ''}"><b>Nr. ${c.number}</b><span class="cardclip-title">${c.title}</span>${c.choice_label ? html`<span class="cardclip-answer">→ ${c.choice_label}</span>` : ''}</a>`)}</div>` : ''}${m.text ? html`<div class="bubble"><p>${m.text}</p></div>` : ''}${timeNode(m.ts, 'msg-time')}</article>`
  }
  // The agent's words (the light markdown; a layout fenced as html goes into the sandboxed frame, ui.mjs), with what it attached.
  const text = m.published ? assetCard(assetOf(m, s), s, base) : raw(String(words(m.text ?? '', { assets, extra: m.html ?? '' })).replace(/<\/div>$/, () => `${attachments(m.attachments, s, base, m.id)}</div>`))
  return html`<article class="msg msg-agent${cont ? ' cont' : ''}" id="msg-${m.id}"${cont ? html` title="${FULL.format(m.ts)}"` : ''}>${cont ? '' : html`<header class="msg-head">${AGENT_MARK}<span class="msg-name">Agent</span>${timeNode(m.ts, 'msg-time')}</header>`}${aboutNode}${text}${m.details ? html`<details class="msg-details"><summary>Details</summary>${words(m.details, { assets })}</details>` : ''}</article>`
}
const dayLine = ts => html`<div class="day" data-day="${ts}"><span>${dayLabel(ts)}</span></div>`

/** Every message of the session as it stands in the log: [{ id, day (a day line before it, or ''), node }]. */
/** The messages from index `from` to `to` (not included) as they stand in the log: [{ id, seq, day, node }]. */
function logItems(s, base, from = 0, to = s.messages.length) {
  const out = []
  for (let i = Math.max(0, from); i < to; i++) {
    const m = s.messages[i], prev = s.messages[i - 1]
    // (The oldest in memory while older ones exist: its day line comes with the page before it, see logWindow.)
    const day = !prev ? (s.more ? '' : dayLine(m.ts)) : dayKey(prev.ts) !== dayKey(m.ts) ? dayLine(m.ts) : ''
    out.push({ id: m.id, seq: m.seq ?? 0, day, node: message(m, prev, s, base) })
  }
  return out
}

// ---- the pieces of the page that change by themselves (each has an id; the live stream replaces it) ----
/** The session's drawing and name: the page's heading, on its own line at the page's top (session.css). */
/** A main session's small menu beside its name (his word, 6 October): three pen dots. "Move to other desk" lists the
 *  other desks, a click moves the session there (the human register session/<id>, as on the Agents page; its subs go
 *  with it; only while there is more than one desk). "Copy invite link again" makes an invite link for THIS session
 *  (auth.mjs /pair, continue=<session>): the connector that joins with it continues the session, the one that held it
 *  is retired. Not for a sub: it goes with its main. */
const DOTS = raw('<svg class="t-head-dots" viewBox="0 0 24 24" aria-hidden="true"><path d="M4.4 11.1Q5.9 9.9 7.2 11.3Q7.9 13.2 6.2 14Q4.3 14.2 3.9 12.6Q3.8 11.7 4.4 11.1Z"/><path d="M10.7 10.9Q12.4 10 13.5 11.4Q14 13.3 12.3 14Q10.5 14 10.1 12.4Q10.1 11.5 10.7 10.9Z"/><path d="M17 11.2Q18.5 10 19.8 11.2Q20.5 13 18.9 13.9Q17 14.2 16.5 12.7Q16.4 11.8 17 11.2Z"/></svg>')
function sessionMore(s, base) {
  const a = s.agent, desks = s.model.state.desks ?? []
  if (a.parent) return ''
  const others = desks.length < 2 ? [] : desks.filter(d => d.id !== a.desk)
  const move = d => html`<form method="post" action="${base}/sessions/${encodeURIComponent(a.id)}/edit"><input type="hidden" name="stay" value="1"><input type="hidden" name="moved" value="1"><input type="hidden" name="leave" value="1"><button type="submit" role="menuitem" name="desk" value="${d.id}">${sk('desk')}<span>${d.name || 'Desk'}</span></button></form>`
  return html`<details class="t-pick t-pick-desk"><summary class="t-head-desk t-head-more" title="More" aria-label="${a.name}: more">${DOTS}</summary>
<div class="desk-move t-pop" role="menu" aria-label="More for ${a.name}">${others.length ? html`<details class="desk-move-sub"><summary role="menuitem">${sk('desk')}<span>Move to other desk</span></summary>${others.map(move)}</details>` : ''}
<form method="post" action="/pair" data-turbo-frame="_top"><input type="hidden" name="role" value="agent"><input type="hidden" name="continue" value="${a.device_id}"><button type="submit" role="menuitem">${sk('key')}<span>Copy invite link again</span></button></form></div></details>`
}
function sessionWho(s, base) {
  const a = s.agent
  // The mark opens the drawings, the name renames (ui.mjs); the live stream brings what was changed.
  // The raised red hand when the session is really stopped (server/blocked.mjs), with the cause in words.
  const stopped = blockedOf(a, s.model.state), quiet = stopped ? null : quietOf(a, s.model.state)
  return html`<div class="pane-who" id="session-who-${a.id}"${a.main ? raw(' data-main') : ''}><h2 class="pane-name offscreen">${a.name}</h2>${sessionHeadEdit(a, base, { stay: true })}${sessionMore(s, base)}${stopped ? html`<span class="t-blocked" data-why="${stopped.why}" role="status" title="Stopped: ${stopped.text}">${raw(handSvg())}<span>Stopped: ${stopped.text}</span></span>` : quiet ? html`<span class="t-quiet" title="Connected and working, nothing new for a while">${quiet.text}</span>` : ''}</div>`
}
/** The quiet line under the name: what the session is at, its model and machine, and "N files" (the drawer). */
function sessionNow(s, base = '') {
  const a = s.agent
  // (A session that does not hear at once says so here; one that does says what it is at.)
  const link = linkOf(a)
  const words = link && link.state !== 'live' ? link.word : a.online ? a.task || 'connected' : 'disconnected'
  const facts = [a.model, a.host].filter(Boolean).join(' · ')
  return html`<p class="pane-now" id="session-now-${a.id}"${link && link.state !== 'live' ? html` data-link="${link.state}" title="${link.line}"` : ''}><span>${words}</span>${facts ? html`<span class="caps">${facts}</span>` : ''}${filesChip(s, base)}</p>`
}
/** The filter beside the composer: one quiet icon that opens a small menu, All / Questions only (with the number that
 *  waits) / Files, the one in view ticked; a dot on the icon while a filter is on. A <details> (controller "pops" closes
 *  it on Escape or a click beside it); the entries are real links, so it works without scripts. */
const FILTERS = [['', 'All messages', null], ['questions', 'Questions only', 'filter-questions'], ['files', 'Files', 'filter-files']]   // (Files: on a phone only, app.css; it opens the drawer)
function sessionFilters(s, base, mode = '') {
  const here = sessionPath(s.id, base)
  const href = { '': here, questions: `${here}?only=questions`, files: `${here}/files` }
  if (mode !== 'questions') mode = ''   // ("Files" is the conversation with the drawer open: no filter is on)
  const on = FILTERS.find(f => f[0] === mode) ?? FILTERS[0]
  const n = fileCount(s)
  return html`<details class="t-pick session-filter" id="session-filters-${s.id}"${mode ? raw(' data-on') : ''} data-controller="pops title" data-title-count-value="${s.fresh.length}"><summary class="session-filter-btn" title="Filter: ${on[1]}" aria-label="Filter the conversation: ${on[1]}">${ico('filter')}${mode ? raw('<i class="session-filter-dot"></i>') : ''}</summary><nav class="t-pop t-menu session-filter-menu" aria-label="Filter the conversation">${FILTERS.map(([m, label, id]) => m === 'files'
    ? (n ? html`<a href="${href[m]}" data-nav id="${id}" class="session-filter-files" data-turbo-frame="files-frame-${s.id}" data-action="files#open">${ico('clip', 'ico session-filter-tick')}<span>${label} (${n})</span></a>` : '')
    : html`<a href="${href[m]}" data-nav${id ? html` id="${id}"` : ''}${m === mode ? raw(' aria-current="true"') : ''}>${ico('decided', 'ico session-filter-tick')}<span>${label}</span>${m === 'questions' ? html`<b id="filter-count">${s.fresh.length || ''}</b>` : ''}</a>`)}</nav></details>`
}
/** The status lines of the session's running work, and that it is answering. They stand at the end of the conversation. */
function sessionStatus(s, base, now = Date.now()) {
  const last = s.messages.findLast(m => m.from !== 'event')
  const answering = last?.from === 'user' && now - last.ts < WORKING_WINDOW
  const lines = s.tasks.filter(t => t.state !== 'done' || now - (t.updated ?? 0) < WORKING_WINDOW)
  return html`<div class="session-status" id="session-status-${s.id}"${lines.length || answering ? '' : raw(' hidden')}>${answering ? html`<div class="working">${AGENT_MARK}<span>Agent is working</span><span class="dots"><i></i><i></i><i></i></span></div>` : ''}${lines.map(t => {
    const card = t.card_id ? s.model.byCard.get(t.card_id) : null
    const inner = html`<span class="status-mark">${t.state === 'working' ? raw(ringSvg({ drop: true })) : t.state === 'decision' ? sk('knock') : sk('tick')}</span><b>${t.label}</b>${t.detail ? html`<span class="status-detail">${t.detail}</span>` : ''}${t.updated ? agoSpan(t.updated, 'status-ago') : ''}`
    return card ? html`<a class="status-line" data-state="${t.state}" data-nav href="${questionPath(card, base)}">${inner}</a>` : html`<p class="status-line" data-state="${t.state}">${inner}</p>`
  })}</div>`
}
/** "N open": the questions of this session that wait, and the way to the first of them. */
function sessionOpen(s, base, shown = null) {
  const n = s.fresh.length
  const first = s.fresh.map(c => s.askAt.get(c.id)).find(id => id && (!shown || shown.has(id)))
  const href = first ? `#msg-${first}` : `${sessionPath(s.id, base)}?only=questions`
  return n ? html`<a class="open-jump" id="session-open-${s.id}" data-nav href="${href}"${first ? raw(' data-turbo="false" data-log-target="open" data-action="log#toOpen"') : ''} aria-label="${n === 1 ? 'One open question: go to it' : `${n} open questions: go to the first one`}"><span data-log-target="openText">${n} open</span>${ico('down')}</a>` : html`<span id="session-open-${s.id}" hidden></span>`
}

// ---- the conversation ----
/** The link that brings the messages before `first` (a Turbo Frame: only they are rendered). left: how many memory
 *  holds before them; more: the core has older ones still (loaded when the link is followed). The log controller
 *  follows it by itself when it comes near while scrolling up. */
function earlier(s, base, first, left, more = s.more) {
  return html`<turbo-frame class="log-earlier" id="earlier-${first}">${left || more ? html`<a class="log-earlier-link" data-nav href="${sessionPath(s.id, base)}?before=${first}" data-log-target="earlier">Earlier messages${left ? html`<b>${left}${more ? '+' : ''}</b>` : ''}</a>` : ''}</turbo-frame>`
}
/** A window of the log: the PAGE messages before `before` (a message id; null: the latest). */
function logWindow(s, base, before = null) {
  const total = s.messages.length
  const at = before == null ? -1 : s.messages.findIndex(m => m.id === before)
  // (An earlier window asked for a message memory no longer holds: nothing, rather than the latest a second time.)
  const end = before != null && at < 0 ? 0 : at < 0 ? total : at, start = Math.max(0, end - PAGE)
  const shown = logItems(s, base, start, end)   // only the window is rendered, however much memory holds
  // An earlier window ends where the one below it begins: the day line between them, when the day changes there.
  const next = before != null && at >= 0 ? s.messages[at] : null, last = s.messages[end - 1]
  const joint = next && last && dayKey(last.ts) !== dayKey(next.ts) ? dayLine(next.ts) : ''
  return { shown, start, end, total, body: html`${shown.length ? earlier(s, base, shown[0].id, start) : ''}${shown.map(i => html`${i.day}${i.node}`)}${joint}` }
}

// (The three starters are links: each brings the page again with its words in the field, ready to send or change.)
const STARTERS = ['Where do we stand?', 'What do you need from me?', 'Sum up what you did last.']
const empty = (s, base) => html`<div class="empty-chat"><span class="agent-mark agent-mark-lg">${ico('spark')}</span><h2>What should the agent start with?</h2><p>Tell it what to work on. When it needs something from you, it puts a question in front of you.</p><div class="empty-picks">${STARTERS.map(text => html`<a class="empty-pick" data-nav href="${sessionPath(s.id, base)}?say=${encodeURIComponent(text)}">${text}</a>`)}</div></div>`

/** The composer: a plain form. The island "composer" adds Enter to send, the field that grows, the list of chosen files. */
/** What the field says: when the session will read it, if not at once. */
function composeWords(s) {
  const link = linkOf(s.agent)
  if (link?.state === 'cut') return 'It cannot hear you right now. What you write waits for it'
  if (link?.state === 'gone') return 'It is gone. What you write waits for it'
  if (link?.state === 'asleep' || link?.state === 'oncall') return 'Reaches the agent on its next step'
  return 'Message to the agent'
}
/** Above the field: why the session does not hear (cut off, gone, not listening) and the step in its terminal, or that
 *  his last message was not picked up. Nothing for a session that hears, also on its next step. Its id stays for the stream. */
function sessionLink(s) {
  const a = s.agent, link = linkOf(a), id = `session-link-${s.id}`
  const mine = s.messages?.findLast?.(m => m.from === 'user' && Number.isSafeInteger(m.seq) && m.seq < Number.MAX_SAFE_INTEGER) ?? null
  const waits = mine && a.heard_up_to != null && mine.seq > a.heard_up_to && Date.now() - (mine.ts ?? 0) >= UNHEARD_MS
  const receipt = waits ? `${a.name} has not picked up your last message.` : ''
  if (link && ['cut', 'gone', 'asleep'].includes(link.state)) return linkNote(link, { receipt, id })
  if (waits) return linkNote({ state: 'unheard', fix: { say: 'Look at its terminal: type anything to wake it, or reconnect it with', code: '/mcp → trommi → Reconnect' } }, { receipt, sign: 'letter', tone: 'unheard', id })
  return html`<aside class="link-note" id="${id}" hidden></aside>`
}
function composer(s, base, { text = '', focus = false } = {}) {
  return html`<form class="composer" id="composer-${s.id}" method="post" action="${sessionPath(s.id, base)}/message" enctype="multipart/form-data" data-controller="composer" data-composer-agent-value="${s.id}"${focus ? raw(' data-composer-focus-value="true"') : ''} data-action="turbo:submit-start->composer#start turbo:submit-end->composer#sent click->composer#aim dragover@window->composer#over dragleave@window->composer#left drop@window->composer#drop">
<input type="hidden" name="stay" value="1">
<div class="composer-files" data-composer-target="chips"></div>
<label class="mic composer-clip" title="Attach a picture or a file">${sk('clip')}<input class="offscreen" type="file" name="files" multiple data-composer-target="picker" data-action="change->composer#paint" aria-label="Attach pictures or files (at most ${MAX_FILES})"></label>
<textarea name="text" id="composer-field-${s.id}" rows="1" data-composer-target="field" data-action="input->composer#typed keydown->composer#keys paste->composer#paste focus->composer#paint" autocomplete="off" enterkeyhint="enter" placeholder="${composeWords(s)}" aria-label="Message to ${s.agent.name}">${text}</textarea>
<button class="send" type="submit" aria-label="Send" data-composer-target="send">${ico('send')}</button>
</form>`
}
const sendError = (s, text = '') => html`<p class="send-error" id="session-error-${s.id}" role="alert"${text ? '' : raw(' hidden')}>${text}</p>`

// ---- the lists a filter shows in place of the conversation ----
/** The session's questions: what waits as Desk rows, then everything else as quiet lines, the newest first. */
function questionList(s, base) {
  const { model } = s
  const rest = s.cards.filter(c => !s.fresh.includes(c)).sort((a, b) => (b.decided ?? b.shredded ?? b.created ?? 0) - (a.decided ?? a.shredded ?? a.created ?? 0))
  const line = card => {
    const [kind, text] = card.status === 'decided' || card.settled ? [card.trusted ? 'trusted' : 'decided', choiceLabel(card)] : card.status === 'shredded' ? ['shredded', ''] : card.status !== 'open' ? ['done', card.summary ?? ''] : card.with_agent ? ['handed', ''] : ['snoozed', '']
    return eventLine({ kind, text: text === card.title ? '' : text, ts: card.decided ?? card.shredded ?? card.created ?? 0 }, card, base, { wrap: true, cont: true })
  }
  return html`<div class="session-cards" id="session-questions-${s.id}"><header class="inbox-head"><div class="inbox-title"><h2>${s.fresh.length ? (s.fresh.length === 1 ? '1 question waits for you' : `${s.fresh.length} questions wait for you`) : 'No question waits for you.'}</h2></div></header>
<div class="inbox-groups">${s.fresh.length ? runSection(s.agent, s.fresh.map(c => raw(String(deskRow(c, model, base)).replaceAll(`href="${base}/q/`, `href="${sessionPath(s.id, base)}/q/`))), s.fresh.length) : ''}</div>
${rest.length ? html`<h3 class="hist-heading"><span>Earlier questions</span><b>${rest.length}</b></h3><div class="session-past">${rest.map(line)}</div>` : ''}</div>`
}

// ---- the files: what the session sent and was sent that no card shows (a card shows its own pictures) ----
/** Groups, newest first: one per question its messages were about, one per message otherwise.
 *  [{ ts, card, from, msg (the newest message), next (the message after it, or null), items: [{ kind, type, name, url, n, a }] }] */
const looseKept = new WeakMap()
function looseFiles(s) {
  if (looseKept.has(s)) return looseKept.get(s)
  const onCards = new Set()
  for (const c of s.cards) for (const a of c.attachments ?? []) if (a?.url) onCards.add(a.url)
  const groups = new Map(), seen = new Set()
  s.messages.forEach((m, i) => {
    if (m.from === 'event') return
    const items = []
    if (m.published && !seen.has(`asset ${m.published}`)) {
      seen.add(`asset ${m.published}`)
      const asset = assetOf(m, s)
      items.push({ kind: 'asset', type: ASSET_LABEL[asset.type] ? asset.type : 'file', name: asset.title || 'Untitled', url: asset.gone ? null : asset.id, asset })
    }
    for (const a of m.published ? [] : m.attachments ?? []) {
      if (!a?.url || onCards.has(a.url) || seen.has(a.url)) continue
      seen.add(a.url)
      items.push({ kind: a.kind === 'scribble' ? 'scribble' : kindOf(a), name: a.name || 'Scribble', url: a.url, n: isPicture(a) ? s.nr.get(a.url) : null, a })
    }
    if (!items.length) return
    const card = m.card_id ? s.model.byCard.get(m.card_id) ?? null : null
    const key = card ? `card ${card.id}` : `msg ${m.id}`
    const g = groups.get(key)
    const next = s.messages[i + 1]?.id ?? null
    if (g) { g.items.unshift(...items); Object.assign(g, { ts: m.ts, msg: m.id, next, from: m.from }) }
    else groups.set(key, { ts: m.ts, card, from: m.from, msg: m.id, next, items })
  })
  const out = [...groups.values()].sort((x, y) => y.ts - x.ts)
  looseKept.set(s, out)
  return out
}
const fileCount = s => looseFiles(s).reduce((n, g) => n + g.items.length, 0)

/** "N files" beside the quiet line: opens the drawer (controller "files"); without scripts, the page with it open. */
function filesChip(s, base) {
  const n = fileCount(s)
  return n ? html`<a class="files-chip" href="${sessionPath(s.id, base)}/files" data-turbo-frame="files-frame-${s.id}" data-action="files#toggle" aria-controls="files-drawer-${s.id}" title="What was sent and published here, without the questions' own pictures">${ico('clip')}<span>${n === 1 ? '1 file' : `${n} files`}</span></a>` : ''
}

const FILE_GLYPH = { video: 'video', audio: 'audio', image: 'image', scribble: 'image' }
function fileThumb(item, s, base, msg) {
  if (item.kind === 'asset') {
    if (!item.url) return html`<span class="files-thumb asset-preview is-gone" data-kind="${item.type}" title="${item.name}: no longer available">${assetGlyph(item.type)}</span>`
    return html`<a class="files-thumb asset-preview${item.type === 'image' ? ' is-shown' : ''}" data-kind="${item.type}" data-nav href="${assetPath(s, item.asset.id, base)}" title="${item.name}"${thumbAttrs(item.asset, item.type)}>${preview(item.asset, item.type)}</a>`
  }
  if (item.kind === 'image' || item.kind === 'scribble') {
    const img = html`<img${srcOf(item.a, 64)} alt="" loading="lazy" decoding="async" width="64" height="44">`
    return item.n ? html`<a class="files-thumb" data-nav href="${sessionPath(s.id, base)}/files/${item.n}?from=${msg}" title="${item.name}">${img}</a>` : html`<a class="files-thumb" href="${item.url}" target="_blank" rel="noopener" title="${item.name}">${img}</a>`
  }
  return html`<a class="files-thumb asset-preview" data-kind="${item.kind}" href="${item.url}" target="_blank" rel="noopener" title="${item.name}">${assetGlyph(FILE_GLYPH[item.kind] ?? 'file')}</a>`
}

/** The drawer's list: a group per question or message, its pictures and files, and "Jump to" where it stands.
 *  The jump: scrolled to by the controller when the message is on the page; otherwise the window that ends with it. */
function filesList(s, base) {
  const here = sessionPath(s.id, base)
  const groups = looseFiles(s), n = fileCount(s)
  const jump = g => (g.next ? `${here}?before=${encodeURIComponent(g.next)}#msg-${g.msg}` : `${here}#msg-${g.msg}`)
  return html`<div class="files-list" id="session-files-${s.id}"><p class="files-sum">${n === 1 ? '1 file' : `${n} files`}<span> · the questions keep their own pictures</span></p>${groups.length ? groups.map(g => html`<section class="files-group"><div class="files-group-head">${g.card
    ? html`<a class="files-where" data-nav href="${questionPath(g.card, base)}"><b>Nr. ${g.card.number}</b><span>${g.card.title}</span></a>`
    : html`<span class="files-where"><b>${g.from === 'user' ? 'You' : 'Agent'} · ${timeNode(g.ts, 'files-time')}</b><span>${g.items.length === 1 ? g.items[0].name : `${g.items.length} files`}</span></span>`}<a class="files-jump" data-nav href="${jump(g)}" data-action="files#jump" data-files-msg-param="${g.msg}">Jump to${ico('next')}</a></div><div class="files-thumbs">${g.items.slice(0, 4).map(item => fileThumb(item, s, base, g.msg))}${g.items.length > 4 ? html`<span class="files-more">+${g.items.length - 4}</span>` : ''}</div></section>`) : html`<p class="files-empty">Nothing was sent here yet, besides the questions' own pictures.</p>`}</div>`
}

/** The drawer from the right (a sheet from below on a phone): its list is a lazy frame, loaded when it opens. */
function filesDrawer(s, base, open = false) {
  const here = sessionPath(s.id, base)
  return html`<aside class="files-drawer" id="files-drawer-${s.id}" data-files-target="drawer" aria-label="Files of this session"${open ? '' : raw(' hidden')}><header class="files-head"><h3>Files</h3><a class="files-close" data-nav href="${here}" data-action="files#close" aria-label="Close the files">${ico('close')}</a></header><turbo-frame class="files-frame" id="files-frame-${s.id}" target="_top" data-files-target="frame">${open ? filesList(s, base) : ''}</turbo-frame></aside>`
}

// ---- the page ----
/** mode: '' (the conversation) | 'questions' | 'files' (the conversation, the drawer open). before: a message id (the window before it). */
function sessionMain(s, base, { mode = '', before = null, error = '', text = '', focus = false } = {}) {
  let body, open = ''
  if (mode === 'questions') body = html`<div class="pane-list pane-questions"><div class="column">${questionList(s, base)}</div></div>`
  else {
    const w = logWindow(s, base, before)
    const latest = w.end === w.total
    // An earlier window stands in the frame its link named: Turbo takes that frame out of this page and puts it where the link was.
    const part = before != null && !latest ? html`<turbo-frame class="log-earlier" id="earlier-${before}">${w.body}</turbo-frame>` : w.body
    open = sessionOpen(s, base, new Set(w.shown.map(i => i.id)))
    body = html`<div class="log" tabindex="-1" data-log-target="log" data-action="scroll->log#scrolled"><div class="column log-inner" role="log" aria-live="polite" aria-relevant="additions">${w.total ? part : empty(s, base)}${latest ? html`<div id="log-end-${s.id}" hidden></div>${sessionStatus(s, base)}` : html`<a class="log-earlier-link is-later" data-nav href="${sessionPath(s.id, base)}">To the latest messages</a>`}</div></div>`
  }
  return html`<main id="session" aria-label="Session: ${s.agent.name}" data-controller="files" data-action="keydown@document->files#key click@document->files#outside"${mode === 'files' ? raw(' data-files-open') : ''}>
<header class="pane-title">${sessionWho(s, base)}${sessionNow(s, base)}</header>
<section id="chat" aria-label="Conversation"><div class="chat-pane" data-agent="${s.id}" data-controller="log">
<div class="chat-body">${body}</div>
<div class="dock">${mode === 'questions' ? '' : html`<button type="button" class="jump" hidden data-log-target="jump" data-action="log#toEnd">${ico('down')}<span data-log-target="jumpText">To the end</span></button>`}${open}<div class="column session-compose">${sendError(s, error)}${sessionLink(s)}${composer(s, base, { text, focus })}${sessionFilters(s, base, mode)}</div></div>
</div></section>
${filesDrawer(s, base, mode === 'files')}
</main>`
}

/** One picture of the session, large, at its own address. from: the message it was opened from (the way back). */
function sessionPicture(s, base, at, from = '') {
  const n = s.pictures.length, i = Math.min(Math.max(1, at), n), a = s.pictures[i - 1]
  const here = sessionPath(s.id, base), q = from ? `?from=${encodeURIComponent(from)}` : ''
  const back = from && s.messages.some(m => m.id === from) ? `${here}#msg-${from}` : `${here}/files`
  const arrow = d => raw(`<svg viewBox="0 0 24 24" class="focus-icon" aria-hidden="true"><path d="${d}"/></svg>`)
  return html`<div class="t-picture">
<header class="t-picture-bar"><a class="focus-back-desk t-picture-back" data-nav href="${back}" aria-label="Back to ${from ? 'the conversation' : 'the files'}">${arrow('M19 12H5M11 6l-6 6 6 6')}<span>${s.agent.name}</span></a><span class="t-picture-where"><b>${i} / ${n}</b> ${a.title || a.name}</span>${a.page ? pageChip(a.page) : html`<a class="page-chip" target="_blank" rel="noopener noreferrer" href="${a.url}">${sk('picture')}<b>${a.name}</b><i>open</i></a>`}</header>
<a class="t-picture-view" data-nav href="${back}" aria-label="Close the picture"><img src="${a.url}" alt="${a.name}" decoding="async"></a>
${n > 1 ? html`<a class="focus-stage-step is-prev" data-nav href="${here}/files/${i > 1 ? i - 1 : n}${q}" data-turbo-action="replace" aria-label="The picture before">${arrow('M19 12H5M11 6l-6 6 6 6')}</a><a class="focus-stage-step is-next" data-nav href="${here}/files/${i < n ? i + 1 : 1}${q}" data-turbo-action="replace" aria-label="The next picture">${arrow('M5 12h14M13 6l6 6-6 6')}</a>` : ''}
</div>`
}

// ---- routes, the form, the live pieces ----
export function register(t) {
  const { BASE } = t
  const idOf = ref => { try { return decodeURIComponent(ref) } catch { return ref } }
  // The window of the session's own chat in memory: what is older than its oldest loaded item is not shown yet.
  const timeline = agent => (agent?.device_id ? t.hub.client?.model?.timelines?.get(`chat:session/${agent.device_id}`) : null)
  const windowOf = agent => {
    const tl = timeline(agent)
    if (!tl?.has_more) return { floor: 0, more: false }
    return { floor: Number.isFinite(tl.loaded_down_to) ? tl.loaded_down_to : 0, more: true }
  }
  const current = (id, m = t.model()) => sessionOf(m, id, windowOf(m.byAgent.get(id)))
  const find = (req, res, ref) => {
    const s = current(idOf(ref))
    if (!s) t.notFound(req, res, 'This session is not on the board.')
    return s
  }
  // The next older page of a timeline (a session's board id: its chat; or a timeline key), one request at a time.
  const loading = new Map()
  const older = ref => {
    if (!loading.has(ref)) loading.set(ref, Promise.resolve(t.hub.loadOlder?.(ref)).catch(err => console.warn('timeline', err)).finally(() => loading.delete(ref)))
    return loading.get(ref)
  }
  // Opened for the first time on this device: the newest page of its chat and of its recent questions' threads
  // (from storage, else from the hub), waited for only briefly; what comes later arrives by the live stream.
  const RECENT_THREADS = 20
  async function firstPage(id) {
    const model = t.hub.client?.model, agent = t.model().byAgent.get(id)
    if (!model || !agent) return
    const unread = tl => tl && tl.loaded_down_to === Infinity && tl.item_count > 0
    const wait = []
    if (unread(timeline(agent))) wait.push(older(id))
    for (const cid of (model.sessions.get(agent.device_id)?.card_ids ?? []).slice(-RECENT_THREADS)) {
      const key = `chat:card/${cid}`
      // (Its questions' threads come in the background: the live log puts late items at their places.)
      if (unread(model.timelines.get(key))) older(key).catch?.(() => {})
    }
    // Only the session's own chat is waited for, and not long (a phone switching sessions must stay under ~100 ms).
    if (wait.length) await Promise.race([Promise.all(wait), new Promise(r => setTimeout(r, 120))])
  }
  // "Earlier" asked for what is before `before`: when memory holds nothing older above the floor, the next page.
  async function reach(s, before) {
    for (let n = 0; n < 4 && s.more; n++) {
      if (s.messages.findIndex(m => m.id === before) > 0) break
      await older(s.id)
      s = current(s.id) ?? s
    }
    return s
  }
  const send = (req, res, s, opts = {}, code = 200) => t.page(req, res, {
    model: s.model, title: `${s.fresh.length ? `(${s.fresh.length}) ` : ''}${s.agent.name} · Trommi`, view: 'session', css: 'session', current: s.id, scope: s.id,
    stream: `&session=${encodeURIComponent(s.id)}${opts.mode ? `&mode=${opts.mode}` : ''}`, bodyAttrs: opts.mode === 'questions' ? ` data-filter="${opts.mode}"` : '',
    main: sessionMain(s, BASE, opts),
  }, code)

  // (A '+' in the place of the id is the old client's "sessions laid together": not rendered here.)
  t.get(/^\/s\/([^/+]+)$/, async ({ req, res, url, match }) => {
    await firstPage(idOf(match[1]))
    let s = find(req, res, match[1])
    if (!s) return
    // ?before=<message>: the window before that message. The "Earlier" link asks for it from inside a Turbo Frame.
    const before = url.searchParams.get('before')
    if (before) s = await reach(s, before)
    send(req, res, s, { mode: url.searchParams.get('only') === 'questions' ? 'questions' : '', before, text: (url.searchParams.get('say') ?? '').slice(0, 2000), focus: url.searchParams.has('say') })
  })
  t.get(/^\/s\/([^/+]+)\/questions$/, ({ res, match }) => t.redirect(res, `${BASE}/s/${match[1]}?only=questions`))
  t.get(/^\/s\/([^/+]+)\/files$/, async ({ req, res, match }) => {
    await firstPage(idOf(match[1]))
    const s = find(req, res, match[1])
    if (!s) return
    // Asked by the drawer's frame: only the frame with its list (Turbo takes the frame of that id out of the answer).
    if (req.headers['turbo-frame'] === `files-frame-${s.id}`) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' })
      return res.end(String(html`<turbo-frame id="files-frame-${s.id}" target="_top">${filesList(s, BASE)}</turbo-frame>`))
    }
    send(req, res, s, { mode: 'files' })
  })
  t.get(/^\/s\/([^/+]+)\/files\/(\d+)$/, ({ req, res, url, match }) => {
    const s = find(req, res, match[1])
    if (!s) return
    if (!s.pictures.length) return t.redirect(res, `${sessionPath(s.id, BASE)}/files`)
    t.page(req, res, { model: s.model, title: `${s.agent.name} · picture ${match[2]}`, view: 'picture', sidebar: false, css: 'card', stream: null, main: sessionPicture(s, BASE, Number(match[2]), url.searchParams.get('from') ?? ''), bodyAttrs: ' data-focus-page="card"' })
  })

  // Something it published, in the app's viewer (?from=<message>: the way back to where it was announced).
  t.get(/^\/s\/([^/+]+)\/a\/([0-9a-f]{8,64})$/, ({ req, res, url, match }) => {
    const s = find(req, res, match[1])
    if (!s) return
    const asset = s.model.state.assets.find(a => a.id === match[2]) ?? { id: match[2], gone: true, type: 'file', title: 'Published' }
    t.page(req, res, { model: s.model, title: `${asset.title || 'Published'} · ${s.agent.name}`, view: 'picture', sidebar: false, css: 'asset', stream: null, main: assetPage(s, asset, BASE, url.searchParams.get('from') ?? ''), bodyAttrs: ' data-focus-page="card"' })
  })

  // The composer: words, files (pictures, pasted or dropped ones) and copied cards (controller "composer"). The core
  // shows the message at once (its optimistic echo; the composer already put its own in), then seals and sends it.
  t.post(/^\/s\/([^/+]+)\/message$/, async ({ req, res, match, form }) => {
    const s = find(req, res, match[1])
    if (!s) return
    const stay = form.has('stay') && t.wantsStream(req)
    const text = String(form.get('text') ?? '').replace(/\r\n/g, '\n')
    const files = form.getAll('files').filter(f => typeof f === 'object' && f && f.size > 0)
    const cards = [...new Set(form.getAll('cards').map(String).filter(id => /^[0-9a-f]{8,64}$/.test(id)))].slice(0, 5)
    try {
      if (files.length > MAX_FILES) throw new Error(`at most ${MAX_FILES} files at once`)
      if (!text.trim() && !files.length && !cards.length) throw new Error('write something first')
      await t.hub.message({ agent: s.id, text, attachments: files, cards })
    } catch (err) {
      const said = `Not sent: ${err.message || 'the board did not take it'}`
      // 422: counted as not sent, so the composer keeps the words and files (composer_controller.js).
      if (stay) return t.sendStream(req, res, t.stream('replace', `session-error-${s.id}`, sendError(s, said)), 422)
      return send(req, res, current(s.id) ?? s, { error: said, text }, 422)
    }
    // Sent: the message itself is in the log already; the composer cleared itself.
    if (stay) return t.sendStream(req, res, t.stream('replace', `session-error-${s.id}`, sendError(s)))
    t.redirect(res, sessionPath(s.id, BASE))
  })

  // Live: for every session that has a page open, its pieces; a page gets what differs, and a new message at the log's end.
  t.live('session', {
    take(m, clients) {
      const out = new Map()
      for (const c of clients) {
        const id = c.params.get('session'), mode = c.params.get('mode') ?? ''
        if (!id) continue
        let p = out.get(id)
        if (!p) {
          const s = current(id, m)
          if (!s) { out.set(id, null); continue }
          p = { s, who: sessionWho(s, BASE), now: sessionNow(s, BASE), link: sessionLink(s), count: `${s.fresh.length} ${fileCount(s)}`, modes: {} }
          out.set(id, p)
        }
        if (p && !(mode in p.modes)) {
          p.modes[mode] = true
          if (mode === 'questions') p.questions = questionList(p.s, BASE)
          // The live part of the log: its newest LIVE messages (what "Earlier" brought further up stays as it was).
          else { p.files = filesList(p.s, BASE); p.items = logItems(p.s, BASE, p.s.messages.length - LIVE); p.byId = new Map(p.items.map(i => [i.id, i])); p.all = new Set(p.s.messages.map(m => m.id)); p.status = sessionStatus(p.s, BASE); p.open = sessionOpen(p.s, BASE, new Set(p.items.slice(-PAGE).map(i => i.id))) }
        }
      }
      return out
    },
    diff(was, now, client) {
      const id = client.params.get('session'), mode = client.params.get('mode') ?? ''
      const a = was.get(id), b = now.get(id)
      if (!b) return a ? String(t.stream('refresh')) : ''
      if (!a) return ''
      const out = []
      if (t.differs(a.who, b.who)) out.push(t.stream('replace', `session-who-${id}`, b.who))
      if (t.differs(a.now, b.now)) out.push(t.stream('replace', `session-now-${id}`, b.now))
      if (t.differs(a.link, b.link)) out.push(t.stream('replace', `session-link-${id}`, b.link))
      if (a.count !== b.count) out.push(t.stream('replace', `session-filters-${id}`, sessionFilters(b.s, BASE, mode)))
      if (mode === 'questions') { if (a.questions != null && t.differs(a.questions, b.questions)) out.push(t.stream('replace', `session-questions-${id}`, b.questions)) }
      else if (a.items && b.items) {
        // What stood there and stands there still, changed: that element. What is new goes in before the first message
        // after it that stood there (at the end, mostly; a question's thread loaded late lands at its places). What came
        // in older than all that stood there is an earlier page ("Earlier" shows it).
        const first = a.items[0]?.seq ?? Infinity
        const fresh = b.items.filter(i => !a.byId.has(i.id) && i.seq >= first)
        // (More new ones than a window holds: the latest window again, rather than a log that grows without end.)
        if (fresh.length > PAGE) return String(t.stream('refresh'))
        for (const i of a.items) if (!b.all.has(i.id)) out.push(t.stream('remove', `msg-${i.id}`))
        for (const i of b.items) { const old = a.byId.get(i.id); if (old && old.node !== i.node && t.differs(old.node, i.node)) out.push(t.stream('replace', `msg-${i.id}`, i.node)) }
        let anchor = `log-end-${id}`
        const at = []
        for (let n = b.items.length - 1; n >= 0; n--) { const i = b.items[n]; if (a.byId.has(i.id)) anchor = `msg-${i.id}`; else if (i.seq >= first) at.push([i, anchor]) }
        for (const [i, before] of at.reverse()) out.push(t.stream('before', before, html`${i.day}${i.node}`))
        if (t.differs(a.status, b.status)) out.push(t.stream('replace', `session-status-${id}`, b.status))
        if (t.differs(a.open, b.open)) out.push(t.stream('replace', `session-open-${id}`, b.open))
        // The drawer's list (a page whose drawer was never opened has no such element: the action does nothing there).
        if (t.differs(a.files, b.files)) out.push(t.stream('replace', `session-files-${id}`, b.files))
      }
      return out.join('')
    },
  })
}

// ---- controller "composer" ----
// The composer of a session's page (session.mjs): a plain form that works by itself. This adds what a form
// cannot do alone: Enter sends (Shift+Enter is a new line; on a touch screen Enter stays a new line, and Ctrl/Cmd+Enter
// sends everywhere), the field grows with its words, the chosen files stand as chips that can be taken off, a pasted
// picture or a file dropped anywhere on the page is attached, a card copied elsewhere ("Copy" on a card, controller
// "clip") is offered and goes along as a chip, and what was typed survives a reload.
//
// Sending shows the message at once: the moment the form is taken (turbo:submit-start, after the router read it),
// the composer puts its own copy at the log's end and is empty again. The core's echo (the real message, pending)
// replaces that copy when it arrives (controller "log"); a refusal takes it out and gives the words and files back.

const MAX_CARDS = 5
const CLIP_KEY = 'trommi-cardclip'   // written by controller "clip": { id, number, title, choice_label, text }
const fine = mq('(pointer: fine)')
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e }
const held = () => { try { const c = JSON.parse(sessionStorage.getItem(CLIP_KEY) ?? 'null'); return c?.id ? c : null } catch { return null } }

controller('composer', class extends Controller {
  static targets = ['field', 'picker', 'chips', 'send']
  static values = { agent: String, focus: Boolean }

  connect() {
    this.cards = []
    if (!this.fieldTarget.value) { try { this.fieldTarget.value = localStorage.getItem(this.key) ?? '' } catch {} }
    // (no measuring while the page is built: an empty field keeps its CSS height, a draft is fitted once it is painted)
    this.paint({ fit: false })
    if (this.fieldTarget.value) requestAnimationFrame(() => setTimeout(() => { if (this.element.isConnected) this.fit() }, 0))
    if (this.focusValue) { this.fieldTarget.focus(); this.fieldTarget.setSelectionRange(this.fieldTarget.value.length, this.fieldTarget.value.length) }
  }
  // Gone with the page: the previews' object URLs are let go.
  disconnect() { this.revoke() }
  revoke() { if (this.hasChipsTarget) for (const img of this.chipsTarget.querySelectorAll('img')) URL.revokeObjectURL(img.src) }
  get key() { return `agent-board-draft:${this.agentValue}` }
  forget() { try { localStorage.removeItem(this.key) } catch {} }
  get empty() { return !this.fieldTarget.value.trim() && !this.pickerTarget.files.length && !this.cards.length }

  fit() {
    const field = this.fieldTarget
    field.style.height = 'auto'
    const max = Math.max(120, Math.min(260, innerHeight * 0.36))
    field.style.height = `${Math.min(field.scrollHeight, max)}px`
    field.style.overflowY = field.scrollHeight > max ? 'auto' : 'hidden'
    this.sendTarget.disabled = this.empty
  }
  typed() { this.fit(); try { localStorage.setItem(this.key, this.fieldTarget.value) } catch {} }
  keys(e) {
    if (e.key !== 'Enter' || e.shiftKey || e.isComposing || e.keyCode === 229) return
    if (!(fine.matches || e.ctrlKey || e.metaKey)) return
    e.preventDefault()
    if (!this.sendTarget.disabled) this.element.requestSubmit(this.sendTarget)
  }
  // A click anywhere in the box goes to the field, as in a text box.
  aim(e) { if (e.target === this.element) this.fieldTarget.focus() }

  // ---- sending ----
  start() {
    const files = [...this.pickerTarget.files]
    this.sending = { text: this.fieldTarget.value, files, cards: this.cards, echo: this.echo(this.fieldTarget.value.trim(), files, this.cards) }
    if (this.cards.length) { try { sessionStorage.removeItem(CLIP_KEY) } catch {} }
    this.fieldTarget.value = ''
    this.cards = []
    this.forget()
    this.setFiles([])
  }
  // Sent: the core has it. Not sent (422, or an error): the copy leaves, the words and files come back.
  sent(e) {
    const was = this.sending
    this.sending = null
    if (!was || e.detail.success) return
    was.echo?.remove()
    if (!this.fieldTarget.value) this.fieldTarget.value = was.text
    if (!this.cards.length) this.cards = was.cards
    if (!this.pickerTarget.files.length) this.setFiles(was.files)
    else this.paint()
    this.typed()
  }
  /** Our own copy of the message at the log's end, in the markup the session view gives a message of the human. */
  echo(text, files, cards) {
    const end = document.getElementById(`log-end-${this.agentValue}`)
    if (!end || (!text && !files.length && !cards.length)) return null
    const msg = el('article', 'msg msg-user')
    msg.dataset.echo = ''
    const prev = end.previousElementSibling
    if (prev?.matches('.msg-user') && !prev.querySelector('.cardclip-row, .shots, .files')) msg.classList.add('cont')
    const pics = files.filter(f => f.type.startsWith('image/')), rest = files.filter(f => !f.type.startsWith('image/'))
    if (pics.length) {
      const shots = el('div', `shots${pics.length === 1 ? ' shots-one' : ''}`)
      for (const f of pics) { const a = el('span', 'shot'), img = el('img'); img.src = URL.createObjectURL(f); img.alt = f.name; img.onload = () => URL.revokeObjectURL(img.src); a.append(img); shots.append(a) }
      msg.append(shots)
    }
    if (rest.length) { const box = el('div', 'files'); for (const f of rest) { const chip = el('span', 'file-chip'); chip.append(el('span', '', f.name)); box.append(chip) } msg.append(box) }
    if (cards.length) {
      const row = el('div', 'cardclip-row')
      for (const c of cards) { const chip = el('span', 'cardclip-chip is-link'); chip.append(el('b', '', `Nr. ${c.number}`), el('span', 'cardclip-title', c.title)); row.append(chip) }
      msg.append(row)
    }
    if (text) { const bubble = el('div', 'bubble'); bubble.append(el('p', '', text)); msg.append(bubble) }
    const now = new Date(), time = el('time', 'msg-time', `${two(now.getHours())}:${two(now.getMinutes())}`)
    time.dateTime = now.toISOString()
    msg.append(time)
    end.before(msg)
    return msg
  }

  // ---- files ----
  setFiles(list) {
    const dt = new DataTransfer()
    for (const f of list.slice(0, MAX_FILES)) dt.items.add(f)
    this.pickerTarget.files = dt.files
    this.paint()
  }
  add(files) { if (files.length) this.setFiles([...this.pickerTarget.files, ...files]) }
  off({ params: { at } }) { this.setFiles([...this.pickerTarget.files].filter((_, n) => n !== at)) }

  // ---- copied cards ----
  takeCard() {
    const c = held()
    if (c && !this.cards.some(x => x.id === c.id) && this.cards.length < MAX_CARDS) this.cards = [...this.cards, c]
    this.paint()
    this.fieldTarget.focus()
  }
  dropOffer() { try { sessionStorage.removeItem(CLIP_KEY) } catch {} this.paint() }
  cardOff({ params: { id } }) { this.cards = this.cards.filter(c => c.id !== id); this.paint() }

  paint({ fit = true } = {}) {
    this.revoke()
    const chips = [...this.pickerTarget.files].map((file, at) => {
      const chip = el('span', 'composer-file')
      if (file.type.startsWith('image/')) {
        const thumb = el('img')
        thumb.src = URL.createObjectURL(file)
        thumb.alt = ''
        chip.classList.add('has-thumb')
        chip.append(thumb)
      }
      const off = el('button', 'composer-file-off', '×')
      off.type = 'button'
      off.title = `${file.name}: take it off`
      off.setAttribute('aria-label', off.title)
      off.dataset.action = 'composer#off'
      off.dataset.composerAtParam = String(at)
      chip.append(el('span', '', file.name), off)
      return chip
    })
    for (const c of this.cards) {
      const chip = el('span', 'cardclip-chip')
      const off = el('button', 'cardclip-off', '×')
      off.type = 'button'
      off.setAttribute('aria-label', `Nr. ${c.number}: take it off`)
      off.dataset.action = 'composer#cardOff'
      off.dataset.composerIdParam = c.id
      const input = el('input')
      input.type = 'hidden'; input.name = 'cards'; input.value = c.id
      chip.title = `Nr. ${c.number} · ${c.title}${c.choice_label ? ` → ${c.choice_label}` : ''}`
      chip.append(el('b', '', `Nr. ${c.number}`), el('span', 'cardclip-title', c.title), ...(c.choice_label ? [el('span', 'cardclip-answer', `→ ${c.choice_label}`)] : []), off, input)
      chips.push(chip)
    }
    // A card copied elsewhere and not attached yet: offered, one click attaches it.
    const c = held()
    if (c && !this.cards.some(x => x.id === c.id) && this.cards.length < MAX_CARDS) {
      const offer = el('span', 'cardclip-offer')
      const take = el('button', 'cardclip-paste', `Paste Nr. ${c.number}`)
      take.type = 'button'; take.title = `Attach the copied card: ${c.title}`; take.dataset.action = 'composer#takeCard'
      const drop = el('button', 'cardclip-off', '×')
      drop.type = 'button'; drop.setAttribute('aria-label', 'Forget the copied card'); drop.dataset.action = 'composer#dropOffer'
      offer.append(take, drop)
      chips.push(offer)
    }
    this.chipsTarget.replaceChildren(...chips)
    this.element.toggleAttribute('data-files', this.pickerTarget.files.length > 0 || this.cards.length > 0)
    if (fit) this.fit(); else this.sendTarget.disabled = this.empty
  }
  paste(e) {
    // The line a card's "Copy" wrote: the card itself, as a chip.
    const c = held(), said = e.clipboardData?.getData('text/plain')?.trim()
    if (c && said && said === String(c.text ?? '').trim()) { e.preventDefault(); this.takeCard(); return }
    const files = [...(e.clipboardData?.files ?? [])].map(f => (f.name && f.name !== 'image.png' ? f : new File([f], `pasted-${Date.now()}.${(f.type.split('/')[1] ?? 'png').replace('jpeg', 'jpg')}`, { type: f.type })))
    if (files.length) { e.preventDefault(); this.add(files) }
  }
  // A file dragged over the page: the box shows that it takes it; dropped anywhere, it is attached.
  over(e) { if (e.dataTransfer?.types.includes('Files')) { e.preventDefault(); this.element.classList.add('is-drop') } }
  left(e) { if (!e.relatedTarget) this.element.classList.remove('is-drop') }
  drop(e) {
    this.element.classList.remove('is-drop')
    const files = [...(e.dataTransfer?.files ?? [])]
    if (files.length) { e.preventDefault(); this.add(files); this.fieldTarget.focus() }
  }
})

// ---- controller "log" ----
// A session's conversation (session.mjs), on .chat-pane. The hub rendered it and the log stands at its
// end by itself (css: a reversed column). This adds what only the browser knows:
//   - "To the end", with the number of messages that arrived while one was reading further up, and the view
//     that stays where it is when they arrive;
//   - the "N open" chip: only while an open question of the conversation is out of sight, and the way to the next;
//   - the times in this browser's own zone (the hub wrote them in its own);
//   - paging up by itself: the "Earlier messages" link is followed when it comes near while scrolling up;
//   - the composer's own copy of a message (data-echo) leaves when the real one arrives.

function localise(root) {
  for (const t of root.querySelectorAll?.('time[datetime]') ?? []) {
    const d = new Date(t.dateTime)
    if (Number.isNaN(d.getTime())) continue
    const full = FULL.format(d), text = t.hasAttribute('data-full') ? full : `${two(d.getHours())}:${two(d.getMinutes())}`
    if (t.textContent !== text) t.textContent = text
    if (!t.hasAttribute('data-full') && t.title !== full) t.title = full
  }
  for (const day of root.querySelectorAll?.('.day[data-day]') ?? []) {
    const label = dayLabel(Number(day.dataset.day))
    if (day.firstElementChild && day.firstElementChild.textContent !== label) day.firstElementChild.textContent = label
  }
}

controller('log', class extends Controller {
  static targets = ['log', 'jump', 'jumpText', 'open', 'openText', 'earlier']

  connect() {
    this.pinned = true
    this.unread = 0
    localise(this.element)
    if (!this.hasLogTarget) return   // a list is in view (questions, files): only the times
    // (nothing is measured while the page is built: the log's height and the open questions out of sight are read once
    //  the frame is painted, when the layout is there anyway; reading them here made the browser lay the page out first)
    this.height = null
    this.seen = new MutationObserver(list => this.arrived(list))
    this.seen.observe(this.logTarget, { childList: true, subtree: true })
    this.sizes = new ResizeObserver(() => this.paint())
    this.sizes.observe(this.logTarget)
    requestAnimationFrame(() => setTimeout(() => { if (!this.hasLogTarget || !this.logTarget.isConnected) return; this.height ??= this.logTarget.scrollHeight; this.paint() }, 0))
  }
  disconnect() { this.seen?.disconnect(); this.sizes?.disconnect(); this.near?.disconnect() }

  // An "Earlier messages" link near the top of what is in view: followed (its frame brings the window before it).
  earlierTargetConnected(link) {
    if (!this.hasLogTarget) return
    this.near ??= new IntersectionObserver(seen => {
      for (const e of seen) if (e.isIntersecting && e.target.isConnected) { this.near.unobserve(e.target); e.target.click() }
    }, { root: this.logTarget, rootMargin: '900px 0px 0px 0px' })
    // Only once the reader scrolls: opening a conversation does not page by itself.
    if (this.moved) this.near.observe(link)
    else this.waiting = link
  }
  earlierTargetDisconnected(link) { this.near?.unobserve(link) }

  // (The log is a reversed column: its end is scrollTop 0, further up is negative.)
  get atEnd() { return Math.abs(this.logTarget.scrollTop) < 72 }
  scrolled() {
    this.moved = true
    if (this.waiting?.isConnected) this.near?.observe(this.waiting)
    this.waiting = null
    this.pinned = this.atEnd
    if (this.pinned) this.unread = 0
    this.paint()
  }
  toEnd() {
    this.pinned = true
    this.unread = 0
    this.logTarget.scrollTo({ top: 0, behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth' })
    this.paint()
  }
  arrived(list) {
    const log = this.logTarget
    let fresh = 0
    for (const change of list) for (const node of change.addedNodes) {
      if (node.nodeType !== 1) continue
      localise(node.matches('time, .day') ? node.parentNode : node)
      // What is put in at the log's end (before its end mark) is new; anything else replaces what stood there, or is earlier.
      if (change.nextSibling?.id?.startsWith?.('log-end-') && node.matches('.msg-agent, .ask, .event')) fresh++
      else if (change.nextSibling?.id?.startsWith?.('log-end-') && node.matches('.msg-user')) {
        this.pinned = true; this.unread = 0
        // The core's echo of what the composer sent: the composer's copy with the same words leaves.
        if (!node.hasAttribute('data-echo')) {
          const words = node.querySelector('.bubble')?.textContent ?? ''
          ;[...log.querySelectorAll('[data-echo]')].find(e => (e.querySelector('.bubble')?.textContent ?? '') === words)?.remove()
        }
      }
    }
    const grew = this.height == null ? 0 : log.scrollHeight - this.height
    this.height = log.scrollHeight
    if (this.pinned) log.scrollTop = 0
    else if (fresh) { this.unread += fresh; if (grew > 0) log.scrollTop -= grew }   // reading further up: what is in view stays in view
    this.paint()
  }
  paint() {
    if (!this.hasLogTarget) return
    if (this.hasJumpTarget) {
      this.jumpTarget.hidden = this.pinned
      this.jumpTarget.classList.toggle('has-unread', this.unread > 0)
      this.jumpTextTarget.textContent = this.unread === 0 ? 'To the end' : this.unread === 1 ? '1 new message' : `${this.unread} new messages`
    }
    this.paintOpen()
  }
  openTargetConnected() { if (this.hasLogTarget) this.paintOpen() }

  // The open questions of the conversation that are out of sight, and which of them comes next.
  paintOpen() {
    if (!this.hasOpenTarget) return
    const box = this.logTarget.getBoundingClientRect()
    const away = [...this.logTarget.querySelectorAll('.ask-card')].map(node => ({ node, r: node.getBoundingClientRect() })).filter(({ r }) => r.bottom < box.top + 48 || r.top > box.bottom - 48)
    const below = away.find(({ r }) => r.top > box.top)
    this.next = (below ?? away.at(-1))?.node ?? null
    this.openTarget.hidden = !this.next
    if (!this.next) return
    this.openTarget.classList.toggle('is-up', !below)
    this.openTarget.setAttribute('href', `#${this.next.id}`)
    if (this.hasOpenTextTarget) this.openTextTarget.textContent = `${away.length} open`
    this.openTarget.setAttribute('aria-label', away.length === 1 ? 'One open question out of sight: go to it' : `${away.length} open questions out of sight: go to the next one`)
  }
  toOpen(e) {
    if (!this.next) return
    e.preventDefault()
    this.pinned = false
    this.next.scrollIntoView({ block: 'center', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth' })
    this.next.querySelector('.inbox-row')?.focus({ preventScroll: true })
  }
})

// ---- controller "files" ----
// A session's files drawer (session.mjs filesDrawer): "N files" beside the quiet line (on a phone,
// "Files (N)" in the filter menu) opens it, the chip again, Escape, a click beside it or its × close it. The list is
// a frame: the link that opens it loads it once (data-turbo-frame); later it is kept current by the live stream.
// "Jump to" scrolls to the message and marks it for a moment when it is on the page; otherwise its link loads the
// window of the conversation that ends with it.

const PHONE = '(max-width: 860px)'

controller('files', class extends Controller {
  static targets = ['drawer', 'frame']

  get isOpen() { return this.hasDrawerTarget && !this.drawerTarget.hidden }

  toggle(event) {
    if (this.isOpen) { event.preventDefault(); this.close() } else this.open(event)
  }
  open(event) {
    if (!this.hasDrawerTarget) return
    event?.target.closest('details')?.removeAttribute('open')
    // Loaded before: only shown. Otherwise the link goes on and Turbo loads the list into the frame.
    if (this.frameTarget.childElementCount) event?.preventDefault()
    this.drawerTarget.hidden = false
    this.element.setAttribute('data-files-open', '')
  }
  close(event) {
    event?.preventDefault()
    if (!this.hasDrawerTarget) return
    this.drawerTarget.hidden = true
    this.element.removeAttribute('data-files-open')
    // Opened as its own address (/s/<id>/files): the address becomes the conversation's again.
    if (/\/files$/.test(location.pathname)) history.replaceState(history.state, '', location.pathname.replace(/\/files$/, '') + location.search)
  }
  key(event) {
    if (event.key === 'Escape' && this.isOpen && !event.defaultPrevented) { event.preventDefault(); this.close() }
  }
  outside(event) {
    if (!this.isOpen || !event.target.isConnected) return
    if (this.drawerTarget.contains(event.target) || event.target.closest('.files-chip, .session-filter-files, .session-filter')) return
    this.close()
  }
  jump(event) {
    const at = document.getElementById(`msg-${event.params.msg}`)
    if (!at) return   // not on the page: the link loads the window that holds it
    event.preventDefault()
    if (matchMedia(PHONE).matches) this.close()
    at.scrollIntoView({ block: 'center', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' })
    at.classList.remove('is-jumped')
    void at.offsetWidth
    at.classList.add('is-jumped')
    clearTimeout(this.unmark)
    this.unmark = setTimeout(() => at.classList.remove('is-jumped'), 1800)
  }
  disconnect() { clearTimeout(this.unmark) }
})

// ---- controller "share" ----
// "Copy link" of something a session published (session.mjs assetCard, assetPage): copies the address of the
// app's viewer for it. It opens for the people of this room (the contents are end-to-end encrypted with the room's
// keys); there is no outside link.

controller('share', class extends Controller {
  static values = { link: String, title: String }

  async copy() {
    const ok = await copyText(new URL(this.linkValue, location.href).href)
    if (!ok) return toast({ head: 'Not copied', line: 'The browser kept the clipboard closed', role: 'alert' })
    toast({ head: 'Link copied', line: `“${this.titleValue}” opens for the people of this room` })
  }
})
