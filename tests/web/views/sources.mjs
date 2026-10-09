// sources.mjs: reading the views' sources (app/web/public/*.mjs, demo/demo.mjs) and the core's (app/web/core/*.ts)
// as text, for the contract test. No parser: a scanner that blanks comments and the text of strings (so a name in a
// comment or a label is never taken for code), brace matching for "the block this stands in", and a few regular
// expressions over what is left.
//
// What this cannot see, by its nature: a property reached through a computed name (`client[name]`), a value that
// travels through a variable the patterns here do not follow (a client handed to a function under another name, an
// object built first and passed later), a spread (`...content`), and which of two same-named variables in nested
// scopes is meant. contract.test.mjs says which patterns it follows.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
export const PUBLIC = path.join(REPO, 'app/web/public')
export const CORE = path.join(REPO, 'app/web/core')

/** The views: every module of the app's page, and the demo room. `name` is relative to app/web/public. */
export function viewSources() {
  const names = [...fs.readdirSync(PUBLIC).filter(f => f.endsWith('.mjs')).sort(), 'demo/demo.mjs']
  return names.map(name => { const text = fs.readFileSync(path.join(PUBLIC, name), 'utf8'); return { name, text, code: codeOf(text) } })
}

const REGEX_BEFORE = /(?:^|[(,=:[!&|?{};+\-*%<>~^]|\breturn|\btypeof|\bcase|\bof|\bin|=>)\s*$/
/**
 * The source with everything that is not code blanked, position for position: comments, the text of strings and of
 * template literals (their `${…}` expressions stay), the body of regular expression literals.
 */
export function codeOf(text) {
  const out = text.split('')
  const blank = (from, to) => { for (let i = from; i < to; i++) if (out[i] !== '\n') out[i] = ' ' }
  const stack = []   // open template literals: the brace depth at which each `${` was opened
  let depth = 0
  for (let i = 0; i < text.length;) {
    const ch = text[i], next = text[i + 1]
    if (ch === '/' && next === '/') { const end = text.indexOf('\n', i); const to = end < 0 ? text.length : end; blank(i, to); i = to; continue }
    if (ch === '/' && next === '*') { const end = text.indexOf('*/', i + 2); const to = end < 0 ? text.length : end + 2; blank(i, to); i = to; continue }
    if (ch === '\'' || ch === '"') {
      let j = i + 1
      while (j < text.length && text[j] !== ch && text[j] !== '\n') j += text[j] === '\\' ? 2 : 1
      blank(i + 1, j); i = j + 1; continue
    }
    if (ch === '`' || (ch === '}' && stack.length && stack.at(-1) === depth)) {
      // the text of a template literal, from its start or from the end of one of its expressions
      if (ch === '}') stack.pop()
      let j = i + 1
      for (; j < text.length; j++) {
        if (text[j] === '\\') { j++; continue }
        if (text[j] === '`') break
        if (text[j] === '$' && text[j + 1] === '{') { stack.push(depth); break }
      }
      blank(i + 1, j)
      i = text[j] === '`' ? j + 1 : j + 2
      continue
    }
    if (ch === '/' && REGEX_BEFORE.test(text.slice(Math.max(0, i - 12), i))) {
      let j = i + 1, inClass = false
      for (; j < text.length && text[j] !== '\n'; j++) {
        if (text[j] === '\\') { j++; continue }
        if (text[j] === '[') inClass = true
        else if (text[j] === ']') inClass = false
        else if (text[j] === '/' && !inClass) break
      }
      if (text[j] === '/') { blank(i + 1, j); i = j + 1; continue }
    }
    if (ch === '{') depth++
    else if (ch === '}') depth--
    i++
  }
  return out.join('')
}

const OPEN = '{([', CLOSE = '})]'
/** The index of the bracket that closes the one at `at`. */
export function closing(code, at) {
  let depth = 0
  for (let i = at; i < code.length; i++) {
    if (OPEN.includes(code[i])) depth++
    else if (CLOSE.includes(code[i]) && --depth === 0) return i
  }
  return code.length
}
/** [start, end) of the innermost `{ … }` block around `at` (the whole file when there is none). */
export function blockAround(code, at) {
  let depth = 0
  for (let i = at - 1; i >= 0; i--) {
    if (code[i] === '}') depth++
    else if (code[i] === '{') { if (depth === 0) return [i, closing(code, i) + 1]; depth-- }
  }
  return [0, code.length]
}
/** The parts of a bracketed list split at its top-level commas: `at` is the opening bracket. */
export function listParts(code, at) {
  const end = closing(code, at), parts = []
  let depth = 0, from = at + 1
  for (let i = at + 1; i < end; i++) {
    if (OPEN.includes(code[i])) depth++
    else if (CLOSE.includes(code[i])) depth--
    else if (code[i] === ',' && depth === 0) { parts.push([from, i]); from = i + 1 }
  }
  if (code.slice(from, end).trim()) parts.push([from, end])
  return parts
}
/** The top-level keys of an object literal or a destructuring pattern that opens at `at`; `rest`: it has a `...x`. */
export function keysOf(code, at) {
  const keys = []
  let rest = false, computed = false
  for (const [from, to] of listParts(code, at)) {
    const part = code.slice(from, to).trim()
    if (part.startsWith('...')) { rest = true; continue }
    if (part.startsWith('[')) { computed = true; continue }
    const m = /^(?:async\s+)?([A-Za-z_$][\w$]*)/.exec(part)
    if (m) keys.push(m[1])
  }
  return { keys, rest, computed }
}
export const lineOf = (text, at) => text.slice(0, at).split('\n').length

/** The fields an `export interface` of a TypeScript source names, by interface, those of what it extends included
 *  (`required`: its own that are not optional). `open`: it also has an index signature (`[field: string]: …`), so
 *  it may carry more. */
export function interfacesOf(file) {
  const text = fs.readFileSync(file, 'utf8'), code = codeOf(text), out = new Map()
  for (const m of code.matchAll(/export interface (\w+)(?: extends (\w+))? \{/g)) {
    const at = m.index + m[0].length - 1, end = closing(code, at), fields = [], required = []
    let open = false, depth = 0, lineStart = true
    for (let i = at + 1; i < end; i++) {
      const ch = code[i]
      if (depth === 0 && lineStart) {
        const rest = code.slice(i, end)
        const f = /^\s*(\w+)(\??):/.exec(rest)
        if (f) { fields.push(f[1]); if (!f[2]) required.push(f[1]) }
        else if (/^\s*\[\w+: string\]:/.test(rest)) open = true
        lineStart = false
      }
      if (OPEN.includes(ch)) depth++
      else if (CLOSE.includes(ch)) depth--
      else if ((ch === '\n' || ch === ';') && depth === 0) lineStart = true
    }
    out.set(m[1], { fields, required, open, parent: m[2] ?? null })
  }
  for (const v of out.values()) for (let p = v.parent; p; p = out.get(p)?.parent) { v.fields.push(...(out.get(p)?.fields ?? [])); v.open ||= Boolean(out.get(p)?.open) }
  // (a field the interface names again is the interface's: Session narrows what Linked leaves optional)
  return out
}

/** The parameters of a class's methods as its source declares them: name -> [{ keys, rest } | { name }] per
 *  parameter (a destructured one gives its keys). Arrow-valued and one-line methods included. */
export function methodParams(file, className) {
  const text = fs.readFileSync(file, 'utf8'), code = codeOf(text)
  const start = code.search(new RegExp(`export class ${className}\\b`))
  if (start < 0) throw new Error(`${file} has no class ${className}`)
  const open = code.indexOf('{', start), end = closing(code, open), out = new Map()
  let depth = 0
  for (let i = open + 1; i < end; i++) {
    const ch = code[i]
    if (depth === 0 && (i === open + 1 || code[i - 1] === '\n')) {
      const m = /^\s*(?:private\s+|readonly\s+|static\s+)*(?:async\s+)?(?:get\s+)?([A-Za-z_$][\w$]*)\s*\(/.exec(code.slice(i, i + 200))
      if (m && !/^\s*(?:private)\b/.test(code.slice(i, i + 40))) {
        const paren = i + m[0].length - 1
        out.set(m[1], listParts(code, paren).map(([from, to]) => {
          const at = from + code.slice(from, to).search(/\S/)
          if (code[at] === '{') { const { keys, rest } = keysOf(code, at); return { keys, rest } }
          return { name: /^[\w$]+/.exec(code.slice(at, to))?.[0] ?? '' }
        }))
      }
    }
    if (OPEN.includes(ch)) depth++
    else if (CLOSE.includes(ch)) depth--
  }
  return out
}
