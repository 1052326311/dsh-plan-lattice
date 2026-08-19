# V17 Retained Result

Status: executed negative; do not rerun under the V17 identity.

- Candidate: `68856eaec8741a30873b881d9bb6b3a7df072e0b`
- Driver: `3c504c81705e5cc994fb6e7114f094123b501904`
- Manifest: `f84c2ef6b41acca463838e2dc50e3a852815d1565a3ac933f97952a9882a19f6`
- Harness: `99f6f02fecdb7dff40c3fbc9470f5907c29f74ca`
- Runtime SHA-256: `412b790e24c40309cbcdf03a0e2556a2adc5cb41b2fe37da14cfc5475a8cbc1d`
- Paired report SHA-256: `319d3e0b28ee9eb0478736dd2ead8e3b24fe1cfbbc391b1752534f86ace23026`
- Execution order: native, candidate
- Model: `deepseek-v4-flash`, temperature 0
- Budget per arm: 100 agent requests, 4,000,000 input tokens, 500,000 output tokens

## Outcome

| Arm | Score at stop | Hard misses | Requests | Input tokens | Stages completed |
| --- | ---: | ---: | ---: | ---: | ---: |
| Native | 84 | 1 | 83 | 4,078,374 | 3/5 |
| Candidate | 100 | 0 | 71 | 4,034,232 | 4/5 |

The candidate implemented every hidden functional requirement visible in the
workspace at termination, while native had not implemented historical summary.
The observed score delta was 16 points and the candidate used 44,142 fewer
input tokens. This is not a valid positive pair: both arms exceeded the frozen
input budget, neither completed the five-stage lifecycle, and the candidate's
child snapshot itself had zero reporting coverage before later root repair.

The frozen analyzer therefore returned:

- `protocolLifecycleValid: false`
- `positiveExploratorySignal: false`
- `statisticalUpliftEstablished: false`
- `globalBestEstablished: false`
- `stableReleaseAllowed: false`

No release, ranking, or general quality-uplift claim is allowed from V17.

## Native Signal

Native completed Foundation, Transitions, and the real native child stage. It
then exhausted the input budget during material revision. Its native child had
the correct random UUID Session, `parentSession`, descriptor, first user prompt,
and `subagent/start` evidence, but did not preserve the delegated summary
behavior in the shared workspace.

This is direct evidence that DSH's lineage and prompt delivery work as designed,
while parent task authority and cross-agent outcome retention remain semantic
gaps rather than missing subagent transport.

## Candidate Signal

The candidate completed Foundation, Transitions, delegated Summary, and the
material revision, scoring 100 at termination. It still exhausted the budget
before Final Integration. The retained Session trace explains the cost:

1. The first uninterrupted Foundation segment stayed native.
2. After the first real compaction and process restart, the candidate forgot
   its deterministic `contract` route and restarted as `probe`.
3. The model then spent turns on `lattice_route`, `lattice_intake`, an invalid
   `lattice_open`, and an invalid `lattice_review_input` before implementation.
4. Contract mode required repeated `lattice_refresh_context` calls between
   ordinary writes even though DSH's conversation remained continuous.

The exact trace reached 71 model requests and 4,034,232 input tokens. This is a
negative control-cost result even though the partial functional outcome was
better. The plugin still behaved too much like a second planning harness after
a native continuity boundary.

## Required Successor Change

The successor must preserve DSH ownership of Plan Mode, Todo, Session surface,
compaction, retry, child prompt delivery, and scheduling. Automatic mode should
recover the already selected route from the exact anchored root Session
messages, cap evidence probes at `contract`, and require at most one authority
refresh for an uninterrupted native execution segment. Full graph, target-bound
one-shot receipts, leases, and checkpoints remain explicit full-Lattice
behavior only.

V17 remains immutable. A successor evaluation must use a new protocol identity
and pre-register its candidate after these implementation changes.
