// The piles at the foot of a list of questions, one per state a card can be in once it left the open rows:
// three stacks of paper drawn with the pen, "Later" (snoozed), "In the works" (with the session: in revision, or
// answered and being acted on) and "Done" (closed), and at the end of the row a small waste-paper basket
// (shredded, withdrawn). A stack carries
// its count (a tally, or the number where the strokes would be too many) and its name as a rubber stamp; its
// height grows with the count. A click fans a stack out: its sheets leave it and lie below as full-width lines. A second click
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

/** The waste-paper basket: small, woven, drawn by hand; with something in it a crumpled sheet looks over its rim. */
function basket(n) {
  const ball = n ? '<path class="inbox-bin-ball" d="M13.5 15.5 Q11 9.5 16.5 7.5 Q18.5 3.5 23.5 5.5 Q28.5 3 31 8 Q35.5 9.5 33.5 15.5"/><path class="inbox-bin-crease" d="M17.5 9.5 Q20.5 11.5 20 15 M24 6.5 Q25.5 10 29 10.5 M27 15 Q28.5 12.5 31.5 12"/>' : ''
  return `<svg class="inbox-bin-drawing" width="46" height="54" viewBox="0 0 46 54" aria-hidden="true">${ball}<path class="inbox-bin-body" d="M6.5 16.5 Q22.5 15 39.5 16.2 Q38.2 33 35.2 50.2 Q23 51.6 11 50.4 Q8 33 6.5 16.5 Z"/><path class="inbox-bin-weave" d="M14.2 17 Q15.2 34 16.6 50.6 M23 16.4 Q23.2 34 23 51 M31.6 16.6 Q30.8 34 29.4 50.8 M8.4 27.5 Q23 26.4 37.8 27.6 M9.8 39 Q23 38 36.6 39.2"/><path class="inbox-bin-rim" d="M4.6 16.8 Q23 14.2 41.4 16.4"/></svg>`
}

/** The stacks. piles: [{ kind, word, also, ring, bin, lines }]: bin: this one is the small basket at the end of the
 *  row, not a stack of paper; lines are functions that each build one line,
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
    head.title = pile.bin ? (to ? 'Put them back into the basket' : `${pile.word}: show what is in it`) : to ? 'Gather them back into the stack' : 'Fan the stack out'
    // An open stack has given its sheets away: one sheet is left where it stood.
    sheets.innerHTML = pile.bin ? basket(to ? 0 : pile.lines.length) : paper(to ? 1 : pile.lines.length, kind)
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
    if (pile.bin) section.classList.add('inbox-bin')
    section.style.setProperty('--at', at)
    section.dataset.stack = pile.kind   // which stack it is, also when it is empty (the ink of its stamp, css)
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
    // (The basket is too small for strokes: it carries its count as a small number.)
    if (n) on.append(pile.bin || n > TALLY_MAX ? el('span', 'inbox-stack-num', String(n)) : tally(n, TALLY_MAX), ...(pile.ring ? [pile.ring] : []))
    drawn.append(sheets, on)
    // The one place for a stack's name: .inbox-stack-word holds it, as .inbox-stamp. The word stands first for whoever
    // reads the page aloud; to the eye it is a rubber stamp on the top sheet (css). The basket's name is not shown.
    const word = el('span', 'inbox-stack-word')
    word.append(el('span', 'inbox-stamp', pile.word))
    head.append(word, drawn, el('b', null, String(n)))
    title.append(head)
    const fan = el('div', 'inbox-pile-sheets')
    section.append(title, fan)
    parts.set(pile.kind, { pile, section, head, sheets, fan })
    sheets.innerHTML = pile.bin ? basket(n) : paper(n, pile.kind)
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
