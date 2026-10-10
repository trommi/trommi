# site

The website [trommi.com](https://trommi.com): one page, the imprint, the privacy page and a not-found page, served as
they are from `public/` by the Cloudflare Worker `trommi-com` (`worker.js`: http to https, www.trommi.com to
trommi.com). Nothing is built; Node 22 or newer, no packages. Font licences: `THIRD-PARTY.md`.

```
node site/dev/serve.mjs              # http://127.0.0.1:8910, with the headers of public/_headers
node tests/site/check.mjs            # links, files, headers, worker; no browser (CI: .github/workflows/site.yml)
node tests/site/header.mjs           # the head of every page in headless Chromium
node site/dev/shots.mjs site         # pictures of every page, desktop and phone, light and dark
```

## Deploy

Cloudflare Workers Builds deploys the Worker `trommi-com` (custom domains trommi.com and www.trommi.com) on every
push to main that touches `site/`: repository trommi/trommi, root directory `site/`, build watch path `site/*`, no
build command, deploy command `npx wrangler deploy`. `Strict-Transport-Security` is set once for the zone.
