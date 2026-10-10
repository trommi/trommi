// demo-room.mjs: the demo room's own client (app/web/public/demo/demo.mjs, `?mock=1`) in Node, for the tests: the
// real module, not a copy of it. Its one import that only a build has (gen/vendor/demo-screens.mjs, the list of
// screens the build makes from demo/data/screens.json) is answered here with that list.
import fs from 'node:fs'
import path from 'node:path'
import { registerHooks } from 'node:module'
import { pathToFileURL } from 'node:url'
import { PUBLIC, REPO } from './sources.mjs'

const STATES = JSON.parse(fs.readFileSync(path.join(REPO, 'demo/data/screens.json'), 'utf8')).states
registerHooks({
  resolve(specifier, context, next) {
    if (specifier.endsWith('/gen/vendor/demo-screens.mjs')) return { url: `data:text/javascript,${encodeURIComponent(`export const STATES = ${JSON.stringify(STATES)}`)}`, shortCircuit: true }
    return next(specifier, context)
  },
})
/** { MockClient, variantOf }: the room's client and the variants it builds from a fixture (`?mock=<name>`). */
export const demo = await import(pathToFileURL(path.join(PUBLIC, 'demo/demo.mjs')).href)

/** The repository's own demo room (the skeleton every checkout has). */
export const SKELETON = path.join(REPO, 'demo/data/fixture.json')
/** The rich demo room: test data that is in no repository. TROMMI_DEMO_FIXTURE names its fixture.json; without it
 *  the tests that need it are skipped and say so. */
export const RICH = process.env.TROMMI_DEMO_FIXTURE ?? ''
export const readFixture = file => JSON.parse(fs.readFileSync(file, 'utf8'))
