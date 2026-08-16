# V8 Router Evaluation Preregistration

## Purpose

V8 evaluates one falsifiable claim: whether the frozen zero-model-call router
selects the least durable control that can prevent a later mutation from using
an incomplete or invalidated intent-and-fact basis.

It does not claim that Plan Lattice prevents every model error. An action may
still implement a complete, current basis incorrectly. Outcome benchmarks,
tests, review, approval policy, and sandboxes evaluate those failures.

V7 is immutable pre-reveal failure evidence. Its ordinary closed-issue frame
could not supply the preregistered complex strata. V8 does not add rows to V7,
change its quotas, or inspect a V7 router score.

## Two Queues, Two Claims

### Natural queue

The natural queue contains 800 native-language public requests: 400 English
and 400 Chinese. Selection uses only a frozen platform object registry,
creation time, object type, language, length, source isolation, relationship
counts, and duplicate-cluster identity. Labels, issue labels, titles, body
keywords, router output, and model scores cannot affect inclusion.

This queue supports only:

- route prevalence in the declared source frame;
- natural-traffic exact accuracy and macro F1;
- natural simple-task false activation; and
- abstention and ineligible rates.

It is never reweighted or described as representative of all agent traffic.

### Source-backed challenge queue

The challenge queue contains 480 independent public task episodes: 60 per
language for each of four construction families. A family is fixed by public
timeline and repository facts before annotation, never by router output:

- bounded episode: a single source-backed mutation with immediate proof;
- decision episode: a mutating request with an unresolved user or authority
  choice, or a protected external effect;
- continuity episode: a complete basis-invalidation-later-mutation chain in a
  public tracker, review sequence, specification history, or handoff;
- repository-contingent episode: a public task whose fixed base repository has
  at least two mutually exclusive observable states that require different
  control levels.

Construction family is hidden from annotators. Three independent annotations
must confirm the observable facts. A failed construction remains in the
denominator and is never replaced.

This queue supports route-specific sensitivity and safety claims. It does not
estimate natural prevalence.

## Frozen Counts

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

The independent unit is a task episode. Repetitions, paired variants, review
turns, and multiple runs of one episode never increase the sample size.

## Source Isolation

- Exclude every V1-V7 repository network, repository node ID, URL, issue or
  discussion node ID, prompt digest, canonical prompt digest, linked PR,
  commit, duplicate chain, and calibration source.
- Resolve forks, transfers, and renames to one canonical network root.
- Cluster normalized prompts using deterministic 5-token shingles. Jaccard
  similarity at or above 0.85 is one duplicate cluster.
- Natural queue caps: 10 rows per repository, 20 per organization, 2 per
  author, 15 percent per ecosystem, and 25 percent per platform object type.
- Challenge queue caps per language and construction family: 4 rows per
  repository, 8 per organization, 12 per ecosystem, and 1 per duplicate
  cluster. Each stratum must cover at least 15 repositories and 8
  organizations.
- Native-language text is required. Machine or bot translation is excluded.
- Raw public text is retained only in the private audit bundle. Public
  evidence contains URLs, stable node IDs, timestamps, hashes, extractor code,
  and derived metrics pending redistribution review.

## Cutoff And Snapshot

The cutoff is `2026-08-15T23:59:59Z`. Every included body, comment, review,
relationship, commit, and repository fact must be observable at or before the
cutoff. Edited text without an immutable pre-cutoff version is excluded.
Objects created before the cutoff but changed after it are reconstructed from
an immutable source or rejected. PR-shaped search results are mechanically
excluded from issue queues.

Every source frame is sorted by a stable platform node ID and selected by
`SHA256(seed || queue || stratum || stableSourceId)`. Insufficient capacity,
time-boundary uncertainty, or source contamination retires V8 before
annotation. The source registry, queries, category IDs, counts, seed, and
rejection ledger are frozen before candidate text is materialized.

## Runtime Freeze

The router is the exact source at commit
`3d34a2e6fe71870caedb0bedecd53cfdb38195ef`. V8 builds an isolated read-only
artifact from that commit and records the source archive, dependency lock,
compiler, Node identity, emitted files, and artifact digest. Evaluation imports
only that artifact. Importing `lib/router.js` from the worktree is forbidden.

The router configuration is:

```json
{
  "activationMode": "auto",
  "clarificationPolicy": "critical",
  "controlCeiling": "lattice",
  "longTaskThreshold": 8
}
```

## Annotation And Adjudication

- Annotators receive only randomized `{id, language, text}` rows and the
  rubric in an export directory with no runtime, source metadata, prior labels,
  aggregate counts, or repository checkout.
- Three annotators label only observable primitive facts. Route and
  `outcomeCritical` are derived by frozen code.
- Reliability gates apply globally and separately by language. Route and every
  primitive require Fleiss kappa >= 0.75, Gwet AC1 >= 0.80, and unanimous rate
  >= 0.85. Derived `outcomeCritical` uses the same gate.
- Each rare positive class requires pairwise annotator Jaccard >= 0.60 and at
  least 40 positive rows per language before adjudication.
- The adjudicator receives only disagreement packets with anonymized and
  per-row shuffled A/B/C identities. It selects one whole record and cannot
  synthesize fields. Source metadata and runtime remain unavailable.
- Availability counts are not computed or displayed until adjudication is
  frozen.

## Router Gates

Primary challenge gates use one-sided 95 percent Clopper-Pearson confidence
bounds over independent task episodes:

- bypass false-activation upper bound <= 0.05;
- contract recall lower bound >= 0.85;
- lattice recall lower bound >= 0.90;
- probe recall lower bound >= 0.85;
- outcome-critical bypass count = 0; and
- probe false-positive upper bound on non-probe challenge tasks <= 0.10.

Natural metrics and construction-family metrics are reported separately.
Point estimates cannot substitute for a failed confidence-bound gate.
Repository-cluster sensitivity analysis is mandatory and repetitions are
collapsed within task before any interval or bootstrap.

## One Reveal And Failure Rules

Prompt, label, source, annotation, adjudication, runtime, protocol, and metric
artifacts are hash-bound before the one reveal. No partial score, per-language
score, confusion row, or failure example is available before that point.

Any pre-reveal failure produces an immutable failure manifest and retires the
entire V8 source frame. No rows are added, removed, relabeled, or replaced; no
threshold, seed, rubric, quota, or diversity cap is changed. A successor must
use a new protocol version and source-disjoint registry.

Any runtime execution consumes the reveal. A runtime mismatch, interrupted
reveal, or failed gate is retained as V8 failure evidence. Router code may then
be improved only for a new runtime commit and a new source-disjoint evaluation.
