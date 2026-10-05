// versions.mjs: which clients this hub serves. Clients send `Trommi-Client: <app|connector|ios>/<semver>` and
// `Trommi-Protocol: 1`. A client below the minimum of its kind gets 426 client-too-old on every route, and an
// open stream of such a client gets `event: upgrade_required` when the minimum is raised at run time.
import { refuse } from './http.mjs'

export const PROTOCOL_VERSIONS = [1]
const KINDS = ['app', 'connector', 'ios']
const SEMVER = /^(\d{1,6})\.(\d{1,6})\.(\d{1,6})(?:[-+][0-9A-Za-z.-]*)?$/

/** -1, 0, 1 for two "x.y.z" strings (pre-release and build suffixes ignored). */
export function compareVersions(a, b) {
  const pa = SEMVER.exec(a).slice(1, 4).map(Number), pb = SEMVER.exec(b).slice(1, 4).map(Number)
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i] < pb[i] ? -1 : 1
  return 0
}

/** `Trommi-Client` header -> { kind, version } or null. */
export function parseClient(header) {
  const m = /^([a-z]+)\/(\S+)$/.exec(String(header ?? '').trim())
  return m && KINDS.includes(m[1]) && SEMVER.test(m[2]) ? { kind: m[1], version: m[2] } : null
}

const fromEnv = (env, prefix) => Object.fromEntries(KINDS.map(k => [k, env[`${prefix}${k.toUpperCase()}`]]).filter(([, v]) => v && SEMVER.test(v)))

export function clientVersions({ env = process.env, log = () => {}, now = Date.now } = {}) {
  let minimum = fromEnv(env, 'HUB_MIN_')
  let recommended = fromEnv(env, 'HUB_RECOMMENDED_')
  let message = env.HUB_UPGRADE_MESSAGE || ''
  let unnamedSince = 0, unnamed = 0

  const tooOld = c => !!c && !!minimum[c.kind] && compareVersions(c.version, minimum[c.kind]) < 0
  const upgradeBody = c => ({ minimum_version: minimum[c.kind], message: message || `Please update Trommi (${c.kind}) to ${minimum[c.kind]} or newer.` })

  return {
    /** The public answer of GET /v1/version. */
    info: () => ({
      protocol_versions_supported: PROTOCOL_VERSIONS, minimum_client_versions: minimum, recommended_client_versions: recommended,
      ...(message ? { message } : {}),
    }),
    /** Refuses an outdated client or an unknown protocol; returns the parsed client (or null: allowed for now, logged once a minute). */
    check(req) {
      const protocol = req.headers['trommi-protocol']
      if (protocol != null && !PROTOCOL_VERSIONS.includes(Number(protocol))) {
        refuse(400, 'bad-version', `this hub speaks protocol ${PROTOCOL_VERSIONS.join(', ')}, not ${String(protocol).slice(0, 10)}`)
      }
      const c = parseClient(req.headers['trommi-client'])
      if (!c) {
        unnamed++
        if (now() - unnamedSince > 60000) { log(`${unnamed} request(s) without a Trommi-Client header in the last minute`); unnamedSince = now(); unnamed = 0 }
        return null
      }
      if (tooOld(c)) refuse(426, 'client-too-old', upgradeBody(c).message, { minimum_version: minimum[c.kind] })
      return c
    },
    tooOld,
    upgradeBody,
    /** Change minimum/recommended/message at run time (the admin page, tests). */
    update(next) {
      if (next.minimum) minimum = { ...next.minimum }
      if (next.recommended) recommended = { ...next.recommended }
      if (next.message != null) message = next.message
    },
  }
}
