# Asset normalization results — September 8, 2026

The asset follow-up is implemented in three code commits:

- `9c57870`: owner-scoped asset deduplication and canonical immutable metadata.
- `37f7260`: independently stored representations pinned by live content and revisions.
- `8a7846e`: compact immutable import receipts and current-state client reads.

Distinct import keys create distinct artifacts while sharing owner-scoped bytes.
Concurrent delivery and uncertain acknowledgements converge on one stored object
and one reservation. Quota admission includes committed bytes plus unresolved
reservations. A newer extraction cannot rewrite an older revision or its provider
context. Restoration validates referenced bytes, representation payload identities,
foreign keys, ownership and formats.

## Binary and PDF fixture

[Raw measurements](asset-scaling.json) come from a deterministic 128×96 noise PNG
and a five-page PDF with complete multi-line extracted text. Each file was imported
20 times with distinct keys. Every artifact received one snapshot. The probe
requires at least 6,000 extracted PDF characters, so clipped or unavailable text
cannot accidentally make the payload comparison look favorable.

| Measured quantity                                |       Result |
| ------------------------------------------------ | -----------: |
| Artifacts / revisions / receipts                 | 40 / 40 / 40 |
| Stored assets / representations                  |        2 / 2 |
| Original object bytes, stored                    |       47,095 |
| Original object bytes, without deduplication     |      941,900 |
| Compact live and revision JSON bytes             |       11,840 |
| Shared representation payload bytes              |        7,233 |
| Equivalent expanded live and revision JSON bytes |      306,520 |
| Compact wire receipt bytes                       |        6,080 |
| Reconstructed full import-result JSON bytes      |      166,838 |
| Verified content references                      |           80 |

The object-byte reduction is 95% for this deliberately repeated fixture. These
logical payload counts exclude database rows, indexes, asset metadata, request
hashes, WAL, backups and filesystem allocation. Full import results are
reconstructed from current DTOs, rather than measured by running an older binary.
They are a payload comparison, not a claim about total database allocation, process
memory, ingestion speed or representative production deduplication rates.

Reproduce without a server or persistent database:

```sh
NODE_ENV=test node --import tsx scripts/asset-scaling.ts /tmp/asset-scaling.json
```

## Verification and migration limits

`npm run verify` passed formatting, type checking, build, 187 tests and 18 browser
tests. Tests include concurrent distinct and same-key delivery across service
instances; owner isolation; quota reservations; write acknowledgement loss;
publication rollback; migration equivalence for frozen image/PDF provider content;
new extraction versions; missing and corrupted restoration data; receipt migration;
and retry after placement movement or removal. The binary/PDF probe independently
verified all 80 content references after the final fixture adjustment.

SQL migration does not read or delete object-store bytes. Canonical asset migration
aborts transactionally if legacy hashes are absent/conflicting or existing duplicate
owner/digest rows violate the new uniqueness rule. Such a database needs an explicit
offline consolidation before upgrade; the migration does not silently discard
physical objects or guess integrity metadata. Fresh databases and the checked-in
migration fixtures pass. No live database migration or remote push was performed.

## Recommended next round

1. Reuse validated extraction results before launching a parser. Give each extraction
   policy an explicit identity containing parser version and limits; look up by
   owner-scoped asset plus policy, and coalesce concurrent work. Test exactly one
   parser invocation for repeated uploads, policy changes producing new immutable
   representations, and corrupt originals still failing integrity checks.
2. Split PDF workspace summaries from page-text reads. Keep filename, page count,
   compatibility and representation identity in workspace state; fetch page bodies
   for inspection and provider execution. Verify a large PDF no longer dominates
   every workspace response while frozen provider messages and estimates stay equal.
3. Add an offline canonicalization preflight for legacy duplicate objects. Produce a
   deterministic owner/digest mapping, check actual bytes, rewrite references without
   changing expanded messages, and journal redundant objects for resumable cleanup.
   Validate crash points and backup restoration before deleting any redundant bytes.
