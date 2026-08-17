const HOST_MUTATION_TOOLS = new Set([
  'cordis_run',
  'edit',
  'pwsh',
  'run_code',
  'str_replace_editor',
  'terminal_open',
  'terminal_send',
  'terminal_signal',
  'write',
])

export function hiddenIcaeHostTools(toolNames) {
  return [...new Set(toolNames)].filter(name => HOST_MUTATION_TOOLS.has(name)).sort()
}

export function assertIcaeToolBoundary(exec) {
  if (HOST_MUTATION_TOOLS.has(exec?.name)) {
    throw new Error(`ICAE candidate blocks host-side tool ${JSON.stringify(exec.name)}; use the exact guarded docker exec Bash channel`)
  }
}
