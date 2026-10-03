// Copying a decision into another session's conversation (docs/question-contract.md, section 13).
//
// "Copy" on a card writes one plain line to the system clipboard ("Nr. 131 · Stack: what do hub and web
// app run on? → Node, no framework") and remembers the card in this tab. While a card is remembered,
// every composer offers "Paste decision Nr. 131" above its field; a click on it, or Ctrl+V in the field
// while the clipboard still holds that line, attaches the card as a chip instead of pasting text. On
// send the ids go along as `cards`, and the receiving agent gets the card in full. In the conversation a
// message that carries cards shows each as a quiet chip that links to /q/<number>.
//
// For the composers (chat.js, quicksend.js), the whole hook:
//   const clipped = pasteChip(field, { host, onChange })    // host: where the chips stand (prepended)
//   … clipped.ids() goes to sendMessage as `cards`; clipped.clear(true) after it was sent.
// For a message:  if (m.cards?.length) node.append(cardChips(m.cards, (id, isOpen) => …))
// For a card:     copyButton(card)

import { el } from './ui.js'
import { getState } from './store.js'

const KEY = 'trommi-cardclip'
const MAX = 5   // the server takes no more per message
const SVG = 'http://www.w3.org/2000/svg'

// ---- what is remembered: { id, number, title, choice_label, text } ----
let held = null
try { held = JSON.parse(sessionStorage.getItem(KEY) ?? 'null') } catch {}
if (held && !held.id) held = null
const watchers = new Set()
const changed = () => { for (const fn of watchers) fn() }
const keep = () => { try { held ? sessionStorage.setItem(KEY, JSON.stringify(held)) : sessionStorage.removeItem(KEY) } catch {} }

/** The labels of what was chosen, joined by ", "; null while there is no answer. */
export function choiceLabel(card) {
  if (card.choice_label) return card.choice_label
  const picked = card.choices?.length ? card.choices : card.choice != null ? [card.choice] : []
  return (card.options ?? []).filter(o => picked.includes(o.key)).map(o => o.label ?? o.key).join(', ') || null
}

/** The card as one plain line, as it goes to the system clipboard. */
export function cardText(card) {
  const answer = choiceLabel(card)
  return `Nr. ${card.number} · ${card.title}${answer ? ` → ${answer}` : ''}`
}

async function toClipboard(text) {
  try { await navigator.clipboard.writeText(text); return true } catch {}
  // No clipboard API (plain http, or it was refused): the old way, inside an open dialog if there is one.
  try {
    const area = document.createElement('textarea')
    area.value = text
    area.setAttribute('readonly', '')
    area.style.cssText = 'position:fixed;left:0;top:0;width:1px;height:1px;opacity:0'
    const back = document.activeElement
    ;(document.querySelector('dialog[open]') ?? document.body).append(area)
    area.select()
    const ok = document.execCommand('copy')
    area.remove()
    back?.focus?.({ preventScroll: true })
    return ok
  } catch { return false }
}

let note = null, noteTimer = 0
function say(text) {
  if (!note) {
    note = el('p', 'cardclip-note')
    note.setAttribute('role', 'status')
  }
  // Inside an open dialog or the open Focus window, or it would lie under it.
  ;(document.querySelector('dialog[open]') ?? document.querySelector('.focus:not([hidden])') ?? document.body).append(note)
  note.textContent = text
  note.hidden = false
  clearTimeout(noteTimer)
  noteTimer = setTimeout(() => { note.hidden = true }, 2600)
}

/** Copy a card: one line to the system clipboard, and the card remembered here for the composers. */
export async function copyCard(card) {
  const text = cardText(card)
  held = { id: card.id, number: card.number, title: card.title, choice_label: choiceLabel(card), text }
  keep()
  changed()
  const ok = await toClipboard(text)
  say(ok ? 'Copied — paste it into a session' : 'Kept here — paste it into a session')
  return ok
}

/** The id of the remembered card, or null. */
export const copiedCard = () => held?.id ?? null

/** Forget the remembered card. */
export function clearCopied() {
  if (!held) return
  held = null
  keep()
  changed()
}

function copyIcon() {
  const svg = document.createElementNS(SVG, 'svg')
  svg.setAttribute('viewBox', '0 0 24 24')
  svg.setAttribute('class', 'sketch cardclip-ico')
  svg.setAttribute('aria-hidden', 'true')
  // two sheets, the front one drawn in one go and not quite closed
  for (const d of ['M9.2 8.6C12.6 8.3 16 8.4 19.3 8.7C19.7 12.2 19.6 15.8 19.4 19.4C16 19.8 12.6 19.7 9.1 19.5C8.7 16 8.8 12.4 9 9', 'M15 5.6C14.8 4.9 14.3 4.5 13.6 4.5C10.9 4.3 8.2 4.4 5.4 4.6C4.8 4.7 4.5 5.1 4.5 5.7C4.3 8.4 4.3 11.2 4.6 14C4.7 14.6 5.1 14.9 5.8 15']) {
    const path = document.createElementNS(SVG, 'path')
    path.setAttribute('d', d)
    svg.append(path)
  }
  return svg
}

/** A small icon button that copies this card. */
export function copyButton(card) {
  const b = el('button', 'cardclip-copy')
  b.type = 'button'
  b.title = 'Copy to paste into another agent'
  b.setAttribute('aria-label', b.title)
  b.append(copyIcon())
  let timer = 0
  b.addEventListener('click', e => {
    e.preventDefault()
    e.stopPropagation()
    copyCard(card)
    b.classList.add('is-done')
    clearTimeout(timer)
    timer = setTimeout(() => b.classList.remove('is-done'), 1400)
  })
  return b
}

function chipBody(c) {
  const parts = [el('b', null, `Nr. ${c.number}`), el('span', 'cardclip-title', c.title)]
  if (c.choice_label) parts.push(el('span', 'cardclip-answer', `→ ${c.choice_label}`))
  return parts
}

/** The cards a message carries, as quiet chips that link to /q/<number>. onOpen(id, isOpen), if given,
 *  shows the card in place on a plain click; isOpen says whether the question still waits for an answer
 *  (the Focus window shows open ones only). */
export function cardChips(cards = [], onOpen) {
  const row = el('div', 'cardclip-row')
  for (const c of cards) {
    const a = el('a', 'cardclip-chip is-link')
    a.href = `/q/${encodeURIComponent(c.number)}`
    a.title = `Nr. ${c.number} · ${c.title}${c.choice_label ? ` → ${c.choice_label}` : ''}`
    a.append(...chipBody(c))
    a.addEventListener('click', e => {
      if (!onOpen || e.ctrlKey || e.metaKey || e.shiftKey || e.button) return
      e.preventDefault()
      onOpen(c.id, getState().all?.cards?.find(x => x.id === c.id)?.status === 'open')
    })
    row.append(a)
  }
  return row
}

/** The hook for a composer. field: its textarea; host: the element the chips are prepended to;
 *  onChange: called when what is attached changes (to enable Send, to measure).
 *  Returns { node, ids(), clear(sent) }: ids() are the attached card ids (undefined when none),
 *  clear(true) after a send takes the chips off and forgets the copied card. */
export function pasteChip(field, { host = field.form, onChange, initial = [] } = {}) {
  const node = el('div', 'cardclip-bar')
  // (initial: chips a kept draft already carries, as cards() gave them.)
  let attached = initial.filter(c => c?.id).slice(0, MAX)   // [{ id, number, title, choice_label }]
  const offered = () => held && attached.length < MAX && !attached.some(c => c.id === held.id)
  function attach() {
    if (!offered()) return false
    const { text, ...card } = held
    attached.push(card)
    paint()
    onChange?.()
    return true
  }
  function paint() {
    const nodes = attached.map((c, i) => {
      const chip = el('span', 'cardclip-chip')
      chip.title = `Goes along: Nr. ${c.number} · ${c.title}`
      const off = el('button', 'cardclip-off', '×')
      off.type = 'button'
      off.setAttribute('aria-label', `Take Nr. ${c.number} off`)
      off.addEventListener('click', e => { e.stopPropagation(); attached.splice(i, 1); paint(); onChange?.(); field.focus() })
      chip.append(...chipBody(c), off)
      return chip
    })
    if (offered()) {
      const offer = el('span', 'cardclip-offer')
      const paste = el('button', 'cardclip-paste', `Paste decision Nr. ${held.number}`)
      paste.type = 'button'
      paste.title = `${held.text}\nAttach it to this message (or Ctrl+V in the field)`
      paste.addEventListener('click', e => { e.stopPropagation(); attach(); field.focus() })
      const forget = el('button', 'cardclip-off', '×')
      forget.type = 'button'
      forget.setAttribute('aria-label', 'Forget the copied decision')
      forget.title = 'Forget it'
      forget.addEventListener('click', e => { e.stopPropagation(); clearCopied() })
      offer.append(paste, forget)
      nodes.push(offer)
    }
    node.replaceChildren(...nodes)
    node.hidden = !nodes.length
    node.toggleAttribute('data-attached', attached.length > 0)
  }
  // Ctrl+V while the clipboard still holds the copied line: the card, not its text.
  field.addEventListener('paste', e => {
    if (!held || !offered()) return
    const text = e.clipboardData?.getData('text/plain') ?? ''
    if (text.trim() !== held.text) return
    e.preventDefault()
    attach()
  })
  watchers.add(paint)
  paint()
  host?.prepend(node)
  return {
    node,
    ids: () => (attached.length ? attached.map(c => c.id) : undefined),
    /** The attached cards themselves, to keep them with a draft. */
    cards: () => attached.map(c => ({ ...c })),
    clear(sent = false) {
      const had = attached
      attached = []
      if (sent && had.some(c => c.id === held?.id)) clearCopied()
      paint()
      onChange?.()
    },
  }
}
