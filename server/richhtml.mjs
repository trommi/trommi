// HTML an agent sends along with a message or a question (the field html, or a block fenced as
// ```html inside a text). It is stored already cleaned: nothing that runs, loads or navigates.
// The board shows it in a sandboxed frame without an origin and without network (client/web/js/
// richhtml.js), and that frame is what really holds; this cleaning keeps the stored content honest
// and tells the agent what it lost.

/** The most one block may weigh, in bytes of UTF-8. */
export const HTML_MAX = Number(process.env.BOARD_MAX_HTML_KB || 200) * 1024

// Elements that run code, load something, embed another document or send something away: gone with
// their content. Void ones (and anything left unclosed) go as a tag alone.
const PAIRED = ['script', 'iframe', 'frame', 'frameset', 'object', 'embed', 'applet', 'noscript', 'template', 'audio', 'video', 'portal']
const SINGLE = ['script', 'meta', 'link', 'base', 'iframe', 'frame', 'frameset', 'object', 'embed', 'applet', 'source', 'track', 'param', 'portal', 'audio', 'video', 'noscript', 'template']
// A form cannot be sent from the frame anyway; its tags go, what stands inside stays.
const UNWRAPPED = ['form']

// What the last cleaning took out, for the answer to the tool call.
let taken = new Map()
const took = (what, n = 1) => { if (n) taken.set(what, (taken.get(what) ?? 0) + n) }

/** A sentence naming what was removed since the last call, or ''. */
export function strippedHint() {
  if (!taken.size) return ''
  const said = [...taken].map(([what, n]) => (n > 1 ? `${what} (${n})` : what)).join(', ')
  taken = new Map()
  return `\nRemoved from your html, because the board shows it without scripts and without network: ${said}. Send semantic HTML with inline CSS; pictures as data: URLs or as attachments; for a page that must run, use publish_asset.`
}

// An attribute value as the browser reads it: character references resolved, blanks and control characters gone.
const plainOf = value => value
  .replace(/&#x([0-9a-f]+);?/gi, (_, h) => String.fromCodePoint(Math.min(parseInt(h, 16), 0x10ffff)))
  .replace(/&#(\d+);?/g, (_, d) => String.fromCodePoint(Math.min(Number(d), 0x10ffff)))
  .replace(/&colon;?/gi, ':').replace(/&(tab|newline);?/gi, '').replace(/[\s\u0000-\u001f]/g, '')
const count = (text, re) => (text.match(re) ?? []).length

/** The block as it is stored: without scripts, handlers, frames, forms, and without any address that would be fetched. */
export function cleanHtml(source, what = 'html') {
  let html = String(source ?? '').replace(/\r\n?/g, '\n').replace(/\u0000/g, '').trim()
  if (Buffer.byteLength(html) > HTML_MAX) {
    throw new Error(`${what} is ${Math.ceil(Buffer.byteLength(html) / 1024)} KB; one block may have at most ${HTML_MAX / 1024} KB. Shorten it (pictures as attachments instead of data: URLs), or publish a whole page with publish_asset and link it`)
  }
  // Until nothing changes: what is removed must not leave something behind that reads as a tag again.
  for (let round = 0, before = null; before !== html && round < 8; round++) {
    before = html
    for (const tag of PAIRED) {
      const re = new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?<\\/${tag}\\s*>`, 'gi')
      took(`<${tag}>`, count(html, re))
      html = html.replace(re, '')
    }
    for (const tag of SINGLE) {
      // also one that never closes: the rest of the block would be its content
      const open = new RegExp(`<${tag}\\b[^>]*>?`, 'gi')
      took(`<${tag}>`, count(html, open))
      html = html.replace(open, '').replace(new RegExp(`<\\/${tag}\\s*>`, 'gi'), '')
    }
    for (const tag of UNWRAPPED) {
      const re = new RegExp(`<\\/?${tag}\\b[^>]*>`, 'gi')
      took(`<${tag}>`, count(html, new RegExp(`<${tag}\\b[^>]*>`, 'gi')))
      html = html.replace(re, '')
    }
    // Attribute by attribute, each value taken whole, so that nothing inside a quoted value is mistaken for one.
    html = html.replace(/<([a-z][\w:-]*)((?:"[^"]*"|'[^']*'|[^<>"'])*)>/gi, (tag, name, rest) => {
      const attrs = rest.replace(/([^\s=\/"']+)(\s*=\s*("[^"]*"|'[^']*'|[^\s"'>]+))?/g, (attr, key, _eq, value = '') => {
        const k = key.toLowerCase()
        const bare = value.replace(/^["']|["']$/g, '').trim()
        // handlers, and what would load or send
        if (/^on/.test(k)) { took('on… handlers'); return '' }
        if (['srcdoc', 'formaction', 'ping', 'background', 'srcset', 'poster'].includes(k)) { took(`${k}=`); return '' }
        // a link goes to the web, to mail or to a place in the block; anything else could run code
        if (['href', 'xlink:href', 'action'].includes(k) && !/^(https?:|mailto:|#|[^:]*$)/i.test(plainOf(bare))) { took('script addresses'); return `${key}="#"` }
        // a picture from elsewhere would not load: only data: is shown
        if (k === 'src' && !/^data:image\//i.test(bare)) { took('pictures from an address'); return '' }
        return attr
      })
      return `<${name}${attrs}>`
    })
    // Styles may not fetch either.
    const fetched = /@import\b[^;]*;?|url\(\s*(['"]?)(?!data:image\/|#)[^)]*\)/gi
    took('addresses in CSS', count(html, fetched))
    html = html.replace(fetched, '')
  }
  if (!html.replace(/<[^>]*>/g, '').trim() && !/<(img|svg|table|hr)\b/i.test(html)) throw new Error(`${what} is empty${taken.size ? ' after cleaning' : ''}: send semantic HTML (tables, lists, headings, details) with inline CSS`)
  // A fence inside would end the block where the text carries it.
  return html.replace(/```/g, '&#96;&#96;&#96;')
}

const FENCE = /```html[ \t]*\n([\s\S]*?)```/gi

/** A text with its ```html blocks cleaned in place. Text without one comes back untouched. */
export function cleanFences(text, what = 'text') {
  const said = String(text ?? '')
  if (!/```html/i.test(said)) return said
  return said.replace(FENCE, (_, inner) => `\`\`\`html\n${cleanHtml(inner, `an html block in ${what}`)}\n\`\`\``)
}

/** Blank lines inside fenced blocks, hidden from a parser that splits a text at blank lines; show() brings them back. */
export const fences = {
  hide: text => String(text).replace(/```[\s\S]*?```/g, block => block.replace(/\n[ \t]*(?=\n)/g, '\n\u0001')),
  show: text => String(text).replace(/\u0001/g, ''),
}

/** The html beside a text, checked: cleaned, and never without words next to it. */
export function htmlBeside(html, text, { field = 'html', beside = 'text' } = {}) {
  if (html == null || html === '') return ''
  if (typeof html !== 'string') throw new Error(`${field} must be a string of HTML`)
  if (!String(text ?? '').trim()) throw new Error(`${field} needs ${beside} beside it: say the same in plain words there. It is what read-aloud speaks and what clients that cannot show HTML display`)
  return cleanHtml(html, field)
}
