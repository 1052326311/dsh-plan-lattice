# Official DSH rc.7 Control Map

Harness commit: `99f6f02fecdb7dff40c3fbc9470f5907c29f74ca`.

| Concern | Official owner | V22 observation point | Plugin prohibition |
| --- | --- | --- | --- |
| Request loop | `packages/core/agent-loop/src/agent.ts` | `agent/pre-step`, marked `llm/stream` request | No private request builder |
| Prompt and tools | `packages/core/system-prompt/src/index.ts` | registered `systemPrompt.context` in the agent scope | No complete prompt replacement in auto |
| Dynamic context | `packages/core/agent-loop/src/runtime-context.ts` | DSH-authored snapshot source and named sections | No direct private Session event |
| Visible history | `packages/core/session/src/index.ts`, `surface.ts` | `session.deriveMessages()` and committed `surfaceOp.replace` | No alternate transcript |
| Compaction | `packages/compaction/compaction-basic/src/index.ts`, `region.ts` | summary plus replacement provenance | No second compactor |
| Plan Mode | `packages/plan/plan-mode/src/index.ts` | successful native `exit_plan_mode` call/result | No automatic plan state machine |
| Todo | `packages/todo/tool-todo/src/index.ts` | current-turn `todo/write` fold | No mirrored automatic Todo |
| Delegation tool | `packages/subagent/tool-subagent/src/index.ts` | raw parent tool call and matching result | No rewritten model prompt |
| Spawn child | `packages/subagent/subagent-spawn-in-process/src/index.ts` | zero-seed child Session | No parent capsule on first request |
| Fork child | `packages/subagent/subagent-fork-in-process/src/index.ts` | completed-turn seed boundary | Seed replacements are not child losses |
| Child execution | `packages/subagent/subagent-in-process-driver/src/index.ts` | first own user message and completed turn | No alternate lifecycle or result channel |

The stable boundary is the append-only Session log plus the current DSH
surface. Concrete plans, Todo items, summaries, providers, task wording, and
child topology are variable state. Auto recovery selects exact native records
only after the current surface no longer contains them.

