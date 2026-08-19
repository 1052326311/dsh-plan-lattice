# V19 Retained Result

Status: executed negative with a matched infrastructure fault; do not rerun
under the V19 identity.

- Candidate: `41b315f6f77a8b660018d4b67cfb095eea5adde4`
- Driver/lock: `93ea9e0cd268a811580dee7dca5161bb3db04937`
- Manifest: `e30ed00646707a27b374255f27d4987a70ceadb6f686bcd3a9563d1abb150fe0`
- Harness: `99f6f02fecdb7dff40c3fbc9470f5907c29f74ca`
- Runtime SHA-256: `1347c201791be755dceaced2d65e6ddf7ca0f184ced0ac5288a7b59b52ad4ecd`
- Paired report SHA-256: `ca48e385bab0387313de1db53fb1f27165436ee1e36c6ad5eeafe78a16596683`
- Canonical report digest: `16d75406f4699d86c0fe20f5a1b026198b22676e06941160beb9bac2ea804d19`
- Execution order: native, candidate
- Model: `deepseek-v4-flash`, temperature 0
- Budget per arm: 100 agent requests, 4,000,000 input tokens, 500,000 output tokens

## Outcome

| Arm | Score | Hard misses | Requests | Input tokens | Output tokens | Duration |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Native | 55 | 4 | 76 | 3,227,802 | 242,170 | 1,669,030 ms |
| Candidate | 55 | 4 | 67 | 2,708,833 | 184,615 | 1,352,026 ms |

The frozen analyzer returned `releaseAllowed: false` and
`resultClaimAllowed: false`. The score delta was zero. No release, Discussion
update, ranking, or positive quality-uplift claim is allowed from V19.

The candidate used 518,969 fewer input tokens, 57,555 fewer output tokens, nine
fewer model turns, and 317,004 ms less wall time. Those differences are retained
as a resource signal only. They do not establish a product-quality improvement
because neither arm could execute a workspace mutation or a test command.

## Native Lifecycle Evidence

Both arms completed all five scheduled process epochs and retained valid DSH
lifecycle evidence:

- two real `compaction/summary` events and two canonical `surfaceOp.replace`
  boundaries per arm;
- one model-authored foreground `subagent` call per arm;
- byte-identical parent tool-call prompt and child first ordinary user message;
- a completed child turn and matching parent `tool/result`;
- the same native subagent tool-schema digest in both arms; and
- zero candidate `lattice_*` calls, clarification questions, `.dsh` files, or
  automatic contract/graph control.

This validates the intended compatibility boundary. DSH remained the sole
owner of Session history, prompt assembly, compaction, Plan Mode, Todo, child
creation, child prompt transport, scheduling, and result delivery. The
candidate observed those native boundaries without replacing them.

## Infrastructure Fault

The evaluator launched each complete Harness process inside an outer macOS
`sandbox-exec` profile to isolate repository history and sibling attempts. It
also configured DSH with `DSH_PERMISSION_MODE=workspace-write`. Every model
`bash` call therefore attempted to start a second `sandbox-exec` inside the
outer sandbox. macOS rejected that nested operation with:

```text
sandbox-exec: sandbox_apply: Operation not permitted
```

The matched execution boundary intentionally hid direct `write` and `edit`
tools so Bash was the only mutation and test channel. The fault consequently
prevented both arms from changing the Foundation fixture. Both scored the same
55 points already present in that fixture, missed Transitions, adjusted-start,
and historical Summary, and preserved zero delegated reporting coverage.

The existing free smoke did not catch the fault because its deterministic
model exercised compaction and subagent transport but never required a real
Bash mutation or test command.

## Required Successor Change

V20 must change only the evaluation execution boundary:

1. Keep the outer evaluator `sandbox-exec` profile as the filesystem and
   network isolation layer.
2. Run DSH with `DSH_PERMISSION_MODE=danger-full-access` inside that already
   isolated process so its Bash executor does not create a nested sandbox.
3. Add a zero-paid-call infrastructure gate that uses the real rc.7 CLI and
   Bash tool to create a workspace file, read it back, run a Node test, and
   prove forbidden outer roots remain unreadable.
4. Keep the candidate, task, fixture, hidden grader, model, budgets, stage
   order, lifecycle gates, and score thresholds unchanged.
5. Assign a new protocol identity and freeze a new manifest before any paid
   call.

V19 remains immutable. Its functional result is negative and its lifecycle
evidence remains valid; the successor is justified only because the shared
mutation channel was observably unavailable in both arms.
