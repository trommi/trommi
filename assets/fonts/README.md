# Fonts

The three typefaces of Trommi, as the web client loads them from Google Fonts
(`client/web/index.html`; the families are named in `client/web/css/tokens.css`).
These are the Latin subsets in WOFF2, fetched on 2 October 2026.

| File | Family | Use | Licence |
| --- | --- | --- | --- |
| `BricolageGrotesque-latin-variable.woff2` | Bricolage Grotesque (variable; the app uses 600 to 800) | headlines, the name | `OFL-BricolageGrotesque.txt` |
| `IBMPlexSans-latin-variable.woff2` | IBM Plex Sans (variable; the app uses 400 to 600) | text | `OFL-IBMPlexSans.txt` |
| `IBMPlexMono-latin-400.woff2`, `IBMPlexMono-latin-500.woff2` | IBM Plex Mono | code | `OFL-IBMPlexMono.txt` |

All three are under the SIL Open Font License 1.1, which allows bundling them as
long as the licence text travels with them; it lies next to each family here.
"Plex" is a reserved font name of IBM Corp.: a changed version must not carry it.

`assets/build.mjs` embeds these files in the gallery and in `logo/trommi-logo*.svg`.
To fetch them again, open the stylesheet address in `client/web/index.html` with a
browser's user agent and take the `/* latin */` files; the licence texts are in
`ofl/<family>/OFL.txt` of github.com/google/fonts.
