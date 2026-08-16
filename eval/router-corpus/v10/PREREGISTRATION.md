# V10 Router Evaluation Preregistration

## Claim

V10 tests whether the frozen zero-model-call router selects the least durable
control capable of preventing a later protected mutation from using an
incomplete or invalidated intent-and-fact basis. It does not test general coding
quality and does not claim that every model error is drift.

V1-V5 remain failed first reveals. V6-V9 remain immutable pre-reveal failures.
V9 established that a large source frame is insufficient when rare decision
and continuity episodes are collected only from complete review bodies in a
fixed repository window. V10 changes the source design before any router reveal;
it does not add rows to, relabel, or rescore an earlier protocol.

## Fixed Source Frame

The source universe is the exact set of GitHub Search queries in
`source-frame-spec.json`, evaluated once against objects whose observable
updates are at or before `2026-08-15T23:59:59Z`. Query order, terms, page count,
cutoff, structural constructors, language gates, diversity requirements, and
source-isolation rules are frozen before collection.

The frame has two queues:

- `natural` contains native public issue requests selected from fixed time
  windows for English and fixed high-frequency native-language markers for
  Chinese. It supports metrics only for this declared search frame; it is not a
  population estimate for all agent traffic.
- `challenge` contains source-backed episodes found by fixed family-specific
  searches. Search terms intentionally increase the supply of rare causal
  structures. Challenge results support sensitivity and safety claims, never
  natural prevalence.

The challenge construction families are:

1. `bounded`: one maintainer-authored inline or review request against a fixed
   pull-request diff, with no required later feedback cycle in the rendered
   episode.
2. `decision`: an initial mutation request followed by the last unresolved
   maintainer question at the cutoff.
3. `continuity`: an initial pull-request task, maintainer change request, and a
   later commit after that feedback. Inline comments count; an empty aggregate
   review body is not required.
4. `repository-contingent`: an issue whose requested action has two observable
   repository states that may require different control levels.

Construction family is metadata, not a label. Three independent annotations
must establish the primitive authorization facts. A structurally sourced row
whose annotation does not support its intended route remains in the denominator.

## Counts And Diversity

After source isolation and duplicate collapse, capacity must exist for:

```text
natural/en:                    400
natural/zh:                    400
challenge/en/bounded:           60
challenge/en/decision:          60
challenge/en/continuity:        60
challenge/en/repository:        60
challenge/zh/bounded:           60
challenge/zh/decision:          60
challenge/zh/continuity:        60
challenge/zh/repository:        60
total:                        1280
```

Every challenge stratum must cover at least 15 repositories and 8
organizations. Final selection caps each challenge stratum at 4 rows per
repository and 8 per organization. Natural selection caps each repository at
10 rows, each organization at 20, and each author at 2. One issue or pull
request timeline is one independent task episode and can appear only once
across all queues and families.

If any capacity or diversity requirement fails, V10 is retired before seed
access, annotation, or router execution. No query, threshold, or failed stratum
is repaired in place.

## Source Isolation

- Exclude every V1-V9 repository, canonical fork network, stable node ID, URL,
  issue/PR family, associated commit, duplicate chain, prompt digest, canonical
  prompt digest, and five-token near-duplicate cluster.
- Resolve repository transfers and forks through current immutable repository
  metadata; both repository and canonical source network are compared.
- Exclude deleted, inaccessible, bot-authored, post-cutoff-edited, truncated,
  or over-limit timelines.
- Native-language text is required. Translated variants are forbidden.
- Search rank may define the frame but cannot select the final row. Final
  selection uses only a seed commitment and stable source identity after
  capacity succeeds.
- Raw public text and full API responses remain in a private audit artifact
  until redistribution review. Public freeze artifacts contain stable URLs,
  node IDs, timestamps, digests, counts, and the exact collector.

## Annotation

Annotators receive only randomized `{id, language, text}` rows. They receive no
query family, source metadata, repository identity, prior labels, router output,
or aggregate counts. They label observable primitive facts only; the route and
`outcomeCritical` are derived by frozen code.

Reliability gates apply globally and per language:

- Fleiss kappa at least 0.75;
- Gwet AC1 at least 0.80;
- unanimous rate at least 0.85; and
- pairwise Jaccard at least 0.60 for every rare positive class, with at least
  40 positive rows per language before adjudication.

The adjudicator sees only disagreements with shuffled A/B/C identities and may
choose one complete annotation record. It cannot synthesize fields.

## Router Freeze And Gates

The router source commit, compiler, Node identity, lockfile, emitted artifact,
configuration, candidate prompts, labels, sources, and all digests are frozen
before one reveal. The configuration is:

```json
{
  "activationMode": "auto",
  "clarificationPolicy": "critical",
  "controlCeiling": "lattice",
  "longTaskThreshold": 8
}
```

Challenge gates use one-sided 95 percent Clopper-Pearson bounds over independent
task episodes:

- bypass false-activation upper bound <= 0.05;
- contract recall lower bound >= 0.85;
- lattice recall lower bound >= 0.90;
- probe recall lower bound >= 0.85;
- outcome-critical bypass count = 0; and
- probe false-positive upper bound on non-probe challenge tasks <= 0.10.

Natural exact accuracy, macro F1, prevalence, false activation, and abstention
are reported separately and cannot substitute for a failed challenge gate.

## One-Reveal Rule

No router score, prediction, partial confusion row, language score, or failure
example may be inspected before all freeze digests are committed. Any runtime
execution consumes the reveal. Any pre-reveal failure emits an immutable failure
manifest and retires V10. A successor must use a new protocol ID and a
source-disjoint frame.
