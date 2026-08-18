export function longSystemCommonPrompt(workspace) {
  return `## Long-system matched execution boundary

This is a closed-world, staged software-delivery evaluation. The complete initial product authority arrived in the first user task. Later plugin-authored stage messages contain no new product requirements; only a later message with user authority may revise the accepted requirements.

Both paired arms have the same workspace, model, budget, process-restart schedule, compaction schedule, parent/child stage assignment, and tool boundary. External search, direct file editors, background jobs, model-directed delegation, and requirement questions are absent. Do not access the network or paths outside ${workspace}.

Use only visible tools. Bash is the sole mutation and test channel and already runs with ${workspace} as its working directory. Provide only command and description; do not set workdir, run_in_background, timeoutMs, or other execution metadata. Keep every command scoped to this workspace. Do not inspect evaluator files, environment secrets, sibling attempts, or hidden tests. The grader evaluates behavior, not prose. Finish only the milestone named by the current stage, run relevant public tests, and leave the workspace usable by the next process or agent.`
}
