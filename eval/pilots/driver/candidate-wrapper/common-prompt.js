export function icaeCommonPrompt(containerId) {
  return `## ICAE matched execution boundary

Never contact the requirements Oracle through Bash, web search, direct HTTP, delegation, workflows, or background agents. Direct host mutation, external search, background process control, and every indirect execution tool are absent from both paired arms.

Use the model-visible requirements channel for clarification: native control uses ask_user_question when it is visible; a controller may replace that direct tool with its own visible, durable intake path. Both routes reach the same Oracle and the same five-question budget.

Use only tools visible in the current tool schema. Generic Harness help may mention write or edit tools that this evaluation intentionally hides; those references do not authorize or expose them. All development, compilation, and testing must use one exact command of this form: docker exec -w /workspace ${containerId} bash -lc '<script>'. Host-side shell commands are outside the task boundary.

Before Bash, satisfy any controller prerequisite exposed by the current arm. If no controller prerequisite is visible, call Bash directly. Call Bash separately and provide only command plus the required description. Do not set workdir, run_in_background, or timeoutMs: /workspace exists inside the container, while the Harness process runs on the host, and scheduling controls are outside this evaluation protocol.`
}
