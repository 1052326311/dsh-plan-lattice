const DIRECT_HOST_MUTATION_TOOLS = new Set([
  'cordis_run',
  'edit',
  'pwsh',
  'run_code',
  'str_replace_editor',
  'terminal_close',
  'terminal_list',
  'terminal_open',
  'terminal_read',
  'terminal_send',
  'terminal_signal',
  'write',
])

const INDIRECT_EXECUTION_TOOLS = new Set([
  'interrupt_agent',
  'list_agents',
  'ralph',
  'send_message',
  'subagent',
  'subagent_fork',
  'workflow',
])

const EXTERNAL_INFORMATION_TOOLS = new Set([
  'web_fetch',
  'web_search',
])

const FORBIDDEN_TOOL_PREFIXES = [
  'job_',
  'schedule_',
  'subagent_',
]

function isForbiddenIcaeTool(name) {
  return typeof name === 'string'
    && (DIRECT_HOST_MUTATION_TOOLS.has(name)
      || INDIRECT_EXECUTION_TOOLS.has(name)
      || EXTERNAL_INFORMATION_TOOLS.has(name)
      || FORBIDDEN_TOOL_PREFIXES.some(prefix => name.startsWith(prefix)))
}

export function hiddenIcaeExecutionTools(toolNames) {
  return [...new Set(toolNames)].filter(isForbiddenIcaeTool).sort()
}

export function assertIcaeToolBoundary(exec) {
  if (isForbiddenIcaeTool(exec?.name)) {
    throw new Error(`ICAE candidate blocks out-of-bound tool ${JSON.stringify(exec.name)}; use only workspace reads, Plan Lattice controls, and the exact guarded docker exec Bash channel`)
  }
}

export function createIcaeToolBoundary() {
  const intakeAttemptedBy = new Set()
  return (exec) => {
    assertIcaeToolBoundary(exec)
    if (exec?.name !== 'lattice_intake') return
    const owner = exec.agent?.id
    if (owner === undefined || owner === null || String(owner).length === 0) {
      throw new Error('ICAE candidate intake requires an owning agent')
    }
    const key = String(owner)
    if (intakeAttemptedBy.has(key)) {
      throw new Error('ICAE candidate permits one Oracle intake batch; do not retry after an Oracle error')
    }
    intakeAttemptedBy.add(key)
  }
}
