# Router V11 Preregistration

## Status

V11 is a preregistered successor to the retired V10 source collection. V10
failed before emitting any source metrics because an empty repository returned
HTTP 409 from the commits endpoint. The immutable V10 failure record states
that the selection seed was not accessed and that no partial metrics were
observed.

This protocol is frozen before the V11 collector is implemented or run. V11
does not repair, continue, or reinterpret V10. It establishes a new,
source-disjoint search frame.

## Exposure Boundary

V10 queried page 1 of each of the 42 searches in its frozen
`source-frame-spec.json`. Because no durable request trace survived, V11 uses a
conservative recovery rule: every item returned when those exact page-1
searches are replayed is registered as V10-exposed, whether or not V10 later
fetched its repository or timeline.

The recovery script may read only:

- the frozen V10 source-frame spec whose SHA256 is recorded in the V11 spec;
- GitHub Search page 1 for each frozen query; and
- response metadata required to detect incomplete search results and rate
  limits.

It must not read router code, labels, annotations, model scores, source bodies,
the V10/V11 selection seed, or any seed path. The public registry stores only
identity and provenance: node ID, task-family identity, repository, URL,
object type, search family, query ID, exact query, page, and rank.

V11 excludes every registered object by node ID, source-family ID, or
normalized URL. Excluding a source-family ID also excludes reviews, comments,
and commits belonging to the exposed issue or pull request.

## V11 Search Frame

V11 reuses the frozen V10 query text and cutoff but begins at page 2. It
collects pages 2 through 10, the remainder of GitHub's documented 1,000-result
search window. The 1,000-result cap is recorded explicitly; it is not mistaken
for complete enumeration of every matching GitHub object. `incomplete_results`,
page drift, unexpected duplicates, missing page metadata, or any result later
than the cutoff retires V11 before seed access.

Search results are deterministically ordered without a selection seed. At most
the frozen per-query candidate limit proceeds to source materialization.

## Source Materialization

GitHub Search remains REST because its page semantics define the frame.
Repository and timeline data are fetched in GraphQL `nodes` batches to avoid a
REST request per timeline edge. Every connection needed by a constructor must
be complete within the frozen limit. `hasNextPage`, a count larger than the
returned connection, missing requested nodes, repository-lineage truncation,
or post-cutoff mutable content is an explicit rejection or protocol failure as
defined in `SOURCE_FRAME_PROTOCOL.md`.

An absent default branch, a non-commit default target, or no commit at or
before the cutoff is the rejection `cutoff-base-commit-unavailable`. It is not
an exception and cannot abort collection.

## Isolation

V11 applies both boundaries:

1. the complete committed V1-V9 source inventory used by V10, including
   repository/fork-network, node, URL, related PR, commit, prompt digest, and
   near-duplicate exclusions; and
2. the recovered V10 exposure registry.

No selection seed is available to registry recovery or source collection. A
selection seed may be accessed only by a later, separately frozen assembly
stage after source capacity and diversity pass.

## Fail-Closed Gates

V11 retires before seed access on any of the following:

- V10 spec digest or query-set mismatch;
- exposure registry or registry-manifest digest mismatch;
- incomplete or drifting GitHub Search pages;
- REST Search or GraphQL rate-limit exhaustion;
- GraphQL transport, schema, pagination, node-identity, or cutoff uncertainty;
- output reuse or partial-output ambiguity;
- overlap with V1-V9 or the V10 exposure registry;
- insufficient language/family capacity;
- insufficient repository or organization diversity; or
- a source-frame, audit, or rejection-ledger digest mismatch.

All failures write an exclusive failure manifest with stage, class, sanitized
operation, rate-limit snapshot when available, and `seedAccessed: false`.
Collector outputs are never overwritten.

## Prohibited Claims

V11 source capacity is not router accuracy and is not product-uplift evidence.
No release, benchmark claim, or Discussion update is allowed from this stage.

