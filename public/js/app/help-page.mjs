// The help page's key list, read from the app's own key table (t/lib/keys.js SHORT), and the key beside each way.
import { SHORT, capOf } from '/t/lib/keys.js'

const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n }
const caps = spec => capOf(spec).map(p => el('kbd', null, p))
const list = el('dl', 'hp-params')
for (const k of SHORT) {
  const row = el('div'), dt = el('dt'), dd = el('dd', null, k.does)
  k.keys.forEach((spec, i) => { if (i) dt.append(el('i', null, 'or')); dt.append(...caps(spec)) })
  row.append(dt, dd)
  list.append(row)
}
const block = el('div')
block.append(el('h3', null, 'Keys'), list)
document.getElementById('key-list')?.replaceChildren(block, el('p', 'hp-wait', 'More keys later.'))
const all = Object.fromEntries(SHORT.flatMap(k => k.keys.map(spec => [k.id, spec])))
for (const node of document.querySelectorAll('[data-key]')) { try { node.append(...caps(all[node.dataset.key] ?? node.dataset.key)) } catch {} }
// "?" on this page goes to the list.
addEventListener('keydown', e => {
  if (e.key !== '?' || e.ctrlKey || e.metaKey || e.altKey || e.target?.closest?.('input, textarea, select')) return
  e.preventDefault()
  document.getElementById('keys')?.scrollIntoView()
})
