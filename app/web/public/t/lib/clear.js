// The Desk's two switches (paper.js lays them with the paper): the pen (draw anywhere, P) and "clear the table"
// (W): only the paper is left. They stand round and drawn at the Desk's lower left, apart from the memo button
// (Christopher, card Nr. 211: "Wegwischen"). Clearing wipes the cards off the table to the right; they slide back in the same
// way. The state (session-only, the knocks on the switch) is paper.js's; this file is the look and the motion.
// Styles: css/clear.css.

// Hand-drawn symbols in the memo button's manner: wobbly outlines, paper fills.
const PEN = '<svg class="clear-ico" viewBox="0 0 24 24" aria-hidden="true"><path class="clear-fill" d="M6.3 15.2 Q11 10.4 15.6 5.7 Q17.5 4.3 19 5.8 Q20.2 7.4 18.6 8.8 Q13.9 13.6 9.1 18.1 Z"/><path class="clear-wood" d="M6.3 15.2 Q5.2 17.4 4.7 19.6 Q6.9 19.1 9.1 18.1 Z"/><path d="M14.3 7 Q15.8 8.2 17.3 9.9"/><path class="clear-line" d="M11.6 20.6 Q13.6 19.3 15.4 20.3 Q17.4 21.2 19.6 19.7"/></svg>'
const WIPE = '<svg class="clear-ico" viewBox="0 0 24 24" aria-hidden="true"><path class="clear-fill" d="M10.2 6.1 Q15.4 5.3 20.6 5.8 Q21 10.4 20.7 15.4 Q15.6 16.2 10.4 15.8 Q9.9 11 10.2 6.1 Z" transform="rotate(7 15.4 10.8)"/><path class="clear-line" d="M12.7 9.4 Q15.6 9.1 18.4 9.6" transform="rotate(7 15.4 10.8)"/><path class="clear-line" d="M12.8 12.4 Q14.8 12.2 16.6 12.5" transform="rotate(7 15.4 10.8)"/><path d="M2.8 8.6 Q4.9 8.3 7 8.7"/><path d="M2.2 12.2 Q4.6 11.9 7.3 12.3"/><path d="M3.4 15.8 Q5.2 15.5 7.1 15.9"/><path class="clear-line" d="M5.6 20.2 Q11.6 19.4 18.8 20.4"/></svg>'

if (!document.querySelector('link[href="/css/clear.css"]')) document.head.append(Object.assign(document.createElement('link'), { rel: 'stylesheet', href: '/css/clear.css' }))

function button(id, art, label, key) {
  const b = document.createElement('button')
  b.type = 'button'
  b.id = id
  b.className = 'clear-btn'
  b.innerHTML = `${art}<span class="clear-note"></span>`
  b.setAttribute('aria-label', label)
  b.setAttribute('aria-keyshortcuts', key)
  b.title = label
  return b
}

/** The switches' place (to go into the paper's top layer) and the two buttons. */
export function switches(label) {
  const place = document.createElement('div')
  place.className = 'clear-at'
  place.setAttribute('role', 'toolbar')
  place.setAttribute('aria-label', label)
  const pen = button('deskpad-pen', PEN, 'Draw on the Desk, anywhere (P); Escape ends it', 'P')
  const clear = button('deskpad-clear', WIPE, 'Clear the table: only the paper (W)', 'W')
  place.append(pen, clear)
  return { place, pen, clear }
}

/** What lies on the table: the heading, every row and the stacks, each moved on its own. */
const things = box => [...box.querySelectorAll(':scope > .inbox-head, :scope > .inbox-news-at > *, :scope > .inbox-groups > .inbox-group > *, :scope > .inbox-groups > :not(.inbox-group)')].filter(n => n.getClientRects().length)

let running = []
/** The cards are wiped off the table (hide) or slide back. paint() sets the state; while they leave they stay
 *  visible (data-clearing). */
export function wipe(box, hide, paint) {
  for (const a of running) a.cancel()
  running = []
  const list = matchMedia('(prefers-reduced-motion: reduce)').matches ? [] : things(box)
  box.toggleAttribute('data-clearing', list.length > 0)
  paint()
  if (!list.length) return
  const order = hide ? list : [...list].reverse()
  order.forEach((node, i) => {
    const r = node.getBoundingClientRect()
    const away = { transform: `translateX(${innerWidth - r.left + 40}px) rotate(${4 + (i % 3) * 3}deg)` }
    const here = { transform: 'none' }
    running.push(node.animate(hide ? [here, away] : [away, here], {
      duration: 420, delay: Math.min(i, 12) * 40, fill: 'both',
      easing: hide ? 'cubic-bezier(.5, 0, .9, .4)' : 'cubic-bezier(.15, .9, .3, 1.08)',
    }))
  })
  const these = running
  Promise.all(these.map(a => a.finished)).then(() => {
    if (running !== these) return
    box.removeAttribute('data-clearing')
    for (const a of these) a.cancel()
    running = []
  }, () => {})
}
