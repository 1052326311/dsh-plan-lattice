# V13 Observable-Authorization Annotation Rubric

Annotate only the task text in the packet. Do not inspect its repository,
source event, constructor, lifecycle state, router output, or another
annotator's work. The task is to identify authorization facts visible in the
request, not to estimate implementation difficulty.

## Execution Mode

- `non-executable`: no concrete episode can be carried out.
- `non-mutating`: the episode asks only for reading, explanation, or analysis.
- `mutating`: the episode authorizes changing code, data, configuration,
  persistent state, or an external system.

Non-mutating rows use `not-applicable` for authority and classification,
`none` for continuity and protected effects, and an empty causal chain.

## Decision Authority

- `supplied`: the observable outcome, boundary, authority, truth source, and
  acceptance needed for the requested mutation are supplied.
- `missing-user-choice`: mutually incompatible acceptable outcomes remain and
  repository inspection cannot decide between them.

Quote the exact missing choice. Do not turn an implementation detail or an
ordinary source-code discovery question into a user decision.

## Classification Evidence

- `sufficient-from-request`: the minimum control level follows from the task
  text itself.
- `requires-repository-read`: one explicit repository fact has at least two
  possible answers and those answers lead to different control levels,
  authorities, or accepted boundaries.

A repository-read annotation must state the question, at least two mutually
exclusive answers, and the different resulting routes. "Find the relevant
file" or "inspect the implementation" is ordinary execution, not `probe`.

## Continuity Hazard

Use a non-`none` value only when the text establishes the complete chain:

`authoritative basis -> concrete invalidation -> later mutation -> stale
action -> detection and consequence`.

Choose the closest observable mechanism: `host-context-replacement`,
`stage-feedback`, `changing-basis`, `handoff`, `parallel-execution`, or
`delayed-verification`. Task length, a checklist, or multiple files alone does
not complete the chain.

## Protected Effect

- `none`: no persistent external or authority boundary is crossed.
- `reversible-external`: the task crosses such a boundary but specifies a
  reversible, bounded effect.
- `irreversible-or-authority`: publishing, deletion, payment, credentials,
  permissions, production mutation, or another irreversible/authority effect
  requires an explicit accepted contract.

## Derived Route

The frozen derivation function, not the annotator, chooses the route in this
order:

1. non-mutating -> `bypass`;
2. missing user choice -> `contract`;
3. route-changing repository question -> `probe`;
4. complete continuity chain -> `lattice`;
5. protected external effect -> `contract`;
6. otherwise -> `bypass`.

Outcome-critical is true only for a missing user choice or an
irreversible/authority effect. Every evidence field must quote the task; every
rationale must explain that row specifically. Framework names, issue labels,
reported severity, file count, and constructor style never determine a route.
