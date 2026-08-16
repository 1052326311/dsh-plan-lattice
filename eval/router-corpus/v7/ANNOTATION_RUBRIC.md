# V7 Observable Authorization Rubric

## Object Being Labeled

Treat the supplied text as the complete request for one autonomous episode in
a clean checkout. A concrete bug report with observed and expected behavior
authorizes a smallest PR-ready fix unless it explicitly asks only for analysis.
An already completed status report does not authorize another mutation.

The annotation predicts neither the implementation nor the quality of the
eventual patch. It records only facts visible in the request and fixed Harness
envelope. Every positive fact must cite request text verbatim.

## One Root Cause, Two Decisions

Every execution-drift failure in the plugin's control domain has one form: a
later mutation uses an incomplete or invalidated intent-and-fact basis.

Routing asks how much durable control is justified before execution.
Enforcement later compares a single-use receipt with current contract, plan,
target, proof, and host state. Do not infer runtime events that the request and
fixed Harness envelope do not establish.

## Observable Facts

### `episodeMode`

- `non-executable`: spam, empty template, corrupt fragment, or a completed
  status with no remaining request.
- `non-mutating`: explanation, investigation, triage, or another answer that
  does not authorize changing an artifact or protected system.
- `mutating`: the request asks for a change, or gives a concrete defect whose
  fixed envelope calls for the smallest verifiable repair.

### `decisionAuthority`

- `supplied`: the requested outcome and authority are sufficient to begin.
- `missing-user-choice`: the text leaves mutually incompatible outcomes,
  scope, authority, truth source, or acceptance policies for the user to
  choose. Quote the unresolved choice. Model preference and repository
  inspection cannot close it.
- `not-applicable`: required for non-mutating episodes.

### `classificationEvidence`

- `sufficient-from-request`: the request determines the control level. A
  normal need to locate code, read tests, or discover the implementation owner
  is always sufficient-from-request.
- `requires-repository-read`: a specific repository fact may change the
  control level, accepted boundary, or mutation authority. State one question,
  at least two mutually exclusive repository answers, and how those answers
  route differently. "Which file implements this?" never qualifies by itself.
- `not-applicable`: required for non-mutating episodes.

### `continuityHazard`

Use `none` unless the request plus fixed Harness facts establish a complete
path by which a valid basis can become stale before a later mutation.

- `host-context-replacement`: at least eight explicitly requested mutation
  stages, a declared long-running program, or an explicit compaction boundary.
- `stage-feedback`: an earlier stage result determines a later mutation.
- `changing-basis`: requirements, accepted facts, or an external truth source
  may change during the episode.
- `handoff`: a later mutation is delegated to another executor.
- `parallel-execution`: concurrent executors can act from diverging copies.
- `delayed-verification`: later mutation is allowed before the prior result can
  be verified.

For every non-`none` value, record this full chain:

```text
authoritative basis item
-> concrete invalidation event
-> later mutation opportunity
-> stale action
-> detection point and consequence
```

The host-context case may use the fixed Harness fact that a long episode can
replace model-visible history. All other links require direct request quotes.
Issue severity, file count, test count, or a guess about implementation steps
does not establish a continuity hazard.

### `protectedEffect`

- `none`: local artifact work with no explicit protected side effect.
- `reversible-external`: an explicit external or persistent effect with a
  stated rollback, dry run, preview, or isolated fixture.
- `irreversible-or-authority`: publishing, deployment, payment, destructive
  persistent-state changes, credential or permission changes, or another
  explicit authority boundary without a complete reversible envelope.

This fact raises the durable contract requirement. It does not manufacture a
Lattice continuity hazard.

## Frozen Derivation

The annotator never chooses a route or `outcomeCritical` value:

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

## Calibration And Blind Evaluation

V6 is permanently revealed failure evidence. A selected V6 subset may be used
only to calibrate this rubric. V7 blind candidates must come from repositories
and URLs absent from V1-V6 and from the calibration set.

Three annotators work independently without the router. Reliability is
measured for every primitive and the derived route using unanimous agreement,
pairwise confusion matrices, Fleiss kappa, and Gwet AC1. Adjudication and blind
selection remain blocked unless every preregistered reliability gate passes.
