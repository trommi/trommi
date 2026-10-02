# Testing automatically

The app can only be built on macOS. So the question is whose Mac does it, and how you see the result.

## Recommendation

1. **Now: GitHub Actions.** The workflow `.github/workflows/ios.yml` is ready and needs no account but GitHub. You see in the browser which step is red, read the first errors in the job summary, and download screenshots from the UI tests.
2. **Once the minutes hurt: the same workflow on the Mac mini** as a runner of your own. One line changes.
3. **To use the app on your own iPhone: TestFlight**, uploaded by `.github/workflows/ios-testflight.yml`. That needs the Apple Developer membership.

## 1. GitHub Actions (set up, never run)

`ios.yml` runs on a push that changes `client/ios/**`, `server/server.mjs`, `dev/serve.sh`, `dev/demo-state.mjs`, `dev/session.mjs` or `client/web/js/ui.js`, and on the button "Run workflow". A change to the web's drawings in `ui.js` turns the fixture check red until `node tools/doodle-fixtures.mjs` and `node tools/doodle-tables.mjs` were run and their output checked in. A change to the workflow file alone does not start it. It has two jobs that run side by side:

| Job | Runner | What it does | Feedback after about |
| - | - | - | - |
| Core on Linux | `ubuntu-24.04` | Checks that the fixtures and `Core/DoodleTables.swift` are what their generators write (also: that the marks still match the web's generator), then `swift test` with a live `server.mjs`, seeded by `tools/live-seed.sh` | 2 to 3 minutes |
| App on the simulator | `macos-26` | The same `swift test` with Apple's URLSession, `xcodegen`, then three separate steps: **Build**, **Unit tests**, **UI tests** | 10 to 20 minutes (estimated, never measured) |

Building and testing are separate steps on purpose: if the app does not compile, "Build" is red and nothing else runs; if it compiles and a test fails, the build step is green and you know it is about behaviour.

### Reading a run

- **The job summary** (the page of the run, below the graph) has, per step, the verdict (`** TEST BUILD FAILED **`), the number of different errors, the first 25 with file and line, each once, and the number of errors per file. This is the place to look first; copy it into a chat with the agent that fixes the build.
- **Annotations**: with `xcbeautify` on the runner (it is preinstalled on GitHub's macOS images) errors and failed tests are also attached to the commit.
- **Artifact `ios-logs`**: `build.txt`, `unit-tests.txt`, `ui-tests.txt` are the short logs, `*.raw.log` everything xcodebuild said, `swift-test.log` the core tests, `trommi-server.log` the test server.
- **Artifact `ios-screenshots`**: the pictures the UI tests take, as PNG. The first look at the app anyone gets.
- **Artifact `ios-test-results`**: the `.xcresult` bundles; they open in Xcode.
- **Artifact `ios-simulator-app`**: the app for the simulator as a zip.

### What is cached

- npm packages (`actions/setup-node` with `cache: npm`).
- The SwiftPM build folder `client/ios/.build`, keyed by the sources of Core, Net and the tests; an unchanged core is not compiled again.
- Not cached: Xcode's DerivedData. Xcode decides by file times what to rebuild, and a fresh checkout makes every file new, so the cache would be restored and then ignored.

### The first run

Expect the "Build" step to be red: `Trommi/App`, `Trommi/Views` and the UI tests were never compiled. [BUILD-RISKS.md](BUILD-RISKS.md) lists the constructs most likely to fail, each with a fallback. The way through:

1. Push, or press "Run workflow". Wait for "Core on Linux" (green means the server interface and the rules are fine).
2. Open the run, read "Build" in the summary, hand the error list to the agent or fix by hand, push again.
3. Once "Build" is green, "Unit tests" and "UI tests" speak. Look at the screenshots.

On a private repository macOS minutes count ten times; 2,000 free minutes a month are about 200 macOS minutes, ten to twenty runs. The Linux job costs a few ordinary minutes. (Prices as of the previous version of this file; not checked again.)

## 2. A Mac mini as the runner

Once, on the Mac mini: install Xcode 16 or newer and start it once, `brew install xcodegen xcbeautify node`. Then in the repository under Settings → Actions → Runners → "New self-hosted runner" (macOS, ARM64) run the commands shown and set it up as a service with `./svc.sh install && ./svc.sh start`.

In the workflow replace `runs-on: macos-26` with `runs-on: [self-hosted, macOS]`.

Two things to mind:

- A runner of your own executes what is in the repository. On a public repository a stranger's pull request could run code on the Mac mini. The workflow therefore starts on `push` only, not on `pull_request`; leave it so or keep the repository private.
- UI tests need a logged-in session on the screen (switch on automatic login), otherwise the simulator does not start reliably. That is hearsay, not checked here.

For the iPhone at the Mac mini: pair the device once in Xcode, enter the team in `project.yml` (`DEVELOPMENT_TEAM`), then `xcodebuild -destination 'platform=iOS,name=<device name>' -allowProvisioningUpdates` builds and `xcrun devicectl device install app` installs. Without a paid membership such an app runs for seven days.

## 3. TestFlight

`ios-testflight.yml` archives the app, signs it and uploads it; internal testers get it without a review. It is started by hand ("Run workflow") until the first simulator build is green. To upload on every push to `main`, add the `push` trigger shown at the top of the workflow.

One-time setup, all in the browser:

1. Join the Apple Developer Program. In App Store Connect create an app with the bundle id `com.trommi.app`, or change the id in `project.yml` first; it must be one your team owns.
2. Users and Access → Integrations → App Store Connect API → Team Keys: create a key with the role **Admin**, download the `.p8` file (once only).
3. TestFlight → Internal Testing: create a group and add yourself.
4. Repository settings → Secrets and variables → Actions: `ASC_KEY_ID`, `ASC_ISSUER_ID`, `ASC_KEY_P8` (the content of the file), `APPLE_TEAM_ID`.
5. On the phone: install TestFlight; switch on automatic updates for Trommi.

What the workflow does: the run number becomes the build number; the archive is made **without signing**; `xcodebuild -exportArchive` then signs with the distribution certificate Apple keeps for the team and uploads, marked "TestFlight internal testing only". The app has an icon (`Trommi/Assets.xcassets`) and declares that it uses no encryption beyond the system's, so App Store Connect asks no export question per build.

Checked against documentation and reports (October 2026), not by running it:

- `-allowProvisioningUpdates` with `-authenticationKeyPath`, `-authenticationKeyID`, `-authenticationKeyIssuerID` are the flags `man xcodebuild` names for an App Store Connect key.
- Export options: `method` `app-store-connect` (the old name `app-store` is deprecated), `destination` `upload`, `testFlightInternalTestingOnly` (Xcode 15 and newer).
- The earlier version of the workflow asked for the role "App Manager"; reports say distribution signing through the API needs "Admin".
- The earlier version signed the archive automatically. On a fresh runner that makes a new development certificate on every run, and a team may only have a few; after two or three runs the build fails with "maximum number of certificates".

Not verified, and the likely places for the first failure:

- Whether the export accepts an unsigned archive. If it does not, run the workflow with "Sign the archive" ticked; if that hits the certificate limit, revoke the surplus development certificates at developer.apple.com → Certificates.
- Whether App Store Connect accepts a build with a single 1024-point icon and the generated Info.plist as they are.
- Whether uploads must be built with the newest Xcode at the time you read this; the workflow uses the image `macos-26` and its default Xcode.

The app allows HTTP to any address (see README). For TestFlight with internal testers that is no obstacle; for a release on the App Store Apple would ask about it.

## 4. Other ways

| | What you get | What it needs | Cost |
| - | - | - | - |
| GitHub Actions | Tests on every push, result and screenshots in the browser | nothing more | public repository: free. Private: macOS minutes count ten times |
| Mac mini as runner | the same, faster (caches stay), no minutes; can also install on a connected iPhone | Xcode and the runner service on the Mac mini, the machine must be on | free |
| Appetize.io | a simulator in the browser, by link | an account, an API token as a repository secret, an upload step | free with 30 minutes a month |
| Xcode Cloud | building and testing at Apple, uploads straight to TestFlight | Apple Developer Program, the repository connected to App Store Connect, a checked-in `.xcodeproj` or a script that runs `xcodegen` | 25 hours a month in the membership |
| TestFlight | the app on your iPhone, updates arrive by themselves | Apple Developer Program (99 $ a year), a signed build | in the membership |

Prices are carried over from the previous version of this file and were not checked again.

Appetize takes the simulator app as a zip, which is exactly the artifact `ios-simulator-app`. The upload step, deliberately not in the workflow, and never tried:

```yaml
      - name: Upload to Appetize
        if: github.ref == 'refs/heads/main'
        env:
          APPETIZE_API_TOKEN: ${{ secrets.APPETIZE_API_TOKEN }}
        run: |
          curl --fail -X POST "https://api.appetize.io/v1/apps${APPETIZE_APP:+/$APPETIZE_APP}" \
            -H "X-API-KEY: $APPETIZE_API_TOKEN" \
            -F "file=@build/Trommi-simulator.zip" -F "platform=ios"
```

In the browser the app runs without your server unless that is reachable from the internet; "Look at the demo" on the first screen is enough to click through.

Xcode Cloud expects a project file in the repository. Because `Trommi.xcodeproj` is generated, it would need `client/ios/ci_scripts/ci_post_clone.sh` with `brew install xcodegen && cd .. && xcodegen`, or a checked-in project file. Not set up, not tried.
