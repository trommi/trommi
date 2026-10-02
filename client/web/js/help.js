// The help page: a short guide to the app (its words come from ui.js and its key list from keys.js,
// so neither can drift from the app), then the picture of the channel and the reference of tools and
// events from /api/tools, the same tables the agent is given.

const $ = id => document.getElementById(id)
const el = (tag, cls, text) => {
  const node = document.createElement(tag)
  if (cls) node.className = cls
  if (text != null) node.textContent = text
  return node
}
const svg = (tag, attrs = {}, text) => {
  const node = document.createElementNS('http://www.w3.org/2000/svg', tag)
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value)
  if (text != null) node.textContent = text
  return node
}

// ---- the picture ---------------------------------------------------------------

const LANES = [
  { name: 'Claude Code', sub: 'the session: model and terminal' },
  { name: 'Channel', sub: 'server.mjs, MCP over stdio' },
  { name: 'Hub', sub: 'HTTP, SSE, state in data/pad.db' },
  { name: 'Browser, apps', short: 'Browser', sub: 'you', human: true },
]
// A hop goes from one lane to another. Lines are names on the wire; a line that starts with ~ is an explanation.
const hop = (from, to, ...lines) => ({ from, to, lines })
const BANDS = [
  { title: 'You → agent', rows: [
    [hop(3, 2, 'POST /message  /decide', 'POST /reopen  /shred  /close …'), hop(2, 1, 'SSE /agent/link'),
      hop(1, 0, 'notifications/claude/channel', 'content, meta.kind = chat | decision', '| decision_reopened | shredded | …', '~all kinds: see Events below')],
    [hop(3, 2, 'POST /decide', '~on an approval card'), hop(2, 1, 'SSE /agent/link'),
      hop(1, 0, 'notifications/claude/channel/', 'permission', 'request_id, behavior')],
  ] },
  { title: 'Claude Code → channel', rows: [
    [hop(0, 1, 'initialize', 'clientInfo.name'), hop(1, 2, 'POST /agent/profile'), hop(2, 3, 'SSE /events', '~shown as “Program”')],
    [hop(0, 1, 'notifications/claude/channel/', 'permission_request', 'request_id, tool_name,', 'description, input_preview'), hop(1, 2, 'POST /agent/permission'),
      hop(2, 3, 'SSE /events', '~a card: Allow or Deny')],
  ] },
  { title: 'Agent → you', rows: [
    [hop(0, 1, 'tools/call', '~every tool: reply, create_decision,', '~set_status, list_cards …'), hop(1, 2, 'POST /agent/tool'),
      hop(2, 3, 'SSE /events', '~the whole state, on every change')],
    [hop(0, 1, 'tools/call publish_asset', '~encrypted here, in the channel'), hop(1, 2, 'POST /agent/asset', '~ciphertext only'),
      hop(2, 3, 'GET /a/<id>#<key>', '~no login; the key stays in the browser')],
  ] },
]
const NEVER = ['the model’s thinking', 'its tool calls', 'the terminal’s output', 'text while it streams']
const INSTEAD = ['Instead, the agent says it:', 'what you should know goes in reply,', 'the reasoning in its details field,', 'shown collapsed under the message.']

const LINE = 15

// One layout for a desk and one for a phone, from the same rows: on a phone
// every hop gets a row of its own, so the labels keep their size. Both are in
// the page and the stylesheet shows one, so the picture needs no script once drawn.
function drawDiagram(narrow) {
  const width = narrow ? 380 : 1180
  const xs = narrow ? [46, 142, 238, 334] : [130, 437, 743, 1050]
  const box = narrow ? { w: 88, h: 30 } : { w: 236, h: 54 }
  const root = svg('svg', { class: `dg ${narrow ? 'is-narrow' : 'is-wide'}`, role: 'img', 'aria-label': 'What travels between Claude Code, the channel, the hub and the browser, in both directions' })
  const defs = root.appendChild(svg('defs'))
  for (const way of ['to-agent', 'to-human']) {
    const marker = defs.appendChild(svg('marker', { id: `dg-${way}-${width}`, viewBox: '0 0 10 10', refX: 9, refY: 5, markerWidth: 6.5, markerHeight: 6.5, orient: 'auto' }))
    marker.append(svg('path', { d: 'M0 1 L10 5 L0 9 z', class: `is-${way}`, stroke: 'none' }))
  }
  const lives = root.appendChild(svg('g'))
  LANES.forEach((lane, i) => {
    const g = root.appendChild(svg('g', { class: `dg-lane${lane.human ? ' is-human' : ''}` }))
    g.append(svg('rect', { x: xs[i] - box.w / 2, y: 0.5, width: box.w, height: box.h, rx: 6 }))
    g.append(svg('text', { x: xs[i], y: narrow ? 19 : 24, 'text-anchor': 'middle', class: 'dg-name' }, narrow ? lane.short ?? lane.name : lane.name))
    if (!narrow) g.append(svg('text', { x: xs[i], y: 42, 'text-anchor': 'middle', class: 'dg-sub' }, lane.sub))
  })
  let y = box.h + 8

  // The words above an arrow, then the arrow. Returns the y below it.
  const drawHop = (h, top, lines) => {
    const way = h.to < h.from ? 'to-agent' : 'to-human'
    const mid = (xs[h.from] + xs[h.to]) / 2
    const g = root.appendChild(svg('g', { class: 'dg-hop' }))
    // On a phone a label may be wider than the gap it belongs to; it stays inside the picture.
    const wide = Math.max(...h.lines.map(l => l.length)) * 6.9
    const x = narrow ? Math.min(Math.max(mid, wide / 2 + 2), width - wide / 2 - 2) : mid
    h.lines.forEach((line, i) => {
      const say = line.startsWith('~')
      g.append(svg('text', { x, y: top + (lines - h.lines.length + i + 1) * LINE, 'text-anchor': 'middle', class: say ? 'dg-say' : 'dg-wire' }, say ? line.slice(1) : line))
    })
    const at = top + lines * LINE + 9
    const dir = Math.sign(xs[h.to] - xs[h.from])
    g.append(svg('circle', { cx: xs[h.from], cy: at, r: 3.2, class: `is-${way}`, stroke: 'none' }))
    g.append(svg('line', { x1: xs[h.from], y1: at, x2: xs[h.to] - dir * 7, y2: at, class: `is-${way}`, 'marker-end': `url(#dg-${way}-${width})` }))
    return at
  }

  for (const band of BANDS) {
    y += 14
    root.append(svg('line', { x1: 0, y1: y, x2: width, y2: y, class: 'dg-rule' }))
    y += 18
    root.append(svg('text', { x: 0, y, class: 'dg-band' }, band.title))
    y += 6
    for (const row of band.rows) {
      if (narrow) for (const h of row) y = drawHop(h, y, h.lines.length) + 12
      else {
        const lines = Math.max(...row.map(h => h.lines.length))
        y = Math.max(...row.map(h => drawHop(h, y, lines))) + 14
      }
      y += narrow ? 8 : 4
    }
  }
  const end = y + 4
  for (const x of xs) lives.append(svg('line', { x1: x, y1: box.h, x2: x, y2: end, class: 'dg-life' }))

  // What never leaves the session: a dashed box under Claude Code, and a line that is cut short.
  y = end + 14
  root.append(svg('line', { x1: 0, y1: y, x2: width, y2: y, class: 'dg-rule' }))
  y += 18
  root.append(svg('text', { x: 0, y, class: 'dg-band' }, 'Never crosses the channel'))
  y += 12
  const never = root.appendChild(svg('g', { class: 'dg-never' }))
  const lost = { x: narrow ? 1 : xs[0] - box.w / 2, w: narrow ? 172 : box.w, h: NEVER.length * 17 + 16 }
  never.append(svg('rect', { x: lost.x, y, width: lost.w, height: lost.h, rx: 6 }))
  NEVER.forEach((line, i) => never.append(svg('text', { x: lost.x + 14, y: y + 23 + i * 17, class: 'dg-lost' }, line)))
  const cut = { x1: lost.x + lost.w, x2: lost.x + lost.w + (narrow ? 30 : 72), y: y + lost.h / 2 }
  never.append(svg('line', { x1: cut.x1, y1: cut.y, x2: cut.x2, y2: cut.y, class: 'dg-cut' }))
  for (const tilt of [-1, 1]) never.append(svg('line', { x1: cut.x2 + 3, y1: cut.y - 7 * tilt, x2: cut.x2 + 17, y2: cut.y + 7 * tilt }))
  const note = narrow ? { x: 1, y: y + lost.h + 24 } : { x: xs[1] - 30, y: y + 23 }
  INSTEAD.forEach((line, i) => root.append(svg('text', { x: note.x, y: note.y + i * 18, class: `dg-instead${i ? '' : ' is-lead'}` }, line)))
  y = Math.max(y + lost.h, note.y + (INSTEAD.length - 1) * 18) + 10

  root.setAttribute('viewBox', `0 0 ${width} ${Math.ceil(y)}`)
  return root
}

const alone = document.documentElement.dataset.only === 'diagram'
$('diagram').replaceChildren(drawDiagram(false), drawDiagram(true))

// ---- the guide: the app's own words, and its own key table -----------------------

const MOD = /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘' : 'Ctrl'
const KEY_NAMES = { Mod: MOD, Shift: '⇧', ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→', Escape: 'Esc', ' ': 'Space', Delete: 'Del', Backspace: '⌫' }
// One key of the table as caps: 'g i' is G then I, 'Shift+ArrowUp' is ⇧ ↑.
function caps(spec) {
  const nodes = []
  ;(spec === ' ' ? [spec] : spec.split(' ')).forEach((part, i) => {
    if (i) nodes.push(el('i', null, 'then'))
    for (const p of part === '+' ? [part] : part.split('+')) nodes.push(el('kbd', null, KEY_NAMES[p] ?? (p.length === 1 ? p.toUpperCase() : p)))
  })
  return nodes
}

// The key list, from LAYOUT in keys.js: one block per title, a quiet entry lends its key to its twin.
function drawKeys(layout) {
  const blocks = new Map()
  for (const group of layout) {
    if (!blocks.has(group.title)) {
      const block = el('div')
      block.append(el('h3', null, group.title), el('dl', 'hp-params'))
      blocks.set(group.title, block)
    }
    const list = blocks.get(group.title).lastChild
    for (const entry of group.keys) {
      if (entry.quiet) continue
      const twin = group.keys.find(k => k.quiet && k.id === entry.id.replace('.next', '.prev'))
      const row = el('div')
      const dt = row.appendChild(el('dt'))
      ;[...(twin?.keys ?? []), ...entry.keys].forEach((spec, i) => { if (i) dt.append(el('i', null, twin ? '' : 'or')); dt.append(...caps(spec)) })
      row.append(el('dd', null, entry.verb ?? entry.does))
      list.append(row)
    }
  }
  $('key-list').replaceChildren(...blocks.values())
}

async function loadGuide() {
  // The words as the app says them today; the page's own text stands in where they cannot be read.
  try {
    const words = { ...(await import('./ui.js')), ...(await import('/pad/name.js').catch(() => ({}))) }
    for (const node of document.querySelectorAll('[data-word]')) {
      const word = words[node.dataset.word]
      if (typeof word === 'string') node.textContent = word
    }
  } catch {}
  try {
    const { LAYOUT, cap } = await import('./keys.js')
    drawKeys(LAYOUT)
    // The key of each of the four ways, beside its word.
    for (const node of document.querySelectorAll('[data-key]')) { try { node.append(el('kbd', null, cap(node.dataset.key))) } catch {} }
  } catch {
    $('key-list').replaceChildren(el('p', 'hp-wait', 'The key list could not be read. In the app, press ? to see it.'))
  }
}

// keys.js listens for "?" to open its sheet; on this page the list is the page, so "?" goes there.
window.addEventListener('keydown', e => {
  if (e.key !== '?' || e.ctrlKey || e.metaKey || e.altKey || e.target?.closest?.('input, textarea, select')) return
  e.preventDefault()
  e.stopImmediatePropagation()
  $('keys')?.scrollIntoView()
}, true)

// ---- the reference -------------------------------------------------------------

function typeOf(prop) {
  if (prop.enum) return prop.enum.join(' | ')
  if (prop.anyOf) return prop.anyOf.map(typeOf).join(' or ')
  if (prop.type === 'array') return prop.items?.type === 'object' ? `list of { ${Object.keys(prop.items.properties ?? {}).join(', ')} }` : `list of ${prop.items?.type ?? 'values'}`
  return prop.type ?? ''
}

// name, note in small caps, type and description: one row of a parameter list.
function paramRow(name, note, type, description, required = false) {
  const row = el('div')
  const dt = row.appendChild(el('dt', null, name))
  if (note) dt.append(el('small', required ? 'is-required' : null, note))
  const dd = row.appendChild(el('dd'))
  if (type) dd.append(el('b', null, type))
  dd.append(description ?? '')
  return row
}

function example(label, text) {
  const side = el('div', 'hp-entry-side')
  const pre = el('pre')
  pre.append(el('code', null, text))
  side.append(el('span', 'hp-label', label), pre)
  return side
}

function toolEntry(tool) {
  const entry = el('article', 'hp-entry')
  entry.id = `tool-${tool.name}`
  const head = entry.appendChild(el('div', 'hp-entry-head'))
  head.append(el('h3', null, tool.name))
  entry.append(el('p', null, tool.description))
  const props = Object.entries(tool.inputSchema.properties ?? {})
  const required = new Set(tool.inputSchema.required ?? [])
  const body = entry.appendChild(el('div', 'hp-entry-body'))
  if (!props.length) body.append(el('p', 'hp-none', 'Takes no parameters.'))
  else {
    const list = body.appendChild(el('dl', 'hp-params'))
    for (const [name, prop] of props) list.append(paramRow(name, required.has(name) ? 'required' : 'optional', typeOf(prop), prop.description, required.has(name)))
  }
  entry.append(example('Example call', `${tool.name}(${JSON.stringify(tool.example ?? {}, null, 2)})`))
  return entry
}

function eventEntry(event) {
  const entry = el('article', 'hp-entry')
  const head = entry.appendChild(el('div', 'hp-entry-head'))
  const toAgent = event.direction === 'to_agent'
  head.append(el('span', `hp-tag ${toAgent ? 'is-to-agent' : ''}`, toAgent ? 'to the agent' : 'from Claude Code'), el('h3', null, event.kind ? `kind="${event.kind}"` : event.method.split('/').at(-1)))
  entry.append(el('p', null, event.when))
  const body = entry.appendChild(el('div', 'hp-entry-body'))
  const list = body.appendChild(el('dl', 'hp-params'))
  list.append(paramRow('method', '', event.method, ''))
  if (event.content) list.append(paramRow('content', '', '', event.content))
  for (const [name, says] of Object.entries(event.meta ?? {})) list.append(paramRow(`meta.${name}`, '', '', says))
  for (const [name, says] of Object.entries(event.optional ?? {})) list.append(paramRow(`meta.${name}`, 'sometimes', '', says))
  for (const [name, says] of Object.entries(event.params ?? {})) list.append(paramRow(name, '', '', says))
  entry.append(example(event.kind ? 'As the agent sees it' : 'Parameters', event.example))
  return entry
}

async function loadReference() {
  let ref
  try {
    const res = await fetch('/api/tools')
    if (!res.ok) throw new Error(String(res.status))
    ref = await res.json()
  } catch {
    for (const id of ['tool-list', 'event-list']) $(id).replaceChildren(el('p', 'hp-wait', 'The reference is read from the running server, and this server does not offer it yet. Restart the hub to see it.'))
    return
  }
  $('tool-list').replaceChildren(...ref.tools.map(toolEntry))
  $('event-list').replaceChildren(...ref.events.map(eventEntry))
  $('tool-count').textContent = `${ref.tools.length} tools · Trommi ${ref.version}`
  $('asset-life').textContent = `Deleted after ${ref.retention_days} days unless published with keep; revoke_asset ends a link at once. Up to ${ref.max_asset_mb} MB each.`
  // The page may have been opened at an entry that did not exist yet.
  if (location.hash.startsWith('#tool-')) document.getElementById(location.hash.slice(1))?.scrollIntoView()
}

// On a phone the table of what the hub sees becomes a list; each cell then says which column it was.
for (const row of document.querySelectorAll('.hp-sees tbody tr')) {
  const cells = row.querySelectorAll('td')
  if (cells.length === 2) ['Today', 'Once the room key exists'].forEach((when, i) => { cells[i].dataset.when = when })
}

if (!alone) { loadGuide(); loadReference() }
