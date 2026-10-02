#!/usr/bin/env node
// Builds assets/ from the sources of the product, so the folder never drifts from what the app draws.
//
//   node assets/build.mjs            rewrite every file that is derived from code: the SVGs, the palette,
//                                    the gallery (assets/index.html and client/web/designs/assets.html)
//   node assets/build.mjs --check    write nothing; exit 1 when a file is out of date, missing or left over
//   node assets/build.mjs --render   also render the PNGs (logo, favicon, swatches) with headless Chromium
//   node assets/build.mjs --screens [PORT]   also take the product screenshots from a demo board (default 8827)
//
// No dependencies. --render and --screens start Chromium through dev/cdp.mjs, which cannot run inside the
// command sandbox. Nothing here copies path data by hand: the drawings come out of client/web/js/ui.js (imported
// with a stub of the little DOM it touches) and out of the literals in the other modules (read from their source
// text and evaluated), the colours and stroke widths out of the stylesheets.
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.join(here, '..')
const web = path.join(root, 'client', 'web')
const read = rel => fs.readFileSync(path.join(root, rel), 'utf8')
const flags = new Set(process.argv.slice(2).filter(a => a.startsWith('--')))
const CHECK = flags.has('--check')

// ---- the little of the DOM the drawing code touches ----------------------------------------------

class Node {
  constructor(tag) {
    this.tag = tag
    this.attrs = {}
    this.children = []
    this.dataset = {}
    const props = {}
    this.style = { rotate: '', props, setProperty: (k, v) => { props[k] = String(v) }, removeProperty: k => { delete props[k] } }
    this.classList = { add: (...c) => { this.attrs.class = [this.attrs.class, ...c].filter(Boolean).join(' ') }, remove() {}, toggle() {} }
  }
  set className(v) { this.attrs.class = v }
  get className() { return this.attrs.class ?? '' }
  setAttribute(k, v) { this.attrs[k] = String(v) }
  getAttribute(k) { return this.attrs[k] ?? null }
  append(...kids) { this.children.push(...kids) }
  prepend(...kids) { this.children.unshift(...kids) }
  get childNodes() { return this.children }
  addEventListener() {}
}
globalThis.document = { createElementNS: (_, tag) => new Node(tag), createElement: tag => new Node(tag), querySelectorAll: () => [], querySelector: () => null, head: new Node('head'), body: new Node('body'), documentElement: new Node('html'), styleSheets: [] }
globalThis.setInterval = () => 0   // ui.js keeps relative times current; nothing here needs it

const ui = await import(pathToFileURL(path.join(web, 'js', 'ui.js')).href)

// ---- reading literals and functions out of a module's source -------------------------------------

/** The text from the bracket at `from` to the bracket that closes it. */
function balanced(src, from) {
  const open = src[from], close = { '{': '}', '[': ']', '(': ')' }[open]
  let depth = 0
  for (let i = from; i < src.length; i++) {
    if (src[i] === open) depth++
    else if (src[i] === close && --depth === 0) return src.slice(from, i + 1)
  }
  throw new Error('unbalanced source')
}
/** `const NAME = <literal>` in a source text, evaluated. Names the literal refers to resolve to `scope`,
 *  or to a stub that gives an empty list (enough to learn the literal's keys). */
function constOf(src, name, scope = {}) {
  const at = src.search(new RegExp(`\\bconst ${name} = [\\[{]`))
  if (at < 0) return null
  const lit = balanced(src, src.indexOf('=', at) + 2)
  const stub = () => []
  const env = new Proxy(scope, { has: () => true, get: (t, k) => (k === Symbol.unscopables ? undefined : k in t ? t[k] : k in globalThis ? globalThis[k] : stub) })
  return new Function('env', `with (env) { return (${lit}) }`)(env)
}
/** `function NAME(…) {…}` in a source text, as a function over the given scope. */
function functionOf(src, name, scope = {}) {
  const at = src.search(new RegExp(`\\bfunction ${name}\\(`))
  if (at < 0) return null
  const head = balanced(src, src.indexOf('(', at))
  const bodyAt = src.indexOf('{', src.indexOf('(', at) + head.length)
  const text = src.slice(at, bodyAt) + balanced(src, bodyAt)
  return new Function(...Object.keys(scope), `${text}; return ${name}`)(...Object.values(scope))
}
const kebab = s => s.replace(/([a-z0-9])([A-Z])/g, '$1-$2').replace(/[^A-Za-z0-9]+/g, '-').toLowerCase()

// ---- the stylesheets: tokens, and the rules that say how a drawing is stroked ----------------------

const cssFiles = ['css/tokens.css', 'css/app.css', ...fs.readdirSync(path.join(web, 'css')).filter(f => f.endsWith('.css') && !['tokens.css', 'app.css'].includes(f)).sort().map(f => `css/${f}`), 'pad/pad.css']
const cssText = Object.fromEntries(cssFiles.map(f => [f, fs.readFileSync(path.join(web, f), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')]))
const declarations = body => Object.fromEntries(body.split(';').map(d => d.trim()).filter(Boolean).map(d => [d.slice(0, d.indexOf(':')).trim(), d.slice(d.indexOf(':') + 1).trim()]))
const ruleCache = new Map()
/** The first rule with exactly this selector, as { property: value }; null when there is none. */
function rule(selector) {
  if (ruleCache.has(selector)) return ruleCache.get(selector)
  let found = null
  for (const f of cssFiles) {
    for (const m of cssText[f].matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      if (m[1].split(',').some(s => s.trim() === selector)) { found = declarations(m[2]); break }
    }
    if (found) break
  }
  ruleCache.set(selector, found)
  return found
}
const need = (selector, prop) => {
  const value = rule(selector)?.[prop]
  if (value == null) throw new Error(`the stylesheets no longer say ${selector} { ${prop} }; assets/build.mjs reads it`)
  return value
}

const tokenBlock = selector => {
  const m = new RegExp(`${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{([^{}]*)\\}`).exec(cssText['css/tokens.css'])
  if (!m) throw new Error(`css/tokens.css has no ${selector} block`)
  return Object.fromEntries(Object.entries(declarations(m[1])).filter(([k]) => k.startsWith('--')))
}
const lightTokens = tokenBlock(':root')
const darkTokens = { ...lightTokens, ...tokenBlock(':root[data-theme="dark"]') }
const TOKENS = { light: lightTokens, dark: darkTokens }
const isColour = v => /^(#[0-9a-f]{3,8}|rgba?\([^)]*\))$/i.test(v)
const colourNames = Object.keys(lightTokens).filter(k => isColour(lightTokens[k]))

// The colour a session's mark is drawn in: a hue per session (agents.js), a pen per theme (app.css).
const agentsSrc = read('client/web/js/agents.js')
const HUES = constOf(agentsSrc, 'HUES')
const hueOf = functionOf(agentsSrc, 'hueOf', { HUES })
const INK = { light: need('.agent-avatar', 'color'), dark: need(':root[data-theme="dark"] .agent-avatar', 'color') }

// ---- colours: CSS expressions to plain hex, for files that must stand alone -----------------------

const hex = ([r, g, b]) => `#${[r, g, b].map(v => Math.round(Math.min(255, Math.max(0, v))).toString(16).padStart(2, '0')).join('')}`
function rgbOf(c) {
  c = c.trim()
  if (c === 'white') return [255, 255, 255]
  if (c === 'black') return [0, 0, 0]
  let m = /^#([0-9a-f]{6})$/i.exec(c)
  if (m) return [0, 2, 4].map(i => parseInt(m[1].slice(i, i + 2), 16))
  m = /^#([0-9a-f]{3})$/i.exec(c)
  if (m) return [...m[1]].map(ch => parseInt(ch + ch, 16))
  m = /^hsl\(\s*([\d.]+)(?:deg)?[\s,]+([\d.]+)%[\s,]+([\d.]+)%\s*\)$/.exec(c)
  if (m) {
    const h = Number(m[1]) / 360, s = Number(m[2]) / 100, l = Number(m[3]) / 100
    const q = l < .5 ? l * (1 + s) : l + s - l * s, p = 2 * l - q
    const ch = t => { t = (t + 1) % 1; return t < 1 / 6 ? p + (q - p) * 6 * t : t < .5 ? q : t < 2 / 3 ? p + (q - p) * (2 / 3 - t) * 6 : p }
    return [ch(h + 1 / 3), ch(h), ch(h - 1 / 3)].map(v => v * 255)
  }
  return null
}
/** Split the arguments of a CSS function at its top-level commas. */
function args(text) {
  const out = []
  let depth = 0, last = 0
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '(') depth++
    else if (text[i] === ')') depth--
    else if (text[i] === ',' && !depth) { out.push(text.slice(last, i).trim()); last = i + 1 }
  }
  out.push(text.slice(last).trim())
  return out
}
/** A CSS value with var(), color-mix(in srgb) and hsl() worked out for one theme. currentColor stays. */
function resolve(value, theme = 'light', vars = {}) {
  const all = { ...TOKENS[theme], '--ink': INK[theme], ...vars }
  let v = String(value)
  for (let guard = 0; guard < 40; guard++) {
    const fn = /\b(var|color-mix|hsl)\(/.exec(v.replace(/\b(var|color-mix|hsl)\((?=[^()]*\))/g, '\u0000$1('))
    // Work from the inside out: the first call that has no call in its own arguments.
    const inner = [...v.matchAll(/\b(var|color-mix|hsl)\(([^()]*)\)/g)][0]
    if (!inner) { if (fn) throw new Error(`cannot work out ${value}`); break }
    const [whole, name, body] = inner
    let to
    if (name === 'var') {
      const [key, ...fallback] = args(body)
      to = all[key] ?? fallback.join(', ')
      if (to === '' || to == null) throw new Error(`no value for ${key} in ${value}`)
    } else if (name === 'hsl') {
      const rgb = rgbOf(whole)
      if (!rgb) throw new Error(`cannot read ${whole}`)
      to = hex(rgb)
    } else {
      const [, a, b] = args(body)
      const part = s => { const m = /^(.*?)\s+([\d.]+)%$/.exec(s); return m ? [m[1], Number(m[2]) / 100] : [s, null] }
      let [ca, pa] = part(a), [cb, pb] = part(b)
      if (pa == null && pb == null) pa = pb = .5
      else if (pa == null) pa = 1 - pb
      else if (pb == null) pb = 1 - pa
      const ra = rgbOf(ca), rb = rgbOf(cb)
      if (!ra || !rb) return v   // mixes with currentColor or transparent: left to whoever emits it
      to = hex(ra.map((x, i) => (x * pa + rb[i] * pb) / (pa + pb)))
    }
    v = v.replace(whole, to)
  }
  return v
}

// ---- from a drawn node to SVG text --------------------------------------------------------------------

const SVG_PROPS = ['fill', 'stroke', 'stroke-width', 'stroke-linecap', 'stroke-linejoin', 'stroke-dasharray', 'opacity', 'vector-effect']
const PEN = { fill: 'none', stroke: 'currentColor', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }
const num = n => String(Math.round(n * 1000) / 1000)
const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;')

/** What the stylesheets say about a node's classes, as presentation properties. */
function styleOf(node, { styles = {}, context = '' } = {}) {
  const out = {}
  for (const cls of (node.attrs.class ?? '').split(/\s+/).filter(Boolean)) {
    for (const selector of [`.${cls}`, context && `${context} .${cls}`]) {
      const r = selector && rule(selector)
      if (r) for (const p of SVG_PROPS) if (r[p] != null) out[p] = r[p]
    }
    Object.assign(out, styles[cls])
  }
  Object.assign(out, styles[node.tag])
  for (const k of Object.keys(out)) if (out[k] == null) delete out[k]
  return out
}
/** Presentation properties as attributes (file: plain values) or as a style (live: the page's own tokens). */
function paint(props, o) {
  const entries = Object.entries(props)
  if (!entries.length) return ''
  if (o.live) return ` style="${esc(entries.map(([k, v]) => `${k}:${v}`).join(';'))}"`
  return entries.map(([k, v]) => {
    let value = resolve(v, o.theme, o.vars)
    // A wash of the pen's own colour: the colour stays the reader's, its strength goes into the opacity.
    const wash = /^color-mix\(in srgb, currentColor ([\d.]+)%, transparent\)$/.exec(value)
    if (wash) return ` ${k}="currentColor" ${k}-opacity="${num(Number(wash[1]) / 100)}"`
    return ` ${k}="${esc(value)}"`
  }).join('')
}
function inner(node, o) {
  return node.children.map(kid => {
    if (typeof kid === 'string') return kid
    const attrs = Object.entries(kid.attrs).filter(([k]) => !['class', 'aria-hidden', 'pathLength'].includes(k)).map(([k, v]) => ` ${k}="${esc(v)}"`).join('')
    const own = { ...styleOf(kid, o) }
    if (kid.style.props['--hue'] != null && !own.stroke) own.stroke = resolve(INK.light, 'light', { '--hue': kid.style.props['--hue'] }) && (o.live ? `hsl(${kid.style.props['--hue']} var(--ink-sl))` : resolve(INK[o.theme], o.theme, { '--hue': kid.style.props['--hue'] }))
    const body = inner(kid, o)
    return `<${kid.tag}${attrs}${paint(own, o)}${body || kid.text ? `>${kid.text ? esc(kid.text) : ''}${body}</${kid.tag}>` : '/>'}`
  }).join('')
}
/** One drawing as SVG text.
 *  o.live: for the gallery (colours stay CSS, so the page's theme switch reaches them); else a file that stands alone.
 *  o.styles: { class or tag: properties } on top of what the stylesheets say. o.pad: air round the box, for
 *  drawings the app lets overflow. o.context: a selector the drawing stands in ('.focus-rail-mark'). */
function svgText(node, o = {}) {
  const [x, y, w, h] = node.attrs.viewBox.split(/[\s,]+/).map(Number)
  const pad = o.pad ?? 0
  const box = [x - pad, y - pad, w + 2 * pad, h + 2 * pad]
  const props = { ...PEN, ...(o.plain ? {} : styleOf(node, o)), ...o.styles?.svg }
  if (o.plain) for (const k of Object.keys(PEN)) if (!(o.styles?.svg && k in o.styles.svg)) delete props[k]
  delete props.opacity
  const classRule = (node.attrs.class ?? '').split(/\s+/).map(c => rule(`.${c}`)).find(r => r?.rotate)
  const turn = (parseFloat(node.style.rotate) || 0) + (o.still ? 0 : parseFloat(classRule?.rotate) || 0)
  const body = inner(node, o)
  const size = o.live ? ` width="${num(o.width ?? box[2])}" height="${num(o.height ?? box[3])}"` : ''
  const keep = node.attrs.preserveAspectRatio ? ` preserveAspectRatio="${node.attrs.preserveAspectRatio}"` : ''
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${box.map(num).join(' ')}"${size}${keep}${paint(props, o)}>${turn ? `<g transform="rotate(${num(turn)} ${num(x + w / 2)} ${num(y + h / 2)})">${body}</g>` : body}</svg>`
}
const boxOf = node => node.attrs.viewBox.split(/[\s,]+/).map(Number)

/** A node from path data, the way the modules' own icon() helpers build one. */
function fromPaths(cls, viewBox, paths) {
  const svg = new Node('svg')
  svg.attrs.viewBox = viewBox
  svg.attrs.class = cls
  for (const d of [].concat(paths)) { const p = new Node('path'); p.attrs.d = d; svg.append(p) }
  return svg
}
/** A node from SVG markup found in a page: the elements of one <svg>, attributes kept. */
function fromMarkup(markup) {
  const head = /<svg\b([^>]*)>/.exec(markup)
  const attrsOf = text => Object.fromEntries([...text.matchAll(/([\w:-]+)="([^"]*)"/g)].map(m => [m[1], m[2]]))
  const svg = new Node('svg')
  Object.assign(svg.attrs, attrsOf(head[1]))
  for (const m of markup.slice(head.index + head[0].length).matchAll(/<(rect|path|circle|line|ellipse)\b([^>]*?)\/?>/g)) {
    const kid = new Node(m[1])
    Object.assign(kid.attrs, attrsOf(m[2]))
    svg.append(kid)
  }
  return svg
}

// ---- the assets ------------------------------------------------------------------------------------

/** Every file this build writes: path under assets/ -> text or bytes. */
const files = new Map()
/** What the gallery shows, in order: { section, group, file, title, note, live, w, h, hue, kind }. */
const shown = []

function add(section, group, file, node, o = {}) {
  const [, , w, h] = boxOf(node)
  const text = o.text ?? svgText(node, { theme: 'light', ...o })
  files.set(file, text + '\n')
  const scale = o.show ?? Math.min(64 / h, 220 / w)
  const live = o.liveText ?? svgText(node, { ...o, live: true, width: (w + 2 * (o.pad ?? 0)) * scale, height: (h + 2 * (o.pad ?? 0)) * scale })
  shown.push({ section, group, file, note: o.note ?? '', live, w, h, hue: o.hue, ground: o.ground, wide: o.wide })
}

// -- logo ------------------------------------------------------------------------------------------------

const indexHtml = read('client/web/index.html')
const logo = await import(pathToFileURL(path.join(here, 'logo.mjs')).href)
const TILE_FG = { light: lightTokens['--accent-fg'], dark: darkTokens['--accent-fg'] }, TILE_BG = { light: lightTokens['--accent'], dark: darkTokens['--accent'] }
const penBig = logo.CUTS.big.strokes.map((s, i) => logo.outline(s, { seed: `ring${i}` })).join('')
const lines = cut => logo.CUTS[cut].strokes.map(s => logo.line(s, logo.CUTS[cut].heavier))
const strokesOf = (cut, attrs = '') => lines(cut).map(l => `<path${attrs} stroke-width="${l.width}" d="${l.d}"/>`).join('')
const S = logo.TILE.size
/** The mark on its tile. cut: big (the pen's pressure, filled) or small / tiny (plain strokes). rx: the tile's corner. shrink: the mark smaller on the tile. */
function tileSvg({ cut = 'big', theme = 'light', rx = logo.TILE.rx, shrink = 1, size = '' } = {}) {
  const body = cut === 'big' ? `<path fill="${TILE_FG[theme]}" d="${penBig}"/>` : `<g fill="none" stroke="${TILE_FG[theme]}" stroke-linecap="round" stroke-linejoin="round">${strokesOf(cut)}</g>`
  const placed = shrink === 1 ? body : `<g transform="translate(${num(S / 2 * (1 - shrink))} ${num(S / 2 * (1 - shrink))}) scale(${shrink})">${body}</g>`
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${S} ${S}"${size}><rect width="${S}" height="${S}"${rx ? ` rx="${rx}"` : ''} fill="${TILE_BG[theme]}"/>${placed}</svg>`
}
const big = ' width="96" height="96"'
files.set('logo/trommi-mark.svg', tileSvg() + '\n')
files.set('logo/trommi-mark-dark.svg', tileSvg({ theme: 'dark' }) + '\n')
files.set('logo/trommi-mark-small.svg', tileSvg({ cut: 'small' }) + '\n')
files.set('logo/trommi-mark-16.svg', tileSvg({ cut: 'tiny' }) + '\n')
shown.push({ section: 'logo', group: 'The mark', file: 'logo/trommi-mark.svg', note: 'the Z in its ring on the green tile; 48 px and up', live: tileSvg({ size: big }), w: S, h: S, ground: 'light' })
shown.push({ section: 'logo', group: 'The mark', file: 'logo/trommi-mark-dark.svg', note: 'the same, in the dark theme\'s colours', live: tileSvg({ theme: 'dark', size: big }), w: S, h: S, ground: 'dark' })
shown.push({ section: 'logo', group: 'The mark', file: 'logo/trommi-mark-small.svg', note: 'the cut for 20 to 40 px, as the top bar shows it: larger Z, heavier pen', live: tileSvg({ cut: 'small', size: ' width="32" height="32"' }), w: S, h: S, ground: 'light' })
shown.push({ section: 'logo', group: 'The mark', file: 'logo/trommi-mark-16.svg', note: 'the cut for 16 px: the Z alone, no ring', live: tileSvg({ cut: 'tiny', size: ' width="16" height="16"' }), w: S, h: S, ground: 'light' })
// The mark without a tile, in the colour of the text it stands in.
{
  const [cx, cy, cs] = logo.CROP
  const bare = size => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${cx} ${cy} ${cs} ${cs}"${size} fill="currentColor"><path d="${penBig}"/></svg>`
  files.set('logo/trommi-z.svg', bare('') + '\n')
  shown.push({ section: 'logo', group: 'The mark', file: 'logo/trommi-z.svg', note: 'the mark alone, in currentColor', live: bare(big), w: cs, h: cs })
}
// The app icon: the tile to the edge, for systems that cut the corners themselves; and one with the mark
// inside the safe zone of a maskable web icon.
files.set('logo/app-icon.svg', tileSvg({ rx: 0 }) + '\n')
files.set('logo/app-icon-maskable.svg', tileSvg({ rx: 0, shrink: .74 }) + '\n')
shown.push({ section: 'logo', group: 'App icon', file: 'logo/app-icon.svg', note: 'square to the edge: the source for iOS, Android and the web manifest', live: tileSvg({ rx: 0, size: big }), w: S, h: S })
shown.push({ section: 'logo', group: 'App icon', file: 'logo/app-icon-maskable.svg', note: 'maskable: the mark inside the safe zone', live: tileSvg({ rx: 0, shrink: .74, size: big }), w: S, h: S })

// The icon of a browser tab: one SVG with two cuts. Painted at 16 px it shows the Z alone, from 24 px on the Z in its ring.
const favicon = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${S} ${S}"><style>.s{display:none}@media (min-width:24px){.s{display:inline}.t{display:none}}</style><rect width="${S}" height="${S}" rx="${logo.TILE.rx}" fill="${TILE_BG.light}"/><g fill="none" stroke="${TILE_FG.light}" stroke-linecap="round" stroke-linejoin="round"><g class="t">${strokesOf('tiny')}</g><g class="s">${strokesOf('small')}</g></g></svg>`
files.set('logo/favicon.svg', favicon + '\n')
shown.push({ section: 'logo', group: 'The mark', file: 'logo/favicon.svg', note: 'the icon link of every page: at 16 px the Z alone, larger the Z in its ring', live: tileSvg({ cut: 'small', size: ' width="64" height="64"' }), w: S, h: S })

// What the web client carries of the mark, written into its pages by this build.
const iconLink = `<link rel="icon" type="image/svg+xml" href="data:image/svg+xml,${favicon.replace(/"/g, "'").replace(/[<>#%{}]/g, c => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)}">`
const brandMarkup = `<svg class="brand-mark" viewBox="0 0 ${S} ${S}" aria-hidden="true">
        <rect class="brand-mark-bg" width="${S}" height="${S}" rx="${logo.TILE.rx}"/>
${lines('small').map(l => `        <path class="brand-mark-pen" stroke-width="${l.width}" d="${l.d}"/>`).join('\n')}
      </svg>`
const patched = new Map()
for (const page of ['index.html', 'admin.html', 'help.html']) {
  const was = fs.readFileSync(path.join(web, page), 'utf8')
  if (!/<link rel="icon"[^>]*>/.test(was)) throw new Error(`client/web/${page} no longer has its icon link`)
  let now = was.replace(/<link rel="icon"[^>]*>/, () => iconLink)
  if (page === 'index.html') {
    if (!/<svg class="brand-mark"[\s\S]*?<\/svg>/.test(was)) throw new Error('client/web/index.html no longer has the brand mark')
    now = now.replace(/<svg class="brand-mark"[\s\S]*?<\/svg>/, () => brandMarkup)
  }
  patched.set(path.join(web, page), now)
}
need('.brand-mark-pen', 'stroke')   // css/app.css strokes the mark's pen; without the rule the top bar shows a black blot

// Mark and name together, as they stand in the top bar: sizes and weight from `.brand h1` and `.brand-mark`.
const brandFont = /^(\d+)\s+([\d.]+)rem/.exec(need('.brand h1', 'font'))
const markPx = parseFloat(need('.brand-mark', 'width')), gapPx = parseFloat(need('.brand', 'gap'))
const unit = 32 / markPx                                  // the mark is 32 units high here
const textSize = Number(brandFont[2]) * 16 * unit, tracking = parseFloat(need('.brand h1', 'letter-spacing'))
// How wide "Trommi" runs in Bricolage Grotesque 700 at 1 em, measured in Chromium (--render says when it is off).
const WORD = 'Trommi', WORD_EM = 3.617
const textX = 32 + gapPx * unit, lockW = Math.ceil(textX + textSize * (WORD_EM + tracking * WORD.length) + 2)
const fontFile = name => fs.readFileSync(path.join(here, 'fonts', name))
const haveFonts = fs.existsSync(path.join(here, 'fonts', 'BricolageGrotesque-latin-variable.woff2'))
const face = (family, file, weight) => `@font-face{font-family:"${family}";font-weight:${weight};src:url(data:font/woff2;base64,${fontFile(file).toString('base64')}) format("woff2")}`
function lockup(theme, { live = false, embed = true } = {}) {
  const mark = `<g transform="scale(${32 / S})">${tileSvg({ theme }).replace(/^<svg[^>]*>/, '').replace(/<\/svg>$/, '')}</g>`
  const fill = live ? 'style="fill:var(--fg)"' : `fill="${TOKENS[theme]['--fg']}"`
  const font = embed && haveFonts ? `<style>${face('Bricolage Grotesque', 'BricolageGrotesque-latin-variable.woff2', '200 800')}</style>` : ''
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${lockW} 32"${live ? ` width="${num(lockW * 2)}" height="64"` : ''}>${font}${mark}<text x="${num(textX)}" y="16" dominant-baseline="central" font-family="'Bricolage Grotesque', 'Avenir Next', 'Segoe UI', sans-serif" font-weight="${brandFont[1]}" font-size="${num(textSize)}" letter-spacing="${num(tracking * textSize)}" ${fill}>${WORD}</text></svg>`
}
files.set('logo/trommi-logo.svg', lockup('light') + '\n')
files.set('logo/trommi-logo-dark.svg', lockup('dark') + '\n')
shown.push({ section: 'logo', group: 'Mark and name', file: 'logo/trommi-logo.svg', note: 'the top bar\'s logo; the typeface is embedded', live: lockup('light', { embed: false }).replace('<svg ', `<svg width="${lockW * 2}" height="64" `), w: lockW, h: 32, wide: true, ground: 'light', noSource: true })
shown.push({ section: 'logo', group: 'Mark and name', file: 'logo/trommi-logo-dark.svg', note: 'the same for dark ground', live: lockup('dark', { embed: false }).replace('<svg ', `<svg width="${lockW * 2}" height="64" `), w: lockW, h: 32, wide: true, ground: 'dark', noSource: true })

// The name written by hand and circled, from the naming page.
const naming = read('client/web/naming.html')
const hero = /<div class="hero-mark">\s*(<svg[\s\S]*?<\/svg>)/.exec(naming)?.[1]
const defs = ['<filter id="rough"', '<filter id="sway"', '<symbol id="trommi"'].map(start => {
  const at = naming.indexOf(start), tag = start.slice(1, start.indexOf(' '))
  return at < 0 ? '' : naming.slice(at, naming.indexOf(`</${tag}>`, at) + tag.length + 3)
})
if (hero && defs.every(Boolean)) {
  const pen = /--pen:\s*(#[0-9a-f]+)/i.exec(naming)?.[1] ?? TOKENS.light['--urg-high']
  const box = /viewBox="([^"]+)"/.exec(hero)[1]
  const body = hero.replace(/^<svg[^>]*>/, '').replace(/<\/svg>$/, '').replace(/\s*\n\s*/g, '')
  const make = (ink, ring, size = '') => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${box}"${size} fill="none" stroke-linecap="round" stroke-linejoin="round" ${ink}><defs>${defs.join('').replace(/\s*\n\s*/g, '')}</defs>${body.replace(/ class="ink ring"/, ` ${ring}`).replace(/ class="ink"/g, '')}</svg>`
  const [, , bw, bh] = box.split(' ').map(Number)
  files.set('logo/trommi-handwritten.svg', make(`stroke="${TOKENS.light['--fg']}"`, `stroke="${pen}"`) + '\n')
  shown.push({ section: 'logo', group: 'Mark and name', file: 'logo/trommi-handwritten.svg', note: 'the name written by hand and circled (naming.html)', live: make('style="stroke:var(--fg)"', 'style="stroke:var(--urg-high)"', ` width="${num(bw * .8)}" height="${num(bh * .8)}"`), w: bw, h: bh, wide: true })
}

// The app icon the iOS client ships today (the client is parked): a picture, copied as it is.
const appIcon = path.join(root, 'client', 'ios', 'Trommi', 'Assets.xcassets', 'AppIcon.appiconset', 'icon-1024.png')
if (fs.existsSync(appIcon)) files.set('logo/app-icon-ios-shipped.png', fs.readFileSync(appIcon))

// -- session marks ---------------------------------------------------------------------------------------

const uiSrc = read('client/web/js/ui.js')
const KINDS = constOf(uiSrc, 'KINDS')
ui.DRAWINGS.forEach((name, i) => {
  const hue = HUES[i % HUES.length]
  add('marks', KINDS.includes(name) ? 'The eight families, by name' : 'Named drawings', `marks/mark-${name}.svg`, ui.doodle(ui.drawingMark(name)), {
    note: `doodle('${ui.drawingMark(name)}')`, hue, pad: 1, styles: { svg: { stroke: 'var(--ink)' } }, vars: { '--hue': hue },
  })
})

// A sheet of marks as sessions get them from their id alone: a few seeds for each family.
const WORDS = ['api', 'web-frontend', 'infrastructure', 'docs', 'ios-app', 'main', 'trommi', 'inbox', 'pad', 'server', 'linux', 'crypto', 'design', 'review', 'deploy', 'tests', 'billing', 'search', 'sync', 'speech', 'focus', 'keys', 'admin', 'assets', 'board', 'hub', 'relay', 'store', 'chat', 'release', 'backup', 'mail', 'metrics', 'login', 'payments', 'onboarding', 'landing', 'research', 'support', 'data']
const PER_FAMILY = 6
const families = KINDS.map(() => [])
for (let i = 0; families.some(f => f.length < PER_FAMILY) && i < 4000; i++) {
  const seed = WORDS[i] ?? `session-${i - WORDS.length + 1}`
  const family = families[Math.floor(ui.penSeed(seed)() * KINDS.length)]
  if (family.length < PER_FAMILY) family.push(seed)
}
const doodleStyle = { svg: { stroke: 'var(--ink)' } }
{
  const cell = 46, left = 70, top = 14, labelH = 13
  const w = left + PER_FAMILY * cell + 8, h = top + KINDS.length * (cell + labelH) + 4
  const text = (x, y, s, o = '') => `<text x="${num(x)}" y="${num(y)}" font-family="'IBM Plex Sans', system-ui, sans-serif" stroke="none" ${o}>${esc(s)}</text>`
  let body = `<rect width="${w}" height="${h}" fill="${TOKENS.light['--surface']}" stroke="none"/>`
  families.forEach((seeds, row) => {
    const y = top + row * (cell + labelH)
    body += text(10, y + 20, KINDS[row], `font-size="9" font-weight="600" fill="${TOKENS.light['--fg']}"`)
    seeds.forEach((seed, col) => {
      const node = ui.doodle(seed), hue = hueOf(seed), turn = parseFloat(node.style.rotate) || 0
      body += `<g transform="translate(${left + col * cell} ${y})" stroke="${resolve(INK.light, 'light', { '--hue': hue })}"><g transform="rotate(${turn} 16 16)">${inner(node, { theme: 'light' })}</g></g>`
      body += text(left + col * cell + 16, y + 40, seed.length > 9 ? `${seed.slice(0, 8)}…` : seed, `font-size="5.4" text-anchor="middle" fill="${TOKENS.light['--muted']}"`)
    })
  })
  files.set('marks/doodles-sheet.svg', `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" fill="none" stroke-width="${need('.doodle', 'stroke-width')}" stroke-linecap="round" stroke-linejoin="round">${body}</svg>\n`)
}

// Sessions scribbled together, and the loop round a group.
const member = (id, vip = false) => ({ id, mark: id, hue: hueOf(id), vip })
const pairO = { pad: 3, show: 3.4, styles: { g: { 'stroke-width': need('.pair-mark g', 'stroke-width') }, rect: { fill: 'none', stroke: 'none' }, 'pair-crown': { ...Object.fromEntries(SVG_PROPS.map(p => [p, rule('.pair-mark g .pair-crown')?.[p]])) } } }
add('marks', 'Together', 'marks/pair-two.svg', ui.pairDoodle([member('docs'), member('docs-review')]), { ...pairO, note: 'pairDoodle(): two sessions in one loop', wide: true })
add('marks', 'Together', 'marks/pair-three.svg', ui.pairDoodle([member('api', true), member('web-frontend'), member('infrastructure')]), { ...pairO, note: 'pairDoodle(): three, the first wears the crown', wide: true })
add('marks', 'Together', 'marks/group-loop.svg', ui.groupLoop('api+web-frontend+infrastructure'), { note: 'groupLoop(): stretched round a group', pad: 2, show: 1.6, wide: true, styles: { svg: { 'stroke-width': need('.pair-loop', 'stroke-width'), stroke: need('.pair-loop', 'stroke') }, path: { 'vector-effect': 'non-scaling-stroke' } } })

// -- icons -----------------------------------------------------------------------------------------------

// Every drawing sketch() knows, by the names in its table.
for (const name of Object.keys(constOf(uiSrc, 'SKETCH'))) {
  add('icons', 'Drawn by hand: sketch()', `icons/icon-${name}.svg`, ui.sketch(name), { note: `sketch('${name}')`, pad: 1 })
}
// Every other function of ui.js that draws one picture on its own (the crown, the hand, the advice mark …):
// found by trying, so a drawing added there tomorrow is here after the next build.
const BY_SEED = new Set(['doodle', 'sketch', 'pairDoodle', 'groupLoop'])
const drawn = {}
for (const [name, fn] of Object.entries(ui)) {
  if (typeof fn !== 'function' || BY_SEED.has(name) || fn.length > 0 || !/createElementNS/.test(String(fn))) continue
  try { const node = fn(); if (node?.tag === 'svg' && node.attrs.viewBox) drawn[name] = node } catch {}
}
const STRETCHED = { 'vector-effect': 'non-scaling-stroke' }
for (const [name, node] of Object.entries(drawn)) {
  const stretched = node.attrs.preserveAspectRatio === 'none'
  add('icons', 'Drawn by hand: marks of their own', `icons/icon-${kebab(name)}.svg`, node, {
    note: `${name}()`, pad: 2,
    ...(stretched ? { show: 1.5, wide: true, styles: { path: STRETCHED } } : {}),
    ...(stretched ? { liveText: svgText(node, { live: true, pad: 2, width: 200, height: 72, styles: { path: STRETCHED } }) } : {}),
  })
}

// The way back (back.js): the arrow of "Back" and the scribbled line that runs out under the note.
const backSrc = read('client/web/js/back.js')
for (const m of backSrc.matchAll(/svg\('([\w-]+)',\s*'([^']+)',\s*((?:'[^']+'(?:,\s*)?)+)\)/g)) {
  const paths = [...m[3].matchAll(/'([^']+)'/g)].map(x => x[1])
  const line = m[1] === 'back-line'
  add('icons', 'Drawn by hand: marks of their own', `icons/icon-${line ? 'underline' : m[1]}.svg`, fromPaths(m[1], m[2], paths), { note: `back.js, .${m[1]}`, pad: 1, wide: line, show: line ? 1.1 : undefined, styles: { svg: { opacity: null } } })
}
// The pad's control (padlink.js): a sheet with a scribble on it.
const padlinkSrc = read('client/web/js/padlink.js')
const scribble = constOf(padlinkSrc, 'SCRIBBLE')
if (scribble) add('icons', 'Drawn by hand: marks of their own', 'icons/icon-pad.svg', fromPaths('padlink-ico', '0 0 24 24', scribble), { note: 'padlink.js, the pad\'s control' })
// The loop that breathes round the microphone while dictating (speech.js).
const speechSrc = read('client/web/js/speech.js')
const ringCall = /svgEl\('path', \{ d: (loopPath\(.*\)) \}\)/.exec(speechSrc)?.[1]
if (ringCall) {
  const d = new Function('loopPath', 'penSeed', 'key', 'targets', `return ${ringCall}`)(ui.loopPath, ui.penSeed, null, [])
  const ring = fromPaths('dictate-ring', '0 0 32 32', d)
  const mic = ui.sketch('mic')
  // The microphone stands in the middle of the ring, at the size speech.css gives it.
  const micPx = parseFloat(need('.dictate-mic .sketch', 'width')), ringPx = 34, s = micPx / 24 * (32 / ringPx)
  const g = new Node('g')
  g.attrs.transform = `translate(${num(16 - 12 * s)} ${num(16 - 12 * s)}) scale(${num(s)}) rotate(${parseFloat(mic.style.rotate) || 0} 12 12)`
  g.attrs.class = 'dictate-mic-sketch'
  g.children = mic.children
  ring.append(g)
  add('icons', 'Drawn by hand: marks of their own', 'icons/icon-dictate.svg', ring, { note: 'speech.js: the ring round the microphone while it listens', pad: 2, styles: { 'dictate-mic-sketch': { fill: 'none', 'stroke-width': need('.dictate-mic .sketch', 'stroke-width') } } })
}
// The keys' arrow (keys.css): a mask written into the stylesheet as a data address.
const keysArrow = /--keys-arrow:\s*url\("data:image\/svg\+xml,([^"]+)"\)/.exec(fs.readFileSync(path.join(web, 'css', 'keys.css'), 'utf8'))?.[1]
if (keysArrow) {
  const markup = decodeURIComponent(keysArrow).replace(/'/g, '"')
  const node = fromMarkup(markup)
  add('icons', 'Drawn by hand: marks of their own', 'icons/icon-keys-arrow.svg', node, { note: 'keys.css, --keys-arrow', plain: true, styles: { svg: { ...PEN, 'stroke-width': node.attrs['stroke-width'] } } })
}

// The Focus window (focus.js): its line icons, the drawings it builds in place, the marks of its progress rail.
const focusSrc = read('client/web/js/focus.js')
for (const [name, d] of Object.entries(constOf(focusSrc, 'ICON') ?? {})) {
  add('icons', 'Line icons: the question window (focus.js)', `icons/icon-focus-${kebab(name)}.svg`, fromPaths('focus-icon', '0 0 24 24', d), { note: `focus.js, ICON.${name}` })
}
for (const m of focusSrc.matchAll(/const (\w+) = document\.createElementNS\(SVG_NS, 'svg'\)\s*\n\s*\1\.setAttribute\('viewBox', '([^']+)'\)\s*\n\s*\1\.setAttribute\('class', '([^']+)'\)[\s\S]{0,160}?for \(const d of (\[[^\]]+\])\)/g)) {
  add('icons', 'Line icons: the question window (focus.js)', `icons/icon-focus-${kebab(m[1])}.svg`, fromPaths(m[3], m[2], new Function(`return ${m[4]}`)()), { note: `focus.js, ${m[1]}` })
}
const railMark = functionOf(focusSrc, 'railMark', { penSeed: ui.penSeed, loopPath: ui.loopPath, document: globalThis.document, SVG_NS: 'http://www.w3.org/2000/svg' })
if (railMark) {
  const railO = { context: '.focus-rail-mark', pad: 2, styles: { svg: { 'stroke-width': need('.focus-rail-mark svg', 'stroke-width') }, 'focus-rail-ring': { stroke: 'currentColor' } } }
  for (const [name, call, note] of [['open', ['open', false], 'a question still open'], ['front', ['open', true], 'the question in front'], ['done', ['done', false], 'answered'], ['later', ['later', false], 'put off']]) {
    add('icons', 'Drawn by hand: the progress rail', `icons/icon-rail-${name}.svg`, railMark(...call, 'assets'), { ...railO, note: `focus.js, railMark('${call[0]}'${call[1] ? ', true' : ''}): ${note}` })
  }
}
// The line icons of the other parts: the conversation, the scribble pad in the page, the pad, the top bar.
for (const [file, cls, label, key] of [['client/web/js/chat.js', 'ico', 'the conversation (chat.js)', 'chat'], ['client/web/js/scribble.js', 'scr-icon', 'the scribble sheet (scribble.js)', 'scribble'], ['client/web/pad/pad.js', 'pad-icon', 'the pad (pad/pad.js)', 'pad']]) {
  for (const [name, paths] of Object.entries(constOf(read(file), 'ICONS') ?? {})) {
    add('icons', `Line icons: ${label}`, `icons/icon-${key}-${kebab(name)}.svg`, fromPaths(cls, '0 0 24 24', paths), { note: `${path.basename(file)}, ICONS['${name}']` })
  }
}
{
  const seen = new Set()
  for (const m of indexHtml.matchAll(/<svg class="(ico[^"]*)"[^>]*>[\s\S]*?<\/svg>/g)) {
    const before = indexHtml.slice(0, m.index)
    const id = m[1].includes('ico-') ? m[1].split('ico-')[1] : [...before.matchAll(/id="([\w-]+)"/g)].at(-1)?.[1] ?? 'mark'
    if (seen.has(id)) continue
    seen.add(id)
    const node = fromMarkup(m[0])
    node.attrs.class = 'ico'
    add('icons', 'Line icons: the top bar (index.html)', `icons/icon-bar-${kebab(id)}.svg`, node, { note: `index.html, #${id}` })
  }
}

// -- states: the badge at the end of a session's row -----------------------------------------------------
// (agents.js badge(): a hand in red when the session waits for you, a small stack of cards while it works with
// questions open; a session that is away shows nothing there, its mark turns grey.)
{
  const badgeSketch = rule('.agent-badge .sketch') ?? {}
  if (drawn.bareHand) add('states', 'The badge of a session row', 'states/state-waiting.svg', drawn.bareHand, {
    note: 'waiting for you: the hand, in red', pad: 2,
    text: svgText(drawn.bareHand, { pad: 2, styles: { svg: { stroke: need('.agent-badge[data-state="waiting"]', 'color') } } }),
    liveText: svgText(drawn.bareHand, { live: true, pad: 2, width: 49, height: 62, styles: { svg: { stroke: need('.agent-badge[data-state="waiting"]', 'color') } } }),
  })
  const stack = ui.sketch('stack')
  if (stack.children.length) add('states', 'The badge of a session row', 'states/state-working.svg', stack, {
    note: 'at work with questions open: a small stack of cards', pad: 1,
    text: svgText(stack, { pad: 1, styles: { svg: { stroke: need('.agent-badge[data-state="running"]', 'color'), 'stroke-width': badgeSketch['stroke-width'] } } }),
    liveText: svgText(stack, { live: true, pad: 1, width: 62, height: 62, styles: { svg: { stroke: need('.agent-badge[data-state="running"]', 'color'), 'stroke-width': badgeSketch['stroke-width'] } } }),
  })
  // A session that is not connected wears its own mark in grey.
  const offline = rule('.agent-avatar.is-offline')
  const mark = ui.doodle('draw:kite')
  const grey = hex(rgbOf(resolve(INK.light, 'light', { '--hue': HUES[0] })).map((_, i, c) => .2126 * c[0] + .7152 * c[1] + .0722 * c[2]))
  add('states', 'The mark of a session', 'states/state-mark-online.svg', mark, { note: 'connected: its mark in its colour', hue: HUES[0], pad: 1, styles: { svg: { stroke: 'var(--ink)' } }, vars: { '--hue': HUES[0] } })
  add('states', 'The mark of a session', 'states/state-mark-offline.svg', mark, {
    note: 'not connected: grey and faint', hue: HUES[0], pad: 1,
    text: svgText(mark, { pad: 1, styles: { svg: { stroke: grey } } }).replace('<svg ', `<svg opacity="${offline?.opacity ?? .6}" `),
    liveText: svgText(mark, { live: true, pad: 1, width: 68, height: 68, styles: { svg: { stroke: 'var(--ink)', filter: 'grayscale(1)', opacity: offline?.opacity ?? .6 } } }),
  })
}

// -- palette ---------------------------------------------------------------------------------------------

const tokensJson = {
  source: 'client/web/css/tokens.css',
  colours: Object.fromEntries(colourNames.map(k => [k.slice(2), { light: lightTokens[k], dark: darkTokens[k] }])),
  light: Object.fromEntries(Object.entries(lightTokens).map(([k, v]) => [k.slice(2), v])),
  dark: Object.fromEntries(Object.entries(darkTokens).map(([k, v]) => [k.slice(2), v])),
  sessions: { hues: HUES, ink: { light: INK.light.replace('var(--hue)', '<hue>'), dark: INK.dark.replace('var(--hue)', '<hue>') } },
}
files.set('palette/tokens.json', JSON.stringify(tokensJson, null, 2) + '\n')
const solid = colourNames.filter(k => lightTokens[k].startsWith('#'))
{
  const cols = 4, cw = 150, ch = 62, padX = 20, head = 44
  const rows = Math.ceil((solid.length + HUES.length) / cols)
  const panelW = padX * 2 + cols * cw, panelH = head + rows * ch + 16
  const text = (x, y, s, o) => `<text x="${x}" y="${y}" ${o}>${esc(s)}</text>`
  const panel = (theme, dx) => {
    const t = TOKENS[theme]
    let out = `<g transform="translate(${dx} 0)"><rect width="${panelW}" height="${panelH}" fill="${t['--bg']}"/>` + text(padX, 28, theme === 'light' ? 'Light' : 'Dark', `font-family="'Bricolage Grotesque', 'Segoe UI', sans-serif" font-weight="700" font-size="17" fill="${t['--fg']}"`)
    const cells = [...solid.map(k => [k.slice(2), t[k]]), ...HUES.map(h => [`session ${h}`, resolve(INK[theme], theme, { '--hue': h })])]
    cells.forEach(([name, value], i) => {
      const x = padX + (i % cols) * cw, y = head + Math.floor(i / cols) * ch
      out += `<rect x="${x}" y="${y}" width="34" height="34" rx="8" fill="${value}" stroke="${t['--line-strong']}"/>`
      out += text(x + 42, y + 15, name, `font-family="'IBM Plex Sans', system-ui, sans-serif" font-weight="600" font-size="10.5" fill="${t['--fg']}"`)
      out += text(x + 42, y + 29, value, `font-family="'IBM Plex Mono', ui-monospace, monospace" font-size="9.5" fill="${t['--muted']}"`)
    })
    return out + '</g>'
  }
  files.set('palette/swatches.svg', `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${panelW * 2} ${panelH}">${panel('light', 0)}${panel('dark', panelW)}</svg>\n`)
}

// ---- pictures: made with Chromium or taken from the app, never by this build itself ------------------------

/** PNGs made from an SVG of this folder (--render): [png, svg, width, height]. */
const RENDERS = [
  ['logo/trommi-mark-512.png', 'logo/trommi-mark.svg', 512, 512],
  ['logo/trommi-mark-1024.png', 'logo/trommi-mark.svg', 1024, 1024],
  ['logo/trommi-logo-512.png', 'logo/trommi-logo.svg', Math.round(512 * lockW / 32), 512],
  ['logo/trommi-logo-dark-512.png', 'logo/trommi-logo-dark.svg', Math.round(512 * lockW / 32), 512],
  ['logo/favicon-16.png', 'logo/favicon.svg', 16, 16],
  ['logo/favicon-32.png', 'logo/favicon.svg', 32, 32],
  ['logo/favicon-180.png', 'logo/app-icon.svg', 180, 180],
  ['logo/app-icon-192.png', 'logo/app-icon.svg', 192, 192],
  ['logo/app-icon-512.png', 'logo/app-icon.svg', 512, 512],
  ['logo/app-icon-1024.png', 'logo/app-icon.svg', 1024, 1024],
  ['logo/app-icon-maskable-512.png', 'logo/app-icon-maskable.svg', 512, 512],
  ['palette/swatches.png', 'palette/swatches.svg', null, null],
  ['marks/doodles-sheet.png', 'marks/doodles-sheet.svg', null, null],
]
/** Screenshots of the product (--screens): [png, what it shows]. */
const SCREENS = [
  ['screens/inbox-light.png', 'Inbox, light'], ['screens/inbox-dark.png', 'Inbox, dark'],
  ['screens/question-light.png', 'Question window, light'], ['screens/question-dark.png', 'Question window, dark'],
  ['screens/sidebar-light.png', 'Sessions in the sidebar, light'], ['screens/sidebar-dark.png', 'Sessions in the sidebar, dark'],
  ['screens/pad-light.png', 'Pad, light'], ['screens/pad-dark.png', 'Pad, dark'],
  ['screens/phone-inbox-light.png', 'Inbox on a phone, light'], ['screens/phone-question-dark.png', 'Question window on a phone, dark'],
]
const sha = data => crypto.createHash('sha256').update(data).digest('hex').slice(0, 16)
const onDisk = rel => { try { return fs.readFileSync(path.join(here, rel)) } catch { return null } }
const renderedFile = path.join(here, 'rendered.json')
const rendered = (() => { try { return JSON.parse(fs.readFileSync(renderedFile, 'utf8')) } catch { return {} } })()

if (flags.has('--render') || flags.has('--screens')) {
  for (const [rel, data] of files) { fs.mkdirSync(path.dirname(path.join(here, rel)), { recursive: true }); fs.writeFileSync(path.join(here, rel), data) }
  const { launchChromium } = await import(pathToFileURL(path.join(root, 'dev', 'cdp.mjs')).href)
  const sleep = ms => new Promise(r => setTimeout(r, ms))
  const browser = await launchChromium({ width: 1280, height: 800 })
  try {
    const page = await browser.page()
    await page.send('Page.enable')
    const evaluate = async expression => {
      const res = await page.send('Runtime.evaluate', { expression: `(async () => { ${expression} })()`, awaitPromise: true, returnByValue: true })
      if (res.exceptionDetails) throw new Error(res.exceptionDetails.exception?.description ?? res.exceptionDetails.text)
      return res.result?.value
    }
    const shoot = async (rel, clip) => {
      const shot = await page.send('Page.captureScreenshot', { format: 'png', ...(clip ? { clip: { ...clip, scale: 1 } } : {}) })
      fs.mkdirSync(path.dirname(path.join(here, rel)), { recursive: true })
      fs.writeFileSync(path.join(here, rel), Buffer.from(shot.data, 'base64'))
      console.log(`  ${rel}`)
    }
    if (flags.has('--render')) {
      await page.send('Emulation.setDefaultBackgroundColorOverride', { color: { r: 0, g: 0, b: 0, a: 0 } })
      for (const [png, svg, w, h] of RENDERS) {
        const text = files.get(svg)
        const [, , bw, bh] = /viewBox="([^"]+)"/.exec(text)[1].split(' ').map(Number)
        const width = w ?? bw * 2, height = h ?? bh * 2
        await page.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false })
        await page.send('Page.navigate', { url: `data:text/html;base64,${Buffer.from(`<!doctype html><style>html,body{margin:0;background:transparent}svg{display:block;width:${width}px;height:${height}px}</style>${text}`).toString('base64')}` })
        await sleep(500)
        await evaluate('await document.fonts.ready; return 1')
        if (svg === 'logo/trommi-logo.svg' && png.endsWith('-512.png')) {
          const em = await evaluate(`const t = document.querySelector('text'); return t.getComputedTextLength() / parseFloat(t.getAttribute('font-size'))`)
          const wanted = em - tracking * WORD.length
          if (Math.abs(wanted - WORD_EM) > .03) console.warn(`  the word runs ${wanted.toFixed(3)} em wide, assets/build.mjs says WORD_EM = ${WORD_EM}: correct it and build again`)
        }
        await shoot(png, { x: 0, y: 0, width, height })
        rendered[png] = { from: svg, sha: sha(text) }
      }
      await page.send('Emulation.setDefaultBackgroundColorOverride', {})
      // favicon.ico: the two small pictures in one file (an ICO may hold PNGs as they are).
      const pngs = [16, 32].map(n => [n, fs.readFileSync(path.join(here, `logo/favicon-${n}.png`))])
      const head = Buffer.alloc(6 + 16 * pngs.length)
      head.writeUInt16LE(1, 2); head.writeUInt16LE(pngs.length, 4)
      let at = head.length
      pngs.forEach(([n, png], i) => { const o = 6 + 16 * i; head[o] = n; head[o + 1] = n; head.writeUInt16LE(1, o + 4); head.writeUInt16LE(32, o + 6); head.writeUInt32LE(png.length, o + 8); head.writeUInt32LE(at, o + 12); at += png.length })
      fs.writeFileSync(path.join(here, 'logo/favicon.ico'), Buffer.concat([head, ...pngs.map(p => p[1])]))
      rendered['logo/favicon.ico'] = { from: 'logo/favicon.svg', sha: sha(files.get('logo/favicon.svg')) }
    }
    if (flags.has('--screens')) {
      const { takeScreens } = await import(pathToFileURL(path.join(here, 'screens.mjs')).href)
      const port = Number(process.argv.find(a => /^\d{4,5}$/.test(a))) || 8827
      await takeScreens({ page, evaluate, shoot, sleep, port, root })
      rendered.screens = { taken: new Date().toISOString().slice(0, 10) }
    }
  } finally {
    await browser.close()
  }
  fs.writeFileSync(renderedFile, JSON.stringify(rendered, null, 2) + '\n')
}

// ---- the gallery ---------------------------------------------------------------------------------------

function pngSize(buf) { return buf && buf.length > 24 ? [buf.readUInt32BE(16), buf.readUInt32BE(20)] : [0, 0] }
const kB = n => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} kB`)
const SECTIONS = [
  ['logo', 'Logo', 'The mark, the name, the app icon.'],
  ['marks', 'Session marks', 'Every session has a scribble of its own. Forty can be given by name; any other id draws one of eight families.'],
  ['icons', 'Icons', 'Small drawings of the interface. They are stroked in currentColor: they take the colour of the text they stand in.'],
  ['states', 'States', 'What a session row says at its end, and how a mark looks when its session is away.'],
  ['palette', 'Palette', 'The colour tokens of css/tokens.css. Dark is chosen by the user, never by the system.'],
  ['fonts', 'Type', 'Three families, all under the SIL Open Font License.'],
  ['screens', 'Screens', 'The product as it looks today, taken from a demo board.'],
]

function gallery({ embedPictures }) {
  const picture = rel => {
    const buf = files.get(rel) ?? onDisk(rel)
    if (!buf) return null
    const [w, h] = pngSize(buf)
    return { src: embedPictures ? `data:image/png;base64,${Buffer.from(buf).toString('base64')}` : rel, w, h, bytes: buf.length }
  }
  const name = rel => `<button type="button" class="name" data-copy="${esc(path.basename(rel))}" title="Copy the file name">${esc(path.basename(rel))}</button>`
  const tile = a => `<figure class="tile${a.wide ? ' is-wide' : ''}"${a.hue != null ? ` style="--hue:${a.hue}"` : ''}><div class="art${a.ground ? ` on-${a.ground}` : ''}">${a.live}</div><figcaption>${name(a.file)}${a.noSource ? '<span></span>' : `<button type="button" class="src" data-svg="${esc(a.file)}" title="Copy the SVG itself">SVG</button>`}<span class="meta">${num(a.w)} × ${num(a.h)}${a.note ? ` · ${esc(a.note)}` : ''}</span></figcaption></figure>`
  const pictureTile = (rel, note, cls = '') => {
    const p = picture(rel)
    if (!p) return `<figure class="tile is-missing"><div class="art">not rendered yet</div><figcaption>${name(rel)}<span class="meta">${esc(note)}</span></figcaption></figure>`
    return `<figure class="tile is-picture ${cls}"><a class="art" href="${p.src}" target="_blank" rel="noopener"><img src="${p.src}" alt="${esc(note)}" width="${p.w}" height="${p.h}" loading="lazy"></a><figcaption>${name(rel)}<span class="meta">${p.w} × ${p.h} · ${kB(p.bytes)} · ${esc(note)}</span></figcaption></figure>`
  }
  const groupsOf = section => {
    const groups = new Map()
    for (const a of shown.filter(a => a.section === section)) groups.set(a.group, [...(groups.get(a.group) ?? []), a])
    return [...groups].map(([title, list]) => `<h3>${esc(title)} <span>${list.length}</span></h3><div class="grid">${list.map(tile).join('')}</div>`).join('')
  }
  const body = {
    logo: () => groupsOf('logo') + `<h3>As pictures</h3><div class="grid">${[
      ['logo/trommi-mark-512.png', 'the mark'], ['logo/trommi-mark-1024.png', 'the mark'], ['logo/trommi-logo-512.png', 'mark and name', 'on-light'], ['logo/trommi-logo-dark-512.png', 'mark and name, for dark ground', 'on-dark'],
      ['logo/favicon-16.png', 'the favicon at 16 px: the Z alone'], ['logo/favicon-32.png', 'the favicon at 32 px'], ['logo/favicon-180.png', 'touch icon'],
      ['logo/app-icon-192.png', 'app icon, web manifest'], ['logo/app-icon-512.png', 'app icon, web manifest'], ['logo/app-icon-1024.png', 'app icon, the source for iOS'], ['logo/app-icon-maskable-512.png', 'app icon, maskable'],
      ['logo/app-icon-ios-shipped.png', 'what the parked iOS client still ships'],
    ].map(p => pictureTile(...p)).join('')}</div>`,
    marks: () => groupsOf('marks') + `<h3>From a session's id alone <span>${families.flat().length}</span></h3><p class="lead">${name('marks/doodles-sheet.svg')} ${name('marks/doodles-sheet.png')} hold this sheet: ${PER_FAMILY} ids for each of the ${KINDS.length} families, each in the colour its id gives it.</p>` +
      families.map((seeds, i) => `<div class="family"><b>${esc(KINDS[i])}</b>${seeds.map(seed => `<span class="seed" style="--hue:${hueOf(seed)}">${svgText(ui.doodle(seed), { live: true, width: 44, height: 44, pad: 1, styles: doodleStyle })}<i>${esc(seed)}</i></span>`).join('')}</div>`).join(''),
    icons: () => groupsOf('icons'),
    states: () => groupsOf('states'),
    palette: () => `<p class="lead">${name('palette/tokens.json')} ${name('palette/swatches.svg')} ${name('palette/swatches.png')}</p>` + ['light', 'dark'].map(theme => `<h3>${theme === 'light' ? 'Light' : 'Dark'}</h3><div class="swatches" data-theme-panel="${theme}">${[
      ...colourNames.map(k => [k, TOKENS[theme][k]]), ...HUES.map(h => [`session ${h}`, resolve(INK[theme], theme, { '--hue': h })]),
    ].map(([k, v]) => `<button type="button" class="swatch" data-copy="${esc(v)}" title="Copy ${esc(v)}"><i style="background:${esc(v)}"></i><b>${esc(k.replace(/^--/, ''))}</b><span>${esc(v)}</span></button>`).join('')}</div>`).join(''),
    fonts: () => {
      const list = fs.existsSync(path.join(here, 'fonts')) ? fs.readdirSync(path.join(here, 'fonts')).sort() : []
      const specimen = (family, css, sample, weights) => `<div class="specimen"><p class="caps">${esc(family)} · ${esc(weights)}</p><p style="font:${css}">${esc(sample)}</p></div>`
      return specimen('Bricolage Grotesque', '800 2.4rem/1.1 var(--display)', 'Trommi asks, you answer.', 'display, 600 to 800') +
        specimen('IBM Plex Sans', '400 1.15rem/1.5 var(--font)', 'Every session raises its hand when it needs you, and goes on working when it does not.', 'text, 400 to 600') +
        specimen('IBM Plex Mono', '400 1rem/1.5 var(--mono)', 'node assets/build.mjs --check', 'code, 400 and 500') +
        `<p class="lead">${list.length ? list.map(f => name(`fonts/${f}`)).join(' ') : 'No font files here yet: see fonts/README.md for what to fetch.'}</p>`
    },
    screens: () => `<div class="grid screens">${SCREENS.map(([rel, note]) => pictureTile(rel, note, /phone|sidebar/.test(rel) ? 'is-tall' : '')).join('')}</div>`,
  }
  const count = section => shown.filter(a => a.section === section).length
  const fonts = haveFonts ? [face('Bricolage Grotesque', 'BricolageGrotesque-latin-variable.woff2', '200 800'), face('IBM Plex Sans', 'IBMPlexSans-latin-variable.woff2', '100 700'), face('IBM Plex Mono', 'IBMPlexMono-latin-400.woff2', 400), face('IBM Plex Mono', 'IBMPlexMono-latin-500.woff2', 500)].join('\n') : ''
  const vars = t => Object.entries(t).map(([k, v]) => `${k}:${v}`).join(';')
  const sources = Object.fromEntries(shown.filter(a => !a.noSource).map(a => [a.file, String(files.get(a.file)).trim()]))
  const sl = s => s.replace(/^hsl\(var\(--hue\)\s*/, '').replace(/\)$/, '')
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Trommi assets</title>
<!-- Written by assets/build.mjs. Do not edit: change the sources and run  node assets/build.mjs -->
<style>
${fonts}
:root{${vars(lightTokens)};--ink-sl:${sl(INK.light)}}
.tile,.seed{--ink:hsl(var(--hue,${HUES[0]}) var(--ink-sl))}
:root[data-theme="dark"]{${vars(tokenBlock(':root[data-theme="dark"]'))};--ink-sl:${sl(INK.dark)}}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--bg);color:var(--fg);font:400 var(--t-md)/1.5 var(--font)}
button{font:inherit;color:inherit;background:none;border:0;padding:0;cursor:pointer}
.top{position:sticky;top:0;z-index:5;display:flex;align-items:center;gap:var(--s-4);padding:10px var(--s-5);background:color-mix(in srgb,var(--bg) 88%,transparent);backdrop-filter:blur(10px);border-bottom:1px solid var(--line)}
.top h1{margin:0;margin-right:auto;font:800 1.15rem/1 var(--display);letter-spacing:-.012em;white-space:nowrap}
.top nav{display:flex;gap:2px;overflow-x:auto;min-width:0}
.top nav a{padding:6px 10px;border-radius:var(--r-pill);color:var(--muted);text-decoration:none;font-size:var(--t-sm);font-weight:500;white-space:nowrap}
.top nav a:hover{background:var(--sunken);color:var(--fg)}
#theme{flex:none;padding:7px 14px;border-radius:var(--r-pill);box-shadow:0 0 0 1px var(--line-strong);font-size:var(--t-sm);font-weight:600;white-space:nowrap}
#theme:hover{background:var(--sunken)}
main{max-width:1240px;margin:0 auto;padding:var(--s-6) var(--s-5) 96px}
.intro{max-width:62ch;color:var(--muted);margin:0 0 var(--s-8)}
.intro code,.lead code{font:400 .92em var(--mono);color:var(--fg)}
section{margin-bottom:56px;scroll-margin-top:64px}
h2{margin:0;font:800 var(--t-2xl)/1.1 var(--display);letter-spacing:-.02em}
h2 span,h3 span{font:500 var(--t-sm)/1 var(--mono);color:var(--faint);letter-spacing:0;margin-left:6px}
h2+p{margin:6px 0 0;max-width:68ch;color:var(--muted)}
h3{margin:var(--s-8) 0 var(--s-3);font:600 var(--t-xs)/1 var(--font);letter-spacing:.07em;text-transform:uppercase;color:var(--muted)}
.lead{margin:var(--s-3) 0;color:var(--muted);display:flex;flex-wrap:wrap;gap:6px 10px;align-items:baseline}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(148px,1fr));gap:var(--s-3)}
.tile{margin:0;min-width:0;display:flex;flex-direction:column;background:var(--surface);border-radius:var(--r-md);box-shadow:0 0 0 1px var(--line);overflow:hidden}
.tile.is-wide{grid-column:span 2}
.art{flex:1;min-height:104px;display:grid;place-items:center;padding:18px 12px;color:var(--fg);overflow:hidden}
.art svg{display:block;max-width:100%;overflow:visible}
.is-wide .art svg{height:auto}
.art.on-dark,.tile.on-dark .art{background:${darkTokens['--bg']}}
.art.on-light,.tile.on-light .art{background:${lightTokens['--surface']}}
.tile[style*="--hue"] .art{color:var(--ink)}
figcaption{display:grid;grid-template-columns:1fr auto;gap:2px 8px;align-items:start;padding:9px 11px 10px;border-top:1px solid var(--line);background:var(--surface-2)}
.name{min-width:0;text-align:left;font:500 .78rem/1.3 var(--mono);overflow-wrap:anywhere;border-radius:4px}
.name:hover,.src:hover{color:var(--accent)}
.name:focus-visible,.src:focus-visible,.swatch:focus-visible,#theme:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
.lead .name{padding:3px 8px;border-radius:var(--r-pill);background:var(--surface);box-shadow:0 0 0 1px var(--line-strong);color:var(--fg)}
.src{font:600 .66rem/1 var(--font);letter-spacing:.07em;color:var(--faint);padding:4px 0 4px 4px}
.meta{grid-column:1/-1;font-size:.72rem;line-height:1.35;color:var(--faint);overflow-wrap:anywhere}
.is-picture .art{padding:10px;background:var(--sunken)}
.is-picture img{display:block;max-width:100%;max-height:150px;width:auto;height:auto;border-radius:4px}
.is-missing .art{color:var(--faint);font-size:var(--t-sm)}
.screens{grid-template-columns:repeat(auto-fill,minmax(300px,1fr));align-items:start}
.screens .art{padding:0}
.screens img{max-height:none;width:100%;border-radius:0}
.screens .is-tall img{width:auto;max-height:360px;margin:12px auto;border-radius:6px}
.family{display:flex;align-items:center;gap:var(--s-2);padding:6px 0;border-bottom:1px solid var(--line)}
.family b{flex:none;width:64px;font:600 var(--t-sm)/1 var(--font)}
.family{flex-wrap:wrap}
.seed{display:grid;justify-items:center;gap:2px;width:84px;padding:6px 2px;color:var(--ink)}
.seed i{font:400 .68rem/1.2 var(--mono);color:var(--faint);max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.swatches{display:grid;grid-template-columns:repeat(auto-fill,minmax(168px,1fr));gap:var(--s-2)}
.swatch{display:grid;grid-template-columns:36px 1fr;column-gap:10px;align-items:center;text-align:left;padding:8px;border-radius:var(--r-sm);background:var(--surface);box-shadow:0 0 0 1px var(--line);min-width:0}
.swatch:hover{box-shadow:0 0 0 1px var(--fg)}
.swatch i{grid-row:span 2;width:36px;height:36px;border-radius:8px;box-shadow:inset 0 0 0 1px rgb(128 128 128 / .35)}
.swatch b{font:600 .8rem/1.2 var(--font);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.swatch span{font:400 .7rem/1.2 var(--mono);color:var(--muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.specimen{padding:var(--s-4) 0;border-bottom:1px solid var(--line)}
.specimen p{margin:0}
.caps{font:600 var(--t-xs)/1 var(--font);letter-spacing:.07em;text-transform:uppercase;color:var(--faint);margin-bottom:8px!important}
#said{position:fixed;left:50%;bottom:24px;translate:-50% 20px;padding:9px 16px;border-radius:var(--r-pill);background:var(--fg);color:var(--bg);font-size:var(--t-sm);font-weight:500;opacity:0;pointer-events:none;transition:opacity var(--d-fast),translate var(--d-med) var(--ease-out);max-width:calc(100vw - 32px);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
#said.is-on{opacity:1;translate:-50% 0}
@media (max-width:640px){
  .top{padding:8px var(--s-4);flex-wrap:wrap;gap:6px var(--s-3)}
  .top nav{order:3;width:100%;margin:0 -6px}
  main{padding:var(--s-5) var(--s-4) 80px}
  .grid{grid-template-columns:repeat(2,minmax(0,1fr))}
  .screens{grid-template-columns:1fr}
  .seed{width:25%}
  .family b{width:100%;padding-top:6px}
  .swatches{grid-template-columns:repeat(2,minmax(0,1fr))}
}
@media (prefers-reduced-motion:reduce){#said{transition:none}}
</style>
</head>
<body>
<header class="top">
  <h1>Trommi assets</h1>
  <nav aria-label="Sections">${SECTIONS.map(([id, title]) => `<a href="#${id}">${title}</a>`).join('')}</nav>
  <button type="button" id="theme" aria-pressed="false">Dark</button>
</header>
<main>
<p class="intro">Everything Trommi draws, as files in <code>assets/</code>. The drawings are made from the app's own code by <code>node assets/build.mjs</code>, so this page shows what the app shows. A click on a name copies it; <b>SVG</b> copies the drawing itself.</p>
${SECTIONS.map(([id, title, lead]) => `<section id="${id}"><h2>${title}${count(id) ? ` <span>${count(id)}</span>` : ''}</h2><p>${lead}</p>${body[id]()}</section>`).join('\n')}
</main>
<p id="said" role="status" aria-live="polite"></p>
<script type="application/json" id="sources">${JSON.stringify(sources).replace(/</g, '\\u003c')}</script>
<script>
const root = document.documentElement, theme = document.getElementById('theme'), said = document.getElementById('said')
const sources = JSON.parse(document.getElementById('sources').textContent)
function setTheme(dark) {
  if (dark) root.dataset.theme = 'dark'; else delete root.dataset.theme
  theme.textContent = dark ? 'Light' : 'Dark'
  theme.setAttribute('aria-pressed', String(dark))
}
setTheme(/[#,]dark\\b/.test(location.hash))
theme.addEventListener('click', () => setTheme(root.dataset.theme !== 'dark'))
let timer
async function copy(text, what) {
  try { await navigator.clipboard.writeText(text) }
  catch {
    const t = document.createElement('textarea')
    t.value = text; t.style.position = 'fixed'; t.style.opacity = '0'
    document.body.append(t); t.select()
    try { document.execCommand('copy') } catch {}
    t.remove()
  }
  said.textContent = 'Copied ' + what
  said.classList.add('is-on')
  clearTimeout(timer)
  timer = setTimeout(() => said.classList.remove('is-on'), 1600)
}
document.addEventListener('click', e => {
  const name = e.target.closest('[data-copy]'), src = e.target.closest('[data-svg]')
  if (name) copy(name.dataset.copy, name.dataset.copy)
  else if (src) copy(sources[src.dataset.svg], 'the SVG of ' + src.dataset.svg.split('/').pop())
})
</script>
</body>
</html>
`
}

files.set('index.html', gallery({ embedPictures: false }))
/** Outside assets/: the board serves only client/web, and follows no link out of it, so the gallery stands
 *  there once more as one page that needs no other file. */
const outside = new Map([[path.join(web, 'designs', 'assets.html'), gallery({ embedPictures: true })], ...patched])

// ---- write, or check --------------------------------------------------------------------------------------

const GENERATED_DIRS = ['logo', 'marks', 'icons', 'states', 'palette']
const kept = new Set([...files.keys(), ...RENDERS.map(r => r[0]), 'logo/favicon.ico'])
const leftover = GENERATED_DIRS.flatMap(dir => { try { return fs.readdirSync(path.join(here, dir)).map(f => `${dir}/${f}`) } catch { return [] } }).filter(rel => !kept.has(rel))
const same = (a, b) => b != null && Buffer.compare(Buffer.from(a), b) === 0
const stale = [...files].filter(([rel, data]) => !same(data, onDisk(rel))).map(([rel]) => `assets/${rel}`)
for (const [abs, data] of outside) if (!same(data, (() => { try { return fs.readFileSync(abs) } catch { return null } })())) stale.push(path.relative(root, abs))
const pictures = []
for (const [png, svg] of RENDERS) {
  if (!onDisk(png)) pictures.push(`assets/${png} is missing`)
  else if (rendered[png]?.sha !== sha(files.get(svg))) pictures.push(`assets/${png} was rendered from an older ${svg}`)
}
for (const [png] of SCREENS) if (!onDisk(png)) pictures.push(`assets/${png} is missing`)

if (CHECK) {
  for (const f of stale) console.log(`out of date: ${f}`)
  for (const f of leftover) console.log(`left over:   assets/${f}`)
  for (const p of pictures) console.log(`picture:     ${p}`)
  const bad = stale.length + leftover.length + pictures.length
  console.log(bad ? `assets/ is out of date (${bad}). Run: node assets/build.mjs${pictures.length ? ' --render' : ''}` : `assets/ is up to date: ${files.size} files from code, ${RENDERS.length + SCREENS.length} pictures.`)
  process.exit(bad ? 1 : 0)
}
for (const [rel, data] of files) {
  fs.mkdirSync(path.dirname(path.join(here, rel)), { recursive: true })
  if (!same(data, onDisk(rel))) fs.writeFileSync(path.join(here, rel), data)
}
for (const [abs, data] of outside) if (!same(data, (() => { try { return fs.readFileSync(abs) } catch { return null } })())) fs.writeFileSync(abs, data)
for (const rel of leftover) fs.rmSync(path.join(here, rel))
const per = dir => [...files.keys()].filter(f => f.startsWith(`${dir}/`)).length
console.log(`assets/: ${files.size} files from code (${GENERATED_DIRS.map(d => `${d} ${per(d)}`).join(', ')}), ${stale.length} rewritten, ${leftover.length} removed.`)
for (const p of pictures) console.log(`picture: ${p} (node assets/build.mjs --render${p.includes('screens/') ? ' --screens' : ''})`)
process.exit(0)
