// Navigation, forms, frames and live updates of the app (what Turbo Drive, Frames and the stream did for the hub's
// pages, done in the page):
//   - a link of the app (same origin) renders its page from the local model: no request leaves the device;
//   - the page's body is patched by parts (topbar, sidebar, main, …): a part whose markup did not change stays;
//   - a form is answered by the board's handlers (public/js/app/board.mjs): stream actions, a redirect, or a page;
//   - after every change of the core only the elements that changed are replaced (board.live → <turbo-stream>);
//   - fetch() calls of the controllers to the hub's old JSON routes (/memo, /desk, a card's draft) are answered here.
import { bodyParts, CSS } from './layout.mjs'
import { useSheets } from './sheets.mjs'
import { setVisitor, setRefresher, renderStreamMessage } from './turbo.mjs'

const STREAM_ACCEPT = 'text/vnd.turbo-stream.html, text/html, application/xhtml+xml'
const fire = (target, name, detail = {}, cancelable = false) => { const e = new CustomEvent(name, { bubbles: true, cancelable, detail }); target.dispatchEvent(e); return e }
const isAppPath = p => !/\.(?:css|js|mjs|json|png|svg|jpe?g|webp|gif|woff2?|webmanifest|html|txt|csv|log|ico)$/i.test(p) && !p.startsWith('/mock/') && !p.startsWith('/vendor/') && !p.startsWith('/att/')

export function createRouter({ board, onPage = () => {}, beforeVisit = () => {}, flush = () => {} }) {
  let page = null          // { path, client: { view, params }, opts }
  const parts = new Map()  // key -> { html, nodes: [Node] }

  // ---- painting a page ----
  function enableCss(name) {
    useSheets([...(CSS[name] ?? CSS.base), 'turbo', 'fonts', 'push', 'trommi', 'room', 'news', 'gallery', 'whiteboard'])
  }
  // Each part stands between two comments (<!--p:key--> … <!--/p:key-->), so what a stream put in its place
  // still belongs to it.
  const between = part => { const out = []; for (let n = part.start; n; n = n.nextSibling) { out.push(n); if (n === part.end) break } return out }
  function paintBody(list) {
    const body = document.body
    const keep = new Set(list.map(p => p.key))
    for (const [key, part] of parts) if (!keep.has(key)) { for (const n of between(part)) n.remove(); parts.delete(key) }
    let anchor = body.firstChild
    for (const { key, html } of list) {
      let part = parts.get(key)
      if (part && key === 'says') {
        // Toasts stay across pages (data-turbo-permanent); one the new page brings (?said=…) joins them on top.
        const t = document.createElement('template')
        t.innerHTML = html
        const fresh = t.content.firstElementChild, host = document.getElementById('says-host')
        if (fresh?.childNodes.length && host) host.prepend(...fresh.childNodes)
      }
      if (part && (key === 'says' || part.html === html)) {
        // Kept (toasts always stay across pages, like data-turbo-permanent): moved into place if needed.
        if (part.start !== anchor) for (const n of between(part)) body.insertBefore(n, anchor)
        anchor = part.end.nextSibling
        continue
      }
      const t = document.createElement('template')
      t.innerHTML = html
      const start = document.createComment(`p:${key}`), end = document.createComment(`/p:${key}`)
      if (part) { anchor = part.end.nextSibling; for (const n of between(part)) n.remove() }
      if (anchor && !anchor.isConnected) anchor = null
      body.insertBefore(start, anchor)
      body.insertBefore(t.content, anchor)
      body.insertBefore(end, anchor)
      parts.set(key, { html, start, end })
      anchor = end.nextSibling
    }
  }
  // A part a stream changed no longer holds the markup it was painted with.
  const forget = streams => {
    for (const [, id] of String(streams).matchAll(/<turbo-stream action="[a-z]+" target="([^"]+)"/g)) {
      const el = document.getElementById(id)
      if (!el) continue
      for (const part of parts.values()) if (part.html != null && between(part).some(n => n === el || n.contains?.(el))) part.html = null
    }
  }
  function paint(path, opts, { scroll = 'top' } = {}) {
    fire(document, 'turbo:before-cache')
    document.title = opts.title ?? 'Trommi'
    enableCss(opts.css ?? (opts.view === 'agents' ? 'agents' : 'base'))
    const body = document.body
    body.dataset.view = 'chat'
    body.dataset.scope = opts.scope ?? 'all'
    body.dataset.tView = opts.view
    body.dataset.tBase = ''
    for (const a of [...body.attributes]) if (a.name.startsWith('data-') && !['data-view', 'data-scope', 'data-t-view', 'data-t-base'].includes(a.name)) body.removeAttribute(a.name)
    for (const [, name, value] of String(opts.bodyAttrs ?? '').matchAll(/([\w-]+)="([^"]*)"/g)) body.setAttribute(name, value)
    paintBody(bodyParts({ ...opts, base: '' }))
    const params = new URLSearchParams(`view=${opts.view}${opts.sidebar === false ? '' : '&bar=1'}${opts.stream ?? ''}`)
    page = { path, client: { view: opts.view, params }, opts }
    board.live(page.client, { reset: true })
    if (scroll === 'top') window.scrollTo(0, 0)
    else if (typeof scroll === 'number') requestAnimationFrame(() => window.scrollTo(0, scroll))
    // As Turbo does: the first [autofocus] element of the new page gets the keyboard.
    const auto = document.querySelector('main [autofocus], [autofocus]')
    if (auto && !auto.closest('[hidden], dialog:not([open])')) auto.focus({ preventScroll: true })
    fire(document, 'turbo:render')
    fire(document, 'turbo:load', { url: location.href })
    onPage(page)
  }

  // ---- visiting ----
  let visiting = 0
  async function visit(path, { action = 'advance', scroll } = {}) {
    const url = new URL(path, location.href)
    if (url.origin !== location.origin) { location.href = url.href; return }
    const to = url.pathname + url.search + url.hash
    if (action !== 'restore' && fire(document, 'turbo:before-visit', { url: url.href }, true).defaultPrevented) return
    const mine = ++visiting
    flush()   // what an action just changed is in the state before the page is rendered
    beforeVisit(url)
    const tq = performance.now()
    const res = await board.request({ method: 'GET', path: url.pathname + url.search, headers: { accept: 'text/html' } })
    const tr = performance.now()
    if (mine !== visiting) return
    if (res.kind === 'redirect') return visit(res.to, { action: action === 'restore' ? 'replace' : action === 'advance' ? 'replace-after' : action })
    if (action === 'advance') { saveScroll(); history.pushState({ trommi: true, scroll: 0 }, '', to) }
    else if (action === 'replace' || action === 'replace-after') { if (action === 'replace-after') saveScroll(); history[action === 'replace-after' ? 'pushState' : 'replaceState']({ trommi: true, scroll: 0 }, '', to) }
    if (res.kind === 'page') paint(to, res.opts, { scroll: scroll ?? (action === 'restore' ? history.state?.scroll ?? 0 : 'top') })
    else paint(to, { title: 'Not found · Trommi', view: 'missing', main: '<main id="inbox" aria-label="Not found"><header class="inbox-head"><div class="inbox-title"><h2>Not here.</h2><p><a href="/" data-nav>Back to the Desk</a></p></div></header></main>', model: board.t.model() })
    if (url.hash) document.getElementById(decodeURIComponent(url.hash.slice(1)))?.scrollIntoView({ block: 'center' })
    if (window.trommi) window.trommi.lastVisit = { render: tr - tq, paint: performance.now() - tr }
  }
  const saveScroll = () => { try { history.replaceState({ ...(history.state ?? {}), trommi: true, scroll: window.scrollY }, '') } catch {} }
  /** The page in view, rendered again from the model (a stream's "refresh", or after the room changed under it). */
  async function refresh() {
    if (!page) return
    const res = await board.request({ method: 'GET', path: page.path, headers: { accept: 'text/html' } })
    if (res.kind === 'page') { const y = window.scrollY; paint(page.path, res.opts, { scroll: y }) }
    else if (res.kind === 'redirect') visit(res.to, { action: 'replace' })
  }
  setVisitor((path, opts) => visit(path, { action: opts.action === 'replace' ? 'replace' : 'advance' }))
  setRefresher(refresh)
  addEventListener('popstate', () => visit(location.pathname + location.search + location.hash, { action: 'restore' }))
  if ('scrollRestoration' in history) history.scrollRestoration = 'manual'

  // ---- frames ----
  async function frameVisit(frame, path) {
    const res = await board.request({ method: 'GET', path, headers: { accept: 'text/html', 'turbo-frame': frame.id } })
    let markup = ''
    if (res.kind === 'html') markup = res.body
    else if (res.kind === 'page') markup = bodyParts({ ...res.opts, base: '' }).map(p => p.html).join('')
    else if (res.kind === 'redirect') return visit(res.to)
    const t = document.createElement('template')
    t.innerHTML = markup
    const fresh = t.content.querySelector(`turbo-frame#${globalThis.CSS.escape(frame.id)}`)
    if (!fresh) return visit(path)
    frame.replaceChildren(...fresh.childNodes)
    fire(frame, 'turbo:frame-load')
  }
  const frameOf = (el, url) => {
    const name = el.getAttribute('data-turbo-frame') ?? el.closest('form')?.getAttribute('data-turbo-frame')
    if (name === '_top') return null
    if (name) return document.getElementById(name)
    const frame = el.closest('turbo-frame')
    if (!frame || frame.getAttribute('target') === '_top') return null
    return frame
  }

  // ---- links ----
  document.addEventListener('click', e => {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return
    const a = e.target instanceof Element ? e.target.closest('a[href]') : null
    if (!a || a.target && a.target !== '_self' || a.hasAttribute('download') || a.getAttribute('data-turbo') === 'false' || a.closest('[data-turbo="false"]')) return
    const url = new URL(a.href, location.href)
    if (url.origin !== location.origin || !isAppPath(url.pathname)) return
    if (url.pathname === location.pathname && url.search === location.search && url.hash) return   // a jump within the page
    e.preventDefault()
    const frame = frameOf(a, url)
    if (frame) {
      // A frame link with data-turbo-action also moves the address (a picture switched in place: ?pic=n survives a reload).
      const promote = a.getAttribute('data-turbo-action')
      return frameVisit(frame, url.pathname + url.search).then(() => { if (promote) { saveScroll(); history[promote === 'advance' ? 'pushState' : 'replaceState']({ trommi: true, scroll: window.scrollY }, '', url.pathname + url.search); if (page) page.path = url.pathname + url.search } })
    }
    visit(url.pathname + url.search + url.hash, { action: a.getAttribute('data-turbo-action') === 'replace' ? 'replace' : 'advance' })
  })

  // ---- forms ----
  async function submitForm(form, submitter) {
    const method = (submitter?.getAttribute('formmethod') ?? form.getAttribute('method') ?? 'get').toLowerCase()
    const action = new URL(submitter?.getAttribute('formaction') ?? form.getAttribute('action') ?? location.pathname, location.href)
    const data = new FormData(form, submitter ?? undefined)
    if (method === 'get') {
      const q = new URLSearchParams()
      for (const [k, v] of data) if (typeof v === 'string') q.append(k, v)
      const path = `${action.pathname}?${q}`
      const frame = frameOf(form, action)
      return frame ? frameVisit(frame, path) : visit(path)
    }
    const formSubmission = { formElement: form, submitter, method, location: action }
    fire(form, 'turbo:submit-start', { formSubmission })
    let res, error = null
    try { res = await board.request({ method: 'POST', path: action.pathname + action.search, form: data, headers: { accept: STREAM_ACCEPT, referer: location.href } }) }
    catch (err) { error = err; console.error('form', err) }
    const success = !error && res && res.code < 400
    flush()
    if (res?.kind === 'stream') { forget(res.body); renderStreamMessage(res.body) }
    else if (res?.kind === 'redirect') await visit(res.to)
    else if (res?.kind === 'page') { history.replaceState({ trommi: true }, '', location.href); paint(location.pathname + location.search, res.opts, { scroll: window.scrollY }) }
    fire(form.isConnected ? form : document, 'turbo:submit-end', { formSubmission, success, fetchResponse: res ? { response: { status: res.code } } : null, error })
  }
  document.addEventListener('submit', e => {
    if (e.defaultPrevented) return
    const form = e.target
    if (!(form instanceof HTMLFormElement) || (form.method === 'dialog') || form.getAttribute('data-turbo') === 'false') return
    const action = new URL(form.getAttribute('action') ?? location.pathname, location.href)
    if (action.origin !== location.origin) return
    e.preventDefault()
    submitForm(form, e.submitter)
  })

  // ---- the controllers' fetch() to the hub's routes ----
  const realFetch = window.fetch.bind(window)
  window.fetch = async (input, init = {}) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? String(input) : input.url, location.href)
    const method = (init.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase()
    if (url.origin !== location.origin || method !== 'POST' || !isAppPath(url.pathname)) return realFetch(input, init)
    if (url.pathname === '/memo' || url.pathname === '/desk') {
      const body = JSON.parse(String(init.body ?? '{}'))
      const out = url.pathname === '/memo' ? await board.t.hub.memo(body) : await board.t.hub.desk(body).then(d => ({ code: 200, text: JSON.stringify(d) }), err => ({ code: err.status ?? 400, text: JSON.stringify({ error: err.message }) }))
      return new Response(out.text, { status: out.code, headers: { 'Content-Type': 'application/json' } })
    }
    let form
    if (init.body instanceof FormData) form = init.body
    else { form = new FormData(); for (const [k, v] of new URLSearchParams(typeof init.body === 'string' || init.body instanceof URLSearchParams ? init.body : '')) form.append(k, v) }
    const res = await board.request({ method: 'POST', path: url.pathname + url.search, form, headers: { accept: String(new Headers(init.headers ?? {}).get('accept') ?? STREAM_ACCEPT) } })
    if (res.kind === 'missing') return new Response('not found', { status: 404 })
    return new Response(res.code === 204 ? null : res.body ?? '', { status: res.code, headers: { 'Content-Type': res.kind === 'stream' ? 'text/vnd.turbo-stream.html' : 'text/html' } })
  }

  /** After the core changed: the elements of this page that changed (nothing else is touched). */
  function changed() {
    if (!page) return
    const streams = board.live(page.client)
    if (streams) { forget(streams); renderStreamMessage(streams) }
  }
  return { visit, refresh, changed, get page() { return page }, paint }
}
