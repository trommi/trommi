# The website

[trommi.com](https://trommi.com): five static pages (home, pricing, privacy, imprint, not found), one stylesheet, one
script for the light/dark button. Nothing is built and nothing is fetched from another origin.

```
app/site/
├── public/           what is served, as it is
│   ├── *.html        the pages; head and foot are the same in each, by hand
│   ├── site.css      the look: the web app's colours and fonts
│   ├── theme.js      the theme button (System, Light, Dark)
│   ├── _headers      the response headers (Content-Security-Policy and the rest)
│   ├── fonts/ icons/ copies of the web app's files (app/web/public; licences in app/web/THIRD-PARTY.md)
│   └── img/          screenshots of the web app's demo, light and dark
├── worker.js         http to https, www.trommi.com to trommi.com, then the static files
├── wrangler.jsonc    the Cloudflare Worker that serves it
└── dev/
    ├── serve.mjs     the local server
    └── shots.mjs     makes the pictures
```

## Run it

```
node app/site/dev/serve.mjs          # http://127.0.0.1:8910, with the headers of public/_headers
```

It serves `public/` the way Cloudflare does: `/pricing` is `pricing.html`, an address that is no file gets `404.html`.

## Check it

```
node tests/site/check.mjs            # links, anchors, dead files, sizes, the headers, the worker; no browser
node tests/site/header.mjs           # the head of every page in headless Chromium; starts the server itself
```

The second needs Chromium (`chromium` on the PATH, or the program `CHROMIUM` names).

## The pictures

`public/img/*.webp` are screenshots of the web app in its demo room (`?mock=1`), each in light and in dark: the Desk
and an open card, on a desktop (1280×800 at twice the density) and on a phone (390×844 at twice the density).

```
npm run serve                                   # the web app, in the repository's root: http://127.0.0.1:8900
node app/site/dev/shots.mjs app [--card /card/10] [--only desk-phone]
```

The demo room is `demo/data/fixture.json`. While it holds no agents and no cards, `shots.mjs app` says so and
writes nothing: the committed pictures stay. `--card` names the address of the card to open.

To look at the site itself, every page on a desktop and a phone, light and dark:

```
node app/site/dev/shots.mjs site [--out DIR]    # PNG files, into app/site/.shots/ unless --out is given
```

## Deploy

`npx wrangler@4 deploy` in `app/site` puts `public/` and `worker.js` on the Worker `trommi-com`;
`npx wrangler@4 deploy --dry-run` shows what would go without sending it. The custom domains are attached to the
Worker in Cloudflare's dashboard.

`Strict-Transport-Security` is not in `public/_headers`: it is set once for the zone, for trommi.com and every name
under it.
