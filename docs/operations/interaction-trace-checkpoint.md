# Canvas trace checkpoint — September 11, 2026

The long frame gaps around tool switching and conflict appearance came from the stress harness's DOM inspection. An unchanged application produced zero main-thread tasks over 50 ms in both phases once the harness scoped its selectors and stopped generating accessibility snapshots while awaiting a delayed conflict. This evidence supports keeping the current gesture owner, per-entity subscriptions, local drafts and independent save lanes.

## Controlled comparison

`npm run test:stress:trace` runs two Chromium cases against the same production profiling bundle: the previous global role/text queries and the corrected scoped queries. Both execute the same 500-card workload, four streams at 50 ms, delayed saves, held writes, independent saves/cancellation and conflict recovery. Chrome timeline events and CPU samples are aligned to `stress:phase:*` marks; individual input marks and response measures remain available in the raw trace.

Host: Apple M4 Pro, macOS kernel 25.6.0, arm64, Node 24.13.1. Chromium 153.0.8010.12. Source: `54ce598` plus the harness changes in this checkpoint. Traces reported no data loss.

| Phase / harness            | Frame gap max | Tasks >50 ms | Longest task | Sampled selector work | Sampled assertion snapshots |
| -------------------------- | ------------: | -----------: | -----------: | --------------------: | --------------------------: |
| Tool switching / previous  |       83.4 ms |           24 |      99.5 ms |             2204.2 ms |                        0 ms |
| Tool switching / corrected |       16.8 ms |            0 |      20.4 ms |               31.0 ms |                        0 ms |
| Conflict / previous        |      133.4 ms |            4 |     143.7 ms |              127.9 ms |                    266.0 ms |
| Conflict / corrected       |       16.8 ms |            0 |       8.3 ms |               14.1 ms |                        0 ms |

Playwright's global `getByRole` traversed the 500-card accessibility surface before delivering the tool click. CPU stacks identify `queryRole` and descendant accessible-name work in Playwright's injected script. Scoping the query to `.canvas-tools` removes that traversal. Cancellation and retry queries now target their respective panels too.

While waiting for the deliberately delayed conflict, a missing-locator `expect(...).toBeVisible()` generated `ariaSnapshotForExpectFailure(document.body)` on retries. CPU samples descend through `generateAriaTree` and `getTextAlternativeInternal`. The corrected case uses the locator's visibility wait, which still times out if the banner never arrives and preserves the subsequent geometry assertions. The previous queries and assertion remain only in the trace control case.

The trace summary attributes CPU samples to the thread named by `Profile`, because Chrome emits `ProfileChunk` events from a separate profiler thread. Profile IDs are scoped by process. Tests cover thread identity, ancestor classification, unrelated application queries, phase clipping, missing profiles and assertion snapshot attribution. Sampling estimates are not exact function durations. Layout, paint and main-thread tasks are nested measurements; never add them together as independent costs.

## Untraced regression run

All three engines passed the corrected workload. Each still committed exactly the four streaming card subtrees during the streaming-only phase; tool changes committed no unrelated card. All six input categories satisfied the existing p95 <100 ms and maximum <250 ms guards.

| Engine                 | Largest input p95 | Largest input sample | Largest observed frame interval across phases |
| ---------------------- | ----------------: | -------------------: | --------------------------------------------: |
| Chromium 153.0.8010.12 |           33.5 ms |              33.7 ms |                                       16.8 ms |
| Firefox 155.0          |           22.0 ms |              33.0 ms |                                       32.4 ms |
| WebKit 26.6            |           33.0 ms |              34.0 ms |                                       50.0 ms |

The [machine-readable checkpoint](interaction-trace-checkpoint.json) retains phase timings, input summaries, subtree counts and trace attribution. Full raw samples and Chrome trace files remain in ignored `artifacts/stress/`; rerun the commands to reproduce them. A traced comparison diagnoses cost; the separate untraced run supplies the response measurements. Neither establishes physical display latency or a universal frame-rate guarantee.

## Architectural decision and follow-up

Do not replace the renderer or add viewport culling based on the old gaps: the expensive stacks belonged to the test harness, and the corrected workload preserves the intended rendering isolation. Keep input recognition and transient previews local, preserve native editor ownership, and allow each entity's save lane to progress independently.

Complete the physical input matrix in the [verification guide](../interaction-verification.md), distinguishing injected device input from fingers, trackpad inertia, text-selection handles and software-keyboard behavior. At 350 ms and 1500 ms saves, exercise background pan/pinch, native editing, focus changes and conflict recovery. Investigate any reproducible failure at its owning boundary before expanding this refactor. Only evaluate culling if a trace with realistic content establishes offscreen layout as a dominant application cost; first specify active-editor retention and gesture cancellation invariants.
