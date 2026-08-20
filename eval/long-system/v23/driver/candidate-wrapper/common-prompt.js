export function longSystemCommonPrompt(workspace) {
  return `## Long-system matched execution boundary

This is a closed-world, staged software-delivery evaluation. The complete initial product authority arrived in the first user task. Each later stage is an ordinary user task so a completed native Todo opens a fresh task epoch. Only the material-revision stage changes product requirements; the other stages request bounded verification, delegation, or integration work over the same workspace.

Both paired arms have the same workspace, model, budget, process-restart schedule, compaction schedule, delegation stage, and tool boundary. External search, direct file editors, background jobs, alternate delegation tools, and requirement questions are absent. Do not access the network or paths outside ${workspace}.

Use only visible tools. Bash is the sole mutation and test channel and already runs with ${workspace} as its working directory. Provide only command and description to Bash; do not set workdir, run_in_background, timeoutMs, or other Bash execution metadata. Keep every command scoped to this workspace. The native \`subagent_fork\` tool may be used exactly when the current stage explicitly requires foreground delegation; set \`run_in_background: false\`, wait for its result, and do not substitute a driver-started child. Do not inspect evaluator files, environment secrets, sibling attempts, or hidden tests. The grader evaluates behavior, not prose. Finish only the milestone named by the current stage, run relevant public tests, and leave the workspace usable by the next process or agent.`
}
