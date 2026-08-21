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
  'workflow',
])

const EXTERNAL_INFORMATION_TOOLS = new Set([
  'ask_user_question',
  'web_fetch',
  'web_search',
])

const FORBIDDEN_TOOL_PREFIXES = ['job_', 'schedule_']

export function isForbiddenLongSystemTool(name) {
  return typeof name === 'string'
    && (DIRECT_HOST_MUTATION_TOOLS.has(name)
      || INDIRECT_EXECUTION_TOOLS.has(name)
      || EXTERNAL_INFORMATION_TOOLS.has(name)
      || (name.startsWith('subagent_') && name !== 'subagent_fork')
      || FORBIDDEN_TOOL_PREFIXES.some(prefix => name.startsWith(prefix)))
}

export function hiddenLongSystemTools(toolNames) {
  return [...new Set(toolNames)].filter(isForbiddenLongSystemTool).sort()
}

export function assertLongSystemToolBoundary(exec) {
  if (isForbiddenLongSystemTool(exec?.name)) {
    throw new Error(`long-system matched boundary blocks out-of-bound tool ${JSON.stringify(exec.name)}`)
  }
}
