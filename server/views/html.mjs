// The one escaping helper of the server-rendered board (docs/turbo.md).
//
//   html`<p title="${card.title}">${card.body}</p>`
//
// Every value put into the template is escaped, for text and for a quoted attribute alike. What is already
// markup is said so by being a Safe: the result of another html`` template, or raw('…') for a string this
// code made itself (an SVG from the pen, a stream wrapper). Board content (titles, texts, labels, names,
// anything an agent or the human wrote) never goes through raw().
// A list is its items one after the other; null, undefined and false are nothing.

const ENT = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }
export const esc = value => String(value ?? '').replace(/[&<>"']/g, ch => ENT[ch])

class Safe {
  constructor(text) { this.text = text }
  toString() { return this.text }
}
export const raw = text => new Safe(String(text ?? ''))
export const isSafe = value => value instanceof Safe

const put = value => {
  if (value == null || value === false || value === true) return ''
  if (value instanceof Safe) return value.text
  if (Array.isArray(value)) return value.map(put).join('')
  return esc(value)
}

export function html(strings, ...values) {
  let out = strings[0]
  for (let i = 0; i < values.length; i++) out += put(values[i]) + strings[i + 1]
  return new Safe(out)
}

/** Attributes from an object: { class: 'a', hidden: true, title: null } -> ` class="a" hidden`. */
export const attrs = map => raw(Object.entries(map).map(([name, value]) => (value == null || value === false ? '' : value === true ? ` ${name}` : ` ${name}="${esc(value)}"`)).join(''))
