// The app's worker (wrangler.jsonc: it runs before the static assets of public/).
//   - plain http goes to https (WebCrypto only exists on https pages);
//   - /connect is the connect script for Claude Code (curl -fsSL https://app.trommi.com/connect | sh -s '<invite link>',
//     public/connect.sh), as plain text;
//   - the connector's release (connector-rs/build-plugin.mjs: the binaries, the Trommi plugin and its marketplace) comes
//     from the R2 bucket bound as RELEASES, which dev/deploy/connector.sh fills: Cloudflare's build of this app has no
//     Rust toolchain, so the binaries are built on a developer's machine and uploaded apart from the app;
//   - /.well-known/apple-app-site-association (the iOS app's universal links: /card/…, /s/…, /settings… open in Trommi
//     when it is installed) is public/apple-app-site-association.json, served as JSON;
//   - everything else is the static app.
// dev/serve.mjs answers the release addresses from connector-rs/dist/ (build-plugin.mjs's default output) and the
// association file from public/.

/**
 * The R2 key of a release address, or null. Named by content (never change, cached for good):
 * connector/<sha256>/trommi-connector-<target>(.sig) and plugins/trommi-<version>.zip. Pointers at the newest (no-cache):
 * connector/trommi-connector-<target>.sha256, connector/release-key.pub and plugins/marketplace.json.
 */
export const releaseKey = pathname => (/^\/(connector\/([0-9a-f]{64}\/trommi-connector-[\w-]+(\.sig)?|trommi-connector-[\w-]+\.sha256|release-key\.pub)|plugins\/(marketplace\.json|trommi-[0-9a-f]{12}\.zip))$/.test(pathname) ? pathname.slice(1) : null)

/** The headers of a release file. */
export function releaseHeaders(key) {
  const type = key.endsWith('.json') ? 'application/json; charset=utf-8' : key.endsWith('.zip') ? 'application/zip' : /\.(sha256|sig|pub)$/.test(key) ? 'text/plain; charset=utf-8' : 'application/octet-stream'
  const named = /^connector\/[0-9a-f]{64}\/|^plugins\/trommi-[0-9a-f]{12}\.zip$/.test(key)
  return { 'Content-Type': type, 'Cache-Control': named ? 'public, max-age=31536000, immutable' : 'no-cache', 'X-Content-Type-Options': 'nosniff' }
}

/** The address Apple fetches for the iOS app's universal links, and the file of public/ that answers it. */
export const SITE_ASSOCIATION = { address: '/.well-known/apple-app-site-association', file: '/apple-app-site-association.json' }

export default {
  async fetch(request, env) {
    const url = new URL(request.url)
    if (url.protocol === 'http:') {
      url.protocol = 'https:'
      return Response.redirect(url.toString(), 301)
    }
    if (url.pathname === '/connect' || url.pathname === '/connect/') {
      const r = await env.ASSETS.fetch(new Request(new URL('/connect.sh', url), { method: request.method === 'HEAD' ? 'HEAD' : 'GET' }))
      if (!r.ok) return r
      return new Response(r.body, { status: 200, headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff' } })
    }
    if (url.pathname === SITE_ASSOCIATION.address) {
      const r = await env.ASSETS.fetch(new Request(new URL(SITE_ASSOCIATION.file, url), { method: request.method === 'HEAD' ? 'HEAD' : 'GET' }))
      if (!r.ok) return r
      return new Response(r.body, { status: 200, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=3600', 'X-Content-Type-Options': 'nosniff' } })
    }
    const key = releaseKey(url.pathname)
    if (key) {
      const object = await env.RELEASES?.get(key)
      if (!object) return new Response('not found\n', { status: 404, headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-cache' } })
      return new Response(request.method === 'HEAD' ? null : object.body, { headers: { ...releaseHeaders(key), 'Content-Length': String(object.size), ETag: object.httpEtag } })
    }
    return env.ASSETS.fetch(request)
  }
}
