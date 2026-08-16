# Router V3 Annotation Rubric

Annotate the implementation task represented by each issue excerpt. Repository,
query group, issue label, text length, and category words are not labels.

Annotators receive only `candidates.jsonl` and this rubric. Router source,
router output, source groups, previous blind labels, and other annotations are
off limits.

## Route

- `bypass`: a bounded question, local capability change, maintenance update,
  or existing-behavior defect with a concrete object and observable correct
  result. A long issue template or diagnostic log does not add execution span.
- `contract`: an implementation request whose product behavior, authority,
  source of truth, security/data boundary, irreversible side effect, or
  acceptance condition remains outcome-critical and underspecified.
- `lattice`: one strong long-horizon signal or two independent span signals.
  Strong signals include a populated tracking/RFC/KEP program with multiple
  milestones or deliverable tracks, persistent-state migration with rollback
  or compatibility, dynamic requirements, explicit multi-agent execution, or
  at least eight atomic implementation stages. A word such as migration,
  upgrade, refactor, or KEP in an otherwise local task is not sufficient.
- `exclude`: spam, duplicate, support-only question with no implementation
  request, insufficient excerpt, or a task that cannot be assigned confidently
  after applying this rubric.

Examples of bounded work: expose an existing command in one additional file,
show an existing tag in a table, accept a float where an integer is currently
validated, fix a reproducible UI regression, or bump one dependency.

Examples of contract work: define OAuth/permission semantics, design secret
storage and deletion, decide cross-tenant truth, introduce a product capability
without observable acceptance, or change externally visible authority.

Examples of Lattice work: alpha/beta/stable implementation plus code and docs,
cross-component architecture with staged acceptance, major-version data and
configuration migration with rollback, or evolving multi-agent execution.

## Outcome Critical

`outcomeCritical: true` means an unconfirmed assumption about target behavior,
scope, authority, data/security truth, or acceptance can change the P0 result
or cause an unsafe side effect.

`route: bypass` MUST have `outcomeCritical: false`. If an assumption is truly
outcome-critical, use `contract`, `lattice`, or `exclude`; never emit the
internally contradictory pair `bypass + true`.

## Confidence

- `high`: the text directly satisfies the route definition.
- `medium`: one reasonable inference is required, with no competing route.
- `low`: material ambiguity remains. Low-confidence rows are diagnostic only
  and cannot enter the hard blind gate.

## Output

Preserve input order and write one JSON object per row:

```json
{"id":"candidate-001","route":"contract","outcomeCritical":true,"confidence":"high","rationale":"one sentence","exclusionReason":null}
```

For `exclude`, provide `exclusionReason`. For retained routes it must be null.
