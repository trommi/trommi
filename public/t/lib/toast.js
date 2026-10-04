// A toast made in the browser, for an action a controller did itself (the hub's forms get theirs from
// server/views/toast.mjs; the markup is the same, so the controller "says" in application.js times and stacks it).
//   toast({ head, line?, undo?: async () => {}, label?, role?, ms? })
// undo: what takes the action back; the toast goes as soon as it is pressed (also by U: keys_controller.js presses
// the newest .says-back).
const UNDO = '<svg class="back-arrow" viewBox="0 0 24 24" aria-hidden="true"><path d="M9 14L4 9l5-5M4 9h10a6 6 0 0 1 0 12h-3"/></svg>'
const CLOCK = '<svg class="back-line" viewBox="0 0 100 6" preserveAspectRatio="none" aria-hidden="true"><path d="M0 3 Q12 1 25 3 T50 3 T75 3 T100 3" pathLength="100"/></svg>'

export function toast({ head, line = '', undo = null, label = 'Undo', role = 'status', ms = null }) {
  const host = document.getElementById('says-host')
  if (!host) return null
  const node = Object.assign(document.createElement('div'), { className: 'says' })
  node.setAttribute('role', role)
  node.dataset.controller = 'says'
  node.dataset.action = 'pointerenter->says#pause pointerleave->says#run'
  if (ms) node.dataset.saysMsValue = String(Math.round(ms))
  const words = Object.assign(document.createElement('span'), { className: 'says-words' })
  words.append(Object.assign(document.createElement('b'), { textContent: head }))
  if (line) words.append(Object.assign(document.createElement('span'), { textContent: line }))
  node.append(words)
  if (undo) {
    const button = Object.assign(document.createElement('button'), { type: 'button', className: 'says-back', title: `${label} (U)` })
    button.setAttribute('aria-keyshortcuts', 'u')
    button.innerHTML = UNDO
    button.append(label, Object.assign(document.createElement('kbd'), { textContent: 'U' }))
    button.addEventListener('click', async () => {
      node.hidden = true
      try { await undo() } finally { node.remove() }
    }, { once: true })
    node.append(button)
  }
  node.insertAdjacentHTML('beforeend', CLOCK)
  host.prepend(node)
  return node
}
