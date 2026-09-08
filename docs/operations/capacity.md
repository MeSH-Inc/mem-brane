# Capacity exercise — September 8, 2026

All measurements came from isolated temporary SQLite databases and built Node
servers on the development Mac: Node 24.13.1, arm64 macOS, 24 GiB memory, 12 logical
CPUs. Four parallel HTTP readers fetched 40 complete workspace responses while two
mock workers drained queued runs. These are local fixture measurements, not VPS,
Internet, browser-rendering, live-provider or sustained-soak benchmarks.

| Fixture                     | Placement/text limits    | Run queue / output limit       | HTTP p95 | Response size | Peak sampled server RSS | Max event-loop delay | Queue wait p95 |
| --------------------------- | ------------------------ | ------------------------------ | -------- | ------------- | ----------------------- | -------------------- | -------------- |
| Original representative     | 500 × 2,048 characters   | 100 / 128 tokens, short prompt | 38 ms    | 1.21 MB       | 200 MiB                 | 35 ms                | 24 s           |
| Original maximum text       | 500 × 100,000 characters | 100 / 128 tokens, short prompt | 1,050 ms | 50.18 MB      | 1,621 MiB               | 720 ms               | 29 s           |
| Intermediate response bound | 200 × 20,000 characters  | 20 / 128 tokens, short prompt  | 58 ms    | 4.07 MB       | 388 MiB                 | 35 ms                | 5 s            |
| Full output, queue 20       | 200 × 20,000 characters  | 20 / 1,024 tokens, long prompt | 75 ms    | 4.08 MB       | 329 MiB                 | 56 ms                | 75 s           |
| Final defaults              | 200 × 20,000 characters  | 8 / 1,024 tokens, long prompt  | 60 ms    | 4.08 MB       | 341 MiB                 | 47 ms                | 25 s           |

Every fixture returned 40 HTTP 200 responses, rejected an additional placement at
the cap, and completed all admitted runs. RSS is the maximum of periodic process
samples; it is not a guaranteed allocator peak or whole-machine memory use.
Earlier fixtures predate the concurrent typed-content migration, which adds small
content tags; that difference does not explain the response-size reduction.

The final settings meet this development-host target: p95 reads below 100 ms,
sampled server RSS below 512 MiB, event-loop delay below 100 ms, and p95 mock queue
wait below 30 seconds. A 20-run queue failed the queue-wait target at full output,
so the default is eight. Actual providers may be slower; no universal latency SLO
is implied. Worker concurrency remains two because increasing it would amplify
memory use and paid-request concurrency without production-host measurements.

Text limits are enforced at mutation boundaries, ingestion and worker output. A
32 KiB serialized-content ceiling also bounds Unicode and JSON-escaping expansion.
The aggregate response includes placement metadata, visible generated output and
recent run checkpoints, so the character product is not a complete byte estimate.
The test uses ASCII text; multibyte limit enforcement is covered separately.

Imports retain a single consumer and a ten-second fetch deadline. Admission is now
six globally and three per actor. That cap is a conservative scheduling choice from
the serial timeout bound, not a measured remote-page throughput claim. Image-byte
quotas remain unchanged; this exercise does not establish live R2 throughput or
worst-case simultaneous upload memory use.

Reproduce the final fixture without touching live data:

```sh
npm run build
node --import tsx scripts/capacity.ts /tmp/capacity-report.json 8 20000 1024
```

The script creates fixture users, fills a brane through domain services, seeds a
bounded queue, starts the built server, measures latency/bytes/RSS/loop delay/run
waits, then removes only its own temporary data. It requires no provider credentials.
Raw reports are checked in beside this document as `capacity-*.json`.

Next capacity work should repeat this exact fixture on the intended production
host and add a sustained mixed workload with uploads and imported pages. Revisit
limits only after comparing p95/p99 latency, sampled RSS, queue wait and disk headroom.
