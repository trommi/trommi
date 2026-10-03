// The pad's link to the board it is served from: who the sessions are and where a
// selection is sent. With no board behind the page (a plain file server, file://)
// everything still works, with sample sessions, and says so.

const SAMPLE_SESSIONS = [
  { id: 'sample-web', name: 'Web frontend', online: true, sample: true },
  { id: 'sample-api', name: 'API', online: true, sample: true },
  { id: 'sample-infra', name: 'Infra', online: false, sample: true },
]

const state = { board: false, sessions: SAMPLE_SESSIONS }
const listeners = new Set()
let store = null   // /js/store.js, when the page runs on a board

export const boardState = () => state
export function onBoard(fn) { listeners.add(fn); fn(state); return () => listeners.delete(fn) }

/** Look for a board. Resolves once it is known whether there is one (at most ~2.5 s). */
export async function connectBoard(embedded = false) {
  if (!/^https?:$/.test(location.protocol)) return state
  // Inside the board the page around the pad already listens to it and passes on what the
  // pad needs (setBoard); a second stream of the whole board would be one connection too many.
  if (embedded) return state
  try {
    // An absolute path on purpose: the pad may be served from /pad/ or from anywhere else.
    store = await import('/js/store.js')
  } catch {
    return state
  }
  store.connect()
  return new Promise(resolve => {
    const timer = setTimeout(() => resolve(state), 2500)
    store.subscribe(s => {
      if (!store.isLoaded()) return
      state.board = true
      state.sessions = s.all.agents.map(a => ({ id: a.id, name: a.name, online: Boolean(a.online) }))
      for (const fn of listeners) fn(state)
      clearTimeout(timer)
      resolve(state)
    })
  })
}

/** What the board around an embedded pad says about itself. */
export function setBoard({ sessions }) {
  state.board = true
  // mark: the session's scribble as the board draws it (an SVG), hue: its colour.
  state.sessions = sessions.map(a => ({ id: a.id, name: a.name, online: Boolean(a.online), mark: a.mark ?? null, hue: a.hue ?? null }))
  for (const fn of listeners) fn(state)
}

/** Send a selection to a session. Resolves with { message_id } or rejects with a
 *  readable Error; it never pretends. payload is described in docs/pad.md. */
export async function sendSelection(payload) {
  if (!state.board) throw new Error('There is no board behind this page, so there is nobody to send to.')
  let res
  try {
    res = await fetch('/pad/send', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) })
  } catch (err) {
    throw new Error(`The board did not answer (${err.message}).`)
  }
  let out = {}
  try { out = await res.json() } catch {}
  if (res.status === 404 && out.error !== 'unknown session') throw new Error('This board has no /pad/send yet (HTTP 404). Nothing was delivered.')
  if (!res.ok) throw new Error(out.error ? `The board refused: ${out.error}` : `The board answered HTTP ${res.status}. Nothing was delivered.`)
  if (!out.message_id) throw new Error('The board answered without a message id, so the delivery is not confirmed.')
  return out
}
