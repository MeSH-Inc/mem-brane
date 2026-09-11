# Interaction verification

The local checks cover gesture ownership, focus, per-entity rendering and responsiveness under a deliberately crowded canvas. The browser-engine runs are automated. Injected-input checks have also passed in installed macOS Safari and Chrome on a physical Pixel. Physical iPhone Safari passes the keyboard selection, save-lane, cancellation and conflict-retry subset; native gesture and text-entry coverage is pending. Human trackpad and touchscreen checks remain pending. The [device checkpoint](operations/canvas-device-checkpoint.md) records the exact coverage and the native-runner signing prerequisite.

## Repeatable checks

```sh
npx playwright install chromium firefox webkit
npm run verify
npm run test:stress
```

`verify` runs formatting, TypeScript, application builds, unit/API tests and browser behavior tests. Chromium runs the complete browser suite, including the authenticated application, offline replica and recovery flows. Firefox and WebKit run the canvas, loading, geometry, selection, presentation and native-input suites. The multi-touch injection test runs only in Chromium because it uses CDP. Native taps, wheel gestures and keyboard traversal run in all three engines. On macOS, WebKit uses Option-Tab to include buttons in native focus traversal.

`test:stress` builds a separate production React profiling bundle, then runs Chromium, Firefox and WebKit serially at 1440 × 1000. Keep port 4180 free and avoid running other CPU-heavy checks at the same time. The command writes `artifacts/stress/latest.json` and `latest.md`, including browser versions, host, source revision, dirty-tree status, test outcome, input samples and per-card commit counts. Failed assertions preserve the measurements collected so far. Generated artifacts are ignored by Git; an explicitly recorded baseline belongs in `docs/operations`.

The stress entry point is separate from the shipped application. The standard production build does not use React's profiling renderer. Its cards create no Profiler boundary unless a render observer is supplied.

For Chrome CPU/timeline attribution, run `npm run test:stress:trace`. It runs the previous global queries and the corrected scoped queries against the same application, writing `artifacts/stress/trace-comparison.md`, `.json` and `traces/*.json`. Load the raw Chrome trace in DevTools Performance. Phase marks, input marks and response measures align the measured workload with browser tasks, layout, paint and sampled stacks. The [trace checkpoint](operations/interaction-trace-checkpoint.md) explains why broad accessibility searches and retry diagnostics must stay outside the measured input path. Keep ordinary timing baselines untraced.

## Workload and acceptance

The fixture mounts all 500 React Flow cards, including offscreen cards. Four generated cards receive partial output every 50 ms. The remaining cards contain editable text; the first has enough text for native scrolling. The fixture runs the real workspace controller, document subscriptions, editor drafts, gesture owner and save lanes against simulated transport. It does not exercise an authenticated server, actual model calls, SSE networking or replica replay; those boundaries have separate integration tests.

| Phase          | Workload                                                                               | Required result                                                                               |
| -------------- | -------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| Streaming      | At least 30 ticks across four streams                                                  | Exactly four card subtrees commit, each at least 20 times; all 496 unrelated cards stay quiet |
| Tool switching | 24 alternating Pan/Select clicks while streams continue                                | Unselected, non-streaming cards do not commit                                                 |
| Input          | 24 selection clicks, 24 drag updates, 24 typed characters, 24 wheel pans; 350 ms saves | Each sample observes a visual update; only the edited card and streaming card subtrees commit |
| Blocked save   | Hold card 1's geometry response and make a newer move                                  | Card 7 saves and a run cancellation is accepted before the held response is released          |
| Conflict       | Release a conflicting response, type 12 characters, explicitly retry                   | Latest local geometry survives the conflict and retry; typing remains responsive              |

Each input category must have p95 below 100 ms and maximum below 250 ms. These are broad stall guards for a headless local run, not a universal frame-rate or device-performance target. Rendering isolation is an exact structural assertion; timing is hardware-dependent.

The [recorded baseline](operations/canvas-interaction-baseline.md) includes all input categories, per-phase frame gaps and the full raw report. Cancellation reduces the remaining active streams to three during the conflict-typing samples.

The added tests exposed and fixed three behaviors: Shift+Enter only added selection instead of toggling it; an owned pinch ignored a second finger over an editor; switching tools changed the resize data of every card. Resize availability now changes only for selected cards. Mixed mouse/touch sequences cannot take over each other's active gesture.

## What the measurements mean

Input timing starts when the browser delivers the captured `pointerup`, pressed `pointermove`, `input` or `wheel` event. The probe waits for the selected/tool class, textarea value or transform to change, then records the following animation frame. This provides an upper bound on a paint opportunity and includes one frame of measurement overhead. It excludes physical-device delivery latency and does not prove when pixels reached a display. In particular, the `input` event follows the browser's native text insertion. These measurements are not INP.

Card counts are React **subtree commits**, including descendant updates; they are not component function-call counts. Workspace render durations are the Profiler's `actualDuration` for committed updates; they exclude browser layout, paint and display time. Frame-interval summaries help reveal stalls that fall outside sampled input. Event Timing entries, where supported, are supplementary and filtered at 16 ms; absence of entries is not zero latency. The test fails if profiling is disabled rather than accepting zero commits as proof of isolation.

Use the raw report to compare the same workload on the same machine. Retain the source revision and browser versions. Establish a physical-device baseline before tightening timing budgets or choosing viewport culling, frame-coalesced presentation or a renderer replacement.

## Hands-on fixture

```sh
npm run preview:stress
```

Open `http://127.0.0.1:4180/e2e/stress/index.html?view=canvas`. Start the streams, choose a save delay and use **Conflict next move of card 1** before moving the first card. **Reset metrics** starts a fresh frame/render-count interval; **Export metrics** downloads that report. Automated input samples require `test:stress`. Reload in a fresh browser context to restore the scene and clear fixture drafts and camera state.

The fixture supports editing, moving, selecting, resizing, camera/focus changes, context selection, cancellation and geometry-conflict recovery. Create, import and new model submissions are outside its simulated API. Use the isolated full-application tests for those flows.

For a phone/tablet on the same development network, use the HTTPS fixture so native browser APIs have a secure context:

```sh
npm run preview:stress:device
```

Open `https://<Mac LAN address>:4188/e2e/stress/index.html?view=canvas`. The command creates a temporary self-signed certificate, serves the fixture on reachable interfaces and removes its key files when stopped. It installs no certificate or trust profile. SafariDriver accepts the certificate only for its isolated test session; a human browser must accept its local certificate warning. The fixture has no live credentials or model calls. Plain LAN HTTP is unsuitable for these checks because the app uses secure-context browser APIs.

## Repeatable device automation

Run device checks serially with the fixture already built and served. Keep the target browser foreground and the device unlocked. `test:device:safari` creates and deletes its own isolated Safari automation session. `test:device:android` creates and closes one tab in the attached Chrome; it disconnects without quitting Chrome or tracing other tabs. Both record per-delay assertions and fail with a nonzero exit code when a required interaction does not complete. Reports include browser/environment metadata, source revision and dirty-tree status in ignored `artifacts/stress/device/`. `STRESS_DEVICE_OUTPUT` can redirect the output for a smoke test without overwriting physical-device evidence.

For installed Safari on this Mac, start SafariDriver in another terminal, then run:

```sh
/usr/bin/safaridriver --port 4184
```

```sh
STRESS_DEVICE_LABEL='Mac / installed Safari' npm run test:device:safari
```

For the keyboard subset on a paired physical iPhone with Safari Web Inspector and Remote Automation enabled, connect by USB, leave Safari open and use:

```sh
SAFARI_PLATFORM=iOS SAFARI_DEVICE_UDID='<paired device UDID>' \
STRESS_DEVICE_LABEL='iPhone model' \
STRESS_DEVICE_URL='https://<Mac LAN address>:4188/e2e/stress/index.html?view=canvas' \
npm run test:device:safari
```

Device discovery is available through `xcrun devicectl list devices`. SafariDriver can host one active test session at a time. The iOS branch now uses Element Send Keys and DOM focus setup, verifies trusted key events, and records its restricted coverage in `ios-safari-keyboard-results.json`. It starts with four streams at each delay, verifies a second card can save and a run can cancel while the first response is held, then checks that newer geometry survives a conflict and keyboard-activated retry. It does not claim text insertion, touch, software-keyboard behavior or hardware keyboard traversal.

Avoid SafariDriver's W3C Actions on this iOS version. Our protocol log matches [WebKit issue 322937](https://bugs.webkit.org/show_bug.cgi?id=322937): an input sequence succeeds, then even the next browsing-context query receives no response. Switching `pointerType` or restarting only the host driver does not resolve the reported issue. Restarting Safari on the phone recovered our session. Element click/text probes were inconclusive too: a successful command response without the expected DOM change is not a pass.

For native iOS gestures, use XCUITest input with web-view observation instead of the affected WebKit Automation input path. Appium 3.7.0, XCUITest driver 12.12.1 and WebDriverAgent 16.12.7 were prepared under ignored `artifacts/stress/device/ios-tools/`; the native test runner compiled unsigned successfully. Its signed launch is blocked because Xcode reports **No Accounts** and has no matching development provisioning profile. Sign in under Xcode → Settings → Accounts, then build/sign the runner for the paired phone and continue the native matrix. The [Appium real-device setup guide](https://appium.github.io/appium-xcuitest-driver/latest/getting-started/device-setup/) describes that prerequisite. A signing certificate alone is insufficient to install this runner.

For an unlocked Android phone with USB debugging authorized and Chrome open, use `npm run preview:stress` for the localhost HTTP fixture, then:

```sh
adb devices -l
adb reverse tcp:4180 tcp:4180
adb forward tcp:59261 localabstract:chrome_devtools_remote
ANDROID_CDP_URL='ws://127.0.0.1:59261/devtools/browser' \
STRESS_DEVICE_LABEL='Phone model / Android version' npm run test:device:android
```

Localhost is a secure context on the phone. If Chrome uses a process-specific debugging socket, inspect `adb shell cat /proc/net/unix` for `chrome_devtools_remote` and forward that socket instead. Choose an unused host port; the values above are examples. After the run, remove only the mappings created for it with `adb forward --remove tcp:59261` and `adb reverse --remove tcp:4180`. Stop the fixture and SafariDriver processes started for testing.

## Human input record — pending

Record device model, OS, browser/version, input hardware, display refresh rate, device pixel ratio, viewport, source revision and fixture delay. Repeat each applicable row in Select, Write and Pan with four streams active, first at 350 ms and then at 1500 ms save delay. Record pass/fail and the exact reproduction for any failure; attach an exported interval and a browser performance trace where available.

| Hardware / scenario                                                                               | Expected behavior                                                                        | Status  |
| ------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- | ------- |
| Mac trackpad: horizontal/vertical scrolling and inertia over empty canvas                         | Camera pans smoothly and never creates or moves a card                                   | Pending |
| Mac trackpad: scrolling and text selection inside authored/generated content                      | Native content scroll/selection retains ownership; camera stays put                      | Pending |
| Mac trackpad: pinch over background and near a card boundary                                      | Canvas zoom stays anchored to the pointer; page scale stays stable                       | Pending |
| iPhone/iPad Safari and Android Chrome: editor taps, text selection handles, long press            | Native editing remains usable without changing placement selection                       | Pending |
| Mobile touch: background pan, pinch with second finger over editor/control, lift one finger       | One coherent viewport gesture; no card creation, click-through or accidental action      | Pending |
| Mobile: rotate and show/hide the software keyboard in Focus and Canvas                            | Active editor remains usable; no delayed command steals focus                            | Pending |
| Physical keyboard: Tab/Shift-Tab (Option-Tab on macOS Safari), Enter/Space, Shift toggles, arrows | Predictable focus traversal; editor keys never move cards                                | Pending |
| Slow save and conflict visible while editing a different card                                     | Input remains usable, independent save/cancel progresses, latest geometry survives retry | Pending |

The next architectural decision should use this record: classify any stall as event handling, React rendering, layout/paint or storage/transport, then change the responsible boundary and rerun the same workload. Card virtualization needs explicit editor-focus retention and gesture cancellation tests before adoption.
