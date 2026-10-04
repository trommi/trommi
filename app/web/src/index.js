// Sends plain http to https (WebCrypto only exists on https pages); /connect is the connect script for Claude Code
// (curl -fsSL https://app.trommi.com/connect | sh -s '<invite link>', public/connect.sh) as plain text; everything else
// is the static app.
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
    return env.ASSETS.fetch(request)
  }
}
