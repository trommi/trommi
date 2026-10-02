// The inbox: every open decision of every session, grouped by who is asking.
// Yes/no questions are answered right in the row, with two buttons on the
// right; anything longer opens as a full page.

import { el, agoNode, URGENCY_LABEL, doodle, kindOf } from './ui.js'
import { decide, reopen } from './store.js'
import { openLightbox } from './chat.js'

const RANK = { critical: 3, high: 2, normal: 1, low: 0 }

// Answerable in the list: a yes/no kind of question. Two options with labels
// short enough for a button, at most about three lines of text, and nothing
// attached beyond pictures, which the row shows. Everything else opens.
const quick = card =>
  card.kind === 'permission' ||
  (card.options.length === 2 && card.options.every(o => o.label.length <= 18) && (card.attachments ?? []).every(a => kindOf(a) === 'image') && (card.body ?? '').length <= 240)

const plain = text => String(text ?? '').replace(/```[\s\S]*?```/g, ' ').replace(/[*`#]/g, '').replace(/\s+/g, ' ').trim()

/** onOpen(cardId | null): open that card as a full page, or with null start at the most urgent one. */
export function mountInbox(root, { onOpen }) {
  let signature = ''
  const head = el('header', 'inbox-head')
  const undo = el('div', 'inbox-undo')
  undo.hidden = true
  const list = el('div', 'inbox-groups')
  root.append(head, undo, list)
  let undoTimer = 0

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

  function row(card, vip) {
    const node = el('article', 'inbox-row')
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
    if (rest) text.append(el('span', 'inbox-body', rest))
    text.addEventListener('click', () => onOpen(card.id))
    const content = el('div', 'inbox-content')
    content.append(head, text)

    // Pictures are shown small and open large on tap, without leaving the list.
    const images = (card.attachments ?? []).filter(a => kindOf(a) === 'image')
    const others = (card.attachments?.length ?? 0) - images.length
    if (images.length) {
      const strip = el('div', 'inbox-thumbs')
      images.slice(0, 4).forEach((a, i) => {
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
      content.append(strip)
    }
    content.append(error)

    // The answers stand on the right, large and in one column down the page.
    const actions = el('div', 'inbox-actions')
    if (quick(card)) {
      // Decline first, approve last, as on the stack.
      const options = card.kind === 'permission'
        ? [...card.options].sort((a, b) => (a.key === 'allow') - (b.key === 'allow'))
        : card.options
      options.forEach((o, i) => {
        const b = el('button', 'inbox-answer', o.label)
        b.type = 'button'
        // The first option of a decision is the one the agent leads with.
        if (card.kind === 'permission' ? o.key === 'allow' : i === 0) b.classList.add('is-lead')
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
      const open = el('button', 'inbox-answer inbox-open')
      open.type = 'button'
      open.append(el('span', null, 'Optionen ansehen'), el('small', null, `${card.options.length} zur Wahl`))
      open.addEventListener('click', () => onOpen(card.id))
      actions.append(open)
    }
    node.append(content, actions)
    return node
  }

  function render(state) {
    const { all } = state
    const byId = new Map(all.cards.map(c => [c.id, c]))
    const open = all.queue.map(id => byId.get(id)).filter(Boolean)
    const next = JSON.stringify([open.map(c => [c.id, c.urgency, c.urgency_reason, c.title, c.body, c.options, c.attachments?.length]), all.agents.map(a => [a.id, a.name, a.starred])])
    if (next === signature) return
    signature = next

    const title = el('div', 'inbox-title')
    const line = el('p')
    if (open.length) line.append(el('span', 'inbox-circled', String(open.length)), open.length === 1 ? ' Frage wartet auf dich.' : ' Fragen warten auf dich.')
    else line.append('Nichts wartet auf dich.')
    title.append(el('h2', null, 'Posteingang'), line)
    head.replaceChildren(title)
    if (open.length > 1) {
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
      mark.append(doodle(agent.id))
      label.append(mark, el('span', null, agent.starred ? `★ ${agent.name}` : agent.name), el('b', null, cards.length === 1 ? '1 Frage' : `${cards.length} Fragen`))
      section.append(label, ...cards.map(c => row(c, agent.starred)))
      list.append(section)
    }
    if (!groups.length) list.append(el('p', 'inbox-empty', 'Sobald ein Agent eine Frage hat, erscheint sie hier.'))
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
