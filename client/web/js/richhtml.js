// Rich content in a text: tables as agents write them in markdown, and HTML an agent sends along
// (the field html beside a message or a question, or a block fenced as ```html inside a text).
//
// The HTML is never part of this page. It stands in a frame that has no origin of its own
// (sandbox without allow-same-origin: no cookies, no storage, no way to the board's DOM), under a
// policy that fetches nothing (default-src 'none', pictures as data: only) and runs one script, the
// one written here (it carries a nonce made for this frame; whatever the agent wrote has none, and
// handlers written into tags never run). That script does three things: it says how tall the
// content is, takes the theme when it changes, and hands a clicked link to this page, which opens
// it in a new tab. No forms, no popups, no way to move the page around it.
// The server has already cleaned what it stored (server/richhtml.mjs); here it is parsed and
// cleaned once more by the browser's own parser, so that old state and other senders hold too.
//
// rich() in ui.js calls htmlBlock() for a ```html fence, and store.js folds the html field of
// messages, cards, sections and versions into their text as such a fence (foldHtml), so every
// place that draws a text with rich() shows the layout at its place without knowing of it.

const el = (tag, cls, text) => {
  const node = document.createElement(tag)
  if (cls) node.className = cls
  if (text != null) node.textContent = text
  return node
}

// This module brings its own stylesheet, so a page that draws texts needs no line for it.
if (typeof document !== 'undefined' && !document.querySelector('link[data-richhtml]')) {
  const link = el('link')
  link.rel = 'stylesheet'
  link.href = new URL('../css/richhtml.css', import.meta.url).pathname
  link.dataset.richhtml = ''
  document.head.append(link)
}

// ---- tables ----------------------------------------------------------------------

// What counts as a number in a cell: 40, 1.250,50 €, ~12 ms, +3 %, 1.2 GB, $40/month.
const NUMERIC = /^[~≈<>≤≥±+\-−–]?\s*[€$£¥]?\s*\d[\d.,'’   ]*\s*(%|‰|[€$£¥]|[a-zA-Zµ°²³]{1,8})?(\s*\/\s*[a-zA-Z]{1,8})?$/
const NEUTRAL = /^([-–—]|n\/a|k\.\s?a\.)?$/i

/** Set a table's columns: a column of numbers stands right-aligned, in figures of one width; a rule
 *  row as markdown writes it (:--, :-:, --:) says it outright. Returns the table. */
export function tidyTable(table, rule = '') {
  const rows = [...table.rows]
  if (!rows.length || rows.some(r => [...r.cells].some(c => c.colSpan > 1 || c.rowSpan > 1))) return table
  const said = String(rule).trim().replace(/^\||\|$/g, '').split('|').map(c => c.trim()).map(c => (/^:-+:$/.test(c) ? 'center' : /^-+:$/.test(c) ? 'right' : /^:-+$/.test(c) ? 'left' : ''))
  const width = Math.max(...rows.map(r => r.cells.length))
  for (let col = 0; col < width; col++) {
    const cells = rows.map(r => r.cells[col]).filter(Boolean)
    const body = cells.filter(c => c.tagName === 'TD').map(c => c.textContent.trim())
    const numbers = body.filter(t => NUMERIC.test(t)).length
    const numeric = numbers > 0 && body.every(t => NUMERIC.test(t) || NEUTRAL.test(t))
    const align = said[col] || (numeric ? 'right' : '')
    if (!align) continue
    for (const cell of cells) {
      // What the author set on a cell stands.
      if (cell.hasAttribute('align') || /text-align/i.test(cell.getAttribute('style') ?? '')) continue
      if (align === 'right') cell.classList.add('num')
      else if (align === 'center') cell.classList.add('mid')
    }
  }
  return table
}

const ROW = /^\s*\|.*\|\s*$/
const RULE = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/

/** A text in which every markdown table is a block of its own: a blank line before and after it, and
 *  pipes at both ends of its rows, so that rich() finds it also right under a sentence. */
export function spaceTables(text) {
  const lines = String(text).split('\n')
  if (!lines.some(l => RULE.test(l) && l.includes('-'))) return String(text)
  const out = []
  for (let i = 0; i < lines.length; i++) {
    const head = lines[i], rule = lines[i + 1]
    if (!(head.includes('|') && rule != null && rule.includes('-') && RULE.test(rule) && (rule.includes('|') || ROW.test(head)))) { out.push(head); continue }
    const piped = l => (ROW.test(l) ? l : `| ${l.trim().replace(/^\||\|$/g, '')} |`)
    if (out.length && out.at(-1).trim()) out.push('')
    out.push(piped(head), piped(rule))
    i += 2
    while (i < lines.length && lines[i].trim() && lines[i].includes('|')) out.push(piped(lines[i++]))
    if (i < lines.length && lines[i].trim()) out.push('')
    i--
  }
  return out.join('\n')
}

// ---- what a text carries, for places that show one line of it ---------------------

const HTML_FENCE = /```html[ \t]*\n[\s\S]*?```/gi

/** 'table', 'layout' or '': what a card shows besides words (a row in a list has no room for it, and names it). */
export function richMark(card) {
  const sections = card?.sections ?? []
  const texts = [card?.body, ...sections.map(s => s?.text)].filter(Boolean).join('\n\n')
  const blocks = [...(texts.match(HTML_FENCE) ?? []), card?.html, ...sections.map(s => s?.html)].filter(Boolean)
  if (blocks.some(b => !/<table\b/i.test(b))) return 'layout'
  if (blocks.length) return 'table'
  const lines = texts.replace(/```[\s\S]*?```/g, '').split('\n')
  return lines.some((l, i) => i && l.includes('-') && RULE.test(l) && lines[i - 1].includes('|')) ? 'table' : ''
}

/** A text for one line: without its layouts and without the rows of its tables. */
export function withoutLayouts(text) {
  const lines = String(text ?? '').replace(HTML_FENCE, ' ').split('\n')
  return lines.filter((l, i) => !(ROW.test(l) || (l.includes('-') && RULE.test(l) && (lines[i - 1] ?? '').includes('|')))).join('\n')
}

// ---- the html field, folded into the text it belongs to ----------------------------

const fence = html => `\`\`\`html\n${String(html).replace(/```/g, '&#96;&#96;&#96;')}\n\`\`\``
const under = (text, html) => [String(text ?? '').trimEnd(), fence(html)].filter(Boolean).join('\n\n')

function foldQuestion(q) {
  if (!q || typeof q !== 'object') return
  if (Array.isArray(q.sections) && q.sections.some(s => s?.html)) {
    q.sections = q.sections.map(s => {
      if (!s?.html) return s
      const { html, ...rest } = s
      return { ...rest, text: under(s.text, html) }
    })
    // The body is the same text for places that know nothing of sections; it shows the layouts too.
    q.body = q.sections.map(s => (s.key == null ? s.text : `**${s.label}**${s.text ? `: ${s.text}` : ''}`)).join('\n\n')
  }
  if (q.html) {
    q.body = under(q.body, q.html)
    delete q.html
  }
}

/** The board's state with every html field moved into its text as a ```html block, in place: a message's
 *  under its text, a card's under its body, a section's under its paragraph, and the same in a card's
 *  earlier versions. Whatever draws a text with rich() then shows the layout. Folding twice changes nothing. */
export function foldHtml(data) {
  for (const m of data?.messages ?? []) {
    if (!m?.html) continue
    m.text = under(m.text, m.html)
    delete m.html
  }
  for (const card of data?.cards ?? []) {
    foldQuestion(card)
    for (const v of card?.versions ?? []) foldQuestion(v)
  }
  return data
}

// ---- the frame ---------------------------------------------------------------------

// Never part of a block: what runs, embeds, loads or redirects.
const BANNED = 'script, iframe, frame, frameset, object, embed, applet, meta, link, base, noscript, template, audio, video, source, track, portal'
const LINK_OK = /^(https?:|mailto:|#|[^:]*$)/i

/** Parse a block with the browser's parser (nothing runs, nothing loads) and take out what does not belong. */
function parse(source) {
  const doc = new DOMParser().parseFromString(String(source ?? ''), 'text/html')
  doc.querySelectorAll(BANNED).forEach(n => n.remove())
  doc.querySelectorAll('form').forEach(f => f.replaceWith(...f.childNodes))
  for (const node of doc.querySelectorAll('*')) {
    for (const attr of [...node.attributes]) {
      const name = attr.name.toLowerCase()
      if (name.startsWith('on') || ['srcdoc', 'formaction', 'ping', 'srcset', 'poster', 'background'].includes(name)) node.removeAttribute(attr.name)
      else if (['href', 'xlink:href', 'action'].includes(name) && !LINK_OK.test(attr.value.replace(/[\s\u0000-\u001f]/g, ''))) node.setAttribute(attr.name, '#')
      else if (name === 'src' && !/^data:image\//i.test(attr.value.trim())) node.removeAttribute(attr.name)
    }
  }
  // A link never moves the frame: it asks for a new tab, which the frame may not open; the page around it does.
  doc.querySelectorAll('a[href]').forEach(a => { if (!a.getAttribute('href').startsWith('#')) a.target = '_blank' })
  doc.querySelectorAll('table').forEach(t => tidyTable(t))
  for (const style of doc.head.querySelectorAll('style')) doc.body.prepend(style)
  return { body: doc.body.innerHTML, kind: doc.querySelector('table') && !doc.querySelector('.grid, .card, details, h1, h2, h3, svg, img') ? 'table' : 'layout' }
}

// The house style inside the frame: plain semantic HTML looks like the board. Colours, radii and fonts
// are the board's own tokens, handed in per theme (tokens()).
const HOUSE = `
*,*::before,*::after{box-sizing:border-box}
html{background:transparent;-webkit-text-size-adjust:100%;text-size-adjust:100%}
body{margin:0;padding:1px 0;font:400 1rem/1.55 var(--font);color:var(--fg);overflow-wrap:anywhere}
body>:first-child{margin-top:0}body>:last-child{margin-bottom:0}
h1,h2,h3,h4,h5,h6{margin:1.15em 0 .45em;font-family:var(--display);font-weight:700;line-height:1.2}
h1{font-size:1.45rem}h2{font-size:1.25rem}h3{font-size:1.08rem}h4,h5,h6{font-size:1rem}
p,ul,ol,dl,table,pre,details,blockquote,figure,.grid{margin:0 0 .8em}
ul,ol{padding-left:1.35em}li+li{margin-top:.3em}li::marker{color:var(--faint)}
a{color:var(--accent);text-decoration-thickness:1px;text-underline-offset:3px}
strong,b{font-weight:600}
small,.muted,figcaption,caption{color:var(--muted)}
small,figcaption,caption{font-size:var(--t-sm)}
table{border-collapse:collapse;font-size:.95em;line-height:1.4}
th,td{padding:6px 14px 6px 0;text-align:left;vertical-align:top;border-bottom:1px solid var(--line-strong);overflow-wrap:normal}
th{font-weight:600}
thead th,table>tr:first-child>th,tbody:first-child>tr:first-child>th{border-bottom:2px solid var(--fg);white-space:nowrap}
tbody:last-child>tr:last-child>*,table>tr:last-child>*{border-bottom:0}
tfoot>tr>*{border-top:2px solid var(--fg);border-bottom:0;font-weight:600}
th:last-child,td:last-child{padding-right:0}
caption{caption-side:top;text-align:left;padding-bottom:6px}
.num,[align=right]{text-align:right;font-variant-numeric:tabular-nums}
.mid,[align=center]{text-align:center}
code,kbd,samp,pre{font-family:var(--mono);font-size:.86em}
:not(pre)>code{padding:1px 5px;border-radius:5px;background:var(--sunken)}
pre{padding:12px 14px;border:1px solid var(--line);border-radius:var(--r-md);background:var(--surface-2);overflow-x:auto;line-height:1.6}
kbd{padding:1px 6px;border:1px solid var(--line-strong);border-bottom-width:2px;border-radius:5px;background:var(--surface)}
mark{padding:0 3px;border-radius:3px;background:var(--st-working-soft);color:inherit}
details{padding:8px 12px;border:1px solid var(--line);border-radius:var(--r-md)}
summary{cursor:pointer;font-weight:600}details[open]>summary{margin-bottom:6px}details>:last-child{margin-bottom:0}
blockquote{padding-left:12px;border-left:2px solid var(--line-strong);color:var(--muted)}
hr{margin:1em 0;border:0;border-top:1px solid var(--line-strong)}
img,svg{max-width:100%;height:auto}figure>img{display:block;border-radius:var(--r-sm)}figcaption{margin-top:4px}
dt{font-weight:600}dd{margin:0 0 .5em}
input,button,select,textarea{font:inherit;color:inherit}
.grid{display:grid;gap:12px;grid-template-columns:repeat(auto-fit,minmax(160px,1fr))}
.cols-2{grid-template-columns:repeat(2,minmax(0,1fr))}.cols-3{grid-template-columns:repeat(3,minmax(0,1fr))}
@media (max-width:440px){.cols-2,.cols-3{grid-template-columns:minmax(0,1fr)}}
.card{padding:12px 14px;border:1px solid var(--line-strong);border-radius:var(--r-md);background:var(--surface)}
.card>:first-child{margin-top:0}.card>:last-child{margin-bottom:0}
.tag{display:inline-block;padding:1px 8px;border-radius:999px;background:var(--sunken);color:var(--muted);font-size:var(--t-xs);font-weight:600;white-space:nowrap}
.good{color:var(--st-done)}.warn{color:var(--st-working)}.bad{color:var(--st-decision)}
.tag.good{background:var(--st-done-soft)}.tag.warn{background:var(--st-working-soft)}.tag.bad{background:var(--st-decision-soft)}
`

// The board's tokens as they are right now, light or dark: every custom property that tokens.css sets on :root.
let tokenNames = null
function tokens() {
  if (!tokenNames) {
    tokenNames = new Set()
    for (const sheet of document.styleSheets) {
      let rules = []
      try { rules = sheet.cssRules } catch { continue }   // a sheet from another origin (the fonts) is not ours to read
      for (const rule of rules) {
        if (!/^:root\b/.test(rule.selectorText ?? '')) continue
        for (const name of rule.style) if (name.startsWith('--')) tokenNames.add(name)
      }
    }
    if (!tokenNames.size) tokenNames = null
  }
  const root = getComputedStyle(document.documentElement)
  const dark = document.documentElement.dataset.theme === 'dark'
  // Drawn marks (data: pictures in a token) stay on the board.
  const vars = [...(tokenNames ?? [])].map(name => [name, root.getPropertyValue(name).trim()]).filter(([, v]) => v && !v.includes('url(')).map(([n, v]) => `${n}:${v}`)
  return { css: `:root{${vars.join(';')};font-size:${root.fontSize};color-scheme:${dark ? 'dark' : 'light'}}`, scheme: dark ? 'dark' : 'light' }
}

// The one script in a frame. It reports the height of the content (and whether it is wider than the
// frame), takes new tokens when the theme changes, and hands a clicked link to the page around it.
const inside = id => `(()=>{
const id=${JSON.stringify(id)},root=document.documentElement
let last=''
const tell=()=>{const h=Math.ceil(root.getBoundingClientRect().height),wide=root.scrollWidth>root.clientWidth+1,now=h+'|'+wide;if(now===last)return;last=now;parent.postMessage({trommiRich:id,h,wide},'*')}
new ResizeObserver(tell).observe(root)
addEventListener('load',tell)
addEventListener('toggle',()=>requestAnimationFrame(tell),true)
tell()
addEventListener('message',e=>{if(e.source!==parent||!e.data||typeof e.data.trommiTokens!=='string')return;document.getElementById('trommi-tokens').textContent=e.data.trommiTokens;last='';tell()})
addEventListener('click',e=>{const a=e.target&&e.target.closest&&e.target.closest('a[href]');if(!a)return;const href=a.getAttribute('href');if(href.charAt(0)==='#')return;e.preventDefault();parent.postMessage({trommiRich:id,open:a.href},'*')},true)
})()`

const POLICY = nonce => `default-src 'none'; style-src 'unsafe-inline'; img-src data:; script-src 'nonce-${nonce}'; base-uri 'none'; form-action 'none'`

function documentOf(body, id, large) {
  const nonce = [...crypto.getRandomValues(new Uint8Array(16))].map(b => b.toString(16).padStart(2, '0')).join('')
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${POLICY(nonce)}"><meta name="referrer" content="no-referrer"><style id="trommi-tokens">${tokens().css}</style><style>${HOUSE}${large ? 'body{padding:20px 24px}' : ''}</style></head><body>${body}<script nonce="${nonce}">${inside(id)}</script></body></html>`
}

// The frames that stand in the page, by the name their script signs with.
const live = new Map()   // id -> WeakRef(frame)
let seq = 0
// How tall a block came out, so that it is drawn again at that height at once (lists are redrawn often).
const heights = new Map()   // key of the source -> px
const keyOf = source => { let h = 0; for (let i = 0; i < source.length; i += 1 + (source.length >> 12)) h = (h * 31 + source.charCodeAt(i)) | 0; return `${source.length}:${h}:${Math.round(innerWidth / 40)}` }
const cap = () => Math.max(240, Math.round(innerHeight * 0.7))

function fit(frame, h, wide) {
  if (frame.dataset.large != null) return
  // A sideways scroll bar takes room of its own.
  const need = wide == null ? h : Math.max(24, h + (wide ? 14 : 0))
  heights.set(frame.dataset.key, need)
  frame.dataset.need = need
  frame.style.height = `${Math.min(need, cap())}px`
  frame.parentElement?.classList.toggle('is-capped', need > cap())
  if (wide != null) frame.parentElement?.classList.toggle('is-wide', wide)
}

if (typeof window !== 'undefined') {
  addEventListener('message', e => {
    const said = e.data
    if (!said || typeof said.trommiRich !== 'string') return
    const frame = live.get(said.trommiRich)?.deref()
    // Only the frame that was given this name may speak under it.
    if (!frame || e.source !== frame.contentWindow) return
    if (Number.isFinite(said.h)) fit(frame, Math.min(Math.max(0, said.h), 100000), said.wide === true)
    else if (typeof said.open === 'string' && /^https?:\/\//i.test(said.open)) window.open(said.open, '_blank', 'noopener,noreferrer')
  })
  // The theme changed: every frame gets the new tokens, without being loaded again.
  new MutationObserver(() => {
    const { css, scheme } = tokens()
    for (const [id, ref] of live) {
      const frame = ref.deref()
      if (!frame?.isConnected) { if (!frame) live.delete(id); continue }
      frame.style.colorScheme = scheme
      frame.contentWindow?.postMessage({ trommiTokens: css }, '*')
    }
  }).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
  // The window changed: most of the screen is another height now.
  addEventListener('resize', () => {
    for (const ref of live.values()) {
      const frame = ref.deref()
      if (frame?.isConnected && frame.dataset.need) fit(frame, Number(frame.dataset.need), null)
    }
  })
}

function frameOf(body, source, large = false) {
  for (const [id, ref] of live) if (!ref.deref()) live.delete(id)
  const id = `r${++seq}-${Math.random().toString(36).slice(2, 10)}`
  const frame = el('iframe', 'rh-frame')
  // Scripts, and nothing else: no origin, no forms, no popups, no navigation of the page around it.
  frame.setAttribute('sandbox', 'allow-scripts')
  frame.referrerPolicy = 'no-referrer'
  frame.title = 'Layout from the agent'
  frame.style.colorScheme = tokens().scheme
  frame.dataset.key = keyOf(source)
  if (large) frame.dataset.large = ''
  else frame.style.height = `${Math.min(heights.get(frame.dataset.key) ?? 96, cap())}px`
  frame.srcdoc = documentOf(body, id, large)
  live.set(id, new WeakRef(frame))
  return frame
}

// The big view: the same block, in a window over the page, as tall and wide as the screen gives.
let large = null
function openLarge(body, source) {
  if (!large) {
    const dialog = el('dialog', 'rh-large')
    dialog.setAttribute('aria-label', 'Layout, large')
    const bar = el('div', 'rh-large-bar')
    const close = el('button', 'rh-large-close', 'Close')
    close.type = 'button'
    close.addEventListener('click', () => dialog.close())
    bar.append(el('span', 'rh-large-name', 'From the agent'), close)
    const stage = el('div', 'rh-large-stage')
    dialog.append(bar, stage)
    // A click beside the sheet closes it; Escape closes this window and not the one under it.
    dialog.addEventListener('click', e => { if (e.target === dialog) dialog.close() })
    dialog.addEventListener('keydown', e => { if (e.key === 'Escape') { e.stopPropagation(); e.preventDefault(); dialog.close() } })
    dialog.addEventListener('close', () => stage.replaceChildren())
    document.body.append(dialog)
    large = { dialog, stage }
  }
  large.stage.replaceChildren(frameOf(body, source, true))
  if (!large.dialog.open) large.dialog.showModal()
}

/** A block of HTML from an agent, shown at its place: a sandboxed frame as tall as its content, up to
 *  most of the screen (beyond that it scrolls inside), with "Open large". Returns a div.rh. */
export function htmlBlock(source) {
  const text = String(source ?? '')
  const { body, kind } = parse(text)
  const box = el('div', `rh rh-${kind}`)
  box.dataset.rich = kind
  const frame = frameOf(body, text)
  const open = el('button', 'rh-open', 'Open large')
  open.type = 'button'
  open.addEventListener('click', e => { e.stopPropagation(); openLarge(body, text) })
  if ((heights.get(frame.dataset.key) ?? 0) > cap()) box.classList.add('is-capped')
  box.append(frame, open)
  return box
}
