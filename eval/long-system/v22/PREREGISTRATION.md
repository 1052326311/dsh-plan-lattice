# DSH-Native Boundary V22 Preregistration

Status: **CANDIDATE FROZEN; EXECUTION DISABLED UNTIL DRIVER, TASK, GRADER, AND RUNTIME FREEZE.**

The plugin candidate is the merged `main` commit
`f9e3e245e629d1013e77dc10e67c06a4f1682a14` with tree
`8c12c887ac1c99ffdc33518fc37fa9ba0fa818dd`. Its locally packed and official
rc.7 compatibility-tested `0.4.0-rc.8` tarball has SHA-256
`ac07771c8b98dccc6489184443d71e1f8680f0c132c71b551f574d8cd13273c4`.
No later production-code commit may enter V22 under this protocol identity.

V21 is immutable negative evidence. Both V21 workspaces scored 100, neither arm
completed the exact lifecycle, and the frozen Session collector double-counted
fork-seed usage. V22 has a new identity and cannot be used to reinterpret or
rerun V21. `eval/long-system/v21/RESULT.md` is the authoritative disposition.

## First Principle

The invariant is not a plugin-owned plan schema. A later DSH model request must
recover the same still-valid execution authority that governed earlier work.
DSH remains the owner of Session history, request assembly, Plan Mode, Todo,
compaction, process resume, subagent prompt creation, scheduling, and result
return. Plan Lattice may contribute only a bounded recovery delta after DSH has
committed a native surface replacement that actually hid one of those sources.

## Native Control Boundaries

The evaluator binds to official rc.7 behavior:

1. `ReactLoopAgent.preStep()` assembles DSH prompt sections, dynamic runtime
   context, and tool schemas.
2. `RuntimeContextProjection` commits a changed dynamic context as an ordinary
   DSH `user/message` snapshot.
3. `ReactLoopAgent.step()` derives every request from
   `session.deriveMessages()`; a retry reuses the same private assembly.
4. Compaction commits `compaction/summary`, then a `user/message` carrying
   `surfaceOp.replace` and exact source provenance.
5. Spawn children start with zero parent conversation; fork children inherit
   only the parent's completed-turn prefix. In both cases the model-authored
   `prompt` becomes the child's first own user message.
6. Foreground child output returns through the matching parent `tool/result`.

V22 fails if the plugin creates a parallel prompt builder, planner, Todo list,
child scheduler, child result channel, or Session event vocabulary.

The V22 Session auditor reads the same persisted JSONL artifacts used by DSH
resume. It does not accept in-memory plugin counters or evaluator-authored
claims as proof of a replacement, child prompt, or recovery snapshot.

## Fixed Mechanism Gates

The eventual frozen pair must prove all of the following from durable Session
artifacts and request records:

- a preregistered native-only task-selection pilot first completes every stage,
  remains within budget, and scores at most 90 on the unchanged hidden grader;
- both paired arms complete every scheduled root process epoch and the native child
  lifecycle;
- the parent model emits the foreground `subagent` call and its exact prompt is
  the child's first own ordinary user message;
- a fork seed containing a parent replacement does not activate child recovery;
- a fresh child receives zero Plan Lattice runtime-context snapshots;
- every token, turn, compaction, replacement, timing, continuation, and tool
  aggregate reads only that Session's own suffix after `header.seedLength`;
- every recovery snapshot follows a replacement in that Session's own event
  suffix, excluding inherited fork seed events;
- no replacement causes more than one Plan Lattice recovery snapshot;
- each Plan Lattice section is at most 65,536 UTF-8 bytes;
- the candidate exercises at least three root-owned native replacements;
- candidate input tokens stay below 4,000,000 and no more than 1.10 times the
  paired native arm; and
- candidate final behavior is no worse than native on the frozen hidden grader.

Workspace state alone cannot satisfy lifecycle gates. A workspace that passes
tests after the candidate exhausted its budget or skipped the final parent turn
is an incomplete attempt.

## Quality Task Gate

V22 must not reuse a task on which native already scores 100. Before freeze,
the task and hidden grader must expose several independent, outcome-relevant
requirements across at least three real replacements, one cold resume, one
foreground delegation, and one material revision. The grader must score final
behavior rather than Plan Lattice phrases, files, calls, or implementation
details. The candidate does not receive hidden assertions or evaluator-only
state.

The free model gate must complete the exact lifecycle and mutation channel but
does not predict paid-model quality. After the free gate, the candidate commit,
driver, task, grader, runtime, budgets, order, and source digests are frozen in
a new manifest before any paid call.

## Claim Boundary

Even a passing V22 pair permits only a narrow mechanism statement: on the
frozen DSH rc.7 task, automatic recovery preserved native lifecycle, did not
modify fresh child prompts, remained bounded, stayed within the paired input
budget, and did not regress the hidden score.

V22 alone cannot authorize a release, a general quality-uplift percentage, a
global ranking, or superiority over Codex or Claude Code. Those claims require
multiple non-ceiling tasks, repetitions, confidence intervals, and an external
benchmark.
