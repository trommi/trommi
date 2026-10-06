// A card's own page (decided on card Nr. 191): inside the board's frame, the sidebar beside it. The card is one calm
// block of FIXED height in two columns: at the left the title, one quiet line (who, when, Nr.), the short text and a
// low picture; at the right the options, "or" Whatever, and the field whose Send hands the card back with the words.
// Everything else stands in the comments below the card: the whole text when it is longer than the card holds, the
// options in detail, links of options, why it is urgent, versions and what happened to the card, the talk.
// Above the card one row: the way back, where it stands ("3 of 9", before and next), and one "More" (Wake up, Copy,
// Shred). Later is a pull-tag tied under the card's bottom-right corner (the Desk's Later: ui.mjs sideWays, the same
// route): pulled, the card is put off and the next one follows.
//
// One form (#card-form-<id>) holds the field and the notes on single options; every way to answer is a button of that
// form with its own address (formaction), so what was written goes along, with or without scripts. The controller
// "card" (controller "card") adds the pencil for a note on one option, the draft kept while typing,
// Enter that sends, files that are pasted or dropped, and the pen's arrow from the picture to its option.
// Styles: card.css.
import { BASE, SAID, stream } from './app.mjs'
import { Controller, EXPLAIN_TEXT, WORDS, act, advisedKeys, advisedLabels, agoSpan, arrowStrokes, cardNote, cardNr, cardPath, controller, copyButton, deskRow, doodleSvg, el, html, isKnock, kindOf, knockWord, pageChip, plain, raw, rich, sideWays, sk, sketch, srcOf, thumb } from './ui.mjs'
const icon = d => raw(`<svg viewBox="0 0 24 24" class="tc-icon" aria-hidden="true"><path d="${d}"/></svg>`)
const ARROW_L = 'M19 12H5M11 6l-6 6 6 6', ARROW_R = 'M5 12h14M13 6l6 6-6 6', TICK = 'M5 12.5l4.5 4.5L19 7.5', ZOOM = 'M11 4a7 7 0 1 0 0 14a7 7 0 0 0 0-14M20 20l-4-4M11 8v6M8 11h6', ZOOM_OUT = 'M11 4a7 7 0 1 0 0 14a7 7 0 0 0 0-14M20 20l-4-4M8 11h6', PLAY = 'M9 6.5v11l9-5.5z'
// The way back, drawn with the pen: an arrow to the left.
const BACK = raw('<svg viewBox="0 0 24 24" class="sketch" aria-hidden="true"><path d="M19.4 12.3 Q12.2 11.5 5 12.1"/><path d="M10.9 6 Q7.7 9.3 4.7 12.1 Q8 14.8 11.2 18.2"/></svg>')
const HAND_BACK_TEXT = 'Back to you: please rework this question and present it again. Take the comments under the card into account.'
const imagesOf = card => (card.attachments ?? []).filter(a => kindOf(a) === 'image')
const videosOf = card => (card.attachments ?? []).filter(a => kindOf(a) === 'video')
/** The version that stands now, as a number. */
const liveVersion = card => card.version ?? (card.versions?.at(-1)?.n ?? 0) + 1
/** The card as it was in version n (title, text, options, pictures), or null. */
const versionOf = (card, n) => (n != null && n < liveVersion(card) ? card.versions?.find(v => v.n === n) ?? null : null)

// ---- the fixed height: what the card holds, and what goes to the comments ----
// The card shows at most TEXT_FIT characters of plain text, whole paragraphs first. A layout, a table or code never
// stands on the card. What does not fit is in the comments, as "The whole text", and the card says so.
const TEXT_FIT = 340
/** -> { shown: the text for the card (markdown), more: whether the comments hold more } */
function fitText(text) {
  const source = String(text ?? '')
  const prose = source.replace(/```[\s\S]*?```/g, '\n\n').split(/\n{2,}/).map(p => p.trim()).filter(p => p && !/^\s*\|.*\|\s*$/m.test(p))
  let shown = '', used = 0
  for (const p of prose) {
    const len = plain(p).length
    if (used + len <= TEXT_FIT) { shown += `${shown ? '\n\n' : ''}${p}`; used += len; continue }
    if (!shown) { const words = plain(p).slice(0, TEXT_FIT).replace(/\s+\S*$/, ''); shown = `${words}…`; used = TEXT_FIT }
    break
  }
  const all = prose.reduce((n, p) => n + plain(p).length, 0)
  return { shown, more: used < all || /```|^\s*\|/m.test(source) }
}
/** What was said about one card (its events and its comments), in order: the board state's per-card list where it
 *  has one (built from that card's thread only), else filtered from its session's or the whole board's. */
const talkOf = (model, card) => {
  const st = model.state
  return st.messagesOfCard ? st.messagesOfCard(card.id) : (st.messagesOf ? st.messagesOf(card.agent) : st.messages).filter(m => m.card_id === card.id)
}
/** The text a card stands for: its body, or the plain blocks of its sections. */
const textOf = card => (card.sections?.length ? card.sections.filter(s => s.key == null).map(s => s.text).filter(Boolean).join('\n\n') : card.body ?? '')

/** Which picture belongs to which option: picture index -> option key, where that is
 *  plain to see: a section names its picture; or every picture names one option in its file name; or there are
 *  as many pictures as options, three or more. Nothing is guessed otherwise. */
function pictureKeys(card) {
  const images = imagesOf(card), options = card.options ?? [], out = new Map()
  for (const s of card.sections ?? []) {
    const at = s.key != null && s.picture != null ? images.indexOf(card.attachments?.[s.picture]) : -1
    if (at >= 0 && !out.has(at)) out.set(at, s.key)
  }
  if (out.size || images.length < 2 || options.length < 2) return out
  const slug = text => String(text ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
  let unclear = false
  const owners = new Set()
  images.forEach((img, i) => {
    const name = `-${slug(String(img.name ?? '').replace(/\.[a-z0-9]+$/i, ''))}-`
    const hits = options.filter(o => [slug(o.key), slug(o.label)].some(w => w && name.includes(`-${w}-`))).sort((x, y) => slug(y.key).length - slug(x.key).length)
    if (!hits.length) return
    if (hits.length > 1 && slug(hits[1].key).length === slug(hits[0].key).length) { unclear = true; return }
    out.set(i, hits[0].key); owners.add(hits[0].key)
  })
  if (!unclear && owners.size >= 2) return out
  return images.length === options.length && options.length >= 3 ? new Map(options.map((o, i) => [i, o.key])) : new Map()
}

/** What the controller "card" needs to put another picture on the stage (the pointer on an option or on a small
 *  picture): per picture its address, its size, its marks, the option it belongs to, its file name and caption, its page. */
function picturesOf(card, base) {
  const keys = pictureKeys(card)
  const images = imagesOf(card)
  // (Several options may show the same picture: a section names it for each.)
  const shared = i => (card.sections ?? []).filter(s => s.key != null && s.picture != null && images.indexOf(card.attachments?.[s.picture]) === i).map(s => s.key)
  return images.map((a, i) => { const all = shared(i), key = keys.get(i) ?? null; return { at: i + 1, src: thumb(a).src, width: a.width > 0 ? a.width : null, height: a.height > 0 ? a.height : null, name: a.name, title: a.title && a.title !== a.name ? a.title : '', page: a.page ?? null, marks: a.marks ?? [], key, keys: all.length ? all : key != null ? [key] : [], href: `${cardPath(card, base)}/p/${i + 1}` } })
}
/** Where one stands among the pictures: "2 / 6", the file's name, its caption. */
const where = (a, i, n, cls) => html`<span class="${cls}" data-card-target="where">${n > 1 ? html`<b>${i} / ${n}</b> ` : ''}<span>${a.name}${a.title && a.title !== a.name ? ` · ${a.title}` : ''}</span></span>`
/** The small pictures to pick from: the one that stands is marked; the pointer on one shows it (controller "card"). */
const strip = (images, i, to, cls = '') => html`<span class="tc-strip ${cls}" data-action="pointerover->card#peek focusin->card#peek pointerleave->card#unpreview focusout->card#unpreview">${images.map((p, n) => html`<a class="tc-thumb" data-nav href="${to(n + 1)}" data-turbo-action="replace" data-at="${n + 1}" title="${p.name}" aria-label="Show picture ${n + 1}: ${p.name}" aria-pressed="${String(n + 1 === i)}"><img${srcOf(p)} alt="" loading="lazy" decoding="async" draggable="false" width="48" height="34"></a>`)}</span>`
/** The picture's shown width: its own, never wider than its place (a phone's screenshot is not blown up). */
const ownWidth = a => (a.width > 0 ? raw(` style="width:${Number(a.width)}px"`) : '')

/** The picture of the card: one at a time at the column's width, cut off below (its top is what one reads); "+" makes
 *  it whole right here, "Gallery" opens it large on its own page. The others as small ones to pick. A frame of its
 *  own, so picking another loads only this. Videos come after the pictures (?pic= counts on): one stands on the stage
 *  as a player (decrypted to a blob by att.mjs / sw.js; never autoplays), its tile a play mark. */
function cardMedia(card, base, at = 1, query = '') {
  const images = imagesOf(card), videos = videosOf(card), all = [...images, ...videos]
  if (!all.length) return ''
  const i = Math.min(Math.max(1, at), all.length), a = all[i - 1], video = i > images.length
  const here = cardPath(card, base)
  const to = n => `${here}?pic=${n}${query}`
  const key = video ? undefined : pictureKeys(card).get(i - 1)
  const step = (n, cls, label, d) => (all.length > 1 ? html`<a class="tc-step ${cls}" data-nav href="${to(n)}" data-turbo-action="replace" aria-label="${label}">${icon(d)}</a>` : '')
  const shown = video
    ? html`<figure class="tc-video"><video src="${a.url}#t=0.001" controls playsinline preload="metadata" aria-label="Video ${i} of ${all.length}: ${a.name}"></video></figure>`
    : html`<div class="tc-figure" data-card-target="figure" data-action="click->card#enlarge" data-at="${i}"${key != null ? html` data-key="${key}"` : ''} data-controller="circles" data-circles-marks-value="${JSON.stringify(a.marks ?? [])}"><img alt="Picture ${i} of ${images.length}: ${a.name}"${srcOf(a)}${ownWidth(a)} decoding="async" draggable="false"></div><button class="tc-zoom" type="button" data-card-target="zoom" data-action="card#enlarge" aria-pressed="false" title="Bigger, right here" aria-label="Show the whole picture here, or only its top">${icon(ZOOM)}${icon(ZOOM_OUT)}</button>`
  return html`<turbo-frame id="card-media-${card.id}" class="tc-media">
<div class="tc-stage${video ? ' is-video' : ''}">${shown}${step(i > 1 ? i - 1 : all.length, 'is-prev', 'The one before', ARROW_L)}${step(i < all.length ? i + 1 : 1, 'is-next', 'The next one', ARROW_R)}</div>
<div class="tc-thumbs">${all.length > 1 ? html`${strip(images, i, to)}${videos.map((p, n) => html`<a class="tc-thumb tc-thumb-video" data-nav href="${to(images.length + n + 1)}" data-turbo-action="replace" aria-label="Show video ${n + 1}: ${p.name}" aria-pressed="${String(images.length + n + 1 === i)}">${icon(PLAY)}</a>`)}` : ''}${video ? '' : html`<a class="tc-gallery" data-nav href="${here}/p/${i}" data-turbo-frame="_top" data-card-target="gallery" title="Open the gallery: the pictures large, on their own page">${sk('picture')}<span>Gallery</span></a>`}</div>
<div class="tc-cap">${where(a, i, all.length, 'tc-where')}${video ? '' : pageChip(a.page, true)}</div>
</turbo-frame>`
}

/** The card's left column (#card-left-<id>): title, one quiet line, the text that fits, the picture.
 *  version: as it was then (read-only). pic: the picture shown. self: the base its links are under (a session's page). */
function cardLeft(card, model, base, { version = null, pic = 1, query = '' } = {}) {
  const old = versionOf(card, version)
  const shown = old ? { ...card, attachments: old.attachments ?? card.attachments } : card
  return html`<div class="tc-left">${cardLead(card, model, base, { version })}
${cardMedia(shown, base, pic, query)}
</div>`
}
/** The words of the left column (#card-lead-<id>): what the live stream replaces (the picture keeps its place). */
function cardLead(card, model, base, { version = null } = {}) {
  const from = model.byAgent.get(card.agent)
  const old = versionOf(card, version)
  const shown = old ? { ...card, title: old.title ?? card.title, body: old.body ?? '', sections: old.sections } : card
  const { shown: text, more } = fitText(textOf(shown))
  const said = talkOf(model, card).filter(m => m.from !== 'event' && (m.text || m.attachments?.length)).length
  const notes = [cardNote(card), old ? `version ${old.n}, as it was` : '', said ? (said === 1 ? '1 message below' : `${said} messages below`) : ''].filter(Boolean)
  return html`<div class="tc-lead focus-lead" id="card-lead-${card.id}">
${isKnock(card) && card.status === 'open' ? html`<span class="inbox-tab tc-knock">${sk('knock')}${knockWord(card)}</span>` : ''}
<h1 class="tc-title" id="card-title-${card.id}">${shown.title}</h1>
<p class="tc-meta">${from ? html`<a class="tc-from" data-nav href="${base}/s/${encodeURIComponent(from.id)}" style="--hue:${from.hue}">${raw(doodleSvg(from.mark))}${from.name}</a><span aria-hidden="true">·</span>` : ''}${agoSpan(card.revised ?? card.created, 'tc-ago')}<span aria-hidden="true">·</span><span>${cardNr(card)}</span>${notes.length ? html`<span aria-hidden="true">·</span><a href="#card-thread-${card.id}">${notes.join(' · ')}</a>` : ''}</p>
${text ? html`<div class="tc-text">${rich(text, { assets: model.state.assets })}</div>` : ''}${more ? html`<a class="tc-more-text" href="#card-whole-${card.id}">More in the comments ↓</a>` : ''}
</div>`
}

// The reverse card: one press hands the card back at once, "put this before me again". Nothing opens and nothing is
// asked: the session reworks the card with the comments under it in mind (what should change is written there first).
// A button of the card's form: what stands unsent in the field and what is drawn on the card go along.
const reviseTile = (card, model, base) => { const to = model.byAgent.get(card.agent)?.name ?? 'the agent', tip = `Reverse: back to ${to} for rework, with the comments`; return html`<button class="tc-tile tc-reverse" type="submit" form="card-form-${card.id}" formaction="${act(card, base, 'revise')}" name="next" value="1" title="${tip} (B)" aria-label="${tip}">${sk('reverse')}</button>` }
const still = (label, detail = '', cls = '') => html`<div class="tc-opt is-still ${cls}"><span class="tc-opt-words"><span class="tc-opt-label">${label}</span>${detail ? html`<span class="tc-opt-detail">${detail}</span>` : ''}</span></div>`
const back = (card, base, way, word = WORDS.takeBack) => html`<button class="tc-way" type="submit" form="card-form-${card.id}" formaction="${act(card, base, way)}">${word}</button>`

/** The right column's answers (#card-answer-<id>): every option a button of the card's form, with its line for a note;
 *  then "or" Whatever. Or, once answered or handed back, what was said and the way back. */
function cardAnswer(card, model, base, { error = '', version = null, pic = 1 } = {}) {
  const form = `card-form-${card.id}`
  const err = html`<p class="tc-error" role="alert"${error ? '' : raw(' hidden')}>${error}</p>`
  const old = versionOf(card, version)
  // (The revised stamp stands with the options: a rewrite that brings new options brings its stamp along.)
  const stamp = card.revised ? html`<input type="hidden" name="revised" value="${card.revised}" form="${form}">` : ''
  const box = inner => html`<div class="tc-answer" id="card-answer-${card.id}">${err}${stamp}${inner}</div>`
  if (old) return box(html`<div class="tc-opts">${(old.options ?? []).map(o => still(o.label, plain(o.detail)))}</div><p class="tc-quiet">Version ${old.n} cannot be answered. <a data-nav href="${cardPath(card, base)}">The question as it stands now</a></p>`)
  if (card.status !== 'open') {
    const picked = card.choices?.length ? card.choices : [card.choice]
    const said = card.status === 'shredded' ? 'Shredded' : card.kind === 'info' ? 'Read' : card.trusted ? `${WORDS.trust}${advisedLabels(card) ? `: ${advisedLabels(card)}` : ''}` : card.options.filter(o => picked.includes(o.key)).map(o => o.label).join(', ') || 'Withdrawn by the agent'
    const can = card.status === 'shredded' || card.choice != null || card.trusted || (card.kind === 'info' && card.read)
    return box(html`<div class="tc-opts">${still(said, card.note ? `Your note: ${card.note}` : '', 'is-picked')}${card.options.filter(o => card.option_notes?.[o.key]).map(o => still(o.label, `Your note: ${card.option_notes[o.key]}`))}${card.summary ? still('Done by the agent', card.summary) : ''}</div>${can ? back(card, base, 'reopen') : ''}`)
  }
  if (card.with_agent) return box(html`<div class="tc-opts">${still(WORDS.revising, 'It is with its session and comes back reworked.')}</div>${back(card, base, 'takeback')}`)
  // Something to read: two clear tiles, What?? (it comes back explained) and Acknowledge (read, closed).
  if (card.kind === 'info') return box(html`<div class="tc-info-ways"><button class="tc-tile is-what" type="submit" form="${form}" formaction="${act(card, base, 'what')}" title="${WORDS.what}: ask the session to explain this; it comes back explained" aria-label="What?? — explain this to me">${sk('what')}</button><button class="tc-tile is-ack" type="submit" form="${form}" formaction="${act(card, base, 'close')}" title="${WORDS.ack}: read, close it">${sk('tick')}<span>${WORDS.ack}</span></button></div>`)
  const advised = advisedKeys(card)
  const shownKey = pictureKeys(card).get(pic - 1)
  const draft = card.draft ?? {}
  const option = o => {
    const is = advised.includes(o.key), noted = String(draft.notes?.[o.key] ?? '')
    // (A link written into an option is not on its tile: the tile says it in plain words, the link stands in the comments.)
    const words = html`<span class="tc-opt-words"><span class="tc-opt-label"${is ? raw(' data-controller="advice"') : ''}>${o.label}</span>${o.detail ? html`<span class="tc-opt-detail">${plain(o.detail)}</span>` : ''}${is ? raw('<span class="tc-sr">, recommended by the agent</span>') : ''}</span>`
    const pen = card.kind === 'decision' ? html`<span class="tc-opt-pen" data-key="${o.key}" data-action="click->card#note" title="A note on this option"${noted ? raw(' data-noted') : ''}>${sk('pen')}</span>` : ''
    const marks = html`${is ? raw(' title="The agent recommends this"') : ''}${shownKey === o.key ? raw(' data-match') : ''}`
    const tile = card.multiple
      ? html`<label class="tc-opt${is ? ' is-advised' : ''}" data-key="${o.key}"${marks}><input type="checkbox" id="tick-${card.id}-${o.key}" name="keys" value="${o.key}" form="${form}" data-action="change->card#keep"${draft.keys?.includes(o.key) ? raw(' checked') : ''}><span class="tc-tick" aria-hidden="true">${icon(TICK)}</span>${words}${pen}</label>`
      : html`<button class="tc-opt${is ? ' is-advised' : ''}" type="submit" form="${form}" formaction="${act(card, base, 'decide')}" name="key" value="${o.key}" data-key="${o.key}"${marks}>${words}${pen}</button>`
    return card.kind === 'decision' ? html`${tile}<label class="tc-opt-note" data-note="${o.key}"${noted ? '' : raw(' hidden')}>${sk('pen')}<input type="text" name="note-${o.key}" form="${form}" value="${noted}" maxlength="2000" placeholder="A note on ${o.label}" aria-label="A note on ${o.label}" autocomplete="off" data-action="input->card#keep blur->card#noteLeft keydown->card#noteKey"></label>` : tile
  }
  const trustTip = `I don’t give a duck: your call (R)${advisedLabels(card) ? ` · agent takes ${advisedLabels(card)}` : ''}`
  return box(html`<div class="tc-opts" data-action="pointerover->card#preview focusin->card#preview pointerleave->card#unpreview focusout->card#unpreview" role="group" aria-label="${card.multiple ? 'Your answer. Tick what applies, then send.' : 'Your answer. One tap answers.'}">${card.options.map(option)}${card.multiple ? html`<button class="tc-opt tc-send-many" type="submit" form="${form}" formaction="${act(card, base, 'decide')}"><span class="tc-opt-words"><span class="tc-opt-label">Send the answer</span></span></button>` : ''}</div>
${card.kind === 'decision' ? html`<div class="tc-or"><i>or</i><button class="tc-opt tc-whatever" type="submit" form="${form}" formaction="${act(card, base, 'trust')}" title="${trustTip}" aria-label="${trustTip}">${sk('duck')}<span class="tc-opt-words"><span class="tc-opt-label">I don’t give a duck</span></span></button><div class="tc-or-pair"><button class="tc-tile tc-wtf" type="submit" form="${form}" formaction="${act(card, base, 'what')}" title="What?? — explain this to me (E)" aria-label="What?? Explain this to me: the session explains it, and it comes back explained">${sk('what')}</button>${reviseTile(card, model, base)}</div></div>` : ''}`)
}

// Links an agent wrote into an option (its label or its line of detail): they stand here, under the card, named by their option.
const LINK = /https?:\/\/[^\s<>)`]+|(?<![\w\/:.~\-])\/(?:[\w\-.]+\/)*[\w\-.]+\.html?(?:\?[\w\-.=&%+]*)?(?:#[\w\-.=&%+]*)?/g
function optionLinks(card) {
  const found = (card.options ?? []).flatMap(o => (`${o.label} ${o.detail ?? ''}`.match(LINK) ?? []).map(url => ({ o, url: url.replace(/[.,;:!?]+$/, '') })))
  if (!found.length) return ''
  return html`<div class="tc-did t-opt-links"><span>Links of the options</span><ul>${found.map(({ o, url }) => html`<li><b>${o.label.replace(LINK, '').trim() || o.key}</b> <a href="${url}" target="_blank" rel="noopener noreferrer">${url.replace(/^https?:\/\/(www\.)?/, '')}</a></li>`)}</ul></div>`
}

/** The comments under the card (#card-thread-<id>), the oldest first. Sober, as a conversation is: no drawings here.
 *  - What the card did not hold: the whole text, the options in detail (folded: the card shows their pictures already),
 *    links of options, why it is urgent.
 *  - The talk. "What??" and the answer that follows it stand together as one "Explained" block; a hand-back and the
 *    revision it brought stand together ("Version n, as you asked").
 *  - Everything before the version that stands now folds away behind "Earlier versions (n)". */
function cardThread(card, model, base = '', { more = false } = {}) {
  const all = talkOf(model, card)
  const assets = model.state.assets
  const who = model.byAgent.get(card.agent)
  const files = list => { const rest = (list ?? []).filter(a => kindOf(a) !== 'image'); return rest.length ? html`<p class="tc-files">${rest.map(a => html`<a href="${a.url}" target="_blank" rel="noopener">${a.name}</a> `)}</p>` : '' }
  const shots = list => { const pics = (list ?? []).filter(a => kindOf(a) === 'image'); return pics.length ? html`<div class="shots">${pics.map(a => html`<a href="${a.url}" target="_blank" rel="noopener"><img${srcOf(a, 320)} alt="${a.name}" loading="lazy" decoding="async"></a>`)}</div>` : '' }
  // One column, every piece in the same two places: at the left who (the session's small drawing, the pen for you),
  // beside it the name, when, and the words. What happened (asked, why urgent, a version, taken back) is one quiet
  // line on the words' line, without a who.
  const did = (text, ts) => html`<p class="tc-did"><span>${text}</span>${ts ? agoSpan(ts, 'msg-time') : ''}</p>`
  const name = who?.name ?? card.agent
  const mark = who ? html`<span class="tc-c-who" style="--hue:${who.hue}" aria-hidden="true">${raw(doodleSvg(who.mark))}</span>` : html`<span class="tc-c-who" aria-hidden="true"></span>`
  const you = html`<span class="tc-c-who is-you" aria-hidden="true">${sk('pen')}</span>`
  const head = (title, ts, by = name) => html`<header class="msg-head"><span class="msg-name">${by}</span>${title ? html`<b class="tc-said">${title}</b>` : ''}${ts ? agoSpan(ts, 'msg-time') : ''}</header>`
  const words = text => rich(text ?? '', { assets, hand: false })
  const agentMsg = (m, cont = false) => html`<article class="msg msg-agent tc-c${cont ? ' cont' : ''}" id="msg-${m.id}">${cont ? '' : mark}<div class="tc-c-in">${cont ? '' : head('', m.ts)}${rich(m.text ?? '', { assets, extra: m.html ?? '', hand: false })}${shots(m.attachments)}${files(m.attachments)}${m.details ? html`<details class="msg-details"><summary>Details</summary>${words(m.details)}</details>` : ''}</div></article>`
  const userMsg = (m, text = m.text) => html`<article class="msg msg-user tc-c" id="msg-${m.id}">${you}<div class="tc-c-in">${head('', m.ts, 'You')}${text ? html`<div class="bubble"><p>${text}</p></div>` : ''}${shots(m.attachments)}${files(m.attachments)}</div></article>`
  const isBare = m => (m.handback && m.text?.trim() === HAND_BACK_TEXT) || (m.explain && m.text?.trim() === EXPLAIN_TEXT)

  // ---- what the card did not hold ----
  const lead = []
  const whole = textOf(card)
  if (fitText(whole).more) lead.push(html`<article class="msg msg-agent tc-c tc-whole" id="card-whole-${card.id}">${mark}<div class="tc-c-in">${head('The whole text')}${rich(whole, { assets, extra: card.html ?? '', hand: false })}</div></article>`)
  else if (card.html) lead.push(html`<article class="msg msg-agent tc-c tc-whole" id="card-whole-${card.id}">${mark}<div class="tc-c-in">${head('With the text')}${rich('', { assets, extra: card.html })}</div></article>`)
  const secs = (card.sections ?? []).filter(s => s.key != null && (s.text || s.html))
  if (secs.length) lead.push(html`<details class="tc-fold tc-options-said"><summary>Options in detail</summary>${secs.map(s => html`<section class="tc-sec"><h3>${s.label}${s.recommended ? html` <span class="tc-advised-word">recommended</span>` : ''}</h3>${s.text ? rich(s.text, { assets, extra: s.html ?? '', hand: false }) : ''}</section>`)}</details>`)
  const links = optionLinks(card)
  if (String(links)) lead.push(links)
  if (card.status === 'open' && card.snoozed_until) lead.push(did(`You put it off: it waits on “${WORDS.later}”`, card.snoozed_at))

  // ---- the talk, in pieces ----
  const items = []   // { html, turn?: version, handback?, brought?: the version a hand-back brought }
  let askedAt = -1   // the hand-back that waits for its version
  for (let i = 0; i < all.length; i++) {
    const m = all[i]
    if (m.from === 'event') {
      if (m.kind === 'revised' && m.version) {
        const note = String(m.text ?? '').replace(/^Presented again:?\s*/i, '').trim()
        // A hand-back before it (the session may have answered it first): "as you asked".
        const asked = askedAt >= 0
        if (asked) items[askedAt].brought = m.version
        askedAt = -1
        const before = m.version > 1 && versionOf(card, m.version - 1)
        items.push({ turn: m.version, html: html`<div class="tc-turn" id="turn-${m.id}" data-version="${m.version}"><p class="tc-turn-head"><b>${m.again || m.version > 1 ? `Version ${m.version}` : 'Presented'}${asked ? ', as you asked' : ''}</b>${agoSpan(m.ts, 'msg-time')}</p>${note ? html`<p class="tc-turn-note">${note}</p>` : ''}${before ? html`<a class="tc-turn-before" data-nav href="${cardPath(card, base)}?v=${m.version - 1}">See version ${m.version - 1}</a>` : ''}</div>` })
      } else if (m.kind === 'handback_withdrawn') items.push({ html: did('You took it back', m.ts) })
      else if (m.kind === 'reopened') items.push({ html: did('Your answer was taken back: open again', m.ts) })
      continue
    }
    if (m.from === 'user' && m.present) { items.push({ html: did('You took it back', m.ts) }); askedAt = -1; continue }
    if (!m.text && !m.attachments?.length) continue
    if (m.from === 'user' && m.explain && isBare(m)) {
      // What?? and what the session answered to it, as one block.
      const answers = []
      while (all[i + 1] && all[i + 1].from === 'agent') answers.push(all[++i])
      items.push({ html: html`<section class="tc-explained">${did('You asked: What??', m.ts)}${answers.length ? answers.map((a, n) => agentMsg(a, n > 0)) : did('Waiting for the explanation.')}</section>` })
      continue
    }
    if (m.from === 'user') { if (m.handback) askedAt = items.length; items.push({ handback: Boolean(m.handback), html: userMsg(m, isBare(m) ? WORDS.revise : m.text === EXPLAIN_TEXT ? WORDS.what : m.text) }); continue }
    items.push({ html: agentMsg(m, items.at(-1)?.agent === true), agent: true })
    items.at(-1).agent = true
  }
  // ---- before the version that stands now: folded ----
  let lastTurn = items.findLastIndex(x => x.turn != null && x.turn > 1)
  const brought = lastTurn > 0 ? items.findIndex(x => x.brought === items[lastTurn].turn) : -1
  if (brought >= 0) lastTurn = brought   // the hand-back (and what was said after it) stays with the version it brought
  const earlier = lastTurn > 0 ? items.slice(0, lastTurn) : []
  const now = lastTurn > 0 ? items.slice(lastTurn) : items
  const turns = earlier.filter(x => x.turn != null).length
  const folded = earlier.length ? html`<details class="tc-fold tc-earlier"><summary>Earlier versions (${turns + 1})</summary>${earlier.map(x => x.html)}</details>` : ''
  // The talk is loaded newest page first: older comments come on request, at the top of the talk.
  const older = more ? html`<a class="tc-older" data-nav href="${cardPath(card, base)}?older=1#card-thread-${card.id}" data-turbo-action="replace">Earlier comments</a>` : ''
  // Between the card and the talk, one quiet centred line, only when it says something: why the card is urgent.
  // "<session> asked" opens a talk; alone it would say what the card's own line says already, so it is left out then.
  const why = card.urgency_reason ? html`<p class="tc-why">${sk('knock')}<span>${card.urgency_reason}</span></p>` : ''
  const any = lead.length || items.length || more
  return html`<section class="tc-feed" id="card-thread-${card.id}" aria-label="Comments"${why || any ? '' : raw(' hidden')}>${why}${any ? did(`${name} asked`, card.created) : ''}${lead}${older}${folded}${now.map(x => x.html)}</section>`
}

/** Where the card stands in the stack, for the walk: { at, of, prev, next } (cards), or null when it is not waiting. */
function placeOf(card, model) {
  const at = model.fresh.indexOf(card)
  return at < 0 ? null : { at: at + 1, of: model.fresh.length, prev: model.fresh[at - 1] ?? null, next: model.fresh[at + 1] ?? null }
}

/** The whole <main> of a card's page. pic: which picture stands. walk: a step of "Next, please". version: as it was
 *  then. from: the session it was opened from (/s/<id>/q/<n>): the way back and the links lead there. */
function cardPage(card, model, base, { pic = 1, walk = false, error = '', version = null, from = null, more: older = false } = {}) {
  const old = versionOf(card, version)
  const open = card.status === 'open' && !card.with_agent && !old
  // The draft and the pen stay while the card is with its session too: the reworked card comes back live into a page
  // whose form is not rendered again, and what is drawn or written meanwhile is kept for it.
  const drafting = card.status === 'open' && card.kind === 'decision' && !old
  const session = from ? model.byAgent.get(from) : null
  const home = session ? `${base}/s/${encodeURIComponent(session.id)}` : `${base}/`
  const self = session ? home : base
  const place = old ? null : placeOf(card, model)
  const query = `${walk ? '&walk=1' : ''}${old ? `&v=${old.n}` : ''}`
  const images = imagesOf(old ? { attachments: old.attachments ?? card.attachments } : card)
  const media = images.length + videosOf(old ? { attachments: old.attachments ?? card.attachments } : card).length
  const shownPic = Math.min(Math.max(1, pic), Math.max(1, media))
  const step = (to, cls, label, d) => (to ? html`<a class="tc-step-card ${cls}" data-nav href="${cardPath(to, self)}${walk ? '?walk=1' : ''}" aria-label="${label}: ${to.title}" title="${label}: ${to.title}">${icon(d)}</a>` : html`<span class="tc-step-card ${cls}" aria-hidden="true">${icon(d)}</span>`)
  const form = `card-form-${card.id}`
  const asker = model.byAgent.get(card.agent)?.name ?? ''
  const more = (cls, drawing, word, tip, action) => html`<button class="tc-more-item ${cls}" type="submit" form="${form}" formaction="${action}" title="${tip}">${sk(drawing)}<span>${word}</span></button>`
  return html`<main id="cardpage" class="tc-page" aria-label="Question ${card.number}" data-id="${card.id}" data-controller="card" data-card-draft-value="${drafting ? act(card, base, 'draft') : ''}" data-card-pictures-value="${JSON.stringify(picturesOf(old ? { ...card, attachments: old.attachments ?? card.attachments } : card, self))}" data-action="turbo:frame-load->card#framed circles:drawn->card#link turbo:submit-start->card#sent turbo:submit-end->card#done dragover->card#over drop->card#drop">
<nav class="tc-head" aria-label="Around this question">
<a class="tc-back" data-nav href="${home}" aria-keyshortcuts="Escape" title="Back to ${session ? session.name : WORDS.desk} · Esc" aria-label="Back to ${session ? session.name : WORDS.desk}">${BACK}</a>
${place ? html`<span class="tc-place">${step(place.prev, 'is-prev', 'The question before', ARROW_L)}<span class="tc-count" title="Where this question stands on the Desk">${place.at} of ${place.of}</span>${step(place.next, 'is-next', 'The next question', ARROW_R)}</span>` : ''}
<details class="tc-more" data-controller="pops"><summary class="tc-more-open" aria-label="More for this question">More ${sk('unfold')}</summary><div class="tc-more-list" role="menu">
${open && card.kind !== 'permission' && card.snoozed_until ? more('', 'wake', WORDS.wake, `${WORDS.wake}: back on the Desk now`, act(card, base, 'wake')) : ''}
${copyButton(card)}
${open && card.kind !== 'permission' ? more('is-shred', 'bin', WORDS.shred, `${WORDS.shred}: throw it away unanswered`, act(card, base, 'shred')) : ''}
</div></details>
</nav>
<article class="tc-card" id="card-${card.id}" data-id="${card.id}" data-kind="${card.kind}" data-urgency="${card.urgency}" aria-labelledby="card-title-${card.id}"${media ? raw(' data-pictures') : ''}>
${cardLeft(card, model, self, { version, pic: shownPic, query })}
<div class="tc-right">
${cardAnswer(card, model, base, { error, version, pic: shownPic })}
</div>
</article>
${open && card.kind !== 'permission' && !card.snoozed_until ? html`<form class="tc-later" data-action="pointerdown->card#pullStart click->card#pullClick" method="post" action="${base}/cards/batch" aria-label="Put this question off"><input type="hidden" name="ids" value="${card.id}"><input type="hidden" name="from" value="${card.id}">${session ? html`<input type="hidden" name="back" value="${home}">` : ''}${sideWays({ duck: false, shred: false })}</form>` : ''}
${cardThread(card, model, self, { more: older })}
<form class="tc-chat" id="${form}" aria-label="Write to the agent" method="post" action="${act(card, base, 'message')}" enctype="multipart/form-data" data-card-target="form">
${walk ? raw('<input type="hidden" name="walk" value="1">') : ''}${session ? html`<input type="hidden" name="back" value="${home}">` : ''}
${drafting ? html`<input type="hidden" name="marks" value="${JSON.stringify(card.draft?.marks ?? [])}" data-card-target="marks">` : ''}
<span class="tc-c-who is-you" aria-hidden="true">${sk('pen')}</span>
<div class="tc-ask"><div class="tc-chips" data-card-target="chips" hidden></div>
<textarea class="tc-field" id="card-field-${card.id}" data-card-target="field" data-action="input->card#typed keydown->card#keys paste->card#paste" name="note" rows="1" placeholder="${asker ? `Ask ${asker} something, or say what is missing…` : 'Ask something, or say what is missing…'}" autocomplete="off" enterkeyhint="send" aria-label="Write to the agent about this question. Send adds it to the talk; an answer takes it along as a note.">${card.draft?.note ?? ''}</textarea>
<div class="tc-ask-row"><label class="tc-clip" title="Attach files or pictures (or paste, or drop them on the card)">${sk('clip')}<span class="tc-sr">Attach files</span><input type="file" name="files" multiple hidden data-card-target="files" data-action="change->card#files"></label><span class="tc-saved" role="status" data-card-target="saved" hidden></span><button class="tc-send" type="submit" name="stay" value="1" title="Send to the agent (Enter); the question stays with you" aria-label="Send to the agent">${sk('send')}</button></div></div>
</form>
</main>`
}

/** One picture of a card, large, at its own address: the browser's Back closes it. from: the session it was opened from.
 *  The picture fits the width and scrolls (a tall screenshot is read top to bottom); a click on it shows it at its own
 *  size (scrolls both ways) and back. The card's answer stands beside it (a phone: a bar at the foot), the same buttons
 *  of the same form as on the card's page, so it can be decided while looking: an answer goes back to the Desk. */
function picturePage(card, model, base, at, { from = null } = {}) {
  const images = imagesOf(card)
  const i = Math.min(Math.max(1, at), images.length), a = images[i - 1]
  const session = from ? model.byAgent.get(from) : null
  const self = from ? `${base}/s/${encodeURIComponent(from)}` : base
  const here = cardPath(card, self)
  const form = `card-form-${card.id}`, zoom = `t-picture-zoom-${card.id}`
  const drafting = card.status === 'open' && card.kind === 'decision'
  const key = pictureKeys(card).get(i - 1)
  return html`<div class="t-picture is-deciding" data-id="${card.id}" data-controller="card" data-card-draft-value="${drafting ? act(card, base, 'draft') : ''}" data-card-pictures-value="${JSON.stringify(picturesOf(card, self))}">
<header class="t-picture-bar"><a class="tc-back t-picture-back" data-nav href="${here}?pic=${i}" data-card-target="gallery" data-back aria-label="Back to the question">${icon(ARROW_L)}<span>${card.title}</span></a>${where(a, i, images.length, 't-picture-where')}${pageChip(a.page, true)}</header>
<input type="checkbox" class="t-picture-zoom" id="${zoom}" hidden>
<div class="t-picture-view" tabindex="0" role="region" aria-label="The picture: scroll to see all of it"><label class="t-picture-fit" for="${zoom}" title="Click: its own size, or fit to the width" data-card-target="figure" data-at="${i}"${key != null ? html` data-key="${key}"` : ''} data-controller="circles" data-circles-marks-value="${JSON.stringify(a.marks ?? [])}"><img${srcOf(a)} alt="${a.name}" decoding="async"${a.width > 0 && a.height > 0 ? html` width="${a.width}" height="${a.height}"` : ''}></label></div>
${images.length > 1 ? html`<a class="tc-step is-prev" data-nav href="${here}/p/${i > 1 ? i - 1 : images.length}" data-turbo-action="replace" aria-label="The picture before">${icon(ARROW_L)}</a><a class="tc-step is-next" data-nav href="${here}/p/${i < images.length ? i + 1 : 1}" data-turbo-action="replace" aria-label="The next picture">${icon(ARROW_R)}</a><nav class="t-picture-strip" aria-label="The pictures of this question">${strip(images, i, n => `${here}/p/${n}`)}</nav>` : ''}
<aside class="t-picture-answer" aria-label="Your answer" data-kind="${card.kind}">${cardAnswer(card, model, base, { pic: i })}${card.status === 'open' && !card.with_agent && card.kind !== 'permission' ? html`<button class="tc-way t-picture-later" type="submit" form="${form}" formaction="${act(card, base, 'snooze')}" title="${WORDS.later}: it waits for you on &quot;Later&quot;">${sk('snooze')}<span>${WORDS.later}</span></button>` : ''}</aside>
<form id="${form}" method="post" action="${act(card, base, 'message')}" hidden data-card-target="form">${session ? html`<input type="hidden" name="back" value="${self}">` : ''}${drafting ? html`<input type="hidden" name="marks" value="${JSON.stringify(card.draft?.marks ?? [])}"><input type="hidden" name="note" value="${card.draft?.note ?? ''}">` : ''}</form>
</div>`
}

// ---- focus marks ----
// Writing and scribbling anywhere on a question card (the Focus window, behind its flag).
//
// The card itself is the surface. A click on what is asked (a paragraph, the title, empty space) puts a caret
// there: a small note that stays with what was clicked. The pen scribbles over everything that scrolls. Both
// are "marks":
//   { id, anchor: { kind: 'card' | 'text' | 'option', key?, quote? }, text }               a written note
//   { id, anchor: { kind: 'card' }, strokes: [{ color, pts: [x0, y0, x1, y1, …] }] }          a scribble
// A note on a piece of the text carries how that piece begins (quote), to find it again after a rewording; a
// paragraph that is an option counts as that option. Stroke points are fractions of the content's WIDTH (y too), so a scribble keeps its place while the
// column keeps its width and scales with it otherwise.
//
//   const marks = cardMarks({ scroll, blocks(), labelOf(key), onChange() })
//   marks.controls            the pen, the eraser, undo: put them on the card
//   marks.get() / set(list)   the marks, plain data (for the card's draft)
//   marks.note(anchor)        begin a note there (the keyboard's way in; a click on the content does it by itself)
//   marks.text()              the written notes for the agent, each with what it refers to; '' when there are none
//   marks.optionNotes()       { key: text } for notes written on options
//   marks.picture()           Promise<PNG data URL | null>: the card as the human sees it, notes and scribbles drawn in
//   marks.count()

const NS = 'http://www.w3.org/2000/svg'
const newId = () => Math.random().toString(36).slice(2, 10)
const INK = ['var(--urg-high)', 'var(--accent)']

function cardMarks({ scroll, blocks, labelOf, onChange }) {
  let list = []
  let pen = false, erasing = false, ink = 0
  let drawing = null

  // ── the layer the scribbles lie on: as large as what scrolls, scrolling with it ──
  const layer = document.createElementNS(NS, 'svg')
  layer.setAttribute('class', 'focus-ink')
  layer.setAttribute('aria-hidden', 'true')
  scroll.append(layer)
  const width = () => scroll.clientWidth || 1
  const fit = () => { layer.style.height = '0px'; layer.style.height = `${scroll.scrollHeight}px`; paintInk() }
  new ResizeObserver(fit).observe(scroll)

  const pathOf = pts => {
    const w = width()
    let d = ''
    for (let i = 0; i < pts.length; i += 2) d += `${i ? 'L' : 'M'}${(pts[i] * w).toFixed(1)} ${(pts[i + 1] * w).toFixed(1)}`
    return d
  }
  function paintInk() {
    const nodes = []
    for (const mark of list) for (const [at, stroke] of (mark.strokes ?? []).entries()) {
      const path = document.createElementNS(NS, 'path')
      path.setAttribute('d', pathOf(stroke.pts))
      path.style.stroke = stroke.color
      path.dataset.mark = mark.id
      path.dataset.at = at
      nodes.push(path)
    }
    layer.replaceChildren(...nodes)
  }
  const point = e => { const box = scroll.getBoundingClientRect(); return [(e.clientX - box.left + scroll.scrollLeft) / width(), (e.clientY - box.top + scroll.scrollTop) / width()] }

  layer.addEventListener('pointerdown', e => {
    if (!pen || e.button) return
    e.preventDefault()
    if (erasing) return rub(e)
    layer.setPointerCapture(e.pointerId)
    let mark = list.findLast(m => m.strokes)
    if (!mark) { mark = { id: `pen-${newId()}`, anchor: { kind: 'card' }, strokes: [] }; list.push(mark) }
    drawing = { mark, stroke: { color: INK[ink], pts: point(e) } }
    mark.strokes.push(drawing.stroke)
    paintInk()
  })
  layer.addEventListener('pointermove', e => {
    if (erasing && e.buttons & 1) return rub(e)
    if (!drawing) return
    const [x, y] = point(e), pts = drawing.stroke.pts
    if (Math.hypot(x - pts.at(-2), y - pts.at(-1)) * width() < 2) return
    pts.push(Number(x.toFixed(4)), Number(y.toFixed(4)))
    layer.lastElementChild?.setAttribute('d', pathOf(pts))
  })
  const lift = () => { if (!drawing) return; if (drawing.stroke.pts.length < 4) drawing.mark.strokes.pop(); drawing = null; changed() }
  layer.addEventListener('pointerup', lift)
  layer.addEventListener('pointercancel', lift)
  function rub(e) {
    const hit = document.elementFromPoint(e.clientX, e.clientY)
    if (!(hit instanceof SVGPathElement) || hit.parentNode !== layer) return
    const mark = list.find(m => m.id === hit.dataset.mark)
    mark?.strokes.splice(Number(hit.dataset.at), 1)
    changed()
  }

  // ── the controls: the pen, a second colour, the eraser, undo ──
  const control = (cls, label, drawingName, act) => {
    const b = el('button', `focus-mark-tool ${cls}`)
    b.type = 'button'
    b.title = label
    b.setAttribute('aria-label', label)
    b.append(sketch(drawingName))
    b.addEventListener('click', act)
    return b
  }
  const penBtn = control('focus-mark-pen', 'Draw on the card (D)', 'pen', () => setPen(!pen))
  // While the pen is in the hand the row says so, and offers the way out and a clean sheet.
  const state = el('span', 'focus-mark-state', 'Drawing')
  const doneBtn = el('button', 'focus-mark-done', 'Done')
  doneBtn.type = 'button'
  doneBtn.title = 'Stop drawing (Esc)'
  doneBtn.addEventListener('click', () => setPen(false))
  const clearBtn = el('button', 'focus-mark-clear', 'Clear drawing')
  clearBtn.type = 'button'
  clearBtn.addEventListener('click', () => { for (const m of list) if (m.strokes) m.strokes = []; changed(); paintTools() })
  const inkBtn = control('focus-mark-ink', 'The other colour', 'pen', () => { ink = (ink + 1) % INK.length; erasing = false; paintTools() })
  const rubBtn = control('focus-mark-rub', 'Eraser: rub a line away', 'no', () => { erasing = !erasing; paintTools() })
  const undoBtn = control('focus-mark-undo', 'Undo the last line', 'back', () => { const mark = list.findLast(m => m.strokes?.length); mark?.strokes.pop(); changed() })
  const controls = el('span', 'focus-mark-tools')
  controls.append(penBtn, state, undoBtn, rubBtn, inkBtn, clearBtn, doneBtn)
  function paintTools() {
    penBtn.setAttribute('aria-pressed', String(pen))
    rubBtn.setAttribute('aria-pressed', String(erasing))
    inkBtn.style.color = INK[ink]
    inkBtn.hidden = rubBtn.hidden = undoBtn.hidden = state.hidden = doneBtn.hidden = !pen
    // a drawing that is there can be cleared without taking the pen up first
    clearBtn.hidden = !pen || !list.some(m => m.strokes?.length)
    controls.toggleAttribute('data-pen', pen)
    layer.toggleAttribute('data-pen', pen)
    layer.toggleAttribute('data-rub', pen && erasing)
  }
  function setPen(on) { pen = on; erasing = false; quill.hidden = true; paintTools() }

  // ── written notes ──
  const anchorOf = target => {
    const all = blocks()
    const block = all.find(b => b.contains(target))
    if (!block || block.classList.contains('focus-title')) return null
    if (block.dataset.key) return { kind: 'option', key: block.dataset.key }
    return { kind: 'text', quote: block.textContent.trim().replace(/\s+/g, ' ').slice(0, 48) }
  }
  /** Where a note of that anchor stands: after its block, under its option, or at the end of the text. */
  function placeOf(anchor) {
    if (anchor.kind === 'text') return blocks().find(b => !b.classList.contains('focus-mark') && b.textContent.trim().replace(/\s+/g, ' ').startsWith(anchor.quote ?? '\u0000')) ?? null
    if (anchor.kind === 'option') return scroll.closest('.focus-card')?.querySelector(`.focus-opt[data-key="${CSS.escape(anchor.key)}"]`) ?? null
    return null
  }
  const noteNodes = new Map()   // mark id -> node
  function paintNotes() {
    for (const [id, node] of noteNodes) if (!list.some(m => m.id === id && m.text != null)) { node.remove(); noteNodes.delete(id) }
    for (const mark of list) {
      if (mark.text == null) continue
      let node = noteNodes.get(mark.id)
      if (!node) {
        node = el('label', 'focus-mark')
        const field = el('textarea')
        field.rows = 1
        field.placeholder = 'Write here'
        field.setAttribute('aria-label', mark.anchor.kind === 'option' ? `Note on ${labelOf(mark.anchor.key)}` : 'Note on this place')
        const grow = () => { field.style.height = 'auto'; field.style.height = `${field.scrollHeight}px` }
        field.addEventListener('input', () => { mark.text = field.value; grow(); onChange() })
        // Enter finishes the note, Shift+Enter breaks the line, Escape leaves; an empty note is gone.
        field.addEventListener('keydown', e => {
          if (e.key === 'Escape' || (e.key === 'Enter' && !e.shiftKey && !e.isComposing)) { e.preventDefault(); e.stopPropagation(); field.blur() }
        })
        field.addEventListener('blur', () => { if (!field.value.trim()) { list = list.filter(m => m !== mark); changed() } })
        node.append(sketch('pen'), field)
        node.grow = grow
        noteNodes.set(mark.id, node)
      }
      const field = node.querySelector('textarea')
      if (document.activeElement !== field && field.value !== mark.text) field.value = mark.text
      const place = placeOf(mark.anchor)
      node.dataset.kind = mark.anchor.kind
      const home = place ?? scroll.querySelector('.focus-body, .focus-lead')
      if (node.previousElementSibling !== home && !(node.previousElementSibling?.classList.contains('focus-mark') && node.isConnected)) home?.after(node)
      node.grow()
    }
  }
  function note(anchor) {
    if (!anchor || anchor.kind === 'card') return   // words about the whole card go into the field at its foot
    // one note per place: a second click there goes on writing the first
    let mark = list.find(m => m.text != null && m.anchor.kind === anchor.kind && m.anchor.key === anchor.key && (anchor.kind !== 'text' || m.anchor.quote === anchor.quote))
    if (!mark) { mark = { id: newId(), anchor, text: '' }; list.push(mark) }
    paintNotes()
    noteNodes.get(mark.id)?.querySelector('textarea').focus({ preventScroll: false })
  }
  // A click on what is asked begins a note there. Not on what does something itself (a link, a button, a picture
  // that opens large, a field), not while text is being selected, not while the pen is in the hand.
  // A note never begins by a plain click on the text (that happens by accident while reading and selecting). Under
  // the pointer a paragraph shows a small pencil in its margin; the pencil begins the note. Selecting text in a
  // paragraph shows the same pencil.
  const quill = el('button', 'focus-mark-quill')
  quill.type = 'button'
  quill.title = 'Write a note on this paragraph'
  quill.setAttribute('aria-label', 'Write a note on this paragraph')
  quill.append(sketch('pen'))
  quill.hidden = true
  scroll.append(quill)
  let quillAt = null
  const offer = block => {
    if (pen || !block || block.classList.contains('focus-title') || block.dataset.key) { if (!quill.matches(':hover')) quill.hidden = true; return }
    quillAt = block
    const box = scroll.getBoundingClientRect(), r = block.getBoundingClientRect()
    quill.style.left = `${Math.max(2, r.left - box.left + scroll.scrollLeft - 28)}px`
    quill.style.top = `${r.top - box.top + scroll.scrollTop}px`
    quill.hidden = false
  }
  scroll.addEventListener('pointerover', e => { if (e.target === quill || quill.contains(e.target)) return; offer(blocks().find(b => b.contains(e.target))) })
  scroll.addEventListener('pointerleave', () => { quill.hidden = true })
  // (The page is swapped without a reload: once the card is gone, this listener goes too, not one more per card opened.)
  document.addEventListener('selectionchange', function selected() {
    if (!scroll.isConnected) return document.removeEventListener('selectionchange', selected)
    const sel = getSelection()
    if (!sel || sel.isCollapsed || !scroll.contains(sel.anchorNode)) return
    offer(blocks().find(b => b.contains(sel.anchorNode)))
  })
  quill.addEventListener('click', () => { if (!quillAt) return; quill.hidden = true; note(anchorOf(quillAt)) })

  function changed() {
    list = list.filter(m => m.text != null || m.strokes?.length)
    paintInk()
    paintNotes()
    paintTools()
    onChange()
  }

  // ── what the agent gets ──
  const refer = anchor => (anchor.kind === 'option' ? `on option "${labelOf(anchor.key)}"` : anchor.kind === 'text' ? `on the paragraph beginning "${anchor.quote}"` : 'general')
  const written = () => list.filter(m => m.text?.trim())
  function text() {
    const notes = written().filter(m => m.anchor.kind !== 'option')
    if (!notes.length) return ''
    if (notes.length === 1 && notes[0].anchor.kind === 'card') return notes[0].text.trim()
    return notes.map(m => `${refer(m.anchor)}: ${m.text.trim()}`).join('\n')
  }
  const optionNotes = () => Object.fromEntries(written().filter(m => m.anchor.kind === 'option').map(m => [m.anchor.key, m.text.trim()]))

  /** The card as the human sees it, with notes and scribbles: what scrolls is copied with its looks written into
   *  every element, its pictures taken in as data, laid into an SVG and painted on a canvas at twice the size.
   *  Where a browser will not hand such a canvas out (Safari taints it), the notes and the scribbles are painted
   *  plainly on paper instead. */
  async function picture() {
    const w = scroll.clientWidth, h = Math.min(scroll.scrollHeight, 6000)
    const scale = 2
    const done = canvas => { try { return canvas.toDataURL('image/png') } catch { return null } }
    try {
      const copy = scroll.cloneNode(true)
      const from = [scroll, ...scroll.querySelectorAll('*')], to = [copy, ...copy.querySelectorAll('*')]
      for (let i = 0; i < from.length; i++) {
        const a = from[i], b = to[i]
        if (!(b instanceof HTMLElement || b instanceof SVGElement)) continue
        const style = getComputedStyle(a)
        let css = ''
        for (const prop of style) css += `${prop}:${style.getPropertyValue(prop)};`
        b.setAttribute('style', css)
        if (b instanceof HTMLTextAreaElement) b.textContent = a.value
        if (b instanceof HTMLIFrameElement) { const box = el('div'); box.setAttribute('style', `${css}background:#eee;`); b.replaceWith(box) }
      }
      copy.style.overflow = 'visible'
      copy.style.height = `${h}px`
      copy.style.maxHeight = 'none'
      copy.style.background = getComputedStyle(scroll.closest('.focus-card') ?? scroll).backgroundColor
      await Promise.all([...copy.querySelectorAll('img')].map(async img => {
        try {
          const blob = await (await fetch(img.src)).blob()
          img.src = await new Promise((resolve, reject) => { const r = new FileReader(); r.onload = () => resolve(r.result); r.onerror = reject; r.readAsDataURL(blob) })
        } catch { img.removeAttribute('src') }
      }))
      copy.setAttribute('xmlns', 'http://www.w3.org/1999/xhtml')
      const svg = `<svg xmlns="${NS}" width="${w}" height="${h}"><foreignObject width="100%" height="100%">${new XMLSerializer().serializeToString(copy)}</foreignObject></svg>`
      const image = new Image()
      await new Promise((resolve, reject) => { image.onload = resolve; image.onerror = reject; image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}` })
      const canvas = document.createElement('canvas')
      canvas.width = w * scale
      canvas.height = h * scale
      const c = canvas.getContext('2d')
      c.fillStyle = '#fff'
      c.fillRect(0, 0, canvas.width, canvas.height)
      c.drawImage(image, 0, 0, canvas.width, canvas.height)
      const out = done(canvas)
      if (out) return out
    } catch {}
    // the plain way: paper, the notes as lines of text, the scribbles where they were drawn
    const canvas = document.createElement('canvas')
    canvas.width = w * scale
    canvas.height = h * scale
    const c = canvas.getContext('2d')
    c.scale(scale, scale)
    c.fillStyle = '#fff'
    c.fillRect(0, 0, w, h)
    c.fillStyle = '#222'
    c.font = '16px system-ui, sans-serif'
    let y = 28
    for (const line of [text(), ...Object.entries(optionNotes()).map(([key, t]) => `on option "${labelOf(key)}": ${t}`)].join('\n').split('\n')) { c.fillText(line, 16, y); y += 22 }
    c.lineWidth = 2.5
    c.lineCap = c.lineJoin = 'round'
    for (const mark of list) for (const stroke of mark.strokes ?? []) {
      c.strokeStyle = '#b4531a'
      c.beginPath()
      for (let i = 0; i < stroke.pts.length; i += 2) c[i ? 'lineTo' : 'moveTo'](stroke.pts[i] * w, stroke.pts[i + 1] * w)
      c.stroke()
    }
    return done(canvas)
  }

  paintTools()
  return {
    controls, note, text, optionNotes, picture, setPen,
    penOn: () => pen,
    get: () => list.map(m => ({ ...m, strokes: m.strokes?.map(s => ({ color: s.color, pts: [...s.pts] })) })),
    set(next) {
      list = (Array.isArray(next) ? next : []).filter(m => m && m.id && m.anchor && !(m.anchor.kind === 'card' && m.text != null) && !(m.strokes && m.text == null && !String(m.id).startsWith('pen-'))).map(m => ({ id: m.id, anchor: m.anchor, ...(m.text != null ? { text: String(m.text) } : {}), ...(m.strokes ? { strokes: m.strokes } : {}) }))
      fit()
      paintNotes()
      paintTools()
    },
    count: () => list.filter(m => m.text?.trim() || m.strokes?.length).length,
    refit: fit,
  }
}

// ---- controller "card" ----
// A card's page (card.mjs). The page works without this: every answer is a button of one form.
// This adds what needs a script: the pencil that opens the note on one option, the draft kept on the hub while
// typing, Enter that sends, the names of attached files (also pasted or dropped), and the arrow of the pen from
// the picture shown to the option it belongs to.

const clamp = (n, lo, hi) => Math.min(Math.max(n, lo), hi)
let turn = 0
const GROWS = globalThis.CSS?.supports?.('field-sizing', 'content') ?? false

controller('card', class extends Controller {
  static targets = ['form', 'field', 'files', 'chips', 'saved', 'figure', 'marks', 'where', 'page', 'gallery', 'zoom']
  static values = { draft: String, pictures: Array }

  connect() {
    this.grow()
    if (this.hasMarksTarget) this.mountMarks()
    this.link = this.link.bind(this)
    addEventListener('resize', this.link)
    this.element.addEventListener('scroll', this.link, { capture: true, passive: true })
    this.link()
  }
  disconnect() {
    removeEventListener('resize', this.link)
    this.element.removeEventListener('scroll', this.link, { capture: true })
    clearTimeout(this.timer)
  }

  // ---- marks: draw on the card with the pen, write a note at a paragraph (the old client's card.mjs) ----
  // They travel in the form's field "marks" with whatever is pressed, and in the draft while nothing is.
  async mountMarks() {

    const left = this.element.querySelector('.tc-left')
    if (!left || !this.element.isConnected || this.marksUi) return
    const labels = new Map([...this.element.querySelectorAll('.tc-opt[data-key]')].map(b => [b.dataset.key, b.querySelector('.tc-opt-label')?.textContent ?? b.dataset.key]))
    this.marksUi = cardMarks({
      scroll: left,
      blocks: () => [...left.querySelectorAll('.tc-title, .tc-text .rich > *, .focus-mark')],
      labelOf: key => labels.get(key) ?? key,
      onChange: () => { this.marksTarget.value = JSON.stringify(this.marksUi.get()); this.keep() },
    })
    try { this.marksUi.set(JSON.parse(this.marksTarget.value || '[]')) } catch {}
    this.element.querySelector('.tc-ask-row .tc-clip')?.after(this.marksUi.controls)
  }

  // ---- the pictures and the options are one thing ----
  // While the pointer or the keyboard is on an option, its picture stands on the stage and its small picture is
  // marked; on a small picture, that picture stands there and its option is marked. Leaving puts back what stood.
  // A click on a small picture makes it the one that stands (its link). A finger has no hover: a tap on a small
  // picture shows it and marks its option; a tap on an option answers, as before.
  preview(event) {
    if (event.pointerType === 'touch') return
    const key = event.target.closest?.('.tc-opt[data-key]')?.dataset.key
    const pic = key != null && this.picturesValue.find(p => (p.keys ?? [p.key]).includes(key))
    if (pic) this.stage(pic, key)
  }
  peek(event) {
    if (event.pointerType === 'touch') return
    const pic = this.picturesValue.find(p => p.at === Number(event.target.closest?.('.tc-thumb[data-at]')?.dataset.at))
    if (pic) this.stage(pic)
  }
  unpreview(event) {
    if (event.relatedTarget instanceof Element && event.currentTarget.contains(event.relatedTarget)) return
    if (this.stood) { const back = this.stood; this.stood = null; this.stage(back.pic, back.key, true) }
  }
  // key: the option the picture stands for now (a picture several options share points at the one under the pointer).
  stage(pic, key = pic.key, restoring = false) {
    if (!this.hasFigureTarget || !pic) return
    const fig = this.figureTarget, img = fig.querySelector('img')
    const now = Number(fig.dataset.at)
    if (!restoring && !this.stood) this.stood = { pic: this.picturesValue.find(p => p.at === now), key: fig.dataset.key ?? null }
    if (key != null) fig.dataset.key = key; else delete fig.dataset.key
    const thumbs = [...this.element.querySelectorAll('.tc-thumb[data-at]')]
    for (const t of thumbs) t.toggleAttribute('data-peek', !restoring && Number(t.dataset.at) === pic.at)
    if (now === pic.at) return this.link()
    img.src = pic.src
    if (img.hasAttribute('width')) { if (pic.width && pic.height) { img.width = pic.width; img.height = pic.height } else { img.removeAttribute('width'); img.removeAttribute('height') } }
    else img.style.width = pic.width ? `${pic.width}px` : ''
    fig.dataset.at = pic.at
    fig.dataset.circlesMarksValue = JSON.stringify(pic.marks ?? [])
    if (this.hasWhereTarget) {
      const n = thumbs.length || this.picturesValue.length
      this.whereTarget.replaceChildren(...(n > 1 ? [el('b', '', `${pic.at} / ${n}`), ' '] : []), el('span', '', `${pic.name}${pic.title ? ` · ${pic.title}` : ''}`))
    }
    if (this.hasPageTarget) {
      this.pageTarget.hidden = !pic.page
      if (pic.page) { this.pageTarget.href = pic.page.url; this.pageTarget.querySelector('b').textContent = pic.page.name }
    }
    // (the way to the gallery opens the picture that stands; the gallery's way back returns to it)
    if (this.hasGalleryTarget) this.galleryTarget.href = 'back' in this.galleryTarget.dataset ? pic.href.replace(/\/p\/(\d+)$/, '?pic=$1') : pic.href
    img.addEventListener('load', () => this.link(), { once: true })
    this.link()
  }
  // ---- Later is a pull: the tag under the card is drawn down (mouse or finger), the card follows the string; let go
  // past the threshold (or a plain press) and the card is pulled off the page, then the next one comes; let go before
  // it and both spring back. Reduced motion: nothing moves, the press does it.
  pullStart(event) {
    const tag = event.target.closest?.('.sel-later')
    if (!tag || event.button > 0 || this.pulling) return
    const card = this.element.querySelector('.tc-card'), y0 = event.clientY, calm = matchMedia('(prefers-reduced-motion: reduce)').matches
    let dy = 0
    const set = v => { dy = v; tag.style.setProperty('--pull', `${v}px`); if (card && !calm) card.style.translate = `0 ${(v * .4).toFixed(1)}px` }
    tag.setPointerCapture(event.pointerId)
    tag.classList.add('is-pulling')
    if (card) card.style.transition = 'none'
    const move = e => set(clamp(e.clientY - y0, 0, 240))
    const up = e => {
      tag.removeEventListener('pointermove', move); tag.removeEventListener('pointerup', up); tag.removeEventListener('pointercancel', up)
      tag.classList.remove('is-pulling')
      if (dy > 6) { this.dragged = true; setTimeout(() => { this.dragged = false }, 0) }   // (the click that follows a drag is not a press)
      if (e.type === 'pointerup' && dy > 72) return this.pullAway(tag)
      if (card) card.style.transition = 'translate 320ms cubic-bezier(.3, 1.7, .5, 1)'
      set(0)
    }
    tag.addEventListener('pointermove', move); tag.addEventListener('pointerup', up); tag.addEventListener('pointercancel', up)
  }
  pullClick(event) {
    const tag = event.target.closest?.('.sel-later')
    if (!tag || this.going) return
    event.preventDefault()
    if (!this.dragged && !this.pulling) this.pullAway(tag)
  }
  pullAway(tag) {
    this.pulling = true
    const go = () => { this.going = true; tag.form.requestSubmit(tag) }
    const card = this.element.querySelector('.tc-card')
    if (!card || matchMedia('(prefers-reduced-motion: reduce)').matches) return go()
    const from = parseFloat(card.style.translate.split(' ')[1]) || 0, far = innerHeight
    const how = { duration: 300, easing: 'cubic-bezier(.55, 0, .9, .45)', fill: 'forwards' }
    tag.animate([{ translate: `0 ${tag.style.getPropertyValue('--pull') || '0px'}` }, { translate: `0 ${far + 120}px` }], how)
    card.animate([{ translate: `0 ${from}px` }, { translate: `0 ${far}px`, rotate: '1.2deg' }], how).finished.then(go, go)
  }
  // "+": the whole picture, right here on the card (and back to its top). Never another page.
  enlarge(event) {
    event.preventDefault()
    this.large = !this.large
    this.sized()
  }
  sized() {
    this.element.querySelector('.tc-stage')?.classList.toggle('is-large', Boolean(this.large))
    if (this.hasZoomTarget) { this.zoomTarget.setAttribute('aria-pressed', String(Boolean(this.large))); this.zoomTarget.title = this.large ? 'Smaller again: only its top' : 'Bigger, right here' }
    this.link()
  }
  // (another picture came into the frame: it is the one that stands now, at the size the last one had)
  framed() { this.stood = null; this.sized() }

  // ---- the note on one option: the pencil opens its line ----
  note(event) {
    event.preventDefault()
    event.stopPropagation()
    const row = this.element.querySelector(`.tc-opt-note[data-note="${CSS.escape(event.currentTarget.dataset.key)}"]`)
    if (!row) return
    row.hidden = false
    row.querySelector('input').focus()
  }
  // (left empty, the line goes again; Enter in it is no answer)
  noteLeft({ currentTarget }) {
    const row = currentTarget.closest('.tc-opt-note'), said = currentTarget.value.trim()
    if (!said) row.hidden = true
    this.element.querySelector(`.tc-opt-pen[data-key="${CSS.escape(row.dataset.note)}"]`)?.toggleAttribute('data-noted', Boolean(said))
  }
  noteKey(event) { if (event.key === 'Enter') { event.preventDefault(); event.currentTarget.blur() } }

  // ---- the field ----
  typed() { this.grow(); this.keep() }
  // (Where the browser sizes a field to its content itself (field-sizing, cardpage.css), no measuring: it cost a forced layout per page.)
  grow() { if (GROWS) return; const f = this.hasFieldTarget ? this.fieldTarget : null; if (f) { f.style.height = 'auto'; f.style.height = `${Math.min(f.scrollHeight, 220)}px` } }
  // Enter sends, Shift+Enter is a new line.
  keys(event) {
    if (event.key !== 'Enter' || event.shiftKey || event.isComposing || (!this.fieldTarget.value.trim() && !this.filesTarget.files.length)) return
    event.preventDefault()
    this.formTarget.requestSubmit(this.formTarget.querySelector('.tc-send'))
  }

  // ---- the draft: what is ticked and written is kept on the hub a moment after the last stroke ----
  keep() {
    if (!this.draftValue) return
    clearTimeout(this.timer)
    this.timer = setTimeout(() => this.save(), 700)
  }
  async save() {
    const body = new URLSearchParams()
    for (const [name, value] of new FormData(this.formTarget)) if (typeof value === 'string' && (name === 'note' || name === 'keys' || name === 'marks' || name.startsWith('note-'))) body.append(name, value)
    const say = (state, words) => { if (this.hasSavedTarget) { this.savedTarget.hidden = false; this.savedTarget.dataset.state = state; this.savedTarget.textContent = words } }
    try {
      const res = await fetch(this.draftValue, { method: 'POST', body })
      say(res.ok ? 'saved' : 'failed', res.ok ? 'Saved' : 'Not saved')
    } catch { say('failed', 'Not saved') }
  }
  // (an answer is on its way: a save that is still waiting must not come after it)
  sent() { clearTimeout(this.timer) }
  // A message sent with Send stays on the page (the comment comes in live under the card): the field, the files and
  // the marks that went along are emptied here. (Ticks and notes on options stay: they belong to the answer.)
  done(event) {
    const { formSubmission, success } = event.detail ?? {}
    if (!success || !formSubmission?.submitter?.classList.contains('tc-send')) return
    if (this.hasFieldTarget) { this.fieldTarget.value = ''; this.grow() }
    if (this.hasFilesTarget) { this.filesTarget.value = ''; this.files() }
    if (this.marksUi && this.hasMarksTarget) { this.marksUi.set([]); this.marksTarget.value = '[]' }
  }

  // ---- files: chosen, pasted or dropped ----
  files() {
    const list = [...this.filesTarget.files]
    this.chipsTarget.hidden = !list.length
    this.chipsTarget.replaceChildren(...list.map(f => { const chip = document.createElement('span'); chip.className = 'focus-chip'; chip.textContent = f.name; return chip }))
    if (list.length) {
      const drop = document.createElement('button')
      drop.type = 'button'; drop.className = 'focus-chip t-chip-drop'; drop.textContent = 'Remove'
      drop.addEventListener('click', () => { this.filesTarget.value = ''; this.files() })
      this.chipsTarget.append(drop)
    }
  }
  add(list) {
    const all = new DataTransfer()
    for (const f of [...this.filesTarget.files, ...list]) all.items.add(f)
    this.filesTarget.files = all.files
    this.files()
  }
  paste(event) { const got = [...(event.clipboardData?.files ?? [])]; if (got.length) { event.preventDefault(); this.add(got) } }
  over(event) { if (event.dataTransfer?.types.includes('Files')) event.preventDefault() }
  drop(event) { const got = [...(event.dataTransfer?.files ?? [])]; if (got.length) { event.preventDefault(); this.add(got) } }

  // ---- the arrow: one line of the pen from the picture shown to the option it belongs to ----
  // The picture names its option (data-key); the option is marked (data-match) and, where the answers stand beside
  // the picture and both ends are in sight, the arrow is drawn into the option's left edge.
  link() {
    const picture = this.hasFigureTarget ? this.figureTarget : null, key = picture?.dataset.key
    for (const b of this.element.querySelectorAll('.tc-opt[data-key]')) b.toggleAttribute('data-match', key != null && b.dataset.key === key)
    const host = this.element.querySelector('.tc-card')
    if (!host) return   // (the gallery: the option is marked, no arrow)
    const tile = host.querySelector('.tc-opt[data-match]'), answer = host.querySelector('.tc-right'), scroll = host.querySelector('.tc-left')
    const old = host.querySelector(':scope > .focus-arrow')
    const gone = () => { old?.remove(); this.arrowSig = '' }
    if (!picture || !tile || !answer || !scroll) return gone()
    const base = host.getBoundingClientRect()
    const box = n => { const r = n.getBoundingClientRect(); return { x: r.left - base.left, y: r.top - base.top, w: r.width, h: r.height } }
    const P = box(picture.closest('.tc-stage') ?? picture), T = box(tile), A = box(answer), F = box(scroll), L = box(tile.parentElement)
    if (A.x < P.x + P.w - 1) return gone()   // a narrow window: the answers stand under the pictures
    const top = Math.max(P.y, F.y), bottom = Math.min(P.y + P.h, F.y + F.h)
    if (!P.w || bottom - top < 70 || T.y < L.y - 2 || T.y + T.h > L.y + L.h + 2) return gone()
    const ring = picture.querySelector(':scope > .focus-circles > path')?.getBoundingClientRect()
    const sig = [P.x, top, P.w, T.x, T.y, T.h, ring?.right ?? 0, ring?.top ?? 0].map(Math.round).join()
    if (sig === this.arrowSig && old) return
    this.arrowSig = sig
    old?.remove()
    const mid = T.y + T.h / 2
    // (it starts at the first circle where the agent marked a region, else near the picture's edge)
    const from = ring?.width ? [ring.right - base.left - 2, clamp(ring.top - base.top + ring.height / 2, top + 6, bottom - 6)] : [P.x + P.w - 30, clamp(mid - 46, Math.min(top + 62, bottom - 22), bottom - 22)]   // (under the "+" in its corner)
    const gx = Math.max(P.x + P.w + 12, T.x - 26)   // down the gap just before the options, never across the words
    const points = [from, [P.x + P.w - 6, from[1] + 5], [gx - 8, from[1] + 9], [gx + 4, from[1] + (mid - from[1]) * .45], [gx + 6, mid - (mid > from[1] ? 14 : -14)], [gx + 12, mid - (mid > from[1] ? 3 : -3)], [T.x - 2, mid]]
    const svg = document.createElementNS(NS, 'svg')
    svg.setAttribute('class', 'focus-arrow')
    svg.setAttribute('aria-hidden', 'true')
    for (const d of arrowStrokes(points, `${tile.dataset.key}:${turn++}`)) { const path = document.createElementNS(NS, 'path'); path.setAttribute('d', d); svg.append(path) }
    host.append(svg)
  }
})

// ---- controller "circles" ----
// The regions an agent marked on a picture (marks: [{ x, y, w, h, label? }] in fractions of the picture): each is
// circled with the pen over the picture as it is shown, its label beside it. The element holds the <img>.

controller('circles', class extends Controller {
  static values = { marks: Array }
  connect() {
    this.img = this.element.querySelector('img')
    if (!this.img) return
    this.layer = document.createElementNS(NS, 'svg')
    this.layer.setAttribute('class', 'focus-circles')
    this.layer.setAttribute('aria-hidden', 'true')
    if (getComputedStyle(this.element).position === 'static') this.element.style.position = 'relative'
    this.element.append(this.layer)
    this.draw = this.draw.bind(this)
    this.sizes = new ResizeObserver(this.draw)
    this.sizes.observe(this.img)
    this.img.addEventListener('load', this.draw)
    this.draw()
  }
  disconnect() { this.sizes?.disconnect(); this.img?.removeEventListener('load', this.draw); this.layer?.remove() }
  // (The card puts another picture on the stage with its marks: drawn anew.)
  marksValueChanged() { if (this.layer) this.draw() }
  draw() {
    const img = this.img, w = img.offsetWidth, h = img.offsetHeight
    if (!w || !h) return this.layer.replaceChildren()
    Object.assign(this.layer.style, { left: `${img.offsetLeft}px`, top: `${img.offsetTop}px`, width: `${w}px`, height: `${h}px` })
    const nodes = []
    this.marksValue.forEach((given, n) => {
      // (The client core carries a region as width/height (the connector's ref); the board wrote w/h.)
      const m = { ...given, w: Number(given.w ?? given.width), h: Number(given.h ?? given.height) }
      if (![m.x, m.y, m.w, m.h].every(Number.isFinite)) return
      const cx = (m.x + m.w / 2) * w, cy = (m.y + m.h / 2) * h
      const rx = Math.max(12, m.w * w / 2 * 1.16 + 5), ry = Math.max(12, m.h * h / 2 * 1.16 + 5)
      // one stroke of the pen, a little more than once round, never quite closing where it began
      let d = ''
      const turns = 34, seed = n * 7 + 3
      for (let i = 0; i <= turns; i++) {
        const t = -2.4 + (i / turns) * (Math.PI * 2 + .5)
        const wob = 1 + Math.sin(i * 1.7 + seed) * .035 + (i / turns - .5) * .05
        d += `${i ? 'L' : 'M'}${(cx + Math.cos(t) * rx * wob).toFixed(1)} ${(cy + Math.sin(t) * ry * wob).toFixed(1)}`
      }
      const path = document.createElementNS(NS, 'path')
      path.setAttribute('d', d)
      nodes.push(path)
      if (m.label) {
        const text = document.createElementNS(NS, 'text')
        text.setAttribute('x', Math.min(Math.max(cx - rx, 4), Math.max(4, w - 8 * String(m.label).length)).toFixed(1))
        text.setAttribute('y', (cy - ry < 22 ? cy + ry + 17 : cy - ry - 7).toFixed(1))
        text.textContent = m.label
        nodes.push(text)
      }
    })
    this.layer.replaceChildren(...nodes)
    this.dispatch('drawn')   // (the card draws its arrow from the first circle)
  }
})

// ---- the card's routes: its page, its picture, the forms that answer it, its live pieces ----
export function register(t) {
  const { BASE, hub, model, stream, says, redirect } = t
  // ---- what a card's form does ----
  const noteOf = f => String(f.get('note') ?? '').trim()
  const seenOf = f => (f.has('revised') ? Number(f.get('revised')) : undefined)
  const marksIn = f => { try { const list = JSON.parse(String(f.get('marks') ?? '[]')); return Array.isArray(list) && list.length ? list : undefined } catch { return undefined } }
  const notesOf = (card, f) => Object.fromEntries(card.options.map(o => [o.key, String(f.get(`note-${o.key}`) ?? '').trim()]).filter(([, said]) => said))
  const forgetSent = card => {
    if (!card.draft || card.kind !== 'decision' || card.status !== 'open') return
    try { hub.setDraft(card.id, { keys: card.draft.keys ?? [], note: '', notes: card.draft.notes ?? {}, marks: [] }) } catch {}
  }
  const say = (card, text, turn, files = [], marks) => hub.message({ agent: card.agent, text, card_id: card.id, ...turn, ...(files.length ? { attachments: files } : {}), ...(marks ? { marks } : {}) })
  const WAYS = {
    decide(card, f, files) {
      const keys = f.getAll('keys').map(String), key = f.get('key')
      if (!keys.length && key == null) throw new Error('pick an option first')
      return hub.decide(card.id, card.multiple ? (keys.length ? keys : [String(key)]) : String(key ?? keys[0]), noteOf(f), seenOf(f), card.kind === 'decision' ? notesOf(card, f) : undefined, files, card.kind === 'decision' ? marksIn(f) : undefined)
    },
    trust: (card, f) => hub.trust(card.id, noteOf(f), seenOf(f)),
    close: card => hub.closeInfo(card.id),
    snooze: card => hub.snooze(card.id, {}),
    wake: card => hub.snooze(card.id, { clear: true }),
    shred: (card, f, files) => hub.shred(card.id, noteOf(f).slice(0, 2000), marksIn(f), files),
    reopen: card => hub.reopen(card.id),
    takeback: card => hub.takeBack(card.id),
    revise: async (card, f, files) => { await say(card, noteOf(f) || HAND_BACK_TEXT, { handback: true }, files, marksIn(f)); forgetSent(card) },
    what: card => say(card, EXPLAIN_TEXT, { explain: true }),
    message(card, f, files) {
      const marks = marksIn(f)
      if (!noteOf(f) && !files.length && !marks) throw new Error('write something first')
      return say(card, noteOf(f), {}, files, marks).then(() => forgetSent(card))
    },
  }
  const filesOf = form => (form ? [...form.values()].filter(v => v instanceof File && v.size > 0) : [])
  async function actRoute(req, res, form, id, what, cardView) {
    const before = model(), card = before.byCard.get(id)
    const after = card ? before.fresh.slice(before.fresh.indexOf(card) + 1).map(c => c.id) : []
    const wantsStream = t.wantsStream(req)
    const stay = form.has('stay') && wantsStream
    try {
      if (!card) throw Object.assign(new Error('this question is not on the board any more'), { status: 404 })
      await WAYS[what](card, form, filesOf(form))
    } catch (err) {
      const text = err.message || 'the board did not take it'
      const m = model(), now = card && m.byCard.get(card.id)
      // (Sent from the card's own page, where no Desk row stands: what went wrong comes as a note.)
      const onCard = /^\/(?:s\/[^/]+\/)?[qc]\/[\w-]+$/.test(new URL(String(req.headers.referer ?? '/'), location.origin).pathname)
      if (stay && onCard) return t.sendStream(req, res, t.toast({ head: what === 'message' ? 'Not sent' : 'Not saved', line: text, role: 'alert' }), 422)
      if (stay) return t.sendStream(req, res, now && m.fresh.includes(now) ? stream('replace', `row-${now.id}`, deskRow(now, m, BASE, { error: `Not saved: ${text}` })) : t.toast({ head: 'Not saved', line: text, role: 'alert' }))
      if (!now) return t.notFound(req, res, 'This question is not on the board any more.')
      return cardView(req, res, now, m, { walk: form.has('walk'), error: `Not saved: ${text}` }, 422)
    }
    const quiet = form.has('quiet') || !SAID[what]
    if (stay) {
      const m = model()
      return t.sendStream(req, res, html`${m.fresh.some(c => c.id === id) ? '' : stream('remove', `row-${id}`)}${quiet ? '' : stream('prepend', 'says-host', says(m.byCard.get(id), what))}`)
    }
    const said = quiet ? '' : `said=${id}:${what}`
    const home = String(form.get('back') ?? '')
    const fromSession = home.startsWith(`${BASE}/s/`) && /^[\w\-/%+.]+$/.test(home)
    if (['message', 'reopen', 'takeback', 'wake'].includes(what) && !form.has('stay')) return redirect(res, `${cardPath(card, fromSession ? home : BASE)}${what === 'message' ? `?said=${id}:message` : ''}`)
    if (fromSession) return redirect(res, `${home}${said ? `?${said}` : ''}`)
    // (in the walk, and after the reverse card on a card's own page: on to the next open card)
    if (form.has('walk') || (form.has('next') && what === 'revise')) {
      const m = model(), next = after.map(x => m.byCard.get(x)).find(c => c && m.fresh.includes(c)) ?? m.fresh.find(c => c.id !== id)
      return redirect(res, next ? `${cardPath(next, BASE)}?${form.has('walk') ? 'walk=1' : ''}${said ? `${form.has('walk') ? '&' : ''}${said}` : ''}` : `${BASE}/${said ? `?${said}` : ''}`)
    }
    return redirect(res, `${BASE}/${said ? `?${said}` : ''}`)
  }

  // ---- a card's page ----
    const cardView = (req, res, card, m, { said = '', ...opts } = {}, code = 200) => {
      const [saidId, saidWhat] = said.split(':')
      const old = versionOf(card, opts.version)
      const from = opts.from && m.byAgent.has(opts.from) ? opts.from : null
      t.page(req, res, { model: m, title: `${card.title} · Trommi`, view: 'card', css: 'card', current: from, stream: `&card=${card.id}${from ? `&from=${encodeURIComponent(from)}` : ''}${old ? `&old=${old.n}` : ''}`, main: cardPage(card, m, BASE, { ...opts, from }), says: says(m.byCard.get(saidId), saidWhat) }, code)
    }
    // The comments are a timeline loaded newest page first; ?older=1 loads the page before, then the card is shown.
    const threadOf = card => `chat:card/${card.id}`
    const moreOf = card => card.kind !== 'permission' && Boolean(hub.hasMore?.(threadOf(card)))
    t.get(/^\/(?:s\/([^/]+)\/)?[qc]\/([\w-]+)$/, async ({ req, res, url, match }) => {
      let m = model(), card = m.cardByRef(match[2])
      if (!card) return t.notFound(req, res, 'This question is not on the board any more.')
      if (url.searchParams.has('older') && moreOf(card)) {
        try { await hub.loadOlder(threadOf(card)) } catch (err) { console.warn('older comments', err) }
        m = model(); card = m.byCard.get(card.id) ?? card
      }
      cardView(req, res, card, m, { more: moreOf(card), said: String(url.searchParams.get('said') ?? ''), pic: Number(url.searchParams.get('pic')) || 1, walk: url.searchParams.has('walk'), version: Number(url.searchParams.get('v')) || null, from: match[1] ? decodeURIComponent(match[1]) : null })
    })
    t.get(/^\/(?:s\/([^/]+)\/)?[qc]\/([\w-]+)\/p\/(\d+)$/, ({ req, res, match: [, from, ref, at] }) => {
      const m = model(), card = m.cardByRef(ref)
      if (!card) return t.notFound(req, res, 'This question is not on the board any more.')
      if (!imagesOf(card).length) return redirect(res, cardPath(card, BASE))
      t.page(req, res, { model: m, title: `${card.title} · picture ${at}`, view: 'picture', sidebar: false, css: 'picture', stream: null, main: picturePage(card, m, BASE, Number(at), { from: from ? decodeURIComponent(from) : null }), bodyAttrs: ' data-focus-page="card"' })
    })
    t.post(/^\/cards\/([0-9a-f]+)\/draft$/, ({ res, match, form }) => {
      const card = model().byCard.get(match[1])
      if (!card) { res.code = 404; return }
      hub.setDraft(card.id, { keys: form.getAll('keys').map(String), note: String(form.get('note') ?? ''), notes: notesOf(card, form), marks: form.has('marks') ? marksIn(form) ?? [] : card.draft?.marks })
      res.code = 204
    })
    t.post(/^\/cards\/([0-9a-f]+)\/([a-z]+)$/, async ({ req, res, match, form }) => {
      if (!Object.hasOwn(WAYS, match[2])) return false
      return actRoute(req, res, form, match[1], match[2], cardView)
    })
    t.live('card', {
      take: (m, clients) => new Map([...new Set(clients.filter(c => c.params.get('card')).map(c => `${c.params.get('card')}|${c.params.get('from') ?? ''}`))].map(k => {
        const [id, from] = k.split('|'), card = m.byCard.get(id), self = from ? `${BASE}/s/${encodeURIComponent(from)}` : BASE
        return [k, card ? { face: cardLead(card, m, self), answer: cardAnswer(card, m, BASE), answerSig: cardAnswer({ ...card, draft: undefined }, m, BASE), thread: cardThread(card, m, self, { more: moreOf(card) }) } : null]
      })),
      diff(was, now, client) {
        const id = client.params.get('card'), k = `${id}|${client.params.get('from') ?? ''}`, a = was.get(k), b = now.get(k)
        if (!b) return a ? String(stream('refresh')) : ''
        if (!a) return ''
        const face = t.differs(a.face, b.face) ? String(stream('replace', `card-lead-${id}`, b.face)) : ''
        if (client.params.has('old')) return t.differs(a.thread, b.thread) ? String(stream('replace', `card-thread-${id}`, b.thread)) : ''
        return face + (t.differs(a.answerSig, b.answerSig) ? stream('replace', `card-answer-${id}`, b.answer) : '') + (t.differs(a.thread, b.thread) ? stream('replace', `card-thread-${id}`, b.thread) : '')
      },
    })
}
