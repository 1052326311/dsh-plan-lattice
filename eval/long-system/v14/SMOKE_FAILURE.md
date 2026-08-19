# V14 Pre-Execution Smoke Failure

Status: retained negative; paid pair not started.

- Candidate: `49410920b3b6a3c961b8b84d7d80de124d31b878`
- Harness: `dsh-v0.1.0-rc.7` at `99f6f02fecdb7dff40c3fbc9470f5907c29f74ca`
- Frozen runtime SHA-256: `412b790e24c40309cbcdf03a0e2556a2adc5cb41b2fe37da14cfc5475a8cbc1d`
- V14 manifest: `aeb0d7c9daf19448d08e7f9dc6d743f44baf769d17b2c5763743c501c9496240`

The real rc.7 loopback smoke passed fresh installation and both native and
candidate root/one-shot-child lifecycles. Each child had its own durable
Session, a native `subagent/start` edge, a matching descriptor, the exact
ordinary delegated user message, and one successful model request.

The later candidate max-token stage ended after the first model request with a
durable `turn/end` reason of `max-tokens`. No continuation message was appended.
In `activationMode: auto`, the first request intentionally uses the DSH-native
prompt and has no Plan Lattice assembly attestation. The truncation recorder
looked up the session only through that absent attestation, despite the already
validated final `GenerateOptions` carrying DSH's exact `sessionId`.

The successor must identify a validated native-first or native-recovery request
through its DSH session identity, queue only DSH's native `followup()`, preserve
the native system prompt on the next turn, and retain the durable continuation
budget.
