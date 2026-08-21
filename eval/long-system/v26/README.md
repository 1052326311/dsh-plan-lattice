# V26: Terminal-Outcome Long-Task Evaluation

V26 is a prospective follow-up to the retained V25 negative observation. V25
recorded two valid Native `max-tokens` outcomes, then stopped when Native-3
crossed the preregistered 6M cumulative input-token budget. The evaluator
misclassified its own local rejection as an infrastructure failure. Candidate
rc.9 was never executed, and V25 produced no valid comparison claim.

Before any Candidate execution, V26 freezes a symmetric terminal policy:

- `completed`, `max-tokens`, and host-authenticated `attempt-budget-exhausted`
  are scoreable terminal outcomes.
- A budget terminal exists only when the budget proxy locks a first local
  rejection for the active attempt with no upstream 429, transport error, or
  missing usage, and that rejection first appears inside the current stage or
  compaction window. The terminal is attempt-wide, including compaction and
  child Sessions. A generic Harness 429 or a rejection retained from an older
  window is never sufficient.
- Every stage begins with a host barrier: the support plugin cannot issue the
  stage's first model request until the host has captured its budget baseline
  and echoed the complete frozen stage identity.
- Token usage is settled after each allowed response. The first response that
  crosses a cumulative limit is retained; the next model request terminates
  the attempt. Agent requests are serialized at the host proxy, so concurrent
  root and child requests cannot authorize multiple crossing responses.
- Every delivered product round is graded once by the official hidden verifier
  against a copied workspace snapshot. Its exclusive receipt and parent
  directory are both fsynced before the host acknowledges the stage.
- The real support plugin must wait for the host acknowledgement and echo each
  terminal stage, revision, receipt digest, and budget terminal ID exactly
  once. Missing, duplicate, or altered terminal echoes invalidate the attempt.
- Before driver freeze, an external owner-only Ed25519 private key is created
  and its public key and digest are compiled into the driver. The later
  manifest must match that prior code anchor. Each retained attempt summary is
  chained through the host model proxy's signer. The final analyzer rejects a
  manifest or report-provided replacement key and verifies the anchored chain,
  manifest and report digests, exact attempt order, raw attempt result, round
  receipts, and final budget-audit snapshot before returning a release verdict.
- Any premature scoreable terminal ends the attempt immediately. The evaluator
  does not rescue the arm with another product message.
- Undelivered rounds receive strict zero padding under the fixed nine-round
  denominator.
- Network, Session, verifier, runtime, or receipt failures remain
  infrastructure-invalid and cannot be converted into product zeros.
- Five retained Native outcomes must reproduce a median product `max-tokens`
  terminal before the one still-unseen Candidate is exposed.

Release remains blocked unless the Candidate completes all nine rounds, passes
every hidden requirement, reaches both real compaction boundaries, resumes the
same Session in a second process, completes the foreground child audit, has no
premature task terminal, clears the absolute and remaining-gap score
gates, and stays within the frozen input-token ratio.

The paid runner writes the report and then invokes the same disk-backed
verifier used by `long-system:v26:analyze`. An in-memory
`analysis.releaseAllowed` value is not a publication authority.

The private signing key is never committed or copied into run evidence. Its
path is supplied only through
`PLAN_LATTICE_LONG_SYSTEM_V26_SIGNING_PRIVATE_KEY`; freeze and preflight both
require owner-only permissions and derive the exact public key independently.

This protocol can support a result for this exact model, budget, task, Harness,
Candidate package, and adapter. It cannot by itself support a global ranking or
a claim that every long task is solved.
