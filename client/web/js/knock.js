// "It knocks": when an urgent or blocking question arrives, its row arrives with two quick small
// nudges, like knuckles on a door, and the mark of its session in the sidebar knocks once. A soft
// double knock can be heard too, if the human switched that on (it is off by default; the switch is
// in the menu behind the logo, js/bar.js). Under reduced motion nothing moves; the label says it.
//
// What counts as a knock is decided in one place (ui.js isKnock). The first state that arrives
// knocks for nothing: only what comes in, or turns urgent, while the page is open does.

import { subscribe, isLoaded } from './store.js'
import { isKnock } from './ui.js'

const SOUND_KEY = 'trommi-knock-sound'
export const knockSound = () => { try { return localStorage.getItem(SOUND_KEY) === 'on' } catch { return false } }
export function setKnockSound(on) {
  try { localStorage.setItem(SOUND_KEY, on ? 'on' : 'off') } catch {}
  if (on) playKnock()   // so the human hears what was switched on
}

// Two soft thumps on wood: a low tone that drops and dies at once, twice.
let audio = null
export function playKnock() {
  try {
    audio ??= new (window.AudioContext ?? window.webkitAudioContext)()
    if (audio.state === 'suspended') audio.resume()
    for (const at of [0, .17]) {
      const t = audio.currentTime + .02 + at
      const tone = audio.createOscillator(), gain = audio.createGain()
      tone.type = 'sine'
      tone.frequency.setValueAtTime(190, t)
      tone.frequency.exponentialRampToValueAtTime(95, t + .09)
      gain.gain.setValueAtTime(.0001, t)
      gain.gain.exponentialRampToValueAtTime(.22, t + .006)
      gain.gain.exponentialRampToValueAtTime(.0001, t + .13)
      tone.connect(gain).connect(audio.destination)
      tone.start(t)
      tone.stop(t + .16)
    }
  } catch {}
}

let known = null   // ids of the knocks the page has seen; null until the first real state
subscribe(state => {
  if (!isLoaded()) return
  const now = new Map(state.all.cards.filter(c => c.status === 'open' && isKnock(c) && state.all.queue.includes(c.id)).map(c => [c.id, c.agent]))
  const fresh = known ? [...now].filter(([id]) => !known.has(id)) : []
  known = new Set(now.keys())
  if (!fresh.length) return
  if (knockSound()) playKnock()
  // After the lists have drawn the new rows.
  requestAnimationFrame(() => requestAnimationFrame(() => {
    const nodes = fresh.flatMap(([id, agent]) => [
      ...document.querySelectorAll(`.inbox-row[data-id="${CSS.escape(id)}"]`),
      ...document.querySelectorAll(`.agent-row[data-members~="${CSS.escape(agent)}"]`),
    ])
    for (const n of nodes) { n.classList.remove('is-knocking'); void n.offsetWidth; n.classList.add('is-knocking') }
    setTimeout(() => { for (const n of nodes) n.classList.remove('is-knocking') }, 900)
  }))
})
