# V15 Retained Result

Status: executed negative; do not rerun under the V15 identity.

- Candidate: `e49eec5f86f7902110c7cbb328af7240a3e4241a`
- Driver: `8a4847809b1d32c807468bf1d6005c3c037e5af5`
- Manifest: `e72135fe5c39b32183650c372b59500196a7246782d5b57f7b262d9f91e64dcd`
- Harness: `99f6f02fecdb7dff40c3fbc9470f5907c29f74ca`
- Runtime SHA-256: `412b790e24c40309cbcdf03a0e2556a2adc5cb41b2fe37da14cfc5475a8cbc1d`
- Paired report SHA-256: `3e450a3274cec14bc1d07743a98c50f5ce291d48c500d1b703f15a026594e90e`
- Execution order: native, candidate
- Model: `deepseek-v4-flash`, temperature 0

## Outcome

| Arm | Score | Hard misses | Requests | Input tokens | Stages completed |
| --- | ---: | ---: | ---: | ---: | ---: |
| Native | 55 | 4 | 22 | 742,673 | 0/5 |
| Candidate | 0 | 9 | 22 | 640,515 | 0/5 |

Both attempts exhausted the preregistered 22-request budget in the Foundation
stage. Neither reached the first scheduled compaction, process resume, child
delegation, material revision, or final integration. Both lifecycle gates were
therefore false. The candidate did not satisfy any uplift threshold, and no
release or comparative effect claim is allowed.

## Mechanism Audit

The first-stage DSH request headers exposed the same tool names in both arms.
The candidate Session contained zero Plan Lattice execution-state snapshots and
zero `lattice_*` tools. Auto mode was still in its intentional native-first
path, so the observed score difference occurred before the treatment mechanism
under test activated. The native workspace happened to finish 20 public tests;
the candidate workspace ended mid-debug with no test directory and an invalid
test script. A single nondeterministic model trajectory plus an attempt-wide
budget ceiling confounded the intended continuity comparison.

## Consequence

V15 is retained as evidence that a long-system evaluation must first prove both
arms reach the continuity boundary. A successor may not increase the same
single-pair budget and present the result as clean causal evidence. It should
create one shared, completed DSH-native prefix, freeze its workspace and durable
Session, clone that exact prefix into both arms, and begin treatment immediately
before the first native compaction. Both arms must still pass all compaction,
resume, child, revision, and final-stage gates before outcome scores are
compared.
