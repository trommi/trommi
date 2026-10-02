// Question rows, and the lists made of them: the inbox (every open question of every
// session, grouped by who is asking) and one session's own questions.
// Every row is the same height with its answer at the right edge, always in the same place:
// thumb down and thumb up for a two-way question, otherwise one wide "Choose", which unfolds
// the options below the row. Beside them a small arrow puts the question off: it leaves its
// sender's group for one group at the very end, so that working down the list comes to an end.
// The list can be worked down with the keyboard alone; answer one, the next stands in its place.

import { el, rich, agoNode, doodle, sketch, kindOf } from './ui.js'
import { decide, putOff, sendMessage } from './store.js'
import { openLightbox } from './chat.js'

const RANK = { critical: 3, high: 2, normal: 1, low: 0 }
// What a starred session's rows are called. The word is not settled; it lives here alone.
export const VIP_LABEL = 'VIP'

// Answerable by thumb: a two-way question. Two options with labels short enough for a tile,
// at most about three lines of text, and nothing attached beyond pictures, which the row shows.
const quick = card =>
  !card.multiple && (card.kind === 'permission' ||
  (card.options.length === 2 && card.options.every(o => o.label.length <= 18) && (card.attachments ?? []).every(a => kindOf(a) === 'image') && (card.body ?? '').length <= 240))

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

const plain = text => String(text ?? '').replace(/```[\s\S]*?```/g, ' ').replace(/[*`#]/g, '').replace(/\s+/g, ' ').trim()

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
    if (advised(card, o.key)) { b.classList.add('is-advised'); b.title = 'The agent recommends this' }
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
  // Asking back: a message to the session, tied to this card. The card stays open.
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
 *  vip: the session is starred. off: the card was put off. from: the session that asked, named on the
 *  row when nothing around it says so. fit: the list's lineFit(). */
export function questionRow(card, { onOpen, onDecided, vip = false, off = false, from = null, fit = null } = {}) {
  const node = el('article', 'inbox-row')
  node.dataset.id = card.id
  node.dataset.urgency = card.urgency
  if (off) node.dataset.later = ''
  if (vip) node.dataset.vip = ''
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
  const rest = [card.urgency_reason, plain(card.body)].filter(Boolean).join(' · ')
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

  // Later is always possible: a small arrow that pushes the question down to the end of the list.
  // From there the same place fetches it back.
  const later = el('button', 'inbox-later')
  later.type = 'button'
  later.title = off ? 'Fetch back (L)' : 'Later: push this down (L)'
  later.setAttribute('aria-label', off ? 'Fetch back' : 'Later')
  later.append(sketch(off ? 'back' : 'later'))
  later.addEventListener('click', () => putOff(card.id, !off))

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
      if (o.detail) b.title = o.detail
      if (advised(card, o.key)) { b.classList.add('is-advised'); b.title = 'The agent recommends this' }
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

const rowSig = (card, opts) => JSON.stringify([card.urgency, card.urgency_reason, card.title, card.body, card.options, card.recommended, card.multiple, card.attachments?.length, opts.vip, opts.off, opts.from && [opts.from.name, opts.from.mark]])

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
  const row = (card, opts) => {
    const sig = rowSig(card, opts)
    const cached = rows.get(card.id)
    if (cached?.sig === sig) return cached.node
    if (cached) fit.unobserve(cached.node.querySelector('.inbox-question'))
    const node = questionRow(card, { onOpen, onDecided, fit, ...opts })
    rows.set(card.id, { sig, node })
    return node
  }

  // ---- the row the keyboard is on ----
  let current = null   // { id, index, off }
  const nodes = () => [...list.querySelectorAll('.inbox-row')]
  function mark(node, scroll = true) {
    for (const n of list.querySelectorAll('.is-current')) if (n !== node) n.classList.remove('is-current')
    if (!node) { current = null; return }
    node.classList.add('is-current')
    current = { id: node.dataset.id, index: nodes().indexOf(node), off: 'later' in node.dataset }
    if (scroll) node.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
  }

  function render(state) {
    const all = state.all
    const agents = agent ? all.agents.filter(a => a.id === agent) : all.agents
    const byId = new Map(all.cards.map(c => [c.id, c]))
    const open = all.queue.map(id => byId.get(id)).filter(c => c && (!agent || c.agent === agent))
    const off = state.later.map(id => open.find(c => c.id === id)).filter(Boolean)
    const fresh = open.filter(c => !off.includes(c))
    const next = JSON.stringify([off.map(c => c.id), open.map(c => [c.id, c.urgency, c.urgency_reason, c.title, c.body, c.options, c.recommended, c.multiple, c.attachments?.length]), agents.map(a => [a.id, a.name, a.mark, a.starred])])
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
      go.addEventListener('click', () => { mark(nodes()[0]); go.blur() })
      head.append(go)
      title.append(el('p', 'inbox-keys', 'With the keyboard: ↑ and ↓ move, Y or → is yes, N or ← is no, L puts a question off, C or Enter opens the choices, a digit picks one, U takes the last answer back.'))
    }

    // One group per sender. Starred sessions come first, then whoever has the most urgent question.
    const top = cards => Math.max(...cards.map(c => RANK[c.urgency] ?? 1))
    const groups = agents
      .map(a => ({ agent: a, cards: fresh.filter(c => c.agent === a.id) }))
      .filter(g => g.cards.length)
      .sort((a, b) => Boolean(b.agent.starred) - Boolean(a.agent.starred) || top(b.cards) - top(a.cards))

    // Remember where every row was, so that after an answer the rest slides up instead of jumping.
    const before = new Map(nodes().map(n => [n.dataset.id, n.getBoundingClientRect().top]))
    const parts = []
    for (const { agent: sender, cards } of groups) {
      const section = el('section', 'inbox-group')
      if (!agent) {
        const label = el('h3', 'inbox-sender')
        const avatar = el('span', 'inbox-avatar')
        avatar.append(doodle(sender.mark ?? sender.id))
        label.append(avatar, el('span', null, sender.name), el('b', null, cards.length === 1 ? '1 question' : `${cards.length} questions`))
        section.append(label)
      }
      section.append(...cards.map(c => row(c, { vip: Boolean(sender.starred) })))
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
        return row(c, { off: true, vip: Boolean(sender?.starred), from: agent ? null : sender })
      }))
      parts.push(section)
    }
    if (!open.length) parts.push(el('p', 'inbox-empty', agent ? 'This session has no question for you right now.' : 'As soon as an agent has a question, it shows up here.'))
    list.replaceChildren(...parts)
    for (const [id, { node }] of rows) {
      if (node.isConnected) continue
      fit.unobserve(node.querySelector('.inbox-question'))
      rows.delete(id)
    }

    // The marked row was answered or put off: the mark stays in its place, on the row that moved up.
    if (current) {
      const now = nodes()
      const same = now.find(n => n.dataset.id === current.id)
      if (same && 'later' in same.dataset === current.off) mark(same, false)
      else mark(now[Math.min(current.index, now.length - 1)] ?? null, false)
    }
    if (before.size && !matchMedia('(prefers-reduced-motion: reduce)').matches) {
      for (const node of nodes()) {
        const was = before.get(node.dataset.id)
        const moved = was == null ? 0 : was - node.getBoundingClientRect().top
        if (moved) node.animate([{ translate: `0 ${moved}px` }, { translate: '0 0' }], { duration: 320, easing: 'cubic-bezier(.25, 1.4, .5, 1)' })
      }
    }
  }

  // ---- keys: work down the list without the mouse ----
  // The arrows (or "Go through them") pick a row; from then on the letters act on it.
  // Of sessions side by side, the list of the one that is picked listens.
  const shown = () => !root.closest('.chat-pane:not(.is-member)') && (list.checkVisibility ? list.checkVisibility({ visibilityProperty: true }) : list.offsetParent !== null)
  document.addEventListener('keydown', e => {
    if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return
    const t = document.activeElement
    if (t && (/^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) || t.isContentEditable)) return
    if (document.querySelector('dialog[open], .focus:not([hidden])') || !shown()) return
    // Enter on a button is that button's.
    if (e.key === 'Enter' && t && /^(BUTTON|A|SUMMARY)$/.test(t.tagName)) return
    const all = nodes()
    if (!all.length) return
    const key = e.key.length === 1 ? e.key.toLowerCase() : e.key
    const here = current && all.find(n => n.dataset.id === current.id)
    const done = () => { e.preventDefault(); e.stopPropagation() }
    if (key === 'ArrowDown' || key === 'ArrowUp') {
      done()
      return mark(here ? all[Math.max(0, Math.min(all.length - 1, all.indexOf(here) + (key === 'ArrowDown' ? 1 : -1)))] : all[0])
    }
    if (!here) return
    const press = node => { if (node && !node.disabled) { done(); node.click() } }
    const thumbs = here.querySelectorAll('.inbox-answer.is-thumb')
    const open = here.classList.contains('is-open')
    if (key === 'Escape' && !open) { done(); return mark(null) }
    if (key === 'y' || key === 'ArrowRight') return press(thumbs[1])
    if (key === 'n' || key === 'ArrowLeft') return press(thumbs[0])
    if (key === 'l') return press(here.querySelector('.inbox-later'))
    if (key === 'Enter' && open && here.querySelector('.inbox-send:not(:disabled)')) return press(here.querySelector('.inbox-send'))
    if (key === 'c' || key === 'Enter') return press(here.querySelector('.inbox-answer.is-wide'))
    if (open && /^[1-9]$/.test(key)) return press(here.querySelectorAll('.inbox-option[data-key]')[Number(key) - 1])
  }, true)
  // A row that is touched takes the mark along, once the keyboard has set one.
  list.addEventListener('pointerdown', e => {
    const node = e.target.closest('.inbox-row')
    if (current && node) mark(node, false)
  })

  return { render }
}
