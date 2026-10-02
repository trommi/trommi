// The status strip under the top bar: one pill per work stream the agent
// reports, as a traffic light. Red waits on the human, yellow is in progress,
// green is finished.

import { el, agoNode } from './ui.js'

const ORDER = { decision: 0, working: 1, done: 2 }
const STATE_LABEL = { decision: 'Entscheidung nötig', working: 'In Arbeit', done: 'Umgesetzt' }

export function mountStatus(root, { onCard }) {
  const strip = el('div', 'status-strip')
  strip.setAttribute('role', 'list')
  const toggle = el('button', 'status-toggle')
  toggle.type = 'button'
  toggle.setAttribute('aria-expanded', 'false')
  toggle.setAttribute('aria-controls', 'status-panel')
  const panel = el('div', 'status-panel')
  panel.id = 'status-panel'
  panel.hidden = true
  root.append(strip, toggle, panel)

  let signature = ''

  const setOpen = open => {
    panel.hidden = !open
    toggle.setAttribute('aria-expanded', String(open))
    toggle.setAttribute('aria-label', open ? 'Stand einklappen' : 'Stand mit Details zeigen')
  }
  setOpen(false)
  toggle.addEventListener('click', () => setOpen(panel.hidden))
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && !panel.hidden) setOpen(false) })
  document.addEventListener('pointerdown', e => { if (!panel.hidden && !root.contains(e.target)) setOpen(false) })

  function pill(task) {
    const node = el('button', 'status-pill')
    node.type = 'button'
    node.dataset.state = task.state
    node.setAttribute('role', 'listitem')
    node.setAttribute('aria-label', `${task.label}: ${STATE_LABEL[task.state]}`)
    node.append(el('i'), el('span', null, task.label))
    // A red pill is a question for the human, so it leads straight to the card.
    node.addEventListener('click', () => {
      if (task.state === 'decision' && task.card_id) onCard(task.card_id)
      else setOpen(panel.hidden)
    })
    return node
  }

  function row(task) {
    const node = el('div', 'status-row')
    node.dataset.state = task.state
    const head = el('div', 'status-row-head')
    head.append(el('i'), el('strong', null, task.label), el('span', 'status-word caps', STATE_LABEL[task.state]), agoNode(task.updated, 'status-ago'))
    node.append(head)
    if (task.detail) node.append(el('p', 'status-detail', task.detail))
    if (task.state === 'decision' && task.card_id) {
      const go = el('button', 'status-go', 'Zur Entscheidung')
      go.type = 'button'
      go.addEventListener('click', () => { setOpen(false); onCard(task.card_id) })
      node.append(go)
    }
    return node
  }

  function render(state) {
    const tasks = [...state.tasks].sort((a, b) => ORDER[a.state] - ORDER[b.state])
    const next = JSON.stringify(tasks)
    if (next === signature) return
    signature = next
    root.hidden = tasks.length === 0
    if (root.hidden) return setOpen(false)
    strip.replaceChildren(...tasks.map(pill))
    panel.replaceChildren(...tasks.map(row))
    const count = s => tasks.filter(t => t.state === s).length
    toggle.replaceChildren(el('span', 'status-sum', `${count('done')} von ${tasks.length} umgesetzt`), chevron())
  }

  return { render }
}

function chevron() {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  svg.setAttribute('viewBox', '0 0 24 24')
  svg.setAttribute('class', 'ico')
  svg.setAttribute('aria-hidden', 'true')
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path')
  path.setAttribute('d', 'M6.5 9.5 12 15l5.5-5.5')
  svg.append(path)
  return svg
}
