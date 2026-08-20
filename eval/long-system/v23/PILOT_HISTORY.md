# V23 Pilot History

No model pilot has run under the V23 identity.

- Candidate runtime freeze: `5c1df23e8dd60821658dd6b1359dd68ffccd9c67`.
- Qualified grader freeze: `bf344cc`.
- Official rc.7 host runtime SHA-256:
  `54376394ae04c9458956449e12e24c7838b7646699e2779a93af1f855bc44334`.
- Paid execution remains blocked until the driver is committed, the free smoke
  passes, and a non-ceiling native-only pilot is recorded.

## Driver Development Events

- The first zero-paid free-smoke attempt stopped during the delegated-summary
  stage. The loopback fixture classified a forked child's inherited root prompt
  before the child's own exact user prompt and rejected the child as a second
  root workflow. No report or model result was produced. The fixture now routes
  the child's own prompt and non-root Session identity first; the full smoke
  must be rerun from the resulting clean driver commit.
- The next zero-paid attempt completed the native arm but stopped in the
  candidate foundation stage. A successful Node 22 TAP summary contains the
  line `# fail 0`; the runtime failure classifier treated that zero count as a
  failure and correctly blocked later Todo progress on its mistaken premise.
  The production classifier now strips zero-failure summary forms before
  detecting failures, with the exact observed TAP output covered by a focused
  regression. This changed the candidate commit, tree, and tarball identity, so
  all earlier candidate artifacts are invalid for V23 execution.
- The subsequent zero-paid free smoke passed on driver commit
  `ce6c39ff2194aa2c31a51635fdfb04e568599b82`. Both arms completed all five
  process epochs, three native compactions, fifteen ordered Todo writes, one
  foreground fork, and the real Bash/Node/sandbox probe. The candidate recorded
  twenty bounded workflow snapshots and one delegated capsule without exposing
  a control tool or creating workspace `.dsh` state. The canonical receipt is
  `FREE_SMOKE.json` with SHA-256
  `9f397a628ee5af7e2eb974f97ac2de0dc114ae7160d916a4fad004a6a23ffbcb`.
