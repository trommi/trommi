// A card's own page (decided on card Nr. 191): inside the board's frame, the sidebar beside it. The card is one calm
// block of FIXED height in two columns: at the left the title, one quiet line (who, when, Nr.), the short text and a
// low picture; at the right the options, "or" Whatever, and the field whose Send hands the card back with the words.
// Everything else stands in the comments below the card: the whole text when it is longer than the card holds, the
// options in detail, links of options, why it is urgent, versions and what happened to the card, the talk.
// Above the card one row: the way back, where it stands ("3 of 9", before and next), and one "More".
//
// One form (#card-form-<id>) holds the field and the notes on single options; every way to answer is a button of that
// form with its own address (formaction), so what was written goes along, with or without scripts. The controller
// "card" (t/controllers/card_controller.js) adds the pencil for a note on one option, the draft kept while typing,
// Enter that sends, files that are pasted or dropped, and the pen's arrow from the picture to its option.
// Styles: client/web/css/cardpage.css.
import { html, raw } from './html.mjs'
import { WORDS, EXPLAIN_TEXT, rich, plain, cardNr, cardNote, kindOf, advisedKeys, advisedLabels, agoSpan, knockWord, isKnock } from './text.mjs'
import { cardPath, copyButton } from './desk.mjs'
import { doodleSvg, sketchSvg, crownSvg } from '../pen.js'
import { srcOf, thumb } from './picture.mjs'   // a stored picture at the size it is shown (thumbs.mjs)

const sk = name => raw(sketchSvg(name))
const icon = d => raw(`<svg viewBox="0 0 24 24" class="tc-icon" aria-hidden="true"><path d="${d}"/></svg>`)
const ARROW_L = 'M19 12H5M11 6l-6 6 6 6', ARROW_R = 'M5 12h14M13 6l6 6-6 6', TICK = 'M5 12.5l4.5 4.5L19 7.5', ZOOM = 'M11 4a7 7 0 1 0 0 14a7 7 0 0 0 0-14M20 20l-4-4M11 8v6M8 11h6'
const HAND_BACK_TEXT = 'Back to you: please revise this question and present it again.'
const act = (card, base, what) => `${base}/cards/${card.id}/${what}`
const imagesOf = card => (card.attachments ?? []).filter(a => kindOf(a) === 'image')
/** The version that stands now, as a number. */
const liveVersion = card => card.version ?? (card.versions?.at(-1)?.n ?? 0) + 1
/** The card as it was in version n (title, text, options, pictures), or null. */
export const versionOf = (card, n) => (n != null && n < liveVersion(card) ? card.versions?.find(v => v.n === n) ?? null : null)

// ---- the fixed height: what the card holds, and what goes to the comments ----
// The card shows at most TEXT_FIT characters of plain text, whole paragraphs first. A layout, a table or code never
// stands on the card. What does not fit is in the comments, as "The whole text", and the card says so.
export const TEXT_FIT = 340
/** -> { shown: the text for the card (markdown), more: whether the comments hold more } */
export function fitText(text) {
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
/** The text a card stands for: its body, or the plain blocks of its sections. */
const textOf = card => (card.sections?.length ? card.sections.filter(s => s.key == null).map(s => s.text).filter(Boolean).join('\n\n') : card.body ?? '')

/** Which picture belongs to which option (js/focus.js pairPictures): picture index -> option key, where that is
 *  plain to see: a section names its picture; or every picture names one option in its file name; or there are
 *  as many pictures as options, three or more. Nothing is guessed otherwise. */
export function pictureKeys(card) {
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

/** What the controller "card" needs to put an option's picture on the stage while the pointer is on the option:
 *  per picture its address at the stage's size, its marks, the option it belongs to, its page. */
function picturesOf(card, base) {
  const keys = pictureKeys(card)
  const images = imagesOf(card)
  // (Several options may show the same picture: a section names it for each.)
  const shared = i => (card.sections ?? []).filter(s => s.key != null && s.picture != null && images.indexOf(card.attachments?.[s.picture]) === i).map(s => s.key)
  return images.map((a, i) => { const t = thumb(a, 640), all = shared(i), key = keys.get(i) ?? null; return { at: i + 1, src: t.src, srcset: t.srcset, name: a.name, marks: a.marks ?? [], key, keys: all.length ? all : key != null ? [key] : [], href: `${cardPath(card, base)}/p/${i + 1}` } })
}

/** The picture of the card, low: one at a time, the others as small ones to pick; a click opens it large on its own
 *  page. A frame of its own, so picking another loads only this. */
export function cardMedia(card, base, at = 1, query = '') {
  const images = imagesOf(card)
  if (!images.length) return ''
  const i = Math.min(Math.max(1, at), images.length), a = images[i - 1]
  const here = cardPath(card, base)
  const to = n => `${here}?pic=${n}${query}`
  const key = pictureKeys(card).get(i - 1)
  const step = (n, cls, label, d) => (images.length > 1 ? html`<a class="tc-step ${cls}" data-nav href="${to(n)}" data-turbo-action="replace" aria-label="${label}">${icon(d)}</a>` : '')
  return html`<turbo-frame id="card-media-${card.id}" class="tc-media">
<div class="tc-stage"><a class="tc-figure" data-nav href="${here}/p/${i}" data-turbo-frame="_top" data-card-target="figure" data-at="${i}" aria-label="Enlarge picture ${i} of ${images.length}: ${a.name}"${key != null ? html` data-key="${key}"` : ''} data-controller="circles" data-circles-marks-value="${JSON.stringify(a.marks ?? [])}"><img alt=""${srcOf(a, 640)} decoding="async" draggable="false"><span class="tc-zoom">${icon(ZOOM)}</span></a>${step(i > 1 ? i - 1 : images.length, 'is-prev', 'The picture before', ARROW_L)}${step(i < images.length ? i + 1 : 1, 'is-next', 'The next picture', ARROW_R)}</div>
${images.length > 1 ? html`<div class="tc-thumbs">${images.map((p, n) => html`<a class="tc-thumb" data-nav href="${to(n + 1)}" data-turbo-action="replace" aria-label="Show picture ${n + 1}: ${p.name}" aria-pressed="${String(n + 1 === i)}"><img${srcOf(p, 64)} alt="" loading="lazy" decoding="async" draggable="false" width="48" height="34"></a>`)}<span class="tc-where">${i} / ${images.length} · ${a.title || a.name}</span></div>` : html`<div class="tc-thumbs"><span class="tc-where">${a.title || a.name}</span></div>`}
</turbo-frame>`
}

/** The card's left column (#card-left-<id>): title, one quiet line, the text that fits, the picture.
 *  version: as it was then (read-only). pic: the picture shown. self: the base its links are under (a session's page). */
export function cardLeft(card, model, base, { version = null, pic = 1, query = '' } = {}) {
  const old = versionOf(card, version)
  const shown = old ? { ...card, attachments: old.attachments ?? card.attachments } : card
  return html`<div class="tc-left">${cardLead(card, model, base, { version })}
${cardMedia(shown, base, pic, query)}
</div>`
}
/** The words of the left column (#card-lead-<id>): what the live stream replaces (the picture keeps its place). */
export function cardLead(card, model, base, { version = null } = {}) {
  const from = model.byAgent.get(card.agent)
  const old = versionOf(card, version)
  const shown = old ? { ...card, title: old.title ?? card.title, body: old.body ?? '', sections: old.sections } : card
  const { shown: text, more } = fitText(textOf(shown))
  const said = model.state.messages.filter(m => m.card_id === card.id && m.from !== 'event' && (m.text || m.attachments?.length)).length
  const notes = [cardNote(card), old ? `version ${old.n}, as it was` : '', said ? (said === 1 ? '1 message below' : `${said} messages below`) : ''].filter(Boolean)
  return html`<div class="tc-lead focus-lead" id="card-lead-${card.id}">
${isKnock(card) && card.status === 'open' ? html`<span class="inbox-tab tc-knock">${sk('knock')}${knockWord(card)}</span>` : ''}
<h1 class="tc-title" id="card-title-${card.id}">${shown.title}</h1>
<p class="tc-meta">${from ? html`<a class="tc-from" data-nav href="${base}/s/${encodeURIComponent(from.id)}" style="--hue:${from.hue}">${raw(doodleSvg(from.mark))}${from.name}</a><span aria-hidden="true">·</span>` : ''}${agoSpan(card.revised ?? card.created, 'tc-ago')}<span aria-hidden="true">·</span><span>${cardNr(card)}</span>${notes.length ? html`<span aria-hidden="true">·</span><a href="#card-thread-${card.id}">${notes.join(' · ')}</a>` : ''}</p>
${text ? html`<div class="tc-text">${rich(text, { assets: model.state.assets })}</div>` : ''}${more ? html`<a class="tc-more-text" href="#card-whole-${card.id}">More in the comments ↓</a>` : ''}
</div>`
}

// Revise (the reverse card): a press opens a small field right here, "What should change?", with its own Send; sending
// hands the card back with those words. Without scripts it is a plain <details>. Marks drawn on the card go along.
const reviseTile = (card, base) => html`<details class="tc-revise" data-card-target="revise" data-action="toggle->card#reviseToggle"><summary class="tc-tile tc-reverse" title="Revise (B): say what should change, and it goes back to the session" aria-label="Revise: say what should change, and it goes back to the session">${sk('reverse')}</summary><form class="tc-revise-form" method="post" action="${act(card, base, 'revise')}" data-action="submit->card#reviseSend"><input type="hidden" name="marks" value="" data-card-target="reviseMarks"><input type="text" name="note" maxlength="2000" placeholder="What should change?" aria-label="What should change?" autocomplete="off" enterkeyhint="send" data-card-target="reviseField" data-action="keydown->card#reviseKeys input->card#reviseKeep"><button class="tc-revise-send" type="submit" title="Hand back (Enter)">${sk('send')}<span>Hand back</span></button></form></details>`
const still = (label, detail = '', cls = '') => html`<div class="tc-opt is-still ${cls}"><span class="tc-opt-words"><span class="tc-opt-label">${label}</span>${detail ? html`<span class="tc-opt-detail">${detail}</span>` : ''}</span></div>`
const back = (card, base, way, word = WORDS.takeBack) => html`<button class="tc-way" type="submit" form="card-form-${card.id}" formaction="${act(card, base, way)}">${word}</button>`

/** The right column's answers (#card-answer-<id>): every option a button of the card's form, with its line for a note;
 *  then "or" Whatever. Or, once answered or handed back, what was said and the way back. */
export function cardAnswer(card, model, base, { error = '', version = null, pic = 1 } = {}) {
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
${card.kind === 'decision' ? html`<div class="tc-or"><i>or</i><button class="tc-opt tc-whatever" type="submit" form="${form}" formaction="${act(card, base, 'trust')}" title="${trustTip}" aria-label="${trustTip}">${sk('duck')}<span class="tc-opt-words"><span class="tc-opt-label">I don’t give a duck</span></span></button><div class="tc-or-pair"><button class="tc-tile tc-wtf" type="submit" form="${form}" formaction="${act(card, base, 'what')}" title="What?? — explain this to me (E)" aria-label="What?? Explain this to me: the session explains it, and it comes back explained">${sk('what')}</button>${reviseTile(card, base)}</div></div>` : ''}`)
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
export function cardThread(card, model, base = '', { more = false } = {}) {
  const all = model.state.messages.filter(m => m.card_id === card.id)
  const assets = model.state.assets
  const who = model.byAgent.get(card.agent)
  const files = list => { const rest = (list ?? []).filter(a => kindOf(a) !== 'image'); return rest.length ? html`<p class="tc-files">${rest.map(a => html`<a href="${a.url}" target="_blank" rel="noopener">${a.name}</a> `)}</p>` : '' }
  const shots = list => { const pics = (list ?? []).filter(a => kindOf(a) === 'image'); return pics.length ? html`<div class="shots">${pics.map(a => html`<a href="${a.url}" target="_blank" rel="noopener"><img${srcOf(a, 320)} alt="${a.name}" loading="lazy" decoding="async"></a>`)}</div>` : '' }
  const did = (text, ts) => html`<p class="tc-did"><span>${text}</span>${agoSpan(ts, 'msg-time')}</p>`
  const name = who?.name ?? card.agent
  const head = (title, ts) => html`<header class="msg-head"><span class="msg-name">${name}</span>${title ? html`<b class="tc-said">${title}</b>` : ''}${ts ? agoSpan(ts, 'msg-time') : ''}</header>`
  const words = text => rich(text ?? '', { assets, hand: false })
  const agentMsg = (m, cont = false) => html`<article class="msg msg-agent${cont ? ' cont' : ''}" id="msg-${m.id}">${cont ? '' : head('', m.ts)}${rich(m.text ?? '', { assets, extra: m.html ?? '', hand: false })}${shots(m.attachments)}${files(m.attachments)}${m.details ? html`<details class="msg-details"><summary>Details</summary>${words(m.details)}</details>` : ''}</article>`
  const userMsg = (m, text = m.text) => html`<article class="msg msg-user" id="msg-${m.id}">${text ? html`<div class="bubble"><p>${text}</p></div>` : ''}${shots(m.attachments)}${files(m.attachments)}${agoSpan(m.ts, 'msg-time')}</article>`
  const isBare = m => (m.handback && m.text?.trim() === HAND_BACK_TEXT) || (m.explain && m.text?.trim() === EXPLAIN_TEXT)

  // ---- what the card did not hold ----
  const lead = []
  const whole = textOf(card)
  if (fitText(whole).more) lead.push(html`<article class="msg msg-agent tc-whole" id="card-whole-${card.id}">${head('The whole text')}${rich(whole, { assets, extra: card.html ?? '', hand: false })}</article>`)
  else if (card.html) lead.push(html`<article class="msg msg-agent tc-whole" id="card-whole-${card.id}">${head('With the text')}${rich('', { assets, extra: card.html })}</article>`)
  const secs = (card.sections ?? []).filter(s => s.key != null && (s.text || s.html))
  if (secs.length) lead.push(html`<details class="tc-fold tc-options-said"><summary>Options in detail</summary>${secs.map(s => html`<section class="tc-sec"><h3>${s.label}${s.recommended ? html` <span class="tc-advised-word">recommended</span>` : ''}</h3>${s.text ? rich(s.text, { assets, extra: s.html ?? '', hand: false }) : ''}</section>`)}</details>`)
  const links = optionLinks(card)
  if (String(links)) lead.push(links)
  if (card.urgency_reason) lead.push(did(`Why it is urgent: ${card.urgency_reason}`, card.created))

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
      items.push({ html: html`<section class="tc-explained"><p class="tc-explained-head"><b>You asked: What??</b>${agoSpan(m.ts, 'msg-time')}</p>${answers.length ? answers.map((a, n) => agentMsg(a, n > 0)) : html`<p class="tc-quiet">Waiting for the explanation.</p>`}</section>` })
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
  const any = lead.length || items.length || more
  return html`<section class="tc-feed" id="card-thread-${card.id}" aria-label="Comments"${any ? '' : raw(' hidden')}>${lead}${older}${folded}${now.map(x => x.html)}</section>`
}

/** Where the card stands in the stack, for the walk: { at, of, prev, next } (cards), or null when it is not waiting. */
export function placeOf(card, model) {
  const at = model.fresh.indexOf(card)
  return at < 0 ? null : { at: at + 1, of: model.fresh.length, prev: model.fresh[at - 1] ?? null, next: model.fresh[at + 1] ?? null }
}

/** The whole <main> of a card's page. pic: which picture stands. walk: a step of "Next, please". version: as it was
 *  then. from: the session it was opened from (/s/<id>/q/<n>): the way back and the links lead there. */
export function cardPage(card, model, base, { pic = 1, walk = false, error = '', version = null, from = null, more: older = false } = {}) {
  const old = versionOf(card, version)
  const open = card.status === 'open' && !card.with_agent && !old
  const session = from ? model.byAgent.get(from) : null
  const home = session ? `${base}/s/${encodeURIComponent(session.id)}` : `${base}/`
  const self = session ? home : base
  const place = old ? null : placeOf(card, model)
  const query = `${walk ? '&walk=1' : ''}${old ? `&v=${old.n}` : ''}`
  const images = imagesOf(old ? { attachments: old.attachments ?? card.attachments } : card)
  const shownPic = Math.min(Math.max(1, pic), Math.max(1, images.length))
  const pageLink = images[shownPic - 1]?.page?.url
  const step = (to, cls, label, d) => (to ? html`<a class="tc-step-card ${cls}" data-nav href="${cardPath(to, self)}${walk ? '?walk=1' : ''}" aria-label="${label}: ${to.title}" title="${label}: ${to.title}">${icon(d)}</a>` : html`<span class="tc-step-card ${cls}" aria-hidden="true">${icon(d)}</span>`)
  const form = `card-form-${card.id}`
  const more = (cls, drawing, word, tip, action) => html`<button class="tc-more-item ${cls}" type="submit" form="${form}" formaction="${action}" title="${tip}">${sk(drawing)}<span>${word}</span></button>`
  return html`<main id="cardpage" class="tc-page" aria-label="Question ${card.number}" data-id="${card.id}" data-controller="card" data-card-draft-value="${open && card.kind === 'decision' ? act(card, base, 'draft') : ''}" data-card-pictures-value="${JSON.stringify(picturesOf(old ? { ...card, attachments: old.attachments ?? card.attachments } : card, self))}" data-action="turbo:frame-load->card#link circles:drawn->card#link turbo:submit-start->card#sent dragover->card#over drop->card#drop">
<nav class="tc-head" aria-label="Around this question">
<a class="tc-back" data-nav href="${home}" aria-keyshortcuts="Escape"><span>Back to ${session ? session.name : WORDS.desk}</span><kbd>Esc</kbd></a>
${place ? html`<span class="tc-place">${step(place.prev, 'is-prev', 'The question before', ARROW_L)}<span class="tc-count" title="Where this question stands on the Desk">${place.at} of ${place.of}</span>${step(place.next, 'is-next', 'The next question', ARROW_R)}</span>` : ''}
<details class="tc-more" data-controller="pops"><summary class="tc-more-open" aria-label="More for this question">More ${sk('unfold')}</summary><div class="tc-more-list" role="menu">
${open && card.kind !== 'permission' ? html`${more('', 'snooze', WORDS.later, `${WORDS.later}: it waits for you on "Later"`, act(card, base, 'snooze'))}${more('is-shred', 'bin', WORDS.shred, `${WORDS.shred}: throw it away unanswered`, act(card, base, 'shred'))}` : ''}
${copyButton(card)}
${model.state.speech ? html`<button class="tc-more-item" type="button" data-controller="say" data-say-url-value="/speech/card/${card.id}" data-action="say#toggle" aria-pressed="false">${sk('mic')}<span>Read aloud</span></button>` : ''}
${pageLink ? html`<a class="tc-more-item" href="${pageLink}" target="_blank" rel="noopener noreferrer">${sk('page')}<span>Open the page</span></a>` : ''}
</div></details>
</nav>
<article class="tc-card" id="card-${card.id}" data-id="${card.id}" data-kind="${card.kind}" data-urgency="${card.urgency}" aria-labelledby="card-title-${card.id}"${images.length ? raw(' data-pictures') : ''}>
${cardLeft(card, model, self, { version, pic: shownPic, query })}
<div class="tc-right">
${cardAnswer(card, model, base, { error, version, pic: shownPic })}
</div>
</article>
${cardThread(card, model, self, { more: older })}
<form class="tc-ask tc-chat" id="${form}" method="post" action="${act(card, base, 'message')}" enctype="multipart/form-data" data-card-target="form">
${walk ? raw('<input type="hidden" name="walk" value="1">') : ''}${session ? html`<input type="hidden" name="back" value="${home}">` : ''}
${open && card.kind === 'decision' ? html`<input type="hidden" name="marks" value="${JSON.stringify(card.draft?.marks ?? [])}" data-card-target="marks">` : ''}
<div class="tc-chips" data-card-target="chips" hidden></div>
<textarea class="tc-field" id="card-field-${card.id}" data-card-target="field" data-action="input->card#typed keydown->card#keys paste->card#paste" name="note" rows="2" placeholder="Write to the agent about this question" autocomplete="off" enterkeyhint="send" aria-label="Write to the agent about this question. Send adds it to the talk below; an answer takes it along as a note.">${card.draft?.note ?? ''}</textarea>
<div class="tc-ask-row"><label class="tc-clip" title="Attach files or pictures (or paste, or drop them on the card)">${sk('clip')}<span class="tc-sr">Attach files</span><input type="file" name="files" multiple hidden data-card-target="files" data-action="change->card#files"></label><span class="tc-saved" role="status" data-card-target="saved" hidden></span><button class="tc-send" type="submit" title="Send to the agent (Enter); the question stays with you" aria-label="Send to the agent">${sk('send')}</button></div>
</form>
</main>`
}

/** One picture of a card, large, at its own address: the browser's Back closes it. from: the session it was opened from. */
export function picturePage(card, base, at, { from = null } = {}) {
  const images = imagesOf(card)
  const i = Math.min(Math.max(1, at), images.length), a = images[i - 1]
  const self = from ? `${base}/s/${encodeURIComponent(from)}` : base
  const here = cardPath(card, self)
  return html`<div class="t-picture">
<header class="t-picture-bar"><a class="tc-back t-picture-back" data-nav href="${here}?pic=${i}" aria-label="Back to the question">${icon(ARROW_L)}<span>${card.title}</span></a><span class="t-picture-where"><b>${i} / ${images.length}</b> ${a.title || a.name}</span>${a.page?.url ? html`<a class="focus-page-link" target="_blank" rel="noopener noreferrer" href="${a.page.url}">${sk('page')}<span>Open the page</span></a>` : ''}</header>
<a class="t-picture-view" data-nav href="${here}?pic=${i}" aria-label="Close the picture"><span class="t-picture-fit"${a.marks?.length ? html` data-controller="circles" data-circles-marks-value="${JSON.stringify(a.marks)}"` : ''}><img${srcOf(a, 1600)} alt="${a.name}" decoding="async"></span></a>
${images.length > 1 ? html`<a class="tc-step is-prev" data-nav href="${here}/p/${i > 1 ? i - 1 : images.length}" data-turbo-action="replace" aria-label="The picture before">${icon(ARROW_L)}</a><a class="tc-step is-next" data-nav href="${here}/p/${i < images.length ? i + 1 : 1}" data-turbo-action="replace" aria-label="The next picture">${icon(ARROW_R)}</a>` : ''}
</div>`
}
export { imagesOf, crownSvg }
