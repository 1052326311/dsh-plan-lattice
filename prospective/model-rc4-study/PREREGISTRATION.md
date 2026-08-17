# RC.4 External-Model Study Preregistration

This study asks whether the released Plan Lattice RC.4 candidate improves
outcomes on underspecified product work and changing-requirement work without
taxing clear small tasks. It freezes the study design before any paid model run.

Protocol v1 was retired before any model execution because its public-anchor
builder passed a `:(glob)` selector to `git ls-tree`, which does not support
pathspec magic. The immutable failed tag and Actions log remain public. Protocol
v2 changes only the protected-tree enumeration and public study tag identity;
the candidate, tasks, graders, matrix, thresholds, and retry rules are unchanged.

Protocol v2 was then retired before source access, router reveal, or model
execution after an independent crash-recovery audit. A controller could retain
a reservation without a recoverable result, and the paired router protocols
could retain a reveal attempt without a terminal outcome. Protocol v3 adds
durable invocation and response states, crash synthesis that forbids duplicate
paid calls, and crash-safe single-execution router reveal. The candidate,
tasks, graders, 96-slot order, model, thresholds, and retry eligibility remain
unchanged.

## Fixed Basis

- Candidate: `7cb3c77f9dab6ef193eb77318fb87389b877b526` (`v0.4.0-rc.4`).
- Model: `deepseek-v4-flash`, temperature `0`, with one endpoint, budget,
  timeout, and permission policy shared by every paired arm.
- Tasks, hidden graders, source commits, run order, and 96-slot matrix: the
  exact already-frozen `eval/v0.4` assets at commit
  `0414dfa5035e6ca5cdc511964883b64be62ad44e`.
- Runtime builder: the first public GitHub Actions run `31982987064`, launched
  with the exact RC.4 candidate before its artifact digests were known.
- Release thresholds: unchanged from the original strict protocol.

The old frozen manifest remains an RC.3 matrix source and is never cited as
RC.4 outcome evidence. RC.4 receives a new execution envelope and a new result
ledger.

## Two Freezes

The public study-protocol tag freezes every result-affecting controller,
preflight, driver, analyzer, schema, task, grader, threshold, and retry rule.
Only the three artifacts from the already-bound first GitHub run are eligible.
The exact historical evaluation assets are included in the protected source
digest, so changing a current working-tree copy cannot change an execution.

An execution-freeze tag may be created only after the prospective V14 router
result exists and passes. It must bind the immutable V13 and V14 outcomes, all
runtime bytes and metadata, the RC.4 manifest and controller source, and the
result-signing identity. No model call is allowed before that second freeze.

The invariant is the accepted experiment contract. Runtime paths, external
checkouts, and observed outcomes are changeable state. Immediately before each
model call, preflight reconstructs the invariant from both public tags and
revalidates the current V14 evidence, runtime acquisition, benchmark commits,
run slot, source digest, and credential proxy. A summary or copied manifest is
not an authority source.

## Reporting

All six infrastructure slots must resolve before any of the 90 statistical
slots. Every attempt and failure is retained. Only preregistered infrastructure
failures may rerun. Any failed gate publishes a negative result and blocks a
general uplift claim. Router accuracy, deterministic mechanism tests, and
synthetic passing fixtures are never substituted for software-task outcomes.
