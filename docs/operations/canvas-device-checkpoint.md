# Canvas device checkpoint — September 11, 2026

Installed macOS Safari and Chrome on a physical Pixel passed the bounded interaction checks at both 350 ms and 1500 ms save delays with 500 mounted cards and four active streams. These used browser-driver input injection. Human trackpad and touchscreen behavior remains unverified. iPhone Safari established a USB automation connection but did not complete a functional check.

| Target                                           | Input method                                                 | 350 ms / 1500 ms result                                                                                                                                                  |
| ------------------------------------------------ | ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Pixel 9 Pro XL, Android 17, Chrome 152.0.7977.83 | CDP touch, text and keyboard injection on the physical phone | Pass: native editor scroll retains camera; background pan; pinch with second finger over editor; typing during geometry conflict; newest geometry retained through retry |
| Mac, macOS 26.6, installed Safari 26.5           | SafariDriver pointer and keyboard injection                  | Pass: 12 Pan/Select switches, pointer selection, two newer keyboard moves around a held save, 12 text insertions during conflict, latest geometry retained through retry |
| iPhone 16e, iOS/Safari 26.6.1                    | Real-device SafariDriver session, USB, simulator disabled    | Blocked before functional checks completed; stale automation session refuses reconnection                                                                                |

Mac Safari's maximum tool response was 31 ms at 350 ms saves and 32 ms at 1500 ms saves. Maximum typing response was 32 ms and 27 ms respectively. These are input-capture-to-following-frame measurements, with one frame of probe overhead; they are not physical display latency.

The reconnected Pixel passed the expanded checked-in script on clean commit `85f14e8` at 21:24 UTC. This run uses corrected accessibility waits and replaces the initial Pixel probe as the current device record. All six checks passed at both save delays. Only the four streaming cards and the edited card committed; the other 495 card subtrees stayed quiet.

| Save delay | Typing samples | Typing median / p95 / max | Pan observation | Pinch observation | Frame interval max |
| ---------- | -------------: | ------------------------- | --------------: | ----------------: | -----------------: |
| 350 ms     |             12 | 17.8 / 29.9 / 29.9 ms     |         62.7 ms |            9.2 ms |            33.3 ms |
| 1500 ms    |             12 | 22.5 / 39.3 / 39.3 ms     |         63.7 ms |            8.3 ms |            33.3 ms |

There were no recorded frame gaps over 50 ms. Pan and pinch each have one sample per delay, so they are observations rather than latency distributions or acceptance budgets. Pan timing begins on the first pressed move and includes travel through the gesture recognition threshold. These are browser-injected inputs on real hardware; human fingers, inertia and display delivery remain outside this measurement. Raw reports and screenshots for the corrected Pixel run are in `artifacts/stress/device/pixel-corrected/`.

The [machine-readable record](canvas-device-checkpoint.json) contains the successful assertions, environment, timing summaries and connection failure. Raw local reports and screenshots are in ignored `artifacts/stress/device/`. No device serials or personal device names are recorded here. The iPhone session reached a secure, foreground HTTPS fixture after USB connection, then stopped answering page queries. Deleting the session timed out too. Restarting the owned SafariDriver recovered the host service, but Safari on the phone reported that it was still paired with the previous session. No iOS gesture result is inferred from that connection success.

## Reproduction and remaining work

The [verification guide](../interaction-verification.md#repeatable-device-automation) documents HTTPS setup and the `test:device:android` / `test:device:safari` commands. Both run the two save delays and fail when an assertion or driver command fails. The iOS branch uses SafariDriver's documented single-finger translation; it has not completed on this device and does not claim pinch coverage.

Stop the stale automation on the iPhone and rerun its script. Then perform the guide's human-input matrix at both delays: trackpad inertia and pinch; mobile selection handles and long press; one-finger continuation after pinch; rotation and software-keyboard transitions in Canvas and Focus; hardware keyboard traversal. Keep a screen recording and metric export for any failure. Trace and fix the responsible input, rendering or persistence boundary only when a reproduction demonstrates a problem; the [trace checkpoint](interaction-trace-checkpoint.md) does not support changing the renderer based on the previous headless gaps.
