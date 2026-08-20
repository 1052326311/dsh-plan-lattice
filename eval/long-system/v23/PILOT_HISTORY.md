# V23 Pilot History

No model pilot has run under the V23 identity.

- Candidate runtime freeze: `c40f77cd9a61304720168374c539e6d3c30de01e`.
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
