// A small stand-in for Stimulus (the part of its API the board's controllers use), so the controllers of today's
// board (public/t/controllers, synced from trommi-hub) run unchanged without a framework.
//
// Supported: Application.start() / register(name, Controller); Controller with element, identifier, application,
// initialize/connect/disconnect; static targets (xTarget, xTargets, hasXTarget, xTargetConnected/Disconnected);
// static values (xValue get/set, types String/Number/Boolean/Array/Object, defaults, xValueChanged); this.dispatch;
// data-action descriptors "event->id#method", "id#method" (default event of the element), "event@document",
// "event@window", key filters ("keydown.esc"), options ":prevent :stop :once :self"; action params
// (data-id-name-param, typed, in event.params).
//
// How: one MutationObserver on the document. Controllers are created for [data-controller] elements once their
// class is registered (lazy registration works); actions are bound per element and find their controller when the
// event fires (the nearest element with that identifier), so a controller registered later still receives them.

const KEYS = { enter: 'Enter', tab: 'Tab', esc: 'Escape', space: ' ', up: 'ArrowUp', down: 'ArrowDown', left: 'ArrowLeft', right: 'ArrowRight', home: 'Home', end: 'End', page_up: 'PageUp', page_down: 'PageDown' }
const camel = s => s.replace(/[-_](\w)/g, (_, c) => c.toUpperCase())
const kebab = s => s.replace(/([A-Z])/g, '-$1').toLowerCase()
const cap = s => s.charAt(0).toUpperCase() + s.slice(1)
const ids = el => (el.getAttribute('data-controller') ?? '').split(/\s+/).filter(Boolean)

function typeOf(def) {
  if (def === String || def === Number || def === Boolean || def === Array || def === Object) return { type: def, fallback: undefined }
  if (def && typeof def === 'object' && 'type' in def) return { type: def.type, fallback: def.default }
  if (typeof def === 'string') return { type: String, fallback: def }
  if (typeof def === 'number') return { type: Number, fallback: def }
  if (typeof def === 'boolean') return { type: Boolean, fallback: def }
  if (Array.isArray(def)) return { type: Array, fallback: def }
  return { type: Object, fallback: def }
}
const EMPTY = new Map([[String, ''], [Number, 0], [Boolean, false], [Array, []], [Object, {}]])
function readValue(type, raw, fallback) {
  if (raw == null) return fallback !== undefined ? (typeof fallback === 'object' && fallback ? structuredClone(fallback) : fallback) : structuredClone(EMPTY.get(type))
  switch (type) {
    case Number: return Number(raw.replace(/_/g, ''))
    case Boolean: return !(raw === '0' || raw === 'false')
    case Array: case Object: try { return JSON.parse(raw) } catch { return structuredClone(EMPTY.get(type)) }
    default: return raw
  }
}
const writeValue = (type, v) => (type === Array || type === Object ? JSON.stringify(v) : String(v))

function typedParam(raw) {
  if (/^-?\d+(\.\d+)?$/.test(raw)) return Number(raw)
  if (raw === 'true') return true
  if (raw === 'false') return false
  if (/^[[{]/.test(raw)) { try { return JSON.parse(raw) } catch {} }
  return raw
}

export class Controller {
  static targets = []
  static values = {}
  constructor(context) { this.context = context }
  get element() { return this.context.element }
  get identifier() { return this.context.identifier }
  get application() { return this.context.application }
  initialize() {}
  connect() {}
  disconnect() {}
  dispatch(eventName, { target = this.element, detail = {}, prefix = this.identifier, bubbles = true, cancelable = true } = {}) {
    const event = new CustomEvent(prefix ? `${prefix}:${eventName}` : eventName, { detail, bubbles, cancelable })
    target.dispatchEvent(event)
    return event
  }
}

// Getters for targets and values, put on a controller class once, when it is registered.
function equip(Klass, identifier) {
  const proto = Klass.prototype
  const targets = new Set()
  const values = {}
  for (let C = Klass; C && C !== Controller; C = Object.getPrototypeOf(C)) {
    for (const t of Object.hasOwn(C, 'targets') ? C.targets : []) targets.add(t)
    for (const [k, v] of Object.entries(Object.hasOwn(C, 'values') ? C.values : {})) if (!(k in values)) values[k] = v
  }
  for (const name of targets) {
    const attr = `data-${identifier}-target`
    const all = function () { return targetsOf(this, attr, name) }
    Object.defineProperty(proto, `${name}Targets`, { configurable: true, get: all })
    Object.defineProperty(proto, `${name}Target`, { configurable: true, get() { const t = all.call(this)[0]; if (!t) throw new Error(`Missing target element "${name}" for "${identifier}" controller`); return t } })
    Object.defineProperty(proto, `has${cap(name)}Target`, { configurable: true, get() { return all.call(this).length > 0 } })
  }
  const valueSpecs = Object.entries(values).map(([name, def]) => ({ name, attr: `data-${identifier}-${kebab(name)}-value`, ...typeOf(def) }))
  for (const spec of valueSpecs) {
    Object.defineProperty(proto, `${spec.name}Value`, {
      configurable: true,
      get() { return readValue(spec.type, this.element.getAttribute(spec.attr), spec.fallback) },
      set(v) { if (v == null) this.element.removeAttribute(spec.attr); else this.element.setAttribute(spec.attr, writeValue(spec.type, v)) },
    })
    Object.defineProperty(proto, `has${cap(spec.name)}Value`, { configurable: true, get() { return this.element.hasAttribute(spec.attr) } })
  }
  Klass.__equipped = { identifier, targets: [...targets], valueSpecs }
}
function targetsOf(controller, attr, name) {
  const root = controller.element, id = controller.identifier
  const out = []
  const sel = `[${attr}~="${name}"]`
  if (root.matches(sel)) out.push(root)
  for (const el of root.querySelectorAll(sel)) {
    // Scoped like Stimulus: a target inside a nested controller of the same identifier belongs to that one.
    const owner = el.parentElement?.closest(`[data-controller~="${id}"]`)
    if (owner === root || (el !== root && el.closest(`[data-controller~="${id}"]`) === el && owner === root)) out.push(el)
  }
  return out
}

export class Application {
  static start(root = document.documentElement) { const app = new Application(root); app.start(); return app }
  constructor(root = document.documentElement) {
    this.root = root
    this.classes = new Map()                 // identifier -> class
    this.live = new Map()                    // element -> Map(identifier -> controller)
    this.bound = new WeakMap()               // element -> { spec, listeners: [{ target, type, fn, opts }] }
    this.boundEls = new Set()
    this.router = { modulesByIdentifier: this.classes }
    this.missing = null                      // fn(identifier): asked for an identifier with no class yet
    this.pending = false
  }
  start() {
    this.observer = new MutationObserver(records => this.mutated(records))
    this.observer.observe(this.root, { childList: true, subtree: true, attributes: true, attributeOldValue: true })
    this.scan(this.root)
  }
  register(identifier, Klass) {
    if (this.classes.has(identifier)) return
    equip(Klass, identifier)
    this.classes.set(identifier, Klass)
    for (const el of this.root.querySelectorAll(`[data-controller~="${identifier}"]`)) this.connectOne(el, identifier)
  }
  getControllerForElementAndIdentifier(el, identifier) { return this.live.get(el)?.get(identifier) ?? null }

  // ---- connecting and disconnecting ----
  connectOne(el, identifier) {
    if (!el.isConnected) return
    const Klass = this.classes.get(identifier)
    if (!Klass) { this.missing?.(identifier); return }
    let mine = this.live.get(el)
    if (mine?.has(identifier)) return
    if (!mine) this.live.set(el, (mine = new Map()))
    const c = new Klass({ element: el, identifier, application: this })
    c.__targets = new Map()
    c.__values = new Map()
    mine.set(identifier, c)
    try { c.initialize() } catch (err) { console.error(`${identifier}#initialize`, err) }
    // Values first (their Changed callbacks run before connect, as in Stimulus), then connect, then targets.
    for (const spec of Klass.__equipped.valueSpecs) {
      const v = c[`${spec.name}Value`]
      c.__values.set(spec.name, JSON.stringify(v))
      const cb = c[`${spec.name}ValueChanged`]
      if (typeof cb === 'function' && (el.hasAttribute(spec.attr) || spec.fallback !== undefined)) { try { cb.call(c, v, undefined) } catch (err) { console.error(`${identifier}#${spec.name}ValueChanged`, err) } }
    }
    try { c.connect() } catch (err) { console.error(`${identifier}#connect`, err) }
    this.syncTargets(c)
  }
  disconnectOne(el, identifier) {
    const mine = this.live.get(el), c = mine?.get(identifier)
    if (!c) return
    mine.delete(identifier)
    if (!mine.size) this.live.delete(el)
    for (const [name, set] of c.__targets) { const cb = c[`${name}TargetDisconnected`]; if (typeof cb === 'function') for (const t of set) { try { cb.call(c, t) } catch (err) { console.error(err) } } }
    try { c.disconnect() } catch (err) { console.error(`${identifier}#disconnect`, err) }
  }
  syncTargets(c) {
    for (const name of c.constructor.__equipped.targets) {
      const on = c[`${name}TargetConnected`], off = c[`${name}TargetDisconnected`]
      if (typeof on !== 'function' && typeof off !== 'function') continue
      const now = new Set(c[`${name}Targets`]), was = c.__targets.get(name) ?? new Set()
      c.__targets.set(name, now)
      if (typeof off === 'function') for (const t of was) if (!now.has(t)) { try { off.call(c, t) } catch (err) { console.error(err) } }
      if (typeof on === 'function') for (const t of now) if (!was.has(t)) { try { on.call(c, t) } catch (err) { console.error(err) } }
    }
  }
  syncValues(c) {
    for (const spec of c.constructor.__equipped.valueSpecs) {
      const v = c[`${spec.name}Value`], key = JSON.stringify(v), old = c.__values.get(spec.name)
      if (key === old) continue
      c.__values.set(spec.name, key)
      const cb = c[`${spec.name}ValueChanged`]
      if (typeof cb === 'function') { try { cb.call(c, v, old === undefined ? undefined : JSON.parse(old)) } catch (err) { console.error(err) } }
    }
  }

  // ---- actions ----
  bind(el) {
    const spec = el.getAttribute('data-action') ?? ''
    const had = this.bound.get(el)
    if (had?.spec === spec) return
    if (had) { for (const l of had.listeners) l.target.removeEventListener(l.type, l.fn, l.opts); this.bound.delete(el); this.boundEls.delete(el) }
    if (!spec.trim() || !el.isConnected) return
    const listeners = []
    for (const d of spec.trim().split(/\s+/)) {
      const m = /^(?:([\w:.\-]+?)(?:@(window|document))?->)?([\w-]+)#([\w$]+)(?::([\w:!]+))?$/.exec(d)
      if (!m) { console.warn('stimulus: bad action', d); continue }
      let [, evName, global, identifier, method, opts] = m
      if (!evName) evName = defaultEvent(el)
      let key = null
      const dot = evName.lastIndexOf('.')
      if (dot > 0 && /^key/.test(evName)) { key = evName.slice(dot + 1); evName = evName.slice(0, dot) }
      const options = new Set((opts ?? '').split(':').filter(Boolean))
      const target = global === 'window' ? window : global === 'document' ? document : el
      const fn = event => {
        if (key && !keyMatches(event, key)) return
        if (options.has('self') && event.target !== el) return
        const host = el.closest(`[data-controller~="${identifier}"]`)
        const c = host && this.live.get(host)?.get(identifier)
        if (!c || typeof c[method] !== 'function') return
        if (options.has('prevent')) event.preventDefault()
        if (options.has('stop')) event.stopPropagation()
        const params = {}
        const prefix = `data-${identifier}-`
        for (const a of el.attributes) if (a.name.startsWith(prefix) && a.name.endsWith('-param')) params[camel(a.name.slice(prefix.length, -6))] = typedParam(a.value)
        try { Object.defineProperty(event, 'params', { value: params, configurable: true }) } catch {}
        c[method](event)
      }
      const lopts = { once: options.has('once'), passive: options.has('passive') || undefined, capture: options.has('capture') || undefined }
      target.addEventListener(evName, fn, lopts)
      listeners.push({ target, type: evName, fn, opts: lopts })
    }
    this.bound.set(el, { spec, listeners })
    this.boundEls.add(el)
  }
  unbind(el) {
    const had = this.bound.get(el)
    if (!had) return
    for (const l of had.listeners) l.target.removeEventListener(l.type, l.fn, l.opts)
    this.bound.delete(el)
    this.boundEls.delete(el)
  }

  // ---- watching the page ----
  scan(root) {
    if (!(root instanceof Element)) return
    const els = root.matches('[data-controller], [data-action]') ? [root] : []
    els.push(...root.querySelectorAll('[data-controller], [data-action]'))
    for (const el of els) {
      if (el.hasAttribute('data-controller')) for (const id of ids(el)) this.connectOne(el, id)
      if (el.hasAttribute('data-action')) this.bind(el)
    }
  }
  mutated(records) {
    let structural = false
    const added = new Set(), touched = new Set()
    for (const r of records) {
      if (r.type === 'childList') {
        structural = true
        for (const n of r.addedNodes) if (n instanceof Element) added.add(n)
      } else if (r.type === 'attributes') {
        const el = r.target
        if (r.attributeName === 'data-controller') {
          const now = new Set(ids(el))
          for (const id of (r.oldValue ?? '').split(/\s+/).filter(Boolean)) if (!now.has(id)) this.disconnectOne(el, id)
          for (const id of now) this.connectOne(el, id)
        } else if (r.attributeName === 'data-action') this.bind(el)
        else if (/^data-[\w-]+-target$/.test(r.attributeName)) structural = true
        else if (/^data-[\w-]+-value$/.test(r.attributeName)) touched.add(el)
      }
    }
    if (structural) {
      // What left: controllers and listeners of elements no longer in the page.
      for (const [el, mine] of [...this.live]) if (!el.isConnected) for (const id of [...mine.keys()]) this.disconnectOne(el, id)
      for (const el of [...this.boundEls]) if (!el.isConnected) this.unbind(el)
      for (const n of added) if (n.isConnected) this.scan(n)
      for (const mine of this.live.values()) for (const c of mine.values()) this.syncTargets(c)
    }
    for (const el of touched) for (const c of this.live.get(el)?.values() ?? []) this.syncValues(c)
  }
}

function defaultEvent(el) {
  const tag = el.tagName
  if (tag === 'FORM') return 'submit'
  if (tag === 'SELECT') return 'change'
  if (tag === 'TEXTAREA') return 'input'
  if (tag === 'INPUT') return el.type === 'submit' ? 'click' : 'input'
  if (tag === 'DETAILS') return 'toggle'
  return 'click'
}
function keyMatches(event, filter) {
  const parts = filter.split('+')
  const key = parts.pop()
  const want = KEYS[key] ?? key
  if (String(event.key).toLowerCase() !== String(want).toLowerCase()) return false
  for (const mod of ['ctrl', 'alt', 'shift', 'meta']) if (event[`${mod}Key`] !== parts.includes(mod)) return false
  return true
}
