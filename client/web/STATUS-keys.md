# Keyboard worker log (js/keys.js, css/keys.css; small edits in inbox.js, app.js, focus.js, index.html)

Running notes, newest at the bottom. Nothing here is committed by the worker.

## Done so far
- `js/keys.js`: the one keydown listener of the app. `LAYOUT` is the key table (scope, keys, text, flags);
  views register actions with `provide(scope, { active, actions, has })`; the "?" sheet and the "g …" notice are
  drawn from the same table. Rules: no modifier chords, nothing while typing (only Esc), nothing under a
  `dialog[open]` or `[data-owns-keys]`, Enter/Space stay with a focused button, held keys repeat only for moves.
  `native: true` entries are listed but handled in place (composer, canvas) and reserve their key.
- inbox.js: old listener and legend removed; actions for scope `list`; mark = frame + scribbled arrow + key caps
  on the row's controls (`hint()`), row gets the focus, own `reveal()` scrolls (sender heading, Later tag, page title).
  With no mark, a letter only marks the first row in sight. J/K, arrows, Home/End, ←/→ over open options,
  Space toggles, Enter sends (multi), A ask back, L later, Esc folds then drops the mark.
- Found and fixed: with the focus on a row, a rebuild of the list scrolled the inbox to 0 (Chromium lays out
  the emptied list when the focused node is moved). render() now lets go of the focus before rows move.
- app.js: old "type anywhere" listener removed (it clashed with single keys); providers for app, session,
  conversation; `g i/a/f/1-9`, `,` `.` sessions, `t` theme, `u` back, `r` write, `q` `f` filters, `s` scribble,
  `o` other pane, `p` pad (lazy import of `padlink.js`).
- focus.js: its key handler moved to scope `focus` (modal); Tab trap and picture zoom stay there.
- Test rig: `dev/trio.sh 8882`, fixture session "Fixture" via `dev/session.mjs` (BOARD_PORT=8882 BOARD_TOKEN=demo).

## Still to do
- "Back" control after an answer (list and Focus walk), "Explain" (key E), pad contract, Tab/focus-visible audit,
  `dev/keys-test.mjs`, phone and dark screenshots.
