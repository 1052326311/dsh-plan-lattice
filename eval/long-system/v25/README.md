# V25: Terminal-Outcome Long-Task Evaluation

V25 is a prospective follow-up to the retained V24 negative observation. V24
stopped by design when the first Native calibration ended its first product
round at `max-tokens`; it did not execute the Candidate and produced no valid
comparison claim.

Before any Candidate execution, V25 freezes a symmetric terminal policy:

- `completed` and `max-tokens` are model-owned, scoreable terminal outcomes.
- Every delivered product round is graded once by the official hidden verifier
  against a copied workspace snapshot.
- `max-tokens` ends the attempt immediately. The evaluator does not rescue the
  arm with another product message.
- Undelivered rounds receive strict zero padding under the fixed nine-round
  denominator.
- Network, Session, verifier, runtime, or receipt failures remain
  infrastructure-invalid and cannot be converted into product zeros.
- Five retained Native outcomes must reproduce a median product `max-tokens`
  terminal before the one still-unseen Candidate is exposed.

Release remains blocked unless the Candidate completes all nine rounds, passes
every hidden requirement, reaches both real compaction boundaries, resumes the
same Session in a second process, completes the foreground child audit, has no
product `max-tokens` terminal, clears the absolute and remaining-gap score
gates, and stays within the frozen input-token ratio.

This protocol can support a result for this exact model, budget, task, Harness,
Candidate package, and adapter. It cannot by itself support a global ranking or
a claim that every long task is solved.
