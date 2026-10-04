// transport.mjs: the hub's routes over fetch (README "Routes"), sign-in by signed challenge, token refresh,
// and the fetch-based SSE stream with resume and reconnect backoff. No state about the room beyond the token.
import * as z from './zcrypto.mjs'

const { ZError, b64u, unb64u } = z
const REFRESH_BEFORE_MS = 60_000
const REQUEST_TIMEOUT_MS = 30_000          // a JSON route (a page of 1000 envelopes takes about a second on a phone line)
const ATTACHMENT_TIMEOUT_MS = 120_000      // attachment bytes up and down on a slow phone line
const GET_RETRIES = [300, 1000]            // backoff before the 2nd and 3rd try of a GET

/**
 * R9: the canonical hub address, `https://` + lowercase host [+ `:port`], no path. Plain http only for a local or private
 * development hub (localhost, 127.x, ::1, 10.x, 192.168.x, 172.16-31.x, *.local, *.ts.net).
 */
export function normaliseHubUrl(url) {
  let u
  try { u = new URL(String(url).trim()) } catch { throw new ZError('bad-argument', 'not a hub address') }
  const host = u.hostname.toLowerCase()
  const local = /^(localhost|127\.\d+\.\d+\.\d+|\[::1\]|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+)$/.test(host) || /\.(local|ts\.net)$/.test(host)
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && local)) throw new ZError('bad-argument', 'a hub address is https:// (plain http only for a local hub)')
  if (u.username || u.password || u.search || u.hash || (u.pathname && u.pathname.replace(/\/+$/, '') !== '')) throw new ZError('bad-argument', 'a hub address has no path, query or credentials')
  return `${u.protocol}//${u.host.toLowerCase()}`
}

/** Every id that goes into a URL path is lowercase hex of its exact length (never raw text from a body or the hub). */
const HEX = { room_id: 64, attachment_id: 32, invite_id: 32, session_id: 32, share_id: 32, escrow_id: 32 }
export function checkId(what, v) {
  const n = HEX[what]
  if (typeof v !== 'string' || v.length !== n || !/^[0-9a-f]+$/.test(v)) throw new ZError('bad-argument', `${what} must be ${n} lowercase hex characters`)
  return v
}

export class Hub {
  /**
   * hub_url: 'https://hub.trommi.com'. room_id: hex. signer: async (challengeBytes) -> signed challenge bytes
   * (signHubAuth for this room and hub_url), or null for routes without sign-in.
   */
  constructor({ hub_url, room_id = null, signer = null, fetch: f = null, found_token = null, client = null }) {
    this.client_name = client                   // 'app/1.2.3' | 'channel/0.1.0': sent as Trommi-Client on every request
    this.onTooOld = null
    this.onLeaseLost = null
    this.recoverLease = null                    // agents: async () => true if this process holds the lease again (renewal), false if another does
    this.onForbidden = null                     // stream refused with 403: the client checks the member list (removed: it closes the stream)
    this._wakers = new Set()                    // sleeping stream reconnects, woken when a request gets through again
    this._unreachable = false
    this.hub_url = normaliseHubUrl(hub_url)
    this.room_id = room_id
    this.signer = signer
    this.fetch = f ?? ((...a) => globalThis.fetch(...a))
    this.found_token = found_token
    this.timeout_ms = REQUEST_TIMEOUT_MS         // deadline of one request (attachments: ATTACHMENT_TIMEOUT_MS)
    this.token = null
    this.token_expires_at = 0
    this.signed_in_as = null
    this._signing = null
  }

  /** A follower tab (tabs.mjs) reads only: anything that moves the room's log, keys or invites is refused here. */
  _refused() { return Promise.reject(new ZError('follower', 'this tab reads only: the writer tab sends')) }
  url(path) { return `${this.hub_url}/v1${path}` }
  roomPath(path = '') { return `/rooms/${checkId('room_id', this.room_id)}${path}` }

  /**
   * challenge: one the hub handed out already (the login answer carries one; a new device asks for one side by side
   * with the post that makes it a member), so the sign-in costs one round trip, not two. A refused one is asked anew.
   */
  async signIn({ challenge: given = null } = {}) {
    if (this._signing) return this._signing
    this._signing = (async () => {
      if (!this.signer) throw new ZError('unauthorised', 'no signer for this hub client')
      if (given) {
        const challenge = await Promise.resolve(given).catch(() => null)
        // a challenge the hub no longer holds (expired, or a restarted hub): ask for a new one
        if (challenge) { try { return await this._takeToken(challenge) } catch (e) { if (e.status !== 401 && e.status !== 400) throw e } }
      }
      return this._takeToken(null)
    })()
    try { return await this._signing } finally { this._signing = null }
  }
  async _takeToken(challenge) {
    if (!challenge) ({ challenge } = await this.request('POST', this.roomPath('/challenge'), { auth: false }))
    const signed = await this.signer(unb64u(challenge))
    const r = await this.request('POST', this.roomPath('/access_tokens'), { auth: false, body: { signed_challenge: b64u(signed) } })
    this.token = r.access_token
    this.token_expires_at = r.expires_at
    this.signed_in_as = r
    return r
  }
  /** A challenge for a sign-in a moment later (signIn({ challenge })). */
  challenge() { return this.request('POST', this.roomPath('/challenge'), { auth: false }).then(r => r.challenge) }

  async authHeader() {
    if (!this.token || Date.now() > this.token_expires_at - REFRESH_BEFORE_MS) await this.signIn()
    return `Bearer ${this.token}`
  }

  /** The version headers every request carries. */
  baseHeaders() { return this.client_name ? { 'trommi-client': this.client_name, 'trommi-protocol': '1' } : { 'trommi-protocol': '1' } }

  /**
   * One request. Throws ZError(code) with .status (and .retry_after) for every refusal. Never an endless wait: every
   * request has a deadline (timeout_ms; longer for attachment bytes) for the answer and its body. A GET that met a
   * network failure, the deadline or a 502/503/504 is tried twice more after a short backoff (a GET changes nothing);
   * writes are not repeated here, their callers know whether the same bytes may go again.
   */
  async request(method, path, opts = {}) {
    const idempotent = method === 'GET' || method === 'HEAD'
    for (let attempt = 0; ; attempt++) {
      try { return await this._requestOnce(method, path, opts) }
      catch (e) {
        if (!idempotent || attempt >= GET_RETRIES.length || !(e.status === 0 || e.status === 502 || e.status === 503 || e.status === 504)) throw e
        const wait = Math.min(5000, (e.retry_after ?? 0) * 1000 || GET_RETRIES[attempt]) + Math.random() * 200
        await new Promise(r => { const t = setTimeout(r, wait); t.unref?.() })
      }
    }
  }

  async _requestOnce(method, path, { body, auth = true, raw = null, headers = {}, query = null, binary = false, retried = false, lease = false, leaseRetried = false, timeout_ms = null } = {}) {
    const h = { ...this.baseHeaders(), ...headers, ...(lease ? this.leaseHeaders() : {}) }
    const generation = this.lease_generation
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
    const limit = timeout_ms ?? (raw || binary ? ATTACHMENT_TIMEOUT_MS : this.timeout_ms)
    const ac = new AbortController()
    let timer = null
    const deadline = new Promise((_, reject) => {
      timer = setTimeout(() => { ac.abort(); reject(new ZError('offline', `the hub did not answer within ${Math.round(limit / 1000)} s`, { status: 0 })) }, limit)
      timer.unref?.()
    })
    deadline.catch(() => {})
    const within = p => Promise.race([p, deadline])
    try {
      let res
      try { res = await within(this.fetch(url, { method, headers: h, body: payload, signal: ac.signal })) }
      catch (e) { this._unreachable = true; throw e instanceof ZError ? e : new ZError('offline', `hub not reachable: ${e.message}`, { status: 0 }) }
      if (res.status >= 500) this._unreachable = true
      else if (this._unreachable) { this._unreachable = false; this.wake() }   // the hub is back: reconnect streams now
      if (res.status === 401 && auth && !retried) {
        this.token = null
        return this._requestOnce(method, path, { body, auth, raw, headers, query, binary, retried: true, lease, leaseRetried, timeout_ms })
      }
      if (res.status === 426) { const e = new ZError('client-too-old', 'this client is too old for the hub: update it', { status: 426 }); this.onTooOld?.(e); throw e }
      if (!res.ok) {
        let err = {}
        try { err = await within(res.json()) } catch {}
        const e = new ZError(err.error ?? `http-${res.status}`, err.message ?? res.statusText, { status: res.status, retry_after: Number(res.headers.get('retry-after')) || null, body: err })
        // R4 on uploads and ephemeral posts: sent under a generation this process has since replaced, or the lease ran out
        // while this process lives (a renewal gives it back): once more. Only a renewal refused by the hub (another live
        // process holds the key) is lease-lost for good, and then the process stops (onLeaseLost).
        if (e.code === 'lease-lost' && lease && !leaseRetried) {
          let again = this.lease_generation !== generation
          if (!again && this.recoverLease) { try { again = await this.recoverLease() } catch { throw e } if (!again) this.onLeaseLost?.(e) }
          if (again) return this._requestOnce(method, path, { body, auth, raw, headers, query, binary, retried, lease, leaseRetried: true, timeout_ms })
        }
        throw e
      }
      let text
      try {
        if (binary) return new Uint8Array(await within(res.arrayBuffer()))
        text = await within(res.text())
      } catch (e) { throw e instanceof ZError ? e : new ZError('offline', `the answer broke off: ${e.message}`, { status: 0 }) }
      return text ? JSON.parse(text) : {}
    } finally { clearTimeout(timer) }
  }

  // ---- routes (README table), thin ------------------------------------------------
  healthz() { return this.fetch(`${this.hub_url}/healthz`, { headers: this.baseHeaders() }).then(r => r.json()) }
  foundRoom({ signed_entry, sealed_room_keys }) {
    return this.request('POST', '/rooms', { auth: false, body: { signed_entry, sealed_room_keys }, headers: this.found_token ? { 'x-found-token': this.found_token } : {} })
  }
  members({ after_entry_number = -1, invite_id } = {}) {
    return this.request('GET', this.roomPath('/members'), { auth: !invite_id, query: { after_entry_number, invite_id } })
  }
  postMember({ signed_entry, sealed_room_keys, key_back_link }) { if (this.readOnly) return this._refused();
    return this.request('POST', this.roomPath('/members'), { auth: false, body: { signed_entry, sealed_room_keys, key_back_link } })
  }
  devices() { return this.request('GET', this.roomPath('/devices')) }
  sealedRoomKeys(after_key_epoch = 0) { return this.request('GET', this.roomPath('/sealed_room_keys'), { query: { after_key_epoch } }) }
  keyBackLinks() { return this.request('GET', this.roomPath('/key_back_links')) }
  postInvite(signed_offer) { if (this.readOnly) return this._refused(); return this.request('POST', this.roomPath('/invites'), { body: { signed_offer } }) }
  getInvite(invite_id) { return this.request('GET', this.roomPath(`/invites/${checkId('invite_id', invite_id)}`), { auth: false }) }
  postRequest(invite_id, signed_request) { return this.request('POST', this.roomPath(`/invites/${checkId('invite_id', invite_id)}/requests`), { auth: false, body: { signed_request } }) }
  getRequests(invite_id) { return this.request('GET', this.roomPath(`/invites/${checkId('invite_id', invite_id)}/requests`)) }
  deleteInvite(invite_id) { if (this.readOnly) return this._refused(); return this.request('DELETE', this.roomPath(`/invites/${checkId('invite_id', invite_id)}`)) }
  postReveal(invite_id, signed_reveal) { if (this.readOnly) return this._refused(); return this.request('POST', this.roomPath(`/invites/${checkId('invite_id', invite_id)}/reveal`), { body: { signed_reveal } }) }
  joinStatus(invite_id, request_hash) { return this.request('GET', this.roomPath(`/invites/${checkId('invite_id', invite_id)}/status`), { auth: false, query: { request_hash } }) }
  postEnvelope(envelope) { if (this.readOnly) return this._refused();
    return this.request('POST', this.roomPath('/envelopes'), { body: { envelope }, headers: this.lease_generation != null ? { 'x-lease-generation': String(this.lease_generation) } : {} })
  }
  /** newest: the newest `limit` envelopes after the cursor (a hub without it answers from the cursor on: check the numbers). */
  envelopes({ after_envelope_number = 0, limit = 1000, newest = false } = {}) { return this.request('GET', this.roomPath('/envelopes'), { query: { after_envelope_number, limit, newest: newest ? 1 : undefined } }) }
  threads({ timeline_kind, timeline_id, before_envelope_number, after_envelope_number, limit = 50 }) {
    return this.request('GET', this.roomPath('/threads'), { query: { timeline_kind, timeline_id, before_envelope_number, after_envelope_number, limit } })
  }
  agentLease({ process_instance, renew = false }) { if (this.readOnly) return this._refused(); return this.request('POST', this.roomPath('/agent_lease'), { body: { process_instance, ...(renew ? { renew: true } : {}) } }) }
  sessions() { return this.request('GET', this.roomPath('/sessions')) }
  sessionGrants(session_id, after_grant_number = -1) { return this.request('GET', this.roomPath(`/sessions/${checkId('session_id', session_id)}/grants`), { query: { after_grant_number } }) }
  postSessionGrant(session_id, { signed_grant, sealed_session_keys, key_back_link }) { if (this.readOnly) return this._refused();
    return this.request('POST', this.roomPath(`/sessions/${checkId('session_id', session_id)}/grants`), { auth: false, body: { signed_grant, sealed_session_keys, key_back_link } })
  }
  /** Several grants in one atomic post: grants = [{ session_id, signed_grant, sealed_session_keys, key_back_link }]. */
  postSessionGrants(grants) { if (this.readOnly) return this._refused();
    for (const g of grants) checkId('session_id', g.session_id)
    return this.request('POST', this.roomPath('/session_grants'), { auth: false, body: { grants } })
  }
  /**
   * Many sessions in one request: { sessions: [{ session_id, signed_grants, sealed_session_keys (own), key_back_links? }] }.
   * session_ids null: every session of the room. A hub without the route answers 404 (the caller asks per session).
   */
  sessionBundle(session_ids = null) {
    if (session_ids) for (const id of session_ids) checkId('session_id', id)
    return this.request('GET', this.roomPath('/session_grants'), { query: session_ids ? { session_ids: session_ids.join(',') } : null })
  }
  sealedSessionKeys(session_id, after_session_key_epoch = 0) { return this.request('GET', this.roomPath(`/sessions/${checkId('session_id', session_id)}/sealed_session_keys`), { query: { after_session_key_epoch } }) }
  sessionBackLinks(session_id) { return this.request('GET', this.roomPath(`/sessions/${checkId('session_id', session_id)}/key_back_links`)) }
  postEphemeral(envelope) { return this.request('POST', this.roomPath('/ephemeral'), { body: { envelope }, lease: true }) }
  putAttachment(attachment_id, bytes) { return this.request('PUT', this.roomPath(`/attachments/${checkId('attachment_id', attachment_id)}`), { raw: bytes, lease: true }) }
  /** R4: an agent names its lease generation on every write and stream (none for humans). */
  leaseHeaders() { return this.lease_generation != null ? { 'x-lease-generation': String(this.lease_generation) } : { 'x-lease-generation': 'none' } }
  postShare(attachment_id, { share_id, share_secret_hash, expires_at }) { return this.request('POST', this.roomPath(`/attachments/${checkId('attachment_id', attachment_id)}/shares`), { body: { share_id, share_secret_hash, expires_at } }) }
  deleteShare(attachment_id, share_id) { return this.request('DELETE', this.roomPath(`/attachments/${checkId('attachment_id', attachment_id)}/shares/${checkId('share_id', share_id)}`)) }
  /** For the outsider's viewer page: the ciphertext of a shared attachment, no sign-in. */
  getShared(share_id, share_secret) { return this.request('GET', `/shares/${checkId('share_id', share_id)}`, { auth: false, binary: true, headers: { 'x-share-secret': share_secret } }) }
  getAttachment(attachment_id) { return this.request('GET', this.roomPath(`/attachments/${checkId('attachment_id', attachment_id)}`), { binary: true }) }
  pushSubscription(subscription, remove = false) { return this.request('POST', this.roomPath('/push_subscriptions'), { body: remove ? { subscription, remove: true } : { subscription } }) }
  /** Anonymous: GET /escrow/:escrow_id (the id comes from the passphrase). The room-id route serves nothing any more. */
  getEscrow(escrow_id) { return this.request('GET', this.roomPath(`/escrow/${checkId('escrow_id', escrow_id)}`), { auth: false }) }
  /** A signed-in human: { has_escrow, revision, escrow_version, ... } and a v1 blob (only to migrate it). */
  escrowStatus() { return this.request('GET', this.roomPath('/escrow')) }
  /** Compare-and-swap: `replaces` is the revision from escrowStatus (0 when there is none); 409 escrow-changed otherwise. */
  putEscrow({ escrow_version, escrow_id, key_escrow, replaces }) { if (this.readOnly) return this._refused(); return this.request('PUT', this.roomPath('/escrow'), { body: { escrow_version, escrow_id, key_escrow, replaces } }) }
  deleteEscrow(revision) { if (this.readOnly) return this._refused(); return this.request('DELETE', this.roomPath('/escrow'), { query: { revision } }) }
  pushKey() { return this.request('GET', '/push_key', { auth: false }) }

  /**
   * The live stream: fetch with the Bearer header, SSE parsing, resume with after_envelope_number from the last id,
   * reconnect with backoff (0.5 s doubling to 2 s, reset after a healthy connection; woken at once when a request gets through again). Returns { close() }.
   * onEvent({ event, data, id }) may be async; records are handed over strictly in order.
   * onState('connecting' | 'open' | 'closed', error?)
   */
  /** Wake every stream that waits to reconnect (the hub answered again, the browser went online). */
  wake() { for (const w of [...this._wakers]) w() }

  stream({ after_envelope_number = 0, onEvent, onState = () => {}, stale_ms = 70_000 }) {
    let closed = false, controller = null, cursor = after_envelope_number, backoff = 500, timer = null, reauth = 0
    const getCursor = typeof after_envelope_number === 'function' ? after_envelope_number : () => cursor
    const run = async () => {
      while (!closed) {
        onState('connecting')
        controller = new AbortController()
        let watchdog = null
        const kick = () => { clearTimeout(watchdog); watchdog = setTimeout(() => controller.abort(new Error('stream went silent')), stale_ms) }
        let healthy = false
        const generation = this.lease_generation
        try {
          const res = await this.fetch(this.url(this.roomPath('/stream')) + `?after_envelope_number=${getCursor()}`, {
            headers: { ...this.baseHeaders(), authorization: await this.authHeader(), accept: 'text/event-stream', ...this.leaseHeaders() }, signal: controller.signal,
          })
          if (res.status === 426) { const e = new ZError('client-too-old', 'this client is too old for the hub: update it', { status: 426 }); this.onTooOld?.(e); closed = true; throw e }
          if (res.status === 401) { this.token = null; reauth++; if (reauth <= 2) { onState('closed'); continue } throw new ZError('unauthorised', 'stream sign-in') }   // a restarted hub forgot the token: sign in again at once
          if (!res.ok) {
            let err = {}
            try { err = await res.json() } catch {}
            const e = new ZError(err.error ?? `http-${res.status}`, err.message ?? 'stream refused', { status: res.status })
            // Opened under a generation this process has since replaced (its own newer claim): reconnect with the new one.
            // Otherwise the client renews; it stops only if another live process holds the key (R4). No reconnect here.
            if (e.code === 'lease-lost' && this.lease_generation === generation) { closed = true; this.onLeaseLost?.(e) }
            throw e
          }
          onState('open')
          reauth = 0
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
          if (e?.code === 'client-too-old') { closed = true; break }
          // 403 (not-member, removed-sender, …): never give up on a hub's word alone (a restarting hub, a proxy). The client
          // checks the signed member list; if this device was removed it closes the stream itself.
          if (e?.status === 403) this.onForbidden?.(e)
        }
        clearTimeout(watchdog)
        if (closed) break
        // Reconnect soon: at most 2 s apart (a deploy restarts the hub; a long backoff would hold every message back),
        // and at once when any request gets through again.
        const wait = healthy ? 250 : backoff
        backoff = Math.min(backoff * 2, 2_000)
        await new Promise(r => { const done = () => { clearTimeout(timer); this._wakers.delete(done); r() }; this._wakers.add(done); timer = setTimeout(done, wait + Math.random() * 500) })
      }
    }
    const done = run()
    return {
      done,
      close() { closed = true; clearTimeout(timer); try { controller?.abort() } catch {} },
    }
  }
}
