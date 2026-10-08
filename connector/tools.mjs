// tools.mjs: the connector's tools: their schemas, and what each does in the room.
//
//   1. the agent's HTML, cleaned before it is stored (html fields and ```html fences)
//   2. the tools' schemas, one example per tool and the list of events (the app's help page shows them; the app's build
//      writes them to gen/vendor/tools-reference.mjs)
//   3. the bridge: tool call -> envelopes, a human's command -> <channel> event
//
// Every text the agent reads (the instructions and each tool's description) is in prompt.md beside this file, read
// when this module loads (inlined by build.mjs in the single-file connector). No protocol code lives here: everything
// that touches the hub, the keys or the envelopes goes through the client of shared/ (README there: "Agent API").
// This file and prompt.md are the connector's hot-reloaded part (connector.mjs "updates"). Tested in test.mjs.
import fs from 'node:fs'
import path from 'node:path'

// ---- prompt.md: the instructions and the tools' descriptions ----------------------------------------------

/** prompt.md as { '# Heading' | '## tool': text }: a section's lines and paragraphs read as one paragraph. */
export function parsePrompt(md) {
  const out = {}
  let at = null
  for (const line of String(md).split(/\r?\n/)) {
    const h = /^(##?) +(.+?)\s*$/.exec(line)
    if (h) { at = `${h[1]} ${h[2]}`; out[at] = '' } else if (at) out[at] += ` ${line}`
  }
  for (const k of Object.keys(out)) out[k] = out[k].replace(/\s+/g, ' ').trim()
  return out
}
// __TROMMI_PROMPT__: the file's text, set by build.mjs (esbuild define) in the single-file connector.
const PROMPT = parsePrompt(typeof __TROMMI_PROMPT__ !== 'undefined' ? __TROMMI_PROMPT__ : fs.readFileSync(new URL('./prompt.md', import.meta.url), 'utf8'))
/** Each tool's description: { name: text }, the "## <name>" sections of prompt.md. */
export const DESCRIPTIONS = Object.fromEntries(Object.entries(PROMPT).filter(([k]) => k.startsWith('## ')).map(([k, v]) => [k.slice(3), v]))
/** The server's instructions; <connector> stands for the connector's path. Claude Code keeps the first 2048 characters. */
export const INSTRUCTIONS = PROMPT['# Instructions'] ?? ''
// The inbox tool as Claude Code names it: the plugin's server (plugin:trommi:trommi) or a .mcp.json server "trommi".
export const inboxToolName = (env = process.env) => env.CLAUDE_PLUGIN_ROOT ? 'mcp__plugin_trommi_trommi__inbox' : 'mcp__trommi__inbox'
/** What goes in front of the instructions in a session without channel events (the plugin's monitor wakes it). */
export const monitorNote = (tool = inboxToolName()) => (PROMPT['# Without channel events'] ?? '').replace('<inbox>', tool)

// ---- 1. the agent's HTML -----------------------------------------------------------------------------------
//
// HTML an agent sends along with a message or a question (the field html, or a block fenced as
// ```html inside a text). It is stored already cleaned: nothing that runs, loads or navigates.
// The board shows it in a sandboxed frame without an origin and without network (app/web/public/ui.mjs
// "richhtml"), and that frame is what really holds; this cleaning keeps the stored content honest
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

// ---- 2. the tools ------------------------------------------------------------------------------------------

export const MAX_ASSET = 64 * 1024 * 1024
export const ASSET_TYPES = ['html', 'image', 'video', 'audio', 'file']
export const RETENTION_DAYS = 30
/** The longest an outside release (share_asset) lasts. */
const SHARE_MAX_HOURS = RETENTION_DAYS * 24
export const URGENCIES = ['low', 'normal', 'high', 'critical']
export const STATUSES = ['decision', 'working', 'done']
/** What the agent hears when a newer Trommi wrote something this connector cannot read (README "Versioning and compatibility"). */
export const NEEDS_UPDATE = 'Tell the human that the Trommi connector needs an update to show it (Claude Code: update the trommi plugin, or run the connect script again, then /mcp → trommi → Reconnect). Do not guess what it said.'
// The summary of an answered card that its helper never closed and close_session closes with the session.
export const SESSION_ENDED = 'Closed with its session.'

const SECTION_TEXT_EXAMPLE = [
  'The export times out for large accounts. Tick what I may build.',
  '[limit*] Raise the limit: 60 instead of 30 seconds. Done in five minutes, but only moves the wall.',
  '[async] Export in the background: The file arrives by mail when it is ready. About two days.',
  '[page] Paginate the export\nSmaller files, but every consumer of the API has to follow.',
].join('\n\n')

// What a question is made of besides its title, the same for create_decision, revise_card and merge_cards.
// An option in two or three words, for the answer tile on a Desk row (card Nr. 157). Longer is cut at a word.
export const SHORT_MAX = 18
export function shortOf(value) {
  const said = String(value ?? '').replace(/\s+/g, ' ').trim()
  if (said.length <= SHORT_MAX) return said
  const cut = said.slice(0, SHORT_MAX + 1)
  return (cut.includes(' ') ? cut.slice(0, cut.lastIndexOf(' ')) : said.slice(0, SHORT_MAX)).trim()
}

// A card's teaser: the two short lines the Desk row shows under the title (the same limit as shared/codec.mjs TEASER_MAX).
export const TEASER_MAX = 160
const TEASER_PROP = { type: 'string', description: `Two short lines of plain text (at most ${TEASER_MAX} characters, no markdown) shown under the title on the Desk row: the gist, so the human can decide whether to open the card. Without it the Desk shows the start of the body.` }
const TITLE_ONE_LINE = 'one line, at most about 70 characters'

// An option whose choice ends the matter: the answer itself closes the card (README "card", `final`).
const FINAL_PROP = { type: 'boolean', description: 'true: choosing this leaves nothing for you to do or to report ("Done", "Leave it", "No"). The card then closes itself with the answer: it never waits "with the agent", and you need no close_card. Its tile shows the human a small sign that this choice ends the matter. Leave it out when you will act on the choice.' }

export const QUESTION_PROPS = {
  teaser: TEASER_PROP,
  body: { type: 'string', description: 'Context the human needs to decide: one or two short sentences. Longer explanation belongs behind a link or in an attachment. Not together with sections or text, which carry their own context.' },
  html: { type: 'string', description: `Optional rich layout shown under the words, at its place, in the house style: a comparison table with merged cells, a small grid, a details block. Semantic HTML with inline CSS only (tables, headings, lists, details, mark, kbd; classes grid, cols-2, cols-3, card, tag, muted, num, good, warn, bad); scripts, forms, frames and anything fetched from the network are removed; pictures as data: URLs. At most ${HTML_MAX / 1024} KB. For a plain comparison a markdown table in the text is enough. Needs body beside it, the same in plain words; not together with sections or text, where a block carries its own html.` },
  options: {
    type: 'array',
    minItems: 2,
    description: 'The choices offered. Give options (with body), or sections, or text: one of the three.',
    items: {
      type: 'object',
      properties: {
        key: { type: 'string', description: 'Stable identifier returned to you, e.g. "sqlite"' },
        label: { type: 'string', description: 'What the human sees on the button, at most about four words' },
        detail: { type: 'string', description: 'Optional consequence of this choice: one short line of about six words, never a paragraph, never what leaving it unticked means' },
        short: { type: 'string', description: `Optional: the option in two or three words (at most ${SHORT_MAX} characters), for the answer tile on the Desk row of a two-option question whose labels are not a plain yes or no, e.g. "Delete" and "Keep". Without it such a row shows one "Choose" tile.` },
        final: FINAL_PROP,
      },
      required: ['key', 'label'],
    },
  },
  sections: {
    type: 'array',
    description: 'Instead of body and options: the whole question as one structured text, an ordered list of blocks. A block without key is plain text (introduction, context). A block with key is a flagged paragraph and becomes an option: the board shows the paragraph tied to its option, and options, body and recommended are derived from the blocks. At least two blocks need a key.',
    items: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'The paragraph, markdown; for a flagged block what this option means, at most about 400 characters' },
        key: { type: 'string', description: 'Flags the block as an option: the stable identifier returned to you' },
        label: { type: 'string', description: 'Required with key: the short name of the option on its tile, at most about four words' },
        short: { type: 'string', description: `With key, optional: the option in two or three words (at most ${SHORT_MAX} characters) for the answer tile on the Desk row; see options` },
        html: { type: 'string', description: 'A rich layout shown under this paragraph (see html); the text beside it says the same in plain words' },
        recommended: { type: 'boolean', description: 'true: you would pick this one; several only with multiple: true' },
        final: { type: 'boolean', description: 'With key: choosing this option ends the matter and closes the card; see options' },
        picture: { anyOf: [{ type: 'string' }, { type: 'integer' }], description: 'An attachment of this card that belongs to this option: its file name, or its position in attachments counted from 0' },
      },
      required: ['text'],
    },
  },
  text: {
    type: 'string',
    description: `The same as sections, written as one text block. Paragraphs are separated by a blank line. A paragraph that starts with [key] is an option: "[key] Label: explanation"; without a colon the first line is the label and the following lines explain. [key*], or (recommended) after the label, marks your advice; [key!] marks an option as final (choosing it ends the matter and closes the card, see options; both: [key*!]). A last line "picture: file.png" ties an attachment to the option. Every other paragraph is plain context. Example:\n${SECTION_TEXT_EXAMPLE}`,
  },
  attachments: {
    type: 'array',
    description: 'Files to show on the card, each an absolute path or { path, page, title, mark }; images render inline, videos (mp4, webm, mov; up to 64 MB, end-to-end encrypted like every file) play on the card. A picture of something you built comes with the page it was rendered from (page); foo.html beside foo.png is linked by itself.',
    items: { anyOf: [{ type: 'string' }, { type: 'object', properties: { path: { type: 'string', description: 'Absolute path of the file' }, page: { type: 'string', description: 'The page this picture was rendered from, so the human can open and try it under the picture: the path of a self-contained HTML file, a path on the board (/designs/x.html), an asset link or a URL' }, title: { type: 'string', description: 'A short caption' }, mark: { type: 'object', description: 'For a picture: where on it the thing is, when the picture is a whole screen and what matters is a small part. A region in fractions of the picture, x and y the top-left corner; the board circles it and ties it to the option. Do not draw on the picture yourself.', properties: { x: { type: 'number' }, y: { type: 'number' }, w: { type: 'number' }, h: { type: 'number' }, label: { type: 'string', description: 'A word or two beside the circle, at most 24 characters' } }, required: ['x', 'y', 'w', 'h'] }, marks: { type: 'array', maxItems: 4, description: 'Several such regions on one picture, at most four', items: { type: 'object' } } }, required: ['path'] }] },
  },
  urgency: {
    type: 'string',
    enum: URGENCIES,
    description: 'Position in the stack. critical: you are blocked entirely; high: blocks your current task; normal (default): needed soon; low: nice to know',
  },
  urgency_reason: { type: 'string', description: 'What is waiting on this, one short phrase; expected for high and critical' },
  multiple: { type: 'boolean', description: 'true: the human may tick several options and sends them together; the decision then also carries choices, all chosen keys comma-separated. Default false: one tap on one option decides.' },
  recommended: {
    anyOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }],
    description: 'The key of the option you would pick yourself; for a card with multiple: true it may be a list of keys. It is shown circled by hand, so the human sees your advice at a glance. Leave it out when you have no preference.',
  },
}

// Claude Code loads these tools up front instead of deferring them behind its tool search.
export const ALWAYS_LOAD = { 'anthropic/alwaysLoad': true }

export const TOOLS = [
  {
    _meta: ALWAYS_LOAD,
    name: 'reply',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'The message to show in the chat' },
        html: { type: 'string', description: `Optional rich layout shown under the words, at its place, in the house style: a comparison table with merged cells, a small grid, a details block. Semantic HTML with inline CSS only (tables, headings, lists, details, mark, kbd; classes grid, cols-2, cols-3, card, tag, muted, num, good, warn, bad); scripts, forms, frames and anything fetched from the network are removed; pictures as data: URLs. At most ${HTML_MAX / 1024} KB. For a plain comparison a markdown table in the text is enough. Needs text beside it: the gist in plain words, which is what is read aloud and what clients without HTML show.` },
        details: { type: 'string', description: 'Optional longer material shown collapsed under the message: your reasoning, what you tried, command output, a diff. Markdown. The human opens it only if they want to.' },
        attachments: {
          type: 'array',
          description: 'Absolute paths of files to show with the message; images, videos (mp4, webm, mov) and audio play inline, anything else is a download link. Each is an absolute path or { path, page, title, mark }: a picture of something you built comes with the page it was rendered from (page); foo.html beside foo.png is linked by itself.',
          items: { anyOf: [{ type: 'string' }, { type: 'object', properties: { path: { type: 'string', description: 'Absolute path of the file' }, page: { type: 'string', description: 'The page this picture was rendered from, so the human can open and try it under the picture: the path of a self-contained HTML file, a path on the board (/designs/x.html), an asset link or a URL' }, title: { type: 'string', description: 'A short caption' }, mark: { type: 'object', description: 'For a picture: where on it the thing is, when the picture is a whole screen and what matters is a small part. A region in fractions of the picture, x and y the top-left corner; the board circles it and ties it to the option. Do not draw on the picture yourself.', properties: { x: { type: 'number' }, y: { type: 'number' }, w: { type: 'number' }, h: { type: 'number' }, label: { type: 'string', description: 'A word or two beside the circle, at most 24 characters' } }, required: ['x', 'y', 'w', 'h'] }, marks: { type: 'array', maxItems: 4, description: 'Several such regions on one picture, at most four', items: { type: 'object' } } }, required: ['path'] }] },
        },
        card_id: { type: 'string', description: 'One of your cards this message belongs to; the board shows it under that card. Use it to answer a question the human asked back about the card (a chat message that carried card_id), and to give the details of a card you just filed (background, reasoning, measurements, links), which do not belong in its body. On an open card it changes nothing about the card: not its place, not its state.' },
        present: { type: 'boolean', description: 'Only with card_id, for a card the human handed back to you. true: your work on it is done without rewording it, put the card before the human again. Left out: the reply is only a message on the card (an acknowledgement, a progress note) and the card stays with you. The answer to "Explain" presents the card by itself.' },
      },
      required: ['text'],
    },
  },
  {
    _meta: ALWAYS_LOAD,
    name: 'create_decision',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: `The question, ${TITLE_ONE_LINE}` },
        ...QUESTION_PROPS,
      },
      required: ['title'],
    },
  },
  {
    _meta: ALWAYS_LOAD,
    name: 'create_info',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: `What it is about, ${TITLE_ONE_LINE}` },
        teaser: TEASER_PROP,
        body: { type: 'string', description: 'The text, markdown. Or give sections or text.' },
        sections: {
          type: 'array',
          description: 'Instead of body: the text as an ordered list of blocks, each a paragraph or a short passage of its own. No block has a key: an info has no options.',
          items: { type: 'object', properties: { text: { type: 'string', description: 'The paragraph, markdown' }, html: QUESTION_PROPS.sections.items.properties.html }, required: ['text'] },
        },
        text: { type: 'string', description: 'The same as sections, written as one text block: paragraphs separated by a blank line.' },
        ...Object.fromEntries(['html', 'attachments', 'urgency', 'urgency_reason'].filter(k => QUESTION_PROPS[k]).map(k => [k, QUESTION_PROPS[k]])),
      },
      required: ['title'],
    },
  },
  {
    name: 'revise_card',
    inputSchema: {
      type: 'object',
      properties: {
        card_id: { type: 'string' },
        title: { type: 'string', description: `The question, ${TITLE_ONE_LINE}` },
        ...QUESTION_PROPS,
        note: { type: 'string', description: 'One short line telling the human what changed, shown in the conversation; without it the new title is shown' },
      },
      required: ['card_id'],
    },
  },
  {
    name: 'merge_cards',
    inputSchema: {
      type: 'object',
      properties: {
        card_ids: { type: 'array', minItems: 2, items: { type: 'string' }, description: 'The open cards this one replaces, at least two' },
        title: { type: 'string', description: `The one question, ${TITLE_ONE_LINE}` },
        ...QUESTION_PROPS,
      },
      required: ['card_ids', 'title'],
    },
  },
  {
    name: 'set_urgency',
    inputSchema: {
      type: 'object',
      properties: {
        card_id: { type: 'string' },
        urgency: { type: 'string', enum: URGENCIES },
        reason: { type: 'string', description: 'Why the urgency changed, one short phrase shown to the human' },
      },
      required: ['card_id', 'urgency'],
    },
  },
  {
    name: 'withdraw_card',
    inputSchema: {
      type: 'object',
      properties: {
        card_id: { type: 'string' },
        reason: { type: 'string', description: 'One line on why the answer is no longer needed' },
      },
      required: ['card_id'],
    },
  },
  {
    _meta: ALWAYS_LOAD,
    name: 'close_card',
    inputSchema: {
      type: 'object',
      properties: {
        card_id: { type: 'string' },
        summary: { type: 'string', description: 'One line on what you did' },
      },
      required: ['card_id'],
    },
  },
  {
    _meta: ALWAYS_LOAD,
    name: 'set_status',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Stable identifier of the work stream, e.g. "server" or "tests"' },
        label: { type: 'string', description: 'Short name the human sees, two or three words' },
        state: { type: 'string', enum: STATUSES, description: 'decision = red, waiting on the human; working = yellow, in progress; done = green, finished' },
        detail: { type: 'string', description: 'One line on where it stands' },
        card_id: { type: 'string', description: 'For state "decision": the card that holds the question. The line turns yellow by itself once the human answers it.' },
      },
      required: ['id', 'state'],
    },
  },
  {
    name: 'clear_status',
    inputSchema: { type: 'object', properties: { id: { type: 'string' } } },
  },
  {
    name: 'introduce',
    inputSchema: {
      type: 'object',
      properties: {
        model: { type: 'string', description: 'The model you are running as, e.g. "Claude Opus 5.5"' },
        task: { type: 'string', description: 'What you are working on in this session, one line' },
        icon: { type: 'string', description: 'The name of the drawing that fits your task; it becomes the symbol of your session. A symbol the human picked by hand is kept.' },
        parent: { type: 'string', description: 'If you are a helper of another session: the id or the name of your main session. The board then shows you under it. Pass an empty string to stand alone again.' },
        main: { type: 'boolean', description: 'true: you are a main agent that leads helper sessions; the board shows your helpers under you. A session that has helpers under it is a main without saying so.' },
      },
      required: ['model'],
    },
  },
  {
    name: 'list_cards',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'publish_asset',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute path of the file to publish. Give this or content.' },
        content: { type: 'string', description: 'The asset itself as a string, e.g. the HTML of a page. Give this or path.' },
        type: { type: 'string', enum: ASSET_TYPES, description: 'How the viewer shows it. html: a page in a sandboxed frame, which must be self-contained (inline CSS and scripts, data: images), because nothing is loaded from the network; image, video, audio: shown or played; file: offered as a download. Left out: inferred from the file extension, html for content.' },
        title: { type: 'string', description: 'Shown above the asset and on the board; defaults to the file name' },
        note: { type: 'string', description: 'Optional line shown with the link on the board, e.g. what the page is for' },
      },
    },
  },
  {
    name: 'list_assets',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'revoke_asset',
    inputSchema: { type: 'object', properties: { id: { type: 'string', description: 'The asset id returned by publish_asset' } }, required: ['id'] },
  },
  {
    _meta: ALWAYS_LOAD,
    name: 'open_session',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The helper\'s short name, shown on the board, e.g. "Design"' },
        task: { type: 'string', description: 'What the helper works on, one line' },
        icon: { type: 'string', description: 'The name of the drawing that fits the helper\'s task (as in introduce)' },
        model: { type: 'string', description: 'The model the helper runs as' },
      },
      required: ['name'],
    },
  },
  {
    _meta: ALWAYS_LOAD,
    name: 'close_session',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The helper\'s short name, as given to open_session' },
        summary: { type: 'string', description: 'Optional: the helper\'s result in a few lines, posted into the child session before it is closed' },
      },
      required: ['name'],
    },
  },
  {
    name: 'share_asset',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'The asset id returned by publish_asset' },
        release: { type: 'boolean', description: 'true (default): release it. false: take the release back; the link stops working at once, the asset itself stays.' },
        expires_hours: { type: 'number', description: `The release ends by itself after this many hours. 0 or left out: the longest, ${SHARE_MAX_HOURS / 24} days.` },
      },
      required: ['id'],
    },
  },
]

// Child sessions (open_session): these tools take `session`, the helper's name; the call then lands in that child session.
export const SESSION_TOOLS = ['reply', 'create_decision', 'create_info', 'merge_cards', 'set_status', 'clear_status', 'introduce', 'list_cards', 'publish_asset']
for (const t of TOOLS) if (SESSION_TOOLS.includes(t.name)) t.inputSchema.properties.session = { type: 'string', description: 'Optional: the name of a child session (a helper of yours, e.g. "Design"); opened on first use. Left out: your own session.' }
// The two tools connector.mjs answers itself: loading a new version of this file, and the events of a session without
// channel events (listed only there).
export const RELOAD_TOOL = { name: 'reload_connector', inputSchema: { type: 'object', properties: {}, additionalProperties: false } }
export const INBOX_TOOL = { name: 'inbox', _meta: ALWAYS_LOAD, inputSchema: { type: 'object', properties: {}, additionalProperties: false } }
// Every tool takes its description from prompt.md; one without a section is a mistake there.
for (const t of [...TOOLS, RELOAD_TOOL, INBOX_TOOL]) {
  if (!DESCRIPTIONS[t.name]) throw new Error(`connector/prompt.md has no section "## ${t.name}"`)
  t.description = DESCRIPTIONS[t.name]
}
// One call per tool that does something sensible, for the help page. The test checks each against its schema.
export const TOOL_EXAMPLES = {
  reply: {
    text: 'Three ways to run the migration. **Tonight at 2** is the cheapest: 40 seconds of lock while hardly anyone is online.',
    html: '<table><thead><tr><th>Way</th><th>Lock</th><th>Work for me</th></tr></thead><tbody><tr><td>Now</td><td>40 s</td><td>none</td></tr><tr><td><mark>Tonight at 2</mark></td><td>40 s</td><td>none</td></tr><tr><td>In batches</td><td>0 s</td><td>2 h</td></tr></tbody></table>',
    details: 'Ran `npm test`: 48 of 48 pass.\nThe slow one was the index on `orders`.', attachments: ['/home/me/project/out/before-after.png'],
  },
  create_decision: {
    title: 'Run the migration on production now?', teaser: 'Locks orders for about 40 seconds; now, or tonight when nobody orders?', body: 'It locks `orders` for about 40 seconds.', urgency: 'high', urgency_reason: 'the deploy waits on it', recommended: 'tonight',
    options: [{ key: 'tonight', label: 'Tonight at 2', detail: 'Hardly anyone is online' }, { key: 'now', label: 'Now', detail: 'Short outage for whoever is online' }],
  },
  create_info: {
    title: 'How the nightly migration works', attachments: [{ path: '/home/me/project/out/migration.png', page: '/home/me/project/out/migration.html', title: 'The three steps' }], urgency: 'low',
    sections: [
      { text: 'You asked why the deploy waits until 2. In short: the migration locks `orders`, and at 2 nobody is writing to it.' },
      { text: '**Order of events.** Backup at midnight, migration at 2, deploy right after. The picture shows the three steps.' },
      { text: '**If it fails,** the deploy does not start and you find a question from me in the morning.' },
    ],
  },
  revise_card: { card_id: 'a1b2c3d4', title: 'Run the migration tonight at 2?', options: [{ key: 'tonight', label: 'Tonight at 2' }, { key: 'weekend', label: 'At the weekend' }], recommended: 'tonight', note: 'Running it now is off the table: the backup takes until midnight' },
  merge_cards: {
    card_ids: ['a1b2c3d4', 'e5f6a7b8', 'c9d0e1f2'], title: 'Which parts of the storage plan do you agree to?', multiple: true, attachments: ['/home/me/project/out/sync.png'],
    sections: [
      { text: 'Three parts, each stands on its own. Tick what I may build.' },
      { key: 'sqlite', label: 'SQLite for cards', recommended: true, text: 'One file, no server to run. Cards survive a restart and can be searched.' },
      { key: 'files', label: 'Attachments as files', recommended: true, text: 'Pictures stay next to the database as plain files, so backups are a copy.' },
      { key: 'sync', label: 'Sync between hubs', picture: 'sync.png', text: 'Two machines show the same board. About two days more, and conflicts need a rule.' },
    ],
  },
  set_urgency: { card_id: 'a1b2c3d4', urgency: 'critical', reason: 'nothing else is left to do' },
  withdraw_card: { card_id: 'a1b2c3d4', reason: 'the staging run answered it' },
  close_card: { card_id: 'a1b2c3d4', summary: 'Migration ran at 02:00, 38 seconds' },
  set_status: { id: 'migration', label: 'Migration', state: 'decision', detail: 'waiting for the go-ahead', card_id: 'a1b2c3d4' },
  clear_status: { id: 'migration' },
  introduce: { model: 'Claude Opus 5.5', task: 'Prepare migration and deploy', icon: 'database' },
  list_cards: {},
  publish_asset: { path: '/home/me/project/out/report.html', title: 'Load test, 2 October', note: 'Charts for the three variants' },
  list_assets: {},
  revoke_asset: { id: 'q3n0XWb1kq0lYb6m3v8K2A' },
  share_asset: { id: 'q3n0XWb1kq0lYb6m3v8K2A', expires_hours: 72 },
  open_session: { name: 'Design', task: 'Pictures for the landing page', icon: 'brush' },
  close_session: { name: 'Design', summary: 'Three landing page pictures are in out/landing/, the blue one recommended' },
}

// Everything that travels between Claude Code and the connector besides tool calls, for the help page.
// to_agent: what this process sends Claude Code. from_client: what Claude Code sends this process.
export const EVENTS = [
  {
    direction: 'to_agent', method: 'notifications/claude/channel', kind: 'update', when: 'A new version of the connector is on disk (or the hub recommends one).',
    content: 'a sentence naming the version and what to do: file the update card (jetzt / später)', meta: { kind: 'update', update_available: '1', version: 'the new version (a hash of the connector code, or the hub\'s recommended version)', restart_required: '"1" when only a restart loads it (/mcp → trommi → Reconnect), "0" when reload_connector can' },
    example: '<channel source="board" kind="update" update_available="1" version="3f2a9c1d0b7e" restart_required="0">A new version of the Trommi connector is available …</channel>',
  },
  {
    direction: 'to_agent', method: 'notifications/claude/channel', kind: 'unsupported', when: 'The human sent something (a message, an answer) in a format of a newer Trommi version than this connector reads.',
    content: 'a sentence saying so and that the connector needs an update; nothing of the unreadable part', meta: { kind: 'unsupported', update_required: '1' }, optional: { card_id: 'the card it was about, when it was one of yours' },
    example: '<channel source="board" kind="unsupported" update_required="1">The human sent something on the board that this Trommi connector is too old to read …</channel>',
  },
  {
    direction: 'to_agent', method: 'notifications/claude/channel', kind: 'chat', when: 'The human sent a chat message.',
    content: 'the message; when the human sent only files, a sentence naming them', meta: { kind: 'chat' }, optional: { card_id: 'set when the human asks back about an open card instead of answering it; answer with reply and the same card_id', handback: '"1" when the human handed that card back to you to be reworked: revise it with revise_card, which presents it again', explain: '"1" when the human pressed "What??" (Explain) on that card: rework it with revise_card, and with a clip skill also attach a short silent clip of it (reply with card_id and the mp4)', cards: 'ids of cards the human copied into this message, comma-separated, often another session\'s: each stands in full in the content (question, options, answer, notes, picture paths), so you can act on a decision you never saw', cards_json: 'the same cards as a JSON list of {id, number, title, agent, choice_label, kind, status, choices}', marks: 'how many notes and drawings the human pinned to parts of that card; they are lines of the content under "Notes pinned to the card:", and the picture of the annotated card is in image_path', files: 'absolute paths of the files and pictures the human attached, comma-separated; open them', image_path: 'the first attached picture, when there is one' },
    example: '<channel source="board" kind="chat">Please check the logs first.</channel>',
  },
  {
    direction: 'to_agent', method: 'notifications/claude/channel', kind: 'decision', when: 'The human answered a decision card.',
    content: 'the human\'s note, or a sentence naming the card and the chosen key; when the human wrote notes on single options, a blank line and "Notes on options:" follow, with one line "- Label [key], chosen: note" or "- Label [key], not chosen: note" per note, in the order of the options',
    meta: { kind: 'decision', card_id: 'the card', choice: 'key of the chosen option; of several, the first' },
    optional: { closed: '"1" when the answer settled the card: every chosen option was one you marked final, so the card closed itself; nothing is expected of you, no close_card', choices: 'only for a card made with multiple: true: every chosen key, comma-separated, in the order of the options', trust: '"1" when the human left the decision to you: choice is then the option you recommended, or empty if you recommended none; decide, say what you chose with reply and the card_id, and close the card', marks: 'how many notes and drawings the human pinned to parts of the card; they are lines of the content under "Notes pinned to the card:"', option_notes: 'only when the human wrote notes on single options: the keys that have one, comma-separated; the notes themselves are in the content', files: 'absolute paths of what the human attached to the note of the answer, comma-separated', image_path: 'the first attached picture, when there is one' },
    example: '<channel source="board" kind="decision" card_id="a1b2c3d4" choice="tonight">After the backup, please.</channel>',
  },
  {
    direction: 'to_agent', method: 'notifications/claude/channel', kind: 'decision_reopened', when: 'The human took an answer back; the card is open again.',
    content: 'a sentence saying which answer was taken back', meta: { kind: 'decision_reopened', card_id: 'the card', previous_choice: 'key of the answer that no longer holds' },
    optional: { previous_choices: 'only for a card made with multiple: true: every key that was chosen, comma-separated', trust: '"1" when what is taken back is the human leaving the decision to you', shredded: '"1" when the human took a card back out of the shredder; previous_choice is then empty' },
    example: '<channel source="board" kind="decision_reopened" card_id="a1b2c3d4" previous_choice="tonight">…</channel>',
  },
  {
    direction: 'to_agent', method: 'notifications/claude/channel', kind: 'shredded', when: 'The human threw a question (or an info) away unanswered.',
    content: 'a sentence saying so and what to do: do not ask again, carry on with your own judgement or drop the matter; then the human\'s note, if they wrote one', meta: { kind: 'shredded', card_id: 'the card' },
    optional: { marks: 'how many notes and drawings the human pinned to the card before throwing it away; they are lines of the content', files: 'absolute paths of the pictures that came with it, comma-separated', image_path: 'the first picture' },
    example: '<channel source="board" kind="shredded" card_id="a1b2c3d4">The human threw the question "Which font?" away unanswered. …</channel>',
  },
  {
    direction: 'to_agent', method: 'notifications/claude/channel', kind: 'info_read', when: 'The human read an info card (create_info) and closed it. Nothing is expected of you.',
    content: 'a sentence naming the card', meta: { kind: 'info_read', card_id: 'the card' },
    example: '<channel source="board" kind="info_read" card_id="a1b2c3d4">The human read "How the nightly migration works" and closed it.</channel>',
  },
  {
    direction: 'to_agent', method: 'notifications/claude/channel', kind: 'scribble', when: 'The human selected (or cut out) part of the Scribble Board and sent it to this session. What was sent left the board.',
    content: 'the words of the selected notes and spoken notes in reading order, or a sentence pointing at the picture',
    meta: { kind: 'scribble', board: 'the Scribble Board it came from (desk/<id>)', message_id: 'the message in the conversation that shows the selection', elements: 'ids of the selected strokes, notes and pictures, comma-separated', image_path: 'PNG of exactly the selection, drawn from its strokes on white' },
    example: '<channel source="board" kind="scribble" board="desk/9d7f8611247c59b9c82e0c78b7f084a4" message_id="77" elements="d1/12/0,d1/14/2" image_path="/…/files/selection-9f2c41d07a3e.png">Ship the pad prototype</channel>',
  },
  {
    direction: 'to_agent', method: 'notifications/claude/channel/permission', kind: null, when: 'The human answered an approval card. Claude Code decides whether this or the terminal came first.',
    params: { request_id: 'the id from the request', behavior: 'allow or deny' },
    example: '{ "request_id": "abcde", "behavior": "allow" }',
  },
  {
    direction: 'from_client', method: 'notifications/claude/channel/permission_request', kind: null, when: 'Claude Code wants approval for a tool call. It becomes a card with Allow and Deny, always on top of the stack.',
    params: { request_id: 'echoed in the verdict', tool_name: 'e.g. Bash', description: 'what the tool does', input_preview: 'the arguments, shortened' },
    example: '{ "request_id": "abcde", "tool_name": "Bash", "description": "Run shell command", "input_preview": "{\\"command\\":\\"npm test\\"}" }',
  },
  {
    direction: 'from_client', method: 'initialize', kind: null, when: 'Once, when the MCP connection starts. The name appears as "Program" in the sessions overview.',
    params: { 'clientInfo.name': 'the program on the other end of stdio', 'clientInfo.version': 'its version' },
    example: '{ "clientInfo": { "name": "claude-code", "version": "2.1.0" } }',
  },
]

// ---- 3. the bridge: what each tool does in the room ----------------------------------------------------------

const withShort = value => (shortOf(value) ? { short: shortOf(value) } : {})
const withFinal = value => (value === true ? { final: true } : {})
const listArg = (value, what) => {
  if (value != null && !Array.isArray(value)) throw new Error(`${what} must be a list`)
  return value ?? []
}
const urgencyArg = (value, fallback) => {
  if (value == null || value === '') {
    if (fallback) return fallback
    throw new Error(`urgency must be one of ${URGENCIES.join(', ')}`)
  }
  if (!URGENCIES.includes(value)) throw new Error(`urgency must be one of ${URGENCIES.join(', ')}; got "${value}"`)
  return value
}

// ---- a question as one structured text ---------------------------------------------------------------

const FLAGGED = /^\[([\w.-]+)([*!]{0,2})\](?!\()[ \t]*/
function parseSections(text) {
  return fences.hide(String(text).replace(/\r\n?/g, '\n')).split(/\n[ \t]*\n/).map(p => fences.show(p).trim()).filter(Boolean).map(par => {
    const flag = FLAGGED.exec(par)
    if (!flag) return { text: par }
    let picture = null
    let short = null
    const rest = par.slice(flag[0].length).replace(/\n[ \t]*picture:[ \t]*(.+)$/im, (_, name) => { picture = name.trim(); return '' })
      .replace(/\n[ \t]*short:[ \t]*(.+)$/im, (_, words) => { short = words.trim(); return '' })
    const [first, ...lines] = rest.split('\n')
    const colon = first.search(/:(\s|$)/)
    let advised = flag[2].includes('*')
    const label = (colon < 0 ? first : first.slice(0, colon)).replace(/\s*(\*|\(recommended\))\s*$/i, () => { advised = true; return '' }).trim()
    return {
      key: flag[1], label, text: [colon < 0 ? '' : first.slice(colon + 1), ...lines].join('\n').trim(),
      ...(advised ? { recommended: true } : {}), ...(flag[2].includes('!') ? { final: true } : {}), ...(picture == null ? {} : { picture }), ...(short == null ? {} : { short }),
    }
  })
}

function pictureOf(ref, names, key) {
  const at = Number.isInteger(ref) || /^\d+$/.test(String(ref)) ? Number(ref) : names.findIndex(n => n === String(ref) || n === path.basename(String(ref)))
  if (!(at >= 0 && at < names.length)) {
    throw new Error(`section "${key}" names the picture "${ref}", which is not among this card's attachments (${names.length ? names.map((n, i) => `${i}: ${n}`).join(', ') : 'it has none'}); give a file name or a position counted from 0`)
  }
  return at
}

function sectionsOf(args, names) {
  if (args.sections != null && args.text != null) throw new Error('give sections or text, not both: text is the same thing written as one block')
  if (args.options != null) throw new Error(`${args.sections != null ? 'sections' : 'text'} and options cannot be combined: the flagged blocks are the options. Flag a block with key and label, or go back to body and options`)
  if (args.body != null) throw new Error(`${args.sections != null ? 'sections' : 'text'} and body cannot be combined: the blocks are the body. Put the introduction in as a first block without a key`)
  const blocks = args.sections != null ? listArg(args.sections, 'sections') : parseSections(args.text)
  return blocks.map((b, i) => {
    if (typeof b === 'string') b = { text: b }
    const said = cleanFences(String(b?.text ?? '').trim(), `section ${i + 1}`)
    const rich = htmlBeside(b?.html, said, { field: `the html of section ${b?.key || i + 1}`, beside: 'text' })
    const layout = rich ? { html: rich } : {}
    if (b?.key == null || b.key === '') {
      if (!said) throw new Error(`section ${i + 1} is empty: a block without a key needs text`)
      return { text: said, ...layout }
    }
    const key = String(b.key)
    const label = String(b.label ?? '').trim()
    if (!label) throw new Error(`section "${key}" has a key, so it becomes an option and needs a label: the short name on its tile, at most about four words`)
    return { key, label, text: said, ...layout, ...withShort(b.short), ...withFinal(b.final), recommended: b.recommended === true, ...(b.picture == null || b.picture === '' ? {} : { picture: pictureOf(b.picture, names, key) }) }
  })
}
const bodyOf = sections => sections.map(s => (s.key == null ? s.text : `**${s.label}**${s.text ? `: ${s.text}` : ''}`)).join('\n\n')
const NO_ADVICE = Symbol('no advice')

/** A card's teaser: the two short lines under the title on the Desk row. Plain text on one paragraph; empty is none. */
function teaserArg(value) {
  const said = String(value ?? '').replace(/\s+/g, ' ').trim()
  const n = [...said].length
  if (n > TEASER_MAX) throw new Error(`teaser is ${n} characters, at most ${TEASER_MAX}: the Desk shows only two short lines. Keep the question in it and move the rest into the body or sections`)
  return said || null
}

/** The content of a decision card, checked as today's board checks it. Body field names (README). */
function questionFields(args, names = []) {
  const sections = args.sections != null || args.text != null ? sectionsOf(args, names) : null
  if (sections && args.html) throw new Error('html and sections (or text) cannot be combined: give the layout to the block it belongs to, as html on that section, or fenced as ```html inside the text')
  const body = sections ? bodyOf(sections) : cleanFences(String(args.body ?? ''), 'body')
  const html = sections ? '' : htmlBeside(args.html, body, { beside: 'body' })
  const flagged = sections?.filter(s => s.key != null)
  const options = flagged ? flagged.map(s => ({ key: s.key, label: s.label, detail: '', ...withShort(s.short), ...withFinal(s.final) })) : listArg(args.options, 'options').map(o => ({
    key: String(o?.key), label: String(o?.label), detail: o?.detail ? String(o.detail) : '', ...withShort(o?.short), ...withFinal(o?.final),
  }))
  const keys = new Set(options.map(o => o.key))
  if (options.length < 2 || keys.size !== options.length) {
    throw new Error(sections
      ? 'a question needs at least two options with unique keys: flag at least two blocks with key and label (in text: paragraphs starting with [key] Label:)'
      : 'options need at least two entries with unique keys')
  }
  if (!String(args.title ?? '').trim()) throw new Error('a question needs a title')
  const urgency = urgencyArg(args.urgency, 'normal')
  const multiple = args.multiple === true
  const marked = flagged?.filter(s => s.recommended).map(s => s.key) ?? []
  const given = args.recommended === NO_ADVICE ? null : args.recommended ?? (!marked.length ? null : multiple || marked.length > 1 ? marked : marked[0])
  const advised = given == null ? [] : [given].flat().map(String)
  const stray = advised.find(key => !keys.has(key))
  if (stray != null) throw new Error(`recommended must be the key of one of the options; got "${stray}"`)
  if (Array.isArray(given) && !multiple) throw new Error('recommended as a list needs multiple: true; a card with one answer has one recommendation')
  return {
    card_type: 'decision', title: String(args.title), teaser: teaserArg(args.teaser), body, html: html || null, options,
    sections: sections ? sections.map(s => (s.key == null ? s : { ...s, recommended: advised.includes(s.key) })) : null,
    allows_multiple: multiple, recommended: Array.isArray(given) ? advised : advised[0] ?? null,
    urgency, urgency_reason: String(args.urgency_reason ?? '').trim(),
  }
}

/** The content of an info card. */
function infoFields(args, names = []) {
  for (const key of ['options', 'multiple', 'recommended']) {
    if (args[key] != null) throw new Error(`an info has no ${key}: it asks nothing, the human reads it and closes it. Something to choose is a question: create_decision`)
  }
  const sections = args.sections != null || args.text != null ? sectionsOf(args, names) : null
  const flagged = sections?.find(s => s.key != null)
  if (flagged) throw new Error(`an info has no options, so no block may have a key (got "${flagged.key}"). Something to choose is a question: create_decision`)
  if (sections && args.html) throw new Error('html and sections (or text) cannot be combined: give the layout to the block it belongs to, as html on that section, or fenced as ```html inside the text')
  const body = sections ? bodyOf(sections) : cleanFences(String(args.body ?? ''), 'body')
  const html = sections ? '' : htmlBeside(args.html, body, { beside: 'body' })
  if (!String(args.title ?? '').trim()) throw new Error('an info needs a title')
  if (!body.trim() && !html) throw new Error('an info needs something to read: body, sections or text')
  return {
    card_type: 'info', title: String(args.title), teaser: teaserArg(args.teaser), body, html: html || null, options: [], sections, allows_multiple: false, recommended: null,
    urgency: urgencyArg(args.urgency, 'normal'), urgency_reason: String(args.urgency_reason ?? '').trim(),
  }
}

const namesOf = list => listArg(list, 'attachments').map(f => path.basename(String(f?.path ?? f)))

// ---- files ---------------------------------------------------------------------------------------------

const MEDIA = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.avif': 'image/avif',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime', '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.ogg': 'audio/ogg', '.wav': 'audio/wav',
  '.html': 'text/html', '.htm': 'text/html', '.txt': 'text/plain', '.md': 'text/markdown', '.json': 'application/json', '.pdf': 'application/pdf',
  '.csv': 'text/csv', '.diff': 'text/x-diff', '.patch': 'text/x-diff', '.zip': 'application/zip',
}
const ATTACHMENT_ID = /^[0-9a-f]{32}$/
/** A file name from someone else, as one harmless path component. */
export const safeName = name => (path.basename(String(name || 'file')).replace(/[^\w.-]+/g, '_').replace(/^\.+/, '').slice(0, 100) || 'file')
export const mediaTypeOf = name => MEDIA[path.extname(String(name)).toLowerCase()] ?? 'application/octet-stream'
const assetTypeOf = media => (media === 'text/html' ? 'html' : /^(image|video|audio)\//.test(media) ? media.split('/')[0] : 'file')

/** Width and height of a PNG or JPEG, or {} (cheap header read; nothing is decoded). */
function pictureSize(bytes) {
  if (bytes.length > 24 && bytes[0] === 0x89 && bytes[1] === 0x50) {
    const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    return { width: v.getUint32(16), height: v.getUint32(20) }
  }
  if (bytes[0] === 0xff && bytes[1] === 0xd8) {
    let i = 2
    while (i + 9 < bytes.length) {
      if (bytes[i] !== 0xff) break
      const marker = bytes[i + 1], len = (bytes[i + 2] << 8) | bytes[i + 3]
      if (marker >= 0xc0 && marker <= 0xc3) return { height: (bytes[i + 5] << 8) | bytes[i + 6], width: (bytes[i + 7] << 8) | bytes[i + 8] }
      i += 2 + len
    }
  }
  return {}
}

const markOf = m => {
  if (!m || typeof m !== 'object') return null
  const n = k => Number(m[k])
  if (![n('x'), n('y'), n('w') || n('width'), n('h') || n('height')].every(Number.isFinite)) throw new Error('a mark needs x, y, w and h, fractions of the picture from 0 to 1')
  return { x: n('x'), y: n('y'), width: Number(m.w ?? m.width), height: Number(m.h ?? m.height), ...(m.label ? { label: String(m.label).slice(0, 24) } : {}) }
}

// ---- the bridge ---------------------------------------------------------------------------------------

/**
 * createBridge({ client, notify, cacheDir, state, saveState, log })
 *   client:    a started shared/ agent client
 *   notify:    (method, params) => Promise: an MCP notification to Claude Code
 *   cacheDir:  where the human's attachments are written decrypted (dir 0700, files 0600)
 *   state:     the bridge's own small persisted state ({ permissions: { object_id: request_id } })
 *   saveState: () => void, called after state changed
 * Returns { callTool(name, args) -> text, permissionRequest(params), permissionWithdraw(request_id), command(cmd) }.
 */
export function createBridge({ client, notify, cacheDir, state = {}, saveState = () => {}, log = () => {} }) {
  state.permissions ??= {}
  state.shares ??= {}   // published object_id -> [{ share_id, expires_at }]: outsider links this agent made
  state.children ??= {} // child sessions this agent opened for its helpers: lowercase name -> { session_id, name }
  const model = () => client.model
  const me = () => model().room.my_device_id
  // This agent's session on the board: its session_id once sessions have their own keys (R6), its device id before.
  // With a child session id: that one (a helper's session, open_session).
  const mySession = (sid = null) => model().sessions.get(sid ?? client.session_id ?? me())

  // ---- child sessions: one per helper (a subagent of this Claude session), named by the helper ------------
  const opening = new Map()
  const holds = sid => (client.session_ids ?? []).includes(sid)
  function findChild(name) {
    const key = name.toLowerCase()
    const known = state.children[key]
    if (known && holds(known.session_id)) return known.session_id
    // The state file was lost: find it by the name this agent wrote into the child's profile.
    for (const sid of client.childSessionIds?.() ?? []) {
      if (String(model().sessions.get(sid)?.profile?.agent_name ?? '').toLowerCase() !== key) continue
      state.children[key] = { session_id: sid, name }
      saveState()
      return sid
    }
    return null
  }
  const childName = sid => {
    if (!sid || sid === client.session_id) return null
    const hit = Object.values(state.children).find(c => c.session_id === sid)
    return hit?.name ?? model().sessions.get(sid)?.profile?.agent_name ?? sid.slice(0, 12)
  }
  /** The session a tool call writes into: null for the main session, else the named child (opened on first use). */
  async function sessionOf(args, profile = {}) {
    const name = args.session == null ? '' : String(args.session).trim()
    if (!name) return null
    if (name.length > 40 || /[\n\r]/.test(name)) throw new Error('session is a helper\'s short name, at most 40 characters')
    const found = findChild(name)
    if (found) { await reopen(found); return found }
    if (!client.openChildSession) throw new Error('this hub connection cannot open child sessions')
    const key = name.toLowerCase()
    if (!opening.has(key)) {
      const model_ = mySession()?.profile?.model
      opening.set(key, client.openChildSession({ profile: { agent_name: name, ...(model_ ? { model: model_ } : {}), ...profile } }).then(sid => {
        state.children[key] = { session_id: sid, name }
        saveState()
        log(`child session "${name}" opened: ${sid}`)
        return sid
      }).finally(() => opening.delete(key)))
    }
    return opening.get(key)
  }
  /** A closed child (close_session) that is written to again is open again: back in the human's active list. */
  async function reopen(sid) {
    const p = mySession(sid)?.profile
    if (!p?.closed_at) return
    const { closed_at, ...rest } = p
    await client.setStatus({ profile: rest }, { session_id: sid })
  }
  const into = sid => (sid ? { session_id: sid } : {})
  // An object is this agent's when it holds it: it created it, or it continues the session it belongs to (shared/model.mjs holderOf).
  const mine = o => !!o && (client.holds ? client.holds(o) : o.agent_device_id === me())
  const myCards = () => [...model().cards.values()].filter(c => mine(c)).sort((a, b) => a.first_envelope_number - b.first_envelope_number)

  function findCard(ref) {
    const id = String(ref ?? '').trim().toLowerCase()
    if (!id) throw new Error('card_id is required')
    const mine = myCards()
    const hit = mine.find(c => c.object_id === id) ?? (id.length >= 4 ? mine.filter(c => c.object_id.startsWith(id)) : []).at(0)
    if (!hit || (hit.object_id !== id && mine.filter(c => c.object_id.startsWith(id)).length > 1)) throw new Error(`no card ${ref} of yours; list_cards shows your cards`)
    return hit
  }
  const placeOf = card => {
    const at = model().stack.indexOf(card.object_id)
    return at < 0 ? 'not in the stack yet' : `position ${at + 1} of ${model().stack.length} in the stack`
  }

  // Attachments given as absolute paths: encrypted here, uploaded, referenced (README "attachment reference").
  async function upload(entry, { objectId } = {}) {
    const given = entry && typeof entry === 'object' && !Array.isArray(entry) ? entry : { path: entry }
    const file = path.resolve(String(given.path ?? ''))
    if (!given.path || !fs.existsSync(file) || !fs.statSync(file).isFile()) throw new Error(`attachment not found: ${given.path}`)
    const size = fs.statSync(file).size
    if (size > MAX_ASSET) throw new Error(`${path.basename(file)} is ${Math.round(size / 1048576)} MB; at most ${MAX_ASSET / 1048576} MB`)
    const bytes = new Uint8Array(fs.readFileSync(file))
    const media_type = mediaTypeOf(file)
    const marks = [...(given.mark ? [given.mark] : []), ...listArg(given.marks, 'marks')].slice(0, 4).map(markOf).filter(Boolean)
    // The page this picture was rendered from: a local HTML file travels as an attachment of its own.
    let page = given.page ?? null
    let pageRef = null
    const sibling = media_type.startsWith('image/') && page == null ? ['.html', '.htm'].map(ext => file.replace(/\.[^.\/]+$/, ext)).find(f => f !== file && fs.existsSync(f)) : null
    const pageFile = typeof page === 'string' && !/^(https?:)?\//i.test(page) ? path.resolve(page) : typeof page === 'string' && page.startsWith('/') && fs.existsSync(page) ? page : sibling
    if (pageFile && fs.existsSync(pageFile) && fs.statSync(pageFile).isFile()) {
      pageRef = await client.uploadAttachment(new Uint8Array(fs.readFileSync(pageFile)), { file_name: path.basename(pageFile), media_type: mediaTypeOf(pageFile), object_id: objectId })
      page = `attachment:${pageRef.attachment_id}`
    }
    const ref = await client.uploadAttachment(bytes, {
      file_name: path.basename(file), media_type, ...(media_type.startsWith('image/') ? pictureSize(bytes) : {}),
      ...(given.title ? { caption: String(given.title) } : {}), ...(page ? { page: String(page) } : {}), object_id: objectId,
    })
    return { ref: { ...ref, ...(marks.length ? { marks } : {}) }, pageRef }
  }
  async function uploadAll(list) {
    const refs = []
    for (const entry of listArg(list, 'attachments')) {
      const { ref, pageRef } = await upload(entry)
      refs.push(ref)
      if (pageRef) refs.push({ ...pageRef, role: 'page' })
    }
    return refs
  }

  // Files the human sent: fetched, decrypted, written where Claude can read them.
  async function download(refs) {
    const paths = []
    let image = null
    for (const ref of listArg(refs, 'attachments')) {
      try {
        // A reference is body text from a human device: the id must be exactly an attachment id before it reaches a
        // URL or a file name, and the file must land inside the cache (review 2: path traversal).
        if (!ATTACHMENT_ID.test(String(ref?.attachment_id))) throw new Error('not an attachment id')
        const file = path.resolve(cacheDir, `${ref.attachment_id}-${safeName(ref.file_name)}`)
        if (path.dirname(file) !== path.resolve(cacheDir)) throw new Error('outside the cache')
        const bytes = await client.fetchAttachment(ref)
        fs.mkdirSync(cacheDir, { recursive: true, mode: 0o700 })
        fs.writeFileSync(file, bytes, { mode: 0o600, flag: 'w' })
        paths.push(file)
        if (!image && String(ref.media_type ?? mediaTypeOf(name)).startsWith('image/')) image = file
      } catch (err) {
        log(`attachment ${ref?.attachment_id} not readable: ${err.message}`)
      }
    }
    return { paths, image, names: listArg(refs, 'attachments').map(r => r.file_name || 'file') }
  }
  const fileMeta = got => (got.paths.length ? { files: got.paths.join(','), ...(got.image ? { image_path: got.image } : {}) } : {})
  const uploadLine = got => `The human sent ${got.names.length === 1 ? 'a file' : `${got.names.length} files`}: ${got.names.join(', ')}. The meta attribute files holds ${got.names.length === 1 ? 'its path' : 'their paths'}.`
  // The marks as the agent reads them: one line each, saying what it is pinned to (wording of today's board).
  const brief = (said, max = 80) => { const line = String(said).replace(/\s+/g, ' '); return line.length > max ? `${line.slice(0, max - 1)}…` : line }
  const marksBlock = (card, marks) => {
    const lines = listArg(marks, 'marks').filter(m => m && (m.text || m.strokes)).map(m => {
      const a = m.anchor ?? {}
      const option = a.key == null ? null : card?.options?.find(o => o.key === a.key)
      const section = a.kind === 'section' ? card?.sections?.[a.index] : null
      const where = a.kind === 'option' ? `on option "${option?.label ?? a.key}" [${a.key}]`
        : a.kind === 'section' ? (section?.key ? `on option "${section.label}" [${section.key}]` : `on the paragraph "${brief(section?.text ?? '', 50)}"`)
        : a.kind === 'picture' ? `on the picture ${card?.attachments?.[a.index]?.file_name ?? (a.index ?? 0) + 1}`
        : a.kind === 'text' ? `on the text "${brief(a.quote ?? '', 80)}"`
        : 'general'
      const drawn = m.strokes ? (m.text ? ' (also drawn; see the picture)' : '(drawn; see the picture)') : ''
      return `- ${where}: ${String(m.text ?? '').replace(/\s*\n\s*/g, ' ')}${drawn}`
    })
    return lines.length ? ['', 'Notes pinned to the card:', ...lines] : []
  }

  // The card as an agent reads it, for list_cards.
  const versionOf = c => c.object_version ?? c.versions?.length ?? 1
  const cardLine = c => {
    const open = c.object_state === 'open'
    const answer = c.answer
    return {
      id: c.object_id, kind: c.card_type, status: open ? 'open' : c.closed_how === 'answered' && c.object_state === 'answered' ? 'decided' : c.closed_how === 'shredded' ? 'shredded' : 'done',
      urgency: c.urgency, urgency_reason: c.urgency_reason ?? '', queue_position: model().stack.indexOf(c.object_id) + 1 || null,
      title: c.title, ...(c.teaser ? { teaser: c.teaser } : {}), version: versionOf(c),
      ...(answer ? { answered_version: answer.bound_object_version, choice: answer.choices?.[0] ?? null, choices: answer.choices ?? [], note: answer.note ?? '', ...(answer.trusted ? { trusted: true } : {}) } : {}),
      ...(c.in_revision ? { with_agent: c.in_revision.by } : {}),
      multiple: Boolean(c.allows_multiple),
      ...(open ? { body: c.body ?? '', ...(c.html ? { html: c.html } : {}), options: c.options ?? [], recommended: c.recommended ?? null, ...(c.sections ? { sections: c.sections } : {}) } : {}),
      ...(c.merged_into_object_id ? { merged_into: c.merged_into_object_id } : {}),
      ...(c.merged_from_object_ids?.length ? { merged_from: c.merged_from_object_ids } : {}),
    }
  }

  async function revise(args) {
    const card = findCard(args.card_id)
    if (card.object_state === 'answered') {
      throw new Error(`card ${card.object_id} was already decided (choice: ${card.answer?.choices?.[0] ?? ''}); the human answered the question as it stood, so act on that answer, or call close_card and ask anew with create_decision`)
    }
    if (card.object_state !== 'open') throw new Error(`card ${card.object_id} is already done`)
    const FIELDS = ['title', 'teaser', 'body', 'options', 'sections', 'text', 'multiple', 'recommended', 'urgency', 'urgency_reason', 'attachments', 'html']
    if (!FIELDS.some(k => args[k] != null)) throw new Error(`nothing to revise: pass at least one of ${FIELDS.join(', ')}`)
    const info = card.card_type === 'info'
    const resection = args.sections != null || args.text != null
    const plain = args.body != null || args.options != null
    const options = args.options ?? card.options
    const multiple = args.multiple ?? card.allows_multiple
    const kept = [card.recommended ?? []].flat().filter(key => options.some(o => String(o?.key) === key))
    const urgency = args.urgency ?? card.urgency
    const wording = resection ? { sections: args.sections, text: args.text }
      : card.sections && !plain ? { sections: card.sections.map(s => (typeof s.picture === 'number' ? { ...s } : s)) }
      : { body: args.body ?? card.body, ...(info ? {} : { options }) }
    const attachments = args.attachments == null ? card.attachments ?? [] : await uploadAll(args.attachments)
    const names = attachments.map(a => a.file_name)
    const fields = (info ? infoFields : questionFields)({
      title: args.title ?? card.title, teaser: args.teaser ?? card.teaser, ...wording, ...(info ? {} : { multiple }), urgency,
      html: resection ? args.html : args.html ?? card.html ?? undefined,
      urgency_reason: args.urgency_reason ?? (urgency === card.urgency ? card.urgency_reason : ''),
      ...(info ? {} : { recommended: args.recommended != null ? (args.recommended.length ? args.recommended : NO_ADVICE) : resection ? undefined : multiple && Array.isArray(card.recommended) ? kept : kept[0] ?? NO_ADVICE }),
    }, names)
    await client.revise(card.object_id, { ...fields, attachments, change_note: String(args.note ?? '').trim() || null })
    return `card ${card.object_id} revised, now version ${versionOf(card) + 1}, ${placeOf(card)}${card.in_revision ? '; it is before the human again' : ''}${strippedHint()}`
  }

  // Read your own writes: what this agent sent is in the model before the next tool looks (a status line right
  // after create_decision names a card the hub has just confirmed). Costs nothing when nothing is pending.
  // A halted chain (the hub refused one of our envelopes for good) is not something to work around: say so, act on nothing.
  const caughtUp = () => client.settle().catch(err => {
    if (err.code === 'chain-halted') throw new Error('the hub refused one of this session\'s envelopes for good, so the channel stopped sending to keep its signed history intact. Nothing was sent. Tell the human in the terminal; the Trommi app shows the alert.')
    log(`not settled: ${err.message}`)
  })

  function ownAsset(id) {
    const asset = [...model().published.values()].find(p => mine(p) && p.object_id === String(id ?? ''))
    if (!asset) throw new Error(`no asset ${id}; list_assets shows yours`)
    return asset
  }
  /** Ends every outsider link of an asset; returns how many were open. */
  async function unshare(object_id) {
    const open = (state.shares[object_id] ?? []).filter(s => s.expires_at > Date.now())
    for (const s of open) await client.revokeShare(s.share_id).catch(err => { if (err.code !== 'not-found') throw err })
    delete state.shares[object_id]
    saveState()
    return open.length
  }

  async function callTool(name, args) {
    if (!args || typeof args !== 'object') args = {}
    await caughtUp()
    switch (name) {
      case 'reply': {
        const card = args.card_id == null ? null : findCard(args.card_id)
        const text = cleanFences(String(args.text ?? ''), 'text')
        const html = htmlBeside(args.html, text)
        // A reply on a card that is with the agent stays a message on the card; it presents the card only when
        // asked (present: true) or as the answer to "Explain".
        const turn = card?.in_revision ?? null
        const present = Boolean(turn) && (args.present === true || (turn.by === 'explain' && args.present !== false))
        const sid = card ? null : await sessionOf(args)
        await client.sendMessage({ ...into(sid),
          text, ...(html ? { html } : {}), ...(args.details ? { details: cleanFences(String(args.details), 'details') } : {}),
          attachments: await uploadAll(args.attachments), ...(card ? { object_id: card.object_id } : {}), ...(present ? { present_card: true } : {}),
        })
        return `sent${turn && !present ? `; card ${card.object_id} stays with you (in revision): put it before the human again with revise_card, or with reply and present: true, when your work on it is done` : present ? `; card ${card.object_id} is before the human again` : ''}${strippedHint()}`
      }
      case 'create_decision': {
        const fields = questionFields(args, namesOf(args.attachments))
        const sid = await sessionOf(args)
        const attachments = await uploadAll(args.attachments)
        const id = await client.sendCard({ ...fields, attachments, ...into(sid) })
        await caughtUp()
        return `card ${id} created, ${placeOf({ object_id: id })}; the choice will arrive as a channel event${strippedHint()}`
      }
      case 'create_info': {
        const fields = infoFields(args, namesOf(args.attachments))
        const sid = await sessionOf(args)
        const attachments = await uploadAll(args.attachments)
        const id = await client.sendCard({ ...fields, attachments, ...into(sid) })
        return `info ${id} put on the board; when the human has read and closed it, info_read arrives, which needs no answer${strippedHint()}`
      }
      case 'revise_card':
        return revise(args)
      case 'merge_cards': {
        const ids = [...new Set(listArg(args.card_ids, 'card_ids').map(String))]
        if (ids.length < 2) throw new Error('merge_cards replaces at least two cards; to change one card use revise_card')
        const old = ids.map(findCard)
        for (const c of old) {
          if (c.card_type === 'info') throw new Error(`card ${c.object_id} is an info, not a question; infos are not merged. Rework it with revise_card or take it away with withdraw_card`)
          if (c.object_state === 'answered') throw new Error(`card ${c.object_id} was already decided; the human spent an answer on it, so act on it and merge only the open ones`)
          if (c.object_state !== 'open') throw new Error(`card ${c.object_id} is already done`)
        }
        const top = old.reduce((a, b) => (URGENCIES.indexOf(b.urgency) > URGENCIES.indexOf(a.urgency) ? b : a))
        const fields = questionFields({ ...args, urgency: args.urgency ?? top.urgency, urgency_reason: args.urgency_reason ?? (args.urgency == null ? top.urgency_reason : '') }, namesOf(args.attachments))
        const sid = await sessionOf(args)
        const attachments = await uploadAll(args.attachments)
        const id = await client.merge(old.map(c => c.object_id), { ...fields, attachments, ...into(sid) })
        return `card ${id} created, replacing ${old.map(c => c.object_id).join(', ')}; answers to the replaced cards will no longer arrive, the choice on this one will arrive as a channel event${strippedHint()}`
      }
      case 'set_urgency': {
        const card = findCard(args.card_id)
        const urgency = urgencyArg(args.urgency)
        if (card.object_state !== 'open') throw new Error(`card ${card.object_id} is ${card.object_state}; urgency only applies to open cards`)
        const changed = card.urgency !== urgency
        await client.setUrgency(card.object_id, urgency, String(args.reason ?? '').trim() || null)
        return `urgency ${changed ? 'set to' : 'already'} ${urgency}; the card keeps its place in the stack`
      }
      case 'withdraw_card': {
        const card = findCard(args.card_id)
        if (card.object_state === 'answered') throw new Error(`card ${card.object_id} was already decided (choice: ${card.answer?.choices?.[0] ?? ''}); the human spent an answer on it, so act on it or call close_card with a summary of why it no longer applies`)
        if (card.object_state !== 'open') throw new Error(`card ${card.object_id} is already done`)
        await client.withdraw(card.object_id, String(args.reason ?? '').trim())
        return 'withdrawn'
      }
      case 'close_card': {
        const card = findCard(args.card_id)
        // Settled by a final answer: it is closed already, and a version from here would take the human's "Take back" away.
        if (card.object_state === 'closed' && card.closed_how === 'settled') return 'already closed: the human\'s answer settled it (a final option). Nothing to do; say what there is to say with reply'
        await client.close(card.object_id, String(args.summary ?? ''))
        return 'closed'
      }
      case 'set_status': {
        const id = String(args.id ?? '').trim()
        if (!id) throw new Error('id is required')
        if (!STATUSES.includes(args.state)) throw new Error(`state must be one of ${STATUSES.join(', ')}; got "${args.state}"`)
        const sid = await sessionOf(args)
        const before = mySession(sid)?.status_lines?.find(s => s.id === id)
        if (!before && !args.label) throw new Error(`label is required for the new status line "${id}"`)
        const card = args.card_id ? findCard(args.card_id) : null
        await client.setStatus({ [`status_line/${id}`]: {
          label: String(args.label ?? before.label), state: args.state, detail: args.detail != null ? String(args.detail) : before?.detail ?? '',
          object_id: args.state === 'decision' ? card?.object_id ?? before?.object_id ?? null : null,
        } }, ...(sid ? [{ session_id: sid }] : []))
        return `status "${id}" is ${args.state}`
      }
      case 'clear_status': {
        const sid = await sessionOf(args)
        const lines = mySession(sid)?.status_lines ?? []
        const gone = args.id ? [String(args.id)] : lines.map(s => s.id)
        if (gone.length) await client.setStatus(Object.fromEntries(gone.map(id => [`status_line/${id}`, null])), ...(sid ? [{ session_id: sid }] : []))
        return 'cleared'
      }
      case 'introduce': {
        if (!args.model) throw new Error('model is required')
        const sid = await sessionOf(args)
        const was = mySession(sid)?.profile ?? {}
        await client.setStatus({ profile: {
          ...was, model: String(args.model), task: args.task != null ? String(args.task) : was.task ?? '',
          ...(args.icon != null ? { icon: String(args.icon) } : {}),
          ...(args.parent !== undefined ? { parent_session: args.parent ? String(args.parent) : null } : {}),
          ...(args.main !== undefined ? { is_main: args.main === true } : {}),
        } }, ...(sid ? [{ session_id: sid }] : []))
        return 'noted'
      }
      case 'list_cards': {
        const sid = args.session == null || args.session === '' ? undefined : findChild(String(args.session).trim())
        if (sid === null) throw new Error(`no child session "${args.session}"; open_session opens one`)
        return JSON.stringify(myCards().filter(c => sid === undefined || c.session_id === sid).map(c => {
          const line = cardLine(c), child = childName(c.session_id)
          return child ? { ...line, session: child } : line
        }), null, 2)
      }
      case 'open_session': {
        const name = String(args.name ?? '').trim()
        if (!name) throw new Error('name is required: the helper\'s short name, e.g. "Design"')
        const profile = { ...(args.task != null ? { task: String(args.task) } : {}), ...(args.icon != null ? { icon: String(args.icon) } : {}), ...(args.model != null ? { model: String(args.model) } : {}) }
        const existed = findChild(name)
        const sid = existed ?? await sessionOf({ session: name }, profile)
        if (existed) await reopen(existed)
        if (existed && Object.keys(profile).length) await client.setStatus({ profile: { ...(mySession(sid)?.profile ?? {}), ...profile } }, { session_id: sid })
        return `${existed ? 'child session already open' : 'child session opened'}: "${name}" (${sid}), under your session on the board. Pass session: "${name}" to reply, create_decision, create_info, merge_cards, set_status, clear_status, introduce, list_cards and publish_asset to write into it; the human's messages and answers there arrive with meta session="${name}".`
      }
      case 'close_session': {
        const name = String(args.name ?? args.session ?? '').trim()
        if (!name) throw new Error('name is required: the helper\'s short name, as given to open_session')
        const sid = findChild(name)
        if (!sid) throw new Error(`no child session "${name}"; open_session opens one`)
        if (args.summary != null && String(args.summary).trim()) await client.sendMessage({ session_id: sid, text: cleanFences(String(args.summary), 'summary'), attachments: [] })
        const s = mySession(sid)
        // A helper that is done works on nothing: its lines would keep saying "working" (and look stuck).
        const lines = s?.status_lines ?? []
        if (lines.length) await client.setStatus(Object.fromEntries(lines.map(l => [`status_line/${l.id}`, null])), { session_id: sid })
        await client.setStatus({ profile: { ...(s?.profile ?? {}), closed_at: Date.now() } }, { session_id: sid })
        // What the human answered there and the helper never closed would wait "with the agent" for nobody: closed with it.
        const left = myCards().filter(c => c.session_id === sid && c.object_state === 'answered')
        for (const c of left) await client.close(c.object_id, SESSION_ENDED)
        const open = myCards().filter(c => c.session_id === sid && c.object_state === 'open').length
        return `child session "${name}" closed: archived on the board, still readable there${left.length ? `; ${left.length} answered card${left.length === 1 ? '' : 's'} of it ${left.length === 1 ? 'was' : 'were'} closed with it` : ''}${open ? `; ${open} open question${open === 1 ? '' : 's'} of it stay${open === 1 ? 's' : ''} on the human's stack, and the session stays in the active list until ${open === 1 ? 'it is' : 'they are'} answered` : ''}. open_session("${name}") opens it again.`
      }
      case 'publish_asset': {
        if (args.path == null && args.content == null) throw new Error('give path or content')
        if (args.type != null && !ASSET_TYPES.includes(args.type)) throw new Error(`type must be one of ${ASSET_TYPES.join(', ')}`)
        let ref
        if (args.path != null) ({ ref } = await upload(String(args.path)))
        else {
          const bytes = new TextEncoder().encode(String(args.content))
          if (bytes.length > MAX_ASSET) throw new Error('content is too large')
          const media_type = args.type && args.type !== 'html' ? 'application/octet-stream' : 'text/html'
          ref = await client.uploadAttachment(bytes, { file_name: `${String(args.title || 'page').replace(/[^\w.-]+/g, '-').slice(0, 60)}.html`, media_type })
        }
        const title = String(args.title || ref.file_name)
        const asset = { ...ref, asset_type: args.type ?? assetTypeOf(ref.media_type) }
        const note = args.note ? String(args.note) : null
        const sid = await sessionOf(args)
        const id = await client.publish({ attachments: [asset], title, ...(note ? { note } : {}), ...into(sid) })
        // Announced in the session's conversation, as today's board did: a message carrying the published object.
        await client.sendMessage({ ...into(sid), text: [`**${title}**`, note].filter(Boolean).join('\n\n'), attachments: [asset], published_object_id: id })
        return `published as ${id}: "${title}" is shown in your conversation on the board, end-to-end encrypted; members open it in the Trommi app. For someone outside the board: share_asset.`
      }
      case 'list_assets':
        return JSON.stringify([...model().published.values()].filter(p => mine(p) && p.object_state !== 'closed').map(p => ({
          id: p.object_id, title: p.title, note: p.note ?? '', state: p.object_state,
          type: p.attachments?.[0]?.asset_type ?? assetTypeOf(p.attachments?.[0]?.media_type ?? ''), size: p.attachments?.[0]?.total_size ?? null,
          released_until: Math.max(0, ...(state.shares[p.object_id] ?? []).map(x => x.expires_at)) || null,
        })), null, 2)
      case 'revoke_asset': {
        const asset = ownAsset(args.id)
        await unshare(asset.object_id)
        await client.unpublish(asset.object_id)
        return 'revoked: the asset is taken off the board'
      }
      case 'share_asset': {
        const asset = ownAsset(args.id)
        if (args.release === false) {
          const n = await unshare(asset.object_id)
          return n ? 'release taken back: the link for outsiders no longer opens anything. The asset itself is still there.' : 'it was not released'
        }
        const hours = Number(args.expires_hours) > 0 ? Number(args.expires_hours) : SHARE_MAX_HOURS
        if (hours > SHARE_MAX_HOURS) throw new Error(`a release lasts at most ${SHARE_MAX_HOURS / 24} days; expires_hours ${hours} is too long`)
        const { share_id, link, expires_at } = await client.shareAttachment(asset.attachments[0], { expires_at: Date.now() + hours * 3600000 })
        ;(state.shares[asset.object_id] ??= []).push({ share_id, expires_at })
        saveState()
        return [
          `asset ${asset.object_id} is released until ${new Date(expires_at).toISOString()}.`,
          `Link for the recipient: ${link}`,
          'It opens a plain viewer without the board; the key is after the #, the hub never sees it. share_asset with release: false or revoke_asset ends it.',
        ].join('\n')
      }
    }
    throw new Error(`unknown tool: ${name}`)
  }

  // ---- Claude Code asks for approval: a permission request object -----------------------------------
  const asking = new Set()   // request ids on their way to the hub: a repeat while the first is sealed is the same request
  async function permissionRequest(params) {
    if (asking.has(params.request_id) || Object.values(state.permissions).includes(params.request_id)) return
    asking.add(params.request_id)
    try {
      const id = await client.requestPermission({
        tool_name: String(params.tool_name), description: String(params.description ?? ''), input_preview: String(params.input_preview ?? ''), expires_in_ms: params.expires_in_ms ?? 10 * 60 * 1000,
      })
      state.permissions[id] = params.request_id
      saveState()
      asking.delete(params.request_id)
      if (dropped.delete(params.request_id)) await permissionWithdraw(params.request_id)
      return id
    } finally { asking.delete(params.request_id); dropped.delete(params.request_id) }
  }
  // The prompt was answered elsewhere (in the terminal): the request is withdrawn, the board takes its card away, and a
  // verdict given after that is refused by the core (request-not-pending) and never reaches Claude Code.
  const dropped = new Set()   // withdrawn while still on the way to the hub: withdrawn right after
  async function permissionWithdraw(request_id, reason = 'answered in the terminal') {
    if (asking.has(request_id)) { dropped.add(request_id); return false }
    const id = Object.keys(state.permissions).find(k => state.permissions[k] === request_id)
    if (!id) return false
    delete state.permissions[id]
    saveState()
    return client.withdrawPermission(id, reason)
  }

  // ---- a human's command (already verified and authorised by the core) -> a channel event ------------
  async function command(cmd) {
    const c = cmd.content ?? {}
    const card = cmd.object_id ? model().cards.get(cmd.object_id) : null
    const title = card?.title ?? cmd.object_id ?? ''
    // late: the human had not seen this agent's newest envelope; history: older than what this process had
    // delivered before it lost its state, context only, never a new prompt (README R4).
    // A command in a child session (a helper's) names it, so the main agent hands it to that helper.
    const child = childName(cmd.session_id ?? card?.session_id ?? null)
    const flags = { ...(cmd.late ? { late: '1' } : {}), ...(cmd.history ? { history: '1' } : {}), ...(child ? { session: child } : {}) }
    // (The third argument is for the connector's receipt: which session's command this is, and its number.)
    const send = (content, meta) => notify('notifications/claude/channel', { content: cmd.history ? `(Earlier message, for context only; not a new request.)\n${content}` : content, meta: { ...meta, ...flags } },
      { session_id: cmd.session_id ?? card?.session_id ?? client.session_id ?? null, envelope_number: cmd.envelope_number ?? null })
    // Something a newer Trommi app wrote that this connector cannot read (README "Versioning and compatibility"): the
    // agent hears that it arrived and that the connector needs an update, never a guess at what it meant.
    const unsupported = what => send(`The human sent something on ${card ? `"${title}"` : 'the board'} that this Trommi connector is too old to read (${what}). ${NEEDS_UPDATE}`,
      { kind: 'unsupported', ...(card && mine(card) ? { card_id: card.object_id } : {}), update_required: '1' })
    switch (cmd.command) {
      case 'unsupported': return unsupported(cmd.what ?? 'a newer format')
      case 'message': {
        // A chat item of a content type (or schema) this version does not know: said, not dropped.
        if (cmd.unsupported && cmd.timeline_key?.startsWith('chat:')) return unsupported(cmd.unsupported)
        // Only a message counts as chat; strokes and other timeline items are never commands (README R1/R4).
        if (c.content_type && c.content_type !== 'message') return log(`timeline item ${c.content_type} not relayed`)
        // A human's present_card on a card it had handed back is "take back": the agent need not rework it (as today's board).
        if (c.present_card && mine(card)) return send(`The human took "${title}" back; there is no need to rework or explain it.`, { kind: 'handback_withdrawn', card_id: card.object_id })
        const got = await download(c.attachments)
        const about = card && mine(card) && card.object_state === 'open' ? { card_id: card.object_id } : {}
        const copied = listArg(c.copied_cards, 'copied_cards')
        const marks = listArg(c.marks, 'marks')
        const text = String(c.text ?? '').trim()
        return send([
          text || (got.names.length ? uploadLine(got) : copied.length ? `The human passes ${copied.length === 1 ? 'a card' : `${copied.length} cards`} on to you.` : 'The human pinned notes to the card.'),
          ...marksBlock(card, marks),
          ...copied.flatMap(k => ['', typeof k === 'string' ? k : k.text ?? JSON.stringify(k)]),
        ].join('\n'), {
          kind: 'chat', ...about, ...(about.card_id && c.hand_back ? { handback: '1' } : {}), ...(about.card_id && c.explain ? { explain: '1' } : {}),
          ...(marks.length ? { marks: String(marks.length) } : {}),
          ...(copied.length ? { cards: copied.map(k => k.object_id ?? k.id ?? '').join(','), cards_json: JSON.stringify(copied) } : {}),
          ...fileMeta(got),
        })
      }
      case 'answer': case 'trust': {
        const choices = cmd.choices ?? c.choices ?? []
        if (cmd.command === 'trust' || c.trusted) {
          const advised = [card?.recommended ?? []].flat()
          const labels = advised.map(k => `${card?.options?.find(o => o.key === k)?.label ?? k} [${k}]`)
          return send([
            `The human trusts you with "${title}": decide yourself (${advised.length ? `your advice was: ${labels.join(', ')}` : 'you gave no advice'}). Say in one line what you chose with reply and this card_id, then close_card; do not ask again.`,
            ...(c.note ? ['', `Their note: ${c.note}`] : []),
          ].join('\n'), { kind: 'decision', card_id: cmd.object_id, choice: choices[0] ?? advised[0] ?? '', ...(card?.allows_multiple ? { choices: (choices.length ? choices : advised).join(',') } : {}), trust: '1' })
        }
        const got = await download(c.attachments)
        const notes = c.option_notes && typeof c.option_notes === 'object' ? c.option_notes : {}
        const remarked = (card?.options ?? []).filter(o => notes[o.key])
        const marks = listArg(c.marks, 'marks')
        // A final answer closed the card itself (closed="1"): the agent hears the choice and that nothing is left to do.
        return send([
          c.note || `Decision on "${title}": ${choices.join(', ')}`,
          ...(cmd.settled ? ['', 'This answer settled the card: you marked the choice as final, so the card is closed already. Nothing is expected of you: no close_card, no reply.'] : []),
          ...(remarked.length ? ['', 'Notes on options:', ...remarked.map(o => `- ${o.label} [${o.key}], ${choices.includes(o.key) ? 'chosen' : 'not chosen'}: ${String(notes[o.key]).replace(/\s*\n\s*/g, ' ')}`)] : []),
          ...marksBlock(card, marks),
        ].join('\n'), {
          kind: 'decision', card_id: cmd.object_id, choice: choices[0] ?? '', ...(card?.allows_multiple ? { choices: choices.join(',') } : {}), ...(cmd.settled ? { closed: '1' } : {}),
          ...(remarked.length ? { option_notes: remarked.map(o => o.key).join(',') } : {}), ...(marks.length ? { marks: String(marks.length) } : {}), ...fileMeta(got),
        })
      }
      case 'read':
        return send(`The human read "${title}" and closed it. Nothing is expected of you.`, { kind: 'info_read', card_id: cmd.object_id })
      case 'shred': {
        const got = await download(c.attachments)
        const marks = listArg(c.marks, 'marks')
        return send([
          card?.card_type === 'info' ? `The human threw "${title}" away unread. Do not send it again.`
            : `The human threw the question "${title}" away unanswered. That is neither a yes nor a no. Do not ask it again, in these or other words; carry on without an answer, using your own judgement, or drop the matter.`,
          ...(c.note ? ['', `Their note: ${c.note}`] : []),
          ...marksBlock(card, marks),
        ].join('\n'), { kind: 'shredded', card_id: cmd.object_id, ...(marks.length ? { marks: String(marks.length) } : {}), ...fileMeta(got) })
      }
      case 'decide_again': {
        const was = card?.answers?.findLast(a => a.taken_back_at != null) ?? null
        // An info read and then taken back lies unread again; the agent has nothing to undo and is not told (as today's board).
        if (card?.card_type === 'info' && was?.answer_action === 'read') return
        const previous = cmd.previous_choices ?? was?.choices ?? []
        if (was?.answer_action === 'shred') {
          return send(`The human took "${title}" back out of the shredder; it is open again${card?.card_type === 'info' ? '' : ' and they may answer it after all'}.`, { kind: 'decision_reopened', card_id: cmd.object_id, previous_choice: '', shredded: '1' })
        }
        if (was?.trusted) {
          return send(`The human took back leaving "${title}" to you. Stop acting on what you chose, undo what you safely can, and wait for their answer.`, { kind: 'decision_reopened', card_id: cmd.object_id, previous_choice: previous[0] ?? '', ...(card?.allows_multiple ? { previous_choices: previous.join(',') } : {}), trust: '1' })
        }
        const label = previous.map(k => card?.options?.find(o => o.key === k)?.label ?? k).join(', ')
        return send(`The human took back their answer "${label}" on "${title}". Stop acting on it, undo what you safely can, and wait for the new choice.`, {
          kind: 'decision_reopened', card_id: cmd.object_id, previous_choice: previous[0] ?? '', ...(card?.allows_multiple ? { previous_choices: previous.join(',') } : {}),
        })
      }
      case 'verdict': {
        const request_id = state.permissions[cmd.object_id]
        if (!request_id) return log(`verdict for an unknown permission request ${cmd.object_id}`)
        delete state.permissions[cmd.object_id]
        saveState()
        return notify('notifications/claude/channel/permission', { request_id, behavior: cmd.allow ?? c.allow ? 'allow' : 'deny' })
      }
      case 'selection_sent': {
        const got = await download(c.attachments)
        return send(String(c.text ?? '').trim() || 'The human selected part of the Scribble Board and sent it to you. image_path shows exactly the selection.', {
          kind: 'scribble', ...(typeof c.board === 'string' && /^desk\/[0-9a-f]{32}$/.test(c.board) ? { board: c.board } : {}), message_id: String(cmd.envelope_number), elements: listArg(c.stroke_ids, 'stroke_ids').join(','), ...fileMeta(got),
        })
      }
    }
    log(`command ${cmd.command} not relayed`)
  }

  return { callTool, permissionRequest, permissionWithdraw, command }
}
