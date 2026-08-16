# Router V2 Annotation Rubric

Annotate the task an implementation agent would receive from the issue text.
Do not infer a label from the repository, query group, issue label, text length,
or the words "bug", "feature", "refactor", "migration", or "upgrade" alone.

The annotation packet intentionally omits query groups and router output.

## Route

- `bypass`: a bounded question, local change, or existing-behavior defect whose
  intended result and responsibility boundary are already observable. The work
  may require repository investigation, but it does not need a product contract
  or a persistent multi-stage work graph before writing.
- `contract`: the requested product behavior, authority, source of truth,
  security/data boundary, irreversible side effect, or acceptance condition is
  outcome-critical and underspecified. A contract should be fixed before
  implementation, but the execution horizon is not independently long enough
  for a full graph.
- `lattice`: use only with one strong span signal or at least two independent
  span signals. Strong signals include an RFC/tracking program with unresolved
  design work, persistent-state migration with rollback/compatibility, dynamic
  requirements, explicit multi-agent execution, or at least eight atomic
  stages. Supporting signals include cross-module architecture change,
  multi-release rollout, several independently accepted milestones, and
  changing external facts.
- `exclude`: the excerpt is empty, spam, a duplicate, a support question with
  no implementation request, or too incomplete to establish even the intended
  task. Excluded rows cannot enter the blind set.

A word such as "deploy", "key", or "migration" in an issue template or in a
description of past behavior is not an instruction to perform that action.
Likewise, a tiny UI defect filed under a refactor label is not full Lattice work.

## Outcome Critical

Set `outcomeCritical` to true only when an unconfirmed assumption about target
behavior, scope, authority, data/security truth, or acceptance could change the
P0 result or cause an unsafe side effect. A long task can be non-critical, and
a short security or production task can be critical.

## Output

Write one JSON object per input row, preserving order:

```json
{"id":"candidate-001","route":"contract","outcomeCritical":true,"confidence":"high","rationale":"one sentence","exclusionReason":null}
```

Use `confidence: "high" | "medium" | "low"`. For `exclude`, provide a concise
`exclusionReason`. Do not read the router source, other annotator output, query
groups, or previous blind labels.
