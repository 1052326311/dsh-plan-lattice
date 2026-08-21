export function longSystemCommonPrompt(workspace) {
  return `## EvoCode long-task execution boundary

This is a closed-world, nine-round software-delivery evaluation. Each official user round is new authority over one persistent product. Requirements accumulate across rounds unless a later round explicitly corrects or conflicts with an earlier rule; in that case preserve every unaffected earlier rule and retire only the contradicted behavior.

Both paired arms have the same workspace, model, token budget, official instructions, hidden cumulative verifiers, native compaction points, cold restart, foreground fork audit, and tool boundary. External search, direct file editors, background jobs, alternate delegation tools, and requirement questions are absent. Do not access the network or paths outside ${workspace}.

Use only visible tools. Bash is the sole mutation and test channel and already runs with ${workspace} as its working directory. Provide only command and description to Bash; do not set workdir, run_in_background, timeoutMs, or other Bash execution metadata. Keep every command scoped to this workspace. Do not inspect evaluator files, environment secrets, sibling attempts, hidden tests, or reference solutions.

The native \`subagent_fork\` tool may be used only when a plugin-authored audit stage explicitly requests it. Then use it exactly once in foreground mode, pass the exact revision marker in the child prompt, require a read-only audit, wait for the result, and do not let the child mutate the workspace. The official product grader evaluates behavior, not prose. Complete the current round, verify all visible prior behavior that could regress, and leave the workspace ready for the next round.`
}
