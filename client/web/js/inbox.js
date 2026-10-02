// The inbox: every open decision of every session, grouped by who is asking.
// Every row is the same height with two tiles at its right edge: no and yes
// for a yes/no question, otherwise "later" and "more", which opens the options.

import { el, agoNode, URGENCY_LABEL, doodle, kindOf, rich, mediaNodes } from './ui.js'
import { decide, reopen } from './store.js'
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
 *  With session: true it lists only the session in scope, in the same rows. */
export function mountInbox(root, { onOpen, session = false }) {
  let signature = ''
  let lastState = null
  let later = []   // cards put off for now, in the order they were put off; they sink to the end
  const head = el('header', 'inbox-head')
  const undo = el('div', 'inbox-undo')
  undo.hidden = true
  const list = el('div', 'inbox-groups')
  root.append(head, undo, list)
  let undoTimer = 0

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

  function offerUndo(card, option) {
    clearTimeout(undoTimer)
    const back = el('button', null, 'Rückgängig')
    back.type = 'button'
    back.addEventListener('click', async () => {
      back.disabled = true
      try { await reopen(card.id); undo.hidden = true } catch (err) { back.disabled = false; back.textContent = `Nicht zurückgenommen: ${err.message}` }
    })
    const text = el('span')
    text.append(`Nr. ${card.number} entschieden: `, el('strong', null, option.label))
    undo.replaceChildren(text, back)
    undo.hidden = false
    undoTimer = setTimeout(() => { undo.hidden = true }, 10000)
  }

  function row(card, vip, full = false) {
    const node = el('article', full ? 'inbox-row is-full' : 'inbox-row')
    node.dataset.id = card.id
    node.dataset.urgency = card.urgency
    const error = el('p', 'inbox-error')
    error.hidden = true

    // Head: the tab strip flush with the corner, as on the cards of the stack.
    const head = el('header', 'inbox-row-head')
    const tab = el('span', 'inbox-tab')
    tab.append(el('span', null, `Nr. ${card.number}`), el('span', null, card.kind === 'permission' ? 'Freigabe' : URGENCY_LABEL[card.urgency] ?? ''))
    if (vip) tab.append(el('span', 'inbox-vip', '★ VIP'))
    head.append(tab, agoNode(card.created, 'inbox-ago'))

    const text = el('button', 'inbox-text')
    text.type = 'button'
    const rest = [card.urgency_reason, plain(card.body)].filter(Boolean).join(' · ')
    text.append(el('strong', 'inbox-question', card.title))
    if (rest && !full) text.append(el('span', 'inbox-body', rest))
    text.addEventListener('click', () => onOpen(card.id))
    const content = el('div', 'inbox-content')
    content.append(head, text)
    if (!full) fit.observe(text.firstChild)
    if (full) {
      if (card.urgency_reason) content.append(el('p', 'inbox-reason', card.urgency_reason))
      if (card.body) content.append(rich(card.body))
      content.append(...mediaNodes(card.attachments))
    }

    // Pictures are shown small and open large on tap, without leaving the list.
    let thumbs = null
    const images = (card.attachments ?? []).filter(a => kindOf(a) === 'image')
    const others = (card.attachments?.length ?? 0) - images.length
    if (images.length) {
      const strip = el('div', 'inbox-thumbs')
      images.slice(0, full ? 4 : 2).forEach((a, i) => {
        const b = el('button', 'inbox-thumb')
        b.type = 'button'
        b.setAttribute('aria-label', `${a.name} vergrößern`)
        const img = el('img')
        img.src = a.url
        img.alt = ''
        img.loading = 'lazy'
        b.append(img)
        b.addEventListener('click', () => openLightbox(images, i))
        strip.append(b)
      })
      if (others) strip.append(el('span', 'inbox-note', others === 1 ? '+ 1 Datei' : `+ ${others} Dateien`))
      thumbs = strip
    }
    content.append(error)

    // The answers stand on the right, large and in one column down the page.
    const actions = el('div', 'inbox-actions')
    if (full) {
      // With room to spare, every option is written out and answered where it stands.
      // A short set stands side by side; long lists stay stacked, in the agent's order.
      const side = card.options.length <= 3 && card.options.every(o => o.label.length <= 24 && (o.detail ?? '').length <= 70)
      const isYes = o => (card.kind === 'permission' ? o.key === 'allow' : o === card.options[0])
      const pair = side && card.options.length === 2
      // Two answers follow the inbox: the one the agent leads with on the right, the other on the left.
      const options = pair ? [...card.options].sort((a, b) => isYes(a) - isYes(b)) : card.options
      if (side) actions.dataset.side = String(options.length)
      for (const o of options) {
        const b = el('button', 'inbox-choice')
        b.type = 'button'
        if (pair && isYes(o)) b.classList.add('is-lead')
        b.append(el('strong', null, o.label))
        if (o.detail) b.append(el('span', null, o.detail))
        b.addEventListener('click', async () => {
          for (const other of actions.children) other.disabled = true
          try {
            await decide(card.id, o.key)
            if (card.kind === 'decision') offerUndo(card, o)
          } catch (err) {
            for (const other of actions.children) other.disabled = false
            error.textContent = `Nicht übernommen: ${err.message}`
            error.hidden = false
          }
        })
        actions.append(b)
      }
    } else if (quick(card)) {
      // No on the left, yes on the right, on every card. The option the agent
      // leads with (its first, or "allow") is the yes.
      const isYes = o => (card.kind === 'permission' ? o.key === 'allow' : o === card.options[0])
      const options = [...card.options].sort((a, b) => isYes(a) - isYes(b))
      // A bare yes/no needs no words: thumb up, thumb down.
      const bare = card.options.every(o => /^(ja|nein|yes|no|ok|okay)$/i.test(o.label.trim()))
      options.forEach(o => {
        const b = el('button', 'inbox-answer')
        b.type = 'button'
        const lead = isYes(o)
        if (lead) b.classList.add('is-lead')
        const disc = el('span', 'inbox-disc')
        disc.append(tileIcon(lead ? 'yes' : NEGATIVE.test(o.label) || o.key === 'deny' ? 'no' : 'other'))
        b.append(disc)
        if (bare) b.setAttribute('aria-label', o.label)
        else b.append(el('span', null, o.label))
        if (o.detail) b.title = o.detail
        b.addEventListener('click', async () => {
          for (const other of actions.children) other.disabled = true
          b.classList.add('is-picked')
          try {
            await decide(card.id, o.key)
            if (card.kind === 'decision') offerUndo(card, o)
          } catch (err) {
            for (const other of actions.children) other.disabled = false
            b.classList.remove('is-picked')
            error.textContent = `Nicht übernommen: ${err.message}`
            error.hidden = false
          }
        })
        actions.append(b)
      })
    } else {
      // Not a yes/no: the same two places hold "later" (the card goes to the end
      // of the list) and "more" (the options open in a window).
      const tile = (cls, kind, label, act) => {
        const b = el('button', `inbox-answer ${cls}`)
        b.type = 'button'
        const disc = el('span', 'inbox-disc')
        disc.append(tileIcon(kind))
        b.append(disc, el('span', null, label))
        b.addEventListener('click', act)
        return b
      }
      actions.append(
        tile('inbox-later', 'later', 'Später', () => {
          later = [...later.filter(id => id !== card.id), card.id]
          signature = ''
          render(lastState)
        }),
        tile('is-lead', 'open', 'Mehr', () => onOpen(card.id)),
      )
    }
    // In the list every row has the same height, so the next answer lands where the last one was.
    if (thumbs && full) content.append(thumbs)
    if (thumbs && !full) node.append(content, thumbs, actions)
    else node.append(content, actions)
    return node
  }

  function render(state) {
    // The inbox looks across every session; a session's questions only at the one in scope.
    const all = session ? { ...state.all, cards: state.cards, queue: state.queue, agents: state.all.agents.filter(a => a.id === state.scope) } : state.all
    const byId = new Map(all.cards.map(c => [c.id, c]))
    lastState = state
    const put = id => later.indexOf(id)
    const open = all.queue.map(id => byId.get(id)).filter(Boolean)
      .map((c, i) => [c, i]).sort((a, b) => put(a[0].id) - put(b[0].id) || a[1] - b[1]).map(([c]) => c)
    const next = JSON.stringify([later, open.map(c => [c.id, c.urgency, c.urgency_reason, c.title, c.body, c.options, c.attachments?.length]), all.agents.map(a => [a.id, a.name, a.mark, a.starred])])
    if (next === signature) return
    signature = next

    root.classList.toggle('inbox-session', session)
    const title = el('div', 'inbox-title')
    const line = el('p')
    if (open.length) line.append(el('span', 'inbox-circled', String(open.length)), open.length === 1 ? ' Frage wartet auf dich.' : ' Fragen warten auf dich.')
    else line.append('Nichts wartet auf dich.')
    // A session's pane already carries its name as the title; the inbox has its own.
    if (session) title.append(line)
    else title.append(el('h2', null, 'Posteingang'), line)
    head.replaceChildren(...(session && !open.length ? [] : [title]))
    if (open.length > 1 && !session) {
      const go = el('button', 'inbox-go', 'Der Reihe nach durchgehen')
      go.type = 'button'
      go.addEventListener('click', () => onOpen(null))
      head.append(go)
    }

    // One group per sender. Starred sessions come first, then whoever has the most urgent question.
    const top = cards => Math.max(...cards.map(c => RANK[c.urgency] ?? 1))
    const groups = all.agents
      .map(agent => ({ agent, cards: open.filter(c => c.agent === agent.id) }))
      .filter(g => g.cards.length)
      .sort((a, b) => Boolean(b.agent.starred) - Boolean(a.agent.starred) || top(b.cards) - top(a.cards))

    // Remember where every row was, so that after an answer the rest slides up instead of jumping.
    const before = new Map([...list.querySelectorAll('.inbox-row')].map(n => [n.dataset.id, n.getBoundingClientRect().top]))
    list.replaceChildren()
    for (const { agent, cards } of groups) {
      const section = el('section', 'inbox-group')
      const label = el('h3', 'inbox-sender')
      const mark = el('span', 'inbox-avatar')
      mark.append(doodle(agent.mark ?? agent.id))
      label.append(mark, el('span', null, agent.starred ? `★ ${agent.name}` : agent.name), el('b', null, cards.length === 1 ? '1 Frage' : `${cards.length} Fragen`))
      if (session) section.append(...cards.map(c => row(c, false)))
      else section.append(label, ...cards.map(c => row(c, agent.starred)))
      list.append(section)
    }
    if (!groups.length) list.append(el('p', 'inbox-empty', session ? 'Diese Sitzung hat gerade keine Frage an dich.' : 'Sobald ein Agent eine Frage hat, erscheint sie hier.'))
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
