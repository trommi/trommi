// The Desk: every open question as a row, in the hub's fixed order, and the stacks at its foot
// (Later, Memos, Done). The markup is the one css/app.css, css/piles.css and css/phone-desk.css style
// (the old client built it in js/inbox.js and js/piles.js). A row never unfolds: its text is a link to
// the card's own page, its tiles are forms that answer with one tap.
import { html, raw } from './html.mjs'
import { WORDS, isKnock, knockWord, cardNr, cardNote, kindOf, plain, carries, quick, labelSize, BARE, shortOf, advisedKeys, advisedLabels, ago, agoSpan } from './text.mjs'
import { smallMark, markArt, PLUS } from './sidebar.mjs'
import { srcOf } from './picture.mjs'   // a stored picture at the size it is shown (thumbs.mjs)
import { deskStacks, stackCounts } from './stacks.mjs'   // the four places at the foot of the Desk
import { nextPlease } from './nextplease.mjs'   // the heading as index cards (card Nr. 166)
import { gutterHoverClass, pointerHost } from './gutter-hover.mjs'   // an arrow from the sidebar to the card under the pointer (card Nr. 208)
import { sketchSvg } from '../pen.js'

const sk = (name, cls) => raw(sketchSvg(name, cls))
export const cardPath = (card, base) => `${base}/q/${encodeURIComponent(card.number ?? card.id)}`
const COPY_ICON = raw('<svg viewBox="0 0 24 24" class="sketch cardclip-ico" aria-hidden="true"><path d="M9.2 8.6C12.6 8.3 16 8.4 19.3 8.7C19.7 12.2 19.6 15.8 19.4 19.4C16 19.8 12.6 19.7 9.1 19.5C8.7 16 8.8 12.4 9 9"/><path d="M15 5.6C14.8 4.9 14.3 4.5 13.6 4.5C10.9 4.3 8.2 4.4 5.4 4.6C4.8 4.7 4.5 5.1 4.5 5.7C4.3 8.4 4.3 11.2 4.6 14C4.7 14.6 5.1 14.9 5.8 15"/></svg>')
/** The small button that copies a card as one line, to paste into another agent (controller "clip"). */
export function copyButton(card) {
  const picked = card.choices?.length ? card.options.filter(o => card.choices.includes(o.key)).map(o => o.label).join(', ') : ''
  const text = `Nr. ${card.number} · ${card.title}${picked ? ` → ${picked}` : ''}`
  return html`<button class="cardclip-copy" type="button" data-controller="clip" data-action="clip#copy" data-clip-text-value="${text}" data-clip-card-value="${JSON.stringify({ id: card.id, number: card.number, title: card.title, choice_label: picked })}" title="Copy to paste into another agent" aria-label="Copy to paste into another agent">${COPY_ICON}</button>`
}
const act = (card, base, what) => `${base}/cards/${card.id}/${what}`

// A way out of the row, tucked beside the title: Snooze, Revise, Whatever, Shred. One form, each button its own address.
const tab = (cls, drawing, word, label, action, hidden = false) => html`<button class="inbox-tab-act ${cls}" type="submit" formaction="${action}" aria-label="${label}" title="${label}"${hidden ? raw(' hidden') : ''}><i class="inbox-later-flap">${sk(drawing)}<b>${word}</b></i></button>`

const tile = (cls, drawing, label, { name = 'key', value = '', action = null, title = '', aria = '', short = false } = {}) => html`<button class="inbox-answer ${cls}"${/\bis-advised\b/.test(cls) ? raw(' data-controller="advice"') : ''} type="submit"${value ? html` name="${name}" value="${value}"` : ''}${action ? html` formaction="${action}"` : ''}${title ? html` title="${title}"` : ''}${aria ? html` aria-label="${aria}"` : ''}><span class="inbox-disc">${sk(drawing)}</span>${label ? html`<span${short ? raw(' class="inbox-short"') : ''}>${label}</span>` : ''}</button>`

function tiles(card, base) {
  const stay = raw('<input type="hidden" name="stay" value="1">')
  const seen = card.revised ? html`<input type="hidden" name="revised" value="${card.revised}">` : ''
  if (card.kind === 'info') {
    return html`<form class="inbox-actions" method="post" action="${act(card, base, 'close')}">${stay}
${tile('is-thumb is-what', 'what', '', { action: act(card, base, 'what'), title: `${WORDS.what}: ask the session to explain this; it comes back explained`, aria: 'What?? — explain this to me' })}
${tile('is-thumb is-lead is-ack', 'tick', WORDS.ack, { title: `${WORDS.ack}: read, close it` })}</form>`
  }
  const bare = card.options.every(o => BARE.test(o.label.trim()))
  const size = bare ? 'none' : labelSize(card.options)
  const short = card.options.every(shortOf)
  if (quick(card) && (bare || size !== 'none' || short)) {
    // Thumbs: down on the left, up on the right. The option the agent leads with (its first, or "allow") is the up.
    const isYes = o => (card.kind === 'permission' ? o.key === 'allow' : o === card.options[0])
    const worded = !bare && size === 'none'
    return html`<form class="inbox-actions" method="post" action="${act(card, base, 'decide')}">${stay}${seen}
${[...card.options].sort((a, b) => isYes(a) - isYes(b)).map(o => {
      const lead = isYes(o), advised = advisedKeys(card).includes(o.key)
      const cls = `is-thumb${lead ? ' is-lead' : ''}${size === 'small' ? ' is-small' : ''}${worded ? ' is-short' : ''}${advised ? ' is-advised' : ''}`
      const title = advised ? 'The agent recommends this' : [size === 'none' && !bare ? o.label : '', o.detail].filter(Boolean).join(': ')
      return tile(cls, lead ? 'yes' : 'no', worded ? shortOf(o) : size === 'none' ? '' : o.label, { value: o.key, title, aria: o.label, short: worded })
    })}</form>`
  }
  // More than two ways: one tile, "Choose". It is a link to the card's own page, where every option stands.
  const count = card.multiple ? `${card.options.length} options, several` : `${card.options.length} options`
  return html`<div class="inbox-actions"><a class="inbox-answer is-wide is-lead" data-nav href="${cardPath(card, base)}" title="${count}" aria-label="Choose: ${count}"><span class="inbox-disc">${sk('choose')}</span><span>Choose</span></a></div>`
}

const knockAttr = card => (isKnock(card) ? raw(' data-knock') : '')
/** One open question as a row. from: the session that asked. error: what went wrong with the last answer. */
export function deskRow(card, model, base, { error = '' } = {}) {
  const from = model.byAgent.get(card.agent)
  const assets = model.state.assets
  const about = [cardNote(card), card.unsnoozed && !card.snoozed_until ? 'Back from snooze' : '', card.urgency_reason].filter(Boolean).join(' · ')
  const words = plain(card.body, assets)
  const extra = carries(card, assets)
  const images = (card.attachments ?? []).filter(a => kindOf(a) === 'image')
  const knock = isKnock(card)
  const quiet = knock ? '' : card.kind === 'info' ? html`<span class="inbox-whenever inbox-toread" title="To read: nothing to decide" role="img" aria-label="To read">${sk('page')}</span>`
    : card.urgency === 'low' ? html`<span class="inbox-whenever" title="Whenever: nothing waits on this" role="img" aria-label="Whenever">${sk('whenever')}</span>` : ''
  const trustTip = `I don’t give a duck: your call (R)${advisedLabels(card) ? ` · agent takes ${advisedLabels(card)}` : ''}`
  const href = cardPath(card, base)
  return html`<article class="inbox-row" id="row-${card.id}"${knockAttr(card)} tabindex="-1" data-id="${card.id}" data-urgency="${card.urgency}"${card.kind === 'info' ? raw(' data-kind="info"') : ''}${from ? html` data-from="${from.id}" style="--hue:${from.hue}"` : ''}>
${from ? html`<a class="inbox-gutter${gutterHoverClass()}" data-nav href="${base}/s/${encodeURIComponent(from.id)}" aria-label="From ${from.name}: open the session" data-name="${from.name}" style="--hue:${from.hue}">${smallMark(from)}<span class="inbox-gutter-name" aria-hidden="true">${from.name}</span></a>` : ''}
<div class="inbox-content">
<header class="inbox-row-head">${knock ? html`<span class="inbox-tab">${sk('knock')}${knockWord(card)}</span>` : ''}</header>
<a class="inbox-text${from ? ' has-sender' : ''}" data-nav href="${href}" title="${cardNr(card)}: open it">${from ? html`<span class="inbox-from-mark inbox-who" style="--hue:${from.hue}" title="${from.name}" role="img" aria-label="From ${from.name}">${markArt(from)}</span>` : ''}<strong class="inbox-question" data-controller="fit">${card.title}</strong>${about || words ? html`<span class="inbox-body">${about ? html`<span class="inbox-body-about">${about}</span>` : ''}${words ? html`<span class="inbox-body-text">${about ? ` · ${words}` : words}</span>` : ''}</span>` : ''}</a>
<span class="inbox-when" title="${cardNr(card)} · asked ${ago(card.created)}">${copyButton(card)}<span class="inbox-nr">${cardNr(card)}</span><form class="inbox-tabs" method="post" action="${act(card, base, 'snooze')}"><input type="hidden" name="stay" value="1">
${tab('inbox-later', 'snooze', WORDS.later, `${WORDS.later}: put this question off; it waits for you below`, act(card, base, 'snooze'))}
${card.kind !== 'permission' ? tab('inbox-revise', 'reverse', WORDS.revise, `${WORDS.revise}: hand it back to the session at once; it returns reworked`, act(card, base, 'revise'), true) : ''}
${card.kind === 'decision' ? tab('inbox-trust', 'duck', WORDS.trust, trustTip, act(card, base, 'trust'), true) : ''}
${card.kind !== 'permission' ? tab('inbox-shred', 'bin', WORDS.shred, `${WORDS.shred}: throw this away unanswered. The session is told; it will not ask again`, act(card, base, 'shred')) : ''}
</form>${agoSpan(card.created, 'inbox-ago')}</span>
<p class="inbox-byline">${images.length ? html`<a class="inbox-thumb" data-nav href="${href}/p/1" aria-label="${images.length === 1 ? `Enlarge ${images[0].name}` : `Look at ${images.length} pictures`}">${images.slice(0, 3).map(a => html`<img${srcOf(a, 56)} alt="" loading="lazy" decoding="async" width="56" height="42">`)}</a>` : ''}${extra.length ? html`<span class="inbox-carries" title="This question carries ${extra.map(x => x.text).join(', ')}">${extra.map(x => html`<span>${sk(x.icon)}${x.text}</span>`)}</span>` : ''}${quiet}${from ? html`<span class="inbox-from">${smallMark(from)}<span>${from.name}</span></span><span class="inbox-sep"> · </span>` : ''}</p>
</div>
${tiles(card, base)}
<p class="inbox-error inbox-row-error" role="alert"${error ? '' : raw(' hidden')}>${error}</p>
</article>`
}

// ---- the stacks at the foot: Later, In the works, Done and the small basket (views/stacks.mjs) ----
export { deskStacks }

/** The heading: "Next, please" with the number of what waits, the way into the walk; or that the Desk is clear. */
export function deskHead(model, base) {
  const n = model.fresh.length
  if (n) return html`<header class="inbox-head" id="desk-head" data-controller="title" data-title-count-value="${n}"><div class="inbox-title">${nextPlease(model, base)}</div></header>`
  if (!model.units.length) return deskInvite()
  // (Counted as the tabs at the foot count them, views/stacks.mjs: the same words, the same numbers.)
  const n2 = stackCounts(model)
  const below = [n2.works ? `${n2.works} working` : '', n2.later ? `${n2.later} snoozed` : ''].filter(Boolean).join(' · ')
  return html`<header class="inbox-head" id="desk-head" data-controller="title" data-title-count-value="0"><div class="inbox-title"><h2>${WORDS.desk} is clear.</h2>${below ? html`<p>${below}</p>` : ''}</div></header>`
}

/** The Desk of a new account (no session yet): a calm note with one way on, inviting the first agent. The button sends
 *  the form the Devices page sends (POST /pair, role agent; room.mjs), so the same invite page with the link follows.
 *  It stands in the heading (#desk-head), which the live stream replaces: the note goes once a session is there. */
const deskInvite = () => html`<header class="inbox-head" id="desk-head" data-controller="title" data-title-count-value="0"><section class="desk-invite" id="desk-invite" aria-labelledby="desk-invite-title">
${sk('heads', 'desk-invite-art')}<h2 id="desk-invite-title">Invite your first agent</h2>
<p>You get one command for any computer with Claude Code: run it in the project folder, then start Claude Code there with <code>--dangerously-load-development-channels server:trommi</code>. Its questions land here.</p>
<form method="post" action="/pair"><input type="hidden" name="role" value="agent"><button type="submit" class="desk-invite-go" id="desk-invite-go">${PLUS}<span>Invite an agent</span></button></form>
</section></header>`

/** The rows as runs: cards of one session that follow each other stand in one section. Returns [{ sender, cards }]. */
export function runs(model) {
  const groups = []
  for (const card of model.fresh) {
    const sender = model.byAgent.get(card.agent)
    if (!sender) continue
    if (groups.at(-1)?.sender === sender) groups.at(-1).cards.push(card)
    else groups.push({ sender, cards: [card] })
  }
  return groups
}
export const runSection = (sender, rows, n) => html`<section class="inbox-group" data-sender="${sender.id}" data-run="${n > 1 ? 'many' : 'single'}" aria-label="${sender.name}: ${n === 1 ? '1 question' : `${n} questions`}"${sender.starred ? raw(' data-vip') : ''} style="--hue:${sender.hue}">${rows}</section>`

/** Everything inside .inbox-groups (#desk-list). rowOf(card): the row's markup (the stream keeps what it rendered). */
export function deskList(model, base, { pile = null, q = '', rowOf = card => deskRow(card, model, base) } = {}) {
  return html`${runs(model).map(({ sender, cards }) => runSection(sender, cards.map(rowOf), cards.length))}
${deskStacks(model, base, pile, q)}
${model.open.length ? '' : html`<div class="inbox-empty">${sk('desk')}<p>As soon as an agent has a question, it shows up here.</p></div>`}`
}

/** The Desk's <main>. */
// (Controller "desk": a card that arrives out of sight is said quietly, "1 new ↓"; a knock out of sight has a strip at
//  the list's edge that leads to it.)
export const deskMain = (model, base, opts = {}) => html`<main id="inbox" aria-label="Desk" data-controller="desk" data-action="turbo:before-stream-render@document->desk#changing">
${pointerHost()}${deskHead(model, base)}
<div class="inbox-news-at"><button class="inbox-news" type="button" data-desk-target="news" data-action="desk#toNew" hidden></button></div>
<div class="inbox-groups" id="desk-list" data-desk-target="list">${deskList(model, base, opts)}</div>
<div class="inbox-edge is-up"><button class="inbox-edge-knock" type="button" data-desk-target="up" data-action="desk#toKnock" data-dir="up" hidden>↑ ${sk('knock')}<span></span></button></div>
<div class="inbox-edge is-down"><button class="inbox-edge-knock" type="button" data-desk-target="down" data-action="desk#toKnock" data-dir="down" hidden>↓ ${sk('knock')}<span></span></button></div>
</main>`
