# Typed persistence and HTTP boundaries

`shared/schemas/index.ts` owns command validation. `Edit`, `Geometry`, `PlacementEdit`,
`ImportIntent`, `SubmitRun` and `SpawnArtifact` derive from those schemas. Service
commands use parsed output types; HTTP clients accept input types, so schema defaults
such as an omitted edits array remain explicit. Submission receipt and run status
types also derive from their schemas.

`server/db/records.ts` owns full persistence records for branes, blocks, runs, assets
and conversations. Ownership lookup selects the matching decoder and return type by
table name. It cannot return a run as an untyped object or accidentally expose brane
fields on it. Run submission, retry and worker claiming decode complete run records;
run options and receipts decode stored JSON. Invalid stored records throw an internal
error, not a request-validation error. SQL projections declare the shape actually
selected, including nullable joined fields; database records remain separate from
public responses. These declarations do not make TypeScript a SQL validator: local
integration tests check real queries against the migrated database.

`shared/contracts.ts` describes public response shapes. Configuration, budgets,
estimates and run inspection have explicit service return types. Run inspection
projects its fields deliberately and excludes owner IDs, submission keys/hashes,
lease internals and persisted options/context columns. Missing output/checkpoint
records are represented as null. Failed-run retry returns `{ runId, outputBlockId }`.
Workspace reads preserve summary-only PDF representations; expanding page text still
requires the separate representation endpoint. Stored content and expanded payloads
are validated without unchecked JSON flowing into workspace records.

`src/services/api.ts` returns `unknown`. Callers cannot supply an arbitrary response
type. `src/services/client.ts` provides typed endpoint methods and validates successful
responses before returning them. The workspace controller, artifact/history views,
imports and shell use these methods. Malformed successful responses raise
`InvalidApiResponse`; submission treats this as uncertain delivery and retains the
original request journal. SSE run updates share a schema and fall back to an
authoritative refresh if malformed.

`tests/contracts.types.ts` is compiled by `npm run typecheck`. Its negative checks
must fail for unchecked transport reads, malformed command shapes, wrong-table
fields and attempts to access internal fields on a public run response. Runtime
contract tests reject incomplete or mistyped responses. Authenticated API tests
exercise the same client against real Hono endpoints and SQLite, verify public
projection fields and check that persisted corruption is reported as a server error.

This boundary work leaves lifecycle ownership unchanged: the run worker and run/cost
services still share transition writes. The next refactor should collect claim,
begin-attempt, completion, cancellation and lease expiry into explicit transactional
operations, with a transition matrix covering attempt and reservation outcomes.
