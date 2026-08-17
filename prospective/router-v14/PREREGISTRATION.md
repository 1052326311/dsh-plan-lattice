# V14 RC.4 Candidate Preregistration

Protocol amendment v2 retires the original V14 protocol tag before shared
corpus access. A pre-execution audit found a crash window between consuming the
single reveal and committing its outcome. The successor adds crash-safe,
single-execution persistence and direct fault-injection tests. It reuses the
same RC.4 candidate, prospective V13 source frame, annotations, beacon, labels,
thresholds, and reporting policy.

V14 evaluates the released RC.4 router at commit
`7cb3c77f9dab6ef193eb77318fb87389b877b526` against the exact future corpus
already governed by V13. It does not collect, filter, annotate, adjudicate, or
select another corpus.

## Why V14 Exists

V13 froze router commit `b5971547af8c733312d2efce888cdf2573cc379d`
before RC.4 fixed polite mutation requests. That router classifies
`Can you build a customer support application?` as `bypass` because the
question form masks the mutation request. RC.4 classifies it as `contract`.
V13 remains immutable and its first result must still be reported. It cannot be
silently relabelled as RC.4 evidence.

The RC.4 candidate commit was created at `2026-08-16T23:54:43Z`, before the
V13 GH Archive source window opened at `2026-08-17T00:00:00Z`. The public
`router-v14-rc4-candidate-freeze` tag resolves to that exact commit. No V13
archive object had been acquired when this protocol was written.

## Shared Evidence

V14 accepts only the exact V13:

- protocol tag and commit;
- source-frame spec digest;
- freeze manifest and digest;
- complete evidence artifact inventory;
- prompts, labels, sources, and release gates.

The V13 freeze verifier is executed again before V14 freeze and reveal. V14
must freeze before any V13 reveal attempt exists. V13 reveals first. V14 then
requires and digest-binds exactly one complete V13 result or failure before it
can consume its own reveal. Both outcomes are published regardless of which
passes.

## Candidate Runtime

The candidate runtime is compiled only from a Git archive of the exact RC.4
commit with Node `v22.23.0` and TypeScript `5.9.3`. The archive, Git tree,
source files, transitive runtime closure, compiler, Node executable, and every
artifact file are digest-bound and made read-only before import.

Three public known counterexamples must all route to `contract`. They are a
regression gate, not blind evidence. The separate 120-row shared corpus retains
all eight preregistered V13 blind gates.

## One-Reveal Rule

`freeze` writes one exclusive candidate manifest and digest. `reveal` writes an
attempt record before importing the router. An importer crash, verification
error, or failed score consumes the reveal and is retained. No file may be
overwritten and no post-reveal candidate may reuse the V14 name.

Router accuracy measures automatic-control routing only. It is not evidence of
general software-task quality or the separate 90-run model benchmark.
