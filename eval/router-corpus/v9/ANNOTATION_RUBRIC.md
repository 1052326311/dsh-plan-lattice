# V9 Observable Authorization Rubric

## Scope

Label only the supplied request. Treat it as the complete model-visible input
for one autonomous episode in a clean checkout at the stated base commit. Do
not search the web, inspect a repository, infer the future implementation, or
guess what a stronger model might discover.

Natural rows preserve the public request text. A concrete defect with observed
and expected behavior authorizes the smallest verifiable repair unless it asks
only for analysis. Challenge rows may include a fixed, source-backed task
envelope. That envelope authorizes work but does not itself prove ambiguity,
continuity, or a repository contingency.

Every execution-drift failure in Plan Lattice's control domain has one form:
a later mutation is authorized from an incomplete, invalidated, or non-current
intent-and-fact basis. Routing decides how much durable control is justified
before execution. It does not predict patch quality.

## Observable Facts

### `episodeMode`

- `non-executable`: spam, an empty template, a corrupt fragment, or a completed
  status with no remaining request.
- `non-mutating`: explanation, investigation, review, or triage that does not
  authorize changing an artifact or protected system.
- `mutating`: an explicit change request or a concrete defect whose fixed
  envelope authorizes the smallest verifiable repair.

### `decisionAuthority`

- `supplied`: outcome, scope, truth source, and authority are sufficient to
  begin the least risky valid path.
- `missing-user-choice`: two or more incompatible outcomes, boundaries,
  authorities, truth sources, or acceptance policies remain for the user to
  choose. Repository inspection and model preference cannot decide them.
- `not-applicable`: required for non-mutating episodes.

Quote the unresolved choice. General missing implementation detail is not a
user decision.

### `classificationEvidence`

- `sufficient-from-request`: the request determines the control level.
  Locating code, reading tests, or finding an implementation owner is ordinary
  execution and always belongs here.
- `requires-repository-read`: one specific repository fact has mutually
  exclusive possible answers that require different control levels, authority,
  or accepted boundaries. State the question, at least two possible answers,
  and at least two resulting routes.
- `not-applicable`: required for non-mutating episodes.

"Which file implements this?" never qualifies. A generic instruction to read
the repository also does not qualify unless the request names or establishes
the route-changing alternatives.

### `continuityHazard`

Use `none` unless the request plus fixed Harness envelope establishes the full
chain below:

```text
authoritative basis item
-> observable invalidation event
-> later mutation opportunity
-> stale action
-> detection point and consequence
```

Allowed values:

- `host-context-replacement`: at least eight explicit mutation stages, a
  declared long-running program, or an explicit compaction boundary;
- `stage-feedback`: an earlier stage result changes a later mutation;
- `changing-basis`: requirements, accepted facts, or an external truth source
  can change during the episode;
- `handoff`: another executor later mutates from transferred context;
- `parallel-execution`: concurrent executors can act from diverging copies;
- `delayed-verification`: later mutation is allowed before prior work can be
  verified; or
- `none`: no complete observable chain.

Issue severity, text length, checklist count, file count, and a guessed number
of implementation steps are not continuity hazards. Eight form fields are not
eight mutation stages.

### `protectedEffect`

- `none`: local artifact work with no explicit protected side effect.
- `reversible-external`: an explicit persistent or external effect with a
  stated rollback, preview, dry run, or isolated fixture.
- `irreversible-or-authority`: publishing, deployment, payment, destructive
  persistent-state changes, credentials, permissions, or another explicit
  authority boundary without a complete reversible envelope.

Protected effects require a durable contract. They do not manufacture a
continuity hazard.

## Frozen Derivation

Annotators never write a route or `outcomeCritical` value:

```text
non-executable                              -> excluded
non-mutating                                -> bypass
missing-user-choice                         -> contract
requires-repository-read                    -> probe
continuityHazard != none                    -> lattice
protectedEffect != none                     -> contract
otherwise                                   -> bypass
```

`outcomeCritical` is true only for a missing user choice or an
`irreversible-or-authority` effect.

## Evidence Rules

- Every positive fact cites exact request text.
- Repository alternatives must be mutually exclusive and route differently.
- A continuity label records every causal-chain field and at least one direct
  quote for the invalidation mechanism.
- Do not use source URL, repository identity, queue, construction family,
  issue label, lifecycle state, another annotator, aggregate count, or router
  behavior. These are unavailable by design.
- If the supplied text cannot support the fact, label the conservative
  observable value. Source-custodian intent is not evidence.
