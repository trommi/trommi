// The app's worker (wrangler.jsonc: it runs before the static assets of public/).
//   - plain http goes to https (WebCrypto only exists on https pages);
//   - the connector is a signed GitHub release of trommi/trommi (install.sh), never served from here;
//   - /.well-known/apple-app-site-association (the iOS app's universal links: /card/…, /chat/…, /settings… open in Trommi
//     when it is installed; and `webcredentials`: the app may use this site's passkeys) is
//     public/apple-app-site-association.json, served as JSON, no redirect;
//   - an address of before (/s/…, /a/…: public/paths.mjs) moves to its new form (/chat/…, /artifact/…) with a 301; the
//     browser keeps the part after # (a share link's secret) across it;
//   - /favicon.ico (asked for by what does not read the page's <link rel="icon">) goes to the PNG icon;
//   - everything else is the static app. Its single-page fallback answers every unknown address with the app's page:
//     right for a page (the app routes in the page), wrong for a file, so a file that does not exist is a 404.
// dev/serve.mjs answers the same addresses, the association file from public/.

import { movedPath } from './public/paths.mjs'

/** The address Apple fetches for the iOS app's universal links, and the file of public/ that answers it. */
export const SITE_ASSOCIATION = { address: '/.well-known/apple-app-site-association', file: '/apple-app-site-association.json' }

/**
 * Whether an address names a file (by its ending), not a page of the app: the endings of app.mjs isAppPath, without
 * html. Such an address is never answered with the app's page.
 */
export const isFilePath = pathname => /\.(?:css|js|mjs|json|map|xml|png|svg|jpe?g|webp|gif|woff2?|webmanifest|txt|csv|log|ico)$/i.test(pathname)
export const FAVICON = '/icons/trommi-192.png'
const NOT_FOUND = { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-cache', 'X-Robots-Tag': 'noindex', 'X-Content-Type-Options': 'nosniff' }

export default {
  async fetch(request, env) {
    const url = new URL(request.url)
    if (url.protocol === 'http:') {
      url.protocol = 'https:'
      return Response.redirect(url.toString(), 301)
    }
    if (url.pathname === SITE_ASSOCIATION.address) {
      const r = await env.ASSETS.fetch(new Request(new URL(SITE_ASSOCIATION.file, url), { method: request.method === 'HEAD' ? 'HEAD' : 'GET' }))
      if (!r.ok) return r
      return new Response(r.body, { status: 200, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=3600', 'X-Content-Type-Options': 'nosniff' } })
    }
    const moved = movedPath(url.pathname)
    if (moved) { url.pathname = moved; return Response.redirect(url.toString(), 301) }
    if (url.pathname === '/favicon.ico') return Response.redirect(new URL(FAVICON, url).toString(), 301)
    const r = await env.ASSETS.fetch(request)
    if (isFilePath(url.pathname) && r.status === 200 && (r.headers.get('Content-Type') ?? '').startsWith('text/html')) return new Response(request.method === 'HEAD' ? null : 'not found\n', { status: 404, headers: NOT_FOUND })
    return r
  }
}
