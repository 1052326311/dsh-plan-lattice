# V10 Source Frame Protocol

## Fixed Inputs

`source-frame-spec.json` is the complete search contract. Collection reads no
router code, labels, model scores, selection seed, prior failure examples, or
post-cutoff task content. GitHub credentials are obtained from the existing
`gh` credential store and are never written to artifacts.

## Collection Order

1. Verify the spec, cutoff, query IDs, and absence of output artifacts.
2. Build the complete V1-V9 source inventory from committed evidence.
3. Execute every frozen GitHub Search query in ID order.
4. Resolve repository identity and canonical source network before fetching a
   timeline; reject prior networks immediately.
5. Materialize the family-specific observable timeline using only events at or
   before the cutoff.
6. Apply native-language, length, immutable-time, human-author, truncation,
   exact-source, and prior-near-duplicate gates.
7. Collapse overlapping searches and related issue/PR rows into one task family
   with a deterministic family precedence: continuity, decision,
   repository-contingent, bounded, natural.
8. Compute capacity and diversity without accessing the selection seed.
9. Write either an immutable failure manifest or the private source frame,
   private audit, rejection ledger, and public digest manifest exactly once.

## Observable Constructors

### Bounded

The rendered episode includes the pull-request title/body, exact review file and
diff hunk when available, and one maintainer action request. It excludes later
feedback and commits. Annotation decides whether the resulting task is actually
bounded.

### Decision

The rendered episode includes the original issue and the latest human comment
when that comment is a maintainer-authored question with no later human answer
at the cutoff. Annotation decides whether the unresolved choice is
outcome-critical.

### Continuity

The rendered episode includes the pull-request task, one maintainer change
request, and the first later commit. The feedback may be an aggregate review or
an inline review comment. The commit timestamp must be later than the feedback;
all review and commit collections must be complete within the frozen limits.

### Repository-Contingent

The issue text must contain a conditional state expression and a repository
artifact reference. The collector stores the repository default-branch SHA as
the host precondition. Annotation decides whether inspection can change the
required control level.

## Failure Semantics

Rate-limit exhaustion, API truncation, repository identity drift, output reuse,
source overlap, duplicate clusters, cutoff uncertainty, insufficient capacity,
or insufficient repository/organization diversity retires the protocol before
seed access. Failed rows stay in the rejection ledger and are never silently
replaced after results are visible.
