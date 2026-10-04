// Which stylesheets apply: a view names its sheets (layout.mjs CSS), every other sheet is off, as on the hub's pages
// that linked only theirs. The source shell (public/index.html) links each sheet on its own (<link data-sheet>), and
// switching one off disables its <link>. The deployed shell has one bundle (dev/build.mjs, <link data-bundle>) in which
// each sheet a view may switch off is wrapped as @supports (--sheet: name) { @media all { … } }; switching it off sets
// that @media to "not all": its rules are gone at the same place in the cascade, the same as a disabled <link>.
// Sheets that are on in every view (dev/build.mjs ALWAYS) are not wrapped and cannot be switched off in the bundle.
let want = new Set()
const wrapped = new WeakMap()   // CSSStyleSheet -> Map(name -> CSSMediaRule)
const waiting = new WeakSet()   // bundle <link>s not loaded yet: applied on load

function wrappers(sheet) {
  let map = wrapped.get(sheet)
  if (!map) {
    map = new Map()
    for (const rule of sheet.cssRules) {
      const name = rule instanceof CSSSupportsRule && /--sheet:\s*([\w-]+)/.exec(rule.conditionText)?.[1]
      if (name && rule.cssRules[0] instanceof CSSMediaRule) map.set(name, rule.cssRules[0])
    }
    wrapped.set(sheet, map)
  }
  return map
}

function applyBundle(link) {
  let sheet = null
  try { sheet = link.sheet?.cssRules && link.sheet } catch {}
  if (!sheet) {
    if (!waiting.has(link)) { waiting.add(link); link.addEventListener('load', () => { waiting.delete(link); applyBundle(link) }, { once: true }) }
    return
  }
  for (const [name, media] of wrappers(sheet)) {
    const text = want.has(name) ? 'all' : 'not all'
    if (media.media.mediaText !== text) media.media.mediaText = text
  }
}

/** Turn on exactly these sheets (names as in data-sheet: 'tokens', 'app', …). */
export function useSheets(names) {
  want = new Set(names)
  for (const link of document.querySelectorAll('link[rel="stylesheet"][data-sheet]')) {
    const on = want.has(link.dataset.sheet)
    if (link.disabled === on) link.disabled = !on
  }
  for (const link of document.querySelectorAll('link[rel="stylesheet"][data-bundle]')) applyBundle(link)
}
