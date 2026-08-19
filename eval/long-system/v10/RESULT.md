# RC7 Native Long-System V10 Result

This is an appended execution record for the frozen V10 protocol. It does not
modify the task, grader, source hashes, thresholds, candidate identity, or
`frozen-manifest.json`. V10 must not be rerun under the same identity.

## Record

- Protocol: `plan-lattice-rc7-native-long-system-v10`
- Frozen manifest digest:
  `549f46a291e5b38cef6c11529e931bef531d9621865dcb487417866b2d7af038`
- Candidate commit: `683e9de10b90ab8b9324dbc176245368c7ef9408`
- Driver commit: `fc661a50328b2a452caa6201d603690f3e6bf65d`
- Harness: `dsh-v0.1.0-rc.7`
  (`99f6f02fecdb7dff40c3fbc9470f5907c29f74ca`)
- Host runtime SHA256:
  `20b9e0fe946e372f5d52892b65b87ae488c63f9b3404a0c37f005f02810e56e4`
- Model: `deepseek-v4-flash`, temperature 0, agent output cap 32,768
- Executed once on 2026-08-19 in the registered order: native, candidate.
- Sanitized paired report:
  `.plan-lattice-eval/long-system-v10/rc7-native-long-system-v10-2026-08-19T04-09-43-793Z/paired-report.json`

## Outcome

| Arm | Score | Model turns | Input tokens | Output tokens | Terminal reason |
| --- | ---: | ---: | ---: | ---: | --- |
| Native | 34/100 | 12 | 333,689 | 34,701 | request budget exhausted |
| V10 candidate | 0/100 | 4 | 25,273 | 58,795 | provider rejected tool-message order |

The native arm reached the pre-registered request limit. The candidate arm
recorded one native max-token continuation, but one provider response had no
usage data after a `400`, so its budget is invalid under the V10 rules. Neither
arm completed the staged task. The preregistered gates are all false:

- `positiveExploratorySignal: false`
- `statisticalUpliftEstablished: false`
- `globalBestEstablished: false`
- `stableReleaseAllowed: false`

V10 establishes no coding-quality uplift, general ranking, stable-release
eligibility, or performance claim.

## Root Cause

The candidate failed with:

```text
An assistant message with 'tool_calls' must be followed by tool messages
responding to each 'tool_call_id'.
```

During a Plan Lattice tool execution, the plugin appended an
`[plan-lattice/input-review]` user message directly to the session before DSH
had appended that tool's `tool/result`. Strict OpenAI-compatible providers
therefore observed an arbitrary user message between an assistant tool call and
its required result.

The subsequent implementation replaces that direct append with DSH's native
`ToolRunContext.deferContext()`. DSH commits deferred plugin context only after
the enclosing `tool/result`. A new real AgentLoop regression test verifies the
strict provider ordering. This is a code fix after the frozen V10 run, not a
reason to alter or rerun V10.

## Design Consequence

Any successor evaluation must be a newly preregistered protocol with the fixed
candidate commit, a fresh manifest, and robust accounting for provider failures
that omit usage. Its report must retain V10 as a negative sample and compare
only against a separately executed, fixed protocol.
