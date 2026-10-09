// The site's worker (wrangler.jsonc: it runs before the static assets of public/).
//   - plain http goes to https;
//   - www.trommi.com goes to trommi.com (one address for the site);
//   - everything else is the static site.

/** Where a request is sent instead, or null: http to https, www to the apex (never on a local address). */
export function redirectOf(href) {
  const url = new URL(href)
  if (url.hostname === '127.0.0.1' || url.hostname === 'localhost') return null
  if (url.protocol === 'https:' && url.hostname !== 'www.trommi.com') return null
  url.protocol = 'https:'
  if (url.hostname === 'www.trommi.com') url.hostname = 'trommi.com'
  return url.toString()
}

export default {
  fetch(request, env) {
    const to = redirectOf(request.url)
    if (to) return Response.redirect(to, 301)
    return env.ASSETS.fetch(request)
  }
}
