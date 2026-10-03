// A session's conversation (server/views/session.mjs), on .chat-pane. The hub rendered it and the log stands at its
// end by itself (css: a reversed column). This adds what only the browser knows:
//   - "To the end", with the number of messages that arrived while one was reading further up, and the view
//     that stays where it is when they arrive;
//   - the "N open" chip: only while an open question of the conversation is out of sight, and the way to the next;
//   - the times in this browser's own zone (the hub wrote them in its own).
import { Controller } from '@hotwired/stimulus'

const two = n => String(n).padStart(2, '0')
const FULL = new Intl.DateTimeFormat('en-GB', { dateStyle: 'full', timeStyle: 'short' })
const DAY = new Intl.DateTimeFormat('en-GB', { weekday: 'long', day: 'numeric', month: 'long' })
const dayOf = d => d.getFullYear() * 400 + d.getMonth() * 32 + d.getDate()
function dayLabel(ts) {
  const d = new Date(ts), now = new Date()
  if (dayOf(d) === dayOf(now)) return 'Today'
  if (dayOf(d) === dayOf(new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1))) return 'Yesterday'
  return DAY.format(d)
}
function localise(root) {
  for (const t of root.querySelectorAll?.('time[datetime]') ?? []) {
    const d = new Date(t.dateTime)
    if (Number.isNaN(d.getTime())) continue
    const full = FULL.format(d), text = t.hasAttribute('data-full') ? full : `${two(d.getHours())}:${two(d.getMinutes())}`
    if (t.textContent !== text) t.textContent = text
    if (!t.hasAttribute('data-full') && t.title !== full) t.title = full
  }
  for (const day of root.querySelectorAll?.('.day[data-day]') ?? []) {
    const label = dayLabel(Number(day.dataset.day))
    if (day.firstElementChild && day.firstElementChild.textContent !== label) day.firstElementChild.textContent = label
  }
}

export default class extends Controller {
  static targets = ['log', 'jump', 'jumpText', 'open', 'openText']

  connect() {
    this.pinned = true
    this.unread = 0
    localise(this.element)
    if (!this.hasLogTarget) return   // a list is in view (questions, files): only the times
    this.height = this.logTarget.scrollHeight
    this.seen = new MutationObserver(list => this.arrived(list))
    this.seen.observe(this.logTarget, { childList: true, subtree: true })
    this.sizes = new ResizeObserver(() => this.paint())
    this.sizes.observe(this.logTarget)
    this.paint()
  }
  disconnect() { this.seen?.disconnect(); this.sizes?.disconnect() }

  // (The log is a reversed column: its end is scrollTop 0, further up is negative.)
  get atEnd() { return Math.abs(this.logTarget.scrollTop) < 72 }
  scrolled() {
    this.pinned = this.atEnd
    if (this.pinned) this.unread = 0
    this.paint()
  }
  toEnd() {
    this.pinned = true
    this.unread = 0
    this.logTarget.scrollTo({ top: 0, behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth' })
    this.paint()
  }
  arrived(list) {
    const log = this.logTarget
    let fresh = 0
    for (const change of list) for (const node of change.addedNodes) {
      if (node.nodeType !== 1) continue
      localise(node.matches('time, .day') ? node.parentNode : node)
      // What is put in at the log's end (before its end mark) is new; anything else replaces what stood there, or is earlier.
      if (change.nextSibling?.id?.startsWith?.('log-end-') && node.matches('.msg-agent, .ask, .event')) fresh++
      else if (change.nextSibling?.id?.startsWith?.('log-end-') && node.matches('.msg-user')) { this.pinned = true; this.unread = 0 }
    }
    const grew = log.scrollHeight - this.height
    this.height = log.scrollHeight
    if (this.pinned) log.scrollTop = 0
    else if (fresh) { this.unread += fresh; if (grew > 0) log.scrollTop -= grew }   // reading further up: what is in view stays in view
    this.paint()
  }
  paint() {
    if (!this.hasLogTarget) return
    if (this.hasJumpTarget) {
      this.jumpTarget.hidden = this.pinned
      this.jumpTarget.classList.toggle('has-unread', this.unread > 0)
      this.jumpTextTarget.textContent = this.unread === 0 ? 'To the end' : this.unread === 1 ? '1 new message' : `${this.unread} new messages`
    }
    this.paintOpen()
  }
  openTargetConnected() { if (this.hasLogTarget) this.paintOpen() }

  // The open questions of the conversation that are out of sight, and which of them comes next.
  paintOpen() {
    if (!this.hasOpenTarget) return
    const box = this.logTarget.getBoundingClientRect()
    const away = [...this.logTarget.querySelectorAll('.ask-card')].map(node => ({ node, r: node.getBoundingClientRect() })).filter(({ r }) => r.bottom < box.top + 48 || r.top > box.bottom - 48)
    const below = away.find(({ r }) => r.top > box.top)
    this.next = (below ?? away.at(-1))?.node ?? null
    this.openTarget.hidden = !this.next
    if (!this.next) return
    this.openTarget.classList.toggle('is-up', !below)
    this.openTarget.setAttribute('href', `#${this.next.id}`)
    if (this.hasOpenTextTarget) this.openTextTarget.textContent = `${away.length} open`
    this.openTarget.setAttribute('aria-label', away.length === 1 ? 'One open question out of sight: go to it' : `${away.length} open questions out of sight: go to the next one`)
  }
  toOpen(e) {
    if (!this.next) return
    e.preventDefault()
    this.pinned = false
    this.next.scrollIntoView({ block: 'center', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth' })
    this.next.querySelector('.inbox-row')?.focus({ preventScroll: true })
  }
}
