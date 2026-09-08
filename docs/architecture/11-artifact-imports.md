# Artifact imports and representations

Paste, file drop and the file picker feed one import coordinator. Each imported file becomes an independently reusable artifact with a placement. Pasting into the composer explicitly adds that artifact as a reference; importing onto the canvas does not imply model context. No import starts a generation.

## Capture and recovery

Adapters synchronously capture files from the event's DataTransfer. Its items and files collections are alternate views, never two batches. Plain-text paste retains native selection replacement. A mixed text/file paste into an editor imports the files while leaving native text insertion intact. HTML is not injected or fetched. Unsupported items receive individual errors without discarding supported files.

Imports capture actor, brane, target, filename and geometry at initiation. File drops use screen-to-canvas coordinates. Canvas editor pastes place artifacts beside their source; picker and composer imports find unoccupied space. Batch items have deterministic spacing. Pending previews are shown in the import tray.

The shell-owned coordinator persists each accepted blob and operation key in actor-scoped IndexedDB before sending. It permits two simultaneous transfers and bounds pending blob storage to 50 MiB; the per-file limit comes from server configuration (5 MiB by default). Navigation does not own an upload. Late completion cannot attach a file to another brane or actor. Ready composer imports are delivered when their destination is mounted and refreshed; Run waits until those references are visible.

Reload reconciles uncertain imports through their server receipts. Explicit Retry checks status before resending the same blob and intent. A lost response after commit therefore does not create another artifact. Failed local persistence prevents transmission. Dismiss removes a local receipt, not a committed artifact; uncertain delivery must first be resolved. Completed receipts release their locally stored blobs. Browser storage remains recoverable client intent, not authoritative artifact history.

## Durable operation boundary

POST /imports accepts multipart file and a JSON intent containing key, braneId, target and geometry. The actor comes from authentication. The key is scoped to that actor and binds a hash of the original bytes, filename and complete intent. Changed delivery under an existing key is rejected. GET /imports/:key exposes only that actor's pending state or committed result.

The import service owns the process-local concurrency gate (four active operations), validation, quota reservation and durable completion. Concurrent identical deliveries share one operation. Asset writes occur outside SQL transactions. A retry after process restart verifies an existing immutable object's hash before reusing it. Otherwise it writes to the reserved object identity. The final transaction authorizes the destination again, creates asset metadata, typed content and placement, consumes the upload intent and commits the operation receipt together.

Uncertain storage writes and failed metadata commits retain upload intents. Existing offline reconciliation can remove abandoned objects and release reservations. A subsequent retry can reserve the same operation's object identity again. Storage failure is never treated as proof of successful artifact creation.

## Content and model representations

Content is a discriminated union of text, webpage, image and PDF, validated at artifact creation. Asset references require identity, MIME type and SHA-256 hash. Filename and caption/display text are separate fields. Placements remain independent of content and revisions.

Images preserve original bytes. Sharp recognizes supported raster formats and fully decodes every frame before acceptance, enforcing 20 million total pixels and 100 frames. SVG and HTML are not accepted. New images record dimensions and frame count. Older image revisions may have unknown dimensions; migration preserves their identities and hashes. The original-image-v1 model representation uses the existing low-detail image policy. Animated images can be stored and previewed, but model context requires a still image.

PDFs preserve original bytes and are served as authenticated downloads. PDF.js extracts embedded text in a disposable worker with a 15-second deadline and a 128 MiB old-generation JavaScript heap budget. Rendering, document scripts and remote URL ingestion are not enabled. The build includes the worker beside the server bundle.

A PDF records filename, original asset identity/hash, page count and a pdf-text-v1 representation. Ready representations contain complete, ordered page text and an explicit extractor version. Every page retains its number, including empty pages. The extraction budget is 100 pages, 20,000 characters and a conservative 24,000-byte serialized-text bound. Exceeding a page/text bound stores the original with an unavailable representation; partial extraction is never silently submitted. Graphical PDFs without embedded text are retained with an explicit OCR-unavailable reason. Malformed, locked or resource-exhausting files fail import and retain their local retry material.

A valid stored PDF can be snapshotted independently of whether its text representation is usable. Model compatibility is checked separately in estimation, run admission and message resolution. Ready PDF text works with text-only models and carries no image-token surcharge. The model receives page-labeled extracted text, explicitly excluding diagrams, images and visual layout. Unavailable representations are rejected before a run is queued. The composer and Spawn surface those constraints.

Run inputs freeze the full representation and extractor version in immutable revisions. Execution reads those pages, never current extraction state, and verifies the original asset hash. Images use the same original-byte integrity path. Future OCR or rendered-page representations must have their own versioned representation identity and explicit model/cost policy; they must not rewrite an already-submitted representation.

## Verification

Service tests cover concurrent duplicate delivery, changed-payload conflicts, lost object-write acknowledgements, rollback after metadata failure, malformed images, pixel limits, actor isolation and frozen image bytes. Client tests cover real IndexedDB blob recovery, local quota failure, mixed batches, native paste behavior and actor/brane isolation. Browser tests exercise native screenshot/text paste, picker/drop, pending previews, coordinates, navigation and lost HTTP responses against the built app.

PDF tests cover exact original retention, page boundaries and empty pages, text-only model admission, frozen representation replay, corrupted originals, malformed PDFs, page/text limits and graphical PDFs. Browser tests verify downloads, readable page text, frozen run inputs and unavailable-context controls. Migration verification preserves placements, runs, revision identities and immutability while checking the full foreign-key graph before commit.
