# V4 Router Annotation Rubric

Annotate the task request without reading or running the Plan Lattice router.
Product names and words such as bug, feature, support, or tracking are not
labels. Decide from causal execution requirements.

## Routes

- `bypass`: the outcome and acceptance are explicit enough, the change is
  bounded and reversible, expected execution is short, and no missing fact can
  materially change P0 success, authority, data truth, or scope.
- `contract`: execution is moderate, but a missing product, boundary, source of
  truth, authority, side-effect, or acceptance decision should be made explicit
  before mutation. A contract is useful; a recursive node graph is not yet
  justified.
- `lattice`: the task is long, cross-module, dynamically reframed, materially
  irreversible, multi-agent, or a program of dependent work. It needs durable
  decomposition, leases, checkpoints, and re-entry after compaction/handoff.

## Outcome-Critical Ambiguity

Set `outcomeCritical: true` when an unknown can change the primary result,
scope, authority, truth source, irreversible effect, or acceptance. Such a row
must never be labeled `bypass`.

## Evidence Fields

For each row record:

- `route`: one of `bypass`, `contract`, `lattice`;
- `outcomeCritical`: boolean;
- `confidence`: `high`, `medium`, or `low`;
- `invariants`: concise causal observations from the request;
- `rationale`: why those observations imply the route.

Do not infer hidden repository facts. If the issue text is too incomplete to
bound success, label the definition gap rather than imagining an implementation.
