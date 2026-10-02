// Question rows, and the lists made of them: the inbox (every open question of every
// session, grouped by who is asking) and one session's own questions.
// Every row is the same height with its answer at the right edge, always in the same place:
// thumb down and thumb up for a two-way question, otherwise one wide "Choose", which unfolds
// the options below the row. Beside them a small arrow puts the question off: it leaves its
// sender's group for one group at the very end, so that working down the list comes to an end.
// The list can be worked down with the keyboard alone; answer one, the next stands in its place.

import { el, rich, agoNode, doodle, sketch, kindOf, tidyLinks, adviceLoop, cardNote } from './ui.js'
import { decide, putOff, sendMessage } from './store.js'
import { openLightbox } from './chat.js'
import { provide, hint, openSheet } from './keys.js'
import { say, pageHost, backUsedAt } from './back.js'

const RANK = { critical: 3, high: 2, normal: 1, low: 0 }
// What a starred session's rows are called. The word is not settled; it lives here alone.
export const VIP_LABEL = 'VIP'
// What "Explain" asks the session, about a card, in one tap.
export const EXPLAIN_TEXT = 'Explain this question in more detail and in plain words: what it is about, what each option means for me, and what you would do.'

// The one rule for a word under a thumb. A tile has room for two short lines; a label stands there
// only if it fits them whole, broken between words or after a hyphen, never inside a word.
// A label that needs more is not shrunk and not cut: its card is answered through "Choose",
// where every option has a line of its own.
const TILE_LINE = 14
export function fitsTile(label) {
  let lines = 1, used = 0
  for (const word of String(label).trim().replace(/-(?=\S)/g, '- ').split(/\s+/)) {
    if (word.length > TILE_LINE) return false
    if (used && used + 1 + word.length > TILE_LINE) { lines++; used = word.length } else used += (used ? 1 : 0) + word.length
  }
  return lines <= 2
}

// Answerable by thumb: a two-way question. Two options whose labels fit a tile, at most about
// three lines of text, and nothing attached beyond pictures, which the row shows.
const quick = card =>
  !card.multiple && (card.kind === 'permission' ||
  (card.options.length === 2 && card.options.every(o => fitsTile(o.label)) && (card.attachments ?? []).every(a => kindOf(a) === 'image') && (card.body ?? '').length <= 240))

// A plain yes or no needs no word under its thumb.
const BARE = /^(yes|no|ok|okay|allow|deny|ja|nein)$/i

// "Choose" unfolds a card in its row. A card with more than fits there comfortably opens as a
// window instead: a long text, code, several pictures, anything to play or download, many options.
const needsWindow = card =>
  (card.body ?? '').length > 480 || /```/.test(card.body ?? '') || card.options.length > 6 ||
  (card.attachments ?? []).filter(a => kindOf(a) === 'image').length > 1 || (card.attachments ?? []).some(a => kindOf(a) !== 'image')

// What the agent would pick: one option, or several where several are allowed.
const advised = (card, key) => [].concat(card.recommended ?? []).includes(key)

// Rows that stand unfolded, by card id: a list that is rebuilt keeps them open.
const unfolded = new Set()

// The body as one line of plain words; a link stands as what it is, never as its long address.
const plain = text => tidyLinks(String(text ?? '').replace(/```[\s\S]*?```/g, ' ')).replace(/[*`#]/g, '').replace(/\s+/g, ' ').trim()

/** A row in a list has a fixed height. A title that needs two lines leaves room for one
 *  line of text below it, a one-line title for two. Measured, because it depends on the
 *  width and on the font that finally loaded; whole lines only, never a cut one.
 *  Returns the observer a list hands to its rows; unobserve a row's title when the row goes. */
export const lineFit = () => new ResizeObserver(entries => {
  for (const { target } of entries) {
    if (!target.clientHeight) continue
    const two = target.clientHeight > parseFloat(getComputedStyle(target).lineHeight) * 1.5
    target.closest('.inbox-row')?.toggleAttribute('data-tall', two)
  }
})

// What "Choose" unfolds under a row: the text, every option as a tile, and a line to ask the
// agent back instead of answering. One tap on an option answers; where several answers are
// allowed the options are toggles and one tile sends them.
function unfoldNode(card, { onDecided }) {
  const box = el('div', 'inbox-more-in')
  if (card.body) box.append(rich(card.body))
  const error = el('p', 'inbox-error')
  error.hidden = true
  const options = el('div', 'inbox-options')
  const picked = new Set()
  const answer = async (keys, button) => {
    for (const other of options.children) other.disabled = true
    button.classList.add('is-picked')
    try {
      await decide(card.id, card.multiple ? keys : keys[0])
      unfolded.delete(card.id)
      const chosen = card.options.filter(o => keys.includes(o.key))
      if (card.kind === 'decision') onDecided?.(card, { key: keys[0], label: chosen.map(o => o.label).join(', ') })
    } catch (err) {
      for (const other of options.children) other.disabled = false
      button.classList.remove('is-picked')
      paintSend()
      error.textContent = `Not saved: ${err.message}`
      error.hidden = false
    }
  }
  const send = el('button', 'inbox-option inbox-send')
  send.type = 'button'
  const paintSend = () => {
    send.disabled = !picked.size
    send.replaceChildren(el('strong', null, picked.size ? `Send ${picked.size}` : 'Send'), el('span', null, picked.size ? 'your choice' : 'pick one or more'))
  }
  card.options.forEach((o, i) => {
    const b = el('button', 'inbox-option')
    b.type = 'button'
    b.dataset.key = o.key
    b.append(el('kbd', null, String(i + 1)), el('strong', null, o.label))
    if (o.detail) b.append(el('span', null, o.detail))
    if (advised(card, o.key)) { b.classList.add('is-advised'); b.title = 'The agent recommends this'; b.append(adviceLoop()) }
    if (card.multiple) {
      b.setAttribute('aria-pressed', 'false')
      b.addEventListener('click', () => {
        if (picked.has(o.key)) picked.delete(o.key)
        else picked.add(o.key)
        b.setAttribute('aria-pressed', String(picked.has(o.key)))
        paintSend()
      })
    } else b.addEventListener('click', () => answer([o.key], b))
    options.append(b)
  })
  if (card.multiple) {
    send.addEventListener('click', () => answer(card.options.map(o => o.key).filter(k => picked.has(k)), send))
    paintSend()
    options.append(send)
  }
  // Asking back: a message to the session, tied to this card. The card stays open and stays where it is;
  // only "Later" and "Explain" make it leave.
  const ask = el('form', 'inbox-askback')
  const field = el('input')
  field.type = 'text'
  field.placeholder = 'Ask back instead of answering'
  field.setAttribute('aria-label', 'Ask the agent about this question')
  field.autocomplete = 'off'
  const go = el('button', null, 'Ask back')
  go.type = 'submit'
  const said = el('span', 'inbox-asked')
  said.setAttribute('role', 'status')
  ask.append(field, go, said)
  ask.addEventListener('submit', async e => {
    e.preventDefault()
    const text = field.value.trim()
    if (!text) return field.focus()
    go.disabled = true
    try {
      await sendMessage(text, card.agent, card.id)
      field.value = ''
      said.textContent = 'Asked. The reply comes in the conversation.'
    } catch (err) {
      said.textContent = `Not sent: ${err.message}`
    }
    go.disabled = false
  })
  box.append(options, error, ask)
  return box
}

/** One question as a row.
 *  onOpen(cardId): open the card as a window of its own. onDecided(card, option): it was answered here.
 *  vip: the session is starred and nothing around the row says so (it stands among other sessions' rows),
 *  so the row carries the small golden tab itself.
 *  off: the card was put off. from: the session that asked, named on the
 *  row when nothing around it says so. fit: the list's lineFit(). */
export function questionRow(card, { onOpen, onDecided, vip = false, off = false, from = null, fit = null } = {}) {
  const node = el('article', 'inbox-row')
  node.tabIndex = -1   // the keyboard's mark puts the focus here, so Tab goes on from the marked row
  node.dataset.id = card.id
  node.dataset.urgency = card.urgency
  if (off) node.dataset.later = ''
  const error = el('p', 'inbox-error')
  error.hidden = true

  // Head: only what stands out gets a tab flush with the corner. A blocking question a red one,
  // an urgent one its own; a normal question none; one that can wait a small scribbled hourglass.
  const head = el('header', 'inbox-row-head')
  const blocking = card.kind === 'permission' || card.urgency === 'critical'
  if (blocking || card.urgency === 'high') {
    head.append(el('span', 'inbox-tab', blocking ? (card.kind === 'permission' ? 'Blocking · Permission' : 'Blocking') : 'Urgent'))
  } else if (card.urgency === 'low') {
    const mark = el('span', 'inbox-whenever')
    mark.title = 'Whenever: nothing waits on this'
    mark.setAttribute('role', 'img')
    mark.setAttribute('aria-label', 'Whenever')
    mark.append(sketch('whenever'))
    head.append(mark)
  }
  if (vip) head.append(el('span', 'inbox-vip', VIP_LABEL))
  if (from) {
    const who = el('span', 'inbox-from')
    who.append(doodle(from.mark ?? from.id), el('span', null, from.name))
    head.append(who)
  }
  head.append(agoNode(card.created, 'inbox-ago'))

  const text = el('button', 'inbox-text')
  text.type = 'button'
  // The number is for looking a card up, not for reading along.
  text.title = `Question ${card.number}: open it as a window`
  const rest = [cardNote(card), card.urgency_reason, plain(card.body)].filter(Boolean).join(' · ')
  const title = el('strong', 'inbox-question', card.title)
  text.append(title)
  if (rest) text.append(el('span', 'inbox-body', rest))
  text.addEventListener('click', () => onOpen?.(card.id))
  const content = el('div', 'inbox-content')
  content.append(head, text, error)
  fit?.observe(title)
  node.append(content)

  // One small picture stands for all of them; it opens large on tap, without leaving the list.
  const images = (card.attachments ?? []).filter(a => kindOf(a) === 'image')
  if (images.length) {
    const thumb = el('button', 'inbox-thumb')
    thumb.type = 'button'
    thumb.setAttribute('aria-label', images.length === 1 ? `Enlarge ${images[0].name}` : `Look at ${images.length} pictures`)
    const img = el('img')
    img.src = images[0].url
    img.alt = ''
    img.loading = 'lazy'
    img.addEventListener('error', () => thumb.remove())
    thumb.append(img)
    if (images.length > 1) thumb.append(el('b', null, String(images.length)))
    thumb.addEventListener('click', () => openLightbox(images, 0))
    node.append(thumb)
  }

  // Later is always possible: a small tag with a scribbled arrow that hangs over the row's bottom
  // edge and pushes the question down to the end of the list. From there the same tag fetches it back.
  const later = el('button', 'inbox-later')
  later.type = 'button'
  // No tooltip (it would lie over the next row): the word slides out of the tag on hover and focus.
  later.setAttribute('aria-label', off ? 'Fetch back' : 'Later: push this question down')
  later.append(sketch(off ? 'back' : 'later'), el('span', null, off ? 'Fetch back' : 'Later'))
  later.addEventListener('click', () => {
    putOff(card.id, !off)
    // Say where it went, with the way back.
    if (!off) say(pageHost(), { head: 'Moved to Later', title: card.title, back: async () => putOff(card.id, false) })
  })
  hint(later, 'list.later')

  const actions = el('div', 'inbox-actions')
  const tile = (cls, kind, label, act) => {
    const b = el('button', `inbox-answer ${cls}`)
    b.type = 'button'
    const disc = el('span', 'inbox-disc')
    disc.append(sketch(kind))
    b.append(disc)
    if (label) b.append(el('span', null, label))
    b.addEventListener('click', act)
    return b
  }
  node.append(later, actions)
  if (quick(card)) {
    // Thumbs are the rule: down on the left, up on the right, on every card. The option the agent
    // leads with (its first, or "allow") is the up. The option's own word stands under its thumb
    // only when the pair says more than yes and no.
    const isYes = o => (card.kind === 'permission' ? o.key === 'allow' : o === card.options[0])
    const options = [...card.options].sort((a, b) => isYes(a) - isYes(b))
    const bare = card.options.every(o => BARE.test(o.label.trim()))
    for (const o of options) {
      const lead = isYes(o)
      const b = tile(lead ? 'is-thumb is-lead' : 'is-thumb', lead ? 'yes' : 'no', bare ? '' : o.label, async () => {
        for (const other of actions.children) other.disabled = true
        b.classList.add('is-picked')
        try {
          await decide(card.id, o.key)
          if (card.kind === 'decision') onDecided?.(card, o)
        } catch (err) {
          for (const other of actions.children) other.disabled = false
          b.classList.remove('is-picked')
          error.textContent = `Not saved: ${err.message}`
          error.hidden = false
        }
      })
      b.setAttribute('aria-label', o.label)
      hint(b, lead ? 'list.yes' : 'list.no')
      if (o.detail) b.title = o.detail
      if (advised(card, o.key)) { b.classList.add('is-advised'); b.title = 'The agent recommends this'; b.append(adviceLoop()) }
      actions.append(b)
    }
  } else {
    // More than two ways: one wide tile. The row unfolds downward with its options, and folds
    // again on a second tap or Escape. Only a card with too much for that opens as a window.
    const inline = !needsWindow(card)
    const more = el('div', 'inbox-more')
    const clip = el('div', 'inbox-more-clip')
    more.append(clip)
    const count = card.multiple ? `${card.options.length} options, several allowed` : `${card.options.length} options`
    const choose = tile('is-wide is-lead', 'choose', 'Choose', () => (inline ? unfold(!node.classList.contains('is-open')) : onOpen?.(card.id)))
    choose.append(el('small', null, count))
    hint(choose, 'list.open')
    const unfold = open => {
      if (open && !clip.firstChild) clip.append(unfoldNode(card, { onDecided }))   // built on first use
      node.classList.toggle('is-open', open)
      choose.setAttribute('aria-expanded', String(open))
      clip.inert = !open
      if (open) unfolded.add(card.id)
      else unfolded.delete(card.id)
    }
    actions.append(choose)
    if (inline) {
      node.append(more)
      unfold(unfolded.has(card.id))
      node.addEventListener('keydown', e => {
        if (e.key !== 'Escape' || !node.classList.contains('is-open')) return
        e.stopPropagation()
        unfold(false)
        choose.focus()
      })
    }
  }
  return node
}

const rowSig = (card, opts) => JSON.stringify([card.revised, card.urgency, card.urgency_reason, card.title, card.body, card.options, card.recommended, card.multiple, card.attachments?.length, opts.vip, opts.off, opts.from && [opts.from.name, opts.from.mark]])

/** A list of question rows in root.
 *  onOpen(cardId | null): open that card as a window, or with null walk through all of them there.
 *  onDecided(card, option): a question was answered in the list; the page offers to take it back.
 *  (Nothing is added to the list for that: the next row has to land where the answered one was.)
 *  With agent (a session id) it lists only that session's questions, without the big heading.
 *  Returns { render(state) }. */
export function mountInbox(root, { onOpen, onDecided, agent = null }) {
  let signature = ''
  const head = el('header', 'inbox-head')
  const list = el('div', 'inbox-groups')
  root.append(head, list)
  const fit = lineFit()
  const rows = new Map()   // card id -> { sig, node }; an unchanged card keeps its node, so nothing flickers
  const cards = new Map()  // card id -> the card, for what the keys do with the marked row
  const row = (card, opts = {}) => {
    const sig = rowSig(card, opts)
    const cached = rows.get(card.id)
    if (cached?.sig === sig) return cached.node
    if (cached) fit.unobserve(cached.node.querySelector('.inbox-question'))
    const node = questionRow(card, { onOpen, onDecided, fit, ...opts })
    cards.set(card.id, card)
    rows.set(card.id, { sig, node })
    return node
  }

  // ---- a row that left, and one that comes back ----
  // What happened to a question that left is said by the note at the top left (back.js), which also
  // takes it back. The list does its part: the row that left goes with a motion that shows where to,
  // and a row that "Back" returned is brought into view, and marked if the keyboard is in use.
  const away = new Map()   // card id -> when its row left the open rows
  // Something went wrong with no row to say it on: one line under the page's title.
  function error(text) {
    const line = el('p', 'inbox-error', text)
    line.setAttribute('role', 'alert')
    head.append(line)
    setTimeout(() => line.remove(), 5000)
  }

  // ---- the row the keyboard is on ----
  let current = null   // { id, index, off }
  const nodes = () => [...list.querySelectorAll('.inbox-row:not(.is-leaving)')]
  // Bring a row wholly into view: with its sender's heading if it is the first of its group, with the
  // tag that hangs below its edge, and with the page's own title if it is the very first row.
  function reveal(node, smooth = true) {
    let box = node.parentElement
    while (box && box !== document.body && !/auto|scroll/.test(getComputedStyle(box).overflowY)) box = box.parentElement
    if (!box || box === document.body) return node.scrollIntoView({ block: 'nearest' })
    const frame = box.getBoundingClientRect()
    // A step glides; a jump (Home, End, a held key) is there at once. Always to a place, never by an
    // amount: a step taken while the last one still glides would otherwise add up.
    const go = to => box.scrollTo({ top: to, behavior: smooth && Math.abs(to - box.scrollTop) < frame.height && !matchMedia('(prefers-reduced-motion: reduce)').matches ? 'smooth' : 'instant' })
    if (node === nodes()[0] && box.contains(head)) return go(0)
    const lead = node.previousElementSibling?.matches('.inbox-sender') ? node.previousElementSibling : node
    const top = lead.getBoundingClientRect().top - 16 - frame.top
    const bottom = node.getBoundingClientRect().bottom + 24 - frame.bottom
    // Too far up: down to it. Too far down: up, but never so far that its top leaves.
    const by = top < 0 ? top : bottom > 0 ? Math.min(bottom, top) : 0
    if (by) go(box.scrollTop + by)
  }
  function mark(node, scroll = true, smooth = true) {
    for (const n of list.querySelectorAll('.is-current')) if (n !== node) { n.classList.remove('is-current'); n.removeAttribute('aria-current') }
    if (!node) { current = null; return }
    node.classList.add('is-current')
    node.setAttribute('aria-current', 'true')
    current = { id: node.dataset.id, index: nodes().indexOf(node), off: 'later' in node.dataset }
    // The keyboard's own place follows the mark, unless it is busy elsewhere (a field, the sidebar).
    const at = document.activeElement
    if (!at || at === document.body || (list.contains(at) && !node.contains(at))) node.focus({ preventScroll: true })
    if (scroll) reveal(node, smooth)
  }

  function render(state) {
    const all = state.all
    const agents = agent ? all.agents.filter(a => a.id === agent) : all.agents
    const byId = new Map(all.cards.map(c => [c.id, c]))
    const open = all.queue.map(id => byId.get(id)).filter(c => c && (!agent || c.agent === agent))
    const off = state.later.map(id => open.find(c => c.id === id)).filter(Boolean)
    const fresh = open.filter(c => !off.includes(c))
    const next = JSON.stringify([off.map(c => c.id), open.map(c => [c.id, c.revised, c.urgency, c.urgency_reason, c.title, c.body, c.options, c.recommended, c.multiple, c.attachments?.length]), agents.map(a => [a.id, a.name, a.mark, a.starred])])
    if (next === signature) return
    signature = next

    // The number counts what is still to be worked down; what was put off is counted at its own group.
    const title = el('div', 'inbox-title')
    const line = el('p')
    if (fresh.length) line.append(el('span', 'inbox-circled', String(fresh.length)), fresh.length === 1 ? ' question needs you.' : ' questions need you.')
    else line.append(off.length ? 'Nothing new. What you put off is below.' : 'Nothing needs you.')
    // A session's pane already carries its name as the title; the inbox has its own.
    if (agent) title.append(line)
    else title.append(el('h2', null, 'Inbox'), line)
    head.replaceChildren(...(agent && !open.length ? [] : [title]))
    if (fresh.length > 1 && !agent) {
      // Working down the list happens in the list: the first row is marked, and the keys take over.
      const go = el('button', 'inbox-go', 'Go through them')
      go.type = 'button'
      // The button shows the questions one after the other in the big window: answer or Later, and the next one comes.
      // Working down the list itself stays with the keys (arrows, then the letters).
      go.addEventListener('click', () => { go.blur(); onOpen?.(null) })
      // Which keys: the sheet of all keys, behind a "?" (the key "?" opens it too).
      const help = el('button', 'inbox-keys-toggle', '?')
      help.type = 'button'
      help.title = 'Keys (?)'
      help.setAttribute('aria-label', 'Keys: what the keyboard does here')
      help.setAttribute('aria-haspopup', 'dialog')
      help.addEventListener('click', () => openSheet())
      const tools = el('div', 'inbox-tools')
      tools.append(help, go)
      head.append(tools)
    }

    // One group per sender. Starred sessions come first, then whoever has the most urgent question.
    const top = cards => Math.max(...cards.map(c => RANK[c.urgency] ?? 1))
    const groups = agents
      .map(a => ({ agent: a, cards: fresh.filter(c => c.agent === a.id) }))
      .filter(g => g.cards.length)
      .sort((a, b) => Boolean(b.agent.starred) - Boolean(a.agent.starred) || top(b.cards) - top(a.cards))

    // Remember where every row was, so that after an answer the rest slides up instead of jumping.
    const before = new Map(nodes().map(n => [n.dataset.id, n.getBoundingClientRect().top]))
    const old = nodes().map(n => ({ node: n, id: n.dataset.id, off: 'later' in n.dataset, box: n.getBoundingClientRect() }))
    // Rebuilding moves every row out of the list and back. A row or a control that holds the keyboard
    // would lose it on the way, and Chromium then lays the emptied list out and scrolls it to its top:
    // let go before the first row moves, and take the keyboard up again below.
    const held = list.contains(document.activeElement) ? document.activeElement : null
    held?.blur()
    const parts = []
    for (const { agent: sender, cards } of groups) {
      const section = el('section', 'inbox-group')
      if (!agent) {
        const label = el('h3', 'inbox-sender')
        const avatar = el('span', 'inbox-avatar')
        avatar.append(doodle(sender.mark ?? sender.id))
        label.append(avatar, el('span', null, sender.name))
        // A starred session is marked once, here; its rows below stay plain.
        if (sender.starred) { label.dataset.vip = ''; label.append(el('span', 'inbox-vip', VIP_LABEL)) }
        label.append(el('b', null, cards.length === 1 ? '1 question' : `${cards.length} questions`))
        section.append(label)
      }
      section.append(...cards.map(c => row(c)))
      parts.push(section)
    }
    // Put off: one group below all senders, in the order the cards were put off. Its heading is dashed,
    // because the group is provisional. Each row says who asked, since it no longer stands under its sender.
    if (off.length) {
      const section = el('section', 'inbox-group inbox-group-later')
      const label = el('h3', 'inbox-sender')
      const avatar = el('span', 'inbox-avatar')
      avatar.append(sketch('later'))
      label.append(avatar, el('span', null, 'Later'), el('b', null, `${off.length} put off`))
      section.append(label, ...off.map(c => {
        const sender = all.agents.find(a => a.id === c.agent)
        return row(c, { off: true, vip: Boolean(!agent && sender?.starred), from: agent ? null : sender })
      }))
      parts.push(section)
    }
    if (!open.length) parts.push(el('p', 'inbox-empty', agent ? 'This session has no question for you right now.' : 'As soon as an agent has a question, it shows up here.'))
    list.replaceChildren(...parts)
    for (const [id, { node }] of rows) {
      if (node.isConnected) continue
      fit.unobserve(node.querySelector('.inbox-question'))
      rows.delete(id)
      cards.delete(id)
    }

    // Rows that left the open ones, and one that "Back" has just returned.
    const now = Date.now()
    const openNow = new Set(fresh.map(c => c.id))
    let returned = null
    for (const { id, off: wasOff } of old) if (!wasOff && !openNow.has(id)) away.set(id, now)
    for (const [id, at] of away) {
      if (openNow.has(id)) { if (now - backUsedAt() < 4000) returned = nodes().find(n => n.dataset.id === id) ?? null; away.delete(id) }
      else if (now - at > 60000) away.delete(id)
    }
    // The row that left stays a moment as a ghost in its old place and goes: an answered one off to
    // the side, one that was put off down towards "Later". Nothing can be pressed on it, and it is no row any more.
    const leavers = signature && shown() ? old.filter(o => !o.node.isConnected && !o.off && !openNow.has(o.id)) : []
    const frame = leavers.length ? list.getBoundingClientRect() : null
    for (const { node, id, box } of leavers) {
      node.classList.remove('is-current', 'is-open')
      node.classList.add('is-leaving')
      node.dataset.leave = off.some(c => c.id === id) ? 'later' : 'answered'
      node.removeAttribute('data-id')
      node.inert = true
      Object.assign(node.style, { left: `${box.left - frame.left}px`, top: `${box.top - frame.top}px`, width: `${box.width}px`, height: `${box.height}px` })
      list.append(node)
      setTimeout(() => node.remove(), 340)
    }
    // The marked row was answered or put off: the mark stays in its place, on the row that moved up.
    if (current) {
      const now = nodes()
      const same = now.find(n => n.dataset.id === current.id)
      if (same && 'later' in same.dataset === current.off) mark(same, false)
      // The mark changed rows: where the list got shorter, the row it is on now may be out of sight.
      else { mark(now[Math.min(current.index, now.length - 1)] ?? null, false); if (current && shown()) reveal(now[current.index], false) }
    }
    // A field or button that was in use keeps the keyboard; a row gives it to the row that is marked now.
    if (held?.isConnected && !held.matches('.inbox-row') && !held.closest('[inert]')) held.focus({ preventScroll: true })
    if (returned && shown()) {
      if (current) mark(returned, true, false)
      else { reveal(returned, false); returned.animate([{ outline: '3px solid var(--fg)', outlineOffset: '3px' }, { outline: '3px solid transparent', outlineOffset: '3px' }], { duration: 1400 }) }
    }
    if (before.size && !matchMedia('(prefers-reduced-motion: reduce)').matches) {
      for (const node of nodes()) {
        const was = before.get(node.dataset.id)
        const moved = was == null ? 0 : was - node.getBoundingClientRect().top
        // Where a row is on its way out, the others wait a moment before they move up into its place.
        if (moved) node.animate([{ translate: `0 ${moved}px` }, { translate: '0 0' }], { duration: 320, delay: leavers.length ? 140 : 0, fill: 'backwards', easing: 'cubic-bezier(.25, 1.4, .5, 1)' })
      }
    }
  }

  // ---- keys: work down the list without the mouse ----
  // J/K or the arrows pick a row; from then on the letters act on it. Which keys, and that they
  // rest in a field or under a dialog, is the business of keys.js; here is what they do.
  // Of sessions side by side, the list of the one that is picked listens.
  const shown = () => !root.closest('.chat-pane:not(.is-member)') && (list.checkVisibility ? list.checkVisibility({ visibilityProperty: true }) : list.offsetParent !== null)
  const here = () => (current && nodes().find(n => n.dataset.id === current.id)) || null
  // With no row marked yet, start at the first one that is in sight.
  const firstInSight = all => all.find(n => n.getBoundingClientRect().top >= (root.closest('main, .pane-list')?.getBoundingClientRect().top ?? 0)) ?? all[0]
  const move = (to, edge = false) => (_, e) => {
    const all = nodes()
    if (!all.length) return false
    const at = all.indexOf(here())
    mark(at < 0 && !edge ? firstInSight(all) : all[Math.max(0, Math.min(all.length - 1, to(at, all.length)))], true, !e?.repeat)
  }
  // A letter acts on the marked row. With none marked it marks one and does nothing else:
  // nothing is answered that was not pointed at first.
  const onRow = act => (arg, e) => {
    const all = nodes()
    if (!all.length) return false
    const node = here()
    if (!node) { mark(firstInSight(all)); return true }
    return act(node, arg, e)
  }
  const marked = act => (arg, e) => { const node = here(); return node ? act(node, arg, e) : false }
  const press = button => { if (!button || button.disabled) return false; button.click(); return true }
  const isOpen = node => node.classList.contains('is-open')
  const optionsOf = node => [...node.querySelectorAll('.inbox-option:not(:disabled)')]
  // Is the keyboard free for this row: nowhere in particular, or inside the row itself.
  const mine = node => { const at = document.activeElement; return !at || at === document.body || node.contains(at) }
  const toOption = node => { const all = optionsOf(node); (all.find(b => b.classList.contains('is-advised')) ?? all[0])?.focus({ preventScroll: true }) }
  const stepOption = by => marked(node => {
    const all = optionsOf(node)
    if (!isOpen(node) || !all.length || !mine(node)) return false
    const at = all.indexOf(document.activeElement)
    all[at < 0 ? (by > 0 ? 0 : all.length - 1) : (at + by + all.length) % all.length].focus()
  })
  provide('list', {
    active: shown,
    actions: {
      'list.next': move(at => at + 1),
      'list.prev': move(at => at - 1),
      'list.first': move(() => 0, true),
      'list.last': move((_, n) => n - 1, true),
      'list.option.next': stepOption(1),
      'list.option.prev': stepOption(-1),
      'list.yes': onRow(node => press(node.querySelectorAll('.inbox-answer.is-thumb')[1])),
      'list.no': onRow(node => press(node.querySelectorAll('.inbox-answer.is-thumb')[0])),
      'list.later': onRow(node => press(node.querySelector('.inbox-later'))),
      // Several answers allowed: Enter sends what is picked, and never toggles the option in focus.
      'list.send': marked(node => {
        const send = node.querySelector('.inbox-send')
        if (!send || !isOpen(node) || !mine(node)) return false
        if (!send.disabled) send.click()
      }),
      // The choices in the row, or the whole question as a window where there is too much for a row.
      'list.open': onRow(node => {
        const choose = node.querySelector('.inbox-answer.is-wide')
        if (!choose) { onOpen?.(node.dataset.id); return true }
        if (!press(choose)) return false
        // Unfolded, the row is taller: once it has grown, bring all of it into view.
        if (isOpen(node)) { toOption(node); setTimeout(() => { if (node.isConnected && isOpen(node)) reveal(node) }, 280) }
        else if (node.isConnected) node.focus({ preventScroll: true })
      }),
      'list.pick': marked((node, n) => (isOpen(node) ? press(node.querySelectorAll('.inbox-option[data-key]')[n - 1]) : false)),
      // Ask back: the line under the choices; a row without choices opens as a window, with that line ready.
      'list.ask': onRow(node => {
        const choose = node.querySelector('.inbox-answer.is-wide')
        if (!node.querySelector('.inbox-more')) { onOpen?.(node.dataset.id, { ask: true }); return true }
        if (!isOpen(node)) choose.click()
        node.querySelector('.inbox-askback input')?.focus({ preventScroll: true })
        reveal(node)
      }),
      // Explain: first everything the card holds (the unfolded row, or its window), then the question to the session.
      'list.explain': onRow(node => {
        const card = cards.get(node.dataset.id)
        if (!card || card.kind === 'permission') return false
        if (!node.querySelector('.inbox-more')) { onOpen?.(card.id); return true }
        if (!isOpen(node)) { node.querySelector('.inbox-answer.is-wide').click(); toOption(node); return true }
        sendMessage(EXPLAIN_TEXT, card.agent, card.id).then(() => {
          putOff(card.id, true, true)
          say(pageHost(), { head: 'Asked to explain', title: 'It comes back with the answer.', back: async () => putOff(card.id, false) })
        }, err => error(`Not asked: ${err.message}`))
      }),
      'list.leave': marked(node => {
        if (isOpen(node)) { node.querySelector('.inbox-answer.is-wide').click(); node.focus({ preventScroll: true }); return true }
        mark(null)
        if (node === document.activeElement) node.blur()
      }),
    },
  })
  // A row that is touched takes the mark along, once the keyboard has set one.
  list.addEventListener('pointerdown', e => {
    const node = e.target.closest('.inbox-row')
    if (current && node) mark(node, false)
  })

  return { render }
}
