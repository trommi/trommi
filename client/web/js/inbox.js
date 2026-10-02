// The inbox: every open decision of every session, grouped by who is asking.
// Every row is the same height with two tiles at its right edge: no and yes
// for a yes/no question, otherwise "later" and "more", which opens the options.
// A card put off with "later" leaves its sender's group for one group at the
// very end, so that working down the list comes to an end.

import { el, agoNode, URGENCY_LABEL, doodle, kindOf } from './ui.js'
import { decide, putOff } from './store.js'
import { openLightbox } from './chat.js'

const RANK = { critical: 3, high: 2, normal: 1, low: 0 }

// Answerable in the list: a yes/no kind of question. Two options with labels
// short enough for a button, at most about three lines of text, and nothing
// attached beyond pictures, which the row shows. Everything else opens.
const quick = card =>
  card.kind === 'permission' ||
  (card.options.length === 2 && card.options.every(o => o.label.length <= 18) && (card.attachments ?? []).every(a => kindOf(a) === 'image') && (card.body ?? '').length <= 240)

// Hand-drawn icons for the answer tiles, in the spirit of a thumbs-up and thumbs-down.
const TILE_ICON = {
  yes: 'M7.200 11.200 10.400 4.700c1.500-.2 2.300.9 2.100 2.300l-.5 3h4.700c1.300 0 2.100 1.100 1.800 2.300l-1.200 5c-.3 1.100-1.100 1.700-2.200 1.700H7.300M7.200 11v8.100H4.600V11z',
  no: 'M16.800 12.800 13.600 19.300c-1.500.2-2.300-.9-2.100-2.300l.5-3H7.300c-1.300 0-2.100-1.100-1.800-2.300l1.200-5c.3-1.100 1.100-1.700 2.200-1.700h7.800M16.800 13V4.900h2.600V13z',
  other: 'M5 9.500h11.500l-3.200-3.300M19 14.500H7.500l3.200 3.300',
  open: 'M4.500 7.200h15M4.500 12h15M4.500 16.800h9.500',
  later: 'M12 5v12.500M6.500 12.500 12 18l5.500-5.500M5 20.500h14',
  back: 'M12 19V6.500M6.500 11.500 12 6l5.500 5.500M5 3.500h14',
}
const NEGATIVE = /^(nein|nicht|noch nicht|später|ablehnen|lassen|weglassen|behalten|nur |abbrechen|bei .* bleiben)/i
function tileIcon(kind) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  svg.setAttribute('viewBox', '0 0 24 24')
  svg.setAttribute('aria-hidden', 'true')
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path')
  path.setAttribute('d', TILE_ICON[kind])
  svg.append(path)
  return svg
}

const plain = text => String(text ?? '').replace(/```[\s\S]*?```/g, ' ').replace(/[*`#]/g, '').replace(/\s+/g, ' ').trim()

/** onOpen(cardId | null): open that card as a full page, or with null start at the most urgent one.
 *  onDecided(card, option): a decision was answered in the list; the page offers to take it back.
 *  (Nothing is added to the list for that: the next row has to land where the answered one was.)
 *  With session: true it lists only the session in scope, in the same rows.
 *  Returns { render(state) }. */
export function mountInbox(root, { onOpen, onDecided, session = false }) {
  let signature = ''
  const head = el('header', 'inbox-head')
  const list = el('div', 'inbox-groups')
  root.append(head, list)

  // A row in the list has a fixed height. A title that needs two lines leaves room for one
  // line of text below it, a one-line title for two. Measured, because it depends on the
  // width and on the font that finally loaded; whole lines only, never a cut one.
  const fit = new ResizeObserver(entries => {
    for (const { target } of entries) {
      if (!target.clientHeight) continue
      const two = target.clientHeight > parseFloat(getComputedStyle(target).lineHeight) * 1.5
      target.closest('.inbox-row')?.toggleAttribute('data-tall', two)
    }
  })

  /** from: the session that asked, named on the row when it no longer stands under its sender. */
  function row(card, { vip = false, off = false, from = null } = {}) {
    const node = el('article', 'inbox-row')
    node.dataset.id = card.id
    node.dataset.urgency = card.urgency
    if (off) node.dataset.later = ''
    const error = el('p', 'inbox-error')
    error.hidden = true

    // Head: the tab strip flush with the corner, then who asked (if it is not said above), then the age.
    const head = el('header', 'inbox-row-head')
    const tab = el('span', 'inbox-tab')
    tab.append(el('span', null, `Nr. ${card.number}`), el('span', null, card.kind === 'permission' ? 'Freigabe' : URGENCY_LABEL[card.urgency] ?? ''))
    if (vip) tab.append(el('span', 'inbox-vip', '★ VIP'))
    head.append(tab)
    if (from) {
      const who = el('span', 'inbox-from')
      who.append(doodle(from.mark ?? from.id), el('span', null, from.name))
      head.append(who)
    }
    head.append(agoNode(card.created, 'inbox-ago'))

    const text = el('button', 'inbox-text')
    text.type = 'button'
    const rest = [card.urgency_reason, plain(card.body)].filter(Boolean).join(' · ')
    const title = el('strong', 'inbox-question', card.title)
    text.append(title)
    if (rest) text.append(el('span', 'inbox-body', rest))
    text.addEventListener('click', () => onOpen(card.id))
    const content = el('div', 'inbox-content')
    content.append(head, text, error)
    fit.observe(title)

    // One small picture stands for all of them; it opens large on tap, without leaving the list.
    let thumb = null
    const images = (card.attachments ?? []).filter(a => kindOf(a) === 'image')
    if (images.length) {
      thumb = el('button', 'inbox-thumb')
      thumb.type = 'button'
      thumb.setAttribute('aria-label', images.length === 1 ? `${images[0].name} vergrößern` : `${images.length} Bilder ansehen`)
      const img = el('img')
      img.src = images[0].url
      img.alt = ''
      img.loading = 'lazy'
      img.addEventListener('error', () => thumb.remove())
      thumb.append(img)
      if (images.length > 1) thumb.append(el('b', null, String(images.length)))
      thumb.addEventListener('click', () => openLightbox(images, 0))
    }

    const actions = el('div', 'inbox-actions')
    const tile = (cls, kind, label, act) => {
      const b = el('button', cls ? `inbox-answer ${cls}` : 'inbox-answer')
      b.type = 'button'
      const disc = el('span', 'inbox-disc')
      disc.append(tileIcon(kind))
      b.append(disc)
      if (label) b.append(el('span', null, label))
      b.addEventListener('click', act)
      return b
    }
    if (quick(card)) {
      // No on the left, yes on the right, on every card. The option the agent
      // leads with (its first, or "allow") is the yes.
      const isYes = o => (card.kind === 'permission' ? o.key === 'allow' : o === card.options[0])
      const options = [...card.options].sort((a, b) => isYes(a) - isYes(b))
      // A bare yes/no needs no words: thumb up, thumb down.
      const bare = card.options.every(o => /^(ja|nein|yes|no|ok|okay)$/i.test(o.label.trim()))
      for (const o of options) {
        const lead = isYes(o)
        const advised = card.recommended === o.key
        const b = tile(lead ? 'is-lead' : '', lead ? 'yes' : NEGATIVE.test(o.label) || o.key === 'deny' ? 'no' : 'other', bare ? '' : o.label, async () => {
          for (const other of actions.children) other.disabled = true
          b.classList.add('is-picked')
          try {
            await decide(card.id, o.key)
            if (card.kind === 'decision') onDecided?.(card, o)
          } catch (err) {
            for (const other of actions.children) other.disabled = false
            b.classList.remove('is-picked')
            error.textContent = `Nicht übernommen: ${err.message}`
            error.hidden = false
          }
        })
        if (bare) b.setAttribute('aria-label', o.label)
        if (o.detail) b.title = o.detail
        if (advised) { b.classList.add('is-advised'); b.title = 'Empfehlung des Agenten' }
        actions.append(b)
      }
    } else {
      // Not a yes/no: the same two places hold "later" (the card moves to the group at
      // the end; from there the same tile fetches it back) and "more" (the options open).
      actions.append(
        off ? tile('', 'back', 'Zurückholen', () => putOff(card.id, false)) : tile('', 'later', 'Später', () => putOff(card.id)),
        tile('is-lead', 'open', 'Mehr', () => onOpen(card.id)),
      )
    }
    node.append(content)
    if (thumb) node.append(thumb)
    node.append(actions)
    return node
  }

  function render(state) {
    // The inbox looks across every session; a session's questions only at the one in scope.
    const all = session ? { ...state.all, cards: state.cards, queue: state.queue, agents: state.all.agents.filter(a => a.id === state.scope) } : state.all
    const byId = new Map(all.cards.map(c => [c.id, c]))
    const open = all.queue.map(id => byId.get(id)).filter(Boolean)
    const off = state.later.map(id => open.find(c => c.id === id)).filter(Boolean)
    const fresh = open.filter(c => !off.includes(c))
    const next = JSON.stringify([off.map(c => c.id), open.map(c => [c.id, c.urgency, c.urgency_reason, c.title, c.body, c.options, c.recommended, c.attachments?.length]), all.agents.map(a => [a.id, a.name, a.mark, a.starred])])
    if (next === signature) return
    signature = next

    // The number counts what is still to be worked down; what was put off is counted at its own group.
    const title = el('div', 'inbox-title')
    const line = el('p')
    if (fresh.length) line.append(el('span', 'inbox-circled', String(fresh.length)), fresh.length === 1 ? ' Frage wartet auf dich.' : ' Fragen warten auf dich.')
    else line.append(off.length ? 'Nichts Neues. Was du zurückgestellt hast, steht unten.' : 'Nichts wartet auf dich.')
    // A session's pane already carries its name as the title; the inbox has its own.
    if (session) title.append(line)
    else title.append(el('h2', null, 'Posteingang'), line)
    head.replaceChildren(...(session && !open.length ? [] : [title]))
    if (fresh.length > 1 && !session) {
      const go = el('button', 'inbox-go', 'Der Reihe nach durchgehen')
      go.type = 'button'
      go.addEventListener('click', () => onOpen(null))
      head.append(go)
    }

    // One group per sender. Starred sessions come first, then whoever has the most urgent question.
    const top = cards => Math.max(...cards.map(c => RANK[c.urgency] ?? 1))
    const groups = all.agents
      .map(agent => ({ agent, cards: fresh.filter(c => c.agent === agent.id) }))
      .filter(g => g.cards.length)
      .sort((a, b) => Boolean(b.agent.starred) - Boolean(a.agent.starred) || top(b.cards) - top(a.cards))

    // Remember where every row was, so that after an answer the rest slides up instead of jumping.
    const before = new Map([...list.querySelectorAll('.inbox-row')].map(n => [n.dataset.id, n.getBoundingClientRect().top]))
    fit.disconnect()
    list.replaceChildren()
    for (const { agent, cards } of groups) {
      const section = el('section', 'inbox-group')
      if (!session) {
        const label = el('h3', 'inbox-sender')
        const mark = el('span', 'inbox-avatar')
        mark.append(doodle(agent.mark ?? agent.id))
        label.append(mark, el('span', null, agent.starred ? `★ ${agent.name}` : agent.name), el('b', null, cards.length === 1 ? '1 Frage' : `${cards.length} Fragen`))
        section.append(label)
      }
      section.append(...cards.map(c => row(c, { vip: !session && agent.starred })))
      list.append(section)
    }
    // Put off: one group below all senders, in the order the cards were put off. Its heading is dashed,
    // because the group is provisional. Each row says who asked, since it no longer stands under its sender.
    if (off.length) {
      const section = el('section', 'inbox-group inbox-group-later')
      const label = el('h3', 'inbox-sender')
      const mark = el('span', 'inbox-avatar')
      mark.append(tileIcon('later'))
      label.append(mark, el('span', null, 'Später'), el('b', null, `${off.length} zurückgestellt`))
      section.append(label, ...off.map(c => row(c, { off: true, from: session ? null : all.agents.find(a => a.id === c.agent) })))
      list.append(section)
    }
    if (!open.length) list.append(el('p', 'inbox-empty', session ? 'Diese Sitzung hat gerade keine Frage an dich.' : 'Sobald ein Agent eine Frage hat, erscheint sie hier.'))
    if (before.size && !matchMedia('(prefers-reduced-motion: reduce)').matches) {
      for (const node of list.querySelectorAll('.inbox-row')) {
        const was = before.get(node.dataset.id)
        const moved = was == null ? 0 : was - node.getBoundingClientRect().top
        if (moved) node.animate([{ translate: `0 ${moved}px` }, { translate: '0 0' }], { duration: 320, easing: 'cubic-bezier(.25, 1.4, .5, 1)' })
      }
    }
  }

  return { render }
}
