// transport.mjs: the hub's routes over fetch (README "Routes"), sign-in by signed challenge, token refresh,
// and the fetch-based SSE stream with resume and reconnect backoff. No state about the room beyond the token.
import * as z from './zcrypto.mjs'

const { ZError, b64u, unb64u } = z
const REFRESH_BEFORE_MS = 60_000

export const normaliseHubUrl = url => String(url).replace(/\/+$/, '')

export class Hub {
  /**
   * hub_url: 'https://hub.trommi.com'. room_id: hex. signer: async (challengeBytes) -> signed challenge bytes
   * (signHubAuth for this room and hub_url), or null for routes without sign-in.
   */
  constructor({ hub_url, room_id = null, signer = null, fetch: f = null, found_token = null, client = null }) {
    this.client_name = client                   // 'app/1.2.3' | 'channel/0.1.0': sent as Trommi-Client on every request
    this.onTooOld = null
    this.hub_url = normaliseHubUrl(hub_url)
    this.room_id = room_id
    this.signer = signer
    this.fetch = f ?? ((...a) => globalThis.fetch(...a))
    this.found_token = found_token
    this.token = null
    this.token_expires_at = 0
    this.signed_in_as = null
    this._signing = null
  }

  url(path) { return `${this.hub_url}/v1${path}` }
  roomPath(path = '') { return `/rooms/${this.room_id}${path}` }

  async signIn() {
    if (this._signing) return this._signing
    this._signing = (async () => {
      if (!this.signer) throw new ZError('unauthorised', 'no signer for this hub client')
      const { challenge } = await this.request('POST', this.roomPath('/challenge'), { auth: false })
      const signed = await this.signer(unb64u(challenge))
      const r = await this.request('POST', this.roomPath('/access_tokens'), { auth: false, body: { signed_challenge: b64u(signed) } })
      this.token = r.access_token
      this.token_expires_at = r.expires_at
      this.signed_in_as = r
      return r
    })()
    try { return await this._signing } finally { this._signing = null }
  }

  async authHeader() {
    if (!this.token || Date.now() > this.token_expires_at - REFRESH_BEFORE_MS) await this.signIn()
    return `Bearer ${this.token}`
  }

  /** One request. Throws ZError(code) with .status (and .retry_after) for every refusal. */
  baseHeaders() { return this.client_name ? { 'trommi-client': this.client_name, 'trommi-protocol': '1' } : { 'trommi-protocol': '1' } }

  async request(method, path, { body, auth = true, raw = null, headers = {}, query = null, binary = false, retried = false } = {}) {
    const h = { ...this.baseHeaders(), ...headers }
    if (auth) h.authorization = await this.authHeader()
    let payload
    if (raw) { payload = raw; h['content-type'] = 'application/octet-stream' }
    else if (body !== undefined) { payload = JSON.stringify(body); h['content-type'] = 'application/json' }
    let url = this.url(path)
    if (query) {
      const q = new URLSearchParams()
      for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== null) q.set(k, String(v))
      const s = q.toString()
      if (s) url += `?${s}`
    }
    let res
    try { res = await this.fetch(url, { method, headers: h, body: payload }) }
    catch (e) { throw new ZError('offline', `hub not reachable: ${e.message}`, { status: 0 }) }
    if (res.status === 401 && auth && !retried) {
      this.token = null
      return this.request(method, path, { body, auth, raw, headers, query, binary, retried: true })
    }
    if (res.status === 426) { const e = new ZError('client-too-old', 'this client is too old for the hub: update it', { status: 426 }); this.onTooOld?.(e); throw e }
    if (!res.ok) {
      let err = {}
      try { err = await res.json() } catch {}
      throw new ZError(err.error ?? `http-${res.status}`, err.message ?? res.statusText, { status: res.status, retry_after: Number(res.headers.get('retry-after')) || null, body: err })
    }
    if (binary) return new Uint8Array(await res.arrayBuffer())
    const text = await res.text()
    return text ? JSON.parse(text) : {}
  }

  // ---- routes (README table), thin ------------------------------------------------
  healthz() { return this.fetch(`${this.hub_url}/healthz`, { headers: this.baseHeaders() }).then(r => r.json()) }
  foundRoom({ signed_entry, sealed_room_keys }) {
    return this.request('POST', '/rooms', { auth: false, body: { signed_entry, sealed_room_keys }, headers: this.found_token ? { 'x-found-token': this.found_token } : {} })
  }
  members({ after_entry_number = -1, invite_id } = {}) {
    return this.request('GET', this.roomPath('/members'), { auth: !invite_id, query: { after_entry_number, invite_id } })
  }
  postMember({ signed_entry, sealed_room_keys, key_back_link }) {
    return this.request('POST', this.roomPath('/members'), { auth: false, body: { signed_entry, sealed_room_keys, key_back_link } })
  }
  devices() { return this.request('GET', this.roomPath('/devices')) }
  sealedRoomKeys(after_key_epoch = 0) { return this.request('GET', this.roomPath('/sealed_room_keys'), { query: { after_key_epoch } }) }
  keyBackLinks() { return this.request('GET', this.roomPath('/key_back_links')) }
  postInvite(signed_offer) { return this.request('POST', this.roomPath('/invites'), { body: { signed_offer } }) }
  getInvite(invite_id) { return this.request('GET', this.roomPath(`/invites/${invite_id}`), { auth: false }) }
  postRequest(invite_id, signed_request) { return this.request('POST', this.roomPath(`/invites/${invite_id}/requests`), { auth: false, body: { signed_request } }) }
  getRequests(invite_id) { return this.request('GET', this.roomPath(`/invites/${invite_id}/requests`)) }
  postReveal(invite_id, signed_reveal) { return this.request('POST', this.roomPath(`/invites/${invite_id}/reveal`), { body: { signed_reveal } }) }
  joinStatus(invite_id, request_hash) { return this.request('GET', this.roomPath(`/invites/${invite_id}/status`), { auth: false, query: { request_hash } }) }
  postEnvelope(envelope) { return this.request('POST', this.roomPath('/envelopes'), { body: { envelope } }) }
  envelopes({ after_envelope_number = 0, limit = 1000 } = {}) { return this.request('GET', this.roomPath('/envelopes'), { query: { after_envelope_number, limit } }) }
  threads({ timeline_kind, timeline_id, before_envelope_number, after_envelope_number, limit = 50 }) {
    return this.request('GET', this.roomPath('/threads'), { query: { timeline_kind, timeline_id, before_envelope_number, after_envelope_number, limit } })
  }
  agentSession({ agent_name, process_instance }) { return this.request('POST', this.roomPath('/agent_sessions'), { body: { agent_name, process_instance } }) }
  putAttachment(attachment_id, bytes) { return this.request('PUT', this.roomPath(`/attachments/${attachment_id}`), { raw: bytes }) }
  getAttachment(attachment_id) { return this.request('GET', this.roomPath(`/attachments/${attachment_id}`), { binary: true }) }
  pushSubscription(subscription, remove = false) { return this.request('POST', this.roomPath('/push_subscriptions'), { body: remove ? { subscription, remove: true } : { subscription } }) }
  getEscrow() { return this.request('GET', this.roomPath('/escrow'), { auth: false }) }
  putEscrow({ escrow_version, key_escrow }) { return this.request('PUT', this.roomPath('/escrow'), { body: { escrow_version, key_escrow } }) }
  deleteEscrow() { return this.request('DELETE', this.roomPath('/escrow')) }
  pushKey() { return this.request('GET', '/push_key', { auth: false }) }

  /**
   * The live stream: fetch with the Bearer header, SSE parsing, resume with after_envelope_number from the last id,
   * reconnect with backoff (0.5 s doubling to 30 s, reset after a healthy connection). Returns { close() }.
   * onEvent({ event, data, id }) may be async; records are handed over strictly in order.
   * onState('connecting' | 'open' | 'closed', error?)
   */
  stream({ after_envelope_number = 0, onEvent, onState = () => {}, stale_ms = 70_000 }) {
    let closed = false, controller = null, cursor = after_envelope_number, backoff = 500, timer = null
    const getCursor = typeof after_envelope_number === 'function' ? after_envelope_number : () => cursor
    const run = async () => {
      while (!closed) {
        onState('connecting')
        controller = new AbortController()
        let watchdog = null
        const kick = () => { clearTimeout(watchdog); watchdog = setTimeout(() => controller.abort(new Error('stream went silent')), stale_ms) }
        let healthy = false
        try {
          const res = await this.fetch(this.url(this.roomPath('/stream')) + `?after_envelope_number=${getCursor()}`, {
            headers: { ...this.baseHeaders(), authorization: await this.authHeader(), accept: 'text/event-stream' }, signal: controller.signal,
          })
          if (res.status === 426) { const e = new ZError('client-too-old', 'this client is too old for the hub: update it', { status: 426 }); this.onTooOld?.(e); closed = true; throw e }
          if (res.status === 401) { this.token = null; throw new ZError('unauthorised', 'stream sign-in') }
          if (!res.ok) {
            let err = {}
            try { err = await res.json() } catch {}
            throw new ZError(err.error ?? `http-${res.status}`, err.message ?? 'stream refused', { status: res.status })
          }
          onState('open')
          kick()
          const reader = res.body.getReader()
          const dec = new TextDecoder()
          let buf = ''
          for (;;) {
            const { value, done } = await reader.read()
            if (done) break
            kick()
            buf += dec.decode(value, { stream: true })
            let at
            while ((at = buf.indexOf('\n\n')) >= 0) {
              const block = buf.slice(0, at)
              buf = buf.slice(at + 2)
              const rec = { event: 'message', data: '', id: null }
              for (const line of block.split('\n')) {
                if (!line || line.startsWith(':')) continue
                const c = line.indexOf(':')
                const field = c < 0 ? line : line.slice(0, c)
                const val = c < 0 ? '' : line.slice(c + 1).replace(/^ /, '')
                if (field === 'event') rec.event = val
                else if (field === 'data') rec.data += (rec.data ? '\n' : '') + val
                else if (field === 'id') rec.id = val
              }
              let data = {}
              try { data = rec.data ? JSON.parse(rec.data) : {} } catch {}
              if (rec.event === 'envelope' && Number.isInteger(data.envelope_number)) cursor = Math.max(cursor, data.envelope_number)
              healthy = true
              backoff = 500
              if (rec.event === 'upgrade_required') { const e = new ZError('client-too-old', 'the hub asks for a newer client'); this.onTooOld?.(e); closed = true; break }
              await onEvent({ event: rec.event, data, id: rec.id })
              if (closed) break
            }
            if (closed) break
          }
          onState('closed')
        } catch (e) {
          clearTimeout(watchdog)
          if (closed) break
          onState('closed', e)
          if (e?.code === 'not-member' || e?.code === 'removed-sender' || e?.code === 'client-too-old' || e?.status === 403) { closed = true; break }
        }
        clearTimeout(watchdog)
        if (closed) break
        const wait = healthy ? 250 : backoff
        backoff = Math.min(backoff * 2, 30_000)
        await new Promise(r => { timer = setTimeout(r, wait + Math.random() * 250) })
      }
    }
    const done = run()
    return {
      done,
      close() { closed = true; clearTimeout(timer); try { controller?.abort() } catch {} },
    }
  }
}
