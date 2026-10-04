// A very big mock room for performance work (?mock=crazy): 30+ sessions with status lines, 5,000 answered cards
// with revisions, hundreds of open cards on the Desk, 50,000 chat messages (one session thread over 2,000).
// Same shape as public/mock/fixture.json (core model, core/README.md).
export function crazyFixture({ sessions = 32, answered = 5000, open = 300, messages = 50000 } = {}) {
  const hex = (n, seed) => { let h = ''; let x = seed * 2654435761 >>> 0; while (h.length < n) { x = (x ^ (x << 13)) >>> 0; x = (x ^ (x >>> 17)) >>> 0; x = (x ^ (x << 5)) >>> 0; h += x.toString(16).padStart(8, '0') } return h.slice(0, n) }
  const now = Date.now()
  const icons = ['draw:flask', 'draw:bug', 'draw:key', 'draw:brush', 'draw:rocket', 'draw:database', 'draw:terminal', 'draw:book', 'draw:bell', 'draw:leaf']
  const me = hex(64, 1)
  const ss = Array.from({ length: sessions }, (_, i) => ({
    agent_device_id: hex(64, 1000 + i), agent_session_id: `agent-${i + 1}`, device_name: `Agent ${i + 1}`, is_active: true, is_online: i % 3 !== 0,
    profile: { model: 'claude-opus-5-5', task: `Aufgabe ${i + 1}`, icon: icons[i % icons.length], agent_name: `Agent ${i + 1}`, parent_session: i > 0 && i % 5 === 0 ? 'agent-1' : null, is_main: i === 0 },
    status_lines: Array.from({ length: 1 + (i % 4) }, (_, k) => ({ id: `s${k}`, label: ['Tests', 'Build', 'Deploy', 'Docs'][k], state: ['working', 'done', 'decision', 'working'][(i + k) % 4], detail: `${(i * 7 + k) % 40}/40`, object_id: null, updated_at: now - k * 60000 })),
    settings: { name: '', desk: 'main', archived: false, group: null, icon: null },
  }))
  let n = 0
  const cards = []
  const mk = (i, isOpen) => {
    const s = ss[i % sessions]
    const id = hex(32, 50000 + i)
    const created = now - (answered + open - i) * 60000
    const options = [{ key: 'a', label: 'Variante A', detail: 'schnell' }, { key: 'b', label: 'Variante B', detail: 'sicher' }, ...(i % 3 ? [] : [{ key: 'c', label: 'Später', detail: '' }])]
    const content = { card_type: i % 11 === 0 ? 'info' : 'decision', title: `Frage ${i + 1}: ${['Welche Variante bauen?', 'Migration jetzt ausführen?', 'Layout für die Übersicht?', 'Zertifikat erneuern?'][i % 4]}`, body: 'Kurze Erklärung zur Frage, zwei Sätze lang. Mehr steht im Gespräch.', options: i % 11 === 0 ? [] : options, sections: null, html: null, allows_multiple: false, recommended: 'b', urgency_reason: '', attachments: [], change_note: '', close_summary: null, withdraw_reason: null, merged_into_object_id: null, merged_from_object_ids: null }
    const v1 = { object_version: 1, version_hash: hex(64, 9e5 + i), previous_version_hash: null, envelope_number: ++n, sent_at: created, object_state: 'open', urgency: i % 17 === 0 ? 'high' : 'normal', content }
    const versions = [v1]
    if (i % 4 === 0) versions.push({ ...v1, object_version: 2, version_hash: hex(64, 8e5 + i), previous_version_hash: v1.version_hash, envelope_number: ++n, sent_at: created + 1000, content: { ...content, body: `${content.body} (überarbeitet)` } })
    const cur = versions.at(-1)
    const card = { object_id: id, agent_device_id: s.agent_device_id, first_envelope_number: v1.envelope_number, created_at: created, versions, answer: null, answers: [], closed_how: null, in_revision: null, timeline_key: `chat:card/${id}`, content_state: 'ok', ...cur.content, object_state: 'open', urgency: cur.urgency, object_version: cur.object_version, version_hash: cur.version_hash, envelope_number: cur.envelope_number, updated_at: cur.sent_at }
    if (!isOpen) {
      const a = { answer_action: content.card_type === 'info' ? 'read' : 'answer', choices: content.card_type === 'info' ? [] : ['a'], note: '', option_notes: {}, attachments: [], marks: [], trusted: false, bound_version_hash: cur.version_hash, bound_object_version: cur.object_version, envelope_number: ++n, envelope_hash: hex(64, 7e5 + i), by_device_id: me, answered_at: created + 5000, taken_back_at: null }
      Object.assign(card, { answer: a, answers: [a], object_state: 'closed', closed_how: a.answer_action === 'read' ? 'read' : 'answered' })
    }
    cards.push(card)
  }
  for (let i = 0; i < answered; i++) mk(i, false)
  for (let i = answered; i < answered + open; i++) mk(i, true)
  const timelines = {}
  for (let k = 0; k < messages; k++) {
    // A third into session 1's own thread (over 2,000 there), the rest spread over sessions and cards.
    const s = k % 3 === 0 ? ss[0] : ss[k % sessions]
    const card = k % 2 ? cards[(k * 7) % cards.length] : null
    const key = card ? `chat:card/${card.object_id}` : `chat:session/${s.agent_device_id}`
    const human = k % 4 === 0
    ;(timelines[key] ??= []).push({ envelope_number: ++n, local_id: null, pending: false, envelope_hash: hex(64, 6e6 + k), sender_device_id: human ? me : (card?.agent_device_id ?? s.agent_device_id), recipient_device_id: human ? (card?.agent_device_id ?? s.agent_device_id) : null, sent_at: now - (messages - k) * 1000, item_state: 'loaded', content_type: 'message', content: { text: human ? `Nachricht ${k}: bitte so machen.` : `Antwort ${k}: **erledigt**, die Tests laufen. Details im Log.` } })
  }
  const members = [{ device_id: me, device_role: 'human', device_name: 'Laptop', is_active: true, added_entry_number: 0, removed_entry_number: null, is_me: true, is_online: true }, ...ss.map((s, i) => ({ device_id: s.agent_device_id, device_role: 'agent', device_name: s.device_name, is_active: true, added_entry_number: i + 1, removed_entry_number: null, is_me: false, is_online: s.is_online, agent_session_id: s.agent_session_id }))]
  return {
    made_at: now, room: { room_id: hex(64, 2), hub_url: 'mock:', my_device_id: me, my_role: 'human', key_epoch: 1, last_entry_number: members.length - 1, last_envelope_number: n, connection: 'live' },
    members, sessions: ss, cards, permissions: [], memos: [], published: [], timelines,
    human: { drafts: {}, snoozes: {}, ducks: {}, crown: { agent_device_id: ss[0].agent_device_id }, desks: {}, session_settings: Object.fromEntries(ss.map(s => [s.agent_device_id, s.settings])), read_up_to: {} },
  }
}
