# DSH-Native Workflow V23 Preregistration

Status: **CANDIDATE AND GRADER FROZEN; DRIVER AND NATIVE PILOT UNRESOLVED.**

The runtime candidate is commit
`c40f77cd9a61304720168374c539e6d3c30de01e`, tree
`e0557e448d65767e122ffcbdaff97c4238e8ff73`, package version
`0.4.0-rc.9`, and tarball SHA-256
`5e08e82cfec9a46a0902952c32d6c7ad24db2ba36890a410f1165330dd9e33d8`.
The V23 grader was frozen separately at commit
`bf344cc` after a 100/100 known-good run and 19/19 attributable mutant
captures.

V22 is immutable negative evidence: native and candidate both scored 87/100.
V23 has a new candidate, a qualified grader, and a new protocol identity. It
must not rerun or reinterpret V22.

## Hypothesis

The failure mode is not missing planning vocabulary. DSH already owns Plan,
Todo, Session, compaction, and subagents, but those records do not form one
execution gate. RC.9 makes the native Todo a durable task cursor:

1. a complex task creates at least two ordered Todo items with one active item;
2. only that item may own mutation;
3. the latest mutation must settle and receive deterministic verification;
4. Todo completion and next-item activation occur in a later whole-list update;
5. failures or new human authority require exact refresh and unfinished-suffix
   replanning; and
6. compaction, restart, and native delegation recover the same root authority,
   Todo, and evidence debt.

Small bounded tasks remain true bypass. The plugin does not create a second
planner, scheduler, transcript, child prompt, or result channel.

## Paired Protocol

Both arms use official DSH rc.7 commit
`99f6f02fecdb7dff40c3fbc9470f5907c29f74ca`, the same
`deepseek-v4-flash` settings, task, fixture, grader, Bash boundary, stage
order, process restarts, compactions, foreground `subagent_fork`, budget, and
timeout.

The task has five user-owned epochs over one workspace: baseline foundation,
transition verification, foreground delegated summary, a material product
revision, and final integration. The hidden grader measures only final CLI
behavior. It never exposes assertions or the reference implementation to the
model.

## Required Gates

- A clean, committed driver must pass a real rc.7 zero-paid CLI smoke.
- The native-only task-selection pilot must complete all five stages, remain
  below 100 and at most 90, and stay within budget.
- The candidate must persist at least five bounded root workflow snapshots,
  exactly one post-prompt delegated capsule, at least ten ordered Todo writes,
  and at least five all-complete Todo snapshots.
- Both arms must preserve the model-authored child prompt and matching parent
  `tool/result`.
- Candidate score must be 100, exceed native by at least 15 points, miss no
  hard requirement, and retain no retired behavior.
- Candidate input must remain below 4,000,000 tokens and at most 1.10 times
  native.

Until all gates pass, `releaseAllowed`, `resultClaimAllowed`, and any general
quality or ranking claim remain false.
