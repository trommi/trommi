# The shell

A stand-in for the web app while the real one (`app/web`) is being moved onto the new core: one page that says that
Trommi is being set up and runs the Rust core's own self test in the browser (the same worker the app's "MLS proof"
screen uses, `app/web/core/proof-worker.ts`, bundled as it is). It is served by the app's real worker
(`app/web/worker.js`) under the app's real headers (`app/web/public/_headers`), so a delivery of the shell proves the
whole path: the WASM build, the worker, the route, the headers.

    sh core/wasm/build.sh                 # the core for the browser (core/wasm/pkg/)
    node app/shell/build.mjs OUT_DIR      # the shell's files into OUT_DIR
    node tests/shell/check.mjs OUT_DIR    # what must hold of them

Its `sw.js` removes the service worker and the caches an earlier app left in a browser, so that the browser shows what
is served now. This folder, `tests/shell` and the `shell` entry in `.github/workflows/build.yml` go away when the real
build is green.
