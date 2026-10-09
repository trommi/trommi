// A card's own page: inside the board's frame, the sidebar beside it. The card is one calm
// block of FIXED height in two columns: at the left the title, one quiet line (who, when, Nr.), the short text and a
// low picture; at the right the options, "or" Whatever, and the field whose Send hands the card back with the words.
// Everything else stands in the comments below the card: the whole text when it is longer than the card holds, the
// options in detail, links of options, why it is urgent, versions and what happened to the card, the talk.
// Above the card stands one row of round drawn buttons, at the card's edges: the way back, a cross, at the left; at
// the right the question before and the next, Focus (the page alone in the window, ?focus=1; a picture opens large
// by a click on it) and More, three dots: Wake up, Copy, Shred. Where it stands ("3 of 9") is in the card's own line.
// A narrow window: back and More (no Focus: the page is the whole window there), before and next are a swipe and the
// keys. Later is a pull-tag tied under the card's bottom-right corner (the Desk's Later: ui.mjs sideWays, the same
// route): pulled, the card is put off and the next one follows.
//
// One form (#card-form-<id>) holds the field and the notes on single options; every way to answer is a button of that
// form with its own address (formaction), so what was written goes along, with or without scripts. The controller
// "card" adds the pencil for a note on one option, the draft kept while typing,
// Enter that sends, files that are pasted or dropped, and the pen's arrow from the picture to its option.
// Styles: card.css.
import { NEEDS_NEWER, SAID, heardOf, linkOf, walkOf } from './app.mjs'
import { Controller, fileTile, revokeTiles, EXPLAIN_TEXT, HAND_BACK_TEXT, isTyping, letterKeysOn, FINAL_TIP, LATER_TAG, SETTLED, WORDS, act, advisedKeys, advisedLabels, agoSpan, arrowStrokes, cardNote, cardNr, cardPath, controller, copyButton, deskRow, doodleSvg, el, finalSign, html, isKnock, kindOf, knockWord, linkNote, pageChip, plain, raw, rich, sideWays, sk, sketch, srcOf, thumb } from './ui.mjs'
const icon = d => raw(`<svg viewBox="0 0 24 24" class="tc-icon" aria-hidden="true"><path d="${d}"/></svg>`)
const ARROW_L = 'M19 12H5M11 6l-6 6 6 6', ARROW_R = 'M5 12h14M13 6l6 6-6 6', TICK = 'M5 12.5l4.5 4.5L19 7.5', PLAY = 'M9 6.5v11l9-5.5z', GROW = 'M14 5h5v5M19 5l-6 6M10 19H5v-5M5 19l6-6'
// Drawn with the pen, for the round buttons above a card: an arrow to the left and one to the right, a cross, three
// dots, four corners pulled apart (full screen).
const pen = paths => raw(`<svg viewBox="0 0 24 24" class="sketch" aria-hidden="true">${paths}</svg>`)
const BACK = pen('<path d="M19.4 12.3 Q12.2 11.5 5 12.1"/><path d="M10.9 6 Q7.7 9.3 4.7 12.1 Q8 14.8 11.2 18.2"/>')
const FORTH = pen('<path d="M4.6 12.3 Q11.8 11.5 19 12.1"/><path d="M13.1 6 Q16.3 9.3 19.3 12.1 Q16 14.8 12.8 18.2"/>')
const CROSS = pen('<path d="M6.3 6.6 Q12.2 12.1 17.8 17.7"/><path d="M17.6 6.2 Q12 12.2 6.2 17.9"/>')
const DOTS = pen('<path d="M5.4 12 Q5.9 11.5 6.4 12 Q5.9 12.6 5.4 12 M11.5 12 Q12 11.5 12.5 12 Q12 12.6 11.5 12 M17.6 12 Q18.1 11.5 18.6 12 Q18.1 12.6 17.6 12" stroke-width="2.6"/>')
const FULL = pen('<path d="M4.4 9.3 Q4.1 6.6 4.5 4.4 Q6.9 4.1 9.4 4.4"/><path d="M14.7 4.2 Q17.3 4.5 19.6 4.3 Q19.9 6.7 19.6 9.2"/><path d="M19.8 14.8 Q19.5 17.4 19.7 19.7 Q17.2 19.9 14.8 19.6"/><path d="M9.3 19.8 Q6.7 19.5 4.3 19.7 Q4.1 17.2 4.4 14.9"/>')
// Leave focus: the four corners turned inwards
const LESS = pen('<path d="M4.3 9.2 Q6.8 9.5 9.3 9.2 Q9.6 6.7 9.3 4.3"/><path d="M14.8 4.4 Q14.5 6.9 14.8 9.3 Q17.3 9.6 19.7 9.3"/><path d="M19.6 14.8 Q17.2 14.5 14.7 14.8 Q14.4 17.3 14.7 19.7"/><path d="M9.2 19.6 Q9.5 17.2 9.2 14.7 Q6.7 14.4 4.3 14.7"/>')
/** The words of the focus button, off and on (the controller "card" switches them in place). */
const FOCUS_WORDS = { false: 'Focus', true: 'Leave focus · Esc' }
/** An address with ?focus=1 on it or off it (the card page's focus mode lives in the address). */
const focusAt = (href, on) => { const u = new URL(href, location.origin); if (on) u.searchParams.set('focus', '1'); else u.searchParams.delete('focus'); return u.pathname + u.search + u.hash }
const FOCUS_FIELD = '<input type="hidden" name="focus" value="1">'
const DRAW = pen('<path d="M4.6 19.6 Q5 17.6 5.6 15.9 Q10.6 10.8 16 5.2 Q17.6 4 18.9 5.3 Q20 6.6 18.7 8 Q13.3 13.4 8.2 18.5 Q6.5 19.2 4.6 19.6"/><path d="M14.4 6.9 Q15.8 8.1 17.1 9.6"/>')
// Send and reverse (the words go back with the card, for rework): while Shift is held, Send is the reverse card, and
// a click sends so; Ctrl+Enter (⌘+Enter) from the field; and for who does not know, a small quiet chevron beside
// Send, whose menu holds
// "Send and Reverse" and says "Hold Shift" (ui.mjs watchShift sets <html data-shift>, card.css turns Send; controller
// "card": sendClick, sendReverse).
const CTRL_WORD = /Mac|iPhone|iPad/.test(globalThis.navigator?.platform ?? '') ? '⌘' : 'Ctrl'
const CHEVRON = pen('<path d="M6.4 14.6 Q9.4 11.8 12.1 9.2 Q14.9 11.9 17.6 14.4"/>')
/** Send, and where the card can go back (an open decision or info) the reverse card on it while Shift is held over it,
 *  and the chevron beside it: a small menu above with "Send and Reverse". */
function sendButton(canReverse, asker) {
  const to = asker || 'the agent'
  const send = html`<button class="tc-send" type="submit" name="stay" value="1" title="Send to the agent (Enter); the question stays with you${canReverse ? `. Hold Shift (or ${CTRL_WORD}+Enter): send and reverse, back to ${to}` : ''}" aria-label="Send to the agent" data-action="click->card#sendClick">${sk('send')}${canReverse ? html`<span class="tc-send-uno" aria-hidden="true">${sk('reverse')}</span>` : ''}</button>`
  if (!canReverse) return send
  return html`<span class="tc-send-split">${send}<details class="tc-send-menu" data-controller="pops"><summary class="tc-send-more" title="More ways to send" aria-label="More ways to send">${CHEVRON}</summary><div class="tc-send-pop" role="menu"><button type="button" role="menuitem" class="tc-send-rev" data-action="card#sendReverse" data-pop-close><span class="tc-send-rev-uno" aria-hidden="true">${sk('reverse')}</span><span>Send and Reverse</span><small>back to ${to} for rework</small><small class="tc-send-hint">or hold <kbd>Shift</kbd> and press Send</small></button></div></details></span>`
}
const imagesOf = card => (card.attachments ?? []).filter(a => kindOf(a) === 'image')
const videosOf = card => (card.attachments ?? []).filter(a => kindOf(a) === 'video')
/** What is attached and is neither picture nor video (a table, a log, a sound): shown as files. */
const filesOf = card => (card.attachments ?? []).filter(a => !['image', 'video'].includes(kindOf(a)))
const sizeWord = n => (n >= 1e6 ? `${(n / 1e6).toFixed(1)} MB` : n >= 1e3 ? `${Math.round(n / 1e3)} kB` : `${n} B`)
/** One attached file, to open: the clip, its name, its size. The same on the card and in the talk. */
const fileChip = a => html`<a class="tc-file" href="${a.url}" target="_blank" rel="noopener" title="Open ${a.name}">${sk('clip')}<b>${a.name}</b>${a.size > 0 ? html`<i>${sizeWord(a.size)}</i>` : ''}</a>`
// The pen's circle round an answer in the talk, as wide as its tile.
const RING = raw('<svg class="tc-deed-ring" viewBox="0 0 100 40" preserveAspectRatio="none" aria-hidden="true"><path d="M9 23 C5 9 28 3.4 54 4 C80 4.6 96.4 10 94.6 21 C92.6 33 68 37 45 36.2 C21 35.4 4.6 31 8.4 17 C10 11.6 16 8 25 6.2" vector-effect="non-scaling-stroke"/></svg>')
/** The version that stands now, as a number. */
const liveVersion = card => card.version ?? (card.versions?.at(-1)?.n ?? 0) + 1
/** The card as it was in version n (title, text, options, pictures), or null. */
const versionOf = (card, n) => (n != null && n < liveVersion(card) ? card.versions?.find(v => v.n === n) ?? null : null)

// ---- what the card holds, and what goes to the comments ----
// The card is as long as its words: every paragraph stands on it and the page scrolls. A layout, a table or code never
// stands on the card: those are in the comments, as "The whole text", and the card says so.
/** -> { shown: the text for the card (markdown), more: whether the comments hold more } */
function fitText(text) {
  const source = String(text ?? '')
  // (where a code block or a table stood, one quiet line says so: a sentence that ends in a colon is not left hanging)
  const MOVED = { code: '*↓ code, in the whole text below*', table: '*↓ table, in the whole text below*' }
  const parts = source.replace(/```[\s\S]*?```/g, `\n\n${MOVED.code}\n\n`).split(/\n{2,}/).map(p => p.trim()).filter(Boolean).map(p => (/^\s*\|.*\|\s*$/m.test(p) ? MOVED.table : p))
  const prose = parts.filter((p, i) => !(Object.values(MOVED).includes(p) && Object.values(MOVED).includes(parts[i - 1])))
  return { shown: prose.join('\n\n'), more: /```|^\s*\|/m.test(source) }
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
  return images.map((a, i) => { const all = shared(i), key = keys.get(i) ?? null; return { at: i + 1, src: thumb(a).src, width: a.width > 0 ? a.width : null, height: a.height > 0 ? a.height : null, name: a.name, title: a.title && a.title !== a.name ? a.title : '', page: a.page ? { ...a.page, view: a.page.kind === 'file' ? `${cardPath(card, base)}/picture/${i + 1}/page` : null } : null, marks: a.marks ?? [], key, keys: all.length ? all : key != null ? [key] : [], href: `${cardPath(card, base)}/picture/${i + 1}` } })
}
/** Where one stands among the pictures and videos: "2 / 6", at the end of the bar of small ones. */
const count = (i, n) => (n > 1 ? html`<b class="tc-count" data-card-target="where" aria-label="${i} of ${n}">${i} / ${n}</b>` : '')
/** The small pictures to pick from: the one that stands is marked; the pointer on one shows it (controller "card").
 *  Each lies on a ground with a drawn picture, so one that has not come yet is not a hole. Its tooltip is the
 *  caption its agent gave it, or the file's name. */
const strip = (images, i, to) => html`<span class="tc-strip" data-action="pointerover->card#peek focusin->card#peek pointerleave->card#unpreview focusout->card#unpreview">${images.map((p, n) => html`<a class="tc-thumb" data-nav href="${to(n + 1)}" data-turbo-action="replace" data-at="${n + 1}" title="${p.title && p.title !== p.name ? p.title : p.name}" aria-label="Show picture ${n + 1}: ${p.name}" aria-pressed="${String(n + 1 === i)}">${sk('picture')}<img${srcOf(p)} alt="" loading="lazy" decoding="async" draggable="false" width="48" height="34"></a>`)}</span>`
/** The videos' small tiles, after the pictures: the same tile with a play mark. */
const clips = (videos, i, to, from) => videos.map((p, n) => html`<a class="tc-thumb tc-thumb-video" data-nav href="${to(from + n + 1)}" data-turbo-action="replace" title="${p.name}" aria-label="Show video ${n + 1}: ${p.name}" aria-pressed="${String(from + n + 1 === i)}">${icon(PLAY)}</a>`)
/** The files that are neither picture nor video, as tiles of the same bar after them: a click opens the file in a new tab. */
const attTile = a => html`<a class="tc-thumb tc-thumb-file" href="${a.url}" target="_blank" rel="noopener" title="${a.name}${a.size > 0 ? ` · ${sizeWord(a.size)}` : ''}" aria-label="Open ${a.name} in a new tab">${sk('clip')}<b>${a.name}</b></a>`
/** A picture's shape on the stage, from its size: one more than a quarter taller than wide (TALL) is not fitted into
 *  the stage but stands at its width and is scrolled; a phone's screenshot (SLIM) is kept narrow. */
const TALL = 1.25, SLIM = 1.8
const shapeOf = (w, h) => (w > 0 && h > 0 && h / w > TALL ? (h / w >= SLIM ? ['is-tall', 'is-slim'] : ['is-tall']) : [])
/** The picture's shown width: its own, never wider than its place (a phone's screenshot is not blown up). */
const ownWidth = a => (a.width > 0 ? raw(` style="width:${Number(a.width)}px"${a.height > 0 ? ` width="${Number(a.width)}" height="${Number(a.height)}"` : ''}`) : '')

/** The picture of the card: one at a time on a stage of ONE fixed size (16:10 of the column, never taller than the
 *  card allows), the same for every picture and video of the card, so no hover, pick or late picture moves anything.
 *  A picture is fitted into the stage and centred; a tall one (shapeOf) stands at its width, its top first, and is scrolled inside the stage: by the wheel,
 *  a finger, its scrollbar, and by dragging it with the mouse. A click on it opens it large on its own page. On the stage's lower edge: the caption
 *  its agent gave it, and the page behind it. Under the stage ONE bar: the pictures and videos as small ones to pick
 *  (?pic= counts on through the videos), the other files as tiles (a click opens one in a new tab), and which one
 *  stands ("2 / 6"). A frame of its own, so picking another loads only this. A video stands on the stage as a player
 *  (decrypted to a blob by att.mjs / sw.js; never autoplays): a click on it plays and pauses, so the way to the large
 *  view is a small button in the stage's corner ("Enlarge"). */
function cardMedia(card, base, at = 1, query = '') {
  const images = imagesOf(card), videos = videosOf(card), all = [...images, ...videos], files = filesOf(card)
  if (!all.length) return files.length ? html`<div class="tc-media"><div class="tc-thumbs" aria-label="Attached files"><span class="tc-roll">${files.map(attTile)}</span></div></div>` : ''
  const i = Math.min(Math.max(1, at), all.length), a = all[i - 1], video = i > images.length
  const here = cardPath(card, base)
  const to = n => `${here}?pic=${n}${query}`
  const key = video ? undefined : pictureKeys(card).get(i - 1)
  const step = (n, cls, label, d) => (all.length > 1 ? html`<a class="tc-step ${cls}" data-nav href="${to(n)}" data-turbo-action="replace" aria-label="${label}">${icon(d)}</a>` : '')
  const said = !video && a.title && a.title !== a.name ? a.title : ''
  const shown = video
    ? html`<figure class="tc-video"><video src="${a.url}#t=0.001" controls playsinline preload="metadata" aria-label="Video ${i} of ${all.length}: ${a.name}"></video></figure><a class="tc-enlarge" data-nav href="${here}/picture/${i}" data-turbo-frame="_top" title="Enlarge" aria-label="Enlarge video ${i - images.length}: ${a.name}">${icon(GROW)}</a>`
    : html`<div class="tc-scroll"><a class="tc-figure is-wait ${shapeOf(a.width, a.height).join(' ')}" draggable="false" data-nav href="${here}/picture/${i}" data-turbo-frame="_top" data-card-target="figure" data-at="${i}" title="Open it large" aria-label="Picture ${i} of ${images.length}: ${a.name}. Open it large"${key != null ? html` data-key="${key}"` : ''} data-controller="circles" data-circles-marks-value="${JSON.stringify(a.marks ?? [])}"><img alt=""${srcOf(a)}${ownWidth(a)} decoding="async" draggable="false"></a></div>
<span class="tc-said" data-card-target="said"${said ? '' : raw(' hidden')}>${said}</span>${pageChip(a.page, true, `${here}/picture/${i}/page`)}`
  return html`<turbo-frame id="card-media-${card.id}" class="tc-media">
<div class="tc-stage${video ? ' is-video' : ''}" data-at="${i}">${shown}${step(i > 1 ? i - 1 : all.length, 'is-prev', 'The one before', ARROW_L)}${step(i < all.length ? i + 1 : 1, 'is-next', 'The next one', ARROW_R)}</div>
${all.length > 1 || files.length ? html`<div class="tc-thumbs"><span class="tc-roll">${all.length > 1 ? html`${strip(images, i, to)}${clips(videos, i, to, images.length)}` : ''}${files.map(attTile)}</span>${count(i, all.length)}</div>` : ''}
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
  const place = old ? null : placeOf(card, model)
  const shown = old ? { ...card, title: old.title ?? card.title, body: old.body ?? '', sections: old.sections } : card
  const { shown: text, more } = fitText(textOf(shown))
  const said = talkOf(model, card).filter(m => m.from !== 'event' && (m.text || m.attachments?.length)).length
  const notes = [cardNote(card), old ? `version ${old.n}, as it was` : '', said ? (said === 1 ? '1 message below' : `${said} messages below`) : ''].filter(Boolean)
  return html`<div class="tc-lead focus-lead" id="card-lead-${card.id}">
${isKnock(card) && card.status === 'open' ? html`<span class="inbox-tab tc-knock">${sk('knock')}${knockWord(card)}</span>` : ''}
<h1 class="tc-title" id="card-title-${card.id}">${shown.title}</h1>
<p class="tc-meta">${from ? html`<a class="tc-from" data-nav href="${base}/s/${encodeURIComponent(from.id)}" style="--hue:${from.hue}">${raw(doodleSvg(from.mark))}${from.name}</a><span aria-hidden="true">·</span>` : ''}${agoSpan(card.revised ?? card.created, 'tc-ago')}<span aria-hidden="true">·</span><span>${cardNr(card)}</span>${place ? html`<span aria-hidden="true">·</span><span class="tc-count" title="Where this question stands on the Desk">${place.at} of ${place.of}</span>` : ''}${notes.length ? html`<span aria-hidden="true">·</span><a href="#card-thread-${card.id}">${notes.join(' · ')}</a>` : ''}</p>
${text ? html`<div class="tc-text">${rich(text, { assets: model.state.assets })}</div>` : ''}${more ? html`<a class="tc-more-text" href="#card-whole-${card.id}">More in the comments ↓</a>` : ''}
</div>`
}

// The reverse card: one press hands the card back at once, "put this before me again". Nothing opens and nothing is
// asked: the session reworks the card with the comments under it in mind (what should change is written there first).
// A button of the card's form: what stands unsent in the field and what is drawn on the card go along.
const reviseTile = (card, model, base) => { const to = model.byAgent.get(card.agent)?.name ?? 'the agent', tip = `Reverse: back to ${to} for rework, with the comments`; return html`<button class="tc-tile tc-reverse" type="submit" form="card-form-${card.id}" formaction="${act(card, base, 'revise')}" name="next" value="1" title="${tip} (B)" aria-label="${tip}">${sk('reverse')}</button>` }
const still = (label, detail = '', cls = '') => html`<div class="tc-opt is-still ${cls}"><span class="tc-opt-words"><span class="tc-opt-label">${label}</span>${detail ? html`<span class="tc-opt-detail">${detail}</span>` : ''}</span></div>`
const BACK_ARROW = raw('<svg viewBox="0 0 24 24" class="sketch tc-undo-ico" aria-hidden="true"><path d="M9.8 5.6 Q6.8 8.4 4.3 11.2 Q7.1 13.8 10 16.6"/><path d="M4.9 11.1 Q10.4 10.4 14.9 11.2 Q19.8 12.5 19.5 16.4 Q19 19.5 15 19.7"/></svg>')
/** The way back from what was said: a quiet link with the pen's return arrow, at the end of the answer's own line. */
const back = (card, base, way, word = WORDS.takeBack) => html`<button class="tc-undo" type="submit" form="card-form-${card.id}" formaction="${act(card, base, way)}">${BACK_ARROW}<span>${word}</span></button>`
/** The line under what was said: who did it and when, and the way back at its right end. */
const saidFoot = (words, ts, way = '') => html`<p class="tc-ans-foot"><span>${words}</span>${ts ? html`<i aria-hidden="true">·</i>${agoSpan(ts, 'ago')}` : ''}${way}</p>`
/** The answer that stands: the tile in the accent, the pen's tick at its left (as "Got it": done, at a glance). */
const stood = (label, detail = '') => html`<div class="tc-opt is-still is-picked">${sk('tick')}<span class="tc-opt-words"><span class="tc-opt-label">${label}</span>${detail ? html`<span class="tc-opt-detail">${detail}</span>` : ''}</span></div>`

/** Under the answers: whether the card's session can hear the human, whether it has the answer (the receipt), and the step in its terminal. */
function cardLink(card, model) {
  const agent = model.byAgent.get(card.agent), link = linkOf(agent)
  if (!link || card.status === 'shredded' || card.status === 'done' || card.settled) return ''
  const n = agent.name, h = heardOf(card), mins = ms => `${Math.max(1, Math.round(ms / 60000))} min`
  const state = link.state !== 'live' ? link : null
  // Not answered yet: only what the human should know before answering (a session that hears on its next step is nothing to warn of).
  if (!h) return state && state.state !== 'oncall' ? linkNote(state) : ''
  if (h.heard == null) return state ? linkNote(state, { receipt: `Your answer waits for ${n}.` }) : ''   // a connector without receipts
  const receipt = h.heard ? `${n} has your answer.` : h.late ? `${n} has not picked up your answer, sent ${mins(h.waiting)} ago.` : `Your answer is on its way to ${n}.`
  if (state) return linkNote(state, { receipt })
  return linkNote(h.late ? { state: 'unheard', fix: { say: 'Look at its terminal: type anything to wake it, or reconnect it with', code: '/mcp → trommi → Reconnect' } } : null, { receipt, sign: h.heard ? 'tick' : 'letter', tone: h.heard ? 'heard' : h.late ? 'unheard' : 'sent' })
}
/** What the field to write in says: who reads it, and when, if the session does not hear at once. */
function askWords(card, model, asker) {
  const link = linkOf(model.byAgent.get(card.agent))
  if (link?.state === 'cut') return `${asker || 'The agent'} cannot hear you right now. What you write waits for it…`
  if (link?.state === 'gone') return `${asker || 'The agent'} is gone. What you write waits for it…`
  if (link?.state === 'asleep' || link?.state === 'oncall') return `Reaches ${asker || 'the agent'} on its next step…`
  return asker ? `Ask ${asker} something, or say what is missing…` : 'Ask something, or say what is missing…'
}
/** The options' own paragraphs (a card written as sections), folded under the options. Only when one says more than its
 *  label: an option with nothing beyond its label (a card of body and options) brings no fold. */
const beyond = s => s.html || String(s.text ?? '').replace(/[\s*_.:,;!?\-–—]+/g, ' ').trim().toLowerCase().replace(String(s.label ?? '').replace(/[\s*_.:,;!?\-–—]+/g, ' ').trim().toLowerCase(), '').trim()
function optionsSaid(card, assets) {
  const secs = (card.sections ?? []).filter(s => s.key != null)
  if (!secs.some(beyond)) return ''
  return html`<details class="tc-fold tc-options-said"><summary>Options in detail</summary>${secs.map(s => html`<section class="tc-sec"><h3>${s.label}${s.recommended ? html` <span class="tc-advised-word">recommended</span>` : ''}</h3>${beyond(s) ? rich(s.text ?? '', { assets, extra: s.html ?? '', hand: false }) : ''}</section>`)}</details>`
}
/** The right column's answers (#card-answer-<id>): every option a button of the card's form, with its line for a note;
 *  then "or" Whatever. Or, once answered or handed back, what was said and the way back. */
function cardAnswer(card, model, base, { error = '', version = null, pic = 1 } = {}) {
  const form = `card-form-${card.id}`
  const err = html`<p class="tc-error" role="alert"${error ? '' : raw(' hidden')}>${error}</p>`
  const old = versionOf(card, version)
  // (The revised stamp stands with the options: a rewrite that brings new options brings its stamp along.)
  const stamp = card.revised ? html`<input type="hidden" name="revised" value="${card.revised}" form="${form}">` : ''
  const box = inner => html`<div class="tc-answer" id="card-answer-${card.id}">${err}${stamp}${inner}${old ? '' : cardLink(card, model)}</div>`
  if (old) return box(html`<div class="tc-opts">${(old.options ?? []).map(o => still(o.label, plain(o.detail)))}</div><p class="tc-quiet">Version ${old.n} cannot be answered. <a data-nav href="${cardPath(card, base)}">The question as it stands now</a></p>`)
  if (card.status !== 'open') {
    const picked = card.choices?.length ? card.choices : [card.choice]
    const said = card.status === 'shredded' ? 'Shredded' : card.kind === 'info' ? 'Read' : card.trusted ? `${WORDS.trust}${advisedLabels(card) ? `: ${advisedLabels(card)}` : ''}` : card.options.filter(o => picked.includes(o.key)).map(o => o.label).join(', ') || 'Withdrawn by the agent'
    const can = card.status === 'shredded' || card.choice != null || card.trusted || (card.kind === 'info' && card.read)
    const did = card.status === 'shredded' ? 'You shredded it' : card.kind === 'info' ? 'You read it' : card.trusted ? 'You left it to the agent' : can ? 'You chose' : ''
    return box(html`<div class="tc-opts">${stood(said, card.note ? `Your note: ${card.note}` : '')}${did ? saidFoot(did, card.decided, can ? back(card, base, 'reopen') : '') : ''}${card.options.filter(o => card.option_notes?.[o.key]).map(o => still(o.label, `Your note: ${card.option_notes[o.key]}`))}${card.settled ? still(html`${sk('tick')}${SETTLED}`, `${model.byAgent.get(card.agent)?.name ?? 'The agent'} marked this answer as final: nothing follows from it.`, 'is-settled') : ''}${card.summary ? still('Done by the agent', card.summary) : ''}</div>${card.finished ? html`<button class="tc-tile is-what tc-done-what" type="submit" form="${form}" formaction="${act(card, base, 'what')}" title="${WORDS.what}: ask the session about what it did">${sk('what')}</button>` : ''}`)
  }
  // A card of a newer Trommi: nothing to answer from here; the room's notice offers the reload.
  if (card.unsupported) return box(html`<p class="tc-quiet">${NEEDS_NEWER}</p>`)
  if (card.with_agent) return box(html`<div class="tc-opts">${still(WORDS.revising, 'It is with its session and comes back reworked.')}${saidFoot('You handed it back', card.with_agent, back(card, base, 'takeback'))}</div>`)
  // An info: Got it is its answer; at the column's foot What?? and the reverse card, as on a decision (the reverse
  // card hands it back for rework with the comments; Ctrl+Enter does the same from the field).
  if (card.kind === 'info') return box(html`<div class="tc-or tc-info-ways"><button class="tc-tile is-ack" type="submit" form="${form}" formaction="${act(card, base, 'close')}" title="${WORDS.ack}: read, close it">${sk('tick')}<span>${WORDS.ack}</span></button><div class="tc-or-pair"><button class="tc-tile tc-wtf is-what" type="submit" form="${form}" formaction="${act(card, base, 'what')}" title="${WORDS.what}: ask the session to explain this; it comes back explained" aria-label="What?? — explain this to me">${sk('what')}</button>${reviseTile(card, model, base)}</div></div>`)
  const advised = advisedKeys(card)
  const shownKey = pictureKeys(card).get(pic - 1)
  const draft = card.draft ?? {}
  const option = o => {
    const is = advised.includes(o.key), noted = String(draft.notes?.[o.key] ?? ''), final = o.final === true
    // (A link written into an option is not on its tile: the tile says it in plain words, the link stands in the comments.)
    const words = html`<span class="tc-opt-words"><span class="tc-opt-label"${is ? raw(' data-controller="advice"') : ''}>${o.label}</span>${o.detail ? html`<span class="tc-opt-detail">${plain(o.detail)}</span>` : ''}${is ? raw('<span class="tc-sr">, recommended by the agent</span>') : ''}</span>${final ? finalSign(true) : ''}`
    const pen = card.kind === 'decision' ? html`<span class="tc-opt-pen" data-key="${o.key}" data-action="click->card#note" title="A note on this option"${noted ? raw(' data-noted') : ''}>${sk('pen')}</span>` : ''
    const marks = html`${is || final ? html` title="${[is ? 'The agent recommends this' : '', final ? FINAL_TIP : ''].filter(Boolean).join(' · ')}"` : ''}${shownKey === o.key ? raw(' data-match') : ''}`
    const tile = card.multiple
      ? html`<label class="tc-opt${is ? ' is-advised' : ''}" data-key="${o.key}"${marks}><input type="checkbox" id="tick-${card.id}-${o.key}" name="keys" value="${o.key}" form="${form}" data-action="change->card#keep"${draft.keys?.includes(o.key) ? raw(' checked') : ''}><span class="tc-tick" aria-hidden="true">${icon(TICK)}</span>${words}${pen}</label>`
      : html`<button class="tc-opt${is ? ' is-advised' : ''}" type="submit" form="${form}" formaction="${act(card, base, 'decide')}" name="key" value="${o.key}" data-key="${o.key}"${marks}>${words}${pen}</button>`
    return card.kind === 'decision' ? html`${tile}<label class="tc-opt-note" data-note="${o.key}"${noted ? '' : raw(' hidden')}>${sk('pen')}<input type="text" name="note-${o.key}" form="${form}" value="${noted}" maxlength="2000" placeholder="A note on ${o.label}" aria-label="A note on ${o.label}" autocomplete="off" data-action="input->card#keep blur->card#noteLeft keydown->card#noteKey"></label>` : tile
  }
  const trustTip = `I don’t give a duck: your call (R)${advisedLabels(card) ? ` · agent takes ${advisedLabels(card)}` : ''}`
  return box(html`<div class="tc-opts" data-action="pointerover->card#preview focusin->card#preview pointerleave->card#unpreview focusout->card#unpreview" role="group" aria-label="${card.multiple ? 'Your answer. Tick what applies, then send.' : 'Your answer. One tap answers.'}">${[...card.options].sort((a, b) => Number(advised.includes(a.key)) - Number(advised.includes(b.key))).map(option)}${card.multiple ? html`<button class="tc-opt tc-send-many" type="submit" form="${form}" formaction="${act(card, base, 'decide')}"><span class="tc-opt-words"><span class="tc-opt-label">Send the answer</span></span></button>` : ''}</div>${optionsSaid(card, model.state.assets)}
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
 *  - What was done with the card, each act as the thing itself at its moment: the session's sheet (asked), a version's
 *    sheet with its number, the reverse card (handed back), the answer's tile in the pen's circle, the duck, the tick
 *    (read), the shredder, Later's tag, the sheet with a tick (closed). A thing taken back lies there again, faded.
 *  - Everything before the version that stands now folds away behind "Earlier versions (n)". */
function cardThread(card, model, base = '', { more = false } = {}) {
  const all = talkOf(model, card)
  const assets = model.state.assets
  const who = model.byAgent.get(card.agent)
  const files = list => { const rest = (list ?? []).filter(a => kindOf(a) !== 'image' && kindOf(a) !== 'video'); return rest.length ? html`<p class="tc-files">${rest.map(fileChip)}</p>` : '' }
  // A video in the talk (the clip an agent makes after What??) plays where it is said, never by itself.
  const vids = list => { const v = (list ?? []).filter(a => kindOf(a) === 'video'); return v.length ? html`<div class="tc-vids">${v.map(a => html`<figure class="tc-vid"><video src="${a.url}#t=0.001" controls playsinline preload="metadata" aria-label="Video: ${a.name}"></video></figure>`)}</div>` : '' }
  const shots = list => { const pics = (list ?? []).filter(a => kindOf(a) === 'image'); return pics.length ? html`<div class="shots">${pics.map(a => html`<a href="${a.url}" target="_blank" rel="noopener"><img${srcOf(a, 320)} alt="${a.name}" loading="lazy" decoding="async"></a>`)}</div>` : '' }
  // One column, every piece in the same two places: at the left who (the session's small drawing, the pen for you),
  // beside it the name, when, and the words. A line that only says where things stand (waiting for the explanation)
  // is one quiet line on the words' line, without a who.
  const did = (text, ts) => html`<p class="tc-did"><span>${text}</span>${ts ? agoSpan(ts, 'msg-time') : ''}</p>`
  const name = who?.name ?? card.agent
  // An act: where a message has its who lies the thing the app draws for it, beside it one quiet line (what, when),
  // under it what was written along. tiles: an answer's options, before the line.
  const deed = (thing, cap, ts, { tiles = '', said = [], more = '', cls = '' } = {}) => html`<div class="tc-deed ${cls}"><span class="tc-deed-thing" aria-hidden="true">${thing}</span><div class="tc-deed-in">${tiles}<p class="tc-deed-cap"><span>${cap}</span>${ts ? agoSpan(ts, 'msg-time') : ''}</p>${said.filter(Boolean).map(t => html`<p class="tc-deed-said">${t}</p>`)}${more}</div></div>`
  const uno = html`<span class="tc-uno">${sk('reverse')}</span>`
  const sheet = (inner, cls = '') => html`<span class="tc-sheet ${cls}">${inner}</span>`
  const read = html`<span class="tc-read">${sk('tick')}</span>`
  const tiles = (labels, back = false) => html`<span class="tc-picked-row">${labels.map(l => html`<span class="tc-picked"><b>${l}</b>${back ? '' : RING}</span>`)}</span>`
  const along = m => html`${shots(m.files)}${vids(m.files)}${files(m.files)}`
  // An answer (m: the event, app.mjs eventsOf), or the same answer taken back.
  const answered = (m, back = false) => {
    const said = back ? [] : [m.note ? `“${m.note}”` : '', ...(m.notes ?? []).map(([label, note]) => `On ${label}: “${note}”`)]
    const more = back ? '' : along(m), cls = back ? 'is-undone' : ''
    if (m.trusted) return deed(sk('duck'), back ? 'You took the duck back' : html`${WORDS.trust}: ${name} decides${m.labels?.length ? html` and takes <b>${m.labels.join(', ')}</b>` : ''}`, m.ts, { said, more, cls: `is-duck ${cls}` })
    const old = m.version && m.version < liveVersion(card) ? ` in version ${m.version}` : ''
    const settled = m.settled && !back ? html`<span class="tc-settled">${sk('tick')}${SETTLED}</span>` : ''
    return deed(sk(back ? 'back' : 'tick'), back ? 'You took your answer back' : `You chose${old}`, m.ts, { tiles: html`${tiles(m.labels?.length ? m.labels : [m.text], back)}${settled}`, said, more, cls: `is-chosen ${cls}` })
  }
  const mark = who ? html`<span class="tc-c-who" style="--hue:${who.hue}" aria-hidden="true">${raw(doodleSvg(who.mark))}</span>` : html`<span class="tc-c-who" aria-hidden="true"></span>`
  const you = html`<span class="tc-c-who is-you" aria-hidden="true">${sk('pen')}</span>`
  const head = (title, ts, by = name) => html`<header class="msg-head"><span class="msg-name">${by}</span>${title ? html`<b class="tc-said">${title}</b>` : ''}${ts ? agoSpan(ts, 'msg-time') : ''}</header>`
  const words = text => rich(text ?? '', { assets, hand: false })
  const agentMsg = (m, cont = false) => html`<article class="msg msg-agent tc-c${cont ? ' cont' : ''}" id="msg-${m.id}">${cont ? '' : mark}<div class="tc-c-in">${cont ? '' : head('', m.ts)}${rich(m.text ?? '', { assets, extra: m.html ?? '', hand: false })}${shots(m.attachments)}${vids(m.attachments)}${files(m.attachments)}${m.details ? html`<details class="msg-details"><summary>Details</summary>${words(m.details)}</details>` : ''}</div></article>`
  const userMsg = (m, text = m.text) => html`<article class="msg msg-user tc-c" id="msg-${m.id}">${you}<div class="tc-c-in">${head('', m.ts, 'You')}${text ? html`<div class="bubble"><p>${text}</p></div>` : ''}${shots(m.attachments)}${vids(m.attachments)}${files(m.attachments)}</div></article>`
  const isBare = m => (m.handback && m.text?.trim() === HAND_BACK_TEXT) || (m.explain && m.text?.trim() === EXPLAIN_TEXT)

  // ---- what the card did not hold ----
  const lead = []
  const whole = textOf(card)
  if (fitText(whole).more) lead.push(html`<article class="msg msg-agent tc-c tc-whole" id="card-whole-${card.id}">${mark}<div class="tc-c-in">${head('The whole text')}${rich(whole, { assets, extra: card.html ?? '', hand: false })}</div></article>`)
  else if (card.html) lead.push(html`<article class="msg msg-agent tc-c tc-whole" id="card-whole-${card.id}">${mark}<div class="tc-c-in">${head('With the text')}${rich('', { assets, extra: card.html })}</div></article>`)
  const links = optionLinks(card)
  if (String(links)) lead.push(links)
  if (card.status === 'open' && card.snoozed_until) lead.push(deed(LATER_TAG, `You put it off: it waits on “${WORDS.later}”`, card.snoozed_at, { cls: 'is-later' }))

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
        // The version before stays readable here, as the talk does: it opens in place (title, text, options, pictures).
        const more = before ? html`<details class="tc-turn-before"><summary>See version ${before.n}</summary><div class="tc-was"><b class="tc-was-title">${before.title || card.title}</b>${textOf(before) ? words(fitText(textOf(before)).shown) : ''}${before.options?.length ? html`<div class="tc-opts">${before.options.map(o => still(o.label, plain(o.detail)))}</div>` : ''}${shots(before.attachments)}${files(before.attachments)}<a class="tc-was-open" data-nav href="${cardPath(card, base)}?v=${before.n}">Open version ${before.n} as it was</a></div></details>` : ''
        items.push({ turn: m.version, html: html`<div class="tc-turn" id="turn-${m.id}" data-version="${m.version}">${deed(sheet(html`<b>${m.version}</b>`, 'is-again'), html`<b>Version ${m.version}${asked ? ', as you asked' : ''}</b>`, m.ts, { said: [note], more })}</div>` })
      } else if (m.kind === 'handback_withdrawn') items.push({ html: deed(uno, 'You took it back', m.ts, { cls: 'is-undone' }) })
      else if (m.kind === 'decided') items.push({ html: answered(m) })
      else if (m.kind === 'read') items.push({ html: deed(read, 'You read it', m.ts) })
      else if (m.kind === 'shredded') items.push({ html: deed(sk('shred'), 'You shredded it', m.ts, { said: [m.note ? `“${m.note}”` : ''], more: along(m), cls: 'is-shred' }) })
      else if (m.kind === 'reopened') items.push({ html: m.was === 'read' ? deed(read, 'You took it back: unread again', m.ts, { cls: 'is-undone' }) : m.was === 'shredded' ? deed(sk('shred'), 'You took it out of the shredder', m.ts, { cls: 'is-shred is-undone' }) : answered(m, true) })
      else if (m.kind === 'done') items.push({ html: deed(sheet(sk(m.withdrawn ? 'bin' : 'tick'), 'is-done'), html`<b>${name} ${m.withdrawn ? 'withdrew' : 'closed'} it</b>`, m.ts, { said: [m.withdrawn ?? m.text] }) })
      continue
    }
    if (m.from === 'user' && m.present) { items.push({ html: deed(uno, 'You took it back', m.ts, { cls: 'is-undone' }) }); askedAt = -1; continue }
    if (!m.text && !m.attachments?.length) continue
    if (m.from === 'user' && m.explain && isBare(m)) {
      // What?? and what the session answered to it, as one block.
      const answers = []
      while (all[i + 1] && all[i + 1].from === 'agent') answers.push(all[++i])
      items.push({ html: html`<section class="tc-explained">${deed(sk('what'), 'You asked for an explanation', m.ts, { cls: 'is-what' })}${answers.length ? answers.map((a, n) => agentMsg(a, n > 0)) : did('Waiting for the explanation.')}</section>` })
      continue
    }
    // (a hand-back is the reverse card itself; what was written with it stands under it)
    if (m.from === 'user' && m.handback) { askedAt = items.length; items.push({ handback: true, html: html`<div id="msg-${m.id}">${deed(uno, 'You handed it back', m.ts, { said: [isBare(m) ? '' : m.text], more: html`${shots(m.attachments)}${vids(m.attachments)}${files(m.attachments)}` })}</div>` }); continue }
    if (m.from === 'user') { items.push({ html: userMsg(m, m.text === EXPLAIN_TEXT ? WORDS.what : m.text) }); continue }
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
  // The newest ten entries stand; the ones before wait in groups of ten behind a quiet "Load earlier (N)" (card#earlier).
  const SHOW = 10, cut = Math.max(0, now.length - SHOW)
  const groups = []
  for (let end = cut; end > 0; end -= SHOW) groups.unshift(now.slice(Math.max(0, end - SHOW), end))
  const hidden = groups.map(g => html`<div class="tc-earlier-group" hidden>${g.map(x => x.html)}</div>`)
  const loadEarlier = cut ? html`<button type="button" class="tc-load-earlier" data-action="card#earlier">Load earlier (${cut})</button>` : ''
  return html`<section class="tc-feed" id="card-thread-${card.id}" aria-label="Comments"${why || any ? '' : raw(' hidden')}>${why}${loadEarlier}${any ? deed(sheet(who ? raw(doodleSvg(who.mark)) : ''), `${name} ${card.kind === 'info' ? 'sent this to read' : 'asked'}`, card.created, { cls: 'is-asked' }) : ''}${lead}${older}${folded}${hidden}${now.slice(cut).map(x => x.html)}</section>`
}

/** Where the card stands in the stack, for the walk: { at, of, prev, next } (cards), or null when it is not waiting. */
function placeOf(card, model) {
  const walk = walkOf(model), at = walk.indexOf(card)
  return at < 0 ? null : { at: at + 1, of: walk.length, prev: walk[at - 1] ?? null, next: walk[at + 1] ?? null }
}

/** The whole <main> of a card's page. pic: which picture stands. walk: a step of "Next, please". version: as it was
 *  then. from: the session it was opened from (/s/<id>/card/<n>): the way back and the links lead there. */
function cardPage(card, model, base, { pic = 1, walk = false, error = '', version = null, from = null, more: older = false, full = false, focus = false } = {}) {
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
  const videos = videosOf(old ? { attachments: old.attachments ?? card.attachments } : card).length
  const media = images.length + videos
  const large = Boolean(full && media)
  const keep = focus ? raw(FOCUS_FIELD) : ''
  const shownPic = Math.min(Math.max(1, pic), Math.max(1, media))
  const step = (to, cls, label, art) => (to ? html`<a class="tc-rail ${cls}" data-nav href="${cardPath(to, self)}${walk ? '?walk=1' : ''}" aria-label="${label}: ${to.title}" title="${label}: ${to.title}">${art}</a>` : '')
  const form = `card-form-${card.id}`
  const asker = model.byAgent.get(card.agent)?.name ?? ''
  // The tray: card and talk lie on one drawn desk pad in the session's pale tone (four hatched corners; the round
  // buttons stand in a row above the card, clear of them). When the card
  // has scrolled out of view a slim strip of its paper stays under the top edge: the title, the answers as chips (the
  // card's own buttons again: the same form, the same addresses), the duck, What??, the reverse card, Later's tag.
  const corner = cls => raw(`<svg class="tc-corner ${cls}" viewBox="0 0 64 64" aria-hidden="true"><path d="M1.5 1.5 Q30 2.4 61 1.8 Q32 31 2.2 61 Q1 30 1.5 1.5 Z"/><path d="M8 40 L40 8 M8 26 L26 8 M8 13 L13 8" class="hatch"/></svg>`)
  // (Reverse goes on to the next card, as the card's own reverse tile does: name="next")
  const mini = (cls, way, tip, art) => html`<button class="tc-mini ${cls}" type="submit" form="${form}" formaction="${act(card, base, way)}"${way === 'revise' ? raw(' name="next" value="1"') : ''} title="${tip}" aria-label="${tip}">${art}</button>`
  const jump = html`<button class="tc-chip is-jump" type="button" data-action="card#toAnswers">To the answers ↑</button>`
  const few = open && card.kind === 'decision' && !card.multiple && card.options.length <= 4
  const strip = html`<div class="tc-bar" aria-label="This question, in short"><div class="tc-bar-in"><b class="tc-bar-title">${card.title}</b>
${few ? html`<span class="tc-bar-chips">${card.options.map(o => html`<button class="tc-chip" type="submit" form="${form}" formaction="${act(card, base, 'decide')}" name="key" value="${o.key}" title="${o.final === true ? `${o.label} · ${FINAL_TIP}` : o.label}">${o.label}${o.final === true ? finalSign() : ''}</button>`)}</span>` : ''}${jump}
${open && card.kind === 'decision' ? html`<i class="tc-bar-sep"></i>${mini('is-duck', 'trust', 'I don’t give a duck', sk('duck'))}${mini('is-what', 'what', 'What?? Explain this to me', sk('what'))}${mini('is-reverse', 'revise', `Reverse: back to ${asker || 'the agent'} for rework, with the comments`, sk('reverse'))}` : open && card.kind === 'info' ? html`<i class="tc-bar-sep"></i>${mini('is-what', 'what', 'What?? Explain this to me', sk('what'))}${mini('is-reverse', 'revise', `Reverse: back to ${asker || 'the agent'} for rework, with the comments`, sk('reverse'))}${mini('is-ack', 'close', `${WORDS.ack}: read, close it`, sk('tick'))}` : ''}
${open && card.kind !== 'permission' && !card.snoozed_until ? html`<form class="tc-bar-later" method="post" action="${base}/cards/batch"><input type="hidden" name="ids" value="${card.id}"><input type="hidden" name="from" value="${card.id}">${keep}${session ? html`<input type="hidden" name="back" value="${home}">` : ''}${sideWays({ duck: false, shred: false, word: false })}</form>` : ''}
</div></div>`
  const tone = model.byAgent.get(card.agent)?.hue
  // The tray: card, field and talk lie on one pad in the session's tone, one step deeper,
  // with a pen outline and hatched corners; the card is white with an ink outline and a drop shadow, an object on it;
  // the talk in time order, the field to write in at its foot (sticky at the window's foot while the talk is long).
  const pad = html`<div class="tc-pad"${tone != null ? html` style="--hue:${tone}"` : ''}>${corner('tl')}${corner('tr')}${corner('bl')}${corner('br')}${strip}`
  const notesOpen = raw('<div class="tc-notes">')
  const more = (cls, drawing, word, tip, action) => html`<button class="tc-more-item ${cls}" type="submit" form="${form}" formaction="${action}" title="${tip}">${sk(drawing)}<span>${word}</span></button>`
  return html`<main id="cardpage" class="tc-page${large ? ' is-full' : focus ? ' is-focus' : ''}" aria-label="Question ${card.number}" data-id="${card.id}"${focus ? raw(' data-focus') : ''} data-controller="card" data-card-draft-value="${drafting ? act(card, base, 'draft') : ''}" data-card-pictures-value="${JSON.stringify(picturesOf(old ? { ...card, attachments: old.attachments ?? card.attachments } : card, self))}" data-action="turbo:frame-load->card#framed circles:drawn->card#link turbo:submit-start->card#sent turbo:submit-end->card#done dragover->card#over drop->card#drop">
${pad}<div class="tc-frame">
<nav class="tc-rails" aria-label="Around this question">
<a class="tc-rail tc-back" data-nav href="${home}" aria-keyshortcuts="Escape" title="Back to ${session ? session.name : WORDS.desk} · Esc" aria-label="Back to ${session ? session.name : WORDS.desk}">${CROSS}</a>
${place ? html`${step(place.prev, 'is-prev', 'The question before', BACK)}${step(place.next, 'is-next', 'The next question', FORTH)}` : ''}
${large ? html`<a class="tc-rail tc-full is-leave" data-nav href="${cardPath(card, self)}?pic=${shownPic}${focus ? '&focus=1' : ''}" data-card-target="gallery" data-back data-turbo-action="replace" title="Back to the card · Esc" aria-label="Back to the card">${CROSS}</a>`
    : html`<a class="tc-rail tc-full${focus ? ' is-leave' : ''}" data-nav href="${focusAt(`${cardPath(card, self)}?${shownPic > 1 ? `pic=${shownPic}` : ''}${query}`, !focus)}" data-turbo-action="replace" data-action="card#focus" role="button" aria-pressed="${String(focus)}" title="${FOCUS_WORDS[focus]}" aria-label="${FOCUS_WORDS[focus]}">${FULL}${LESS}</a>`}
${drafting || (open && card.kind === 'info') ? html`<button type="button" class="tc-rail tc-draw" data-action="card#trace" aria-pressed="false" title="Draw on the card: lay a tracing sheet over it" aria-label="Draw on the card">${DRAW}</button>` : ''}
<details class="tc-more" data-controller="pops"><summary class="tc-rail tc-more-open" title="More" aria-label="More for this question">${DOTS}</summary><div class="tc-more-list" role="menu">
${open && card.kind !== 'permission' && card.snoozed_until ? more('', 'wake', WORDS.wake, `${WORDS.wake}: back on the Desk now`, act(card, base, 'wake')) : ''}
${copyButton(card)}
${open && card.kind !== 'permission' ? more('is-shred', 'bin', WORDS.shred, `${WORDS.shred}: throw it away unanswered`, act(card, base, 'shred')) : ''}
</div></details>
</nav>
<article class="tc-card" id="card-${card.id}" style="--hue:162" data-id="${card.id}" data-kind="${card.kind}" data-urgency="${card.urgency}" aria-labelledby="card-title-${card.id}"${media ? raw(' data-pictures') : ''}${card.status === 'open' && !card.with_agent ? '' : raw(' data-settled')}>
${cardLeft(card, model, self, { version, pic: shownPic, query })}
<div class="tc-right">
${cardAnswer(card, model, base, { error, version, pic: shownPic })}
</div>
</article>
${open && card.kind !== 'permission' && !card.snoozed_until ? html`<form class="tc-later" data-action="pointerdown->card#pullStart click->card#pullClick" method="post" action="${base}/cards/batch" aria-label="Put this question off"><input type="hidden" name="ids" value="${card.id}"><input type="hidden" name="from" value="${card.id}">${keep}${session ? html`<input type="hidden" name="back" value="${home}">` : ''}${sideWays({ duck: false, shred: false, word: false })}</form>` : ''}
</div>
${notesOpen}${cardThread(card, model, self, { more: older })}
<form class="tc-chat" id="${form}" aria-label="Write to the agent" method="post" action="${act(card, base, 'message')}" enctype="multipart/form-data" data-card-target="form">
${walk ? raw('<input type="hidden" name="walk" value="1">') : ''}${keep}${session ? html`<input type="hidden" name="back" value="${home}">` : ''}
${drafting || (open && card.kind === 'info') ? html`<input type="hidden" name="marks" value="${JSON.stringify(card.draft?.marks ?? [])}" data-card-target="marks">` : ''}
<span class="tc-c-who is-you" aria-hidden="true">${sk('pen')}</span>
<div class="tc-ask"><div class="tc-chips" data-card-target="chips" hidden></div>
<textarea class="tc-field" id="card-field-${card.id}" data-card-target="field" data-action="input->card#typed keydown->card#keys paste->card#paste" name="note" rows="1" placeholder="${askWords(card, model, asker)}" autocomplete="off" enterkeyhint="send" aria-label="Write to the agent about this question. Send adds it to the talk; an answer takes it along as a note.">${card.draft?.note ?? ''}</textarea>
<div class="tc-ask-row"><label class="tc-clip" title="Attach files or pictures (or paste, or drop them on the card)">${sk('clip')}<span class="tc-sr">Attach files</span><input type="file" name="files" multiple hidden data-card-target="files" data-action="change->card#files"></label>${drafting || (open && card.kind === 'info') ? html`<button type="button" class="tc-draw tc-draw-pen" data-action="card#trace" aria-pressed="false" title="Draw on the card: lay a tracing sheet over it" aria-label="Draw on the card">${sk('pen')}</button>` : ''}<span class="tc-saved" role="status" data-card-target="saved" hidden></span>${sendButton(open && (card.kind === 'decision' || card.kind === 'info'), asker)}</div></div>
</form>
</div>
</div>
</main>`
}

// ---- focus marks ----
// Writing and drawing on a question card. A pencil in a paragraph's margin begins a note that stays with that
// paragraph (or option); the tracing sheet (traceSheet below) is laid over the whole card to draw on. Both are "marks":
//   { id, anchor: { kind: 'text' | 'option', key?, quote? }, text }                          a written note
//   { id: 'pen-card' | 'pen-pic-<n>', anchor: { kind: 'card' } | { kind: 'picture', index },
//     strokes: [{ tool: 'pen' | 'hl', color, pts: [x0, y0, …] }], words: [{ x, y, text, color }], text?, scroll? }
//                                                                                             a tracing sheet
// A note on a piece of the text carries how that piece begins (quote), to find it again after a rewording; a
// paragraph that is an option counts as that option. A sheet's points are fractions of the card's WIDTH (y too), so
// a drawing scales with the card; its words are its text too (what the agent reads), and scroll is where the question
// column stood while drawing (put back when the sheet is laid on again). One sheet over the card, one per picture in
// Full screen. They go with whatever is sent from the card, the sheet as a picture beside them (controller "card").
//
//   const marks = cardMarks({ scroll, blocks(), labelOf(key), onChange() })
//   marks.get() / set(list)   the marks, plain data (for the card's draft)
//   marks.sheet(id, anchor, make) / touch(id)   a tracing sheet's mark; it changed

const NS = 'http://www.w3.org/2000/svg'
const newId = () => Math.random().toString(36).slice(2, 10)

function cardMarks({ scroll, blocks, labelOf, onChange }) {
  let list = []
  let pen = false

  // (While the tracing sheet lies on the card, no pencil is offered in the margin.)
  function setPen(on) { pen = on; quill.hidden = true }

  // ── written notes ──
  const anchorOf = target => {
    const all = blocks()
    const block = all.find(b => b.contains(target))
    if (!block) return null
    if (block.dataset.key) return { kind: 'option', key: block.dataset.key }
    return { kind: 'text', quote: block.textContent.trim().replace(/\s+/g, ' ').slice(0, 48) }
  }
  /** Where a note of that anchor stands: after its block, under its option, or at the end of the text. */
  function placeOf(anchor) {
    if (anchor.kind === 'text') return blocks().find(b => !b.classList.contains('focus-mark') && b.textContent.trim().replace(/\s+/g, ' ').startsWith(anchor.quote ?? '\u0000')) ?? null
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
      const home = place ?? scroll.querySelector('.focus-lead')
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
    if (pen || !block || block.dataset.key) { if (!quill.matches(':hover')) quill.hidden = true; return }
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
    paintNotes()
    onChange()
  }

  return {
    setPen,
    get: () => list.map(m => ({ ...m, ...(m.strokes ? { strokes: m.strokes.map(s => ({ ...s, pts: [...s.pts] })) } : {}), ...(m.words ? { words: m.words.map(w => ({ ...w })) } : {}) })),
    set(next) {
      list = (Array.isArray(next) ? next : []).filter(m => m && m.id && m.anchor && (String(m.id).startsWith('pen-') ? m.strokes || m.words : m.text != null && m.anchor.kind !== 'card')).map(m => ({ id: m.id, anchor: m.anchor, ...(m.text != null ? { text: String(m.text) } : {}), ...(m.strokes ? { strokes: m.strokes } : {}), ...(m.words ? { words: m.words } : {}), ...(m.scroll ? { scroll: m.scroll } : {}) }))
      paintNotes()
    },
    /** The drawing of one tracing sheet (id 'pen-card' or 'pen-pic-<n>'): its mark, made when asked to. */
    sheet(id, anchor, make) { let m = list.find(x => x.id === id); if (!m && make) { m = { id, anchor, strokes: [], words: [] }; list.push(m) } return m ?? null },
    /** The sheet's drawing changed: an empty one is dropped, its words are the mark's text (what the agent reads). */
    touch(id) {
      const m = list.find(x => x.id === id)
      if (m) { m.strokes ??= []; m.words ??= []; const said = m.words.map(w => w.text.trim()).filter(Boolean).join(' · '); if (said) m.text = said; else delete m.text }
      list = list.filter(x => !String(x.id).startsWith('pen-') || x.strokes?.length || x.words?.length)
      onChange()
    },
  }
}

// ---- the tracing sheet ----
// The pen above the card (and the one in the field's row) lays a sheet of tracing paper, taped at the top, over the
// WHOLE card: the question, its picture and the answers show through; mouse, pen and finger draw on it. The Scribble
// Board's tools stand at the foot: pen, highlighter, colours, eraser, text, undo and redo, and "Send with the card".
// Esc or the cross takes the sheet off; the drawing stays on the card (its draft) until it is sent or cleared.
//
//   const sheet = traceSheet({ card, marks, id, anchor, left, onSend, onClose })   card: the .tc-card element
//   sheet.close()                       take it off (as Esc)
const PEN_INKS = [['ink', 'Ink'], ['#d9480f', 'Rust'], ['#0b7a5c', 'Green'], ['#1971c2', 'Blue']]
const HL_INK = '#ffd43b'
const TOOL_PATHS = {
  pen: ['M4 20l1.2-4.4L16.6 4.2a2 2 0 012.9 0l.3.3a2 2 0 010 2.9L8.4 18.8z', 'M14.5 6.5l3 3'],
  hl: ['M14.5 4l5.5 5.5-8 8H7.5v-4.5z', 'M11.5 7l5.5 5.5', 'M4 21h10'],
  eraser: ['M20 20H9.5l-5-5a2 2 0 010-2.8l8-8a2 2 0 012.8 0l4.9 4.9a2 2 0 010 2.8L12 20', 'M8.7 8.3l7 7'],
  text: ['M5.5 7V5h13v2', 'M12 5v14', 'M9.5 19h5'],
  undo: ['M9 14L4 9l5-5', 'M4 9h10.5a5.5 5.5 0 010 11H11'],
  redo: ['M15 14l5-5-5-5', 'M20 9H9.5a5.5 5.5 0 000 11H13'],
  trash: ['M4 7h16', 'M10 11v6', 'M14 11v6', 'M6 7l1 12a2 2 0 002 2h6a2 2 0 002-2l1-12', 'M9 7V4h6v3'],
  send: ['M12 19V5', 'M5.5 11.5L12 5l6.5 6.5'],
  close: ['M6 6l12 12', 'M18 6L6 18'],
}
const toolIcon = name => { const svg = document.createElementNS(NS, 'svg'); svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('class', 'tc-trace-icon'); svg.setAttribute('aria-hidden', 'true'); for (const d of TOOL_PATHS[name]) { const p = document.createElementNS(NS, 'path'); p.setAttribute('d', d); svg.append(p) } return svg }
const isDark = () => document.documentElement.dataset.theme === 'dark'
const DARK_INKS = { ink: '#e9eeea', '#d9480f': '#ff8a4c', '#0b7a5c': '#45d1a3', '#1971c2': '#6cb2ff' }
const inkOf = color => (isDark() ? DARK_INKS[color] ?? color : color === 'ink' ? '#1b1f23' : color)
const SHEET_TOOL = 'trommi-trace-tool'
/** A sheet's stroke as a pen draws it: a smooth line through its points (each point the control of a quadratic curve
 *  between the midpoints beside it), never straight pieces from point to point. pts: [x0, y0, …] as parts of the
 *  sheet's width w. Returns the steps [['M', x, y], ['Q', cx, cy, x, y], ['L', x, y]]: an SVG path's and a canvas's. */
function strokeSteps(pts, w) {
  const n = pts.length >> 1, X = i => pts[2 * i] * w, Y = i => pts[2 * i + 1] * w
  if (!n) return []
  const out = [['M', X(0), Y(0)]]
  if (n === 1) return [...out, ['L', X(0) + 0.1, Y(0)]]
  for (let i = 1; i < n - 1; i++) out.push(['Q', X(i), Y(i), (X(i) + X(i + 1)) / 2, (Y(i) + Y(i + 1)) / 2])
  out.push(['L', X(n - 1), Y(n - 1)])
  return out
}
const strokePath = (pts, w) => strokeSteps(pts, w).map(([k, ...v]) => k + v.map(x => x.toFixed(1)).join(' ')).join('')
/** Every sample of a pointer move: the browser hands one event per frame, the samples between are in it. Taking
 *  only the event itself leaves a quick stroke with one point per frame: long straight pieces with corners. */
const samplesOf = e => { const list = e.getCoalescedEvents?.() ?? []; return list.length ? list : [e] }

function traceSheet({ card, marks, id, anchor, left, dock, onSend, onClose }) {
  let mark = marks.sheet(id, anchor, false)
  let { tool, color } = (() => { try { return { tool: 'pen', color: 'ink', ...JSON.parse(localStorage.getItem(SHEET_TOOL) || '{}') } } catch { return { tool: 'pen', color: 'ink' } } })()
  if (!['pen', 'hl', 'eraser', 'text'].includes(tool)) tool = 'pen'
  const past = [], next = []
  const snap = () => JSON.stringify({ strokes: mark?.strokes ?? [], words: mark?.words ?? [] })
  // (the question column stands where it stood when this was drawn)
  if (left && mark?.scroll != null) left.scrollTop = mark.scroll

  const sheet = el('div', 'tc-trace')
  sheet.setAttribute('role', 'application')
  sheet.setAttribute('aria-label', 'Tracing sheet over the card: draw with mouse, pen or finger. Esc takes it off.')
  const tape = el('span', 'tc-trace-tape')
  const ink = document.createElementNS(NS, 'svg')
  ink.setAttribute('class', 'tc-trace-ink')
  const words = el('div', 'tc-trace-words')
  sheet.append(ink, words, tape)
  card.append(sheet)
  card.closest('.tc-page')?.classList.add('is-tracing')

  const width = () => sheet.clientWidth || 1
  const pathOf = pts => strokePath(pts, width())
  function paint() {
    ink.replaceChildren(...(mark?.strokes ?? []).map((s, at) => { const p = document.createElementNS(NS, 'path'); p.setAttribute('d', pathOf(s.pts)); p.setAttribute('class', `is-${s.tool ?? 'pen'}`); p.style.stroke = s.tool === 'hl' ? s.color : inkOf(s.color); p.dataset.at = at; return p }))
    words.replaceChildren(...(mark?.words ?? []).map((w, at) => { const t = el('span', 'tc-trace-word', w.text); t.style.left = `${w.x * width()}px`; t.style.top = `${w.y * width()}px`; t.style.color = inkOf(w.color); t.dataset.at = at; return t }))
    paintTools()
  }
  new ResizeObserver(() => paint()).observe(sheet)
  const point = e => { const box = sheet.getBoundingClientRect(); return [Number(((e.clientX - box.left) / width()).toFixed(4)), Number(((e.clientY - box.top) / width()).toFixed(4))] }
  const own = () => (mark ??= marks.sheet(id, anchor, true))
  function changed(before) {
    if (before != null && before !== snap()) { past.push(before); next.length = 0 }
    if (mark) { if (left && !mark.scroll && left.scrollTop) mark.scroll = Math.round(left.scrollTop); marks.touch(id); if (!marks.sheet(id)) mark = null }
    paint()
  }

  // ── drawing: one pointer draws; a second finger stops the line and moves the page instead ──
  let drawing = null, fingers = new Map(), inking = 0
  sheet.addEventListener('pointerdown', e => {
    if (e.button || e.target.closest('.tc-trace-type')) return
    fingers.set(e.pointerId, [e.clientX, e.clientY])
    if (fingers.size > 1) { if (drawing) { mark.strokes.pop(); drawing = null; paint() } return }
    e.preventDefault()
    sheet.setPointerCapture(e.pointerId)
    if (tool === 'eraser') return rub(e)
    if (tool === 'text') return type(point(e))
    const before = snap()
    drawing = { before, stroke: { tool, color: tool === 'hl' ? HL_INK : color, pts: point(e) } }
    own().strokes.push(drawing.stroke)
    paint()
  })
  sheet.addEventListener('pointermove', e => {
    const was = fingers.get(e.pointerId)
    if (was && fingers.size > 1) { window.scrollBy(was[0] - e.clientX, was[1] - e.clientY); if (left) left.scrollTop += 0; fingers.set(e.pointerId, [e.clientX, e.clientY]); return }
    if (tool === 'eraser' && e.buttons & 1) return rub(e)
    if (!drawing) return
    const pts = drawing.stroke.pts, n = pts.length
    for (const sample of samplesOf(e)) {
      const [x, y] = point(sample)
      if (Math.hypot(x - pts.at(-2), y - pts.at(-1)) * width() >= 1.5) pts.push(x, y)
    }
    // (the line is laid once per frame, however many samples came)
    if (pts.length !== n) inking ||= requestAnimationFrame(() => { inking = 0; if (drawing) ink.lastElementChild?.setAttribute('d', pathOf(drawing.stroke.pts)) })
  })
  const lift = e => { fingers.delete(e.pointerId); if (!drawing) return; const { before } = drawing; drawing = null; cancelAnimationFrame(inking); inking = 0; changed(before) }
  sheet.addEventListener('pointerup', lift)
  sheet.addEventListener('pointercancel', lift)
  sheet.addEventListener('wheel', e => e.preventDefault(), { passive: false })   // (the card stays still under the sheet)
  function rub(e) {
    for (const hit of document.elementsFromPoint(e.clientX, e.clientY)) {
      if (!sheet.contains(hit)) continue
      const before = snap()
      if (hit instanceof SVGPathElement) { mark.strokes.splice(Number(hit.dataset.at), 1); return changed(before) }
      if (hit.classList.contains('tc-trace-word')) { mark.words.splice(Number(hit.dataset.at), 1); return changed(before) }
    }
  }
  // ── text: a click puts a field there; Enter or leaving it puts the words on the sheet ──
  function type([x, y], at = null) {
    sheet.querySelector('.tc-trace-type')?.blur()
    const field = el('textarea', 'tc-trace-type')
    field.rows = 1
    field.placeholder = 'Write'
    field.setAttribute('aria-label', 'Words on the sheet')
    field.style.left = `${x * width()}px`
    field.style.top = `${y * width()}px`
    field.style.color = inkOf(color)
    if (at != null) field.value = mark.words[at].text
    sheet.append(field)
    requestAnimationFrame(() => field.focus())
    let done = false
    const put = () => {
      if (done) return; done = true
      const before = snap(), text = field.value.trim()
      field.remove()
      if (at != null) { if (text) mark.words[at].text = text; else mark.words.splice(at, 1) }
      else if (text) own().words.push({ x, y, text, color })
      changed(before)
    }
    field.addEventListener('keydown', e => { e.stopPropagation(); if (e.key === 'Escape' || (e.key === 'Enter' && !e.shiftKey && !e.isComposing)) { e.preventDefault(); field.blur() } })
    field.addEventListener('blur', put)
  }
  words.addEventListener('pointerdown', e => {
    const w = e.target.closest('.tc-trace-word')
    if (!w || tool !== 'text') return
    e.stopPropagation(); e.preventDefault()
    const at = Number(w.dataset.at); type([mark.words[at].x, mark.words[at].y], at)
  })

  // ── the tools ──
  // With the card's field in view (dock: its box, .tc-ask) the tools are the field's own top row: one bar, the words
  // that go with the drawing typed under the tools, and the field's Send sends both. Where there is no field (a
  // picture in Full screen, a card that takes no words) the tools float at the foot with a Send of their own.
  const bar = el('div', 'tc-trace-tools')
  bar.setAttribute('role', 'toolbar')
  bar.setAttribute('aria-label', 'Drawing tools')
  const button = (cls, label, name, act) => { const b = el('button', `tc-trace-btn ${cls}`); b.type = 'button'; b.title = label; b.setAttribute('aria-label', label); if (name) b.append(toolIcon(name)); b.addEventListener('click', act); return b }
  const pick = t => { tool = t; sheet.querySelector('.tc-trace-type')?.blur(); remember(); paintTools() }
  const remember = () => { try { localStorage.setItem(SHEET_TOOL, JSON.stringify({ tool, color })) } catch {} }
  const tools = { pen: button('is-tool', 'Pen · P', 'pen', () => pick('pen')), hl: button('is-tool', 'Highlighter · H', 'hl', () => pick('hl')) }
  const swatches = PEN_INKS.map(([c, name]) => { const b = button('is-swatch', name, null, () => { color = c; if (tool !== 'text') tool = 'pen'; remember(); paintTools() }); b.dataset.color = c; b.append(el('span', 'tc-trace-dot')); return b })
  tools.eraser = button('is-tool', 'Eraser · E', 'eraser', () => pick('eraser'))
  tools.text = button('is-tool', 'Text · T', 'text', () => pick('text'))
  const undo = button('', 'Undo · Ctrl+Z', 'undo', () => step(past, next))
  const redo = button('', 'Redo · Ctrl+Shift+Z', 'redo', () => step(next, past))
  const clear = button('is-clear', 'Clear the sheet', 'trash', () => { if (!mark) return; const before = snap(); mark.strokes = []; mark.words = []; changed(before) })
  const send = el('button', 'tc-trace-send')
  send.type = 'button'
  send.title = 'Send the drawing with the card, and what is written in the field'
  send.append(toolIcon('send'), el('span', '', 'Send with the card'))
  send.addEventListener('click', () => { close(); onSend() })
  const off = button('is-off', 'Take the sheet off · Esc (the drawing stays)', 'close', () => close())
  const group = (...nodes) => { const g = el('span', 'tc-trace-group'); g.append(...nodes); return g }
  bar.append(group(tools.pen, tools.hl, ...swatches), group(tools.eraser, tools.text), group(undo, redo), group(clear))
  const page = card.closest('.tc-page')
  // (the field's own Send says what it sends while the sheet lies there)
  const fieldSend = dock?.querySelector('.tc-send'), sendWas = fieldSend && [fieldSend.title, fieldSend.getAttribute('aria-label')]
  if (dock) {
    bar.classList.add('is-docked')
    bar.append(off)
    dock.prepend(bar)
    page?.classList.add('is-docked')
    if (fieldSend) { fieldSend.title = 'Send with the card: the drawing and what is written (Enter)'; fieldSend.setAttribute('aria-label', 'Send with the card') }
  } else { bar.append(send, off); document.body.append(bar) }
  function step(from, to) {
    if (!from.length) return
    to.push(snap())
    const { strokes, words: w } = JSON.parse(from.pop())
    own().strokes = strokes; mark.words = w
    changed(null)
  }
  function paintTools() {
    for (const [name, b] of Object.entries(tools)) b.setAttribute('aria-pressed', String(tool === name))
    for (const b of swatches) { b.setAttribute('aria-pressed', String(b.dataset.color === color && tool !== 'hl' && tool !== 'eraser')); b.style.setProperty('--c', inkOf(b.dataset.color)) }
    undo.disabled = !past.length
    redo.disabled = !next.length
    clear.disabled = send.disabled = !(mark?.strokes?.length || mark?.words?.length)
    bar.dataset.tool = tool
    sheet.dataset.tool = tool
  }
  // ── keys while the sheet lies there: Esc takes it off, the tools by their letters, undo and redo ──
  const keys = e => {
    if (e.key !== 'Escape' && isTyping(e)) return
    const k = e.key.toLowerCase(), mod = e.ctrlKey || e.metaKey
    if (!mod && k.length === 1 && !letterKeysOn(e)) return
    if (e.key === 'Escape') close()
    else if (mod && k === 'z') step(e.shiftKey ? next : past, e.shiftKey ? past : next)
    else if (mod && k === 'y') step(next, past)
    else if (!mod && !e.altKey && { p: 'pen', h: 'hl', e: 'eraser', t: 'text' }[k]) pick({ p: 'pen', h: 'hl', e: 'eraser', t: 'text' }[k])
    else return
    e.preventDefault(); e.stopImmediatePropagation()
  }
  addEventListener('keydown', keys, true)
  let open = true
  function close() {
    if (!open) return; open = false
    sheet.querySelector('.tc-trace-type')?.blur()
    removeEventListener('keydown', keys, true)
    sheet.remove(); bar.remove()
    page?.classList.remove('is-tracing', 'is-docked')
    if (fieldSend) { fieldSend.title = sendWas[0]; fieldSend.setAttribute('aria-label', sendWas[1]) }
    onClose()
  }
  paint()
  if (!dock) requestAnimationFrame(() => (tools[tool] ?? tools.pen).focus({ preventScroll: true }))
  return { close, get open() { return open } }
}

/** The app's fonts for a picture of the page: fonts.css and fallback.css with every font file written into them as
 *  data (a picture made from markup can fetch nothing, so without this it is set in the system's fallback font, wider,
 *  and its lines break and run into each other). Made once. */
let fontStyles = null
const pageFonts = () => (fontStyles ??= (async () => {
  const dataOf = async url => { const blob = await (await fetch(url)).blob(); return new Promise((resolve, reject) => { const r = new FileReader(); r.onload = () => resolve(r.result); r.onerror = reject; r.readAsDataURL(blob) }) }
  let css = (await Promise.all(['/fonts/fallback.css', '/fonts/fonts.css'].map(async u => (await fetch(u)).text()))).join('\n').replace(/\/\*[\s\S]*?\*\//g, '')
  const files = [...new Set([...css.matchAll(/url\(([^)]+)\)/g)].map(m => m[1]))]
  const data = await Promise.all(files.map(f => dataOf(f.replace(/['"]/g, ''))))
  files.forEach((f, i) => { css = css.replaceAll(`url(${f})`, `url(${data[i]})`) })
  return css
})().catch(err => { fontStyles = null; throw err }))
/** A picture that stands in the page, as data: read from the element itself (its address may be one only the page
 *  can open: an attachment decrypted here). null when it has not loaded or cannot be read. */
function pictureData(img) {
  if (!img.complete || !img.naturalWidth) return null
  try {
    const k = Math.min(1, 2000 / Math.max(img.naturalWidth, img.naturalHeight))
    const cv = document.createElement('canvas')
    cv.width = Math.max(1, Math.round(img.naturalWidth * k)); cv.height = Math.max(1, Math.round(img.naturalHeight * k))
    cv.getContext('2d').drawImage(img, 0, 0, cv.width, cv.height)
    return cv.toDataURL('image/png')
  } catch { return null }
}
/** The card painted from the page as it stands, without markup inside a picture (cardPicture's second way, for a
 *  browser that will not hand out a canvas an SVG <foreignObject> was painted on, or paints nothing of it): every
 *  element's box is measured where it lies and painted in document order: outer shadows, ground, borders, inner
 *  shadows, then what it holds: a picture from its <img> (object-fit kept), a video's frame, a drawing (<svg>, as a
 *  picture of its own with its looks written in; no foreignObject), a field's words, and text word by word where the
 *  page laid each word (Range.getClientRects), in the page's own fonts. What is cut off or scrolled away stays cut
 *  (overflow), opacity is kept. Not painted: gradients and pictures as grounds, ::before and ::after, rotation and
 *  other transforms (a turned box is painted upright), z-index (the order is the document's), text shadows.
 *  The drawings are loaded first, then everything is painted in one go (no waiting while the canvas holds a clip).
 *  c is scaled so that one unit is one CSS pixel of the card, its upper left corner at 0 0. */
async function paintCard(c, card, { pictures = true } = {}) {
  const origin = card.getBoundingClientRect(), px = c.getTransform().a
  const num = v => parseFloat(v) || 0
  const clear = color => !color || color === 'transparent' || /^rgba\(.*,\s*0\)$|\/\s*0\)$/.test(color)
  const boxOf = (r, d = 0) => ({ x: r.left - origin.left + d, y: r.top - origin.top + d, w: Math.max(0, r.width - 2 * d), h: Math.max(0, r.height - 2 * d) })
  const radiiOf = (s, r) => ['TopLeft', 'TopRight', 'BottomRight', 'BottomLeft'].map(k => { const [x, y = x] = s[`border${k}Radius`].split(' ').map((v, i) => (v.endsWith('%') ? parseFloat(v) / 100 * (i ? r.height : r.width) : num(v))); return { x, y } })
  // (a box's outline, d inside it (negative: outside), moved by dx dy; no beginPath, so two of them make a ring)
  const outline = (b, radii, d = 0, dx = 0, dy = 0) => { if (b.w - 2 * d > 0 && b.h - 2 * d > 0) c.roundRect(b.x + d + dx, b.y + d + dy, b.w - 2 * d, b.h - 2 * d, radii.map(q => ({ x: Math.max(0, q.x - d), y: Math.max(0, q.y - d) }))) }
  const shadowsOf = s => (s.boxShadow === 'none' ? [] : s.boxShadow.split(/,(?![^(]*\))/).map(one => { const m = one.trim().match(/^(.*?\)|\S+)\s+(-?[\d.]+)px\s+(-?[\d.]+)px\s+([\d.]+)px\s+(-?[\d.]+)px(\s+inset)?$/); return m ? { color: m[1], x: num(m[2]), y: num(m[3]), blur: num(m[4]), spread: num(m[5]), inset: Boolean(m[6]) } : null }).filter(Boolean).reverse())
  const fontOf = s => `${s.fontStyle} ${s.fontWeight} ${s.fontSize} ${s.fontFamily}`
  const drawings = new Map()
  const LOOKS = ['fill', 'stroke', 'stroke-width', 'stroke-linecap', 'stroke-linejoin', 'stroke-dasharray', 'stroke-dashoffset', 'stroke-miterlimit', 'opacity', 'fill-opacity', 'stroke-opacity', 'fill-rule', 'clip-rule', 'color', 'display', 'visibility', 'transform', 'transform-origin', 'transform-box', 'font-family', 'font-size', 'font-weight', 'font-style', 'text-anchor', 'paint-order']
  const drawingOf = svg => {
    if (svg.querySelector('foreignObject, image, use')) return null
    const copy = svg.cloneNode(true), from = [svg, ...svg.querySelectorAll('*')], to = [copy, ...copy.querySelectorAll('*')], r = svg.getBoundingClientRect()
    from.forEach((a, i) => { const s = getComputedStyle(a); to[i].setAttribute('style', LOOKS.filter(p => i || !p.startsWith('transform')).map(p => `${p}:${s.getPropertyValue(p)}`).join(';')); to[i].removeAttribute('class') })
    copy.setAttribute('xmlns', NS); copy.setAttribute('width', r.width); copy.setAttribute('height', r.height)
    if (!copy.hasAttribute('viewBox')) copy.setAttribute('viewBox', `0 0 ${r.width} ${r.height}`)
    copy.style.display = 'block'; copy.style.overflow = getComputedStyle(svg).overflow
    const text = new XMLSerializer().serializeToString(copy)
    if (!drawings.has(text)) drawings.set(text, new Promise(resolve => { const image = new Image(); image.onload = () => resolve(image); image.onerror = () => resolve(null); image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(text)}` }))
    return drawings.get(text)
  }
  // (what an element holds in place of children, in its content box: fitted as object-fit says)
  const fitted = (source, sw, sh, b, s) => {
    if (!(sw > 0 && sh > 0 && b.w > 0 && b.h > 0)) return
    const fit = s.objectFit, [ox = .5, oy = .5] = s.objectPosition.split(' ').map(v => (v.endsWith('%') ? parseFloat(v) / 100 : null) ?? .5)
    const k = fit === 'contain' ? Math.min(b.w / sw, b.h / sh) : fit === 'cover' ? Math.max(b.w / sw, b.h / sh) : fit === 'none' ? 1 : fit === 'scale-down' ? Math.min(1, b.w / sw, b.h / sh) : null
    const dw = k == null ? b.w : sw * k, dh = k == null ? b.h : sh * k
    c.save(); c.beginPath(); c.rect(b.x, b.y, b.w, b.h); c.clip()
    c.drawImage(source, b.x + (b.w - dw) * ox, b.y + (b.h - dh) * oy, dw, dh)
    c.restore()
  }
  const range = document.createRange()
  const words = (node, s) => {
    const fill = s.webkitTextFillColor && !clear(s.webkitTextFillColor) ? s.webkitTextFillColor : s.color
    if (!node.data.trim() || clear(fill)) return
    c.font = fontOf(s); c.fillStyle = fill; c.textBaseline = 'alphabetic'
    if ('letterSpacing' in c) c.letterSpacing = s.letterSpacing === 'normal' ? '0px' : s.letterSpacing
    const m = c.measureText('Hg'), up = m.fontBoundingBoxAscent ?? m.actualBoundingBoxAscent, down = m.fontBoundingBoxDescent ?? m.actualBoundingBoxDescent
    const shown = s.textTransform === 'uppercase' ? t => t.toUpperCase() : s.textTransform === 'lowercase' ? t => t.toLowerCase() : t => t
    const lines = []   // (for a line under or through the words: one stretch per line of the page)
    const put = (from, to) => {
      range.setStart(node, from); range.setEnd(node, to)
      const rects = [...range.getClientRects()].filter(r => r.width > 0)
      if (!rects.length) return
      // (a word broken over two lines: letter by letter)
      if (rects.length > 1 && to - from > 1 && rects.some(r => Math.abs(r.top - rects[0].top) > 2)) { for (let i = from; i < to; i++) put(i, i + 1); return }
      const r = rects[0], base = r.top - origin.top + (r.height - up - down) / 2 + up
      if (r.bottom < origin.top || r.top > origin.bottom) return
      c.fillText(shown(node.data.slice(from, to)), r.left - origin.left, base)
      const last = lines.at(-1)
      if (last && Math.abs(last.base - base) < 1) last.right = r.right - origin.left; else lines.push({ left: r.left - origin.left, right: r.right - origin.left, base })
    }
    for (const word of node.data.matchAll(/\S+/g)) put(word.index, word.index + word[0].length)
    const line = s.textDecorationLine ?? ''
    if (line === 'none' || !lines.length) return
    const thick = Math.max(1, num(s.fontSize) / 14)
    c.fillStyle = clear(s.textDecorationColor) ? fill : s.textDecorationColor
    for (const l of lines) {
      if (line.includes('underline')) c.fillRect(l.left, l.base + thick * 1.6, l.right - l.left, thick)
      if (line.includes('line-through')) c.fillRect(l.left, l.base - up * .32, l.right - l.left, thick)
    }
  }
  const paint = el => {
    if (el.classList.contains('tc-trace')) return
    const s = getComputedStyle(el)
    if (s.display === 'none' || el.checkVisibility?.({ contentVisibilityAuto: true }) === false) return
    const seen = s.visibility === 'visible', opacity = num(s.opacity)
    if (s.opacity !== '1' && opacity <= 0) return
    c.save()
    if (opacity < 1) c.globalAlpha *= opacity
    const whole = el.getBoundingClientRect()
    const rects = s.display === 'contents' ? [] : s.display === 'inline' ? [...el.getClientRects()] : [whole]
    const svg = el instanceof SVGElement
    if (seen && !svg) for (const r of rects) {
      if (!(r.width > 0 && r.height > 0)) continue
      const b = boxOf(r), radii = radiiOf(s, r), shadows = shadowsOf(s)
      for (const sh of shadows.filter(x => !x.inset && !clear(x.color))) {
        // (an outer shadow lies around the box only, never under it)
        c.save(); c.beginPath(); c.rect(b.x - 400, b.y - 400, b.w + 800, b.h + 800); outline(b, radii); c.clip('evenodd')
        if (sh.blur > 0) { c.shadowColor = sh.color; c.shadowBlur = sh.blur * px; c.shadowOffsetX = (sh.x + 4000) * px; c.shadowOffsetY = sh.y * px; c.fillStyle = '#000'; c.beginPath(); outline(b, radii, -sh.spread, -4000, 0); c.fill() }
        else { c.fillStyle = sh.color; c.beginPath(); outline(b, radii, -sh.spread, sh.x, sh.y); c.fill() }
        c.restore()
      }
      if (!clear(s.backgroundColor)) { c.fillStyle = s.backgroundColor; c.beginPath(); outline(b, radii); c.fill() }
      const sides = ['Top', 'Right', 'Bottom', 'Left'].map(k => ({ w: s[`border${k}Style`] === 'none' || s[`border${k}Style`] === 'hidden' ? 0 : num(s[`border${k}Width`]), color: s[`border${k}Color`], style: s[`border${k}Style`] }))
      if (sides.every(d => d.w > 0 && d.w === sides[0].w && d.color === sides[0].color)) {
        const d = sides[0]
        if (!clear(d.color)) { c.strokeStyle = d.color; c.lineWidth = d.w; c.setLineDash(d.style === 'dashed' ? [d.w * 3, d.w * 2] : d.style === 'dotted' ? [d.w, d.w] : []); c.beginPath(); outline(b, radii, d.w / 2); c.stroke(); c.setLineDash([]) }
      } else sides.forEach((d, i) => { if (d.w > 0 && !clear(d.color)) { c.fillStyle = d.color; c.fillRect(i === 1 ? b.x + b.w - d.w : b.x, i === 2 ? b.y + b.h - d.w : b.y, i % 2 ? d.w : b.w, i % 2 ? b.h : d.w) } })
      for (const sh of shadows.filter(x => x.inset && !clear(x.color))) {
        c.save(); c.beginPath(); outline(b, radii); c.clip()
        c.fillStyle = sh.color; c.beginPath(); c.rect(b.x - 1, b.y - 1, b.w + 2, b.h + 2); outline(b, radii, sh.spread + sh.blur / 2, sh.x, sh.y); c.fill('evenodd')
        c.restore()
      }
    }
    const inner = { x: whole.left - origin.left + num(s.borderLeftWidth) + num(s.paddingLeft), y: whole.top - origin.top + num(s.borderTopWidth) + num(s.paddingTop), w: whole.width - num(s.borderLeftWidth) - num(s.borderRightWidth) - num(s.paddingLeft) - num(s.paddingRight), h: whole.height - num(s.borderTopWidth) - num(s.borderBottomWidth) - num(s.paddingTop) - num(s.paddingBottom) }
    const rounded = fn => { c.save(); c.beginPath(); outline(boxOf(whole), radiiOf(s, whole)); c.clip(); try { fn() } finally { c.restore() } }
    if (!seen) { /* (its children may be seen) */ }
    else if (svg) { const image = made.get(el); if (image && whole.width > 0 && whole.height > 0) c.drawImage(image, whole.left - origin.left, whole.top - origin.top, whole.width, whole.height) }
    else if (el instanceof HTMLImageElement) { if (pictures && el.complete && el.naturalWidth) rounded(() => fitted(el, el.naturalWidth, el.naturalHeight, inner, s)) }
    else if (el instanceof HTMLVideoElement) { if (pictures && el.readyState >= 2) rounded(() => fitted(el, el.videoWidth, el.videoHeight, inner, s)) }
    else if (el instanceof HTMLCanvasElement) { if (pictures && el.width && el.height) fitted(el, el.width, el.height, inner, { objectFit: 'fill', objectPosition: '50% 50%' }) }
    else if (el instanceof HTMLIFrameElement) { c.fillStyle = '#ddd'; c.fillRect(inner.x, inner.y, inner.w, inner.h) }
    else if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
      const text = el.value || el.placeholder || '', size = num(s.fontSize), high = num(s.lineHeight) || size * 1.3
      if (text && !['checkbox', 'radio', 'hidden', 'file', 'range', 'color'].includes(el.type)) {
        c.save(); c.beginPath(); c.rect(inner.x, inner.y, inner.w, inner.h); c.clip()
        c.font = fontOf(s); c.textBaseline = 'middle'; c.fillStyle = s.color
        if (!el.value) c.globalAlpha *= .55
        text.split('\n').forEach((t, i) => c.fillText(t, inner.x, el instanceof HTMLTextAreaElement ? inner.y + high * (i + .5) - el.scrollTop : inner.y + inner.h / 2))
        c.restore()
      }
    }
    if (svg || el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLImageElement || el instanceof HTMLVideoElement || el instanceof HTMLIFrameElement || el instanceof HTMLCanvasElement) { c.restore(); return }
    // (a list's point or number, left of the entry's first line)
    if (seen && s.display === 'list-item' && s.listStyleType !== 'none') {
      range.selectNodeContents(el)
      const first = [...range.getClientRects()].find(r => r.width > 0 && r.height > 0), size = num(s.fontSize)
      if (first) {
        c.fillStyle = s.color
        const x = inner.x - size * .55, y = first.top - origin.top + first.height / 2
        if (/decimal/.test(s.listStyleType)) { const at = (el.parentElement?.start || 1) + [...el.parentElement.children].filter(k => k.tagName === 'LI').indexOf(el); c.font = fontOf(s); c.textBaseline = 'middle'; c.textAlign = 'right'; c.fillText(`${at}.`, inner.x - size * .3, y); c.textAlign = 'left' }
        else { c.beginPath(); c.arc(x, y, size * .17, 0, Math.PI * 2); if (s.listStyleType === 'circle') { c.strokeStyle = s.color; c.lineWidth = 1; c.stroke() } else c.fill() }
      }
    }
    // (what lies beyond a box that cuts its content, or is scrolled away in it, is not painted)
    if (s.display !== 'inline' && s.display !== 'contents' && (s.overflowX !== 'visible' || s.overflowY !== 'visible')) {
      const bl = num(s.borderLeftWidth), bt = num(s.borderTopWidth), far = 1e5, cutX = s.overflowX !== 'visible', cutY = s.overflowY !== 'visible'
      const b = boxOf(whole)
      c.beginPath()
      if (cutX && cutY) outline({ x: b.x + bl, y: b.y + bt, w: el.clientWidth || b.w, h: el.clientHeight || b.h }, radiiOf(s, whole).map(q => ({ x: Math.max(0, q.x - bl), y: Math.max(0, q.y - bt) })))
      else c.rect(cutX ? b.x + bl : -far, cutY ? b.y + bt : -far, cutX ? el.clientWidth || b.w : 2 * far, cutY ? el.clientHeight || b.h : 2 * far)
      c.clip()
    }
    for (const kid of el.childNodes) {
      if (kid.nodeType === 3) { if (seen) words(kid, s) }
      else if (kid.nodeType === 1) paint(kid)
    }
    c.restore()
  }
  // (the drawings are made into pictures first: the card is then painted in one go, as it stands at that moment)
  const made = new Map()
  await Promise.all([...card.querySelectorAll('svg')].filter(svg => !svg.closest('.tc-trace') && !svg.parentElement.closest('svg')).map(async svg => made.set(svg, await drawingOf(svg))))
  paint(card)
}
/** The card as the human sees it, with a sheet's drawing on it: what the card shows is copied with its looks written
 *  into every element, the app's fonts and its pictures taken in as data, laid into an SVG and painted on a canvas at
 *  twice the size; the drawing is painted over it. A picture that cannot be taken in leaves its place empty. Where a
 *  browser will not hand such a canvas out, cannot load that SVG, or paints nothing of it (Safari), the card is
 *  painted box by box and word by word from the page instead (paintCard); only if that fails too do the drawing and
 *  its words go on plain paper. The canvas is never larger than a phone's browser makes one (16 million pixels).
 *  Promise<Blob | null>. */
async function cardPicture(card, mark) {
  const w = Math.round(card.clientWidth), h = Math.min(Math.round(card.clientHeight), 6000), scale = Math.min(2, Math.sqrt(16e6 / Math.max(1, w * h)))
  let canvas, c
  const paper = () => { canvas = document.createElement('canvas'); canvas.width = w * scale; canvas.height = h * scale; c = canvas.getContext('2d'); c.fillStyle = '#fff'; c.fillRect(0, 0, canvas.width, canvas.height) }
  paper()
  const blob = () => new Promise(resolve => { try { canvas.toBlob(resolve, 'image/png') } catch { resolve(null) } })
  const drawing = () => {
    c.save(); c.scale(scale, scale); c.lineCap = c.lineJoin = 'round'
    for (const s of mark.strokes ?? []) {
      c.globalAlpha = s.tool === 'hl' ? .38 : 1
      c.lineWidth = s.tool === 'hl' ? 16 : 2.8
      c.strokeStyle = s.tool === 'hl' ? s.color : inkOf(s.color)
      c.beginPath()
      for (const [k, ...v] of strokeSteps(s.pts, w)) { if (k === 'M') c.moveTo(...v); else if (k === 'Q') c.quadraticCurveTo(...v); else c.lineTo(...v) }
      c.stroke()
    }
    c.globalAlpha = 1
    c.font = `600 17px ${getComputedStyle(card).fontFamily || 'system-ui, sans-serif'}`
    c.textBaseline = 'top'
    for (const word of mark.words ?? []) { c.fillStyle = inkOf(word.color); word.text.split('\n').forEach((line, i) => c.fillText(line, word.x * w + 2, word.y * w + 2 + i * 22)) }
    c.restore()
  }
  try {
    const [fonts] = await Promise.all([pageFonts(), document.fonts?.ready])
    const copy = card.cloneNode(true)
    copy.querySelector('.tc-trace')?.remove()
    const from = [card, ...card.querySelectorAll('*')].filter(n => !n.closest('.tc-trace')), to = [copy, ...copy.querySelectorAll('*')]
    for (let i = 0; i < from.length; i++) {
      const a = from[i], b = to[i]
      if (!(b instanceof HTMLElement || b instanceof SVGElement)) continue
      const style = getComputedStyle(a)
      let css = ''
      for (const prop of style) css += `${prop}:${style.getPropertyValue(prop)};`
      b.setAttribute('style', css)
      if (b instanceof HTMLTextAreaElement) b.textContent = a.value
      if (b instanceof HTMLIFrameElement || b instanceof HTMLVideoElement) { const box = el('div'); box.setAttribute('style', `${css}background:#ddd;`); b.replaceWith(box) }
      if (b instanceof HTMLImageElement) {
        const data = pictureData(a)
        b.removeAttribute('srcset'); b.removeAttribute('loading')
        if (data) b.src = data; else { b.removeAttribute('src'); b.alt = ''; b.style.visibility = 'hidden' }
      }
      // (what was scrolled inside the card is shown as it stood)
      if (a.scrollTop && b instanceof HTMLElement) for (const kid of b.children) kid.style.translate = `0 ${-a.scrollTop}px`
    }
    Object.assign(copy.style, { position: 'static', margin: '0', width: `${w}px`, height: `${h}px`, translate: 'none', transform: 'none', animation: 'none' })
    copy.setAttribute('xmlns', 'http://www.w3.org/1999/xhtml')
    const svg = `<svg xmlns="${NS}" width="${w}" height="${h}"><foreignObject width="100%" height="100%"><style xmlns="http://www.w3.org/1999/xhtml">${fonts.replace(/[<&]/g, ch => (ch === '<' ? '&lt;' : '&amp;'))}</style>${new XMLSerializer().serializeToString(copy)}</foreignObject></svg>`
    const url = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`
    const load = () => new Promise((resolve, reject) => { const image = new Image(); image.onload = () => resolve(image); image.onerror = reject; image.src = url })
    // (the picture's own fonts are read while it is painted the first time: the second painting has them)
    c.drawImage(await load(), 0, 0, canvas.width, canvas.height)
    await new Promise(r => setTimeout(r, 120))
    paper()
    c.drawImage(await load(), 0, 0, canvas.width, canvas.height)
    // (throws where the canvas is tainted; and a canvas that is still nothing but paper was not painted)
    const small = document.createElement('canvas'); small.width = small.height = 32
    const seen = small.getContext('2d'); seen.drawImage(canvas, 0, 0, 32, 32)
    if (seen.getImageData(0, 0, 32, 32).data.every(v => v === 255)) throw new Error('nothing was painted')
  } catch (err) {
    console.warn('card picture: painted from the page instead', err)
    // (with its pictures; without them if one of them taints the canvas; plain paper if that fails too)
    const painted = async pictures => { paper(); c.save(); c.scale(scale * w / card.getBoundingClientRect().width, scale * w / card.getBoundingClientRect().width); try { await paintCard(c, card, { pictures }); c.restore(); c.getImageData(0, 0, 1, 1); return true } catch (err2) { console.warn('card picture', err2); return false } }
    if (!(await painted(true)) && !(await painted(false))) paper()
  }
  drawing()
  return blob()
}

// ---- controller "card" ----
// A card's page. The page works without this: every answer is a button of one form.
// This adds what needs a script: the pencil that opens the note on one option, the draft kept on the hub while
// typing, Enter that sends, the names of attached files (also pasted or dropped), and the arrow of the pen from
// the picture shown to the option it belongs to.

const clamp = (n, lo, hi) => Math.min(Math.max(n, lo), hi)
let turn = 0
const GROWS = globalThis.CSS?.supports?.('field-sizing', 'content') ?? false

// A picture that is scrolled inside its stage (a tall one on the card; one at its own size, opened large) is also
// moved by dragging it with the mouse: a press and a move of more than a few pixels scrolls the stage, and the click
// that ends such a drag does not open the picture; a plain click still does. A finger and a pen scroll by themselves
// (nothing here), and so do the wheel and the scrollbar. While the mouse is on such a picture the cursor is a hand
// (card.css .can-drag, .is-dragged); nothing is sized or moved by it.
const DRAG_FROM = 5
const rolls = box => box.scrollHeight > box.clientHeight + 1 || box.scrollWidth > box.clientWidth + 1
if (typeof window !== 'undefined') {
  let dragEnded = false
  const scrollOf = e => (e.pointerType === 'mouse' && e.target instanceof Element ? e.target.closest('.tc-stage > .tc-scroll') : null)
  window.addEventListener('pointerover', e => { const box = scrollOf(e); if (box) box.classList.toggle('can-drag', rolls(box)) }, true)
  window.addEventListener('pointerdown', e => {
    const box = e.button === 0 ? scrollOf(e) : null
    if (!box || !rolls(box)) return
    // (a press on the stage's own scrollbar is the browser's)
    const r = box.getBoundingClientRect()
    if (e.clientX >= r.left + box.clientLeft + box.clientWidth || e.clientY >= r.top + box.clientTop + box.clientHeight) return
    box.classList.add('can-drag')
    const from = { x: e.clientX, y: e.clientY, left: box.scrollLeft, top: box.scrollTop }
    let dragged = false
    const move = m => {
      if (!dragged && Math.hypot(m.clientX - from.x, m.clientY - from.y) < DRAG_FROM) return
      if (!dragged) { dragged = true; box.classList.add('is-dragged'); getSelection()?.removeAllRanges() }
      box.scrollLeft = from.left - (m.clientX - from.x); box.scrollTop = from.top - (m.clientY - from.y)
    }
    const end = () => {
      window.removeEventListener('pointermove', move, true); window.removeEventListener('pointerup', end, true); window.removeEventListener('pointercancel', end, true)
      if (!dragged) return
      box.classList.remove('is-dragged')
      // (the click the release makes is the end of the drag, not a click on the picture)
      dragEnded = true
      setTimeout(() => { dragEnded = false }, 0)
    }
    window.addEventListener('pointermove', move, true); window.addEventListener('pointerup', end, true); window.addEventListener('pointercancel', end, true)
  }, true)
  window.addEventListener('click', e => { if (!dragEnded) return; dragEnded = false; e.preventDefault(); e.stopImmediatePropagation() }, true)
  // (no ghost of the picture or of its link under the pointer)
  window.addEventListener('dragstart', e => { if (e.target instanceof Element && e.target.closest('.tc-stage > .tc-scroll')) e.preventDefault() }, true)
}

// A picture opened large (Full screen, /card/<n>/picture/<m>): a click shows it at its own size to scroll, the next fits it again.
if (typeof window !== 'undefined') window.addEventListener('click', e => {
  const fig = e.target instanceof Element ? e.target.closest('.tc-page.is-full .tc-stage:not(.is-video) .tc-figure') : null
  if (!fig || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey) return
  e.preventDefault(); e.stopPropagation()
  const stage = fig.closest('.tc-stage'), on = stage.classList.toggle('is-zoomed')
  fig.title = on ? 'Fit it into the window' : 'Show it at its own size'
  if (!on) stage.querySelector('.tc-scroll')?.scrollTo(0, 0)
}, true)

controller('card', class extends Controller {
  static targets = ['form', 'field', 'files', 'chips', 'saved', 'figure', 'marks', 'where', 'said', 'page', 'gallery']
  static values = { draft: String, pictures: Array }

  connect() {
    this.grow()
    if (this.hasMarksTarget) this.mountMarks()
    // (the card's pictures are fetched and decoded ahead, so a hover from option to option swaps at once)
    const warm = () => { this.warm = (this.picturesValue ?? []).map(p => { const i = new Image(); i.decoding = 'async'; i.src = p.src; i.decode?.().catch(() => {}); return i }) }
    if ('requestIdleCallback' in window) requestIdleCallback(warm, { timeout: 1500 }); else setTimeout(warm, 300)
    this.link = this.link.bind(this)
    this.placed = this.placed.bind(this)
    addEventListener('resize', this.placed)
    this.element.addEventListener('scroll', this.placed, { passive: true })
    this.element.querySelector('.tc-card > .tc-left')?.addEventListener('scroll', this.placed, { passive: true })
    // (no measuring while the page is built: the ResizeObserver below places it once the layout is there)
    // (the card grows after it was placed: a picture loads, a note's field opens, the talk arrives)
    this.sized = new ResizeObserver(this.placed)
    for (const el of this.element.querySelectorAll('.tc-card, .tc-pad')) this.sized.observe(el)
    addEventListener('resize', this.link)
    // (a finger's swipe across the card: the question before, the next; the round arrows are not there on a phone)
    this.element.addEventListener('touchstart', e => { const t = e.touches[0]; this.swipe = e.touches.length === 1 && t.clientX > 24 && e.target.closest?.('.tc-card') ? { x: t.clientX, y: t.clientY } : null }, { passive: true })   // (from the left edge a finger pulls the drawer: sidebar.mjs)
    this.element.addEventListener('touchend', e => {
      const from = this.swipe, t = e.changedTouches[0]; this.swipe = null
      if (!from || Math.abs(t.clientX - from.x) < 80 || Math.abs(t.clientY - from.y) > Math.abs(t.clientX - from.x) * .5) return
      this.element.querySelector(`.tc-rails a.${t.clientX < from.x ? 'is-next' : 'is-prev'}`)?.click()
    }, { passive: true })
    this.element.addEventListener('scroll', this.link, { capture: true, passive: true })
    this.element.addEventListener('scroll', e => { if (e.target instanceof Element && e.target.classList.contains('tc-roll')) this.rolled() }, { capture: true, passive: true })
    // (in focus, every way to a card's page from here keeps the mode: the question before and the next, another
    //  picture, a picture opened large and the way back from it)
    this.element.addEventListener('click', e => {
      const a = e.target instanceof Element ? e.target.closest('a[href]') : null
      if (!a || a.matches('[data-action~="card#focus"]')) return
      const url = new URL(a.href, location.href)
      if (url.origin === location.origin && /^\/(?:s\/[^/]+\/)?card\/[\w-]+(?:\/picture\/\d+)?$/.test(url.pathname)) a.href = focusAt(url.href, this.element.hasAttribute('data-focus'))
    }, true)
    this.element.addEventListener('load', e => { if (e.target.matches?.('.tc-figure img')) this.shape(e.target) }, true)
    this.link()
  }
  // The shape of the picture that stands (cardMedia, shapeOf): from its known size, or from the picture once it has
  // come. The stage's size does not depend on it.
  shape(img, w = img.naturalWidth, h = img.naturalHeight) {
    const fig = img.closest('.tc-figure'), is = shapeOf(w, h)
    if (!fig || !(w > 0 && h > 0)) return
    for (const c of ['is-tall', 'is-slim']) fig.classList.toggle(c, is.includes(c))
  }
  disconnect() {
    this.sized?.disconnect()
    removeEventListener('resize', this.link)
    removeEventListener('resize', this.placed)
    this.element.removeEventListener('scroll', this.link, { capture: true })
    clearTimeout(this.timer)
    this.sheet?.close()
  }

  // ---- marks: a note at a paragraph, a drawing on the tracing sheet ----
  // They travel in the form's field "marks" with whatever is pressed, and in the draft while nothing is. A sheet that
  // was drawn on also goes as a picture of the card with the drawing (attached as the form is sent).
  async mountMarks() {
    const left = this.element.querySelector('.tc-left')
    if (!left || !this.element.isConnected || this.marksUi) return
    const labels = new Map([...this.element.querySelectorAll('.tc-opt[data-key]')].map(b => [b.dataset.key, b.querySelector('.tc-opt-label')?.textContent ?? b.dataset.key]))
    this.marksUi = cardMarks({
      scroll: left,
      blocks: () => [...left.querySelectorAll('.tc-title, .tc-text .rich > *, .focus-mark')],
      labelOf: key => labels.get(key) ?? key,
      onChange: () => { this.marksTarget.value = JSON.stringify(this.marksUi.get()); this.keep(); this.keepHere(); this.inked() },
    })
    // (a card without a draft on the hub, an info: its drawing is kept on this device)
    if (!this.draftValue && this.marksTarget.value === '[]') try { this.marksTarget.value = localStorage.getItem(this.hereKey()) || '[]' } catch {}
    try { this.marksUi.set(JSON.parse(this.marksTarget.value || '[]')) } catch {}
    this.attachDrawing = this.attachDrawing.bind(this)
    this.formTarget.addEventListener('submit', this.attachDrawing)
    this.inked()
    // (a drawing kept from before: its picture is made ready, so an answer takes it along)
    if (this.sheetMark()) requestAnimationFrame(() => this.drawingPicture())
  }
  hereKey() { return `trommi-marks-${this.element.dataset.id}` }
  keepHere() {
    if (this.draftValue) return
    try { const v = this.marksTarget.value; if (v && v !== '[]') localStorage.setItem(this.hereKey(), v); else localStorage.removeItem(this.hereKey()) } catch {}
  }
  /** The sheet of this view: over the card, or over the picture standing large in Full screen. */
  sheetId() {
    const at = this.element.classList.contains('is-full') ? Number(this.element.querySelector('.tc-stage[data-at]')?.dataset.at) || 1 : 0
    return at ? { id: `pen-pic-${at}`, anchor: { kind: 'picture', index: at - 1 } } : { id: 'pen-card', anchor: { kind: 'card' } }
  }
  sheetMark() { const m = this.marksUi?.sheet(this.sheetId().id); return m && (m.strokes?.length || m.words?.length) ? m : null }
  // The pen above the card, or in the field's row: lays the sheet on; again: takes it off.
  trace(event) {
    event?.preventDefault()
    if (!this.marksUi) return
    if (this.sheet?.open) return this.sheet.close()
    const { id, anchor } = this.sheetId()
    this.marksUi.setPen(true)
    this.sheet = traceSheet({
      card: this.element.querySelector('.tc-card'), marks: this.marksUi, id, anchor, left: this.element.querySelector('.tc-card > .tc-left'),
      // (the field's box, when it stands under the card: not in Full screen, where the card covers the page)
      dock: this.element.classList.contains('is-full') ? null : this.element.querySelector('.tc-chat > .tc-ask'),
      onClose: () => { this.marksUi.setPen(false); this.inked(); this.drawingPicture() },
      onSend: async () => {
        await this.drawingPicture()
        const send = this.formTarget.querySelector('.tc-send')
        if (send) this.formTarget.requestSubmit(send)
      },
    })
    this.inked()
  }
  /** The pens say whether a drawing waits on the card; the field's chips show it, a tap lays the sheet on again. */
  inked() {
    const on = Boolean(this.sheetMark()), open = Boolean(this.sheet?.open)
    for (const b of this.element.querySelectorAll('.tc-draw')) { b.toggleAttribute('data-inked', on); b.setAttribute('aria-pressed', String(open)) }
    if (!on) this.drawing = null
    this.files()
  }
  async drawingPicture() {
    const mark = this.sheetMark()
    if (!mark) { this.drawing = null; return null }
    const blob = await cardPicture(this.element.querySelector('.tc-card'), mark).catch(() => null)
    this.drawing = blob ? new File([blob], `drawing-on-card-${this.element.getAttribute('aria-label')?.match(/\d+/)?.[0] ?? 'card'}.png`, { type: 'image/png' }) : null
    return this.drawing
  }
  // (sent: the picture of the drawing joins the files, once; the router reads the form after this)
  attachDrawing(event) {
    // Sent while the sheet still lies on the card (the field's Send, Enter, Send and Reverse): the sheet comes off,
    // the picture of the drawing is made, and the same send goes again with it.
    if (this.sheet?.open) {
      event?.preventDefault(); event?.stopImmediatePropagation()
      const by = event?.submitter
      this.sheet.close()
      this.drawingPicture().then(() => this.formTarget.requestSubmit(by?.isConnected ? by : undefined))
      return
    }
    if (!this.drawing || !this.sheetMark() || !this.hasFilesTarget) return
    if ([...this.filesTarget.files].some(f => f.name === this.drawing.name)) return
    const all = new DataTransfer()
    for (const f of [...this.filesTarget.files, this.drawing]) all.items.add(f)
    this.filesTarget.files = all.files
  }

  // ---- the pictures and the options are one thing ----
  // While the pointer or the keyboard is on an option, its picture stands on the stage and its small picture is
  // marked; on a small picture, that picture stands there and its option is marked. Leaving puts back what stood.
  // A click on a small picture makes it the one that stands (its link). A finger has no hover: a tap on a small
  // picture shows it and marks its option; a tap on an option answers.
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
    const fig = this.figureTarget
    // (a picture that could not be fetched left a word in its place, app.mjs watchAttachments: the next one gets a picture again)
    let img = fig.querySelector('img')
    if (!img) { img = document.createElement('img'); img.alt = ''; img.decoding = 'async'; img.draggable = false; const said = fig.querySelector('.att-gone'); if (said) said.replaceWith(img); else fig.prepend(img) }
    const now = Number(fig.dataset.at)
    if (!restoring && !this.stood) this.stood = { pic: this.picturesValue.find(p => p.at === now), key: fig.dataset.key ?? null }
    if (key != null) fig.dataset.key = key; else delete fig.dataset.key
    const thumbs = [...this.element.querySelectorAll('.tc-thumb[data-at]')]
    for (const t of thumbs) t.toggleAttribute('data-peek', !restoring && Number(t.dataset.at) === pic.at)
    if (now === pic.at && !this.pending) return this.link()
    // The picture that stands stays until the next one is decoded: no empty frame between the two, no flash.
    // A newer request wins over one still decoding.
    const token = this.pending = {}
    const next = new Image()
    next.src = pic.src
    const swap = () => {
      if (this.pending !== token) return
      this.pending = null
      delete img.dataset.attTried
      img.src = pic.src
      if (pic.width && pic.height) { img.width = pic.width; img.height = pic.height } else { img.removeAttribute('width'); img.removeAttribute('height') }
      img.style.width = pic.width ? `${pic.width}px` : ''
      this.shape(img, pic.width || next.naturalWidth, pic.height || next.naturalHeight)
      fig.closest('.tc-scroll')?.scrollTo(0, 0)
      this.link()
    }
    ;(next.decode ? next.decode() : Promise.resolve()).then(swap, swap)
    fig.dataset.at = pic.at
    fig.href = pic.href
    fig.dataset.circlesMarksValue = JSON.stringify(pic.marks ?? [])
    if (this.hasWhereTarget) this.whereTarget.textContent = `${pic.at} / ${this.element.querySelectorAll('.tc-roll .tc-thumb:not(.tc-thumb-file)').length || this.picturesValue.length}`
    if (this.hasSaidTarget) { this.saidTarget.textContent = pic.title ?? ''; this.saidTarget.hidden = !pic.title }
    if (this.hasPageTarget) {
      this.pageTarget.hidden = !pic.page
      if (pic.page) {
        const inApp = Boolean(pic.page.view), chip = this.pageTarget
        chip.href = pic.page.view ?? pic.page.url
        chip.querySelector('b').textContent = pic.page.name
        if (inApp) { chip.removeAttribute('target'); chip.removeAttribute('rel'); chip.dataset.nav = '' } else { chip.target = '_blank'; chip.rel = 'noopener noreferrer'; delete chip.dataset.nav }
      }
    }
    // (the way to the gallery opens the picture that stands; the gallery's way back returns to it)
    if (this.hasGalleryTarget) this.galleryTarget.href = 'back' in this.galleryTarget.dataset ? pic.href.replace(/\/picture\/(\d+)$/, '?pic=$1') : pic.href
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
  // Where the card stands against the window: gone (out of view above: the strip comes), and its foot passed (the
  // field to write in may stick to the window's foot without lying on the card).
  placed() {
    this.rolled()
    // (the left side that scrolls inside the card: no fade once its end is in view)
    const left = this.element.querySelector('.tc-card > .tc-left')
    if (left) left.classList.toggle('is-end', left.scrollHeight - left.scrollTop - left.clientHeight < 4)
    const card = this.element.querySelector('.tc-card')
    if (!card) return
    const box = this.element.getBoundingClientRect(), r = card.getBoundingClientRect()
    this.element.classList.toggle('card-gone', r.bottom < box.top + 90)
    this.element.classList.toggle('foot-passed', r.bottom < box.bottom - 96)
  }
  // "Load earlier (N)": the next ten entries above, the page keeps its place (what was in view stays in view)
  earlier(event) {
    const button = event.currentTarget, feed = button.closest('.tc-feed'), groups = [...feed.querySelectorAll('.tc-earlier-group[hidden]')]
    const group = groups.at(-1)
    if (!group) return button.remove()
    const before = this.element.scrollHeight
    group.hidden = false
    this.element.scrollTop += this.element.scrollHeight - before
    const left = feed.querySelectorAll('.tc-earlier-group[hidden] > *').length
    if (left) button.textContent = `Load earlier (${left})`; else button.remove()
  }
  toAnswers() { this.element.querySelector('.tc-card')?.scrollIntoView({ block: 'start', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' }) }
  // ---- focus: the card's page alone in the window (card.css .is-focus), with the talk and the field ----
  // Switched in place, so what is written, drawn or scrolled stays; the address says it (?focus=1), so a reload and
  // back and forward keep it, and the card's forms say it, so the card that comes next is in focus too.
  focus(event) {
    event.preventDefault()
    const on = !this.element.hasAttribute('data-focus'), button = event.currentTarget, to = focusAt(location.href, on)
    this.element.toggleAttribute('data-focus', on)
    this.element.classList.toggle('is-focus', on)
    history.replaceState(history.state, '', to)
    if (window.trommi?.router?.page) window.trommi.router.page.path = to
    button.href = focusAt(location.href, !on)
    button.classList.toggle('is-leave', on)
    button.setAttribute('aria-pressed', String(on))
    button.removeAttribute('title'); button.dataset.tip = FOCUS_WORDS[on]; button.setAttribute('aria-label', FOCUS_WORDS[on])
    for (const form of this.element.querySelectorAll('form[method="post"]')) {
      form.querySelector(':scope > input[name="focus"]')?.remove()
      if (on) form.insertAdjacentHTML('afterbegin', FOCUS_FIELD)
    }
    this.placed()
  }
  // The bar of small ones ends before its counter ("2 / 5" has its own place beside it). Where more of it lies beyond
  // an edge, that edge fades (card.css .is-more-start, .is-more-end); a bar that fits has none.
  rolled() {
    for (const roll of this.element.querySelectorAll('.tc-roll')) {
      const more = roll.scrollWidth - roll.clientWidth
      roll.classList.toggle('is-more-start', more > 1 && roll.scrollLeft > 1)
      roll.classList.toggle('is-more-end', more > 1 && roll.scrollLeft < more - 1)
    }
  }
  // (another picture or a video came into the frame: it is the one that stands now)
  framed() {
    this.stood = null
    // (the one that stands is in view in the bar of small ones)
    const on = this.element.querySelector('.tc-roll .tc-thumb[aria-pressed="true"]'), roll = on?.closest('.tc-roll')
    if (roll && (on.offsetLeft < roll.scrollLeft || on.offsetLeft + on.offsetWidth > roll.scrollLeft + roll.clientWidth)) roll.scrollLeft = on.offsetLeft - (roll.clientWidth - on.offsetWidth) / 2
    const at = this.element.querySelector('.tc-stage[data-at]')?.dataset.at
    if (at && this.hasGalleryTarget) this.galleryTarget.href = this.galleryTarget.getAttribute('href').replace(/\/picture\/\d+$/, `/picture/${at}`)
    this.rolled()
    this.link()
  }

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
  // (Where the browser sizes a field to its content itself (field-sizing, card.css), no measuring: it costs a forced layout per page.)
  grow() { if (GROWS) return; const f = this.hasFieldTarget ? this.fieldTarget : null; if (f) { f.style.height = 'auto'; f.style.height = `${Math.min(f.scrollHeight, 220)}px` } }
  // Enter sends, Shift+Enter is a new line. Ctrl+Enter (Cmd+Enter) on a decision or an info sends and reverses: the words go back
  // with the card, for rework (the reverse card's own way: revise takes the field's words as the hand-back's message).
  keys(event) {
    if (event.key !== 'Enter' || event.shiftKey || event.isComposing || (!this.fieldTarget.value.trim() && !this.filesTarget.files.length)) return
    event.preventDefault()
    const reverse = (event.ctrlKey || event.metaKey) && this.reverseTile()
    this.formTarget.requestSubmit(reverse || this.formTarget.querySelector('.tc-send'))
  }
  reverseTile() { return this.element.querySelector('.tc-answer .tc-reverse') }
  // A click on Send while it wears the reverse card (Shift held: ui.mjs watchShift, <html data-shift>): send and
  // reverse, as Ctrl+Enter.
  sendClick(event) {
    const tile = document.documentElement.hasAttribute('data-shift') && this.reverseTile()
    if (!tile) return
    event.preventDefault()
    this.formTarget.requestSubmit(tile)
  }
  // "Send and Reverse" from the chevron's menu (no keyboard needed)
  sendReverse() {
    const tile = this.reverseTile()
    if (tile) this.formTarget.requestSubmit(tile)
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
    if (this.marksUi && this.hasMarksTarget) { this.marksUi.set([]); this.marksTarget.value = '[]'; this.keepHere(); this.drawing = null; this.inked() }
  }

  // ---- files: chosen, pasted or dropped ----
  files() {
    if (!this.hasFilesTarget || !this.hasChipsTarget) return
    const list = [...this.filesTarget.files].filter(f => !f.name.startsWith('drawing-on-card-'))
    const drawn = this.sheetMark() && !this.sheet?.open
    this.chipsTarget.hidden = !list.length && !drawn
    // (each a small preview with its own × : ui.mjs fileTile; the object URLs of the ones before are let go)
    revokeTiles(this.chipsTarget)
    this.chipsTarget.replaceChildren(...list.map(f => {
      const tile = fileTile(f)
      tile.querySelector('.att-off').addEventListener('click', () => { const left = new DataTransfer(); for (const x of this.filesTarget.files) if (x !== f) left.items.add(x); this.filesTarget.files = left.files; this.files() })
      return tile
    }))
    if (drawn) {
      const chip = document.createElement('button')
      chip.type = 'button'; chip.className = 'focus-chip is-drawing'; chip.textContent = 'Drawing on the card'; chip.title = 'It goes along with what you send. Open the sheet again'
      chip.addEventListener('click', () => this.trace())
      this.chipsTarget.prepend(chip)
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
      // (A region's size comes as width/height (the client core, the connector's ref) or as w/h: both are read.)
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
    const walk0 = walkOf(before), after = card ? walk0.slice(walk0.indexOf(card) + 1).map(c => c.id) : []
    const wantsStream = t.wantsStream(req)
    const stay = form.has('stay') && wantsStream
    try {
      if (!card) throw Object.assign(new Error('this question is not on the board any more'), { status: 404 })
      await WAYS[what](card, form, filesOf(form))
    } catch (err) {
      const text = err.message || 'the board did not take it'
      const m = model(), now = card && m.byCard.get(card.id)
      // (Sent from the card's own page, where no Desk row stands: what went wrong comes as a note.)
      const onCard = /^\/(?:s\/[^/]+\/)?card\/[\w-]+$/.test(new URL(String(req.headers.referer ?? '/'), location.origin).pathname)
      if (stay && onCard) return t.sendStream(req, res, t.toast({ head: what === 'message' ? 'Not sent' : 'Not saved', line: text, role: 'alert' }), 422)
      if (stay) return t.sendStream(req, res, now && m.fresh.includes(now) ? stream('replace', `row-${now.id}`, deskRow(now, m, BASE, { error: `Not saved: ${text}`, slim: true })) : t.toast({ head: 'Not saved', line: text, role: 'alert' }))
      if (!now) return t.notFound(req, res, 'This question is not on the board any more.')
      return cardView(req, res, now, m, { walk: form.has('walk'), focus: form.has('focus'), error: `Not saved: ${text}` }, 422)
    }
    const quiet = form.has('quiet') || !SAID[what]
    if (stay) {
      const m = model()
      // Undone from a toast: back to that card (its page, at its top, the answers in view), unless that is the page already;
      // from a session's page, its card under the session.
      if (form.has('undo')) {
        const at = new URL(String(req.headers.referer ?? '/'), location.origin).pathname, s = /^\/s\/[^/]+/.exec(at.slice(BASE.length))?.[0]
        const to = cardPath(card, s ? `${BASE}${s}` : BASE)
        if (at !== to) return t.sendStream(req, res, stream('visit', to))
      }
      return t.sendStream(req, res, html`${walkOf(m).some(c => c.id === id) ? '' : stream('remove', `row-${id}`)}${quiet ? '' : stream('prepend', 'says-host', says(m.byCard.get(id), what))}`)
    }
    const said = quiet ? '' : `said=${id}:${what}`
    const home = String(form.get('back') ?? '')
    const fromSession = home.startsWith(`${BASE}/s/`) && /^[\w\-/%+.]+$/.test(home)
    // (the focus mode goes along to the card that comes next: name="focus" in the card's forms)
    const to = (c, under, ...query) => focusAt(`${cardPath(c, under)}?${query.filter(Boolean).join('&')}`, form.has('focus'))
    if (['message', 'reopen', 'takeback', 'wake'].includes(what) && !form.has('stay')) return redirect(res, to(card, fromSession ? home : BASE, what === 'message' ? `said=${id}:message` : ''))
    if (fromSession) return redirect(res, `${home}${said ? `?${said}` : ''}`)
    // (in the walk, and after the reverse card on a card's own page: on to the next open card)
    if (form.has('walk') || (form.has('next') && what === 'revise')) {
      const m = model(), walk = walkOf(m), next = after.map(x => m.byCard.get(x)).find(c => c && walk.includes(c)) ?? walk.find(c => c.id !== id)
      return redirect(res, next ? to(next, BASE, form.has('walk') ? 'walk=1' : '', said) : `${BASE}/${said ? `?${said}` : ''}`)
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
    t.get(/^\/(?:s\/([^/]+)\/)?card\/([\w-]+)$/, async ({ req, res, url, match }) => {
      let m = model(), card = m.cardByRef(match[2])
      if (!card) return t.notFound(req, res, 'This question is not on the board any more.')
      if (url.searchParams.has('older') && moreOf(card)) {
        try { await hub.loadOlder(threadOf(card)) } catch (err) { console.warn('older comments', err) }
        m = model(); card = m.byCard.get(card.id) ?? card
      }
      cardView(req, res, card, m, { more: moreOf(card), said: String(url.searchParams.get('said') ?? ''), pic: Number(url.searchParams.get('pic')) || 1, walk: url.searchParams.has('walk'), focus: url.searchParams.has('focus'), version: Number(url.searchParams.get('v')) || null, from: match[1] ? decodeURIComponent(match[1]) : null })
    })
    t.get(/^\/(?:s\/([^/]+)\/)?card\/([\w-]+)\/picture\/(\d+)$/, ({ req, res, url, match: [, from, ref, at] }) => {
      const m = model(), card = m.cardByRef(ref)
      if (!card) return t.notFound(req, res, 'This question is not on the board any more.')
      if (!imagesOf(card).length && !videosOf(card).length) return redirect(res, focusAt(cardPath(card, BASE), url.searchParams.has('focus')))
      cardView(req, res, card, m, { more: moreOf(card), pic: Number(at) || 1, full: true, focus: url.searchParams.has('focus'), from: from ? decodeURIComponent(from) : null })
    })
    // The page a picture was made from (an attachment of the card): shown in the sandboxed frame, never as a page of the
    // app's own origin (controller "assetthumb": decrypted here, handed to /frame as one message).
    t.get(/^\/(?:s\/([^/]+)\/)?card\/([\w-]+)\/picture\/(\d+)\/page$/, ({ req, res, match: [, from, ref, at] }) => {
      const m = model(), card = m.cardByRef(ref)
      if (!card) return t.notFound(req, res, 'This question is not on the board any more.')
      const pic = imagesOf(card)[Number(at) - 1]
      if (!pic?.page) return redirect(res, cardPath(card, BASE))
      const back = `${cardPath(card, BASE)}?pic=${Number(at)}`
      const main = html`<div class="t-picture as-view"><header class="t-picture-bar"><a class="t-picture-back" data-nav href="${back}" aria-label="Back to the card">${sk('back')}<h1>${card.title}</h1></a><span class="t-picture-where"><b>Page</b> ${pic.page.name}</span></header>
<div class="as-stage" data-type="html"><div class="as-frame-box" data-controller="assetthumb" data-assetthumb-src-value="${pic.page.url}" data-assetthumb-full-value="true"><p class="as-wait">Opening the page…</p></div></div></div>`
      t.page(req, res, { model: m, title: `${pic.page.name} · Trommi`, view: 'picture', sidebar: false, css: 'asset', stream: null, main, bodyAttrs: ' data-focus-page="card"' })
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
