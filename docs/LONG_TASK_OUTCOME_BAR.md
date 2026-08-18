# Long-task outcome bar

## First-principles target

A long-task controller is useful only if it preserves the user's intended
outcome while the execution form changes. Context windows, model turns,
processes, agents, files, plans, and implementation choices may change. The
authoritative requirements, accepted decisions, authority boundaries, current
truth, and observable acceptance criteria must not be silently lost or
weakened.

Plan Lattice therefore targets this end-to-end property:

> Given an authoritative task definition, an agent can complete and verify the
> requested system across compaction, restart, delegation, and material change
> without silently dropping requirements or acting from stale authority.

The controller should add ceremony only where an invalidation path exists.
Small explicit work should bypass it; bounded stable work with a complete
specification should use a contract. Full lattice control applies when the
execution is long enough to cross repeated planning or context epochs, even if
the requirements are already complete, and when changing truth, handoff,
delayed proof, irreversible effects, or coordination create independent
invalidation paths.

## Evidence established

- In 12 engineered stale-basis hazards, native Harness executed the unsafe
  mutation in `12/12` cases and Plan Lattice in `0/12`; both arms completed all
  seven matched legitimate controls.
- In two real-`SIGKILL` hazards, native Harness continued unsafely in `2/2`
  cases and Plan Lattice in `0/2`; both arms completed both matched legitimate
  restart controls.
- The published RC.6 asset and the local RC.7 candidate install and expose the
  expected tools on official Harness `dsh-v0.1.0-rc.7`. This is startup and
  registration compatibility, not task-quality evidence.
- A real frozen headless Harness test now terminates the first SSE stream
  without `[DONE]`, resumes the same durable session in a second process, and
  completes after one recovery epoch. The session contains one human task and
  one plugin-authored recovery message, and the durable ledger records the
  `stream_closed` trigger.

These results establish specific enforcement and recovery mechanisms. They do
not establish better completed systems.

## Explicit non-achievement

No completed, matched complex-system study currently shows that Plan Lattice
beats native DeepSeek Harness on hidden functional outcomes. The frozen
90-run statistical matrix has not returned `releaseAllowed: true`. There is no
independent public ranking that supports a "globally best" or "global top two"
claim.

Until those facts change, the accurate claim is that Plan Lattice has
reproducible evidence for preventing selected long-task drift and crash hazards,
while general software-delivery uplift remains unproven.

## Competitor claim boundary

Codex, Claude Code, and Tencent WorkBuddy publicly expose planning, context
management, resume, or delegation features. Their public documentation does not
currently state one comparable end-to-end guarantee spanning compaction,
process restart, multi-agent execution, material requirement change, and exact
requirement/evidence preservation. That absence is not evidence that their
internal systems lack such mechanisms.

Any comparative claim must use the same model, task, budget, tools, permissions,
and grader. A mechanism comparison may name the mechanism tested; a broad
quality or ranking claim requires completed hidden-outcome comparisons.

## Release and claim thresholds

The frozen v0.4 study remains the stable-release authority:

- All six infrastructure slots and all 90 statistical slots must resolve with
  provenance and integrity checks intact; failed task attempts remain included.
- Explicit simple tasks must add zero model turns, remain within a two-point
  non-inferiority margin, and keep median token/time overhead at or below `5%`
  and P95 overhead at or below `10%`.
- ICAE hidden-feature score must improve by at least `1.5x` and 15 percentage
  points, critical requirement misses must fall by at least `50%`, and the
  paired-bootstrap lower bound must be greater than zero.
- EvoCode historical requirement regressions must fall by at least `50%`, mean
  cumulative case score must improve with a paired-bootstrap lower bound above
  zero, and clarification questions must have median at most three and maximum
  five per task.
- The analyzer must return `releaseAllowed: true`. No partial gate set permits a
  stable uplift claim.

For a broader leading-controller claim, additional adversarial evaluation must
show `100%` retention of seeded hard constraints, zero silent requirement drops
or cross-agent overwrites, at least `95%` correct identification of artifacts
affected by a requirement change, and at least `99%` exact durable plan
reconstruction after interruption. A matched complex-system suite must also
reduce requirement violations by at least `30%` relatively or 10 percentage
points absolutely without hidden token or latency explosion. These are target
bars, not current results.

## Prior negative pilot causal chain

The retained RC7 pilots are negative evidence and explain why mechanism success
has not yet become outcome success:

1. Route resolution treated omissions in an inspected file as omissions in the
   complete user authority, leaving acceptance permanently unresolved; an
   exploratory non-strict shell boundary then allowed execution outside the
   intended lifecycle.
2. Host mutation tools remained model-visible even when execution hooks denied
   them. One attempt reached 115 requests without a deliverable, so attribution
   was invalid.
3. Raw shell-object hashing treated presentation metadata as semantic identity,
   and a container path was passed as a host working directory. The resulting
   boundary loop reached 95 requests, 34 tool errors, and no deliverable.
4. Intake retries after HTTP 400/429 and a visible delegated execution channel
   added another invalid evidence path. A later pre-model extraction failure
   also exposed an ENOSPC misclassification.
5. After those defects were corrected, the next candidate reached a committed
   contract, a three-node lattice, guarded execution, and a checkpoint. It then
   ended on HTTP 502 / `STREAM_CLOSED` after 25 successful model responses,
   26 tool calls, seven tool errors, 1,151,411 prompt tokens, and 30,947
   completion tokens, with no source deliverable or grader score.

The final trace showed the remaining controller-level cause: authoritative
context was repeated too aggressively and full lattice ceremony was imposed on
a stable single-epoch task. Seven refreshes emitted 170,570 characters, 76.6%
of all tool-result text; the last ten requests consumed 718,733 prompt tokens.
The RC7 compact contract, context projection, long-task routing boundary,
atomic plan creation, and same-attempt recovery address that causal chain. Only a fresh,
matched hidden-outcome pilot can show whether the correction is sufficient.
