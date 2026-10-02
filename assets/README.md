# Trommi assets

Everything Trommi draws, as files. Open `index.html` to see all of it with names and
sizes, in light and dark; a click on a name copies it. The board shows the same page at
`/designs/assets.html`.

## What is here

| Folder | What | Where it comes from |
| --- | --- | --- |
| `logo/` | The mark: a scribbled Z in a ring drawn by hand, on the green tile (light and dark), its cut for 20 to 40 px, its cut for 16 px (the Z alone), the Z without a tile, the favicon (SVG, PNG 16/32, ICO, touch icon 180), app icon tiles (192, 512, 1024, maskable), mark and name together, the name written by hand | `assets/logo.mjs` is the source of the mark; type and spacing from `css/app.css`; `app-icon-ios-shipped.png` is copied from `client/ios/Trommi/Assets.xcassets` (the parked iOS client still ships it) |
| `marks/` | The forty drawings a session can be given by name (`mark-<name>.svg`), sessions drawn together, a sheet of marks drawn from ids alone | `doodle()`, `pairDoodle()`, `groupLoop()` in `client/web/js/ui.js` |
| `icons/` | Every small drawing of the interface (`icon-<name>.svg`), stroked in `currentColor` | `sketch()` and the other drawing functions of `ui.js`; `back.js`, `padlink.js`, `speech.js`, `focus.js`, `chat.js`, `scribble.js`, `pad/pad.js`, `index.html`, `css/keys.css` |
| `states/` | The badge at the end of a session row (the waiting hand, the stack of a working session) and a session's mark online and offline | `bareHand()`, `sketch('stack')` and the `.agent-badge` rules of `css/app.css` |
| `palette/` | `tokens.json` (every token, light and dark, and the hues of the sessions), a swatch sheet as SVG and PNG | `client/web/css/tokens.css`, `HUES` in `js/agents.js` |
| `fonts/` | The three typefaces as WOFF2, each with its licence | Google Fonts; see `fonts/README.md` |
| `screens/` | Screenshots of the product: inbox, question window, sidebar, pad, in light and dark, and two at phone size | a demo board (`dev/trio.sh`), taken by `screens.mjs` |
| `index.html` | The gallery | written by `build.mjs` |

## How it is made

    node assets/build.mjs                    rewrite everything that is derived from code
    node assets/build.mjs --check            write nothing; exit 1 when the folder is out of date
    node assets/build.mjs --render           also render the PNGs of logo, favicon and sheets
    node assets/build.mjs --render --screens also take the screenshots (starts dev/trio.sh on port 8827;
                                             give another port as a further argument)

`build.mjs` has no dependencies. It imports `client/web/js/ui.js` with a stub of the little
DOM that file touches and calls the real drawing functions; drawings that live as literals
inside other modules are read from the module's source text and evaluated; stroke widths and
colours come from the stylesheets. No path data is copied by hand, so a drawing that changes
in the app changes here with the next build, and a drawing added to `ui.js` or to one of the
icon tables appears on its own. `--check` compares every derived file with what the sources
give now, names files that no source produces any more, and tells when a PNG was rendered
from an older SVG (`rendered.json` remembers what each was made from).

`--render` and `--screens` drive headless Chromium through `dev/cdp.mjs`; that does not run
inside the Claude Code command sandbox.

The mark goes the other way: `assets/logo.mjs` holds its strokes, and the build writes the small
cuts into the web client: the top bar's mark in `client/web/index.html` (`<svg class="brand-mark">`)
and the icon link of `index.html`, `admin.html` and `help.html`. Change the mark in `logo.mjs`, never
in those pages; `--check` tells when they differ. The icon is one SVG with two cuts: painted at
16 px it shows the Z alone, from 24 px on the Z in its ring.

The board serves only `client/web/` and follows no link out of it, so `build.mjs` writes the
gallery a second time to `client/web/designs/assets.html`, as one page with every drawing and
picture inside it.

Do not edit the files in `logo/`, `marks/`, `icons/`, `states/`, `palette/` or `index.html`
by hand: the next build overwrites them, and removes files there that it did not write.

## Colours in the files

Icons are stroked in `currentColor` and take the colour of whatever they are placed in. Session
marks, states and the logo carry the colours of the light theme; the dark values are in
`palette/tokens.json`, and `logo/` has dark versions of its own.

## Licences

The drawings, the logo and the screenshots are part of Trommi and under the licence of this
repository (`LICENSE`). The fonts are under the SIL Open Font License 1.1; the texts are in
`fonts/`. `logo/trommi-logo.svg` and `logo/trommi-logo-dark.svg` embed Bricolage Grotesque
and are covered by that licence for the embedded font.
