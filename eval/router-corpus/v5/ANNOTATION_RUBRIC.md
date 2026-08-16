# V5 Authoritative Mutation Basis Rubric

Annotate the request without reading or running the Plan Lattice router. Product
names and task nouns are not labels. Judge the causal conditions under which an
agent could safely authorize the next mutation.

## First Principle

Long-task drift, compaction drift, handoff drift, stale-plan execution, and
wrong-file edits share one harness-layer root cause: a mutation is authorized
from an intent or fact basis that is no longer authoritative and current.

Judge every request on three independent axes:

1. `basisCompleteness`: whether the accepted outcome, boundaries, authority,
   source of truth, target, and acceptance criteria are sufficiently known now.
2. `expiryExposure`: how likely that basis is to become stale before the task is
   complete because of duration, dependent stages, external change, compaction,
   handoff, parallel agents, or repeated mutation epochs.
3. `staleImpact`: how much damage an action based on stale assumptions can cause
   to P0 outcome, authority, persistent data, compatibility, security, or scope.

Completeness is not task length. A fully specified multi-stage program can still
need `lattice` because its basis will expire. A short request can need `contract`
because a missing authority or truth-source decision changes the result.

## Labels

- `bypass`: the authoritative mutation basis is complete, expiry exposure is
  low, stale impact is low, and the bounded change can be verified directly.
- `contract`: the basis has an outcome-critical gap, or moderate work/stale
  impact requires one durable agreement, but repeated re-entry through a work
  graph is not justified.
- `lattice`: expiry exposure or stale impact is high enough that execution must
  repeatedly re-enter the accepted contract and current root-to-leaf plan before
  mutation. Typical causes are dependent stages, dynamic reframing, irreversible
  state changes, multi-agent work, compaction/handoff, or delayed verification.

`probe` is not an annotation label. It is a temporary runtime prediction used
when repository evidence is needed before choosing one of the three labels.
Annotators must assign only `bypass`, `contract`, or `lattice` from the supplied
request and must not infer hidden repository facts.

## Outcome-Critical Ambiguity

Set `outcomeCritical: true` when a missing fact can change the primary result,
scope, authority, source of truth, irreversible effect, or acceptance. Such a
row cannot be labeled `bypass`.

## Annotation Record

Each JSONL annotation contains:

```json
{
  "id": "v5-001",
  "route": "contract",
  "outcomeCritical": true,
  "confidence": "high",
  "authoritativeMutationBasis": {
    "basisCompleteness": "incomplete",
    "expiryExposure": "low",
    "staleImpact": "high"
  },
  "rationale": "The request omits the authority boundary that determines P0 success."
}
```

Use `complete`, `partial`, or `incomplete` for `basisCompleteness`; use `low`,
`medium`, or `high` for the other two axes. Confidence is `high`, `medium`, or
`low`. Rationales must cite causal execution requirements, not keywords.

## Adjudication

Two annotators label every candidate independently. A third annotator sees only
the candidate `id`, `language`, and `text` for rows where route or
`outcomeCritical` differs. The packet never reveals either primary annotation,
rationale, or axis assessment. Selection requires a two-vote route majority and
at least two non-low-confidence supporters. The final blind set is frozen once
at 120 rows: 60 English and 60 Chinese, with 60 `bypass`, 36 `contract`, and 24
`lattice` labels.
