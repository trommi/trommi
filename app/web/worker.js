// The app's worker (wrangler.jsonc: it runs before the static assets of public/).
//   - plain http goes to https (WebCrypto only exists on https pages);
//   - /connect is the connect script for Claude Code (curl -fsSL https://app.trommi.com/connect | sh -s '<invite link>',
//     public/connect.sh), as plain text;
//   - the generated files keep their public addresses: the connect script, every installed connector (its update check)
//     and the Trommi plugin's marketplace fetch /connector.mjs, /connector.mjs.sha256 and /plugins/…, which live in
//     public/gen/ (assetPath);
//   - everything else is the static app.
// dev/serve.mjs answers through the same assetPath().

/** The file of public/ that answers a public address (the same address for every file but the generated ones). */
// (connector/trommi-connector-<target> and plugins/rs/: the binary connector of connector-rs/build-plugin.mjs)
export const assetPath = pathname => (/^\/(connector\.mjs(\.sha256)?|connector\/(trommi-connector-[\w-]+(\.sha256|\.sig)?|release-key\.pub)|plugins\/(rs\/)?[\w.-]+)$/.test(pathname) ? `/gen${pathname}` : pathname)

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
    const path = assetPath(url.pathname)
    if (path !== url.pathname) { url.pathname = path; return env.ASSETS.fetch(new Request(url, request)) }
    return env.ASSETS.fetch(request)
  }
}
