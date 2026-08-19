# V13 Pre-Execution Smoke Failure

Status: retained negative; paid pair not started.

- Candidate: `131b7dde58fa4d0481685c545f92b78a924d7b8b`
- Harness: `dsh-v0.1.0-rc.7` at `99f6f02fecdb7dff40c3fbc9470f5907c29f74ca`
- Frozen runtime SHA-256: `412b790e24c40309cbcdf03a0e2556a2adc5cb41b2fe37da14cfc5475a8cbc1d`
- V13 manifest: `a4ab593425bf8c5373d13f3de1d650e19789e13e2b68e9871b6393ccc84b0ceb`

The real rc.7 loopback smoke completed the candidate root request. Its native
one-shot child then ended with `turn/end` reason `blocked` before any child
model request. Persistent Session evidence showed that DSH accepted the exact
ordinary child user message and appended `subagent/descriptor` during the
first `agent/pre-step`.

Plan Lattice handled that descriptor by invalidating write authority and
prepending a new probe reason. Probe reasons are rendered into the runtime
context, so the text no longer matched the DSH-owned request assembled before
`pre-step`. The plugin rejected the request itself. Existing tests covered an
established lattice child, whose runtime rendering does not expose reasons, and
therefore missed the probe-specific ordering fault.

The successor must preserve the native request, advance only write admission
authority, prove the auto/probe one-shot path reaches the adapter, and retain
fresh-basis enforcement for protected writes.
