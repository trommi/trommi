// Words and small rules the views share: what a card says in one line, how a label fits a tile, the light
// markdown agents write as safe HTML. The rules are those of the old client (js/ui.js, js/inbox.js); the
// output is strings made with html`` (html.mjs), so every piece of board content is escaped.
import { html, raw, esc } from './html.mjs'
import { pointingHandSvg, sketchSvg, loopPath, penSeed } from '../../client/web/js/pen.js'

/** The microphone for live dictation into the field with this id (controller "dictate"; css/speech.css).
 *  Only where the hub has a speech service: pass model.state.speech. */
export const micButton = (fieldId, speech) => (speech ? html`<button class="dictate-mic" type="button" data-controller="dictate" data-dictate-field-value="${fieldId}" data-action="pointerdown->dictate#keep click->dictate#toggle" aria-pressed="false" aria-label="Dictate: speak, the words appear as you talk" title="Dictate: speak, the words appear as you talk"><svg viewBox="0 0 32 32" class="dictate-ring" aria-hidden="true"><path d="${loopPath(penSeed(`dictate:${fieldId}`), { rad: 14.2 })}"/></svg>${raw(sketchSvg('mic'))}</button>` : '')

// ---- the board's words (one place; the old client has them in js/ui.js) ----
export const WORDS = {
  later: 'Snooze', wake: 'Wake up', ack: 'Acknowledge', what: 'What??', trust: 'I don’t give a duck', revise: 'Revise',
  revising: 'In revision', shred: 'Shred', walk: 'Next', desk: 'Desk', takeBack: 'Take back',
}
export const EXPLAIN_TEXT = 'Explain this question in more detail and in plain words: what it is about, what each option means for me, and what you would do.'

export const isKnock = card => card.kind === 'permission' || card.urgency === 'high' || card.urgency === 'critical'
export const knockWord = card => (card.kind === 'permission' ? 'Knock! Permission' : card.urgency === 'critical' ? 'Knock! Blocking' : card.urgency === 'high' ? 'Knock' : null)
export const knocksText = n => (n === 1 ? '1 knock' : `${n} knocks`)
export const cardNr = card => `Nr. ${card.number}`
export const cardNote = card => [card.merged_from?.length ? `replaces ${card.merged_from.length} questions` : '', card.revised ? 'revised' : ''].filter(Boolean).join(' · ')
export const kindOf = a => a.kind ?? (a.image ? 'image' : 'file')
export const advisedKeys = card => [].concat(card.recommended ?? [])
export const advisedLabels = card => card.options.filter(o => advisedKeys(card).includes(o.key)).map(o => o.label).join(', ')

export function ago(ts, now = Date.now()) {
  const min = Math.round((now - ts) / 60000)
  if (min < 1) return 'just now'
  if (min < 60) return `${min} min ago`
  if (min < 1440) return `${Math.round(min / 60)} h ago`
  return new Date(ts).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })
}
/** A time that keeps itself current in the page (island "ago" in t/boot.js reads data-ts). */
export const agoSpan = (ts, cls = 'ago') => html`<span class="${cls}" data-ts="${ts}">${ago(ts)}</span>`

// ---- links ----
const ASSET_URL = /^(https?:\/\/[^\/\s]+)?\/a\/([A-Za-z0-9_-]{16,64})#([A-Za-z0-9_-]{43})$/
const ASSET_LABEL = { html: 'Page', image: 'Picture', video: 'Video', audio: 'Audio', file: 'File' }
/** What a URL points at: one of the board's published assets ({ asset }) or anything else ({ text }, short). */
export function linkInfo(url, assets = []) {
  const m = ASSET_URL.exec(url)
  if (m) {
    const record = assets.find(a => a.id === m[2])
    if (record || !m[1]) return { asset: { id: m[2], href: `/a/${m[2]}#${m[3]}`, title: record?.title || '', type: record?.type ?? null } }
  }
  let text = url.replace(/^https?:\/\/(www\.)?/, '').replace(/[?#].*$/, '').replace(/\/$/, '')
  if (text.length > 34) text = `${text.slice(0, 33)}…`
  return { text }
}
const HTML_FENCE = /```html[^\n]*\n[\s\S]*?```/gi
const ROW = /^\s*\|.*\|\s*$/, RULE = /^\s*\|?[\s:|-]*-[\s:|-]*\|?\s*$/
const withoutLayouts = text => {
  const lines = String(text ?? '').replace(HTML_FENCE, ' ').split('\n')
  return lines.filter((l, i) => !(ROW.test(l) || (l.includes('-') && RULE.test(l) && (lines[i - 1] ?? '').includes('|')))).join('\n')
}
const tidyLinks = (text, assets) => withoutLayouts(text).replace(/`?(https?:\/\/[^\s<>)`]+)`?/g, (_, url) => {
  const info = linkInfo(url, assets)
  return info.asset ? `[${info.asset.title || (ASSET_LABEL[info.asset.type] ?? 'published link')}]` : info.text
})
/** A text as one line of plain words: no fences, no markup signs, links as what they are. */
export const plain = (text, assets) => tidyLinks(String(text ?? '').replace(/```[\s\S]*?```/g, ' '), assets).replace(/(?<![\w.])__(?=\S)([^_\n]+?)__/g, '$1').replace(/[*`#]/g, '').replace(/\s+/g, ' ').trim()

// ---- tiles: how the labels of a two-way question stand under the thumbs (inbox.js) ----
const fits = (label, width, lines) => {
  let n = 1, used = 0
  for (const word of String(label).trim().replace(/-(?=\S)/g, '- ').split(/\s+/)) {
    if (word.length > width) return false
    if (used && used + 1 + word.length > width) { n++; used = word.length } else used += (used ? 1 : 0) + word.length
  }
  return n <= lines
}
export const fitsTile = label => fits(label, 14, 2)
export const labelSize = options => (options.every(o => fitsTile(o.label)) ? 'usual' : options.every(o => fits(o.label, 17, 3)) ? 'small' : 'none')
export const BARE = /^(yes|no|ok|okay|allow|deny|ja|nein)$/i
export const shortOf = o => { const s = String(o.short ?? '').trim(); return s.length <= 18 ? s : '' }
export const quick = card => !card.multiple && (card.kind === 'permission' || card.options.length === 2)

// ---- what a card carries besides its words ----
const many = (n, one, more = `${one}s`) => (n === 1 ? `1 ${one}` : `${n} ${more}`)
export function richMark(card) {
  const sections = card?.sections ?? []
  const texts = [card?.body, ...sections.map(s => s?.text)].filter(Boolean).join('\n\n')
  const blocks = [...(texts.match(HTML_FENCE) ?? []), card?.html, ...sections.map(s => s?.html)].filter(Boolean)
  if (blocks.some(b => !/<table\b/i.test(b))) return 'layout'
  if (blocks.length) return 'table'
  const lines = texts.replace(/```[\s\S]*?```/g, '').split('\n')
  return lines.some((l, i) => ROW.test(l) && RULE.test(lines[i + 1] ?? '') && (lines[i + 1] ?? '').includes('-')) ? 'table' : null
}
export function carries(card, assets = []) {
  const list = card.attachments ?? [], count = kind => list.filter(a => kindOf(a) === kind).length
  const body = String(card.body ?? '').replace(/```[\s\S]*?```/g, '')
  const pages = new Set((body.match(/https?:\/\/[^\s<>)`]+|(?<=`)\/a\/[^\s`]+/g) ?? []).map(u => linkInfo(u.replace(/[.,;:!?]+$/, ''), assets).asset?.id).filter(Boolean)).size
  const table = richMark(card)
  return [
    count('image') && { icon: 'picture', text: many(count('image'), 'picture') },
    count('video') && { icon: 'play', text: many(count('video'), 'video') },
    count('audio') && { icon: 'play', text: many(count('audio'), 'recording') },
    count('file') && { icon: 'page', text: many(count('file'), 'file') },
    pages && { icon: 'page', text: many(pages, 'page') },
    table && { icon: 'grid', text: table === 'layout' ? 'a layout' : 'a table' },
  ].filter(Boolean)
}

// ---- the light markdown agents write (ui.js rich), as safe HTML ----
// Paragraphs, bullet lists, **bold**, `code`, fenced code, tables, bare links, paths to pages of this board,
// __underlined__ words. A block fenced as html is the agent's own layout: it is NOT put into the page. It
// stands as an inert holder with its source in a data attribute, and the controller "richhtml" shows it in the
// sandboxed frame of js/richhtml.js, exactly as the old client does.
const UNDER = /(?<![\w.])__(?=\S)([^_\n]+?)(?<=\S)__(?=$|[\s,;:!?)\]]|\.(?:\s|$))/gm
const INLINE = /(\[[^\]\n]+\]\((?:https?:\/\/[^\s)]+|\/[^\s)]*)\))|(?<![\w*])\*(?=[^\s*])([^*\n]+?)(?<=[^\s*])\*(?![\w*])|(`[^`\n]+`)|(\*\*[^*\n]+\*\*)|(https?:\/\/[^\s<>)]+)|((?<![\w.])__(?=\S)[^_\n]+?(?<=\S)__(?=$|[\s,;:!?)\]]|\.(?:\s|$)))|((?<![\w\/:.~\-])\/(?:[\w\-.]+\/)*[\w\-.]+\.html?(?:\?[\w\-.=&%+]*)?(?:#[\w\-.=&%+]*)?)/gm
const pathLink = path => html`<a href="${path}" target="_blank" rel="noopener">${path}</a>`
function linkTo(url, ctx) {
  const info = linkInfo(url, ctx.assets)
  if (info.asset) return html`<a class="asset-link" href="${info.asset.href}" target="_blank" rel="noopener">${info.asset.title || (ASSET_LABEL[info.asset.type] ?? 'Published link')}</a>`
  return html`<a href="${url}" target="_blank" rel="noopener noreferrer" title="${url}">${info.text}</a>`
}
function inline(text, ctx) {
  const out = []
  let last = 0
  for (const m of text.matchAll(INLINE)) {
    out.push(text.slice(last, m.index))
    const [, md, em, code, bold, url, under, path] = m
    if (md) {
      // [label](target): the label is the link's words; a published asset keeps its chip, with the label as its title.
      const [, label, target] = /^\[([^\]]+)\]\((.+)\)$/.exec(md)
      const info = /^https?:/.test(target) ? linkInfo(target, ctx.assets) : null
      if (info?.asset) out.push(html`<a class="asset-link" href="${info.asset.href}" target="_blank" rel="noopener">${label}</a>`)
      else out.push(html`<a href="${target}" target="_blank" rel="noopener${/^https?:/.test(target) ? ' noreferrer' : ''}" title="${target}">${label}</a>`)
    }
    else if (em) out.push(html`<em>${inline(em, ctx)}</em>`)
    else if (code && /^`https?:\/\/[^\s`]+`$/.test(code)) out.push(linkTo(code.slice(1, -1), ctx))
    else if (code && /^`\/[\w\-./#?=&%+]+\.html?([#?][^\s`]*)?`$/.test(code)) out.push(pathLink(code.slice(1, -1)))
    else if (path) { const p = path.replace(/[.,;:!?]+$/, ''); out.push(pathLink(p), path.slice(p.length)) }
    else if (code) out.push(html`<code>${code.slice(1, -1)}</code>`)
    else if (bold) out.push(html`<strong>${inline(bold.slice(2, -2), ctx)}</strong>`)
    else if (under) out.push(ctx.underlining ? html`<span class="rich-under">${inline(under.slice(2, -2), ctx)}</span>` : inline(under.slice(2, -2), ctx))
    else { const u = url.replace(/[.,;:!?]+$/, ''); out.push(linkTo(u, ctx), url.slice(u.length)) }
    last = m.index + m[0].length
  }
  out.push(text.slice(last))
  return html`${out}`
}
/** text: what the agent wrote. extra: an html field that belongs under it (card.html, section.html). */
export function rich(text, { assets = [], extra = '', hand = true } = {}) {
  const source = `${String(text ?? '')}${extra ? `\n\n\`\`\`html\n${extra}\n\`\`\`` : ''}`
  const prose = source.replace(/```[\s\S]*?```/g, '')
  const under = [...prose.matchAll(UNDER)].reduce((n, m) => n + m[1].length, 0)
  // hand: false in a conversation (the comments under a card): sober there, no drawn hand.
  const ctx = { assets, hand, underlining: under * 3 <= prose.replace(/\s+/g, ' ').length }
  const langs = [...source.matchAll(/```([^\n]*)\n?/g)].map(m => m[1].trim().toLowerCase())
  const blocks = []
  source.split(/```[^\n]*\n?/).forEach((chunk, i) => {
    if (i % 2) {
      if (langs[i - 1] === 'html') return blocks.push(html`<div class="rich-html" data-controller="richhtml" data-richhtml-source-value="${chunk}"><noscript>A layout from the agent; it needs scripts to show.</noscript></div>`)
      return blocks.push(html`<pre><code>${chunk.replace(/\n$/, '')}</code></pre>`)
    }
    for (const block of chunk.split(/\n{2,}/)) {
      const lines = block.split('\n').filter(l => l.trim())
      if (!lines.length) continue
      const cells = l => l.trim().replace(/^\||\|$/g, '').split('|').map(c => c.trim())
      if (lines.length > 1 && lines.every(l => ROW.test(l)) && RULE.test(lines[1])) {
        blocks.push(html`<div class="rich-table-wrap"><table class="rich-table"><thead><tr>${cells(lines[0]).map(c => html`<th>${inline(c, ctx)}</th>`)}</tr></thead><tbody>${lines.slice(2).map(l => html`<tr>${cells(l).map(c => html`<td>${inline(c, ctx)}</td>`)}</tr>`)}</tbody></table></div>`)
      } else if (/^\s*☞/.test(lines[0]) && !ctx.pointed && ctx.hand) {
        // "☞ " before a paragraph is the agent's mark for the one that matters: the drawn hand points at it. Once per text.
        ctx.pointed = true
        blocks.push(html`<p class="rich-point">${raw(pointingHandSvg())}${inline(lines.join('\n').replace(/^\s*☞\s*/, ''), ctx)}</p>`)
      } else {
        // Lines that are items of a list (- or *, or 1. 2.) make a list; the lines around them stay paragraphs.
        const kind = l => (/^\s*[-*]\s+/.test(l) ? 'ul' : /^\s*\d{1,3}[.)]\s+/.test(l) ? 'ol' : 'p')
        const runs = []
        for (const l of lines) { const k = kind(l); if (runs.at(-1)?.k === k) runs.at(-1).lines.push(l); else runs.push({ k, lines: [l] }) }
        for (const { k, lines: part } of runs) {
          if (k === 'p') blocks.push(html`<p>${inline(part.join('\n').replace(/^\s*☞\s*/, ''), ctx)}</p>`)
          else {
            const items = part.map(l => html`<li>${inline(l.replace(/^\s*(?:[-*]|\d{1,3}[.)])\s+/, ''), ctx)}</li>`)
            const start = k === 'ol' ? Number(/^\s*(\d+)/.exec(part[0])[1]) : 1
            blocks.push(k === 'ol' ? html`<ol${start !== 1 ? html` start="${start}"` : ''}>${items}</ol>` : html`<ul>${items}</ul>`)
          }
        }
      }
    }
  })
  return html`<div class="rich">${blocks}</div>`
}
export { html, raw, esc }
