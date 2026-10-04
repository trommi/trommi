// oracle.mjs: an independent, plain in-memory model of what every member of a room should see, written from the
// README rules (not from client/core/model.mjs). It is fed the intended effect of every action that the real
// client accepted; strict mode (sequential actions, quiesce after each) compares it exactly.
const URG = { low: 0, normal: 1, high: 2, critical: 3 }

export class RoomOracle {
  constructor(idx) {
    this.idx = idx
    this.members = new Map()       // name -> { role, active }
    this.cards = new Map()         // ref -> card
    this.perms = new Map()         // ref -> { agent, state }
    this.memos = new Map()         // ref -> { text, x, y, state, v }
    this.regs = new Map()          // human register key template -> value
    this.agentRegs = new Map()     // agent name -> Map(key -> value)
    this.chat = new Map()          // timeline template ('card/#c1', 'session/@A0') -> [{ id, from, to, text, certain }]
    this.canvas = new Map()        // timeline template -> [{ id, type, stroke_ids, certain }]
    this.refusedForged = 0
    this.order = 0                 // creation order of cards
    this.attempts = new Set()      // cards a human tried to answer / read / shred (valid or not)
    this.memoTexts = new Map()     // memo ref -> Set of texts ever saved
    this.sentTexts = new Set()     // every chat text a member really sent
  }
  active(role) { return [...this.members].filter(([, m]) => m.active && (!role || m.role === role)).map(([n]) => n) }

  // ---- membership ----
  addMember(name, role) { this.members.set(name, { role, active: true }) }
  remove(names) { for (const n of names) { const m = this.members.get(n); if (m) m.active = false } }
  recover(newName) {
    for (const m of this.members.values()) if (m.role === 'human') m.active = false
    this.members.set(newName, { role: 'human', active: true })
  }

  // ---- cards ----
  newCard(ref, agent, f) {
    this.cards.set(ref, { ref, agent, v: 1, title: f.title, card_type: f.card_type, options: f.options.map(o => o.key), allows_multiple: !!f.allows_multiple, urgency: f.urgency, state: 'open', closed_how: null,
      answer: null, revision: null, order: this.order++, titles: new Set([f.title]) })
  }
  revise(ref, f) {
    const c = this.cards.get(ref)
    if (!c || c.state !== 'open') return false
    c.v++; if (f.title !== undefined) { c.title = f.title; c.titles.add(f.title) } if (f.urgency) c.urgency = f.urgency
    c.revision = null
    return true
  }
  withdraw(ref) { const c = this.cards.get(ref); if (!c || c.state !== 'open') return false; c.v++; c.state = 'closed'; c.closed_how = 'withdrawn'; c.revision = null; return true }
  close(ref) {
    const c = this.cards.get(ref)
    if (!c) return false
    c.v++; c.state = 'closed'; c.revision = null
    if (c.closed_how !== 'withdrawn' && c.closed_how !== 'merged') c.closed_how = c.answer?.action === 'read' ? 'read' : c.answer?.action === 'shred' ? 'shredded' : 'closed'
    return true
  }
  /** A human's answer. Returns true if it counts. */
  answer(ref, { action, choices, trusted = false, staleHash = false }) {
    const c = this.cards.get(ref)
    if (!c || c.state !== 'open') return false
    // F15: the owner agent refuses an invalid answer to its open card and sends the card again (one version more), so the
    // hub does not keep it as closed.
    const refused = () => { c.v++; return false }
    if (staleHash) return refused()
    if (action === 'answer' && c.card_type === 'info') return refused()
    if (action === 'answer' && !trusted) {
      if (c.card_type === 'info' || !choices.length || choices.some(k => !c.options.includes(k)) || (choices.length > 1 && !c.allows_multiple)) return refused()
    }
    if (action === 'read' && c.card_type !== 'info') return refused()
    c.answer = { action, choices }
    c.state = action === 'answer' ? 'answered' : 'closed'
    c.closed_how = action === 'read' ? 'read' : action === 'shred' ? 'shredded' : 'answered'
    c.revision = null
    return true
  }
  decideAgain(ref) {
    const c = this.cards.get(ref)
    if (!c || !c.answer) return false
    if (c.state === 'closed' && c.closed_how !== 'read' && c.closed_how !== 'shredded') return false
    c.answer = null; c.state = 'open'; c.closed_how = null
    return true
  }

  // ---- chat / canvas ----
  addChat(tl, item) { this.sentTexts.add(item.text); (this.chat.get(tl) ?? this.chat.set(tl, []).get(tl)).push(item) }
  addCanvas(tl, item) { (this.canvas.get(tl) ?? this.canvas.set(tl, []).get(tl)).push(item) }
  handBack(ref, by) { const c = this.cards.get(ref); if (c) c.revision = by }
  presentCard(ref) { const c = this.cards.get(ref); if (c) c.revision = null }

  // ---- permissions ----
  permRequest(ref, agent) { this.perms.set(ref, { agent, state: 'pending' }) }
  verdict(ref, allow) { const p = this.perms.get(ref); if (!p || p.state !== 'pending') return false; p.state = allow ? 'allowed' : 'denied'; return true }

  // ---- registers ----
  setReg(key, value) { if (value === null || value === undefined) this.regs.set(key, null); else this.regs.set(key, value) }
  setAgentReg(agent, key, value) { const m = this.agentRegs.get(agent) ?? this.agentRegs.set(agent, new Map()).get(agent); m.set(key, value ?? null) }

  /** Expected board stack as card refs: open, not snoozed, session not archived; urgency desc, then creation. */
  stack(resolveSnoozeActive, archivedAgents) {
    return [...this.cards.values()].filter(c => c.state === 'open' && !resolveSnoozeActive(c.ref) && !archivedAgents.has(c.agent))
      .sort((a, b) => URG[b.urgency] - URG[a.urgency] || a.order - b.order).map(c => c.ref)
  }
}
