#!/usr/bin/env node
// Browser regression suite for the web UI.
//   node dev/ui-test.mjs                    run every group at desktop size, then again at phone size
//   node dev/ui-test.mjs --only inbox       run one group (or several: --only inbox,later); see GROUPS below
//   node dev/ui-test.mjs --size phone       only one of the two sizes (desktop | phone)
//   node dev/ui-test.mjs --keep             leave the board up afterwards and print its link; Ctrl-C stops it
//   node dev/ui-test.mjs --shots DIR        where the screenshots go (default: <tmp>/trommi-ui-test)
//   node dev/ui-test.mjs --script FILE.mjs  after the login, run FILE's default export with the test's tools
//                                           (for looking around by hand: `export default async t => { ... }`)
//
// It starts its own board on a free port with a throwaway data folder: three scripted agents
// (dev/fake-agent.mjs), one session the test steers itself ("Courier": it asks exactly the
// questions a group needs) and one that asks a question and disconnects ("Gone Fishing").
// Then it drives ONE headless Chromium over the DevTools protocol with real mouse, touch and
// key events. Everything it started is stopped and removed again, also when a group fails or
// the run is interrupted. Exit code: 0 when nothing failed, 1 on real failures, 2 when the
// suite itself could not run. A check for a feature that is known to be unfinished is listed
// in PENDING below; it is reported as "pending" with its reason and does not fail the run.
// Needs the command sandbox disabled, like dev/cdp.mjs. No packages beyond the board's own.
import { spawn } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { launchChromium } from './cdp.mjs'

// ---- every selector the test knows about ----------------------------------------
// Behaviour is checked through these; nothing else in the file names a class or an id.
const SEL = {
  loaded: 'html[data-loaded]',
  online: '#conn[data-state="online"]',
  themeToggle: '#theme-toggle',
  toast: '#toast',
  // The way back after an answer: the note that says what happened (its place changed several times), or the page's passing notice.
  undoBar: '.says, .back, #toast[data-kind="undo"]',
  undoSaid: '.says-words b, .back-what b, strong',
  dialogOpen: 'dialog[open]',

  // sidebar
  sidebar: '#agents',
  sidebarRow: '#agents .agent-row',
  sidebarEntry: '#agents .agent-entry',
  sidebarName: '.agent-text strong',
  sidebarMark: '.agent-avatar svg, .agent-pair svg',
  sidebarBadge: '.agent-badge',
  sidebarRing: '.agent-ring',
  sidebarHand: '.hand-mark',
  sidebarHeading: '#agents .agent-heading',
  sidebarAway: '#agents .agent-heading-away',
  sidebarArchive: '.agent-archive',
  sidebarOffline: '.is-offline',
  sidebarCount: '.agent-count',   // the Inbox entry: how many questions are open (session rows carry no number)
  navInbox: '#nav-inbox',
  navRoster: '#nav-roster, #roster-open',   // whichever of the two the layout shows

  // question rows: the inbox, a session's conversation, its "Questions only" list
  inbox: '#inbox',
  inboxCount: '#inbox .inbox-circled',
  goThrough: '#inbox .inbox-walk',
  walk: '#focus-open',
  group: '.inbox-group',
  laterGroup: '.inbox-group-later',
  groupName: '.inbox-sender > span:not(.inbox-avatar)',
  groupCount: '.inbox-sender > b',
  groupVip: '.inbox-sender[data-vip], .inbox-sender .crown-mark, .inbox-sender .inbox-vip',
  // what lies below the open questions, pushed together until it is unfolded: put off, with the agent, answered
  pile: '.inbox-pile',
  pileOpen: '.is-open',
  pileHead: '.inbox-pile-head',
  pileName: '.inbox-pile-head > span:not(.inbox-avatar):not(.inbox-pile-fold)',
  pileCount: '.inbox-pile-head > b',
  pilePeek: '.inbox-pile-peek strong',
  doneRow: '.inbox-done',
  takeBack: '.inbox-takeback',
  rowNr: '.inbox-nr',
  row: '.inbox-row',
  rowTitle: '.inbox-question',
  rowTile: '.inbox-actions > button',
  rowLater: '.inbox-later',
  rowThumbTile: '.is-thumb',
  rowThumb: '.inbox-thumb',
  rowThumbImage: '.inbox-thumb img',
  rowVip: '.inbox-vip, .crown-mark',
  rowFrom: '.inbox-from',
  rowOpen: '.is-open',
  rowCurrent: '.is-current',
  rowOption: '.inbox-option[data-key]',   // the card's own options (beside them: "Send" where several are allowed, and "Trust")
  advised: '.is-advised',
  adviceLoop: '.advice-loop path, .advice-hand path',   // the mark of the agent's advice: a loop drawn round the option, later a small hand on it

  // the window of one card, and the walk through all of them
  focus: '.focus',
  focusCard: '.focus-card[data-shown]',
  focusTitle: '.focus-title',
  focusOption: '.focus-opt',
  focusOptionNote: '.focus-opt-note',
  focusField: '.focus-ask-field',
  focusSend: '.focus-ask-send',
  focusExplain: '.focus-explain',
  focusHand: '.focus-handback',
  focusLater: '.focus-later:not(.focus-explain):not(.focus-handback):not(.focus-shred):not(.focus-whatever)',
  focusShred: '.focus-shred',
  focusTrust: '.focus-trust, .focus-whatever',   // "Trust", later "Whatever": the agent decides itself
  focusDiscuss: '.focus-discuss-toggle',         // opens the column beside the decision where one writes to the agent
  focusMark: '.focus-mark textarea',     // a note written on the card itself
  focusChip: '.focus-chip',              // a file that waits on the card for the next action
  focusPen: '.focus-mark-pen',
  focusInk: '.focus-ink path',
  focusScroll: '.focus-scroll',
  focusRail: '.focus-rail, .focus-more',   // how far the walk is: a rail of marks, later one line "3 more" at the foot
  focusThread: '.focus-thread',
  focusNote: '.focus-says .says',
  // In the walk (one scrolling column of cards) a card that left is a slim strip where it stood, with the way back on it.
  focusAnyCard: '.focus-card',
  focusStrip: '.focus-strip',
  focusStripSaid: '.focus-strip-text b',
  focusList: '.focus[data-list]',
  focusNext: '.focus-nav-next',
  focusPrev: '.focus-nav-prev',
  focusFigure: '.focus-figure',
  focusZoom: '.focus-zoom',
  focusZoomOption: '.focus-zoom-answer .focus-opt:not(.focus-opt-send)',
  focusWait: '.focus-thread-wait',
  noteBack: '.says-back, .focus-strip-back',
  lightbox: 'dialog.lightbox',
  lightboxImage: 'dialog.lightbox .lightbox-img',

  // a session
  session: '#session',
  paneTitle: '#pane-who',
  pane: '.chat-pane',
  log: '.log',
  message: '.log .msg',
  userMessage: '.log .msg-user',
  agentMessage: '.log .msg-agent',
  messageImage: '.log .shot img',
  ask: '.log .ask-open, .log .ask-card',   // an open question in the stream of a conversation
  draft: '.composer textarea',
  send: '.composer .send',
  modeChat: '#mode-chat, #tab-chat',
  modeScribble: '#mode-scribble, #tab-scribble',
  filterQuestions: '#filter-questions',
  filterFiles: '#filter-files',
  filterCount: '#filter-count',
  questionsPane: '.pane-questions',
  filesPane: '.pane-files',
  fileRow: '.file-row',
  fileImage: '.file-row img',
  scribbleCard: '.log .scribble-card',
  scribbleCanvas: '#scribble canvas',
  scribbleSend: '#scribble .scr-send',
  scribbleError: '#scribble .scr-error',

  // agents page
  // The Agents page is the Ledger: one line per session.
  roster: '#ledger',
  rosterCard: '.ledger-line[data-id]',
  rosterName: '.ledger-name strong',
  rosterFact: '.ledger-cell',          // in a line: model, machine, last seen
  rosterStar: '.crown-toggle',
  rosterState: '.ledger-state',
  rosterAnswer: '.ledger-ans',
  rosterHead: '.ledger-th',
  rosterFind: '.ledger-find input',
  rosterOrder: '.ledger-tools .ledger-link',
  rosterSplit: '.ledger-with button',
  rosterCurrent: '.is-cur',
  menuAgents: '#menu-agents',
  deskGo: '#desk-go',
  deskTotal: '#desk-state .agent-count.is-total',
  deskKnocks: '#desk-state .agent-count.is-knock',
  jumpField: '#jump-field',
  quickOpen: '.quick-open',
  quickField: '#quick-field',
  quickSend: '.quick-send',
  quickNote: '.quick-note',
  // a session's own title: its drawing, its crown, its name (the way to these on a phone)
  paneMark: '#pane-who .pane-mark',
  paneCrown: '#pane-who .crown-toggle',
  paneRename: '#pane-who .pane-name button',
  groupQuestions: '.group-questions',
  rowShred: '.inbox-shred',
  crownToggle: '.crown-toggle',
  rosterEdit: '.ledger-mark',
  rosterRename: '.ledger-rename',
  markPicker: 'dialog.mark-picker',
  markTile: 'dialog.mark-picker [role="radio"]',
  rosterAct: '.ledger-ib',
  rosterArchived: '.ledger-line.is-archived',
  editor: 'dialog.session-editor',
  editorName: 'dialog.session-editor input[type="text"]',
  editorSave: 'dialog.session-editor button[type="submit"]',

  // side doors: behind the logo
  brandMenu: '#brand-menu',
  brandDoors: '#brand-doors',
  menuItem: '[role="menuitem"]',
  keysOpen: '#keys-open',
  keysSheet: 'dialog.keys-sheet',
  helpLink: 'a[href*="help"], a[href*="hilfe"]',
  adminLink: 'a[href*="admin"]',
  // the pad, from anywhere
  padOpen: '#pad-open',
  pad: '#padlink',
  assetLink: 'a[href*="/a/"]',
  adminGate: '#gate',
  adminKey: '#gate-key',
  adminOpen: '#gate button',
  adminError: '#gate-error',
  adminMain: '#admin',
  adminSection: '#admin > section',

  // These scroll sideways on purpose; everything else must fit the width of a phone.
  sidewaysOk: '#agents, pre, .hist-tabs, .focus-thumbs, .scr-tools, table',
  // What agents and the human wrote. Everything outside of it is the interface and must be English.
  content: '.inbox-question, .inbox-body, .inbox-more-in, .inbox-answer, .inbox-option, .inbox-pile-peek, .inbox-done, .inbox-sender, .inbox-from, .msg, .event, .ask, .agent-row, .ledger-name, .ledger-does, .ledger-task, .quick-note, .quick-to, .quick-list, .focus-card, .hist-row, .file-row, .adm-card, .adm-log, .adm-stderr, .adm-links, .focus-rail, .focus-strip, .pane-now, #pane-who, .chat-pane-head, #toast strong, .says, .back, pre, code',
}

// Words of the interface the test relies on.
const TEXT = {
  inbox: 'Inbox', later: 'Snooze', back: 'Fetch back', choose: 'Choose', split: 'Split',
  send: 'Send', explain: /^(Explain|What)/, hand: 'Revise', answered: 'Answered', movedLater: 'Snoozed', noteBack: 'Back',
  model: 'Model', machine: 'Machine', unknown: 'unknown',
  // What dev/fake-agent.mjs answers (its script is German).
  heard: 'Verstanden', scribbleSeen: 'Scribble erhalten',
}
// The word for putting a question off changed more than once ("Later", "Snooze"); either is the same control.
const isLater = word => /^(Snooze|Later)/.test(String(word ?? ''))
const isFetch = word => /^(Fetch back|Wake)/.test(String(word ?? ''))
const saysLater = words => /Snoozed|Moved to Later/.test(String(words ?? ''))
// Words that give away an interface string that was not translated.
const GERMAN = /(Posteingang|Gespräch|Fragen\b|Senden|Rückgängig|Später|Agenten|Verbunden|Verbindet|Getrennt|Abbrechen|Löschen|Farbe|Stärke|Verwaltung|Schlüssel|Sitzung|Übersicht|Zurück|Öffnen|Schließen|Nachricht|Zeichnen|Entscheidung|Dunkles|Helles|Ansicht|Bereiche|Rückg|Wiederholen|Einpassen|sendet|für eine|Zum Ende|Zum Board)/

// Checks for what is still being built. A failure whose text ("<group>: <message>") matches is
// reported as pending with the reason, apart from the real regressions. Remove an entry when its
// feature lands; a pending check that passes simply counts as passing.
const PENDING = [
  { match: /one wide "Choose" tile and a small "\w+" arrow instead of two square tiles/, reason: 'the row layout is open: the user said no to the wide tile and moved the question to the layout ticket' },
]

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
// The inbox's name was changed more than once ("Inbox", "Desk"): the app's own word for it is read from its source.
TEXT.inbox = /export const INBOX_WORD = '([^']+)'/.exec(fs.readFileSync(path.join(ROOT, 'client', 'web', 'js', 'ui.js'), 'utf8'))?.[1] ?? TEXT.inbox
const DESKTOP = { width: 1440, height: 900 }
const PHONE = { width: 400, height: 860 }
const PUBLIC = 'https://board.example.test'   // the board's https address, as links to published assets carry it
const PIXEL = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='   // a PNG of one pixel
const COURIER = 'Courier'        // the session the test steers
const GONE = 'Gone Fishing'      // asks one question, then disconnects
const sleep = ms => new Promise(r => setTimeout(r, ms))

// ---- command line ---------------------------------------------------------------

const argv = process.argv.slice(2)
const flag = name => argv.includes(`--${name}`)
const option = name => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : undefined }
const only = (option('only') || process.env.UI_TEST_ONLY || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean)
const sizes = option('size') ? [option('size')] : ['desktop', 'phone']
const keep = flag('keep')
const scriptFile = option('script')

// ---- what runs in the page -------------------------------------------------------
// Small helpers under window.__t so that the checks below stay short. They only read.
const PAGE_LIB = `(() => {
  const SEL = ${JSON.stringify(SEL)}
  const GERMAN = ${GERMAN}
  const vis = n => {
    if (!n || !n.isConnected || n.closest('[hidden]')) return false
    const r = n.getBoundingClientRect()
    const s = getComputedStyle(n)
    return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none'
  }
  const scope = root => (typeof root === 'string' ? document.querySelector(root) : root) ?? document
  const all = (sel, root = document) => [...scope(root).querySelectorAll(sel)].filter(vis)
  const one = (sel, root = document) => all(sel, root)[0] ?? null
  const text = n => (n?.textContent ?? '').replace(/\\s+/g, ' ').trim()
  const label = n => n ? (n.getAttribute('aria-label') || text(n)) : ''
  const box = n => { const r = n.getBoundingClientRect(); const f = v => Math.round(v * 10) / 10; return { left: f(r.left), top: f(r.top), right: f(r.right), bottom: f(r.bottom), width: f(r.width), height: f(r.height) } }
  const describe = n => !n ? 'nothing' : '<' + n.tagName.toLowerCase() + (n.id ? '#' + n.id : '') + (typeof n.className === 'string' && n.className ? '.' + n.className.trim().split(/\\s+/).join('.') : '') + '> "' + text(n).slice(0, 40) + '"'
  const ringed = n => !!one(SEL.adviceLoop, n) || ['::before', '::after'].some(p => { const s = getComputedStyle(n, p); return s.content !== 'none' && parseFloat(s.borderTopWidth) > 0 && s.display !== 'none' })
  const tileInfo = t => ({ name: label(t), box: box(t), disabled: t.disabled, thumb: t.matches(SEL.rowThumbTile), drawn: !!t.querySelector('svg path'), advised: t.matches(SEL.advised), ringed: ringed(t) })
  const rowInfo = n => ({
    id: n.dataset.id, title: text(n.querySelector(SEL.rowTitle)), box: box(n), vip: !!one(SEL.rowVip, n), from: text(n.querySelector(SEL.rowFrom)),
    open: n.matches(SEL.rowOpen), current: n.matches(SEL.rowCurrent), tiles: all(SEL.rowTile, n).map(tileInfo), later: label(one(SEL.rowLater, n)),
    options: all(SEL.rowOption, n).map(o => ({ name: text(o.querySelector('strong') ?? o), advised: o.matches(SEL.advised), ringed: ringed(o) || [...o.querySelectorAll('*')].some(ringed) })),
  })
  window.__t = {
    SEL, vis, all, one, text, label, box, describe,
    byText: (sel, wanted, root = document) => all(sel, root).find(n => text(n).includes(wanted)) ?? null,
    byLabel: (sel, wanted, root = document) => all(sel, root).find(n => label(n) === wanted || text(n) === wanted) ?? null,
    /** Where to click or tap an element: its middle, scrolled into view if needed, and not covered by anything. */
    point(n) {
      if (!n) return { error: 'it is not on the page' }
      if (!vis(n)) return { error: 'it is not visible: ' + describe(n) }
      if (n.disabled) return { error: 'it is disabled: ' + describe(n) }
      let r = n.getBoundingClientRect()
      if (r.top < 0 || r.left < 0 || r.bottom > innerHeight || r.right > innerWidth) {
        n.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' })
        r = n.getBoundingClientRect()
      }
      let x = Math.round(r.left + r.width / 2), y = Math.round(r.top + r.height / 2)
      let hit = document.elementFromPoint(x, y)
      if (!hit || !(n === hit || n.contains(hit))) {
        // Under a bar that is fixed to an edge: bring it to the middle and look again.
        n.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' })
        r = n.getBoundingClientRect()
        x = Math.round(r.left + r.width / 2); y = Math.round(r.top + r.height / 2)
        hit = document.elementFromPoint(x, y)
      }
      if (!hit || !(n === hit || n.contains(hit))) return { error: describe(n) + ' is covered by ' + describe(hit) + ' at ' + x + ',' + y }
      return { x, y, box: box(n) }
    },
    /** True when nothing on the page is still sliding or fading (endless spinners do not count, nor does the clock of the way back). */
    still: () => document.getAnimations().every(a => a.playState !== 'running' || a.effect?.getComputedTiming().endTime === Infinity || a.effect?.target?.closest?.(SEL.undoBar)),
    place: () => ({ path: location.pathname, view: document.body.dataset.view ?? '', filter: document.body.dataset.filter ?? '', page: document.body.dataset.page ?? '', scope: document.body.dataset.scope ?? '' }),

    entry: name => all(SEL.sidebarEntry).find(n => text(n.querySelector(SEL.sidebarName)).replace(/^★ /, '') === name) ?? null,
    unit: name => __t.entry(name)?.closest(SEL.sidebarRow) ?? null,
    /** The sidebar from top to bottom: headings and rows, as the eye meets them. */
    sidebar: () => all(SEL.sidebarHeading + ', ' + SEL.sidebarRow).map(n => {
      if (n.matches(SEL.sidebarHeading)) return { heading: text(n), away: n.matches(SEL.sidebarAway) }
      const badge = one(SEL.sidebarBadge, n)
      return {
        name: text(n.querySelector(SEL.sidebarName)), members: (n.dataset.members ?? '').split(' ').filter(Boolean), current: !!n.querySelector('[aria-current]'),
        mark: !!n.querySelector(SEL.sidebarMark)?.querySelector('path'), archive: !!one(SEL.sidebarArchive, n), offline: n.matches(SEL.sidebarOffline), count: text(one(SEL.sidebarCount, n)),
        badge: badge && { state: badge.dataset.state ?? '', hand: badge.dataset.state === 'waiting' || !!badge.querySelector(SEL.sidebarHand), ring: badge.dataset.state === 'running' || !!badge.querySelector(SEL.sidebarRing), number: text(badge.querySelector('b')), title: badge.title },
      }
    }),

    row: (id, root = SEL.inbox) => all(SEL.row, root).find(n => n.dataset.id === id) ?? null,
    tile: (id, which, root = SEL.inbox) => { const r = __t.row(id, root); const tiles = r ? all(SEL.rowTile, r) : []; return (which === 'right' ? tiles.at(-1) : tiles[0]) ?? null },
    later: (id, root = SEL.inbox) => { const r = __t.row(id, root); return r ? one(SEL.rowLater, r) : null },
    rows: (root = SEL.inbox) => all(SEL.row, root).map(rowInfo),
    rowInfo: (id, root = SEL.inbox) => { const r = __t.row(id, root); return r ? rowInfo(r) : null },
    // The questions of one sender stand together: under a heading with its name and count, or (one list without
    // headings) in a section that names them for a screen reader, each row saying who asked.
    // A pile (Later, With the agent, Answered) keeps its rows also while it is pushed together; they are listed either way.
    groups: (root = SEL.inbox) => all(SEL.group, root).map(g => { const pile = g.matches(SEL.pile); const said = /^(.*): (\\d+) questions?$/.exec(g.getAttribute('aria-label') ?? '') ?? []; return { name: text((pile ? g.querySelector(SEL.pileName) : null) ?? g.querySelector(SEL.groupName)) || (said[1] ?? ''), count: text(g.querySelector(pile ? SEL.pileCount : SEL.groupCount)) || (said[2] ?? ''), pile: g.dataset.pile ?? '', open: !pile || g.matches(SEL.pileOpen), later: g.matches(SEL.laterGroup), vip: !!one(SEL.groupVip, g), ids: (pile ? [...g.querySelectorAll(SEL.row + ', ' + SEL.doneRow)] : all(SEL.row, g)).map(n => n.dataset.id).filter(Boolean), peeks: pile ? [...g.querySelectorAll(SEL.pilePeek)].map(text) : [] } }),
    pileOf: kind => all(SEL.pile).find(g => g.dataset.pile === kind) ?? null,
    /** Which answer tile lies under a point of the screen. */
    tileAt(x, y) {
      const hit = document.elementFromPoint(x, y)
      const tile = hit?.closest(SEL.rowTile)
      const row = tile?.closest(SEL.row)
      if (!tile || !row) return { hit: describe(hit) }
      return { hit: describe(hit), row: row.dataset.id, name: label(tile), right: all(SEL.rowTile, row).at(-1) === tile, box: box(tile) }
    },
    focusOpen: () => { const f = document.querySelector(SEL.focus); return !!f && vis(f) && !f.hasAttribute('data-closing') },
    focusState() {
      if (!__t.focusOpen()) return null
      const card = one(SEL.focusCard, SEL.focus)
      return { id: card?.dataset.id ?? null, title: text(card?.querySelector(SEL.focusTitle)), single: 'single' in document.querySelector(SEL.focus).dataset, layout: card?.dataset.opts ?? '', options: card ? all(SEL.focusOption, card).map(o => ({ name: label(o), advised: o.matches(SEL.advised), box: box(o) })) : [] }
    },
    /** What of the page behind a window can still be reached. Empty when the page is inert. */
    reachableBehind() {
      const f = document.querySelector(SEL.focus)
      const out = [...document.body.children].filter(n => n !== f && vis(n) && !n.inert && !n.matches(SEL.toast)).map(describe)
      const toggle = document.querySelector(SEL.themeToggle)
      const before = document.activeElement
      toggle.focus()
      if (document.activeElement === toggle) out.push('the theme toggle takes the keyboard focus')
      before?.focus?.({ preventScroll: true })
      return out
    },
    /** The note that says what just happened, in the window or on the page: its words and whether it offers the way back. */
    noteNode: (inWindow = false, title = '') => (inWindow ? (all(SEL.focusStrip).findLast(n => text(n).includes(title)) ?? one(SEL.focusNote)) : one(SEL.undoBar)),
    note: (inWindow = false, title = '') => { const n = __t.noteNode(inWindow, title); return n && { text: text(n.querySelector(SEL.focusStripSaid) ?? n.querySelector(SEL.undoSaid) ?? n), all: text(n), back: !!one(SEL.noteBack, n), strip: n.matches(SEL.focusStrip), box: box(n) } },
    inPile: (kind, id) => !!__t.pileOf(kind) && [...__t.pileOf(kind).querySelectorAll(SEL.row + ', ' + SEL.doneRow)].some(n => n.dataset.id === id),
    openCount: () => Number(/^\\((\\d+)/.exec(document.title)?.[1] ?? 0),
    pane: id => all(SEL.pane).find(p => p.dataset.agent === id) ?? null,
    roster: () => all(SEL.rosterCard).map(c => ({
      name: text(c.querySelector(SEL.rosterName)),
      id: c.dataset.id, state: c.dataset.state ?? text(c.querySelector(SEL.rosterState)), count: text(c.querySelector(SEL.rosterState + ' b')), current: c.matches(SEL.rosterCurrent),
      // (A narrow window drops the columns of model and machine; what the line holds is read either way.)
      facts: (cells => ({ Model: text(cells[0]), Machine: text(cells[1]) }))(c.querySelectorAll(SEL.rosterFact)),
      starred: c.querySelector(SEL.rosterStar)?.getAttribute('aria-pressed') === 'true',
      mark: [...(c.querySelector(SEL.rosterEdit)?.querySelectorAll('path') ?? [])].map(p => p.getAttribute('d')).join(' '),
      acts: all(SEL.rosterAct, c).map(label),
    })),
    rosterCard: name => all(SEL.rosterCard).find(c => text(c.querySelector(SEL.rosterName)) === name) ?? null,
    /** Scroll every picture into view, give it time to load, and report its real size. */
    async pictures(sel, root = document) {
      const out = []
      for (const img of all(sel, root)) {
        img.scrollIntoView({ block: 'center', behavior: 'instant' })
        for (let i = 0; i < 80 && !img.complete; i++) await new Promise(r => setTimeout(r, 50))
        out.push({ src: img.getAttribute('src'), width: img.naturalWidth, shown: Math.round(img.getBoundingClientRect().width), complete: img.complete, in: describe(img.closest(SEL.row + ', ' + SEL.message + ', ' + SEL.focusCard) ?? img.parentElement) })
      }
      return out
    },
    /** Everything that makes the page wider than the screen. Empty when nothing overflows. */
    overflow() {
      const vw = document.documentElement.clientWidth
      const out = []
      for (const n of [document.documentElement, document.body]) if (n.scrollWidth > vw + 1) out.push(describe(n) + ' is ' + n.scrollWidth + 'px wide on a ' + vw + 'px screen')
      // (Only measured, never scrolled: a scroll made by script right before a tap makes Chromium drop the click.)
      if (window.scrollX) out.push('the page itself is scrolled sideways')
      for (const n of document.body.querySelectorAll('*')) {
        if (!vis(n) || n.closest(SEL.sidewaysOk) || n.closest('svg')) continue
        const s = getComputedStyle(n)
        if (/auto|scroll/.test(s.overflowX) && n.scrollWidth > n.clientWidth + 1) out.push(describe(n) + ' scrolls sideways: ' + n.scrollWidth + 'px of content in ' + n.clientWidth + 'px')
        const r = n.getBoundingClientRect()
        if (r.right <= vw + 1 && r.left >= -1) continue
        let clipped = s.position === 'fixed' && (r.left >= vw || r.right <= 0)
        for (let p = n.parentElement; p && p !== document.body && !clipped; p = p.parentElement) clipped = getComputedStyle(p).overflowX !== 'visible'
        if (!clipped) out.push(describe(n) + ' reaches from ' + Math.round(r.left) + ' to ' + Math.round(r.right) + ' on a ' + vw + 'px screen')
      }
      return out.slice(0, 6)
    },
    /** Interface strings on screen that are not English: visible text, labels, tooltips, placeholders. */
    german() {
      const out = new Set()
      const mine = n => !n.closest(SEL.content)
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
      for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        const p = n.parentElement
        if (!p || /^(SCRIPT|STYLE)$/.test(p.tagName) || !vis(p) || !mine(p)) continue
        if (GERMAN.test(n.nodeValue)) out.add(n.nodeValue.trim().slice(0, 50))
      }
      for (const n of document.body.querySelectorAll('[aria-label], [title], [placeholder]')) {
        if (!vis(n) || !mine(n)) continue
        for (const a of ['aria-label', 'title', 'placeholder']) { const v = n.getAttribute(a); if (v && GERMAN.test(v)) out.add(a + '="' + v.slice(0, 50) + '"') }
      }
      return [...out].slice(0, 8)
    },
  }
})()`

// ---- the run: results, processes, cleanup ---------------------------------------

class Failed extends Error {}
const results = []        // { name, size, passed, failures: [text], ms }
let current = null        // the group that is running

/** A check that does not stop the group: the rest of the group still says something. */
function check(ok, message) {
  if (ok) current.passed++
  else current.failures.push(message)
  return Boolean(ok)
}
/** A condition the rest of the group depends on. */
function need(ok, message) {
  if (!ok) throw new Failed(message)
}
const passed = () => { current.passed++ }
/** Something worth saying that is neither a pass nor a failure, e.g. a retry the harness needed. */
const note = message => { current.notes.push(message) }
const same = (a, b, tolerance = 1) => Math.abs(a - b) <= tolerance

const children = []       // every process started here: { proc, name, log }
const tempDirs = []
let browser = null
let watcher = null
let cleaned = false

const alive = proc => proc.exitCode == null && proc.signalCode == null
function signalAll(sig) {
  // Each child leads its own process group, so its server.mjs goes with it.
  for (const { proc } of children) if (proc.pid && alive(proc)) { try { process.kill(-proc.pid, sig) } catch {} }
}
async function cleanup() {
  if (cleaned) return
  cleaned = true
  watcher?.stop()
  try { await browser?.close() } catch {}
  signalAll('SIGTERM')
  for (let i = 0; i < 30 && children.some(c => alive(c.proc)); i++) await sleep(100)
  signalAll('SIGKILL')
  for (const dir of tempDirs) for (let i = 0; i < 5; i++) { try { fs.rmSync(dir, { recursive: true, force: true }); break } catch { await sleep(200) } }
}
let interrupted = null
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, async () => { if (interrupted) return interrupted(); await cleanup(); process.exit(130) })
for (const event of ['uncaughtException', 'unhandledRejection']) process.on(event, async err => { console.error(`the suite itself broke: ${err?.stack ?? err}`); await cleanup(); process.exit(2) })
// Last resort: nothing may be left running or lying around.
process.on('exit', () => {
  if (cleaned) return
  signalAll('SIGKILL')
  if (browser?.pid) { try { process.kill(-browser.pid, 'SIGKILL') } catch {} }
  for (const dir of [...tempDirs, browser?.profile]) if (dir) { try { fs.rmSync(dir, { recursive: true, force: true }) } catch {} }
})

function start(name, args, env) {
  const proc = spawn(process.execPath, args, { cwd: ROOT, env, stdio: ['pipe', 'pipe', 'pipe'], detached: true })
  const child = { proc, name, log: '' }
  proc.stderr.on('data', chunk => { child.log += chunk })
  proc.on('error', err => { child.log += `\n${err.message}` })
  children.push(child)
  return child
}
async function stop(child) {
  if (child.proc.pid && alive(child.proc)) { try { process.kill(-child.proc.pid, 'SIGTERM') } catch {} }
  for (let i = 0; i < 30 && alive(child.proc); i++) await sleep(100)
  if (alive(child.proc)) { try { process.kill(-child.proc.pid, 'SIGKILL') } catch {} }
}

async function freePort() {
  for (;;) {
    const port = await new Promise((resolve, reject) => {
      const probe = net.createServer()
      probe.once('error', reject)
      probe.listen(0, '127.0.0.1', () => { const { port } = probe.address(); probe.close(() => resolve(port)) })
    })
    // Never the ports of a real board, of server/test.mjs or of the demo.
    if (![8790, 8791, 8795].includes(port)) return port
  }
}

/** Follow the board's state as the server sends it, the same stream the page reads. */
async function watchState(base, cookie) {
  const stopper = new AbortController()
  const res = await fetch(`${base}/events`, { headers: { cookie }, signal: stopper.signal })
  if (!res.ok) throw new Error(`the board refused the test's own login: ${res.status}`)
  const watch = { state: null, stop: () => stopper.abort() }
  ;(async () => {
    const decoder = new TextDecoder()
    let buffer = ''
    try {
      for await (const chunk of res.body) {
        buffer += decoder.decode(chunk, { stream: true })
        for (let at; (at = buffer.indexOf('\n\n')) >= 0;) {
          const frame = buffer.slice(0, at)
          buffer = buffer.slice(at + 2)
          if (frame.startsWith('data: ')) watch.state = JSON.parse(frame.slice(6))
        }
      }
    } catch {}
  })()
  return watch
}

/** A session without a script: the server's own MCP, spoken by hand. Returns { tool(name, args), ask(card), stop() }. */
async function startSession(name, env) {
  const child = start(name, [path.join(ROOT, 'server', 'server.mjs')], { ...env, BOARD_AGENT: name })
  const waiting = new Map()
  let seq = 0
  let buffer = ''
  child.proc.stdout.on('data', chunk => {
    buffer += chunk
    for (let at; (at = buffer.indexOf('\n')) >= 0;) {
      const line = buffer.slice(0, at).trim()
      buffer = buffer.slice(at + 1)
      if (!line) continue
      let msg
      try { msg = JSON.parse(line) } catch { continue }
      if (msg.id != null && waiting.has(msg.id)) { waiting.get(msg.id)(msg); waiting.delete(msg.id) }
    }
  })
  const write = msg => child.proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...msg }) + '\n')
  const request = (method, params) => new Promise((resolve, reject) => {
    const id = ++seq
    const timer = setTimeout(() => reject(new Error(`${name}: no answer to ${method}`)), 10000)
    waiting.set(id, msg => { clearTimeout(timer); resolve(msg) })
    write({ id, method, params })
  })
  await request('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'ui-test', version: '0' } })
  write({ method: 'notifications/initialized' })
  const tool = async (toolName, args) => {
    // Right after the start the session may not be linked to the hub yet.
    let last = ''
    for (let i = 0; i < 40; i++) {
      const out = await request('tools/call', { name: toolName, arguments: args })
      const text = out.result?.content?.[0]?.text ?? ''
      if (out.result && !out.result.isError) return text
      last = out.error?.message ?? text
      await sleep(250)
    }
    throw new Error(`${name}: ${toolName} failed: ${last}`)
  }
  /** File a question and wait until the board lists it. Returns the card as the server reports it. */
  const ask = async card => {
    const id = (await tool('create_decision', card)).match(/^card (\w+) /)?.[1]
    if (!id) throw new Error(`${name}: create_decision did not name its card`)
    return waitState(`the card "${card.title}"`, s => s.cards.find(c => c.id === id))
  }
  return { child, tool, ask, stop: () => stop(child) }
}

// ---- the board under test --------------------------------------------------------

const PERSONAS = ['web', 'api', 'infra']
let base = ''
let token = ''
let adminKey = ''
let port = 0
let courier = null
let workDir = ''

async function startBoard() {
  port = await freePort()
  token = crypto.randomBytes(12).toString('hex')
  adminKey = crypto.randomBytes(12).toString('hex')
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'trommi-ui-test-data-'))
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'trommi-ui-test-work-'))
  tempDirs.push(dataDir, workDir)
  base = `http://127.0.0.1:${port}`
  const env = { ...process.env, BOARD_PORT: String(port), BOARD_HOST: '127.0.0.1', BOARD_DATA: dataDir, BOARD_TOKEN: token, BOARD_ADMIN_TOKEN: adminKey, BOARD_PUBLIC_URL: PUBLIC }
  // No speech: its buttons need a key and a service outside of this machine.
  delete env.TINFOIL_API_KEY
  delete env.BOARD_AGENT
  delete env.BOARD_HUB_ONLY
  const cookie = `board_${port}=${token}`
  const until = async (what, fn, ms = 30000) => {
    const end = Date.now() + ms
    for (;;) {
      const value = await fn()
      if (value) return value
      const dead = children.find(c => !alive(c.proc) && !c.mayStop)
      if (dead) throw new Error(`${dead.name} stopped while the board was starting:\n${dead.log}`)
      if (Date.now() > end) throw new Error(`the board did not come up: ${what}\n${children.map(c => `--- ${c.name}\n${c.log}`).join('\n')}`)
      await sleep(100)
    }
  }
  // One after the other, as dev/trio.sh does: the first becomes the hub, and the order of the sessions is fixed.
  for (const [i, who] of PERSONAS.entries()) {
    start(who, [path.join(ROOT, 'dev', 'fake-agent.mjs'), who], env)
    if (i === 0) {
      await until('nothing answers on the port', () => fetch(`${base}/`).then(r => r.status === 401, () => false))
      watcher = await watchState(base, cookie)
    }
    await until(`session ${i + 1} is not listed`, () => watcher.state?.agents.length === i + 1)
  }
  await until('the scripted agents did not finish their start', () => children.every(c => c.log.includes('is up')), 45000)

  // The session the test steers: pictures and a file in its conversation, and one question that blocks it.
  fs.writeFileSync(path.join(workDir, 'release-notes.txt'), 'Notes for the UI test.\n')
  courier = await startSession(COURIER, env)
  await courier.tool('introduce', { model: 'no model', task: 'Asks what the UI test needs' })
  await courier.tool('set_status', { id: 'fixture', label: 'Fixture', state: 'working', detail: 'waiting for the test' })
  await courier.tool('reply', { text: 'Two pictures and a file for the test.', attachments: [path.join(ROOT, 'demo', 'thema-hell.png'), path.join(ROOT, 'demo', 'thema-dunkel.png'), path.join(workDir, 'release-notes.txt')] })
  await courier.ask({ title: 'May I go on? Everything of mine waits on this.', body: 'A blocking question, so that this session shows as stopped.', urgency: 'critical', urgency_reason: 'nothing moves without it', options: [{ key: 'a', label: 'Go on with plan A', detail: 'the careful one' }, { key: 'b', label: 'Go on with plan B', detail: 'the quick one' }, { key: 'stop', label: 'Stop here' }] })

  // And one that asks something and is gone.
  const gone = await startSession(GONE, env)
  gone.child.mayStop = true
  await gone.tool('introduce', { model: 'no model', task: 'Left before the answer came' })
  await gone.tool('reply', { text: 'I ask one thing and then my connection drops.' })
  await gone.ask({ title: 'Keep the nightly job?', options: [{ key: 'yes', label: 'Yes' }, { key: 'no', label: 'No' }] })
  await gone.stop()
  await until(`"${GONE}" still counts as connected`, () => agentNamed(GONE)?.online === false, 15000)
}

const state = () => watcher.state
const nameOf = agent => agent.label || agent.name
const agentNamed = name => state().agents.find(a => a.name === name || a.label === name)
const agentById = id => state().agents.find(a => a.id === id)
const cardOf = id => state().cards.find(c => c.id === id)
const openCards = agentId => state().queue.map(cardOf).filter(c => c && c.status === 'open' && (!agentId || c.agent === agentId))
const pictures = card => (card.attachments ?? []).filter(a => a.kind === 'image' || a.image)
const plain = text => String(text ?? '').replace(/[*`]/g, '')
const scripted = () => state().agents.filter(a => ![COURIER, GONE].includes(a.name))
const putOff = new Set()   // cards the test put off with "Later"
let serial = 0
const tag = () => `${size} ${++serial}`

async function waitState(what, fn, ms = 8000) {
  const end = Date.now() + ms
  for (;;) {
    const value = fn(state())
    if (value) return value
    if (Date.now() > end) throw new Failed(`the server never reported: ${what}`)
    await sleep(40)
  }
}

// Questions the Courier files for a group. Each group asks for what it needs, so groups run alone.
const YES_NO = [{ key: 'yes', label: 'Yes' }, { key: 'no', label: 'No' }]
const fixture = {
  quick: (title, extra = {}) => courier.ask({ title, options: YES_NO, ...extra }),
  worded: (title, extra = {}) => courier.ask({ title, options: [{ key: 'ship', label: 'Ship it' }, { key: 'hold', label: 'Hold back' }], ...extra }),
  light: (title, extra = {}) => courier.ask({
    title, body: 'A question with a little text and three options. It unfolds in its row.', recommended: 'mid',
    options: [{ key: 'small', label: 'Small', detail: 'the least work' }, { key: 'mid', label: 'Medium', detail: 'what I would do' }, { key: 'large', label: 'Large', detail: 'everything at once' }], ...extra,
  }),
  heavy: (title, extra = {}) => courier.ask({
    title, recommended: 'batch',
    body: 'A question with code and two pictures. It is too much for a row and opens as a window.\n\n```\nALTER TABLE cards ADD COLUMN urgency text NOT NULL DEFAULT \'normal\';\n```',
    attachments: [path.join(ROOT, 'demo', 'phone-gespraech.png'), path.join(ROOT, 'demo', 'phone-entscheidungen.png')],
    options: [{ key: 'now', label: 'Run it now', detail: 'short lock' }, { key: 'night', label: 'Tonight at 02:00', detail: 'nobody notices' }, { key: 'batch', label: 'In batches', detail: 'two hours of work' }, { key: 'cancel', label: 'Do not run it' }], ...extra,
  }),
}

// ---- the browser -----------------------------------------------------------------

let page = null
let touch = false
let size = 'desktop'
let shotDir = ''
let shotCount = 0
const shots = []
let problems = []              // uncaught errors and failed requests since the last group ended
let tolerate = null            // while a refusal is tested: which failures are meant
const urlOf = new Map()        // request id -> url
const seen = []                // urls of every response, to wait for a request
let lastDocument = null        // status of the last page that was loaded
let redirects = []

const ours = url => String(url ?? '').startsWith(base)
function problem(kind, text, entry = {}) {
  if (tolerate?.(entry)) return
  problems.push(`${kind}: ${text}`)
}

async function openBrowser() {
  // Headless Chromium reports no pointer at all; a desktop has a mouse that can hover. The page
  // depends on it (Enter sends only with a fine pointer). Touch emulation overrides it at phone size.
  browser = await launchChromium({ ...DESKTOP, args: ['--blink-settings=primaryPointerType=4,availablePointerTypes=4,primaryHoverType=2,availableHoverTypes=2'] })
  page = await browser.page()
  page.on('Runtime.exceptionThrown', ({ exceptionDetails: d }) => problem('uncaught error', `${d.exception?.description ?? d.text} at ${d.url ?? ''}:${d.lineNumber ?? ''}`))
  page.on('Runtime.consoleAPICalled', p => {
    if (p.type === 'error' || p.type === 'assert') problem('console.error', p.args.map(a => a.value ?? a.description ?? '').join(' '))
  })
  page.on('Log.entryAdded', ({ entry }) => {
    // The fonts come from another host, which the test blocks; that is not the board's failure.
    if (entry.level !== 'error' || (entry.url && !ours(entry.url))) return
    problem('browser error', `${entry.text} ${entry.url ?? ''}`, { status: Number(/status of (\d+)/.exec(entry.text)?.[1]) || 0, url: entry.url })
  })
  page.on('Network.requestWillBeSent', p => {
    urlOf.set(p.requestId, p.request.url)
    if (p.redirectResponse) redirects.push({ status: p.redirectResponse.status, from: p.redirectResponse.url, to: p.request.url })
  })
  page.on('Network.responseReceived', p => {
    const { status, url } = p.response
    seen.push(url)
    if (p.type === 'Document') lastDocument = { status, url }
    if (ours(url) && (status < 200 || status > 399)) problem('failed request', `${status} ${url.slice(base.length)}`, { status, url })
  })
  page.on('Network.loadingFailed', p => {
    const url = urlOf.get(p.requestId)
    // Cancelled: the page was reloaded while its event stream was open. Blocked: the fonts.
    if (p.canceled || p.blockedReason || !ours(url)) return
    problem('failed request', `${p.errorText} ${url.slice(base.length)}`, { url })
  })
  for (const domain of ['Page', 'Runtime', 'Network', 'Log']) await page.send(`${domain}.enable`)
  // The test must not depend on the internet; the page then uses its fallback fonts.
  await page.send('Network.setBlockedURLs', { urls: ['*fonts.googleapis.com*', '*fonts.gstatic.com*'] })
  await page.send('Page.addScriptToEvaluateOnNewDocument', { source: PAGE_LIB })
  await setSize('desktop')
}

async function setSize(which) {
  size = which
  touch = which === 'phone'
  const { width, height } = touch ? PHONE : DESKTOP
  await page.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: touch ? 2 : 1, mobile: touch })
  await page.send('Emulation.setTouchEmulationEnabled', touch ? { enabled: true, maxTouchPoints: 5 } : { enabled: false })
}

/** Run an expression in the page and return its value. */
async function ev(expression) {
  const res = await page.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
  if (res.exceptionDetails) throw new Error(`in the page: ${res.exceptionDetails.exception?.description ?? res.exceptionDetails.text}\n  ${expression}`)
  return res.result.value
}
/** js`__t.row(${id})`: an expression for the page with the values safely written in. */
const js = (parts, ...values) => parts.reduce((out, part, i) => out + JSON.stringify(values[i - 1]) + part)

async function waitFor(what, expression, ms = 8000) {
  const end = Date.now() + ms
  for (;;) {
    const value = await ev(expression)
    if (value) return value
    if (Date.now() > end) throw new Failed(`waited ${ms / 1000} s in vain: ${what}`)
    await sleep(40)
  }
}
/** The same as a check: a wait that failed is noted and the group goes on. */
const expect = (what, expression, ms = 4000) => waitFor(what, expression, ms).then(v => { current.passed++; return v }, e => { if (!(e instanceof Failed)) throw e; current.failures.push(e.message); return null })
/** Wait until nothing slides or fades any more, so that positions mean something. */
async function settle() {
  for (let i = 0; i < 60; i++) {
    if (await ev('__t.still()')) break
    await sleep(40)
  }
  // On a phone the strip of sessions glides to the chosen one after a load. A tap that falls into that
  // glide only stops it (Chromium gives no click), so wait until the strip rests.
  if (touch) {
    const at = () => ev(js`document.querySelector(${SEL.sidebar})?.scrollLeft ?? 0`).catch(() => 0)
    for (let i = 0, last = await at(); i < 15; i++) { await sleep(90); const now = await at(); if (now === last) break; last = now }
  }
  await ev('new Promise(r => requestAnimationFrame(() => requestAnimationFrame(() => r(true))))')
}

let lastTouch = 0
async function pressAt(x, y, { move = true } = {}) {
  if (touch) {
    // A finger: it stays down for a moment, and two touches never follow each other within
    // the time in which Chromium would read them as one double tap and swallow the click.
    await sleep(Math.max(0, lastTouch + 350 - Date.now()))
    await page.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] })
    await sleep(50)
    await page.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
    lastTouch = Date.now()
    return
  }
  if (move) await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y })
  await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 })
  await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 })
}
/** Click (or tap, at phone size) the element an expression names, the way a hand would: at a point of the screen. */
async function press(what, expression) {
  await settle()
  const at = await ev(`__t.point(${expression})`)
  if (at.error) throw new Failed(`cannot press ${what}: ${at.error}`)
  await pressAt(at.x, at.y)
  return at
}
async function key(name, code, extra = {}) {
  const event = { key: name, code: name, windowsVirtualKeyCode: code, nativeVirtualKeyCode: code, ...extra }
  await page.send('Input.dispatchKeyEvent', { type: extra.text ? 'keyDown' : 'rawKeyDown', ...event })
  await page.send('Input.dispatchKeyEvent', { type: 'keyUp', ...event })
}
const escape = () => key('Escape', 27)
const type = text => page.send('Input.insertText', { text })
/** Replace whatever the focused field holds. */
async function retype(text) {
  await key('a', 65, { modifiers: 2, commands: ['selectAll'] })
  await type(text)
}

/** Move the mouse or a finger through points of the screen with the button (the finger) down: a stroke, or a drag. */
async function drag(points, { hold = 0, pause = 16, rest: still = 0 } = {}) {
  const [first, ...rest] = points
  if (touch) {
    await sleep(Math.max(0, lastTouch + 350 - Date.now()))
    await page.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [first] })
    if (hold) await sleep(hold)
    for (const p of rest) { await page.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [p] }); await sleep(pause) }
    if (still) { await sleep(still); await page.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [rest.at(-1)] }); await sleep(still) }
    await page.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
    lastTouch = Date.now()
    return
  }
  await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...first })
  await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...first, button: 'left', buttons: 1, clickCount: 1 })
  if (hold) await sleep(hold)
  for (const p of rest) { await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...p, button: 'left', buttons: 1 }); await sleep(pause) }
  await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...rest.at(-1), button: 'left', clickCount: 1 })
}
const line = (from, to, steps = 10) => Array.from({ length: steps + 1 }, (_, i) => ({ x: Math.round(from.x + (to.x - from.x) * i / steps), y: Math.round(from.y + (to.y - from.y) * i / steps) }))

/** Hold every request to a URL pattern back for a while, as a slow line would. Returns the function that ends it. */
async function hold(urlPattern, ms) {
  await page.send('Fetch.enable', { patterns: [{ urlPattern }] })
  const off = page.on('Fetch.requestPaused', async p => { await sleep(ms); page.send('Fetch.continueRequest', { requestId: p.requestId }).catch(() => {}) })
  return async () => { off(); await page.send('Fetch.disable').catch(() => {}) }
}

/** A screenshot of the step. On the phone every one of them also proves that nothing is wider than the screen. */
async function shot(name, { overflow = true } = {}) {
  const file = path.join(shotDir, `${String(++shotCount).padStart(3, '0')}-${size}-${current?.name ?? 'run'}-${name}.png`)
  try {
    const out = await page.send('Page.captureScreenshot', { format: 'png' })
    fs.writeFileSync(file, Buffer.from(out.data, 'base64'))
    shots.push(file)
  } catch (err) {
    console.log(`      (no screenshot ${name}: ${err.message})`)
  }
  if (touch && overflow && current) {
    const out = await ev('__t.overflow()')
    check(out.length === 0, `${name}: wider than the phone: ${out.join('; ')}`)
  }
  return file
}

/** Load a URL, or the current page again, and wait for the browser to finish. Returns the page's HTTP status. */
async function load(url) {
  lastDocument = null
  redirects = []
  const loaded = new Promise(resolve => { const off = page.on('Page.loadEventFired', () => { off(); resolve() }) })
  if (url) await page.send('Page.navigate', { url })
  else await page.send('Page.reload')
  await Promise.race([loaded, sleep(15000)])
  return lastDocument?.status ?? 0
}
const appReady = () => waitFor('the page shows the state of the board', js`!!document.querySelector(${SEL.loaded}) && !!document.querySelector(${SEL.online}) && !!window.__t`, 15000)
async function reload() {
  await load()
  await appReady()
  await settle()
}
async function open(pathname) {
  const status = await load(base + pathname)
  await appReady()
  await settle()
  return status
}
async function login() {
  const status = await load(`${base}/?t=${token}`)
  await appReady()
  return status
}
const place = () => ev('__t.place()')

// ---- moving around ---------------------------------------------------------------

async function closeWindows() {
  for (let i = 0; i < 3; i++) {
    if (!(await ev(js`__t.focusOpen() || !!document.querySelector(${SEL.dialogOpen})`))) return
    await escape()
    await sleep(300)
  }
}
async function goInbox() {
  await closeWindows()
  // The Desk is the pill at the top centre (it was a row of the sidebar before).
  await press('the Desk pill', js`__t.one(${SEL.deskGo}) ?? __t.entry(${TEXT.inbox})`)
  await waitFor('the inbox shows', js`__t.vis(document.querySelector(${SEL.inbox}))`)
  await settle()
}
async function goSession(agent) {
  await closeWindows()
  await press(`the session "${nameOf(agent)}" in the sidebar`, js`__t.entry(${nameOf(agent)})`)
  await waitFor(`the conversation of "${nameOf(agent)}" opens`, js`!!__t.pane(${agent.id}) && __t.all(${SEL.message}, __t.pane(${agent.id})).length > 0`)
  await settle()
}
async function goRoster() {
  await closeWindows()
  // The Agents page is the Ledger. A phone has an icon for it in its bar; a wide screen reaches it through the menu at the top centre.
  if (!(await ev('__t.vis(document.querySelector("#ledger"))'))) {
    if (await ev(js`!!__t.one(${SEL.navRoster})`)) await press('the agents page', js`__t.one(${SEL.navRoster})`)
    else { await press('the menu', '__t.one("#brand-menu")'); await press('"Agents" in the menu', '__t.one("#menu-agents")') }
  }
  await waitFor('the agents page lists the sessions', '__t.vis(document.querySelector("#ledger")) && document.querySelectorAll("#ledger .ledger-line").length > 0')
  await settle()
}
/** On a phone the tab bar steps aside while the keyboard is up; a tap on the conversation puts it away. */
async function keyboardAway(agent) {
  if (!touch) return
  await ev('document.activeElement?.blur?.()')
  await settle()
}
async function mode(which, agent) {
  await keyboardAway(agent)
  const sel = which === 'scribble' ? SEL.modeScribble : SEL.modeChat
  await press(`the "${which}" mode of the session`, js`__t.one(${sel})`)
  await waitFor(`the session shows its "${which}" mode`, js`document.body.dataset.view === ${which}`)
  await settle()
}

/** The rows of a list: same height, and at the right edge of each the same place to answer:
 *  two square tiles side by side, or one tile as wide as the two. */
async function checkRows(root, where) {
  const rows = (await ev(js`__t.rows(${root})`)).filter(r => !r.open)
  need(rows.length > 0, `${where}: there are no rows`)
  if (!touch) {
    const heights = [...new Set(rows.map(r => Math.round(r.box.height)))]
    check(heights.length === 1, `${where}: the rows differ in height: ${rows.map(r => `"${r.title.slice(0, 20)}" ${r.box.height}px`).join(', ')}`)
  }
  const bad = { count: [], side: [], edge: [], line: [], square: [], title: [] }
  const short = r => `"${r.title.slice(0, 28)}"`
  const span = r => ({ left: r.tiles[0].box.left, right: r.tiles.at(-1).box.right, top: r.tiles[0].box.top - r.box.top, height: r.tiles[0].box.height })
  const lead = rows.find(r => r.tiles.length === 2) ?? rows.find(r => r.tiles.length === 1)
  for (const row of rows) {
    if (row.tiles.length < 1 || row.tiles.length > 2) { bad.count.push(`${short(row)} has ${row.tiles.length}`); continue }
    const [left, right] = row.tiles
    if (right && !(left.box.right <= right.box.left + 1 && same(left.box.top, right.box.top))) bad.side.push(short(row))
    const mine = span(row), ref = span(lead)
    if (!(mine.right <= row.box.right + 1 && row.box.right - mine.right <= 36)) bad.edge.push(`${short(row)} ends ${Math.round(row.box.right - mine.right)}px before the edge`)
    // One tile ("Choose") is as wide as the pair, or a square in the place of the pair's right-hand tile.
    const fits = r => same(mine.left, r.left) && same(mine.right, r.right) && (touch || same(mine.top, r.top)) && same(mine.height, r.height)
    if (!(fits(ref) || (row.tiles.length === 1 && fits({ ...ref, left: lead.tiles.at(-1).box.left })))) bad.line.push(`${short(row)} (${Math.round(mine.left)}..${Math.round(mine.right)}, ${Math.round(mine.height)}px high; the first row ${Math.round(ref.left)}..${Math.round(ref.right)}, ${Math.round(ref.height)}px)`)
    if (right) for (const t of row.tiles) if (!same(t.box.width, t.box.height, 2)) bad.square.push(`${short(row)} "${t.name}" is ${t.box.width}x${t.box.height}`)
    const card = cardOf(row.id)
    if (card && row.title !== card.title) bad.title.push(`${short(row)} for the card "${card.title}"`)
  }
  check(!bad.count.length, `${where}: not every row has its answer tiles: ${bad.count.join(', ')}`)
  // The brief: two square tiles in every row ("Later" and "Choose" where there are more than two options).
  const wide = rows.filter(r => r.tiles.length === 1)
  check(!wide.length, `${where}: ${wide.length} of ${rows.length} rows have one wide "${TEXT.choose}" tile and a small "${TEXT.later}" arrow instead of two square tiles`)
  check(!bad.side.length, `${where}: the two tiles do not stand side by side in ${bad.side.join(', ')}`)
  check(!bad.edge.length, `${where}: the answer tiles are not at the right edge of their row: ${bad.edge.join(', ')}`)
  check(!bad.line.length, `${where}: the answer tiles are not in the same place in every row: ${bad.line.slice(0, 3).join(', ')}`)
  if (!touch) check(!bad.square.length, `${where}: tiles that are not square: ${bad.square.slice(0, 4).join(', ')}`)
  check(!bad.title.length, `${where}: rows that show another title than their card: ${bad.title.join(', ')}`)
  return rows
}
const tileNames = row => row.tiles.map(t => t.name).join('" | "')
/** Every picture a selector names is really there: loaded, and with a size on screen. */
async function checkPictures(what, sel, root, atLeast = 1) {
  const list = await ev(js`__t.pictures(${sel}, ${root ?? null})`)
  check(list.length >= atLeast, `${what}: expected at least ${atLeast} picture(s), found ${list.length}`)
  const broken = list.filter(p => !(p.width > 0 && p.shown > 0))
  check(!broken.length, `${what}: pictures that did not load: ${broken.map(p => `${p.src} in ${p.in}`).join(', ')}`)
  return list
}
async function checkEnglish(where) {
  const words = await ev('__t.german()')
  check(!words.length, `${where}: the interface is not English here: ${words.join(' | ')}`)
}

// ---- the groups ------------------------------------------------------------------

async function groupLogin() {
  // Without the cookie nothing is served, to a program as little as to a browser.
  const fresh = (await page.send('Network.getCookies', { urls: [base] })).cookies.length === 0
  for (const url of ['/', '/events', '/js/app.js', '/s/x', '/agents', '/?t=wrong']) {
    const res = await fetch(base + url, { redirect: 'manual' })
    check(res.status === 401, `GET ${url} without the cookie answered ${res.status}, expected 401`)
  }
  if (fresh) {
    tolerate = entry => entry.status === 401
    const refused = await load(`${base}/`)
    check(refused === 401, `the browser got ${refused} for the page without a login, expected 401`)
    check(!(await ev(js`!!document.querySelector(${SEL.sidebar})`)), 'the page was served without a login')
    await shot('refused', { overflow: false })
    tolerate = null
  }
  const status = await load(`${base}/s/nowhere?t=${token}`)
  check(status === 200, `the login link ended in status ${status}`)
  check(redirects.some(r => r.status === 302), 'the login link did not redirect')
  check(await ev('location.pathname + location.search') === '/s/nowhere' || await ev('location.pathname + location.search') === '/', `after the login the address still carries the token: ${await ev('location.href')}`)
  const { cookies } = await page.send('Network.getCookies', { urls: [base] })
  const cookie = cookies.find(c => c.value === token)
  if (check(cookie, 'the login link set no cookie with the token')) check(cookie.httpOnly, 'the login cookie can be read by scripts (not HttpOnly)')
  await appReady()
  check(await open('/') === 200, 'the page is refused although the cookie is set')
  const names = (await ev('__t.sidebar()')).filter(r => r.name).map(r => r.name)
  for (const a of state().agents) check(names.includes(nameOf(a)), `the sidebar does not list the session "${nameOf(a)}"`)
  await checkEnglish('the page after the login')
  await shot('logged-in')
}

async function groupInbox() {
  const stamp = tag()
  // Three plain yes/no questions that follow each other, one worded pair, and one that is the last of its group.
  const a = await fixture.quick(`Quick A (${stamp})?`, { recommended: 'yes' })
  const b = await fixture.quick(`Quick B (${stamp})?`, { recommended: 'no' })
  const c = await fixture.quick(`Quick C (${stamp})?`)
  const d = await fixture.quick(`Quick D (${stamp})?`)
  const worded = await fixture.worded(`Worded pair (${stamp})?`, { recommended: 'ship' })
  await open('/')
  await goInbox()
  await waitFor('the new questions are listed', js`!!__t.row(${worded.id})`)
  await settle()

  // Groups per sender, each with exactly the open questions of that session; what was put off stands apart.
  const groups = await ev('__t.groups()')
  const fresh = id => !putOff.has(id)
  const expected = state().agents.filter(a => !a.archived).map(a => ({ name: nameOf(a), ids: openCards(a.id).map(c => c.id).filter(fresh) })).filter(g => g.ids.length)
  const senders = groups.filter(g => !g.pile)
  check(senders.length === expected.length, `the inbox has ${senders.length} groups (${senders.map(g => g.name).join(', ')}), but ${expected.length} sessions have open questions (${expected.map(g => g.name).join(', ')})`)
  for (const want of expected) {
    const got = senders.find(g => g.name.replace(/^★ /, '') === want.name)
    if (!check(got, `no group for the sender "${want.name}"`)) continue
    check([...got.ids].sort().join() === [...want.ids].sort().join(), `the group "${want.name}" shows ${got.ids.length} rows, the session has ${want.ids.length} open questions`)
    check(parseInt(got.count, 10) === want.ids.length, `the group "${want.name}" counts "${got.count}", expected ${want.ids.length}`)
  }
  const total = expected.reduce((n, g) => n + g.ids.length, 0)
  check(parseInt(await ev(js`__t.text(__t.one(${SEL.inboxCount}))`), 10) === total, `the heading counts "${await ev(js`__t.text(__t.one(${SEL.inboxCount}))`)}" questions, ${total} need an answer`)
  const rows = await checkRows(SEL.inbox, 'inbox')
  await checkEnglish('inbox')
  await shot('rows')

  // A two-option question: thumb down on the left, thumb up on the right. The advised one is circled by hand.
  const info = id => ev(js`__t.rowInfo(${id})`)
  const [ra, rb, rw] = [await info(a.id), await info(b.id), await info(worded.id)]
  check(ra.tiles.length === 2 && ra.tiles[0].name === 'No' && ra.tiles[1].name === 'Yes', `a yes/no question reads "${tileNames(ra)}", expected no on the left and yes on the right`)
  check(ra.tiles.every(t => t.thumb && t.drawn), 'a yes/no question does not show two drawn thumbs')
  check(rw.tiles.length === 2 && rw.tiles[0].name === 'Hold back' && rw.tiles[1].name === 'Ship it', `a two-option question reads "${tileNames(rw)}", expected the agent's second option on the left and its first on the right`)
  check(ra.tiles[1]?.advised && ra.tiles[1]?.ringed && !ra.tiles[0]?.advised, 'the recommended "Yes" (right tile) is not the one circled')
  check(rb.tiles[0]?.advised && rb.tiles[0]?.ringed && !rb.tiles[1]?.advised, 'the recommended "No" (left tile) is not the one circled')
  check(rw.tiles[1]?.advised && rw.tiles[1]?.ringed, 'the recommended option of a worded pair is not circled')
  const plainRow = await info(c.id)
  check(!plainRow.tiles.some(t => t.advised), 'a question without a recommendation shows a circle')

  // One click answers; the next row slides up, and its right-hand tile lies under the same point of the screen.
  const order = rows.map(r => r.id)
  check(order.indexOf(b.id) === order.indexOf(a.id) + 1 && order.indexOf(c.id) === order.indexOf(b.id) + 1, 'three questions asked one after the other do not stand one below the other')
  // On a phone the answered row stands at the lower edge of the screen: that is where the undo bar comes up.
  if (touch) { await ev(js`__t.row(${a.id}).scrollIntoView({ block: 'end', behavior: 'instant' })`); await settle() }
  const point = await press(`"Yes" on "${a.title}"`, js`__t.tile(${a.id}, 'right')`)
  // While the rows slide, the unmoved pointer must never be over another answer than the one that is coming.
  const during = []
  for (let i = 0; i < 12; i++) { during.push(await ev(js`__t.tileAt(${point.x}, ${point.y})`)); await sleep(30) }
  await waitState(`"${a.title}" is decided`, () => cardOf(a.id).status !== 'open')
  check(cardOf(a.id).choice === 'yes', `one click on "Yes" chose "${cardOf(a.id).choice}"`)
  await waitFor(`the answered row "${a.title}" leaves the inbox`, js`!__t.row(${a.id})`)
  const strays = during.filter(t => t.row && t.row !== a.id && !(t.row === b.id && t.right))
  check(!strays.length, `while the rows slide up, another answer passes under the unmoved pointer: ${strays.map(t => `"${t.name}" of "${cardOf(t.row)?.title}"`).join(', ')}`)
  await settle()
  await shot('answered')
  const under = async (answered, wanted, nth) => {
    const now = await ev(js`__t.tileAt(${point.x}, ${point.y})`)
    const where = `after the ${nth} answer, at the unmoved pointer (${point.x},${point.y})`
    if (!check(now.row, `${where} there is no answer tile but ${now.hit}`)) return null
    check(now.row !== answered, `${where} the answered row is still there`)
    check(now.row === wanted, `${where} lies "${cardOf(now.row)?.title}", not the next row "${cardOf(wanted)?.title}"`)
    check(now.right, `${where} lies the left tile "${now.name}", not the right one`)
    check(same(now.box.left, point.box.left) && same(now.box.top, point.box.top) && same(now.box.width, point.box.width) && same(now.box.height, point.box.height),
      `${where} the next right-hand tile is not where the last one was: it is off by ${Math.round(now.box.left - point.box.left)}px across and ${Math.round(now.box.top - point.box.top)}px down`)
    return now
  }
  // On a phone the finger rests where it tapped; the undo bar must not come up under it.
  if (touch) check(!(await ev(js`!!document.elementFromPoint(${point.x}, ${point.y})?.closest(${SEL.undoBar})`)), 'the way back comes up under the finger that just answered')
  if (!touch) {
    const next = await under(a.id, b.id, 'first')
    if (next?.right) {
      await pressAt(point.x, point.y, { move: false })
      await waitState(`"${b.title}" is decided by a second click on the same spot`, () => cardOf(b.id).status !== 'open')
      check(cardOf(b.id).choice === 'yes', `the second click on the same spot chose "${cardOf(b.id).choice}", expected "yes"`)
      await waitFor(`the second answered row leaves the inbox`, js`!__t.row(${b.id})`)
      await settle()
      await under(b.id, c.id, 'second')
    }
  }

  // The thumb down answers with the other option.
  await press(`"No" on "${c.title}"`, js`__t.tile(${c.id}, 'left')`)
  await waitState(`"${c.title}" is decided`, () => cardOf(c.id).status !== 'open')
  check(cardOf(c.id).choice === 'no', `one click on the thumb down chose "${cardOf(c.id).choice}"`)
  await waitFor('the answered row leaves the inbox', js`!__t.row(${c.id})`)
  await settle()

  // The undo bar names the answer, covers no row, and takes the answer back.
  const bar = await ev(js`(n => n && { text: __t.text(n.querySelector(${SEL.undoSaid}) ?? n), box: __t.box(n) })(__t.one(${SEL.undoBar}))`)
  if (check(bar, 'nothing offers to take the answer back')) {
    check(/(^|\s)No$/.test(bar.text), `the way back reads "${bar.text}", expected it to name the answer "No"`)
    // Wherever it stands, it must not lie over an answer: a press meant for a tile would take the last answer back.
    const over = b => b.top < bar.box.bottom && b.bottom > bar.box.top && b.left < bar.box.right && b.right > bar.box.left
    const covered = (await ev('__t.rows()')).filter(r => r.tiles.some(t => over(t.box)))
    check(!covered.length, `the way back lies over the answer tiles of "${covered[0]?.title}"`)
    const { height: tall, width: wide } = touch ? PHONE : DESKTOP
    check(bar.box.top >= 0 && bar.box.left >= 0 && bar.box.bottom <= tall + 1 && bar.box.right <= wide + 1, `the note with the way back is cut off by the edge of the screen: it reaches from ${bar.box.top} to ${bar.box.bottom} on a screen ${tall}px high`)
    await shot('undo-bar')
    await press('the way back', js`(n => n.matches('button') ? n : n.querySelector('button'))(__t.one(${SEL.undoBar}))`)
    await waitState(`"${c.title}" is open again`, () => cardOf(c.id).status === 'open')
    await expect(`undo brings the row "${c.title}" back`, js`!!__t.row(${c.id})`)
    check(cardOf(c.id).choice == null, 'the reopened card still carries its old answer')
    await expect('the way back goes away once used', js`!__t.one(${SEL.undoBar})`, 3000)
  }
  await settle()

  // The same promise at the end of a sender's group: answer its last row, and an answer tile is under the pointer again.
  if (!touch) {
    const list = await ev('__t.groups()')
    const mine = list.find(g => g.ids.includes(d.id))
    const after = list.slice(list.indexOf(mine) + 1).find(g => !g.pile)   // the next sender; the piles at the foot are no rows to answer
    if (mine && after && mine.ids.at(-1) !== d.id) {
      // d is not the last of its group (the answer to c was taken back); answer what follows it first.
      for (const id of mine.ids.slice(mine.ids.indexOf(d.id) + 1)) { await press('a row below', js`__t.tile(${id}, 'right')`); await waitFor('it leaves', js`!__t.row(${id})`); await settle() }
    }
    if (mine && after) {
      const at = await press(`"Yes" on the last row of the group "${mine.name}"`, js`__t.tile(${d.id}, 'right')`)
      await waitFor('the answered row leaves the inbox', js`!__t.row(${d.id})`)
      await settle()
      const now = await ev(js`__t.tileAt(${at.x}, ${at.y})`)
      check(now.row === after.ids[0] && now.right, `after answering the last row of a sender's group, the unmoved pointer (${at.x},${at.y}) is over ${now.row ? `the left tile "${now.name}"` : now.hit}, not over the right-hand tile of the next row`)
      await shot('group-boundary')
    }
  }
  // An answered row leaves at once: it does not wait for the server. On a slow line (the answer is held back for 1.5 s)
  // the row has to be gone long before the server has heard of the answer.
  const slow = await fixture.quick(`Quick on a slow line (${stamp})?`)
  await waitFor('the new question is listed', js`!!__t.row(${slow.id})`)
  await ev(js`__t.row(${slow.id}).scrollIntoView({ block: 'center', behavior: 'instant' })`)
  await settle()
  const release = await hold('*/decide', 1500)
  try {
    await press(`"Yes" on "${slow.title}"`, js`__t.tile(${slow.id}, 'right')`)
    const gone = await waitFor('the row leaves', js`!__t.row(${slow.id})`, 900).catch(() => false)
    check(gone, 'on a slow line the answered row stays until the server has replied; it should leave at once')
    if (gone) check(cardOf(slow.id).status === 'open', 'the test line was not slow: the server already had the answer')
  } finally {
    await release()
  }
  await waitState(`"${slow.title}" is decided`, () => cardOf(slow.id).status !== 'open', 8000)
  check(cardOf(slow.id).choice === 'yes', `the answer on a slow line arrived as "${cardOf(slow.id).choice}"`)
  await sleep(300)
  // The title of the page: the knocks (urgent and blocking questions) where there are any, else every open question.
  const waiting = openCards().filter(c => agentById(c.agent) && !agentById(c.agent).archived && fresh(c.id))
  const knocks = waiting.filter(c => c.kind === 'permission' || c.urgency === 'high' || c.urgency === 'critical').length
  check(await ev('__t.openCount()') === (knocks || waiting.length), `the title of the page reads "${await ev('document.title')}", expected ${knocks ? `${knocks} knocks` : `${waiting.length} open questions`}`)
}

/** Press the control that puts a row off, or fetches it back. A finger has no hover: where the control is a folded
 *  corner, the first tap only unfolds it and the second one acts. */
async function pressLater(id, what) {
  const was = await ev(js`__t.inPile('later', ${id})`)
  await press(what, js`__t.later(${id})`)
  if (!touch) return
  const moved = await waitFor('it moves', js`__t.inPile('later', ${id}) !== ${was}`, 700).catch(() => false)
  if (!moved && await ev(js`!!__t.later(${id})`)) await press(`${what} (the second tap: the first one unfolded the corner)`, js`__t.later(${id})`)
}

/** Unfold a pile at the foot of the inbox (Later, With the agent, Answered), unless it stands open. */
async function unfoldPile(kind) {
  if (await ev(js`__t.groups().find(g => g.pile === ${kind})?.open`)) return
  await ev(js`__t.pileOf(${kind})?.scrollIntoView({ block: 'center', behavior: 'instant' })`)
  await press(`the pile "${kind}"`, js`__t.one(${SEL.pileHead}, __t.pileOf(${kind}))`)
  await waitFor(`the pile "${kind}" unfolds`, js`__t.groups().find(g => g.pile === ${kind})?.open === true`, 3000)
  await settle()
}

async function groupLater() {
  const stamp = tag()
  const one = await fixture.light(`Put me off, first (${stamp})`)
  const two = await fixture.light(`Put me off, second (${stamp})`)
  const stay = await fixture.light(`I stay where I am (${stamp})`)
  const done = await fixture.quick(`Answer me, then take it back (${stamp})?`)
  await open('/')
  await goInbox()
  await waitFor('the new questions are listed', js`!!__t.row(${done.id})`)
  const before = await ev(js`__t.rowInfo(${one.id})`)
  check(isLater(before.later) && before.tiles.at(-1)?.name.startsWith(TEXT.choose), `a question with three options offers "${before.later}" and "${tileNames(before)}", expected "${TEXT.later}" and "${TEXT.choose}"`)
  const counted = parseInt(await ev(js`__t.text(__t.one(${SEL.inboxCount}))`), 10)

  for (const card of [one, two]) {
    await ev(js`__t.row(${card.id}).scrollIntoView({ block: 'center', behavior: 'instant' })`)
    await pressLater(card.id, `"${TEXT.later}" on "${card.title}"`)
    putOff.add(card.id)
    await waitFor(`"${TEXT.later}" moves "${card.title}" into the pile at the foot`, js`__t.inPile('later', ${card.id})`, 3000)
    await settle()
  }
  const said = await ev('__t.note()')
  if (check(said, `nothing says where the question went after "${TEXT.later}"`)) check(saysLater(said.text) && said.back, `the note after "${TEXT.later}" reads "${said.all}", expected "${TEXT.movedLater}" and the way back`)
  const groups = await ev('__t.groups()')
  const laters = groups.filter(g => g.later)
  check(laters.length === 1, `there are ${laters.length} "${TEXT.later}" piles, expected exactly one`)
  check(groups.findIndex(g => g.pile) > groups.findLastIndex(g => !g.pile), `the piles do not stand below the questions of every sender: ${groups.map(g => g.pile || g.name).join(', ')}`)
  check(laters[0]?.ids.includes(one.id) && laters[0]?.ids.includes(two.id), 'the two rows put off do not lie on the same pile')
  check(!groups.filter(g => !g.pile).some(g => g.ids.includes(one.id) || g.ids.includes(two.id)), `a row put off still stands among the questions of its sender`)
  check(cardOf(one.id).status === 'open', `"${TEXT.later}" answered the card`)
  check(parseInt(laters[0]?.count, 10) === laters[0]?.ids.length, `the "${TEXT.later}" pile counts "${laters[0]?.count}", it holds ${laters[0]?.ids.length}`)
  check(parseInt(await ev(js`__t.text(__t.one(${SEL.inboxCount}))`), 10) === counted - 2, `the heading still counts ${await ev(js`__t.text(__t.one(${SEL.inboxCount}))`)} after two of ${counted} were put off`)

  // An answered question leaves for the "Answered" pile, which lies beside "Later" at the foot.
  await ev(js`__t.row(${done.id}).scrollIntoView({ block: 'center', behavior: 'instant' })`)
  await press(`"Yes" on "${done.title}"`, js`__t.tile(${done.id}, 'right')`)
  await waitState(`"${done.title}" is decided`, () => cardOf(done.id).status !== 'open')
  await expect('the answered question lies on the "Answered" pile', js`__t.inPile('answered', ${done.id}) || __t.groups().find(g => g.pile === 'answered')?.peeks.includes(${done.title})`, 3000)
  await ev(js`__t.pileOf('later')?.scrollIntoView({ block: 'center', behavior: 'instant' })`)
  await settle()
  const feet = await ev(js`['later', 'answered'].map(k => (n => n && __t.box(n))(__t.pileOf(k)))`)
  if (check(feet[0] && feet[1], `the piles "${TEXT.later}" and "${TEXT.answered}" are not both at the foot of the inbox`)) {
    if (touch) check(feet[0].bottom <= feet[1].top + 1 || feet[0].right <= feet[1].left + 1, 'on a phone the two piles lie over each other')
    else check(same(feet[0].top, feet[1].top, 2) && feet[0].right <= feet[1].left + 1, `the piles "${TEXT.later}" and "${TEXT.answered}" do not lie side by side: ${JSON.stringify(feet)}`)
  }
  await shot('piles')

  // Unfolded, the pile shows its rows: each says who asked and offers the way back.
  await unfoldPile('later')
  const off = await ev(js`__t.rowInfo(${one.id})`)
  if (check(off, 'the unfolded pile does not show the row put off')) {
    check(isFetch(off.later), `a row put off offers "${off.later}" as the way back, expected "${TEXT.back}" or "Wake up"`)
    check(off.from.includes(COURIER), `a row put off does not say who asked: "${off.from}"`)
  }
  await checkRows(SEL.inbox, `inbox after "${TEXT.later}"`)
  await ev(js`__t.row(${two.id}).scrollIntoView({ block: 'center', behavior: 'instant' })`)
  await checkEnglish('the piles')
  await shot('put-off')

  await reload()
  check(await ev(js`__t.inPile('later', ${one.id})`), `after a reload the row put off is no longer on the "${TEXT.later}" pile`)
  await unfoldPile('later')
  await pressLater(one.id, `"${TEXT.back}" on "${one.title}"`)
  putOff.delete(one.id)
  await expect(`"${TEXT.back}" returns the row to the questions of its sender`, js`!!__t.groups().find(g => !g.pile && g.name.replace(/^★ /, '') === ${COURIER})?.ids.includes(${one.id})`, 3000)
  await settle()
  await unfoldPile('later')
  await pressLater(two.id, `"${TEXT.back}" on "${two.title}"`)
  putOff.delete(two.id)
  await expect(`the "${TEXT.later}" pile goes when it is empty`, js`!__t.groups().some(g => g.later)`, 3000)
  await settle()
  await shot('fetched-back')

  // The wrong answer that is noticed only later: the "Answered" pile takes it back, and the question
  // stands among those of its sender again, and is one of the walk again.
  await unfoldPile('answered')
  await ev(js`__t.all(${SEL.doneRow}).find(n => n.dataset.id === ${done.id})?.scrollIntoView({ block: 'center', behavior: 'instant' })`)
  await press(`"Take back" on "${done.title}"`, js`__t.one(${SEL.takeBack}, __t.all(${SEL.doneRow}).find(n => n.dataset.id === ${done.id}))`)
  await waitState(`"${done.title}" is open again`, () => cardOf(done.id).status === 'open')
  check(cardOf(done.id).choice == null, 'the card taken back still carries its old answer')
  await expect('the question taken back stands in the group of its sender again', js`!!__t.groups().find(g => !g.pile && g.name.replace(/^★ /, '') === ${COURIER})?.ids.includes(${done.id})`, 3000)
  check(!(await ev(js`__t.inPile('answered', ${done.id})`)), 'the question taken back still lies on the "Answered" pile')
  check(state().queue.includes(done.id), 'the question taken back is not in the line of open questions')
  await settle()
  await shot('taken-back')
  await courier.tool('withdraw_card', { card_id: done.id, reason: 'the test is done with it' }).catch(() => {})
}

async function groupChoose() {
  const stamp = tag()
  const light = await fixture.light(`Choose in the row (${stamp})`)
  const heavy = await fixture.heavy(`Choose in a window (${stamp})`)
  await open('/')
  await goInbox()
  await waitFor('the new questions are listed', js`!!__t.row(${heavy.id})`)
  await settle()

  // A light question unfolds where it stands.
  await ev(js`__t.row(${light.id}).scrollIntoView({ block: 'center', behavior: 'instant' })`)
  await settle()
  const before = await ev(js`__t.rowInfo(${light.id})`)
  await press(`"${TEXT.choose}" on "${light.title}"`, js`__t.tile(${light.id}, 'right')`)
  await sleep(400)
  await settle()
  check(!(await ev('__t.focusOpen()')), `"${TEXT.choose}" on a question with little text opened the big window instead of unfolding the row`)
  await closeWindows()
  const unfolded = await expect(`"${TEXT.choose}" unfolds the row and shows its options`, js`(r => r && r.options.length > 0 && r)(__t.rowInfo(${light.id}))`, 3000)
  if (unfolded) {
    check(unfolded.options.map(o => o.name).join() === light.options.map(o => o.label).join(), `the unfolded row offers "${unfolded.options.map(o => o.name).join('", "')}", the card has "${light.options.map(o => o.label).join('", "')}"`)
    check(same(unfolded.box.top, before.box.top, 2), `the row jumped by ${Math.round(unfolded.box.top - before.box.top)}px when it unfolded`)
    check(unfolded.box.height > before.box.height, 'the row did not grow when it unfolded')
    const advised = unfolded.options.filter(o => o.advised)
    check(advised.length === 1 && advised[0].name === 'Medium' && advised[0].ringed, `the recommended option "Medium" is not the one circled among the unfolded options (circled: ${advised.map(o => o.name).join(', ') || 'none'})`)
    await shot('unfolded')
    // A second press folds it again.
    await press(`"${TEXT.choose}" again`, js`__t.tile(${light.id}, 'right')`)
    await expect('a second press folds the row again', js`__t.rowInfo(${light.id}).options.length === 0`, 3000)
    await press(`"${TEXT.choose}" once more`, js`__t.tile(${light.id}, 'right')`)
    await waitFor('the row unfolds again', js`__t.rowInfo(${light.id}).options.length > 0`, 3000)
    await settle()
    await press('the option "Small"', js`__t.byText(${SEL.rowOption}, 'Small', __t.row(${light.id}))`)
    await waitState(`"${light.title}" is decided`, () => cardOf(light.id).status !== 'open')
    check(cardOf(light.id).choice === 'small', `one click on "Small" chose "${cardOf(light.id).choice}"`)
    await expect('the answered row leaves the inbox', js`!__t.row(${light.id})`)
    await expect('the answer can be taken back', js`!!__t.one(${SEL.undoBar})`, 2000)
  }

  // A content-heavy one opens the big window, on that card, with its pictures and its recommendation.
  await settle()
  await press(`"${TEXT.choose}" on "${heavy.title}"`, js`__t.tile(${heavy.id}, 'right')`)
  await waitFor('the window opens on the heavy card', js`__t.focusOpen() && __t.focusState().id === ${heavy.id}`)
  await settle()
  const shown = await ev('__t.focusState()')
  check(shown.title === heavy.title, `the window shows "${shown.title}"`)
  check(shown.options.length === heavy.options.length, `the window offers ${shown.options.length} options, the card has ${heavy.options.length}`)
  check(shown.options.filter(o => o.advised).length === 1 && shown.options.find(o => o.advised)?.name.startsWith('In batches'), 'the recommended option "In batches" is not the one marked in the window')
  const behind = await ev('__t.reachableBehind()')
  check(behind.length === 0, `the page behind the window is not inert: ${behind.join('; ')}`)
  await checkPictures('the window of the card', `${SEL.focusCard} img`, null, 1)
  check(/^\/q\/\d+$/.test(await ev('location.pathname')), `the window has no address of its own: ${await ev('location.pathname + location.search')}`)   // a question is /q/<number>
  await checkEnglish('the window of a card')
  await shot('window')
  await press('the option "Tonight at 02:00"', js`__t.all(${SEL.focusOption}, __t.one(${SEL.focusCard})).find(n => __t.label(n).startsWith('Tonight'))`)
  await waitState(`"${heavy.title}" is decided`, () => cardOf(heavy.id).status !== 'open')
  check(cardOf(heavy.id).choice === 'night', `one click on "Tonight at 02:00" chose "${cardOf(heavy.id).choice}"`)
  await expect('the window of one card closes on its answer', '!__t.focusOpen()', 4000)
  await expect('the page behind works again', js`![...document.body.children].some(n => n.inert && __t.vis(n))`, 2000)
  await expect('the decided card left the inbox', js`!__t.row(${heavy.id})`)
  await closeWindows()

  // The walk through all of them, one window each: it starts at the most urgent, and Escape leaves it.
  await press('"Go through them"', js`__t.one(${SEL.goThrough}) ?? __t.one(${SEL.walk})`)
  await waitFor('the walk opens', '__t.focusOpen() && !!__t.focusState().id')
  await settle()
  const first = await ev('__t.focusState()')
  const queue = state().queue.filter(id => !putOff.has(id) && !agentById(cardOf(id).agent)?.archived)
  check(first.id === queue[0], `the walk starts at "${first.title}", not at the most urgent question "${cardOf(queue[0])?.title}"`)
  await shot('walk')
  if (!touch) {
    // The arrows and J/K move, and never answer: only Y, N and the digits do.
    const answered = () => state().cards.filter(c => c.status !== 'open').length
    const before = answered()
    await key('ArrowRight', 39)
    await expect('the arrow key shows the next question', js`(s => s && s.id === ${queue[1]})(__t.focusState())`, 3000)
    await key('k', 75, { text: 'k' })
    await expect('K goes back to the one before', js`(s => s && s.id === ${first.id})(__t.focusState())`, 3000)
    // Walk past a few questions, two-option ones among them, with the arrow alone.
    for (let i = 0; i < Math.min(6, queue.length - 1); i++) { await key('ArrowRight', 39); await sleep(250) }
    await settle()
    check(answered() === before, `walking through the questions with the arrow key answered ${answered() - before} of them`)
  }
  await escape()
  await expect('Escape closes the walk', '!__t.focusOpen()')
  check((await place()).path === '/' && !(await ev('location.search')), `after the walk the address is ${await ev('location.pathname + location.search')}`)
}

/** The list worked down with the keyboard alone. */
async function groupKeys() {
  const stamp = tag()
  const light = await fixture.light(`Keys: choose (${stamp})`, { urgency: 'high', urgency_reason: 'so that it stands above the others' })
  const a = await fixture.quick(`Keys: yes (${stamp})?`, { urgency: 'high' })
  const b = await fixture.quick(`Keys: no (${stamp})?`, { urgency: 'high' })
  const c = await fixture.quick(`Keys: later (${stamp})?`, { urgency: 'high' })
  await open('/')
  await waitFor('the new questions are listed', js`!!__t.row(${c.id})`)
  await settle()
  const marked = () => ev(js`(n => n ? n.dataset.id : null)(__t.one(${SEL.row + SEL.rowCurrent}, ${SEL.inbox}))`)
  const first = (await ev('__t.rows()'))[0]
  await key('ArrowDown', 40)
  await expect('the arrow key marks the first row', js`__t.rowInfo(${first.id}).current`, 2000)
  // Walk down to the first of the new rows.
  for (let i = 0; i < 40 && await marked() !== light.id; i++) await key('ArrowDown', 40)
  need(await marked() === light.id, 'the arrow keys do not reach the row of the new question')
  await key('c', 67, { text: 'c' })
  await expect('C unfolds the choices of the marked row', js`__t.rowInfo(${light.id}).options.length === 3`, 2000)
  await shot('unfolded-by-key')
  await key('2', 50, { text: '2' })
  await waitState('the digit 2 picks the second option', () => cardOf(light.id).choice === 'mid', 4000).then(() => passed(), e => check(false, e.message))
  await expect('the answered row leaves', js`!__t.row(${light.id})`)
  await settle()
  check(await marked() === a.id, `after an answer the mark is on "${cardOf(await marked())?.title}", expected the row that moved up, "${a.title}"`)
  await key('y', 89, { text: 'y' })
  await waitState('Y answers yes', () => cardOf(a.id).choice === 'yes', 4000).then(() => passed(), e => check(false, e.message))
  await expect('the answered row leaves', js`!__t.row(${a.id})`)
  await settle()
  check(await marked() === b.id, `after Y the mark is on "${cardOf(await marked())?.title}", expected "${b.title}"`)
  await key('n', 78, { text: 'n' })
  await waitState('N answers no', () => cardOf(b.id).choice === 'no', 4000).then(() => passed(), e => check(false, e.message))
  await expect('the answered row leaves', js`!__t.row(${b.id})`)
  await settle()
  await key('u', 85, { text: 'u' })
  await waitState('U takes the last answer back', () => cardOf(b.id).status === 'open', 4000).then(() => passed(), e => check(false, e.message))
  await expect('the row is back', js`!!__t.row(${b.id})`)
  await settle()
  await shot('marked')
  for (let i = 0; i < 6 && await marked() !== c.id; i++) await key('ArrowDown', 40)
  for (let i = 0; i < 6 && await marked() !== c.id; i++) await key('ArrowUp', 38)
  if (check(await marked() === c.id, 'the arrow keys do not reach the row to put off')) {
    await key('l', 76, { text: 'l' })
    putOff.add(c.id)
    await expect('L puts the marked row off', js`__t.inPile('later', ${c.id})`, 3000)
  }
  await escape()
  await expect('Escape takes the mark away', js`!__t.one(${SEL.row + SEL.rowCurrent}, ${SEL.inbox})`, 2000)
  // Typing into a field is never an answer.
  await goSession(agentNamed(COURIER))
  const before = openCards().length
  await press('the message field', `__t.one(${JSON.stringify(SEL.draft)})`)
  await type('yes, no, later: ynlcu 123')
  await sleep(300)
  check(openCards().length === before, 'letters typed into the message field answered a question')
  await retype('')
  await courier.tool('withdraw_card', { card_id: c.id, reason: 'the test is done with it' }).catch(() => {})
  await courier.tool('withdraw_card', { card_id: b.id, reason: 'the test is done with it' }).catch(() => {})
  putOff.delete(c.id)
}

async function groupSession() {
  const agent = scripted()[0]
  const others = scripted().slice(1)
  await open('/')
  await goSession(agent)
  const pane = js`__t.pane(${agent.id})`
  // One conversation, and only its own.
  const intro = s => plain(state().messages.find(m => m.agent === s.id && m.from === 'agent')?.text).slice(0, 30)
  const log = await ev(`__t.text(${pane}.querySelector(${JSON.stringify(SEL.log)}))`)
  check((await ev(js`__t.text(document.querySelector(${SEL.paneTitle}))`)).includes(nameOf(agent)), `the pane is not titled "${nameOf(agent)}"`)
  check(log.includes(intro(agent)), `the conversation of "${nameOf(agent)}" lacks its first message "${intro(agent)}"`)
  for (const other of others) check(!log.includes(intro(other)), `the conversation of "${nameOf(agent)}" shows a message of "${nameOf(other)}"`)
  check(await ev(js`__t.all(${SEL.pane}).length`) === 1, 'a single session shows more than one conversation')
  await checkEnglish('conversation')

  // A message goes out and the scripted agent answers it.
  const said = `Regression test ${size} ${crypto.randomBytes(3).toString('hex')}`
  await press('the message field', `__t.one(${JSON.stringify(SEL.draft)}, ${pane})`)
  await retype(said)
  await waitFor('typing enables send', `!__t.one(${JSON.stringify(SEL.send)}, ${pane}).disabled`, 2000)
  if (touch) await press('send', `__t.one(${JSON.stringify(SEL.send)}, ${pane})`)
  else await key('Enter', 13, { text: '\r' })
  await waitFor('the sent message appears in the conversation', js`!!__t.byText(${SEL.userMessage}, ${said})`)
  check(await ev(`__t.one(${JSON.stringify(SEL.draft)}, ${pane}).value`) === '', 'the message field was not emptied after sending')
  await expect('the scripted reply appears', js`!!__t.byText(${SEL.agentMessage}, ${`${TEXT.heard}: „${said}“`})`, 10000)
  await keyboardAway()
  await shot('conversation')

  // Its open questions stand in the conversation as the same rows as in the inbox.
  const mine = openCards(agent.id)
  need(mine.length > 0, `"${nameOf(agent)}" has no open question left; the fixture changed`)
  // On a wide window the open questions lie in a column beside the conversation (and "Questions only" has
  // nothing to do); otherwise they stand in the conversation itself.
  const beside = await ev(js`!__t.one(${SEL.filterQuestions}) && !!__t.one(${SEL.questionsPane})`)
  const asks = beside ? SEL.questionsPane : `${SEL.pane} ${SEL.ask}`
  const inline = await ev(js`__t.rows(${asks}).length ? __t.all(${asks}).flatMap(a => __t.rows(a)) : []`)
  check(inline.length === mine.length, `the conversation shows ${inline.length} open questions as rows, the session has ${mine.length}`)
  for (const c of mine) check(inline.some(r => r.id === c.id), `the open question "${c.title}" is missing in the conversation`)
  check(inline.every(r => r.tiles.length >= 1), `not every question in the conversation has its answer tiles`)
  if (!touch) {
    const heights = [...new Set(inline.map(r => Math.round(r.box.height)))]
    check(heights.length === 1, `the questions in the conversation differ in height: ${heights.join(', ')}px`)
  }
  await checkPictures('the pictures of questions in the conversation', `${beside ? SEL.questionsPane : SEL.ask} ${SEL.rowThumbImage}`, null, mine.some(c => pictures(c).length) ? 1 : 0)

  // Answer one right there.
  const card = mine.find(c => c.options.length === 2 && inline.find(r => r.id === c.id)?.tiles.length === 2)
  need(card, `"${nameOf(agent)}" has no open two-option question left; the fixture changed`)
  const root = beside ? `__t.one(${JSON.stringify(SEL.questionsPane)})` : `__t.all(${JSON.stringify(SEL.ask)}).find(a => __t.row(${JSON.stringify(card.id)}, a))`
  await press(`"${card.options[0].label}" on the question "${card.title}" in the conversation`, `__t.tile(${JSON.stringify(card.id)}, 'right', ${root})`)
  await waitState(`"${card.title}" is decided`, () => cardOf(card.id).status !== 'open')
  check(cardOf(card.id).choice === card.options[0].key, `one click on "${card.options[0].label}" chose "${cardOf(card.id).choice}"`)
  await expect('the answered question is no longer offered in the conversation', js`!__t.all(${beside ? SEL.questionsPane : SEL.ask}).some(a => __t.row(${card.id}, a))`)
  await expect('the answer can be taken back', js`!!__t.one(${SEL.undoBar})`, 2000)
  await expect('the scripted agent confirms the answer', js`!!__t.byText(${SEL.agentMessage}, ${`ich setze ${card.options[0].key} um`})`, 10000)
  await shot('answered-inline')

  if (!beside) {
    // "Questions only": the same rows as a list, and nothing else; pressed again, the conversation is back.
    const left = openCards(agent.id)
    await press('"Questions only"', js`__t.one(${SEL.filterQuestions})`)
    await waitFor('the filter shows the list of questions', js`document.body.dataset.filter === 'questions' && !!__t.one(${SEL.questionsPane})`)
    await settle()
    const listed = await ev(js`__t.rows(${SEL.questionsPane})`)
    check(listed.map(r => r.id).sort().join() === left.map(c => c.id).sort().join(), `"Questions only" lists ${listed.length} rows, the session has ${left.length} open questions`)
    check(!(await ev(js`__t.all(${SEL.message}).length`)), '"Questions only" still shows messages of the conversation')
    check(await ev(js`document.querySelector(${SEL.filterQuestions}).getAttribute('aria-pressed')`) === 'true', 'the filter does not say that it is on')
    check(parseInt(await ev(js`__t.text(document.querySelector(${SEL.filterCount}))`) || '0', 10) === left.length, `the filter counts "${await ev(js`__t.text(document.querySelector(${SEL.filterCount}))`)}", ${left.length} are open`)
    if (left.length) await checkRows(SEL.questionsPane, '"Questions only"')
    await checkPictures('"Questions only"', `${SEL.questionsPane} ${SEL.rowThumbImage}`, null, left.some(c => pictures(c).length) ? 1 : 0)
    await checkEnglish('"Questions only"')
    await shot('questions-only')
    await press('"Questions only" again', js`__t.one(${SEL.filterQuestions})`)
    await expect('pressed again, the whole conversation is back', js`!document.body.dataset.filter && __t.all(${SEL.message}).length > 0`)

  }

  // "Files": what the session sent, each with a picture that loads.
  const courierAgent = agentNamed(COURIER)
  await goSession(courierAgent)
  await press('"Files"', js`__t.one(${SEL.filterFiles})`)
  await waitFor('the filter shows the files', js`document.body.dataset.filter === 'files' && !!__t.one(${SEL.filesPane})`)
  await settle()
  const files = await ev(js`__t.all(${SEL.fileRow}, ${SEL.filesPane}).map(__t.text)`)
  for (const name of ['thema-hell.png', 'thema-dunkel.png', 'release-notes.txt']) check(files.some(f => f.includes(name)), `"Files" does not list "${name}" (it lists: ${files.map(f => f.slice(0, 24)).join(' | ')})`)
  await checkPictures('"Files"', SEL.fileImage, SEL.filesPane, 2)
  await checkEnglish('"Files"')
  await shot('files')
  await press('a picture in "Files"', js`__t.all(${SEL.fileRow}, ${SEL.filesPane}).find(r => r.querySelector('img'))`)
  if (await expect('a picture in "Files" opens large', js`!!__t.one(${SEL.lightbox})`, 3000)) {
    await checkPictures('the large picture', SEL.lightboxImage)
    await shot('files-large')
    await escape()
    await expect('Escape closes the large picture', js`!__t.one(${SEL.lightbox})`, 3000)
  }
  await press('"Files" again', js`__t.one(${SEL.filterFiles})`)
  await expect('pressed again, the conversation is back', js`!document.body.dataset.filter && __t.all(${SEL.message}).length > 0`)
  await checkPictures('the pictures in the conversation', SEL.messageImage, null, 2)
}

async function groupScribble() {
  const agent = scripted()[0]
  await open('/')
  await goSession(agent)
  const loadsBefore = seen.filter(u => u.includes('/canvas?')).length
  const sent = () => state().messages.filter(m => m.agent === agent.id && m.attachments?.some(a => a.kind === 'scribble')).length
  const cardsBefore = sent()
  await mode('scribble', agent)
  await waitFor('the canvas appears', js`(n => !!n && n.getBoundingClientRect().width > 200)(__t.one(${SEL.scribbleCanvas})) && !!document.querySelector(${SEL.scribbleSend})`)
  // The stored canvas arrives a moment later and would replace a stroke drawn before it.
  const end = Date.now() + 5000
  while (seen.filter(u => u.includes('/canvas?')).length === loadsBefore && Date.now() < end) await sleep(40)
  await sleep(200)
  if (!cardsBefore) check(await ev(js`document.querySelector(${SEL.scribbleSend}).disabled`), 'send is enabled on an empty canvas')
  await checkEnglish('scribble')
  const box = await ev(js`__t.box(__t.one(${SEL.scribbleCanvas}))`)
  const stroke = Array.from({ length: 14 }, (_, i) => ({
    x: Math.round(box.left + box.width * (0.3 + i * 0.03)),
    y: Math.round(box.top + box.height * (0.5 + (i % 2 ? 0.06 : -0.06))),
  }))
  check(await ev(js`document.elementFromPoint(${stroke[0].x}, ${stroke[0].y}) === __t.one(${SEL.scribbleCanvas})`), 'the canvas is covered where the stroke starts')
  await drag(stroke)
  await waitFor('a stroke enables send', js`!document.querySelector(${SEL.scribbleSend}).disabled`, 3000)
  await shot('drawn')
  const sendState = () => ev(js`(b => 'the button is ' + (b.disabled ? 'disabled' : 'enabled') + ', state "' + (b.dataset.state ?? '') + '", error "' + __t.text(__t.one(${SEL.scribbleError})) + '", under its middle: ' + __t.describe(document.elementFromPoint(b.getBoundingClientRect().left + b.getBoundingClientRect().width / 2, b.getBoundingClientRect().top + b.getBoundingClientRect().height / 2)))(document.querySelector(${SEL.scribbleSend}))`)
  // What the page hears of the press, in case it does nothing.
  await ev(`(window.__heard = [], window.__hear ??= ['touchstart', 'touchend', 'touchcancel', 'pointerdown', 'pointerup', 'pointercancel', 'click'].map(n => document.addEventListener(n, e => window.__heard.push(n + '@' + __t.describe(e.target).slice(0, 28)), true)))`)
  await press('send on the canvas', js`document.querySelector(${SEL.scribbleSend})`)
  const arrived = await waitState('the scribble reached the server', () => sent() === cardsBefore + 1, 5000).catch(() => false)
  if (!arrived) {
    // Seen now and then at phone size: Chromium delivers the touch but no click (the page hears touchstart and
    // touchend on the button, nothing cancels them). Not shown to be the page's fault, so it is noted and
    // tried once more; a second miss fails the group.
    note(`the first press on send did nothing within 5 s (${await sendState()}; the page heard: ${(await ev('window.__heard.join(", ")')) || 'no event at all'})`)
    await press('send on the canvas, a second time', js`document.querySelector(${SEL.scribbleSend})`)
    await waitState('the scribble reached the server on the second press', () => sent() === cardsBefore + 1, 10000)
  }
  await waitFor('sending returns to the conversation', js`document.body.dataset.view === 'chat' && !!__t.pane(${agent.id}) && __t.all(${SEL.message}).length > 0`, 10000)
  await waitFor('the scribble appears in the conversation', js`__t.all(${SEL.scribbleCard}).length === ${cardsBefore + 1}`)
  await checkPictures('the scribble in the conversation', `${SEL.scribbleCard} img`, null, cardsBefore + 1)
  await expect('the scripted agent confirms the scribble', js`__t.all(${SEL.agentMessage}).filter(n => __t.text(n).includes(${TEXT.scribbleSeen})).length === ${cardsBefore + 1}`, 10000)
  await keyboardAway()
  await shot('sent')
  // The canvas keeps the drawing: reopened, send is still possible.
  await mode('scribble', agent)
  await expect('the canvas keeps what was drawn', js`!document.querySelector(${SEL.scribbleSend}).disabled`, 4000)
  await mode('chat', agent)
}

async function groupSidebar() {
  await open('/')
  await settle()
  const list = await ev('__t.sidebar()')
  const rows = list.filter(r => r.name && r.name !== TEXT.inbox)
  const row = name => rows.find(r => r.name === name)
  // Every session has its scribbled mark.
  check(rows.length >= state().agents.filter(a => !a.archived).length - 1, `the sidebar lists ${rows.length} sessions, the board has ${state().agents.length}`)
  check(rows.every(r => r.mark), `sessions without a drawn mark: ${rows.filter(r => !r.mark).map(r => r.name).join(', ')}`)
  // The badge: a red hand when one of the session's questions knocks (urgent, blocking, a permission), else a small stack of cards.
  const knocks = a => openCards(a.id).some(c => !putOff.has(c.id) && (c.kind === 'permission' || c.urgency === 'high' || c.urgency === 'critical'))
  const blocked = row(COURIER)
  if (check(blocked, `"${COURIER}" is not in the sidebar`)) check(blocked.badge?.hand, `"${COURIER}" has a blocking question, but its badge is ${JSON.stringify(blocked.badge)}, expected the raised hand`)
  for (const a of scripted().filter(a => openCards(a.id).some(c => !putOff.has(c.id)))) {
    const b = row(nameOf(a))?.badge
    check(knocks(a) ? b?.hand : b && !b.hand, `a question of "${nameOf(a)}" ${knocks(a) ? 'knocks' : 'does not knock'}, but its badge is ${JSON.stringify(b)}, expected ${knocks(a) ? 'the hand' : 'the stack of cards'}`)
  }
  const busy = scripted().find(a => openCards(a.id).some(c => !putOff.has(c.id)))
  const waiting = openCards(busy?.id).filter(c => !putOff.has(c.id)).length
  // How many questions a session has open: a number in its badge, or (where the badge is a drawing alone) its tooltip.
  if (busy && waiting) check(Number(row(nameOf(busy))?.badge?.number) === waiting || (row(nameOf(busy))?.badge?.number === '' && row(nameOf(busy))?.badge?.title.includes(`${waiting} question`)), `the badge of "${nameOf(busy)}" reads "${row(nameOf(busy))?.badge?.number}" with the tooltip "${row(nameOf(busy))?.badge?.title}", expected its ${waiting} open questions as a number or in the tooltip`)
  const fresh = openCards().filter(c => !putOff.has(c.id) && !agentById(c.agent)?.archived).length
  const deskCount = () => ev(js`(n => n ? __t.text(n) : (__t.sidebar().find(r => r.name === ${TEXT.inbox})?.count ?? ''))(document.querySelector(${SEL.deskTotal}))`)
  check(Number(await deskCount()) === fresh, `the Desk counts "${await deskCount()}", ${fresh} questions need an answer`)

  // Disconnected sessions: at the bottom, under their own heading, with an archive action.
  const names = list.filter(r => r.name && r.name !== TEXT.inbox)
  const firstAway = names.findIndex(r => r.offline)
  check(row(GONE)?.offline, `"${GONE}" is disconnected, but its row does not look it`)
  check(firstAway >= 0 && names.slice(firstAway).every(r => r.offline), `the disconnected sessions are not the last in the sidebar: ${names.map(r => r.name + (r.offline ? ' (away)' : '')).join(', ')}`)
  check(names.filter(r => r.offline).map(r => r.name).sort().join() === state().agents.filter(a => !a.online && !a.archived).map(nameOf).sort().join(), 'the rows shown as disconnected are not the sessions that are disconnected')
  if (!touch) {
    // (A phone shows the sessions as one strip without headings; there the archive action is on the agents page.)
    const awayAt = list.findIndex(r => r.away)
    if (check(awayAt >= 0, 'there is no heading for disconnected sessions')) {
      check(list.slice(awayAt + 1).every(r => r.offline) && list.slice(0, awayAt).every(r => !r.offline), `the heading "${list[awayAt].heading}" does not stand between the connected and the disconnected sessions`)
    }
    const at = await ev(js`__t.box(__t.unit(${GONE}))`)
    await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: Math.round(at.left + 40), y: Math.round(at.top + at.height / 2) })
    await settle()
    const hovered = await ev('__t.sidebar()')
    check(hovered.find(r => r.name === GONE)?.archive, `"${GONE}" offers no archive action`)
    check(hovered.filter(r => r.archive).every(r => r.offline), 'a connected session offers the archive action')
  }
  await checkEnglish('sidebar')
  await shot('sidebar')

  // Archive it: it leaves the sidebar and waits on the agents page, from where it comes back.
  const gone = agentNamed(GONE)
  const without = fresh - openCards(gone.id).length
  if (touch) {
    // A phone has no hover and its line on the agents page only opens the session: is there a way to put a session away?
    await goRoster()
    const way = await ev(js`!!__t.all(${SEL.rosterAct}, __t.rosterCard(${GONE})).find(b => /^Archive/.test(__t.label(b))) || !!__t.one(${SEL.sidebarArchive}, __t.unit(${GONE}))`)
    check(way, `on a phone nothing archives the disconnected session "${GONE}": its line on the agents page only opens it, and the strip of sessions has no archive action`)
    if (way) await press(`"Archive" on "${GONE}"`, js`__t.all(${SEL.rosterAct}, __t.rosterCard(${GONE})).find(b => /^Archive/.test(__t.label(b))) ?? __t.one(${SEL.sidebarArchive}, __t.unit(${GONE}))`)
    else await ev(js`fetch('/session', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ agent: ${agentNamed(GONE).id}, archived: true }) }).then(r => r.status)`)
  } else {
    await press(`archive on "${GONE}"`, js`__t.one(${SEL.sidebarArchive}, __t.unit(${GONE}))`)
  }
  await waitState(`"${GONE}" is archived`, s => s.agents.find(a => a.id === gone.id)?.archived === true)
  await expect(`"${GONE}" leaves the sidebar`, js`!__t.unit(${GONE})`, 3000)
  await expect('its question leaves the inbox count', js`Number((n => n ? __t.text(n) : (__t.sidebar().find(r => r.name === ${TEXT.inbox})?.count ?? ''))(document.querySelector(${SEL.deskTotal}))) === ${without}`, 3000)
  await goRoster()
  const shelf = await expect('the agents page keeps the archived session', js`__t.all(${SEL.rosterArchived}).map(__t.text).find(t => t.includes(${GONE}))`, 3000)
  await shot('archived')
  if (shelf) {
    await press(`"${TEXT.back}" on "${GONE}"`, js`__t.byText('button', ${TEXT.back}, __t.all(${SEL.rosterArchived}).find(n => __t.text(n).includes(${GONE})))`)
    await waitState(`"${GONE}" is back`, s => !s.agents.find(a => a.id === gone.id)?.archived)
    await expect(`"${GONE}" is back in the sidebar`, js`!!__t.unit(${GONE})`, 3000)
  }
}

async function groupPair() {
  const [first, second] = scripted().slice(1)
  await open('/')
  await settle()
  const unitOf = agent => ev(js`(n => n && { box: __t.box(n), members: n.dataset.members })(__t.unit(${nameOf(agent)}))`)
  // On a phone the sessions are a strip that scrolls sideways; both have to be on screen.
  await ev(js`__t.unit(${nameOf(second)})?.scrollIntoView({ inline: 'center', block: 'nearest', behavior: 'instant' })`)
  await settle()
  const from = await unitOf(first), to = await unitOf(second)
  need(from && to, 'the two sessions to lay together are not in the sidebar')
  const mid = u => ({ x: Math.round(Math.max(u.box.left, 0) + Math.min(u.box.width / 2, 60)), y: Math.round(u.box.top + u.box.height / 2) })
  // Drop one session on the other: a mouse drags at once, a finger holds still for a moment first.
  await drag([mid(from), ...line(mid(from), mid(to), 12), mid(to)], { hold: touch ? 700 : 0, pause: 40 })
  const paired = await waitState('the two sessions share a group', s => { const [a, b] = [first, second].map(x => s.agents.find(y => y.id === x.id)); return a.group && a.group === b.group }, 4000).catch(e => { check(false, `dropping "${nameOf(first)}" on "${nameOf(second)}" ${touch ? 'with a finger ' : ''}did not lay them together (${e.message})`); return false })
  if (!paired) return
  current.passed++
  await settle()
  const unit = await expect('the sidebar shows the pair as one row', js`(n => n && n.dataset.members.split(' ').length === 2 && __t.text(n))(__t.all(${SEL.sidebarRow}).find(n => (n.dataset.members ?? '').split(' ').includes(${first.id})))`, 3000)
  if (unit) check(unit.includes(nameOf(first)) && unit.includes(nameOf(second)), `the row of the pair reads "${unit}"`)
  await shot('paired')
  // Opened, both conversations are there.
  await press('the pair in the sidebar', js`__t.all(${SEL.sidebarEntry}).find(n => (n.closest(${SEL.sidebarRow}).dataset.members ?? '').split(' ').includes(${first.id}))`)
  await waitFor('the pair opens', js`!!__t.pane(${first.id}) || !!__t.pane(${second.id})`)
  await settle()
  const panes = await ev(js`__t.all(${SEL.pane}).map(p => p.dataset.agent)`)
  if (touch) check(panes.length === 1, `a phone has room for one conversation of the pair, it shows ${panes.length}`)
  else check(panes.includes(first.id) && panes.includes(second.id) && panes.length === 2, `the pair shows ${panes.length} conversations, expected the two side by side`)
  const title = await ev(js`__t.text(document.querySelector(${SEL.paneTitle}))`)
  check(title.includes(nameOf(first)) && title.includes(nameOf(second)), `the title of the pair reads "${title}"`)
  check((await place()).path.includes(first.id) && (await place()).path.includes(second.id), `the address of the pair is ${(await place()).path}`)
  await shot('pair-open')
  await reload()
  check((await ev(js`__t.all(${SEL.pane}).length`)) === (touch ? 1 : 2), 'after a reload the pair is not shown as before')
  // Sessions laid together: ONE list of the questions of both, each row naming its session.
  if (!touch) {
    const both = [first, second].flatMap(a => openCards(a.id).filter(c => !putOff.has(c.id)))
    const joined = await ev(js`(n => n && __t.rows(n).map(r => ({ id: r.id, from: r.from })))(__t.one(${SEL.groupQuestions}))`)
    if (check(joined, 'the joined view has no list of the questions of its sessions')) {
      check(joined.map(r => r.id).sort().join() === both.map(c => c.id).sort().join(), `the joined list shows ${joined.length} questions, the two sessions have ${both.length} open`)
      const unnamed = joined.filter(r => !r.from.includes(nameOf(agentById(cardOf(r.id).agent))))
      check(!unnamed.length, `${unnamed.length} rows of the joined list do not name their session (e.g. "${cardOf(unnamed[0]?.id)?.title}" says "${unnamed[0]?.from}")`)
      check(await ev(js`__t.all(${SEL.groupQuestions}).length`) === 1, 'the joined view shows more than one list of questions')
    }
  }
  // Split them again on the agents page: the scissors on the chip "with …".
  await goRoster()
  const scissors = js`__t.one(${SEL.rosterSplit}, __t.rosterCard(${nameOf(first)}))`
  if (touch && !(await ev(`!!${scissors}`))) {
    check(false, `on a phone nothing takes "${nameOf(first)}" out of its group: the line on the agents page only opens the session`)
    await ev(js`Promise.all([${first.id}, ${second.id}].map(agent => fetch('/session', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ agent, group: null }) })))`)
  } else await press(`the scissors on "${nameOf(first)}"`, scissors)
  await waitState('the two sessions are apart again', s => !s.agents.find(a => a.id === first.id).group && !s.agents.find(a => a.id === second.id).group, 4000)
  await expect('the sidebar shows two rows again', js`!!__t.unit(${nameOf(first)}) && !!__t.unit(${nameOf(second)})`, 3000)
}

async function groupUrls() {
  const agent = scripted()[0]
  const home = `/s/${agent.id}`
  await open('/')
  const at = async (what, pathname, want) => {
    const now = await place()
    check(now.path === pathname, `${what}: the address is ${now.path}, expected ${pathname}`)
    for (const [k, v] of Object.entries(want)) check(now[k] === v, `${what}: the page shows ${k}="${now[k]}", expected "${v}"`)
  }
  const shows = {
    '/': js`__t.vis(document.querySelector(${SEL.inbox}))`,
    [home]: js`!!__t.pane(${agent.id}) && __t.all(${SEL.message}).length > 0`,
    [`${home}/questions`]: js`!!__t.one(${SEL.questionsPane}) && !__t.all(${SEL.message}).length`,
    [`${home}/scribble`]: js`!!__t.one(${SEL.scribbleCanvas})`,
    '/agents': '__t.vis(document.querySelector("#ledger")) && document.querySelectorAll("#ledger .ledger-line").length > 0',   // the Agents page is the Ledger
  }
  const seenIs = async (what, pathname) => { await expect(`${what}: the page shows what ${pathname} names`, shows[pathname], 4000) }

  // Every step the human takes has an address.
  await at('the inbox', '/', { page: '', scope: 'all' })
  await goSession(agent)
  await at('a session', home, { view: 'chat', filter: '' })
  // (On a wide window the questions lie beside the conversation; there is no "Questions only" then, and its old address is the session's.)
  const beside = !(await ev(js`!!__t.one(${SEL.filterQuestions})`))
  const filtered = beside ? [] : [`${home}/questions`]
  if (!beside) {
    await press('"Questions only"', js`__t.one(${SEL.filterQuestions})`)
    await settle()
    await at('"Questions only"', `${home}/questions`, { view: 'chat', filter: 'questions' })
  }
  await mode('scribble', agent)
  await at('scribble', `${home}/scribble`, { view: 'scribble' })
  await goRoster()
  await at('the agents page', '/agents', { page: 'roster' })

  // Back and forward walk the same steps.
  // A step may leave the page altogether when an entry is missing; then the page loads anew.
  const walk = async dir => { await ev(`history.${dir}()`).catch(() => {}); await sleep(300); await appReady().catch(() => {}); await settle() }
  const back = () => walk('back'), forward = () => walk('forward')
  for (const p of [`${home}/scribble`, ...filtered, home, '/']) { await back(); await at(`back to ${p}`, p, {}); await seenIs(`back to ${p}`, p) }
  for (const p of [home, ...filtered, `${home}/scribble`, '/agents']) { await forward(); await at(`forward to ${p}`, p, {}); await seenIs(`forward to ${p}`, p) }

  // A reload stays where it was, and each address opens its view directly.
  if (beside) {
    check(await open(`${home}/questions`) === 200, `${home}/questions is not served`)
    await expect('an old link to "Questions only" lands on the session, its questions beside the conversation', js`location.pathname === ${home} && !!__t.one(${SEL.questionsPane}) && __t.all(${SEL.message}).length > 0`, 4000)
  }
  for (const p of ['/agents', `${home}/scribble`, ...filtered, home, '/']) {
    check(await open(p) === 200, `${p} is not served`)
    await at(`opened directly, ${p}`, p, {})
    await seenIs(`opened directly, ${p}`, p)
    await reload()
    await at(`after a reload of ${p}`, p, {})
    await seenIs(`after a reload of ${p}`, p)
    if (p !== '/') await shot(`direct-${p.split('/').filter(Boolean).at(-1).replace(/\W+/g, '-').slice(0, 20)}`)
  }
  // An address that names nothing ends somewhere sensible, without an error.
  check(await open('/s/no-such-session') === 200, 'the address of an unknown session is not served')
  await expect('an unknown session falls back to the inbox', js`__t.vis(document.querySelector(${SEL.inbox}))`, 3000)
  await open('/')
}

/** A way to a session's name, drawing and crown: its line on the Agents page, or (a phone's line only opens) its own title. */
async function sessionControl(name, what) {
  const sel = touch ? { rename: SEL.paneRename, mark: SEL.paneMark, crown: SEL.paneCrown }[what] : { rename: SEL.rosterRename, mark: SEL.rosterEdit, crown: SEL.rosterStar }[what]
  if (touch) {
    await goSession(agentNamed(name))
    if (!(await ev(js`!!__t.one(${sel})`))) return false
    await press(`the ${what} of "${name}" in its title`, js`__t.one(${sel})`)
  } else {
    await goRoster()
    await press(`the ${what} of "${name}" in its line`, js`__t.rosterCard(${name}).querySelector(${sel})`)
  }
  return true
}
const post = (pathname, body) => ev(js`fetch(${pathname}, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(${body}) }).then(r => r.status)`)

async function groupAgents() {
  await open('/')
  await goRoster()
  const cards = await ev('__t.roster()')
  const listed = state().agents.filter(a => !a.archived)
  check(cards.length === listed.length, `the agents page lists ${cards.length} sessions, the board has ${listed.length}`)
  for (const agent of listed) {
    const card = cards.find(c => c.name === nameOf(agent))
    if (!check(card, `the agents page lacks the session "${nameOf(agent)}"`)) continue
    check(card.facts[TEXT.model] === agent.model, `"${nameOf(agent)}" shows the model "${card.facts[TEXT.model]}", it introduced itself as "${agent.model}"`)
    const machine = card.facts[TEXT.machine] ?? ''
    check(machine && machine !== TEXT.unknown && machine.includes(agent.host), `"${nameOf(agent)}" shows the machine "${machine}", it runs on "${agent.host}"`)
    const open = openCards(agent.id).filter(c => !putOff.has(c.id)).length
    if (open) check(card.count === String(open), `the line of "${nameOf(agent)}" counts "${card.count}" (${card.state}), it has ${open} open questions`)
  }
  const away = cards.filter(c => /away/.test(c.state)).map(c => c.name)
  check(!away.length || away.join() === state().agents.filter(a => !a.online && !a.archived).map(nameOf).join() && cards.slice(-away.length).every(c => away.includes(c.name)), `the disconnected sessions are not the last lines of the agents page: ${cards.map(c => `${c.name} (${c.state})`).join(', ')}`)
  await checkEnglish('agents page')
  await shot('agents')

  if (!touch) {
    // The first question of a session is answered in its line, and the note takes it back.
    const gone = agentNamed(GONE), asked = openCards(gone.id)[0]
    if (asked && asked.options.length === 2) {
      await press(`the thumb up in the line of "${GONE}"`, js`__t.all(${SEL.rosterAnswer}, __t.rosterCard(${GONE})).find(b => b.dataset.answer === 'yes')`)
      await waitState('the answer in the line reaches the board', () => cardOf(asked.id).status !== 'open', 4000).then(() => passed(), e => check(false, e.message))
      check(cardOf(asked.id).choice === asked.options[0].key, `the thumb up in the line chose "${cardOf(asked.id).choice}"`)
      if (await expect('the note offers to take the answer back', js`!!__t.note()?.back`, 3000)) {
        await shot('answered-in-line')
        const taken = await press('the way back', js`__t.one(${SEL.noteBack}, __t.one(${SEL.undoBar}))`).then(() => true, e => { if (!(e instanceof Failed)) throw e; return check(false, `after an answer in a line of the agents page: ${e.message}`) })
        if (taken) await waitState('the answer is taken back', () => cardOf(asked.id).status === 'open', 4000).then(() => passed(), e => check(false, e.message))
      }
      if (cardOf(asked.id).status !== 'open') { await post('/reopen', { card_id: asked.id }); await waitState('the answer is taken back', () => cardOf(asked.id).status === 'open', 4000) }
      await sleep(4200)   // the note has gone
      await settle()
    }
    // A click on a column head sorts; "Back to your order" returns.
    const names = () => ev('__t.roster().filter(c => !/away/.test(c.state)).map(c => c.name)')
    const own = await names()
    await press('the column head "Session"', js`__t.byText(${SEL.rosterHead}, 'Session')`)
    await settle()
    const sorted = await names()
    check(sorted.join() === [...own].sort((a, b) => (a.toLowerCase() > b.toLowerCase() ? 1 : -1)).join(), `sorted by "Session" the lines read ${sorted.join(', ')}`)
    await press('"Back to your order"', js`__t.one(${SEL.rosterOrder})`)
    await settle()
    check((await names()).join() === own.join(), `"Back to your order" leaves the lines as ${(await names()).join(', ')}, they were ${own.join(', ')}`)
    // The keys of the page: "/" finds, the arrows pick a line, Shift+arrow moves it, C is the crown, Enter opens.
    await ev('document.activeElement?.blur?.()')
    await key('/', 191, { text: '/' })
    check(await ev(js`document.activeElement === document.querySelector(${SEL.rosterFind})`), 'the key "/" does not put the caret into the field that finds a session')
    await type(COURIER.slice(0, 4).toLowerCase())
    await expect('typing into the field leaves the sessions that fit', js`__t.roster().map(c => c.name).join() === ${COURIER}`, 2000)
    await escape()
    await expect('Escape empties the field and shows all again', js`__t.roster().length === ${listed.length}`, 2000)
    await ev('document.activeElement?.blur?.()')
    await key('ArrowDown', 40)
    await expect('the arrow picks the first line', js`__t.roster()[0].current`, 2000)
    await key('ArrowDown', 40)
    await expect('the arrow goes on to the second line', js`__t.roster()[1].current`, 2000)
    const second = own[1], before = state().agents.map(a => a.id).join()
    await key('ArrowUp', 38, { modifiers: 8 })
    await waitState('Shift and an arrow move the picked line', s => s.agents.map(a => a.id).join() !== before, 3000).then(() => passed(), e => check(false, e.message))
    await expect('the sidebar follows the new order', js`(names => names.indexOf(${second}) < names.indexOf(${own[0]}))(__t.sidebar().filter(r => r.name).map(r => r.name))`, 3000)
    await key('ArrowDown', 40, { modifiers: 8 })
    await waitState('Shift and the other arrow move it back', s => s.agents.map(a => a.id).join() === before, 3000).then(() => passed(), e => check(false, e.message))
    const picked = agentNamed(second)
    await key('c', 67, { text: 'c' })
    await waitState('C puts the crown on the picked session', s => s.agents.find(a => a.id === picked.id).starred, 3000).then(() => passed(), e => check(false, e.message))
    await key('c', 67, { text: 'c' })
    await waitState('C takes the crown off again', s => !s.agents.find(a => a.id === picked.id).starred, 3000).then(() => passed(), e => check(false, e.message))
    await key('Enter', 13, { text: '\r' })
    await expect('Enter opens the picked session', js`location.pathname === ${`/s/${picked.id}`} && !!__t.pane(${picked.id})`, 3000)
    await goRoster()
  } else {
    // A phone's line is small: a tap opens the session.
    const first = listed[0]
    await press(`the line of "${nameOf(first)}"`, js`__t.rosterCard(${nameOf(first)}).querySelector(${SEL.rosterName})`)
    await expect('a tap on a line opens the session', js`location.pathname === ${`/s/${first.id}`} && !!__t.pane(${first.id})`, 3000)
  }

  // Rename a session: its name is the way in.
  const target = scripted()[1]
  const oldName = nameOf(target)
  const newName = `Interface ${size}`
  const oldMark = cards.find(c => c.name === oldName).mark
  let chosen = null
  const reach = await sessionControl(oldName, 'rename')
  // (Seen on a phone: a single session has no title there, and its line on the agents page only opens it.)
  check(reach, 'on a phone nothing renames a session, chooses its drawing or sets its crown: a single session has no title, and its line on the agents page only opens it')
  if (reach) {
  await waitFor('the editor opens', js`!!__t.one(${SEL.editor})`)
  await press('the name field', js`__t.one(${SEL.editorName})`)
  await retype(newName)
  await shot('editor')
  await press('save', js`__t.one(${SEL.editorSave})`)
  await waitFor('the editor closes', js`!__t.one(${SEL.editor})`)
  await waitState(`the session is called "${newName}"`, s => s.agents.some(a => nameOf(a) === newName))
  await goRoster()
  await waitFor(`the session is listed as "${newName}"`, js`!!__t.rosterCard(${newName})`)
  check(await ev(js`!!__t.entry(${newName}) && !__t.entry(${oldName})`), `the sidebar does not show the new name "${newName}"`)

  // Choose another mark: its picture is the way in, and one press on a drawing is the choice.
  const drawn = b => `[...${b}.querySelectorAll('path')].map(p => p.getAttribute('d')).join(' ')`
  await sessionControl(newName, 'mark')
  await waitFor('the marks to choose from appear', js`__t.all(${SEL.markTile}).length > 1`)
  await settle()
  const offered = await ev(`__t.all(${JSON.stringify(SEL.markTile)}).map(b => ({ name: __t.label(b), on: b.getAttribute('aria-checked') === 'true', d: ${drawn('b')} }))`)
  check(offered.filter(o => o.on).length <= 1, `${offered.filter(o => o.on).length} marks show as chosen`)
  check(new Set(offered.map(o => o.d)).size === offered.length, `the same drawing is offered more than once among the ${offered.length} marks`)
  if (touch) check(!(await ev('__t.overflow()')).length, `the marks to choose from are wider than the phone: ${(await ev('__t.overflow()')).join('; ')}`)
  await shot('marks')
  const pick = offered.find(o => !o.on && o.d !== oldMark)
  await press(`the mark "${pick.name}"`, js`__t.all(${SEL.markTile}).find(b => __t.label(b) === ${pick.name})`)
  await expect('choosing a mark closes the picker', js`!__t.one(${SEL.markPicker})`, 3000)
  await waitState('the board keeps the chosen mark', s => (s.agents.find(a => a.id === target.id).icon ?? '') !== (target.icon ?? ''), 3000).then(() => passed(), e => check(false, e.message))
  chosen = agentById(target.id).icon
  await sessionControl(newName, 'mark')
  await waitFor('the marks to choose from appear', js`__t.all(${SEL.markTile}).length > 1`)
  check(await ev(js`__t.all(${SEL.markTile}).filter(b => b.getAttribute('aria-checked') === 'true').map(__t.label).join()`) === pick.name, 'the picker does not show the chosen mark as chosen')
  await escape()
  await expect('Escape closes the picker', js`!__t.one(${SEL.markPicker})`, 3000)

  }
  // VIP: the crown is the switch, and the questions of that session lead the inbox.
  const vip = scripted().findLast(a => openCards(a.id).some(c => !putOff.has(c.id)) && a.id !== target.id)
  need(vip, 'no scripted session with open questions; the fixture changed')
  if (!(await sessionControl(nameOf(vip), 'crown'))) await post('/star', { agent: vip.id, starred: true })
  await waitState(`"${nameOf(vip)}" is starred`, s => s.agents.find(a => a.id === vip.id).starred)
  await goRoster()
  await expect('the crown on the agents page shows as set', js`__t.roster().find(c => c.name === ${nameOf(vip)}).starred`)
  // The crown on a session's mark in the sidebar is the same switch: one click takes VIP away, one puts it back.
  const crownOf = js`__t.one(${SEL.crownToggle}, __t.unit(${nameOf(vip)}))`
  if (!touch && await ev(`!!${crownOf}`)) {
    check(await ev(`${crownOf}.getAttribute('aria-pressed')`) === 'true', 'the crown in the sidebar does not show the session as VIP')
    const pressed = await press(`the crown of "${nameOf(vip)}" in the sidebar`, crownOf).then(() => true, e => { if (!(e instanceof Failed)) throw e; return check(false, e.message) })
    if (pressed) {
      await waitState('a click on the crown takes VIP away', s => !s.agents.find(a => a.id === vip.id).starred, 4000).then(() => passed(), e => check(false, e.message))
      await settle()
      if (!agentById(vip.id).starred) {
        await sessionControl(nameOf(vip), 'crown')
        await waitState(`"${nameOf(vip)}" is starred again`, s => s.agents.find(a => a.id === vip.id).starred)
      }
    }
  }

  await reload()
  await goRoster()
  const again = await ev('__t.roster()')
  if (reach) {
    check(again.find(c => c.name === newName), `after a reload the session is no longer called "${newName}": ${again.map(c => c.name).join(', ')}`)
    check(agentById(target.id).icon === chosen, 'after a reload the session has another mark than the chosen one')
  }
  check(again.find(c => c.name === nameOf(vip))?.starred, 'after a reload the crown is gone')
  await shot('renamed-starred')

  await goInbox()
  const top = (await ev('__t.groups()'))[0]
  check(top.name.replace(/^★ /, '') === nameOf(vip), `the VIP session "${nameOf(vip)}" is not the first group of the inbox, "${top.name}" is`)
  // The mark stands once on the heading of the group, or on each of its rows.
  // The crown stands where the session is named: on the group, on each row, or (a run of rows names its sender once) on the first.
  check(top.vip || (await ev('__t.rows()')).filter(r => top.ids.includes(r.id)).some(r => r.vip) || await ev(js`!!document.querySelector(${SEL.inbox + ' .inbox-gutter .crown-mark, ' + SEL.inbox + ' [data-vip] .crown-mark'})`), 'the questions of the VIP session are not marked VIP')
  const marked = (await ev('__t.rows()')).filter(r => r.vip && !top.ids.includes(r.id) && !putOff.has(r.id))
  check((await ev('__t.groups()')).slice(1).every(g => !g.vip) && !marked.length, `a session that is not VIP carries the VIP mark${marked.length ? `: the row "${marked[0].title}"` : ''}`)
  await shot('inbox-vip')

  // Put things back, so the next group finds the board as it was: an emptied name is the session's own again.
  if (!(await sessionControl(nameOf(vip), 'crown'))) await post('/star', { agent: vip.id, starred: false })
  await waitState('the crown is off again', s => !s.agents.find(a => a.id === vip.id).starred)
  if (!reach) return
  await sessionControl(newName, 'rename')
  await waitFor('the editor opens', js`!!__t.one(${SEL.editor})`)
  await press('the name field', js`__t.one(${SEL.editorName})`)
  await retype(target.name)
  await press('save', js`__t.one(${SEL.editorSave})`)
  await waitFor('the editor closes', js`!__t.one(${SEL.editor})`)
  await waitState(`the session is called "${target.name}" again`, s => s.agents.some(a => a.id === target.id && nameOf(a) === target.name), 3000).then(() => passed(), e => check(false, e.message))
}

const closeMenu = async () => { if (await ev(js`!!__t.one(${SEL.brandDoors})`)) { await escape(); await settle() } }
/** The switch between light and dark: in the bar, or one of the entries of the menu at the logo. */
async function pressTheme() {
  if (!(await ev(js`__t.vis(document.querySelector(${SEL.themeToggle}))`))) {
    await press('the logo', js`__t.one(${SEL.brandMenu})`)
    await waitFor('the menu at the logo shows the theme switch', js`__t.vis(document.querySelector(${SEL.themeToggle}))`, 3000)
  }
  await press('the theme toggle', js`document.querySelector(${SEL.themeToggle})`)
}

async function groupTheme() {
  await open('/')
  const theme = () => ev('document.documentElement.dataset.theme ?? "light"')
  const paper = () => ev('getComputedStyle(document.body).backgroundColor')
  const start = await theme()
  const startPaper = await paper()
  const other = start === 'dark' ? 'light' : 'dark'
  await pressTheme()
  await waitFor(`the toggle switches to ${other}`, js`(document.documentElement.dataset.theme ?? 'light') === ${other}`, 2000)
  await settle()
  await closeMenu()
  check(await paper() !== startPaper, 'the page looks the same in both themes')
  check(await ev(js`document.querySelector(${SEL.themeToggle}).getAttribute('aria-pressed')`) === String(other === 'dark'), 'the toggle does not say which theme is on')
  await reload()
  check(await theme() === other, `after a reload the theme is ${await theme()} again`)
  await open('/agents')
  check(await theme() === other, `on another page the theme is ${await theme()} again`)
  await shot(`${other}`)
  await closeMenu()
  await pressTheme()
  await waitFor(`the toggle switches back to ${start}`, js`(document.documentElement.dataset.theme ?? 'light') === ${start}`, 2000)
  await reload()
  check(await theme() === start, `after switching back and a reload the theme is ${await theme()}`)
}

async function groupHelp() {
  await open('/')
  // Help, Admin and Keys are behind the logo.
  need(await ev(js`!!__t.one(${SEL.brandMenu})`), 'the logo is not a button that opens the menu')
  check(!(await ev(js`!!__t.one(${SEL.brandDoors})`)), 'the menu at the logo stands open before it was asked for')
  await press('the logo', js`__t.one(${SEL.brandMenu})`)
  await waitFor('the logo opens its menu', js`!!__t.one(${SEL.brandDoors})`, 3000)
  await settle()
  const doors = await ev(js`__t.all(${SEL.menuItem}, ${SEL.brandDoors}).map(n => __t.text(n).replace(/[ ?]+$/, ''))`)
  check(['Agents', 'Help', 'Admin'].every(d => doors.includes(d)), `the menu at the logo offers "${doors.join('", "')}", expected Agents, Help and Admin among them`)
  const inView = await ev(js`(b => b.left >= 0 && b.top >= 0 && b.right <= innerWidth && b.bottom <= innerHeight)(__t.box(__t.one(${SEL.brandDoors})))`)
  check(inView, 'the menu at the logo reaches out of the screen')
  await checkEnglish('the menu at the logo')
  await shot('menu')
  await escape()
  await expect('Escape closes the menu', js`!__t.one(${SEL.brandDoors})`, 2000)
  // The sheet of all keys: behind a "?" in the bar (or in the menu). A phone has no keyboard, and no such door.
  if (!touch) {
    if (!(await ev(js`!!__t.one(${SEL.keysOpen})`))) { await press('the logo', js`__t.one(${SEL.brandMenu})`); await settle() }
    need(await ev(js`!!__t.one(${SEL.keysOpen})`), 'neither the bar nor the menu at the logo opens the sheet of keys')
    await press('the door to the keys', js`__t.one(${SEL.keysOpen})`)
    if (await expect('it opens the sheet of all keys', js`!!__t.one(${SEL.keysSheet})`, 3000)) {
      check(!(await ev(js`!!__t.one(${SEL.brandDoors})`)), 'the menu stays open under the sheet of keys')
      await checkEnglish('the sheet of keys')
      await shot('keys')
      await escape()
      await expect('Escape closes the sheet of keys', js`!__t.one(${SEL.keysSheet})`, 3000)
    }
  }
  await press('the logo', js`__t.one(${SEL.brandMenu})`)
  await waitFor('the logo opens its menu again', js`!!__t.one(${SEL.brandDoors})`, 3000)
  check((await ev(js`__t.one(${SEL.adminLink}, ${SEL.brandDoors})?.getAttribute('href')`)) === '/admin.html', 'the menu does not lead to the admin page')
  const link = await ev(js`(a => a && a.getAttribute('href'))(__t.one(${SEL.helpLink}, ${SEL.brandDoors}))`)
  need(link, 'the menu at the logo has no link to the help page')
  const res = await fetch(base + link, { headers: { cookie: `board_${port}=${token}` } })
  need(res.status === 200, `the help link ${link} answers ${res.status}`)
  await press('the help link', js`__t.one(${SEL.helpLink}, ${SEL.brandDoors})`)
  await waitFor('the help page opens', js`location.pathname === ${link} && document.readyState === 'complete'`, 6000)
  await waitFor('the help page has loaded its content', '!!window.__t && document.body.innerText.trim().length > 400', 6000)
  await settle()
  check((await ev('document.title')).length > 0 && !GERMAN.test(await ev('document.title')), `the help page is titled "${await ev('document.title')}"`)
  check(await ev('document.documentElement.lang') === 'en', `the help page declares the language "${await ev('document.documentElement.lang')}"`)
  check(await ev('document.querySelectorAll("h1, h2").length') >= 2, 'the help page has no headings')
  await checkEnglish('help page')
  await shot('help')
  const home = await ev(`(a => a && a.getAttribute('href'))([...document.querySelectorAll('a')].find(a => new URL(a.href).pathname === '/'))`)
  check(home, 'the help page offers no way back to the board')
}

async function groupAdmin() {
  const cookie = `board_${port}=${token}`
  // The key of the board is not the key of the admin page.
  const api = await fetch(`${base}/admin/api/overview`, { headers: { cookie } })
  check(api.status === 403, `the admin API answered ${api.status} without the admin key, expected 403`)
  tolerate = entry => entry.status === 403 && String(entry.url).includes('/admin/')
  await page.send('Network.deleteCookies', { name: `board_admin_${port}`, url: base })
  check(await load(`${base}/admin.html`) === 200, 'the admin page is not served')
  await waitFor('the admin page asks for its key', js`!!window.__t && !!__t.one(${SEL.adminGate})`, 6000)
  check(!(await ev(js`!!__t.one(${SEL.adminMain})`)), 'the admin page shows its content without the key')
  await checkEnglish('admin gate')
  await shot('gate')
  await press('the key field', js`__t.one(${SEL.adminKey})`)
  await type('not-the-key')
  await press('open', js`__t.one(${SEL.adminOpen})`)
  await expect('a wrong key is refused with a message', js`!!__t.one(${SEL.adminError}) && !__t.one(${SEL.adminMain})`, 4000)
  await press('the key field', js`__t.one(${SEL.adminKey})`)
  await retype(adminKey)
  await press('open', js`__t.one(${SEL.adminOpen})`)
  await waitFor('the right key opens the admin page', js`!!__t.one(${SEL.adminMain}) && !__t.one(${SEL.adminGate})`, 6000)
  tolerate = null
  await settle()
  const sections = await ev(js`__t.all(${SEL.adminSection}).filter(s => __t.text(s).length > 0).length`)
  check(sections >= 5, `the admin page shows ${sections} sections with content, expected at least five`)
  const text = await ev('document.body.innerText')
  for (const a of state().agents.slice(0, 3)) check(text.includes(nameOf(a)), `the admin page does not list the session "${nameOf(a)}"`)
  check(await ev('document.documentElement.lang') === 'en', `the admin page declares the language "${await ev('document.documentElement.lang')}"`)
  await checkEnglish('admin page')
  await shot('admin')
  await load()
  await expect('after a reload the admin page is still open', js`!!window.__t && !!__t.one(${SEL.adminMain})`, 6000)
  await page.send('Network.deleteCookies', { name: `board_admin_${port}`, url: base })
}

async function groupImages() {
  const stamp = tag()
  const heavy = await fixture.heavy(`Pictures (${stamp})`)
  await open('/')
  await goInbox()
  await waitFor('the new question is listed', js`!!__t.row(${heavy.id})`)
  // In the rows of the inbox: every card with pictures shows one, and it loads.
  const withPictures = openCards().filter(c => pictures(c).length && !agentById(c.agent)?.archived)
  for (const card of withPictures) check(await ev(js`__t.all(${SEL.rowThumbImage}, __t.row(${card.id})).length > 0`), `the row "${card.title}" shows none of its ${pictures(card).length} pictures`)
  await checkPictures('the rows of the inbox', SEL.rowThumbImage, SEL.inbox, withPictures.length)
  await ev(js`__t.row(${heavy.id}).scrollIntoView({ block: 'center', behavior: 'instant' })`)
  await shot('rows')
  // The small picture opens large without leaving the list.
  await press(`the picture on "${heavy.title}"`, js`__t.one(${SEL.rowThumb}, __t.row(${heavy.id}))`)
  if (await expect('the picture of a row opens large', js`!!__t.one(${SEL.lightbox})`, 3000)) {
    await checkPictures('the large picture', SEL.lightboxImage)
    await shot('large')
    await escape()
    await expect('Escape closes the large picture', js`!__t.one(${SEL.lightbox})`, 3000)
  }
  check((await place()).path === '/', `after looking at a picture the address is ${(await place()).path}`)
  // In a conversation: what an agent attached to a message.
  await goSession(agentNamed(COURIER))
  await checkPictures('the pictures of a message', SEL.messageImage, null, 2)
  await checkPictures('every picture of the conversation', `${SEL.pane} img`, null, 2)
  await shot('conversation')
}

/** No checks of its own beyond what every step checks: each view in both themes, to look at. */
async function groupGallery() {
  const agent = scripted()[0]
  const light = await fixture.light(`Gallery (${tag()})`)
  const views = [
    ['inbox', '/', async () => { await ev(js`document.querySelector(${SEL.inbox}).scrollTo?.(0, 0)`) }],
    ['inbox-unfolded', '/', async () => { await press('choose', js`__t.tile(${light.id}, 'right')`); await sleep(400) }],
    ['window', `/?q=${state().queue[0]}`, async () => { await waitFor('the window', '__t.focusOpen()', 5000) }],
    ['conversation', `/s/${agent.id}`, null],
    ['questions-only', `/s/${agent.id}/questions`, null],
    ['files', `/s/${agentNamed(COURIER).id}/files`, null],
    ['scribble', `/s/${agent.id}/scribble`, async () => { await waitFor('the canvas', js`!!__t.one(${SEL.scribbleCanvas})`, 5000); await sleep(500) }],
    ['agents', '/agents', null],
  ]
  const setTheme = async dark => {
    if ((await ev('document.documentElement.dataset.theme === "dark"')) !== dark) await ev(js`document.querySelector(${SEL.themeToggle}).click()`)
  }
  for (const dark of [false, true]) {
    for (const [name, pathname, prepare] of views) {
      await open(pathname)
      await setTheme(dark)
      try { await prepare?.() } catch (err) { check(false, `${name}: ${err.message}`) }
      await settle()
      await ev('document.activeElement?.blur?.()')
      await shot(`${name}-${dark ? 'dark' : 'light'}`)
      current.passed++
    }
  }
  await open('/')
  await setTheme(false)
  await courier.tool('withdraw_card', { card_id: light.id, reason: 'the gallery is done' }).catch(() => {})
}

// ---- the big window: the walk, its composer and its ways out --------------------

/** In the walk, bring a card to the front. Where the walk is one scrolling column, the card is scrolled to and
 *  touched (its title), as a hand would; where it shows one card at a time, the arrows beside the sheet page to it. */
async function walkTo(card) {
  const isFront = () => ev(js`__t.focusState()?.id === ${card.id}`)
  if (await isFront()) { await settle(); return true }
  if (await ev(js`!!document.querySelector(${SEL.focusList})`)) {
    const node = js`[...document.querySelectorAll(${SEL.focusAnyCard})].find(n => n.dataset.id === ${card.id})`
    if (!(await ev(`!!${node}`))) return false
    await ev(`${node}.scrollIntoView({ block: 'center', behavior: 'instant' })`)
    await sleep(250)
    await settle()
    if (!(await isFront())) {
      await press(`the card "${card.title}" in the walk`, `${node}.querySelector(${JSON.stringify(SEL.focusTitle)})`)
      // (Where one writes anywhere on a card, that click also began a note at the title: an empty note goes when it is left.)
      await sleep(150)
      await ev('document.activeElement?.blur?.()')
    }
    await waitFor(`"${card.title}" is the card in front`, js`__t.focusState()?.id === ${card.id}`, 3000).catch(() => {})
    await settle()
    return isFront()
  }
  const n = state().queue.length + 2
  for (const [word, sel] of [['next', SEL.focusNext], ['previous', SEL.focusPrev]]) {
    for (let i = 0; i < n; i++) {
      if (await isFront()) { await settle(); return true }
      await settle()
      if (!(await ev(js`(b => !!b && !b.disabled)(__t.one(${sel}))`))) break
      const before = await ev('__t.focusState()?.id ?? null')
      await press(`${word} in the walk`, js`__t.one(${sel})`)
      if (!(await waitFor('the walk shows another question', js`(s => s && s.id && s.id !== ${before})(__t.focusState())`, 2500).catch(() => false))) break
    }
  }
  return isFront()
}
const front = () => ev('__t.focusState()')
const said = card => state().messages.filter(m => m.card_id === card.id && m.from === 'user')
const screen = () => (touch ? PHONE : DESKTOP)
const walkCard = card => js`[...document.querySelectorAll(${SEL.focusAnyCard})].find(n => n.dataset.id === ${card.id})`
const stripOf = card => ev(js`__t.note(true, ${card.title})`)
/** Begin to write about the card in front. Where one writes on the card itself, a click on its title (or key A) puts a
 *  note there; where the card has a "Discuss" column, that is opened and its field takes the words. Returns the
 *  kind of place ('note' | 'field'), or null when there is nowhere to write. */
async function beginNote(card, byKey = false) {
  const ready = sel => `(n => !!n && document.activeElement === n)(__t.one(${JSON.stringify(sel)}, ${walkCard(card)}))`
  if (byKey) await key('a', 65, { text: 'a' })
  else await press(`the title of "${card.title}"`, `${walkCard(card)}.querySelector(${JSON.stringify(SEL.focusTitle)})`)
  if (await waitFor('a note opens on the card', ready(SEL.focusMark), 1500).catch(() => false)) return 'note'
  if (await ev(ready(SEL.focusField))) return 'field'
  if (await ev(`!!__t.one(${JSON.stringify(SEL.focusDiscuss)}, ${walkCard(card)})`)) {
    if (!(await ev(`!!__t.one(${JSON.stringify(SEL.focusField)}, ${walkCard(card)})`))) await press('"Discuss" on the card', `__t.one(${JSON.stringify(SEL.focusDiscuss)}, ${walkCard(card)})`)
    await settle()
    if (await ev(`!!__t.one(${JSON.stringify(SEL.focusField)}, ${walkCard(card)})`)) { await press('the field of the Discuss column', `__t.one(${JSON.stringify(SEL.focusField)}, ${walkCard(card)})`); return 'field' }
  }
  return null
}

async function groupWalk() {
  const stamp = tag()
  const high = { urgency: 'high', urgency_reason: 'so that the walk comes to it early' }
  const talk = await fixture.quick(`Walk: a note, then the answer (${stamp})?`, high)
  const take = await fixture.quick(`Walk: answer and take back (${stamp})?`, high)
  const off = await fixture.quick(`Walk: snooze (${stamp})?`, high)
  const explain = await fixture.light(`Walk: explain (${stamp})`, high)
  const hand = await fixture.light(`Walk: revise (${stamp})`, high)
  const trusted = await fixture.light(`Walk: trust (${stamp})`, high)
  const shredded = await fixture.quick(`Walk: shred (${stamp})?`, high)
  const files = await fixture.quick(`Walk: files and a scribble (${stamp})?`, high)
  const all = [talk, take, off, explain, hand, trusted, shredded, files]
  // Each part stands for itself: one that cannot run (a control that is being rebuilt) is named, and the rest still runs.
  const part = async (what, fn) => { try { await fn() } catch (e) { if (!(e instanceof Failed)) throw e; check(false, `${what}: ${e.message}`); await ev('document.activeElement?.blur?.()').catch(() => {}) } }
  await open('/')
  await goInbox()
  await waitFor('the new questions are listed', js`!!__t.row(${files.id})`)
  await settle()

  // The module of the window loads: a broken import would leave the walk dead.
  const loaded = await ev(`import('/js/focus.js').then(m => typeof m.mountFocus === 'function' ? 'ok' : 'no mountFocus', e => String(e?.message ?? e))`)
  need(loaded === 'ok', `the Focus window does not load: ${loaded}`)
  passed()

  // The button in the inbox's heading starts the walk, in the big window, under its own address.
  await ev(js`document.querySelector(${SEL.inbox}).scrollTo?.(0, 0)`)
  await press('the walk button in the heading', js`__t.one(${SEL.goThrough})`)
  await waitFor('the button opens the walk', '__t.focusOpen() && !!__t.focusState().id')
  await settle()
  check(!(await front()).single, 'the button opened the window of one card, not the walk')
  check((await ev('location.pathname')) === '/walk', `the walk has no address of its own: ${await ev('location.pathname + location.search')}`)
  check(await ev(js`!!__t.one(${SEL.focusRail})`), 'the walk does not say how far it is (no rail, no "… more" line)')
  // The pass keeps its order: what stands in the column is the line of open questions as it was when the walk began.
  const order = await ev(js`[...document.querySelectorAll(${SEL.focusAnyCard})].map(n => n.dataset.id)`)
  const queueLine = state().queue.filter(id => !putOff.has(id) && cardOf(id)?.status === 'open' && !cardOf(id).with_agent && !agentById(cardOf(id).agent)?.archived)
  check(order.join() === queueLine.join(), `the walk does not go through the questions in the order of the line: it shows ${order.length}, the line has ${queueLine.length}${order.length === queueLine.length ? ', in another order' : ''}`)

  // No composer: one writes on the card itself. Beside the answers stand the ways to leave a card without answering.
  need(await walkTo(talk), `the walk never came to "${talk.title}"`)
  const fields = await ev(js`__t.all(${SEL.focusField}, __t.one(${SEL.focusCard})).length`)
  check(fields <= 1, `the card in front shows ${fields} fields to write in`)
  // (The words on them changed more than once; what counts is that each way is there.)
  const ways = await ev(js`Object.fromEntries(Object.entries({ revise: ${SEL.focusHand}, snooze: ${SEL.focusLater}, shred: ${SEL.focusShred}, trust: ${SEL.focusTrust}, explain: ${SEL.focusExplain} }).map(([k, sel]) => [k, (n => n && (__t.text(n) || __t.label(n)).slice(0, 40))(__t.one(sel, __t.one(${SEL.focusCard})))]))`)
  const missing = ['revise', 'snooze', 'shred', 'trust'].filter(k => !ways[k])
  check(!missing.length, `the card in front lacks a way to ${missing.join(', ')} (it offers: ${Object.entries(ways).filter(([, v]) => v).map(([k, v]) => `${k} "${v}"`).join(', ')})`)
  if (!ways.explain) note('the card has no "What??" (explain) control; that part is not checked')
  await checkEnglish('the walk')
  await shot('walk-card')
  if (touch) {
    // On a phone every one of them has to be on screen and big enough for a finger.
    const small = await ev(js`[${SEL.focusExplain}, ${SEL.focusHand}, ${SEL.focusLater}, ${SEL.focusShred}, ${SEL.focusTrust}, ${SEL.focusOption}].flatMap(sel => __t.all(sel, __t.one(${SEL.focusCard}))).map(n => ({ name: __t.label(n).slice(0, 24), box: __t.box(n) })).filter(x => x.box.height < 40 || x.box.width < 40 || x.box.right > innerWidth + 1 || x.box.left < -1)`)
    check(!small.length, `on a phone these controls of the card are off the screen or smaller than a finger (40px): ${small.map(x => `"${x.name}" ${x.box.width}x${x.box.height} at ${x.box.left},${x.box.top}`).join('; ')}`)
  }

  // What is about to be pressed stays where it is: the board's state changes all the time (other sessions
  // post), and the window must not move by itself when it does.
  const tileTop = () => ev(js`Math.round(__t.all(${SEL.focusOption}, __t.one(${SEL.focusCard})).at(-1).getBoundingClientRect().top)`)
  const restAt = await tileTop()
  await courier.tool('reply', { text: `Something else entirely (${stamp})` })
  await sleep(900)
  check(same(await tileTop(), restAt, 1) && (await front())?.id === talk.id, `a message from a session moved the window by itself: the answer in front went from y=${restAt} to y=${await tileTop()}`)

  // A note written on the card is kept as its draft. It answers nothing, sends nothing, and the card stays in front.
  const words = `only a remark ynlceubrxsh 123 ${stamp}`
  if (check(await beginNote(talk), 'there is nowhere to write on the card: neither a click on its title begins a note, nor does "Discuss" open a field')) {
    await type(words)
    if (!touch) {
      // Arrows in the note move the caret, not the walk.
      await key('ArrowLeft', 37); await key('ArrowRight', 39)
      check((await front()).id === talk.id, 'an arrow key pressed in a note turned the page')
    }
    check(cardOf(talk.id).status === 'open', 'letters typed into a note answered the question')
    await ev('document.activeElement?.blur?.()')
    await waitState('the note is kept on the board as the draft of its card', () => JSON.stringify(cardOf(talk.id).draft ?? '').includes(words), 5000).then(() => passed(), e => check(false, e.message))
    await sleep(500)
    await settle()
    check((await front())?.id === talk.id, `after a note the walk shows "${(await front())?.title}", the card should stay in front`)
    check(cardOf(talk.id).status === 'open' && !said(talk).length, 'a note answered the card or was sent to the session before any action')
    check(!(await ev(js`__t.inPile('later', ${talk.id}) || __t.inPile('asked', ${talk.id})`)), 'a note moved the card onto a pile; only Snooze, What?? and Revise may')
    await shot('walk-note')
  }

  // The arrows page, in both directions, and never answer; a finger pushes the column.
  const answered = () => state().cards.filter(c => c.status !== 'open').length
  const before = answered()
  if (!touch) {
    await key('ArrowRight', 39)
    await expect('the right arrow shows the next question', js`(s => s && s.id !== ${talk.id})(__t.focusState())`, 3000)
    await key('ArrowLeft', 37)
    await expect('the left arrow goes back to the question before', js`__t.focusState()?.id === ${talk.id}`, 3000)
    for (let i = 0; i < 5; i++) { await key('ArrowRight', 39); await sleep(200) }
    for (let i = 0; i < 5; i++) { await key('ArrowLeft', 37); await sleep(200) }
    await settle()
  } else {
    const tile = await ev(js`__t.box(__t.all(${SEL.focusOption}, __t.one(${SEL.focusCard})).at(-1))`)
    const from = { x: Math.round(tile.left + tile.width / 2), y: Math.round(tile.top + tile.height / 2) }
    await drag(line(from, { x: from.x, y: Math.max(40, from.y - 420) }), { pause: 24 })
    await sleep(700)
    await drag(line({ x: from.x, y: 300 }, { x: from.x, y: 720 }), { pause: 24 })
    await sleep(700)
    await settle()
  }
  check(answered() === before, `paging through the questions answered ${answered() - before} of them`)

  // An answer: the walk moves on at once, a strip says what was answered, and Back puts the card in front again.
  await part('an answer in the walk', async () => {
    need(await walkTo(take), `the walk never came to "${take.title}"`)
    if (touch) await press('the thumb up', js`__t.all(${SEL.focusOption}, __t.one(${SEL.focusCard})).at(-1)`)
    else await key('y', 89, { text: 'y' })
    await expect('after an answer the walk moves on at once', js`(s => s && s.id !== ${take.id})(__t.focusState())`, 1500)
    await waitState(`"${take.title}" is decided`, () => cardOf(take.id).status !== 'open')
    check(cardOf(take.id).choice === 'yes', `the answer in the walk chose "${cardOf(take.id).choice}", expected "yes"`)
    const note = await stripOf(take)
    if (check(note, 'in the walk nothing says what was answered, and nothing takes it back')) {
      check(/Yes$/.test(note.text) && note.back, `the strip in the walk reads "${note.all}", expected the answer "Yes" and "${TEXT.noteBack}"`)
      await shot('walk-answered')
      await press(`"${TEXT.noteBack}" in the walk`, js`__t.one(${SEL.noteBack}, __t.noteNode(true, ${take.title}))`)
      await waitState(`"${take.title}" is open again`, () => cardOf(take.id).status === 'open')
      check(cardOf(take.id).choice == null, 'the card taken back still carries its old answer')
      await expect('the card taken back is in front again in the walk', js`__t.focusState()?.id === ${take.id}`, 4000)
      await expect('the card taken back stands in the group of its sender again', js`!!__t.groups().find(g => !g.pile && g.ids.includes(${take.id}))`, 3000)
    }
  })

  // The note goes along with the answer: as its words, and as a picture of the card with the note on it.
  await part('the note with the answer', async () => {
    need(await walkTo(talk), `the walk never came back to "${talk.title}"`)
    if (touch) await press('the thumb up', js`__t.all(${SEL.focusOption}, __t.one(${SEL.focusCard})).at(-1)`)
    else await key('y', 89, { text: 'y' })
    await waitState(`"${talk.title}" is decided`, () => cardOf(talk.id).status !== 'open')
    check(cardOf(talk.id).note.includes(words), `the answer took "${cardOf(talk.id).note}" along as its note, expected what was written on the card`)
    check((cardOf(talk.id).note_attachments ?? []).length >= 1, 'the answer did not take a picture of the card with its note along')
  })

  // Snooze: a plain put-off. The card leaves, the walk moves on. (Keys: L or S.)
  await part('Snooze in the walk', async () => {
    need(await walkTo(off), `the walk never came to "${off.title}"`)
    if (touch) await press(`"${TEXT.later}" in the walk`, js`__t.one(${SEL.focusLater}, __t.one(${SEL.focusCard}))`)
    else await key('s', 83, { text: 's' })
    putOff.add(off.id)
    await expect(`after "${TEXT.later}" the walk moves on`, js`(s => s && s.id !== ${off.id})(__t.focusState())`, 3000)
    await expect(`"${TEXT.later}" lays the card on the "${TEXT.later}" pile`, js`__t.inPile('later', ${off.id})`, 3000)
    check(cardOf(off.id).status === 'open' && !said(off).length, `"${TEXT.later}" answered the card or wrote to the session`)
    const laterNote = await stripOf(off)
    check(saysLater(laterNote?.text) && laterNote.back, `after "${TEXT.later}" the strip reads "${laterNote?.all}", expected "${TEXT.movedLater}" and the way back`)
  })

  // What??: one tap asks the session to explain; the card leaves and returns when the session has replied. (Key: E.)
  await part('What?? in the walk', async () => {
    need(await walkTo(explain), `the walk never came to "${explain.title}"`)
    if (!ways.explain) return
    const asked = () => waitState('the session is asked to explain, tied to the card', () => said(explain).length > 0, 3000).then(() => true, () => false)
    if (!touch) {
      await key('e', 69, { text: 'e' })
      if (!check(await asked(), 'the key E does nothing in the walk: the session is not asked to explain (the button "What??" is tried next)')) await press('"What??" in the walk', js`__t.one(${SEL.focusExplain}, __t.one(${SEL.focusCard}))`)
    } else await press('"What??" in the walk', js`__t.one(${SEL.focusExplain}, __t.one(${SEL.focusCard}))`)
    if (check(await asked(), '"What??" does not reach the session')) {
      await expect('after "What??" the walk moves on', js`(s => s && s.id !== ${explain.id})(__t.focusState())`, 3000)
      await expect('"What??" lays the card on the pile of what waits for the agent', js`__t.inPile('asked', ${explain.id})`, 3000)
      check(cardOf(explain.id).status === 'open', '"What??" answered the card')
      const explainNote = await stripOf(explain)
      check(explainNote && !/undefined|null/.test(explainNote.all) && explainNote.back, `after "What??" the strip reads "${explainNote?.all ?? 'nothing'}", expected what happened and the way back`)
      await sleep(50)
      await courier.tool('reply', { text: `Explained: it is about the size (${stamp})`, card_id: explain.id })
      await expect('with the reply of the session the card returns to the questions of its sender', js`!__t.inPile('asked', ${explain.id}) && !!__t.groups().find(g => !g.pile && g.ids.includes(${explain.id}))`, 5000)
      if (check(await walkTo(explain), 'the card that returned is not part of the walk again')) {
        check(await ev(js`__t.text(${SEL.focusCard}).includes('Explained: it is about the size')`), 'the card that returned does not show what the session explained')
        await shot('walk-explained')
      }
    }
  })

  // Revise: what was written on the card goes to the session; the card leaves and returns with the reply. (Key: B.)
  await part('Revise in the walk', async () => {
    need(await walkTo(hand), `the walk never came to "${hand.title}"`)
    const wish = `please look at it again ${stamp}`
    if (check(await beginNote(hand, !touch), touch ? 'there is nowhere to write on the card' : 'the key A does not put the caret where one writes about the card in front')) {
      await type(wish)
      await ev('document.activeElement?.blur?.()')
      await sleep(500)
    }
    if (touch) await press(`"${TEXT.hand}" in the walk`, js`__t.one(${SEL.focusHand}, __t.one(${SEL.focusCard}))`)
    else await key('b', 66, { text: 'b' })
    await waitState('the words reach the session, tied to the card and marked as a hand-back', () => said(hand).some(m => m.text.includes(wish) && m.handback), 5000).then(() => passed(), e => check(false, `${touch ? `"${TEXT.hand}"` : 'the key B'}: ${e.message}`))
    await expect(`after "${TEXT.hand}" the walk moves on`, js`(s => s && s.id !== ${hand.id})(__t.focusState())`, 3000)
    await expect(`"${TEXT.hand}" lays the card on the pile of what waits for the agent`, js`__t.inPile('asked', ${hand.id})`, 3000)
    check(cardOf(hand.id).status === 'open' && cardOf(hand.id).with_agent, `"${TEXT.hand}" answered the card, or the board does not know that it is with the agent`)
    const handNote = await stripOf(hand)
    check(handNote && !/undefined|null/.test(handNote.all) && handNote.back, `after "${TEXT.hand}" the strip reads "${handNote?.all ?? 'nothing'}", expected what happened and the way back`)
    await shot('walk-revise')
    await sleep(50)
    await courier.tool('reply', { text: `Looked again (${stamp})`, card_id: hand.id })
    await expect('with the reply of the session the card returns', js`!__t.inPile('asked', ${hand.id}) && !!__t.groups().find(g => !g.pile && g.ids.includes(${hand.id}))`, 5000)
  })

  // Trust: the agent decides itself. Back takes it back. (Key: R.)
  await part('Trust in the walk', async () => {
    need(await walkTo(trusted), `the walk never came to "${trusted.title}"`)
    if (touch) await press('"Trust" in the walk', js`__t.one(${SEL.focusTrust}, __t.one(${SEL.focusCard}))`)
    else await key('r', 82, { text: 'r' })
    await waitState('the board notes that the decision is left to the agent', () => cardOf(trusted.id).trusted === true, 4000).then(() => passed(), e => check(false, `${touch ? '"Trust"' : 'the key R'}: ${e.message}`))
    await expect('after "Trust" the walk moves on', js`(s => s && s.id !== ${trusted.id})(__t.focusState())`, 3000)
    const trustNote = await stripOf(trusted)
    if (check(trustNote?.back && /Trust/.test(trustNote.text), `after "Trust" the strip reads "${trustNote?.all ?? 'nothing'}", expected "Trusted" and the way back`)) {
      await press('"Back" on the strip of the trusted card', js`__t.one(${SEL.noteBack}, __t.noteNode(true, ${trusted.title}))`)
      await waitState('Back takes the trust back: the card is open again', () => cardOf(trusted.id).status === 'open' && !cardOf(trusted.id).trusted, 4000).then(() => passed(), e => check(false, e.message))
    }
  })

  // Shred: thrown away unanswered. Back fetches it out again. (Key: X.)
  await part('Shred in the walk', async () => {
    need(await walkTo(shredded), `the walk never came to "${shredded.title}"`)
    if (touch) await press('"Shred" in the walk', js`__t.one(${SEL.focusShred}, __t.one(${SEL.focusCard}))`)
    else await key('x', 88, { text: 'x' })
    await waitState('the card is shredded', () => cardOf(shredded.id).status === 'shredded', 4000).then(() => passed(), async e => check(false, `${touch ? '"Shred"' : 'the key X'}: ${e.message} (in front: "${(await front())?.title}"; the keyboard is in ${await ev('__t.describe(document.activeElement)')}; shredded instead: ${state().cards.filter(c => c.status === 'shredded').map(c => c.title).join(', ') || 'nothing'})`))
    check(cardOf(shredded.id).choice == null, 'a shredded card carries an answer')
    const shredNote = await stripOf(shredded)
    if (check(shredNote?.back && /Shred/.test(shredNote.text), `after "Shred" the strip reads "${shredNote?.all ?? 'nothing'}", expected "Shredded" and the way back`)) {
      await press('"Back" on the strip of the shredded card', js`__t.one(${SEL.noteBack}, __t.noteNode(true, ${shredded.title}))`)
      await waitState('Back fetches the shredded card out again', () => cardOf(shredded.id).status === 'open', 4000).then(() => passed(), e => check(false, e.message))
    }
  })

  // Files without a field: dropped or pasted on the card they wait as chips; a scribble is drawn over the card
  // with the pen (key D). The next action takes all of it to the session.
  await part('files and a scribble on the card', async () => {
    need(await walkTo(files), `the walk never came to "${files.title}"`)
    if (!touch) {
      // H reads the question aloud where the board can speak; it never answers, and breaks nothing where it cannot.
      await key('h', 72, { text: 'h' })
      await sleep(300)
      check((await front())?.id === files.id && cardOf(files.id).status === 'open', 'the key H answered or left the card')
    }
    await ev(`(node => { const dt = new DataTransfer(); dt.items.add(new File(['dropped on the card'], 'dropped.txt', { type: 'text/plain' })); for (const type of ['dragenter', 'dragover', 'drop']) node.querySelector(${JSON.stringify(SEL.focusTitle)}).dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt })) })(${walkCard(files)})`)
    await expect('a file dropped on the card waits as a chip', `__t.all(${JSON.stringify(SEL.focusChip)}, ${walkCard(files)}).some(n => __t.text(n).includes('dropped.txt'))`, 3000)
    await ev(`(node => { const dt = new DataTransfer(); dt.items.add(new File([Uint8Array.from(atob(${JSON.stringify(PIXEL)}), c => c.charCodeAt(0))], 'pasted.png', { type: 'image/png' })); node.focus(); node.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: dt })) })(${walkCard(files)})`)
    await expect('a picture pasted on the card waits as a second chip', `__t.all(${JSON.stringify(SEL.focusChip)}, ${walkCard(files)}).length === 2`, 3000)
    if (!(await ev(`!!${walkCard(files)}.querySelector(${JSON.stringify(SEL.focusPen)})`))) {
      note('the card has no pen to scribble with; the scribble is not checked')
      await press(`"${TEXT.hand}" on the card with files`, `__t.one(${JSON.stringify(SEL.focusHand)}, ${walkCard(files)})`)
      await waitState('the session gets the dropped file and the pasted picture', () => said(files).some(m => { const names = (m.attachments ?? []).map(a => a.name); return names.includes('dropped.txt') && names.includes('pasted.png') }), 6000).then(() => passed(), e => check(false, `${e.message}; it got: ${said(files).flatMap(m => (m.attachments ?? []).map(a => a.name)).join(', ') || 'nothing'}`))
      return
    }
    if (touch) await press('the pen of the card', `__t.one(${JSON.stringify(SEL.focusPen)}, ${walkCard(files)})`)
    else await key('d', 68, { text: 'd' })
    await expect('the pen is in the hand', `__t.one(${JSON.stringify(SEL.focusPen)}, ${walkCard(files)})?.getAttribute('aria-pressed') === 'true'`, 2000)
    const paper = await ev(`__t.box(${walkCard(files)}.querySelector(${JSON.stringify(SEL.focusScroll)}))`)
    await drag(Array.from({ length: 10 }, (_, i) => ({ x: Math.round(paper.left + 40 + i * 14), y: Math.round(paper.top + 70 + (i % 2) * 18) })))
    await expect('a stroke of the pen stays on the card', `${walkCard(files)}.querySelectorAll(${JSON.stringify(SEL.focusInk)}).length >= 1`, 3000)
    await waitState('the scribble is kept in the draft of the card', () => JSON.stringify(cardOf(files.id).draft ?? '').includes('strokes'), 4000).then(() => passed(), e => check(false, e.message))
    await shot('walk-scribble')
    await press('the pen, to put it down', `__t.one(${JSON.stringify(SEL.focusPen)}, ${walkCard(files)})`)
    await press(`"${TEXT.hand}" on the card with files`, `__t.one(${JSON.stringify(SEL.focusHand)}, ${walkCard(files)})`)
    await waitState('the session gets the dropped file, the pasted picture and a picture of the scribbled card', () => said(files).some(m => { const names = (m.attachments ?? []).map(a => a.name); return names.includes('dropped.txt') && names.includes('pasted.png') && (m.attachments ?? []).filter(a => a.kind === 'image').length >= 2 }), 6000).then(() => passed(), e => check(false, `${e.message}; it got: ${said(files).flatMap(m => (m.attachments ?? []).map(a => a.name)).join(', ') || 'nothing'}`))
  })

  await ev('document.activeElement?.blur?.()')
  await escape()
  await expect('Escape closes the walk', '!__t.focusOpen()', 3000)
  await closeWindows()
  check((await place()).path === '/' && !(await ev('location.search')), `after the walk the address is ${await ev('location.pathname + location.search')}`)
  // (A draft is saved a moment after the last key; let it go out before the cards are withdrawn.)
  await sleep(700)
  for (const card of all) await courier.tool('withdraw_card', { card_id: card.id, reason: 'the test is done with it' }).catch(() => {})
  putOff.delete(off.id)
}

/** A question is named by its number: on its row, and in the address. */
async function groupNumber() {
  const stamp = tag()
  const heavy = await fixture.heavy(`By number (${stamp})`)
  const many = await courier.ask({ title: `Many short options (${stamp})`, body: 'Which weekday?', recommended: 'wed', options: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun', 'Never'].map(d => ({ key: d.toLowerCase(), label: d, detail: `on ${d}` })) })
  need(Number.isInteger(heavy.number), 'the server gives a card no number')
  await open('/')
  await goInbox()
  await waitFor('the new question is listed', js`!!__t.row(${many.id})`)
  const shownNr = await ev(js`__t.text(__t.one(${SEL.rowNr}, __t.row(${heavy.id})))`)
  check(shownNr.includes(String(heavy.number)), `the row does not show the number ${heavy.number} of its card: "${shownNr}"`)
  // Opened from the list, the address names the number.
  await ev(js`__t.row(${heavy.id}).scrollIntoView({ block: 'center', behavior: 'instant' })`)
  await press(`"${TEXT.choose}" on "${heavy.title}"`, js`__t.tile(${heavy.id}, 'right')`)
  await waitFor('the window opens', js`__t.focusState()?.id === ${heavy.id}`)
  check(await ev('location.pathname + location.search') === `/q/${heavy.number}`, `the address of the window is ${await ev('location.pathname + location.search')}, expected /q/${heavy.number}`)
  // The pictures large: the options stay beside them, so the answer needs no way back.
  await settle()
  await press('the picture of the card', js`__t.one(${SEL.focusFigure}, __t.one(${SEL.focusCard}))`)
  if (await expect('the picture opens large', js`!!__t.one(${SEL.focusZoom})`, 3000)) {
    await settle()
    const kept = await ev(js`__t.all(${SEL.focusZoomOption}).map(__t.label)`)
    check(kept.length === heavy.options.length, `beside the large picture stand ${kept.length} options (${kept.join(', ')}), the card has ${heavy.options.length}`)
    await shot('zoom-options')
    await escape()
    await expect('Escape closes the large picture, not the window', js`!__t.one(${SEL.focusZoom}) && __t.focusOpen()`, 3000)
  }
  await closeWindows()
  // The address alone opens the card: by number, and by the id that older links carry.
  for (const [what, link] of [['its number', `/q/${heavy.number}`], ['an old link with its number', `/?q=${heavy.number}`], ['an old link with its id', `/?q=${heavy.id}`]]) {
    check(await open(link) === 200, `${link} is not served`)
    await expect(`the address with ${what} opens that question`, js`__t.focusState()?.id === ${heavy.id}`, 5000)
    check((await front())?.single, `the address with ${what} opened the walk instead of the one question`)
    await closeWindows()
  }
  await open(`/s/${agentNamed(COURIER).id}/q/${heavy.number}`)
  await expect('the number opens its question over a session too', js`__t.focusState()?.id === ${heavy.id}`, 5000)
  check((await place()).path === `/s/${agentNamed(COURIER).id}/q/${heavy.number}`, `the address is ${(await place()).path}`)
  await closeWindows()
  await expect('closed, the address is the session again', js`location.pathname === ${`/s/${agentNamed(COURIER).id}`}`, 3000)
  await closeWindows()
  check(await open('/q/999999') === 200, 'the address of an unknown number is not served')
  await sleep(400)
  check(!(await ev('__t.focusOpen()')) || !!(await front())?.id, 'an unknown number opens an empty window')
  await closeWindows()

  // Many short options are tags: all of them on screen at once.
  await open(`/q/${many.number}`)
  await waitFor('the question with many options opens', js`__t.focusState()?.id === ${many.id}`, 5000)
  await settle()
  const tags = await front()
  check(/^tags/.test(tags.layout), `eight short options are laid out as "${tags.layout}", expected tags`)
  check(tags.options.length === many.options.length, `the window offers ${tags.options.length} of ${many.options.length} options`)
  const hidden = tags.options.filter(o => o.box.bottom > screen().height + 1 || o.box.right > screen().width + 1 || o.box.top < 0)
  check(!hidden.length, `of the many options these are not on screen without scrolling: ${hidden.map(o => o.name).join(', ')}`)
  check(tags.options.filter(o => o.advised).length === 1 && /^Wed/.test(tags.options.find(o => o.advised)?.name ?? ''), 'the recommended tag is not marked')
  await shot('tags')
  await press('the tag "Thu"', js`__t.all(${SEL.focusOption}, __t.one(${SEL.focusCard})).find(n => /^Thu/.test(__t.label(n)))`)
  await waitState('one tap on a tag answers', () => cardOf(many.id).choice === 'thu', 4000).then(() => passed(), async () => check(false, `a ${touch ? 'tap' : 'click'} on the middle of the tag "Thu" did not answer${await ev(js`!!__t.one(${SEL.focusOptionNote})`) ? ': the small pencil beside the word took it and opened the line for a note' : ''}`))
  await closeWindows()
  await courier.tool('withdraw_card', { card_id: heavy.id, reason: 'the test is done with it' }).catch(() => {})
  await open('/')
}

/** The pad opens from the bar and under /pad, and closes back to where one was. */
async function groupPad() {
  const agent = scripted()[0]
  const home = `/s/${agent.id}`
  await open(home)
  const padUp = `document.body.hasAttribute('data-pad')`
  const closed = async how => {
    await expect(`${how} closes the pad`, `!${padUp}`, 3000)
    await settle()
    const now = await place()
    check(now.path === home, `after ${how} the address is ${now.path}, expected ${home} (where the pad was opened)`)
    check(await ev(js`!!__t.pane(${agent.id}) && __t.all(${SEL.message}).length > 0 && !document.querySelector(${SEL.session}).inert`), `after ${how} the conversation is not back, or cannot be reached`)
  }
  need(await ev(js`!!__t.one(${SEL.padOpen})`), 'the bar has no control for the pad')
  await press('the pad in the bar', js`__t.one(${SEL.padOpen})`)
  await waitFor('the pad opens', padUp, 4000)
  const frame = js`document.querySelector(${`${SEL.pad} iframe`})`
  await expect('the pad shows its own page', `(f => !!f && f.contentDocument?.readyState === 'complete' && f.contentDocument.body.children.length > 0)(${frame})`, 8000)
  check((await place()).path === '/pad', `the address of the pad is ${(await place()).path}`)
  check(await ev(js`document.querySelector(${SEL.padOpen}).getAttribute('aria-pressed')`) === 'true', 'the control does not say that the pad is open')
  await sleep(600)
  await shot('pad')
  const words = await ev(`(d => { const re = ${GERMAN}; const out = []; const w = d.createTreeWalker(d.body, NodeFilter.SHOW_TEXT); for (let n = w.nextNode(); n; n = w.nextNode()) if (re.test(n.nodeValue) && n.parentElement.getClientRects().length) out.push(n.nodeValue.trim().slice(0, 40)); for (const n of d.querySelectorAll('[aria-label], [title], [placeholder]')) for (const a of ['aria-label', 'title', 'placeholder']) { const v = n.getAttribute(a); if (v && re.test(v)) out.push(a + '="' + v.slice(0, 40) + '"') } return out.slice(0, 8) })(${frame}.contentDocument)`)
  check(!words.length, `the pad: the interface is not English here: ${words.join(' | ')}`)
  await escape()
  await closed('Escape')
  await press('the pad in the bar', js`__t.one(${SEL.padOpen})`)
  await waitFor('the pad opens again', padUp, 4000)
  await ev('history.back()')
  await closed('the Back of the browser')
  if (!touch) {
    await ev('document.activeElement?.blur?.()')
    await key('p', 80, { text: 'p' })
    if (await expect('the key P opens the pad', padUp, 3000)) {
      await sleep(300)
      await escape()
      await closed('Escape after P')
    }
  }
  // Its own address: a reload stays on the pad; closed, with nothing behind it, it becomes the inbox.
  check(await open('/pad') === 200, '/pad is not served')
  await expect('/pad opens the board with the pad up', padUp, 5000)
  await reload()
  await expect('a reload of /pad stays on the pad', padUp, 5000)
  await sleep(400)
  await escape()
  await expect('Escape closes the pad that was opened by its address', `!${padUp}`, 3000)
  check((await place()).path === '/', `closed with nothing behind it, the pad leaves the address ${(await place()).path}, expected /`)
  await open('/')
}

/** A link to something a session published opens where a browser may decrypt it. */
async function groupLinks() {
  const stamp = tag()
  const out = await courier.tool('publish_asset', { content: `<!doctype html><title>t</title><p>Report ${stamp}</p>`, type: 'html', title: `Report ${stamp}` })
  const link = /https:\/\/\S+\/a\/\S+/.exec(out)?.[0]
  need(link, `publish_asset returned no https link although the board has a public address: ${out.slice(0, 200)}`)
  await courier.tool('reply', { text: `The same report as a link in a sentence (${stamp}): ${link}` })
  const courierAgent = agentNamed(COURIER)
  const hrefs = root => ev(js`__t.all(${SEL.assetLink}, ${root}).map(a => ({ href: a.getAttribute('href'), abs: a.href, in: __t.describe(a) }))`)
  // On the machine itself (localhost counts as secure) the link stays on this address.
  await open(`/s/${courierAgent.id}`)
  await waitFor('the published report shows in the conversation', js`__t.all(${SEL.assetLink}, ${SEL.session}).length >= 2`, 5000)
  const local = await hrefs(SEL.session)
  check(local.every(a => a.abs.startsWith(`${base}/a/`)), `on localhost a link to an asset leaves the board: ${local.map(a => a.href.replace(/#.*/, '#…')).join(', ')}`)
  await shot('asset')
  // On a plain http address (the board over the LAN) a browser cannot decrypt: every link has to go to the https address.
  const { identifier } = await page.send('Page.addScriptToEvaluateOnNewDocument', { source: `Object.defineProperty(window, 'isSecureContext', { get: () => false, configurable: true })` })
  try {
    await open(`/s/${courierAgent.id}`)
    await waitFor('the published report shows in the conversation', js`__t.all(${SEL.assetLink}, ${SEL.session}).length >= 2`, 5000)
    need(await ev('window.isSecureContext') === false, 'the test could not make the page a plain http one')
    const plain = await hrefs(SEL.session)
    const bad = plain.filter(a => !a.abs.startsWith(`${PUBLIC}/a/`))
    check(!bad.length, `on a plain http page ${bad.length} of ${plain.length} links to an asset do not go to the https address, so a browser cannot open them: ${bad.map(a => `${a.href.replace(/#.*/, '#…')} in ${a.in}`).join('; ')}`)
    await press('"Files"', js`__t.one(${SEL.filterFiles})`)
    await waitFor('the filter shows the files', js`!!__t.one(${SEL.filesPane})`)
    await settle()
    const files = (await hrefs(SEL.filesPane)).filter(a => !a.abs.startsWith(`${PUBLIC}/a/`))
    check(!files.length, `on a plain http page "Files" links an asset over http: ${files.map(a => a.href.replace(/#.*/, '#…')).join(', ')}`)
  } finally {
    await page.send('Page.removeScriptToEvaluateOnNewDocument', { identifier })
  }
  await open('/')
}

/** Every script of the page parses and loads: a file saved half-way by someone shows here first. */
async function groupModules() {
  const dir = path.join(ROOT, 'client', 'web', 'js')
  // (The worklet runs in an audio thread; admin.js, help.js and asset.js are the scripts of their own pages.)
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.js') && !['pcm-worklet.js', 'admin.js', 'help.js', 'asset.js'].includes(f))
  await open('/')
  for (const file of files) {
    const out = await ev(js`import(${`/js/${file}`}).then(() => 'ok', e => String(e?.message ?? e))`)
    check(out === 'ok', `/js/${file} does not load: ${out}`)
  }
  // Importing is not all: the Focus window is built when it is first opened, and a name that is missing then
  // (a constant renamed half-way) leaves "Go through them" and every "Choose" on a heavy card dead.
  await ev(js`(document.querySelector(${SEL.goThrough}) ?? document.querySelector(${SEL.walk}))?.click()`)
  const up = await waitFor('the window opens', '__t.focusOpen()', 4000).catch(() => false)
  check(up, `the Focus window does not open: ${[...new Set(problems)].join(' | ').slice(0, 300) || 'nothing happens, and no error is logged'}`)
  await closeWindows()
  // German in the sources: a string that only shows in a state the test never reaches (no microphone, a refusal).
  // Allowed: what is read aloud from a German card, a character class, the words by which an agent's "no" is known.
  const allowed = /^\s*(\/\/|\*|\/\*)|^\s*de: \{|äöüÄÖÜß\]|const (NEGATIVE|BARE) = /
  const web = path.join(ROOT, 'client', 'web')
  const sources = [...files.map(f => path.join('js', f)), 'js/admin.js', 'js/help.js', 'js/asset.js', 'index.html', 'admin.html', 'help.html',
    ...fs.readdirSync(path.join(web, 'pad')).filter(f => /\.(js|html)$/.test(f)).map(f => path.join('pad', f))]
  const german = []
  for (const file of sources) {
    fs.readFileSync(path.join(web, file), 'utf8').split('\n').forEach((line, i) => {
      if (allowed.test(line)) return
      for (const [, , text] of line.matchAll(/(['"`>])([^'"`<>]{3,})(?=['"`<])/g)) if (/[äöüÄÖÜß]/.test(text) || GERMAN.test(text)) german.push(`${file}:${i + 1} "${text.trim().slice(0, 50)}"`)
    })
  }
  check(!german.length, `German strings in the sources of the interface: ${german.slice(0, 8).join(' | ')}${german.length > 8 ? ` (and ${german.length - 8} more)` : ''}`)
  const sheets = await ev(`[...document.querySelectorAll('link[rel="stylesheet"][href^="/"]')].map(l => ({ href: l.getAttribute('href'), rules: (() => { try { return l.sheet?.cssRules.length ?? 0 } catch { return -1 } })() }))`)
  for (const sheet of sheets) check(sheet.rules > 0, `the stylesheet ${sheet.href} is empty or did not load`)
}

/** From wherever one is: quick send to the crowned session, the jump field, and moving the session one is in. */
async function groupQuick() {
  const stamp = tag()
  const target = agentNamed(COURIER), other = scripted()[1]
  const card = await fixture.quick(`Jump to me (${stamp})?`)
  await open('/')
  await post('/star', { agent: target.id, starred: true })
  await waitState('the session wears the crown', s => s.agents.find(a => a.id === target.id).starred)
  await settle()
  const arrived = text => waitState(`"${text}" reaches the crowned session`, () => state().messages.some(m => m.agent === target.id && m.from === 'user' && m.text === text && !m.card_id), 5000).then(() => passed(), e => check(false, e.message))

  // The speech bubble with the crown: a small sheet to write in; Enter (or its button) sends to the crowned session.
  need(await ev(js`!!__t.one(${SEL.quickOpen})`), 'there is no quick-send bubble on the page')
  await press('the quick-send bubble', js`__t.one(${SEL.quickOpen})`)
  await waitFor('the bubble opens a field to write in', js`document.activeElement === document.querySelector(${SEL.quickField})`, 3000)
  const first = `quick hello ${stamp}`
  await type(first)
  await shot('quick-send')
  if (touch) await press('send', js`__t.one(${SEL.quickSend})`)
  else await key('Enter', 13, { text: '\r' })
  await arrived(first)
  await expect('a line says that it went, and to whom', js`__t.text(document.querySelector(${SEL.quickNote})).includes(${`Sent to ${nameOf(target)}`})`, 3000)
  check(await ev(js`document.querySelector(${SEL.quickField}).value`) === '', 'the quick-send field was not emptied after sending')
  check((await place()).path === '/', `quick send left the page: ${(await place()).path}`)
  await checkEnglish('quick send')
  await escape()
  await ev('document.activeElement?.blur?.()')
  await pressAt(touch ? 200 : 700, 400)   // beside it: the sheet closes
  await settle()
  if (!touch) {
    // "/" from anywhere puts the caret into it.
    await goSession(other)
    await ev('document.activeElement?.blur?.()')
    await key('/', 191, { text: '/' })
    if (await expect('the key "/" opens quick send from a session', js`document.activeElement === document.querySelector(${SEL.quickField})`, 2000)) {
      const second = `from another place ${stamp}`
      await type(second)
      await key('Enter', 13, { text: '\r' })
      await arrived(second)
      check(!state().messages.some(m => m.agent === other.id && m.text === second), 'quick send wrote to the session that is open, not to the crowned one')
    }
    await escape()
    await ev('document.activeElement?.blur?.()')
    // Alt and an arrow move the session one is in up or down the sidebar.
    const order = () => state().agents.map(a => a.id).join()
    const was = order()
    await key('ArrowUp', 38, { modifiers: 1 })
    await waitState('Alt and the arrow up move the session up', () => order() !== was, 3000).then(() => passed(), e => check(false, e.message))
    await expect('the sidebar shows the new order', js`(names => names.indexOf(${nameOf(other)}) < names.indexOf(${nameOf(scripted().find(a => a.id !== other.id))}))(__t.sidebar().filter(r => r.name).map(r => r.name))`, 3000)
    await key('ArrowDown', 40, { modifiers: 1 })
    await waitState('Alt and the arrow down move it back', () => order() === was, 3000).then(() => passed(), e => check(false, e.message))
  }
  await post('/star', { agent: target.id, starred: false })

  // The jump field in the menu at the logo: a session by its name, a question by its number.
  await open('/')
  const jumpTo = async (words, how) => {
    if (how === 'menu') {
      await press('the logo', js`__t.one(${SEL.brandMenu})`)
      await waitFor('the menu shows the jump field', js`!!__t.one(${SEL.jumpField})`, 3000)
      await press('the jump field', js`__t.one(${SEL.jumpField})`)
    }
    await type(words)
    await sleep(250)
    await key('Enter', 13, { text: '\r' })
  }
  await jumpTo(nameOf(target).slice(0, 4).toLowerCase(), 'menu')
  await expect('the jump field goes to a session by the start of its name', js`location.pathname === ${`/s/${target.id}`} && !!__t.pane(${target.id})`, 3000)
  check(!(await ev(js`!!__t.one(${SEL.brandDoors})`)), 'after the jump the menu stays open')
  await jumpTo(String(card.number), 'menu')
  await expect('the jump field opens a question by its number', js`__t.focusState()?.id === ${card.id}`, 3000)
  await closeWindows()
  if (!touch) {
    // The keys for it: Ctrl+K (Cmd+K), or G then J.
    await open('/')
    for (const [what, send] of [['Ctrl+K', () => key('k', 75, { modifiers: 2 })], ['G then J', async () => { await key('g', 71, { text: 'g' }); await key('j', 74, { text: 'j' }) }]]) {
      await ev('document.activeElement?.blur?.()')
      await send()
      const there = await waitFor('the caret is in the jump field', js`document.activeElement === document.querySelector(${SEL.jumpField})`, 1500).catch(() => false)
      check(there, `${what} does not open the jump field (the table of keys lists it as "jump: type where to go")`)
      await escape()
      await settle()
    }
  }
  await courier.tool('withdraw_card', { card_id: card.id, reason: 'the test is done with it' }).catch(() => {})
  await open('/')
}

// name, what it covers, sizes it runs at
const GROUPS = [
  ['login', 'the link sets the cookie, without it nothing is served', groupLogin, ['desktop']],
  ['inbox', 'groups by sender, equal rows, thumbs, one click answers, the next tile under the pointer, undo, the circled advice', groupInbox],
  ['later', 'put off onto ONE pile at the foot, beside "Answered", and back; survives a reload; an answer taken back from the pile', groupLater],
  ['choose', 'a light question unfolds in its row, a heavy one opens the window; the walk through all', groupChoose],
  ['modules', 'every script and stylesheet of the page loads', groupModules],
  ['walk', 'the big window: one composer, Send keeps the card, Explain / Back to agent / Later make it leave, arrows only page, Back takes an answer back', groupWalk],
  ['number', 'a question is named by its number (?q=102, old id links too); pictures large keep the options; many short options are tags', groupNumber],
  ['keys', 'the list worked down with the keyboard: go through them, Y, N, L, C, digits, U', groupKeys, ['desktop']],
  ['session', 'one conversation, message and reply, questions inline, "Questions only", "Files"', groupSession],
  ['scribble', 'draw, send, back in the conversation with a picture that loads', groupScribble],
  ['sidebar', 'marks, hand and ring, disconnected sessions at the bottom, archive and back', groupSidebar],
  ['pair', 'two sessions dropped on each other show as one, and split again', groupPair],
  ['urls', 'every view has an address; reload, back and forward keep it', groupUrls],
  ['agents', 'model and machine, rename and mark persist, VIP leads the inbox', groupAgents],
  ['theme', 'the toggle switches and persists', groupTheme],
  ['help', 'the menu at the logo (Help, Admin, Keys) and the help page', groupHelp],
  ['quick', 'quick send to the crowned session (bubble, "/"), the jump field (menu, Ctrl+K, G J), Alt+arrows move the session', groupQuick],
  ['pad', 'the pad opens from the bar, with P and under /pad, and closes back to where one was', groupPad],
  ['links', 'links to published assets go to https from a plain http page', groupLinks],
  ['admin', 'the admin page behind its own key', groupAdmin],
  ['images', 'pictures load in rows, large, and in the conversation', groupImages],
  ['gallery', 'a screenshot of every view in light and dark', groupGallery],
]

// ---- main ------------------------------------------------------------------------

const pendingFor = (name, message) => PENDING.find(p => p.match.test(`${name}: ${message}`))

async function group(name, fn) {
  current = { name, size, passed: 0, failures: [], pending: [], notes: [], ms: 0 }
  problems = []
  const began = Date.now()
  try {
    await fn()
  } catch (err) {
    current.failures.push(err instanceof Failed ? err.message : `the test itself broke: ${err.stack ?? err}`)
  }
  tolerate = null
  // What the browser complained about while the group ran belongs to the group.
  await sleep(100)
  const complaints = [...new Set(problems)]
  if (complaints.length) for (const p of complaints.slice(0, 6)) current.failures.push(p)
  else current.passed++
  const failures = []
  for (const f of current.failures) {
    const known = pendingFor(name, f)
    if (known) current.pending.push({ message: f, reason: known.reason })
    else failures.push(f)
  }
  current.failures = failures
  if (page && (failures.length || current.pending.length)) await shot(failures.length ? 'FAILED' : 'PENDING', { overflow: false })
  current.ms = Date.now() - began
  results.push(current)
  const word = failures.length ? 'FAIL   ' : current.pending.length ? 'pending' : 'ok     '
  console.log(`${word} ${size.padEnd(7)} ${name.padEnd(9)} ${String(current.passed).padStart(3)} passing${failures.length ? `, ${failures.length} failing` : ''}${current.pending.length ? `, ${current.pending.length} pending` : ''}  (${(current.ms / 1000).toFixed(1)} s)`)
  for (const f of failures) console.log(`          - ${f}`)
  for (const p of current.pending) console.log(`          ~ pending (${p.reason}): ${p.message}`)
  for (const n of current.notes) console.log(`          · note: ${n}`)
  current = null
}

/** What a --script file gets: everything needed to click around and look. */
const toolkit = () => ({
  SEL, TEXT, base, token, adminKey, page, ev, js, press, pressAt, drag, line, key, escape, type, retype, settle, sleep, waitFor, waitState, load, open, reload, setSize, place,
  goInbox, goSession, goRoster, mode, state, cardOf, openCards, agentNamed, scripted, courier, fixture, nameOf,
  problems: () => problems,
  shot: async name => { const file = path.join(shotDir, `${name}.png`); const out = await page.send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(file, Buffer.from(out.data, 'base64')); return file },
})

async function main() {
  shotDir = path.resolve(option('shots') || process.env.UI_TEST_SHOTS || path.join(os.tmpdir(), 'trommi-ui-test'))
  fs.rmSync(shotDir, { recursive: true, force: true })
  fs.mkdirSync(shotDir, { recursive: true })
  const unknown = only.filter(word => !GROUPS.some(([name]) => name === word))
  if (unknown.length) { console.error(`no such group: ${unknown.join(', ')}. Groups: ${GROUPS.map(g => g[0]).join(', ')}`); process.exit(2) }
  const began = Date.now()
  let broke = false
  try {
    await startBoard()
    await openBrowser()
    console.log(`board on ${base} with ${state().agents.length} sessions and ${openCards().length} open questions, up after ${((Date.now() - began) / 1000).toFixed(1)} s\n`)
    if (scriptFile) {
      await login()
      current = { name: 'script', size, passed: 0, failures: [], pending: [], notes: [] }
      const out = await (await import(pathToFileURL(path.resolve(scriptFile)).href)).default(toolkit())
      if (out !== undefined) console.log(typeof out === 'string' ? out : JSON.stringify(out, null, 2))
      if (problems.length) console.log(`\nthe browser complained:\n  ${[...new Set(problems)].join('\n  ')}`)
      current = null
    } else {
      for (const which of sizes) {
        await setSize(which)
        if ((await page.send('Network.getCookies', { urls: [base] })).cookies.length) await open('/')
        for (const [name, , fn, at = ['desktop', 'phone']] of GROUPS) {
          if (only.length ? !only.includes(name) : !at.includes(which)) continue
          if (name !== 'login' && !(await page.send('Network.getCookies', { urls: [base] })).cookies.length) await login()
          await group(name, fn)
        }
      }
    }
  } catch (err) {
    broke = true
    console.log(`\nthe suite could not run: ${err.stack ?? err}`)
  }
  const sum = key => results.reduce((n, r) => n + (typeof r[key] === 'number' ? r[key] : r[key].length), 0)
  const failing = sum('failures'), pending = sum('pending')
  if (!scriptFile) console.log(`\n${sum('passed')} checks passing, ${failing} failing, ${pending} pending in ${((Date.now() - began) / 1000).toFixed(0)} s`)
  console.log(`screenshots: ${shotDir}`)
  if (keep && !broke) {
    console.log(`\nthe board stays up: ${base}/?t=${token}\nadmin key: ${adminKey}\nCtrl-C stops it and removes its data.`)
    await new Promise(resolve => { interrupted = resolve })
  }
  await cleanup()
  process.exit(broke ? 2 : failing ? 1 : 0)
}

await main()
