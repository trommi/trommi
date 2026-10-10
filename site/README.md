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

CI delivers the site: `.github/workflows/site.yml` runs the checks, and on a push to main that changed `site/` (or
by hand: Actions -> site -> Run workflow on main) calls `.github/workflows/deploy_site.yml`. That job asks for the head
of main, checks its site once more, runs the pinned wrangler (`.github/tools/wrangler`) `deploy --config
site/wrangler.jsonc` to the Worker `trommi-com` (custom domains trommi.com and www.trommi.com) with the Cloudflare
token of the 1Password Environment (GitHub environment `web`), and then compares the front page trommi.com serves
with `site/public/index.html`. Cloudflare Workers Builds is disconnected from `trommi-com`: nothing else deploys the
site. `Strict-Transport-Security` is set once for the zone.
