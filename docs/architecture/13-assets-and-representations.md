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

Services expand persisted references into validated content at read boundaries.
Workspace, revision, estimate and provider consumers receive the same expanded
content shape. Admission counts expanded content, so normalizing storage cannot
bypass context limits. Restoration checks asset bytes against canonical digests,
representation identity against its payload, foreign keys, ownership and format.

Migrations preserve revision identities and provider content. They abort rather
than guess if legacy hashes are missing, conflicting, or cannot satisfy canonical
owner/digest uniqueness. No object deletion is attempted during SQL migration.
