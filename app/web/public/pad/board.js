// The pad's link to the room: the client core it works with, and who the sessions are (where a selection can go).
// Inside the app (the Whiteboard, js/views/whiteboard.mjs) the page around the pad already holds the room: its client
// (window.trommi.client, one per room and device) is used, and the sessions come with the board's context message.
// On its own page (/pad/) the pad opens the room itself, as the app does (or the mock room of this tab).

const state = { board: false, sessions: [] }
const listeners = new Set()
let room = null       // the client core (or the mock room)
let devOf = id => id  // a session's id on the board -> its agent's device id

export const boardState = () => state
export function onBoard(fn) { listeners.add(fn); fn(state); return () => listeners.delete(fn) }
const tellAll = () => { for (const fn of listeners) fn(state) }

/** What the board around an embedded pad says: [{ id, name, online, mark (the board's SVG), hue }]. */
export function setBoard({ sessions }) {
  state.board = true
  state.sessions = sessions.map(a => ({ id: a.id, device: a.device ?? devOf(a.id), name: a.name, online: Boolean(a.online), mark: a.mark ?? null, hue: a.hue ?? null }))
  tellAll()
}

/** The room's client: the app's (embedded), else this page opens it. Null when there is no room on this device. */
export async function connectRoom(embedded) {
  if (embedded) {
    // The app may still be starting: its client appears on window.trommi once the room is open.
    for (let i = 0; i < 200 && !window.parent.trommi?.client; i++) await new Promise(r => setTimeout(r, 50))
    const app = window.parent.trommi
    if (!app?.client) return null
    room = app.client
    devOf = id => app.board?.agentToDev?.get(id) ?? id
    if (state.sessions.length) setBoard({ sessions: state.sessions })
    return room
  }
  try {
    const mock = sessionStorage.getItem('trommi-mock')
    if (mock) room = await (await import('/js/app/mock-room.mjs')).openRoom({ mock })
    else {
      const core = await import('/gen/vendor/index.mjs')
      room = await core.openRoom({ storage: core.idbStorage({ name: 'trommi', prefix: 'room/' }) })
      room.start().catch(err => console.warn('pad: room', err))
    }
  } catch (err) {
    console.warn('pad: no room on this device', err)
    return null
  }
  const names = () => {
    const m = room.model
    state.board = true
    state.sessions = [...m.sessions.values()].filter(s => !m.human.session_settings.get(s.agent_device_id)?.archived).map(s => ({
      id: s.agent_device_id, device: s.agent_device_id, online: Boolean(s.online),
      name: m.human.session_settings.get(s.agent_device_id)?.name || s.profile?.agent_name || s.agent_name || 'Session',
    }))
    tellAll()
  }
  names()
  room.on('change', ch => { if (ch.sessions.size || ch.registers.size) names() })
  return room
}
