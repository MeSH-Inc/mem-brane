# Assets and representations

An asset owns immutable SHA-256 digest, MIME type and byte length. The
`assets_owner_digest` index shares bytes only within an owner. Distinct import
keys still publish distinct artifacts and placements. Upload intents reserve
physical bytes before asynchronous writes, and uncertain writes retain those
reservations. A matching digest can reuse either published bytes or an outstanding
reservation. Immutable object collisions are verified against the requested digest.

Binary live content and revisions contain a format, caption, filename and
`representationId`. Generated columns turn that JSON identity into a foreign key.
An immutable `asset_representations` row pins an asset and a canonical extraction
payload. Its identity hashes the asset ID, format and canonical payload; owners
therefore cannot share representations across the asset ownership boundary.
Identical inspections reuse a representation, while a new extractor or changed
result gets a new identity. New live content can select it; older revisions remain
pinned to the old result.

Image dimensions and PDF page text live in representation payloads. PDF
`ready`/`unavailable` describes the immutable extraction outcome, not mutable job
progress. Import operations own pending/ready delivery progress. Extraction runs
synchronously in the bounded import operation, with PDF parsing in a bounded worker;
there is no additional extraction queue or duplicated job state.

Workspace reads use an immutable summary projection for PDF metadata and omit page
text. The UI retrieves pages on demand by their pinned representation identity.
Revision, estimate and provider consumers expand full content at their read
boundaries. Admission counts expanded content, so normalizing storage cannot bypass
context limits. Restoration checks asset bytes against canonical digests,
representation identities, summary projections, foreign keys, ownership and format.

Extraction policies identify the parser version, options and limits. Results bind a
policy and asset to an immutable representation. Imports serialize matching
owner/digest/policy work within the database handle and reuse persisted results on
later deliveries, while still verifying original object integrity.

Migrations preserve revision identities and provider content. They abort rather
than guess if legacy hashes are missing, conflicting, or cannot satisfy canonical
owner/digest uniqueness. No object deletion is attempted during SQL migration.

Import completion stores a block foreign key and the original placement identity.
The placement ID is historical, so it survives placement removal without a foreign
key or a geometry snapshot. Completed receipts are immutable. Both first delivery
and retry return `{ blockId, placementId, braneId }`; the UI refreshes authoritative
workspace state. Reconciliation never recreates a removed placement or applies an
old position. Request hashes still reject reuse of an import key with different
bytes, filenames or placement intent.

The [offline consolidation tool](../operations/asset-read-efficiency.md) can resolve
legacy duplicate owner/digest rows before migration 015. A verified original backup
precedes reference rewriting. Redundant objects stay in a cleanup journal and in
quota accounting until deletion or absence is acknowledged.
