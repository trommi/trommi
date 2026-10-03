// The piles at the foot of a list of questions, as stacks of paper drawn with the pen: "Later" (what
// comes back: in revision, snoozed) and "Done" (what is finished: answered, shredded). A stack carries
// its count (a tally, or the number where the strokes would be too many); its height grows with the
// count. A click fans a stack out: its sheets leave it and lie below as full-width lines. A second click
// or Escape gathers them back. One stack is fanned out at a time.
// The lines themselves are built by the list (inbox.js); the look is css/piles.css.
import { el, tally } from './ui.js'

export const FAN_MAX = 8   // a fan shows so many of the newest sheets, then one last sheet "N more"
const SHEETS_MAX = 6       // a stack is drawn with so many sheets at most
const TALLY_MAX = 15       // three gates of strokes; a larger count stands on the sheet as a number
const calm = () => matchMedia('(prefers-reduced-motion: reduce)').matches

/** A stack of paper drawn by hand: one sheet for every three that lie on it. The top sheet lies nearly
 *  straight, those below it are turned and pushed a little, so the stack has depth. */
function paper(n, key = '') {
  let seed = 7 + n
  for (const ch of key) seed = (seed * 31 + ch.charCodeAt(0)) % 2147483647
  const r = () => (seed = (seed * 16807) % 2147483647) / 2147483647 - .5
  const sheets = Math.min(SHEETS_MAX, Math.max(1, Math.ceil(n / 3))), W = 124, H = 78, pad = 6, step = 3.4
  const sheet = () => {
    const c = [[pad, pad], [pad + W, pad], [pad + W, pad + H], [pad, pad + H]].map(([x, y]) => [x + r() * 1.8, y + r() * 1.8])
    let d = `M${c[0][0].toFixed(1)} ${c[0][1].toFixed(1)}`
    for (let i = 1; i <= 4; i++) { const a = c[i - 1], b = c[i % 4]; d += ` Q${((a[0] + b[0]) / 2 + r() * 2.4).toFixed(1)} ${((a[1] + b[1]) / 2 + r() * 2.4).toFixed(1)} ${b[0].toFixed(1)} ${b[1].toFixed(1)}` }
    return `${d}Z`
  }
  let out = ''
  for (let i = sheets - 1; i >= 0; i--) out += `<path transform="translate(${i ? (r() * 7).toFixed(1) : 0} ${(i * step).toFixed(1)}) rotate(${(r() * (i ? 7 : 1.6)).toFixed(2)} ${pad + W / 2} ${pad + H / 2})" d="${sheet()}"/>`
  const h = H + 2 * pad + (sheets - 1) * step
  return `<svg class="inbox-stack-sheets" width="${W + 2 * pad}" height="${h.toFixed(0)}" viewBox="0 0 ${W + 2 * pad} ${h.toFixed(0)}" aria-hidden="true">${out}</svg>`
}

/** The stacks. piles: [{ kind, word, also, ring, lines }]: lines are functions that each build one line,
 *  in the order they lie; ring is a node shown on the top sheet (the turning ring while a session works on
 *  something there); also: one more name for the classes (inbox-group-<also>, inbox-<also>-toggle).
 *  open: the kind that stands fanned out; wide: it shows the whole pile, not only the first sheets.
 *  onToggle(kind | null, wide) says what stands open now; onShut() that a fan has gone back.
 *  A pile with something on it is a .inbox-pile[data-pile] with a .inbox-pile-head (what the keys and
 *  the tests look for); an empty one is only its faint sheet.
 *  Returns { node, close() }: close gathers the open stack and says whether there was one. */
export function stacks(piles, { open = null, wide = false, onToggle, onShut } = {}) {
  const node = el('div', 'inbox-stacks')
  const parts = new Map()   // kind -> { pile, section, head, sheets, fan }
  let now = null, busy = false

  const fill = (kind, all) => {
    const { pile, fan } = parts.get(kind)
    const cap = all ? pile.lines.length : FAN_MAX
    fan.replaceChildren(...pile.lines.slice(0, cap).map(line => { const sheet = el('div', 'inbox-pile-item'); sheet.append(line()); return sheet }))
    if (pile.lines.length <= cap) return
    const more = el('button', 'inbox-pile-item inbox-stack-more', `${pile.lines.length - cap} more`)
    more.type = 'button'
    more.title = 'Show the whole pile'
    more.addEventListener('click', () => { fill(kind, true); onToggle?.(kind, true); fan.children[cap]?.querySelector('a, button')?.focus({ preventScroll: true }) })
    fan.append(more)
  }
  const show = (kind, to) => {
    const { pile, section, head, sheets } = parts.get(kind)
    section.classList.toggle('is-open', to)
    head.setAttribute('aria-expanded', String(to))
    head.title = to ? 'Gather them back into the stack' : 'Fan the stack out'
    // An open stack has given its sheets away: one sheet is left where it stood.
    sheets.innerHTML = paper(to ? 1 : pile.lines.length, kind)
  }

  // ---- the fan: the sheets leave the stack, and go back into it ----
  const toStack = (sheet, from) => { const r = sheet.getBoundingClientRect(); return `translate(${from.left - r.left}px, ${from.top - r.top}px) scale(${from.width / r.width}, ${from.height / r.height})` }
  function spread(kind) {
    const { head, fan } = parts.get(kind)
    if (calm() || !node.isConnected) return
    const from = head.getBoundingClientRect()
    ;[...fan.children].forEach((sheet, i) => sheet.animate([{ transform: toStack(sheet, from), opacity: .25 }, { transform: 'none', opacity: 1 }], { duration: 360, delay: Math.min(i, 10) * 28, easing: 'cubic-bezier(.16, 1, .3, 1)', fill: 'backwards' }))
  }
  function gather(kind) {
    const { head, fan } = parts.get(kind)
    const all = [...fan.children]
    if (calm() || !node.isConnected || !all.length) return null
    const from = head.getBoundingClientRect(), last = Math.min(all.length - 1, 10)
    return Promise.allSettled(all.map((sheet, i) => sheet.animate([{ transform: 'none', opacity: 1 }, { transform: toStack(sheet, from), opacity: .15 }], { duration: 220, delay: Math.max(0, last - i) * 16, easing: 'cubic-bezier(.65, 0, .35, 1)', fill: 'forwards' }).finished))
  }
  const shut = kind => { show(kind, false); fill(kind, false); onShut?.() }
  async function toggle(kind) {
    if (busy) return
    if (now === kind) {
      now = null
      onToggle?.(null, false)
      busy = true
      try { await gather(kind) } finally { busy = false }
      return shut(kind)
    }
    if (now) shut(now)
    now = kind
    show(kind, true)
    onToggle?.(kind, false)
    spread(kind)
    parts.get(kind).fan.scrollIntoView({ block: 'nearest', behavior: calm() ? 'instant' : 'smooth' })
  }

  piles.forEach((pile, at) => {
    const n = pile.lines.length, names = [pile.kind, ...(pile.also ? [pile.also] : [])]
    const section = el('section', n ? `inbox-stack inbox-group inbox-pile ${names.map(k => `inbox-group-${k}`).join(' ')}` : 'inbox-stack is-empty')
    section.style.setProperty('--at', at)
    if (n) section.dataset.pile = pile.kind
    const title = el('h3', 'inbox-stack-title')
    const head = el('button', n ? `inbox-stack-head inbox-pile-head ${names.map(k => `inbox-${k}-toggle`).join(' ')}` : 'inbox-stack-head')
    head.type = 'button'
    head.disabled = !n
    const drawn = el('span', 'inbox-stack-paper')
    drawn.setAttribute('aria-hidden', 'true')
    const sheets = el('span')
    // On the top sheet: the count, as strokes or as a number, and the ring while a session works on something.
    const on = el('span', 'inbox-stack-on')
    if (n) on.append(n > TALLY_MAX ? el('span', 'inbox-stack-num', String(n)) : tally(n, TALLY_MAX), ...(pile.ring ? [pile.ring] : []))
    drawn.append(sheets, on)
    // The word stands first for whoever reads the page aloud; the paper is drawn above it (css).
    head.append(el('span', 'inbox-stack-word', pile.word), drawn, el('b', null, String(n)))
    title.append(head)
    const fan = el('div', 'inbox-pile-sheets')
    section.append(title, fan)
    parts.set(pile.kind, { pile, section, head, sheets, fan })
    sheets.innerHTML = paper(n, pile.kind)
    if (n) {
      head.addEventListener('click', () => toggle(pile.kind))
      const stands = open === pile.kind
      if (stands) now = pile.kind
      show(pile.kind, stands)
      fill(pile.kind, stands && wide)
    }
    node.append(section)
  })
  const close = () => { if (!now) return false; toggle(now); return true }
  // Escape gathers the fan, also from a line inside it.
  node.addEventListener('keydown', e => {
    if (e.key !== 'Escape' || !now || e.defaultPrevented || e.target.closest('.inbox-done.is-current')) return
    const head = parts.get(now).head
    close()
    e.preventDefault()
    e.stopPropagation()
    head.focus({ preventScroll: true })
  })
  return { node, close }
}
