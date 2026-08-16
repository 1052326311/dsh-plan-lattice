# V11 Source Frame Protocol

## Immutable Inputs

`source-frame-spec.json` fixes the V10 spec digest, cutoff, search-page window,
candidate limits, GraphQL batch size, connection limits, capacity targets, and
failure reserve. Search definitions are loaded from the digest-bound V10 spec;
V11 cannot silently edit or reorder them.

The two network stages are separate and immutable:

1. `recover-v10-exposure-registry.mjs` replays page 1 only and writes an
   identity-only exposure registry plus manifest, or a failure manifest.
2. `collect-source-frame.mjs` verifies that registry, reads pages 2-10 only,
   materializes candidates, and writes a source frame plus evidence manifests,
   or a failure manifest.

Neither stage accepts or reads a selection seed.

## Exposure Registry

For every item returned by every V10 page-1 search, registry recovery emits one
row per query exposure. Repeated objects remain represented under every query
that exposed them. Rows contain no title, body, comment, diff, label, route, or
model-derived value.

Registry recovery fails closed when:

- a search response reports `incomplete_results`;
- an item lacks node ID, repository, URL, number, or stable object type;
- an item timestamp is later than the cutoff;
- query identity differs from the frozen V10 spec;
- rate-limit state cannot be determined or reaches the frozen reserve; or
- any output already exists.

The registry manifest binds the V10 spec, V11 spec, recovery implementation,
registry bytes, query counts, and search rate-limit snapshots.

## Search Collection

V11 requests the same 42 queries in query-ID order, with `per_page: 100` and
pages 2-10. For each query:

- `incomplete_results` must be false on every page;
- `total_count` must remain identical across fetched pages;
- results must contain complete identity and cutoff fields;
- a repeated node within the same query is rejected as search-page drift;
- every V10 exposure match is rejected before materialization;
- page-2+ results are deterministically ordered and capped by the frozen
  per-query candidate limit; and
- the manifest records returned pages, accessible count, whether GitHub's
  1,000-result cap applied, and all rate-limit snapshots.

The cap flag is descriptive. Search incompleteness or inconsistent pagination
is fatal; GitHub's documented 1,000-result ceiling is a known frame boundary.

## GraphQL Materialization

Candidates are resolved by global node ID in frozen-size GraphQL batches. The
query requests only observable source facts:

- issue or pull-request text and immutable timestamps;
- repository identity, owner, primary language, fork ancestry, default branch,
  and the latest default-branch commit at or before the cutoff;
- issue comments;
- pull-request reviews, inline review threads/comments, and commits; and
- GraphQL rate-limit cost, remaining quota, and reset time.

Every requested ID must appear exactly once with the expected object type and
repository. Missing or mismatched nodes retire the protocol. Candidate-local
content failures are written to the rejection ledger. Any connection with
`hasNextPage: true`, a nested truncated review thread, or a `totalCount` that
does not equal returned nodes is rejected as `timeline-pagination-truncated`.
If fork ancestry remains truncated at the frozen query depth, the candidate is
rejected as `repository-lineage-truncated`.

GraphQL errors, an absent `rateLimit` object, or remaining quota below the
frozen reserve retire the protocol with a precise failure manifest. No
best-effort fallback to per-object REST timeline calls is permitted within V11.

## Observable Constructors

V11 preserves V10's five constructors and family precedence:

1. continuity;
2. decision;
3. repository-contingent;
4. bounded; and
5. natural.

Bounded uses one maintainer action request. Decision uses an unanswered latest
maintainer question at the cutoff. Continuity requires maintainer feedback and
the first later commit. Repository-contingent requires a conditional artifact
reference plus a valid default-branch commit at the cutoff. Natural uses the
original issue request.

Empty repositories and unavailable cutoff commits produce
`cutoff-base-commit-unavailable`; they do not throw.

## Final Isolation and Capacity

Accepted rows are collapsed by task family, exact prompt identity, and fixed
5-shingle Jaccard at 0.85. They must remain disjoint from the committed V1-V9
inventory and every V10 exposure identity.

Capacity and repository/organization diversity are computed only after all
queries and GraphQL batches complete. Any failed stratum writes the immutable
private frame, audit, and ledger plus a public failure manifest, then exits with
status 2. A passing frame writes the public source manifest instead. Neither
outcome accesses a seed.

