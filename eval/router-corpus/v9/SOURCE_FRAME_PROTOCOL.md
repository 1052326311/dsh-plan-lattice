# V9 Source Frame Protocol

## Authorization Boundary

Candidate text may be read only after the source registry, this protocol, and
the collector implementation are committed. The collector never reads the
external selection seed. It creates an over-complete source frame; only the
later assembler may open the seed and choose rows.

The source frame applies the same invariant as the runtime: a row is admitted
only from a complete, cutoff-current source basis. Current GitHub text is not
proof of historical text. An object is therefore rejected when it was created
after the cutoff, its latest observable edit is after the cutoff, or the API
cannot expose a conservative content timestamp. REST issues and pull requests
use `updated_at <= cutoff`, which intentionally rejects harmless later
lifecycle activity rather than guessing whether the body changed.

## Independent Unit

One issue, discussion, or pull request is one task family. Its body, comments,
reviews, variants, and repetitions cannot create additional independent
episodes. The deterministic family partition is computed before inspecting
text:

- issue/discussion bucket 0-49: natural;
- issue/discussion bucket 50-74: decision construction;
- issue/discussion bucket 75-99: repository-contingent construction;
- pull-request bucket 0-49: natural;
- pull-request bucket 50-74: bounded construction; and
- pull-request bucket 75-99: continuity construction.

Issue families in the natural partition use a second fixed hash to choose
either the issue body or one issue comment. Pull-request families use at most
one review comment. Discussion families use the discussion body. No fallback
to another partition or object type is allowed when a chosen construction has
no eligible row.

After construction, true relationship facts form an undirected graph over
task families. Shared associated commits, shared pull requests, and duplicate
references create edges. A seed-independent hash retains exactly one family
per connected component before prompt deduplication. The cutoff default-branch
SHA is stored separately as `repositoryBaseCommit`; it is an external
precondition and never creates a relationship edge.

## Public Objects

The collector reads only the object types declared by the frozen registry:

- GraphQL issue bodies and their duplicate/closing-PR relationships;
- REST issue comments;
- GraphQL discussions from frozen category IDs;
- REST pull-request review comments; and
- GraphQL review/commit timelines only for pull requests already assigned to
  the continuity partition.

Repository default-branch state is fixed to the latest commit at or before the
cutoff. It is used only as source evidence for repository-contingent episodes.

## Challenge Constructions

The construction family is hidden from annotators and is not a target label.
Frozen observable rules nominate source-backed attempts:

- `bounded`: one inline maintainer review request tied to an exact path and
  diff hunk, with bounded text and a mutation verb;
- `decision`: the latest pre-cutoff maintainer issue comment asks an unresolved
  question with an explicit alternative connector;
- `continuity`: a maintainer `CHANGES_REQUESTED` review, an intervening commit,
  and a later maintainer review request form one ordered episode; and
- `repository-contingent`: a public issue or discussion contains an explicit
  two-state conditional plus a repository-state reference and is bound to the
  cutoff branch commit.

These rules can nominate a semantically invalid attempt. Independent
annotation decides the observable facts; failed attempts remain in the frozen
denominator and are never replaced.

## Privacy And Integrity

Raw public text and relationship evidence are written only to the external
private audit bundle. Candidate text is normalized and credential-shaped
strings and email addresses are redacted. The public repository receives only
the collector, protocol, frozen registry, and later non-text manifests and
digests pending redistribution review.

Collection is fail-closed. API pagination drift, a post-cutoff edit, missing
category identity, unresolved fork/source identity, an uncollapsed relation,
digest mismatch, or insufficient deterministic capacity retires V9 rather than
changing a query, threshold, source, or quota.
