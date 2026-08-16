# Router V13 Preregistration

## Purpose

V13 is a new one-reveal evaluation of the automatic Plan Lattice router. It
does not repair or relabel any V1-V12 result. The router under test is the exact
runtime at commit `b5971547af8c733312d2efce888cdf2573cc379d`.

V12 was publicly frozen and then retired before archive acquisition, body
access, annotation, beacon access, or router reveal. Its first public CI run
found a test-only cleanup race: a concurrent suite could remove an untracked
compiled marker before V12 cleanup. V13 uses a source-only worktree marker with
idempotent cleanup. Production router code, source construction, thresholds,
the prospective window, and the future beacon are unchanged. A new protocol
ID and public tag are required because V12 forbade every post-freeze test-tree
change.

V11 was retired before seed access because live GitHub Search could not replay
its historical cutoff: a returned object had been edited after the cutoff.
V13 removes mutable search from the source path. It uses versioned GH Archive
hour objects and only object families created after the V11 cutoff.

## First-Principle Boundary

The router chooses the minimum control that prevents a later mutation from
using an incomplete or invalidated intent-and-fact basis. Labels are derived
from observable authorization facts, not issue keywords or implementation
difficulty:

- no mutation authority: `bypass`;
- unresolved user authority or protected effects: `contract`;
- repository evidence can change the control level: `probe`;
- a complete basis-invalidation chain reaches a later mutation: `lattice`;
- otherwise a bounded, sufficiently authorized mutation: `bypass`.

## Frozen Router

Before the first prospective GH Archive hour exists, the public Git tag
`router-v13-protocol-freeze` binds the complete implementation and test tree.
Any code change after that tag retires V13 rather than repairing it. Before any
selected GH Archive body is read, V13 also binds:

- router commit `b5971547af8c733312d2efce888cdf2573cc379d`;
- the two tracked router source files in `source-frame-spec.json`;
- combined source digest
  `2d6cfee09af8ca0124e112454577104e7652f86439f476aef3413a95d4292abd`;
- a runtime built only from `git archive` at that exact commit with Node
  `v22.23.0` and TypeScript `5.9.3`, never ignored worktree output;
- default automatic-routing configuration; and
- every release threshold.

Source collection, annotation, adjudication, blind selection, and reveal may
not change those files. A failed reveal is retained and the router may only be
improved for a new protocol version and a new source frame.

## Prospective Immutable Source Frame

The exact 24 GH Archive hours from `2026-08-17T00:00:00Z` through
`2026-08-17T23:59:59Z` are fixed in `source-frame-spec.json` before the first
hour exists. The first 12 hours form object families; the last 12 provide a
frozen follow-up window. All begin after `2026-08-15T23:59:59Z`, the V11
cutoff. V13 accepts an issue or pull-request family only when its authoritative
opened event occurs inside the formation window.
Therefore no accepted family could have appeared in the V10/V11 searches,
which required `updated:<=2026-08-15`.

After all 24 hours mature, acquisition downloads each compressed object twice
with identity encoding. Both downloads must match in SHA256, byte count, ETag,
GCS generation, last-modified value, and provider hash headers. Exact gzip
bytes are retained in content-addressed storage. Acquisition does not
decompress, parse, preview, or index any body. It publishes a sorted archive
manifest and Merkle root before source construction begins.

Only a second, offline stage may reverify and decompress those frozen bytes.
Byte-count, gzip, UTF-8, JSONL, duplicate event ID, or hour-boundary
disagreement is fatal. The acquisition and collector never call GitHub REST,
GraphQL, or Search.

The hour list cannot be changed after observing content. An unavailable,
mutable, truncated, malformed, oversized, or metadata-incomplete object
retires V13 before selection-seed access.

## Deterministic Constructors

Constructors expose only event-snapshot facts and fixed neutral framing. They
do not use the router, a model, hidden labels, repository reads, or later live
state. Precedence is frozen:

1. maintainer change request;
2. unresolved maintainer decision;
3. explicit long-program request;
4. repository-contingent request;
5. bounded defect;
6. natural opened request.

At most one constructor survives for an issue or pull-request family. Public
hash ordering and frozen repository caps bound the annotation pool. Capacity
failure retires V13; quotas are not lowered after collection.

## Annotation And Blind Selection

Three isolated annotators receive only randomized `{id, language, text}`
packets and the frozen observable-authorization rubric. They receive neither
source metadata nor router output. Agreement gates apply to primitive facts
before adjudication. Adjudication selects one complete existing annotation
record and may not synthesize a fourth label.

Only after reliability and an exact capacity-flow witness pass may selection
read drand mainnet round `6391766`, scheduled for
`2026-08-20T00:00:00Z`. Selection derives its seed from the protocol ID,
archive Merkle root, capacity-manifest digest, and verified beacon randomness.
No local selection seed exists before that round. Selection creates 60 English
and 60 Chinese rows with the frozen per-route counts and diversity caps.
Insufficient post-label capacity retires V13 before beacon access.

## One Reveal And Gates

The exact frozen router runs once. Required gates remain:

- simple-task false activation at most 5%;
- complex-task non-bypass recall at least 90%;
- zero outcome-critical bypasses;
- exact accuracy at least 80%;
- macro F1 at least 80%;
- Lattice recall at least 90%; and
- probe recall at least 85%; and
- probe false-positive rate at most 10%.

The result is immutable whether it passes or fails. Passing these router gates
only unlocks the separately preregistered external-model infrastructure runs;
it is not itself evidence of coding-quality uplift.

## Prohibited Claims

Collection capacity, annotator agreement, or router accuracy is not evidence
that Plan Lattice improves software-task outcomes. Stable v0.4 publication
still requires the complete external-model release gate. No leaderboard or
"best in the world" claim may be made without comparable independent evidence.
