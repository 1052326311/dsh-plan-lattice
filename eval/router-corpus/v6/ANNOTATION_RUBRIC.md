# V6 Authoritative Mutation Episode Rubric

## Fixed Execution Envelope

Treat the source text as the user's complete request. If it authorizes a code
change, the agent works in a clean checkout and produces the smallest
verifiable, PR-ready change. It does not operate a production system. If the
text asks only for information, the agent answers without inventing a write.

The object being labeled is this execution episode, not the severity of the
reported software problem.

## Root Cause

At the harness layer, drift has one causal form: a mutation is authorized from
an intent or fact basis that is no longer authoritative and current. Label the
facts needed to decide how often the agent must re-enter that basis. Do not
choose `bypass`, `contract`, `lattice`, `probe`, or `outcomeCritical`; the
frozen derivation function computes them.

## Primitive Facts

- `episodeEligibility`: `eligible` for a real request, `non-executable` for an
  empty template, corrupt fragment, spam, or text with no actionable episode.
- `mutationAuthorization`: `none` for no action, `read-only` for explanation or
  investigation, `write` only when the request authorizes artifact mutation.
- `basisClosure`: `closed` when accepted outcome and authority are sufficient;
  `user-decision-gap` when the user must choose outcome, scope, authority, truth
  source, or acceptance; `repository-evidence-gap` when read-only inspection can
  determine owner, scope, or execution span without a user decision.
- `authorizationEpochs`: `one` for one bounded mutation plus immediate proof;
  `few` for two through seven stable authorization cycles; `many` for eight or
  more, likely context replacement, or a program whose work cannot fit one
  stable evidence epoch.
- `invalidationDriver`: the concrete event that can invalidate the basis before
  a later mutation. Use `none` unless the full causal chain is explicit.
- `verificationHorizon`: `immediate`, `staged`, or `delayed` beyond later
  mutation opportunities.
- `staleActionLoss`: harm caused by executing a later mutation from the stale
  basis. This is not the severity of the original bug.
- `recovery`: how directly an incorrectly authorized mutation can be undone.

Every non-`none` invalidation driver requires five row-specific statements:

```text
authoritative basis item
-> concrete invalidation event
-> later mutation
-> stale action
-> detection point and consequence
```

Missing any link means there is no demonstrated Lattice cause. File count,
module count, issue length, security vocabulary, a crash, data loss caused by
the reported bug, or runtime cache staleness do not establish agent-basis
expiry by themselves.

## Nuisance Observations

Record reported issue severity, likely implementation scope, and runtime
dynamism separately. They are useful for auditing shortcuts but never feed the
label derivation function.

## Annotation Process

Three annotators label every candidate independently and cannot inspect the
router. Before freezing a blind set, disagreement statistics are computed from
the primitive facts and their derived labels. If route kappa is below 0.75,
outcome-critical kappa below 0.75, or any ordinal weighted kappa below 0.70,
the rubric is revised and a new source-disjoint candidate pool is collected.
The blind set is not revealed.

An adjudicator then writes one complete coherent fact record for each eligible
candidate. Fields are never combined by independent majority votes. The
adjudicator sees the candidate and all three annotations only after independent
annotation is complete. Repeated template rationales are rejected.
