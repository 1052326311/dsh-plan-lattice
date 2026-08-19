# RC7 Native Long-System V7 Preregistration

## Question

Does the candidate preserve an accepted system specification better than native
DeepSeek Harness when the execution crosses native context compaction, process
restart, delegated implementation, and a material user revision?

The candidate is commit `f9d6cec25ab88cfec756f9d13a97c72d1a7d1df9`. It uses
the published rc.7 AgentLoop, session replay, runtime-context projection,
native compaction, Plan Mode, Todo, and child creation path. It does not replace
the native prompt, conversation, scheduler, compactor, or Plan Mode.

## Causal Boundary

This V7 protocol replaces V6 without modifying it. V6 was retired before any
model call because its candidate-only wrapper supplied a task-specific operating
manual for `lattice_open`, context refreshes, Bash, and checkpoints. A result
there would measure both the manual and the plugin.

V7 gives both arms byte-identical:

- initial task, staged messages, fixture, hidden grader, model, temperature,
  request/token budget, time limit, runtime bytes, and restart sequence;
- common boundary prompt, hidden tool list, working directory, and Bash-only
  execution channel; and
- support plugin, profile construction, model proxy, oracle, session metrics,
  and sandbox restrictions.

The only intended treatment difference is installation of the candidate
tarball. The candidate wrapper configures the plugin's documented `strictBash`
precondition adapter, which is part of the candidate's enforcement mechanism,
but contributes no prompt section, task-specific instruction, staged coaching,
or model-call policy. Native does not receive an equivalent fake tool, prompt,
or controller.

## Task And Outcome

The five fixed stages are copied byte-for-byte from V6:

1. foundation implementation from the complete first user specification;
2. native compaction and process continuation;
3. a native one-shot `spawn` child created through public
   `ctx.subagents.start()` that implements reporting in the shared workspace;
4. a material user revision replacing `reopen` with `requeue`; and
5. another native compaction and final integration.

The hidden grader reports a `0..100` score, hard-requirement misses, stale
removed behavior, affected-artifact coverage, and child-report regression.
Every partial workspace, transcript, grader result, session JSONL, proxy record,
and infrastructure failure is retained. A pair is a targeted exploratory
signal only; it cannot establish a ranking, a release, or general software
delivery uplift.

The runner rejects a child stage that lacks a matching observed native
`subagent/start` event from local `spawn`, a direct `parentSession`, native
`subagent` origin and depth, a durable `subagent/descriptor`, or a first native
user message whose SHA-256 does not match the delegated stage text. This tests
the real native child composition path rather than synthesizing child metadata.

## Fixed Decision Rule

A positive targeted signal requires both arms to finish within the fixed `60`
agent-request, `1,000,000` input-token, and `80,000` output-token budget and
the candidate to achieve all of:

- at least `15` score points and `30%` relative score above native;
- at least `50%` fewer hard-requirement misses;
- no retained `reopen` behavior;
- no regression of the delegated child's reporting work;
- at least two native compaction summaries; and
- an authenticated direct child lineage.

No protocol, prompt, task, grader, candidate commit, host runtime, or threshold
may be changed after the manifest is frozen. Failures remain in the report;
only an independently classified infrastructure failure may be rerun.

## Execution

Freeze the exact runtime and all evaluation sources first:

```sh
pnpm run long-system:v7:freeze
pnpm run long-system:v7:verify
```

Then perform the keyless installation/boot smoke. It never reads a model key or
starts a model request:

```sh
pnpm run long-system:v7:smoke
```

Only after a passing smoke and a clean committed checkout may an operator export
`DEEPSEEK_API_KEY` in the process environment and run:

```sh
pnpm run long-system:v7:run
```

The runner accepts the key only through its inherited environment, replaces it
with local proxy capabilities for every child process, and redacts retained
output. The key must never appear in a command line, repository file, config,
or artifact.
