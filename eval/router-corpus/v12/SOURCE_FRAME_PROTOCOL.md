# V12 GH Archive Source Frame

## Frozen Objects

`source-frame-spec.json` fixes one prospective 24-hour UTC window from GH
Archive before its first hour exists. Selected hours are not probed before this
protocol and its acquisition implementation are committed publicly.

Acquisition requires two HTTP 200 downloads plus all metadata named in the
spec. It computes SHA256 over each exact compressed byte stream and requires
both observations to match. The exact gzip object is retained under its digest
in external content-addressed storage. The declared and observed lengths must
match. Acquisition must not decode gzip content.

After a manifest and Merkle root bind all 24 raw objects, the offline collector
reverifies every digest, validates gzip and JSONL, and checks event-hour
membership and globally unique event identity.

## Temporal Isolation

V10 and V11 searched only objects with `updated:<=2026-08-15`. V12 archive
hours begin at `2026-08-17T00:00:00Z`; every accepted issue or pull request must
also have `created_at` strictly after the old cutoff. The archived payload is
the event-time snapshot, so later edits cannot alter V12 input.

V12 additionally rejects exact prior URLs, node IDs, prompt digests,
canonical prompt digests, and near-duplicate prompts from the committed V1-V11
inventory. It keeps one row per source family and applies repository caps.

## Accepted Events

- `IssuesEvent` with action `opened` supplies issue title and body.
- `PullRequestEvent` with action `opened` supplies pull-request title and body.
- `IssueCommentEvent` with action `created` can replace the opened request with
  an explicit maintainer choice only when no later human answer appears through
  the complete follow-up window.
- `PullRequestReviewEvent` with action `created` and state
  `changes_requested` can participate in a continuity record only when a later
  `PullRequestEvent` synchronization is observed for the same post-cutoff pull
  request and head transition.
- `PushEvent` is supporting evidence only when its complete embedded commit
  list and head identity match the pull-request synchronization. It never
  supplies a route label by itself.

Bots, deleted actors, empty bodies, cross-hour records, pre-cutoff object
families, ambiguous language, and prompts outside the frozen length bounds are
rejected with counted reasons.

## Constructor Semantics

`bounded` requires a concrete defect plus reproduction/expected-versus-actual
evidence and no long-program signal. `program` requires an explicit long
sequence, large checklist, dynamic basis, parallel execution, or delayed
verification. `repository-contingent` requires a conditional repository fact,
at least two possible states, and observably different resulting boundaries.
`decision` requires a trusted maintainer question with explicit mutually
exclusive alternatives and no later human answer. `continuity` requires a
trusted change request, a later synchronized mutation, and source text that
states stale behavior and consequence. Remaining opened requests use
`natural`.

Constructors are candidate-enrichment mechanisms, not labels. Final routes are
derived only from independent annotations.

## Fail-Closed Artifacts

Success writes exactly:

- `source-frame.jsonl`;
- `source-frame.manifest.json`; and
- `source-frame.rejections.json`.

Failure writes only `source-frame.failure.json` plus any external temporary
download state; success artifacts are never partially reused. All repository
artifacts are exclusive writes. No local selection seed exists. The future
drand response is inaccessible to acquisition and collection, and selection
cannot accept it until annotation reliability and exact capacity both pass.
