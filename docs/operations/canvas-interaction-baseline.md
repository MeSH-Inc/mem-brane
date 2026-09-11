# Canvas interaction baseline

Recorded: 2026-09-11T20:28:07.488Z. Outcome: passed.

Production React profiling build, 1440×1000 headless browsers, one worker. All 500 card nodes remain mounted; four streams update every 50 ms. Transport is simulated. No live model or backend is used. Input measurements are double-rAF upper bounds on a paint opportunity, not physical display latency. Profiler counts are card-subtree commits, not component function calls. Timing thresholds are broad regression guards, not a frame-rate guarantee.

Host: Apple M4 Pro, darwin 25.6.0 (arm64); Node v24.13.1.

Revision: 18c2d87430e5a2c32c817d814e45aca03f1c0a31 with working-tree changes.

| Browser                | Phase / input                      | Samples | Median (ms) | p95 (ms) | Max (ms) |
| ---------------------- | ---------------------------------- | ------: | ----------: | -------: | -------: |
| chromium 153.0.8010.12 | tool-switching-with-streams / tool |      24 |        30.1 |     32.2 |     32.2 |
| chromium 153.0.8010.12 | interaction-with-streams / click   |      24 |        27.7 |     29.4 |     30.8 |
| chromium 153.0.8010.12 | interaction-with-streams / drag    |      24 |        32.7 |     34.1 |     34.1 |
| chromium 153.0.8010.12 | interaction-with-streams / typing  |      24 |        24.3 |     30.8 |     30.8 |
| chromium 153.0.8010.12 | interaction-with-streams / wheel   |      24 |        15.7 |     16.3 |     16.3 |
| chromium 153.0.8010.12 | faults / conflict-typing           |      12 |        25.5 |     30.9 |     30.9 |
| firefox 155.0          | tool-switching-with-streams / tool |      24 |        15.0 |     16.0 |     16.0 |
| firefox 155.0          | interaction-with-streams / click   |      24 |        15.0 |     17.0 |     17.0 |
| firefox 155.0          | interaction-with-streams / drag    |      24 |        17.0 |     17.0 |     18.0 |
| firefox 155.0          | interaction-with-streams / typing  |      24 |        11.0 |     15.0 |     28.0 |
| firefox 155.0          | interaction-with-streams / wheel   |      24 |        15.0 |     17.0 |     17.0 |
| firefox 155.0          | faults / conflict-typing           |      12 |        10.0 |     14.0 |     14.0 |
| webkit 26.6            | tool-switching-with-streams / tool |      24 |        31.0 |     33.0 |     34.0 |
| webkit 26.6            | interaction-with-streams / click   |      24 |        21.0 |     29.0 |     31.0 |
| webkit 26.6            | interaction-with-streams / drag    |      24 |        24.0 |     33.0 |     34.0 |
| webkit 26.6            | interaction-with-streams / typing  |      24 |        24.0 |     29.0 |     30.0 |
| webkit 26.6            | interaction-with-streams / wheel   |      24 |        31.0 |     33.0 |     34.0 |
| webkit 26.6            | faults / conflict-typing           |      12 |        24.0 |     30.0 |     30.0 |

chromium: streaming alone committed 4 card subtrees (card:placement-001: 30, card:placement-002: 30, card:placement-004: 30, card:placement-005: 30). Workspace React render duration p95: 0.2 ms.

firefox: streaming alone committed 4 card subtrees (card:placement-001: 30, card:placement-002: 30, card:placement-004: 30, card:placement-005: 30). Workspace React render duration p95: 1.0 ms.

webkit: streaming alone committed 4 card subtrees (card:placement-001: 30, card:placement-002: 30, card:placement-004: 30, card:placement-005: 30). Workspace React render duration p95: 1.0 ms.

Raw samples, frame intervals, Event Timing availability and all subtree commit counts are in [canvas-interaction-baseline.json](canvas-interaction-baseline.json).

Physical touch, trackpad hardware and installed Safari/iOS still require the hands-on protocol in the [verification guide](../interaction-verification.md).

This measurement was captured before the commit containing this baseline. The recorded parent revision and dirty-tree flag are preserved; the accompanying source files contain the measured implementation.

Local verification passed 387 unit/API tests, 122 browser cases and all three stress runs. Two multi-touch cases are explicitly skipped outside Chromium; native taps, wheel input and keyboard checks pass in every engine.

## Frame gaps and follow-up

| Browser  | Phase                       | Frame interval p95 (ms) | Longest interval (ms) | React render p95 (ms) |
| -------- | --------------------------- | ----------------------: | --------------------: | --------------------: |
| chromium | stream-only                 |                    16.7 |                  16.8 |                   0.2 |
| chromium | tool-switching-with-streams |                    83.4 |                  83.4 |                   0.5 |
| chromium | interaction-with-streams    |                    16.8 |                  16.8 |                   0.5 |
| chromium | faults                      |                    83.3 |                 133.3 |                   0.5 |
| firefox  | stream-only                 |                     9.1 |                   9.5 |                   1.0 |
| firefox  | tool-switching-with-streams |                    66.8 |                 142.0 |                   1.0 |
| firefox  | interaction-with-streams    |                     9.1 |                  17.5 |                   1.0 |
| firefox  | faults                      |                    96.1 |                 386.4 |                   1.0 |
| webkit   | stream-only                 |                    20.0 |                  48.0 |                   1.0 |
| webkit   | tool-switching-with-streams |                    91.0 |                  96.0 |                   1.0 |
| webkit   | interaction-with-streams    |                    21.0 |                  29.0 |                   1.0 |
| webkit   | faults                      |                    96.0 |                 156.0 |                   1.0 |

The sampled tool clicks and selection clicks respond within the same broad bounds as typing and dragging. Some unsampled frame intervals are much longer during tool switching and fault handling. Low React render durations do not explain those intervals. A trace must distinguish browser scheduling, layout/paint, automation effects and other main-thread work before attributing them to the application. These runs do not establish continuous smoothness or a physical-device performance budget.

Recommended next round: capture targeted browser performance traces around tool switches and conflict-banner appearance, aligned to the input markers; run the physical-device protocol with 350 ms and 1500 ms delays on a Mac trackpad, iOS Safari and Android Chrome. Classify the dominant cost before changing the renderer. If offscreen layout dominates, evaluate viewport culling while retaining the active editor, selection and in-progress gesture ownership.
