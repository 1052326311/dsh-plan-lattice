# V18 Retained Result

Status: executed negative; do not rerun under the V18 identity.

- Candidate: `e343181af25de6bfd3bd2507e52649c46d587706`
- Driver: `ce165d0910139f2c971a3447bdb6fd4087df92bb`
- Manifest: `ca95e1ce7af111b250523422997255feddb110a1388b9dff6eec201a228e7b33`
- Harness: `99f6f02fecdb7dff40c3fbc9470f5907c29f74ca`
- Runtime SHA-256: `b4aadd9388cba190291f72cdcc9bd4a2e5d432ab29c89c2b8c70eba0e3eda32c`
- Paired report SHA-256: `1b1c30e91a8545673158b97f18fd8f8338e56af3b49a939731332979a4c2889c`
- Execution order: native, candidate
- Model: `deepseek-v4-flash`, temperature 0
- Budget per arm: 100 agent requests, 4,000,000 input tokens, 500,000 output tokens

## Outcome

| Arm | Score at stop | Hard misses | Requests | Input tokens | Stages completed |
| --- | ---: | ---: | ---: | ---: | ---: |
| Native | 88 | 1 | 96 | 4,009,072 | 4/5 |
| Candidate | 75 | 2 | 53 | 1,631,075 | 3/5 |

The candidate preserved the delegated historical-summary behavior that native
lost, and did so with 2,377,997 fewer input tokens and 236,568 ms less wall
time. The observed resource reduction was approximately 59 percent, but it did
not produce a better product outcome. The candidate retained obsolete checkout
behavior, did not implement adjust-start, scored 13 points below native, and
stopped before completing the material-revision stage.

The frozen analyzer therefore returned:

- `candidateLifecycleValid: false`
- `nativeLifecycleValid: false`
- `candidateGatePassed: false`
- `positiveExploratorySignal: false`
- `statisticalUpliftEstablished: false`
- `globalBestEstablished: false`
- `stableReleaseAllowed: false`

No release, ranking, Discussion update, or positive quality-uplift claim is
allowed from V18.

## Native Signal

Native completed Foundation, Transitions, the native child stage, and material
revision. It reached the required revision behavior but lost the delegated
historical summary and exceeded the frozen input budget before final
integration. Its Session retained two genuine compaction summaries, two
`surfaceOp.replace` messages, five process epochs, and valid child lineage,
descriptor, `subagent/start`, and first child user-message evidence.

This remains evidence that DSH's native Session, compaction, and child prompt
transport work. It is also evidence that native execution did not preserve the
child's accepted outcome through final integration under the frozen budget.

## Candidate Signal

The candidate completed Foundation, Transitions, and delegated Summary. The
child snapshot and final workspace both retained the delegated historical
summary, with no cross-agent reporting regression. Child Session identity,
parent lineage, native first user-message identity, and prompt digest all
remained valid through the native path.

The candidate nevertheless violated V18's minimal-control boundary:

1. After the first native compaction and cold process resume, automatic routing
   restored the root as `contract` with no committed contract.
2. The injected runtime capsule instructed the model to call
   `lattice_intake`; the root did so at Session event 9,579.
3. The root later called `lattice_refresh_context` at event 15,106. The child
   called refresh three times at events 129, 6,421, and 7,443.
4. The material-revision turn then consumed the full 32,768-token response in
   reasoning without making a tool call and terminated with `max-tokens`.

The final reasoning trace repeatedly debated whether historical summary had
already been implemented. The root Session had the human revision and a
Plan Lattice capsule requiring `lattice_reframe`, while the delegated child had
modified the shared workspace in a separately resumed native Session. The
trace does not by itself establish whether the missing parent-visible child
completion is a DSH behavior, a driver lifecycle gap, or a plugin integration
error. That distinction must be resolved from the official subagent return path
before another paid pair is frozen.

## Required Successor Change

The successor must be designed from DSH's native control flow rather than by
adding another plan representation:

1. `activationMode: auto` may not create or require a Plan Lattice contract,
   graph, intake, reframe, receipt, lease, checkpoint, or per-file refresh.
2. DSH remains the sole owner of Plan Mode, Todo, Session events, compaction,
   resume, child prompts, child scheduling, and child-result delivery.
3. Automatic mode may observe native continuity boundaries and validate exact
   human or delegated-message identity, but must not turn that observation into
   a second model-directed workflow.
4. Full contract or graph control requires explicit user opt-in through
   `activationMode: always` or an explicit full-Lattice instruction.
5. The evaluation driver must exercise the same native parent-child result
   path used by a real `subagent` call, or explicitly report that it tests only
   child Session transport and shared-workspace effects.

V18 remains immutable. A successor evaluation requires a new protocol identity,
a newly frozen candidate, a free five-stage smoke, and one separately
authorized paid run.
