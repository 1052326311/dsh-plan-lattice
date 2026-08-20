import type { SessionEvent, TodoItem } from '@deepseek-ai/dsh-session/types'
import { isKnownReadOnlyBash } from './shell-readonly.js'

export type NativeWorkflowEvidenceKind = 'mutation' | 'verification' | 'observation'

export interface NativeWorkflowTodoItem extends TodoItem {
  activationSeq?: number
}

export interface NativeWorkflowEvidence {
  kind: NativeWorkflowEvidenceKind
  toolName: string
  callId: string
  callSeq: number
  resultSeq: number
  result: string
  todoIndex?: number
  activationSeq?: number
}

export interface NativeWorkflowProjection {
  todos: NativeWorkflowTodoItem[]
  todoSeq?: number
  evidence: NativeWorkflowEvidence[]
  replanRequired?: {
    seq: number
    reason: string
  }
  replanRefreshSeq?: number
  validationError?: string
}

export interface NativeWorkflowProjectionOptions {
  /** Reject todo/write records that are not causally enclosed by todo_write. */
  requireSuccessfulTodoResult?: boolean
}

export type NativeTodoCandidate = readonly TodoItem[] | { readonly todos: readonly TodoItem[] }

interface RecordedCall {
  name: string
  callId: string
  callSeq: number
  argumentsText: string
  arguments: unknown
  turn?: number
  step?: number
}

interface PendingTodoWrite {
  callId: string
  writeSeq: number
  todos: NativeWorkflowTodoItem[]
  todoSeq?: number
  evidenceLength: number
  replanRequired?: NativeWorkflowProjection['replanRequired']
  replanRefreshSeq?: number
  validationError?: string
}

export type NativeWorkflowToolClass = 'control' | 'read' | 'mutation' | 'unsupported'

const MUTATION_TOOLS = new Set(['write', 'edit', 'str_replace_editor'])
const QUESTION_TOOLS = new Set(['ask_user_question', 'request_user_input'])
const CONTROL_TOOLS = new Set(['todo_write', 'exit_plan_mode', 'lattice_refresh_context', 'lattice_status', 'run_code'])
const EXPLICIT_READ_TOOLS = new Set([
  'read', 'grep', 'glob', 'view',
  'web_search', 'web_fetch', 'lsp', 'read_image', 'skill', 'get_goal', 'job_list', 'job_output',
  'terminal_list', 'terminal_read', 'schedule_list', 'list_agents',
])
const UNSUPPORTED_MULTISTEP_TOOLS = new Set([
  'terminal_open', 'terminal_send', 'terminal_signal', 'terminal_close', 'job_kill',
  'workflow', 'ralph', 'send_message', 'interrupt_agent', 'report',
  'schedule_create', 'schedule_delete', 'cordis_define', 'cordis_run', 'cordis_stop', 'cordis_undefine',
])
const OBSERVATION_ONLY_TODO = /^(?:(?:inspect|analy[sz]e|review|audit|investigate|reproduce|read|research|verify|validate|test|measure|benchmark|compare|clarify|confirm)\b|(?:检查|分析|审查|调查|复现|读取|研究|验证|测试|测量|评测|比较|澄清|确认))/iu
const MUTATION_INTENT = /(?:\b(?:implement|build|create|add|change|modify|edit|write|fix|repair|update|refactor|remove|delete|migrate|deploy|configure|install)\b|实现|开发|构建|创建|新增|添加|修改|编辑|写入|修复|更新|重构|删除|迁移|部署|配置|安装)/iu
const EXPLICIT_REPLAN_SIGNAL = /(?:^|\n)\s*(?:blocker|conflict|requirement changed|critical fact changed|阻塞|冲突|需求变更|关键事实变化)\s*[:：]/iu

function parseArguments(value: string): unknown {
  try {
    return JSON.parse(value) as unknown
  } catch {
    return undefined
  }
}

function renderedText(content: readonly { type: string; text?: string }[]): string {
  return content.flatMap(block => {
    if (block.type === 'text') return [block.text]
    return []
  }).join('\n')
}

function resultText(event: SessionEvent<'tool/result'>): string {
  return renderedText(event.data.message.content[0].content)
}

function successfulResult(event: SessionEvent<'tool/result'>): boolean {
  return event.data.error === undefined && event.data.message.content[0].isError === false
}

function commandText(arguments_: unknown): string | undefined {
  if (arguments_ === null || typeof arguments_ !== 'object' || Array.isArray(arguments_)) return undefined
  const record = arguments_ as Record<string, unknown>
  const value = record.command ?? record.cmd ?? record.script
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

function argumentRecord(arguments_: unknown): Record<string, unknown> | undefined {
  return arguments_ !== null && typeof arguments_ === 'object' && !Array.isArray(arguments_)
    ? arguments_ as Record<string, unknown>
    : undefined
}

function isDelegationTool(toolName: string, arguments_: unknown): boolean {
  const record = argumentRecord(arguments_)
  if (record === undefined || typeof record.prompt !== 'string') return false
  return toolName === 'subagent'
    || toolName.startsWith('subagent_')
    || toolName.endsWith('_subagent')
    || toolName.includes('_subagent_')
}

function isVerificationSegment(segment: string): boolean {
  const command = segment.trim().replace(/^(?:env\s+)?(?:[A-Za-z_][A-Za-z0-9_]*=\S+\s+)*/u, '')
  return /^(?:(?:npm|pnpm|yarn|bun)\s+(?:(?:run|exec)\s+)?(?:test|check|lint|build|typecheck)(?::[A-Za-z0-9_-]+)?\b|(?:npm|pnpm|yarn|bun)\s+(?:exec\s+)?(?:pytest|vitest|jest|eslint|tsc|mypy)\b|npx\s+(?:pytest|vitest|jest|eslint|tsc)\b|(?:python\d*|py)\s+-m\s+pytest\b|(?:pytest|vitest|jest|eslint|mypy|invoke-pester|pester)\b|ruff\s+check\b|tsc(?:\s|$)|node\s+--test\b|deno\s+test\b|go\s+test\b|cargo\s+(?:test|check|build|clippy)\b|dotnet\s+(?:test|build)\b|make\s+(?:test|check|lint|build|typecheck)\b)/iu.test(command)
}

function isVerificationShellCommand(command: string): boolean {
  if (/[;|<>`\n\r]/u.test(command) || command.includes('$(')) return false
  let sawVerification = false
  for (const segment of command.split('&&')) {
    if (isVerificationSegment(segment)) {
      sawVerification = true
      continue
    }
    if (!isKnownReadOnlyBash({ command: segment.trim() })) return false
  }
  return sawVerification
}

function isKnownReadOnlyPwsh(arguments_: unknown): boolean {
  const command = commandText(arguments_)
  // PowerShell's `$()` subexpressions and `&` call operator can execute a
  // mutation while the outer command still begins with an allowed reader.
  if (command === undefined || /[|><`\n\r$&]/u.test(command)) return false
  return command.split(';').every(segment => {
    const program = segment.trim().split(/\s+/u)[0]?.toLowerCase()
    return program !== undefined && new Set([
      'get-childitem', 'get-content', 'get-item', 'get-location', 'select-string',
    ]).has(program)
  })
}

function withoutZeroFailureCounts(text: string): string {
  return text
    .replace(/\b0\s+(?:tests?\s+)?(?:failed|failures?)\b/giu, '')
    .replace(/\b(?:fail|failed|failure|failures)\s*[:=]?\s*0\b/giu, '')
}

function reliableShellVerificationSuccess(text: string): boolean {
  if (text.trim() === '') return false
  let explicitZeroExit = false
  const exitStatus = /\bexit(?:ed)?(?:\s+with)?[\s_-]*(?:code|status)\s*["']?\s*[:=]?\s*(-?\d+)\b/giu
  for (const match of text.matchAll(exitStatus)) {
    const value = Number(match[1])
    if (value !== 0) return false
    explicitZeroExit = true
  }

  const withoutZeroFailures = withoutZeroFailureCounts(text)
  if (/\b(?:fail|failed|failure|failures|timeout|aborted)\b|\btimed\s+out\b|\bsignal\b|\bnot\s+ok\b/iu.test(withoutZeroFailures)) {
    return false
  }
  if (explicitZeroExit) return true

  return /(?:\btest\s+result:\s*ok\b|(?:^|\n)\s*ok\s+\S+|(?:^|\n)\s*pass\s+\S+|\btest\s+files?\s+\d+\s+passed\b|\btests?\s*[:=]?\s*\d+\s+passed\b|\b\d+\s+(?:tests?\s+)?passed\b|\ball\s+(?:tests?|checks?)\s+passed\b|\b(?:build|check|lint|typecheck)\s+(?:completed\s+)?successfully\b)/iu.test(text)
}

function resultReportsFailure(text: string): boolean {
  const normalized = withoutZeroFailureCounts(text)
  for (const match of normalized.matchAll(/\bexit(?:ed)?(?:\s+with)?[\s_-]*(?:code|status)\s*["']?\s*[:=]?\s*(-?\d+)\b/giu)) {
    if (Number(match[1]) !== 0) return true
  }
  return /\b(?:fail|failed|failure|failures|timeout|aborted)\b|\btimed\s+out\b|\bsignal\b|\bnot\s+ok\b/iu.test(normalized)
}

/** Classify DSH tools conservatively; unknown capabilities are side effects until proven read-only. */
export function nativeWorkflowToolClass(
  name: string,
  arguments_: unknown,
  guardedTools: ReadonlySet<string> | readonly string[],
): NativeWorkflowToolClass {
  const toolName = name.trim().toLowerCase()
  const guarded = guardedTools instanceof Set
    ? guardedTools
    : new Set(Array.from(guardedTools, tool => tool.trim().toLowerCase()))
  if (UNSUPPORTED_MULTISTEP_TOOLS.has(toolName)) return 'unsupported'
  if (CONTROL_TOOLS.has(toolName)) return 'control'
  if (QUESTION_TOOLS.has(toolName)) return 'read'
  if (EXPLICIT_READ_TOOLS.has(toolName) || toolName.startsWith('session_') || toolName.startsWith('cordis_inspect_')) {
    return 'read'
  }
  if (toolName === 'str_replace_editor') {
    if (arguments_ !== null && typeof arguments_ === 'object' && !Array.isArray(arguments_)
      && (arguments_ as Record<string, unknown>).command === 'view') return 'read'
    return 'mutation'
  }
  if (toolName === 'bash') {
    if (argumentRecord(arguments_)?.run_in_background === true) return 'unsupported'
    return isKnownReadOnlyBash(arguments_) ? 'read' : 'mutation'
  }
  if (toolName === 'pwsh') return isKnownReadOnlyPwsh(arguments_) ? 'read' : 'mutation'
  if (isDelegationTool(toolName, arguments_)) {
    // rc.7 continuable subagents run in the background by default. Requiring
    // an explicit foreground choice keeps mutation settlement observable.
    return argumentRecord(arguments_)?.run_in_background === false ? 'mutation' : 'unsupported'
  }
  if (MUTATION_TOOLS.has(toolName) || guarded.has(toolName)) return 'mutation'
  return 'mutation'
}

function classifyEvidence(
  call: RecordedCall,
  result: string,
  guardedTools: ReadonlySet<string>,
): NativeWorkflowEvidenceKind | undefined {
  const toolName = call.name.toLowerCase()
  const toolClass = nativeWorkflowToolClass(toolName, call.arguments, guardedTools)
  if (toolClass === 'unsupported' || toolClass === 'control') return undefined
  if (toolName === 'bash' || toolName === 'pwsh') {
    const command = commandText(call.arguments)
    if (command !== undefined && isVerificationShellCommand(command)) {
      return reliableShellVerificationSuccess(result) ? 'verification' : undefined
    }
  }
  if (toolClass === 'read') return 'observation'
  if (toolClass === 'mutation') return 'mutation'
  return undefined
}

function failedExecutionReason(
  call: RecordedCall,
  success: boolean,
  resultSeq: number,
  result: string,
  guardedTools: ReadonlySet<string>,
): string | undefined {
  const toolName = call.name.toLowerCase()
  const toolClass = nativeWorkflowToolClass(toolName, call.arguments, guardedTools)
  if (toolClass === 'unsupported') {
    return `${toolName} used an unsupported background or multi-action transport at result seq ${resultSeq}`
  }
  if (!success && toolClass === 'mutation') {
    return `${toolName} failed at result seq ${resultSeq}`
  }
  if ((toolName === 'bash' || toolName === 'pwsh') && resultReportsFailure(result)) {
    return `${toolName} reported a failed, aborted, timed-out, or non-zero command at result seq ${resultSeq}`
  }
  if (EXPLICIT_REPLAN_SIGNAL.test(result)) {
    return `${toolName} reported an explicit blocker or changed critical fact at result seq ${resultSeq}`
  }
  return undefined
}

function isObservationOnlyTodo(content: string): boolean {
  const normalized = content.trim()
  return OBSERVATION_ONLY_TODO.test(normalized) && !MUTATION_INTENT.test(normalized)
}

function orderedEvents(events: readonly SessionEvent[], throughSeq: number, fromSeq: number): SessionEvent[] {
  return events
    .filter(event => Number.isSafeInteger(event.seq) && event.seq >= fromSeq && event.seq <= throughSeq)
    .map((event, index) => ({ event, index }))
    .sort((left, right) => left.event.seq - right.event.seq || left.index - right.index)
    .map(item => item.event)
}

function sameContents(left: readonly Pick<TodoItem, 'content'>[], right: readonly Pick<TodoItem, 'content'>[]): boolean {
  return left.length === right.length && left.every((item, index) => item.content === right[index]?.content)
}

function sameTodoSnapshot(left: readonly TodoItem[], right: readonly TodoItem[]): boolean {
  return left.length === right.length && left.every((item, index) =>
    item.content === right[index]?.content && item.status === right[index]?.status)
}

function candidateItems(candidate: NativeTodoCandidate): readonly TodoItem[] | undefined {
  if (Array.isArray(candidate)) return candidate
  if (candidate !== null && typeof candidate === 'object') {
    const record = candidate as { readonly todos?: unknown }
    if (Array.isArray(record.todos)) return record.todos as TodoItem[]
  }
  return undefined
}

function candidateShapeError(todos: readonly TodoItem[]): string | undefined {
  for (let index = 0; index < todos.length; index += 1) {
    const item = todos[index]
    if (item === null || typeof item !== 'object') return `Todo item ${index + 1} must be an object`
    if (typeof item.content !== 'string' || item.content.trim() === '') {
      return `Todo item ${index + 1} must have non-empty content`
    }
    if (item.status !== 'pending' && item.status !== 'in_progress' && item.status !== 'completed') {
      return `Todo item ${index + 1} has an invalid status`
    }
  }
  return undefined
}

function orderedStatusError(todos: readonly TodoItem[], allowAllCompleted: boolean): string | undefined {
  const activeIndices = todos.flatMap((todo, index) => todo.status === 'in_progress' ? [index] : [])
  const allCompleted = todos.length > 0 && todos.every(todo => todo.status === 'completed')
  if (allCompleted) return allowAllCompleted ? undefined : 'a replan cannot make every Todo item completed'
  if (activeIndices.length !== 1) return 'Todo must have exactly one in_progress item'
  const activeIndex = activeIndices[0]!
  if (todos.slice(0, activeIndex).some(todo => todo.status !== 'completed')) {
    return 'Todo items before the in_progress item must be completed in order'
  }
  if (todos.slice(activeIndex + 1).some(todo => todo.status !== 'pending')) {
    return 'Todo items after the in_progress item must remain pending'
  }
  return undefined
}

function validateReplan(
  projection: NativeWorkflowProjection,
  candidate: readonly TodoItem[],
): string | undefined {
  if (projection.replanRefreshSeq === undefined || projection.todoSeq === undefined
    || projection.replanRefreshSeq <= projection.todoSeq) {
    return 'changing Todo content, order, or length requires a successful lattice_refresh_context after the latest todo/write'
  }
  const statusError = orderedStatusError(candidate, false)
  if (statusError !== undefined) return statusError

  const completedPrefix = projection.todos.findIndex(todo => todo.status !== 'completed')
  const prefixLength = completedPrefix < 0 ? projection.todos.length : completedPrefix
  if (candidate.length <= prefixLength) {
    return 'replan must preserve the completed prefix and retain unfinished work'
  }
  for (let index = 0; index < prefixLength; index += 1) {
    const before = projection.todos[index]!
    const after = candidate[index]
    if (after?.status !== 'completed' || after.content !== before.content) {
      return `replan must preserve completed Todo prefix item ${index + 1} exactly as ${JSON.stringify(before.content)}`
    }
  }
  const unexpectedCompleted = candidate.findIndex((todo, index) => index >= prefixLength && todo.status === 'completed')
  if (unexpectedCompleted >= 0) {
    return `replan cannot mark new or previously unfinished item ${JSON.stringify(candidate[unexpectedCompleted]!.content)} completed`
  }
  return undefined
}

function completionEvidenceError(
  projection: NativeWorkflowProjection,
  activeIndex: number,
  active: NativeWorkflowTodoItem,
): string | undefined {
  if (active.activationSeq === undefined) {
    return `active Todo item ${JSON.stringify(active.content)} has no activation sequence`
  }
  const activationSeq = active.activationSeq
  const evidence = projection.evidence.filter(item => item.todoIndex === activeIndex
    && item.activationSeq === activationSeq
    && item.callSeq > activationSeq
    && item.resultSeq > item.callSeq)
  const mutations = evidence.filter(item => item.kind === 'mutation')
  if (mutations.length > 0) {
    const lastMutation = mutations.at(-1)!
    if (!evidence.some(item => item.kind === 'verification' && item.callSeq > lastMutation.resultSeq)) {
      return `active Todo item ${JSON.stringify(active.content)} requires verification after the last mutation settled at result seq ${lastMutation.resultSeq}; verification dispatched before settlement does not count`
    }
    return undefined
  }
  if (!isObservationOnlyTodo(active.content)) {
    return `active Todo item ${JSON.stringify(active.content)} requires concrete mutation evidence; use an explicitly observational Todo for inspection, reproduction, clarification, or verification work`
  }
  if (!evidence.some(item => item.kind === 'observation' || item.kind === 'verification')) {
    return `active Todo item ${JSON.stringify(active.content)} requires observation or verification evidence after activation seq ${activationSeq}`
  }
  return undefined
}

/** Validate one proposed whole-list native Todo snapshot without mutating the projection. */
export function validateNativeTodoUpdate(
  projection: NativeWorkflowProjection,
  candidate: NativeTodoCandidate,
): string | undefined {
  const todos = candidateItems(candidate)
  if (todos === undefined) return 'Todo candidate must be an array or an object with a todos array'
  const shapeError = candidateShapeError(todos)
  if (shapeError !== undefined) return shapeError

  if (projection.todoSeq === undefined || projection.todos.length === 0) {
    if (todos.length < 2) return 'initial Todo must contain at least two items'
    if (todos.some(todo => todo.status === 'completed')) return 'initial Todo cannot contain completed items'
    return orderedStatusError(todos, false)
  }

  if (projection.replanRequired !== undefined) {
    if (projection.replanRefreshSeq === undefined
      || projection.replanRefreshSeq <= projection.replanRequired.seq) {
      return `replan required after ${projection.replanRequired.reason}; call lattice_refresh_context before reaffirming or replacing the unfinished Todo`
    }
    if (sameContents(projection.todos, todos)) {
      const sameSnapshot = projection.todos.every((todo, index) => todo.status === todos[index]?.status)
      return sameSnapshot ? undefined : 'replan debt may only be cleared by reaffirming the exact Todo snapshot or replacing its unfinished suffix'
    }
    return validateReplan(projection, todos)
  }

  const replan = !sameContents(projection.todos, todos)
  if (replan) return validateReplan(projection, todos)
  if (projection.validationError !== undefined) {
    return `current Todo is invalid: ${projection.validationError}`
  }

  const currentShapeError = candidateShapeError(projection.todos)
    ?? orderedStatusError(projection.todos, true)
  if (currentShapeError !== undefined) return `current Todo is invalid: ${currentShapeError}`
  const nextStatusError = orderedStatusError(todos, true)
  if (nextStatusError !== undefined) return nextStatusError

  const activeIndex = projection.todos.findIndex(todo => todo.status === 'in_progress')
  for (let index = 0; index < projection.todos.length; index += 1) {
    const before = projection.todos[index]!
    const after = todos[index]!
    if (before.status === 'completed' && after.status !== 'completed') {
      return `completed Todo item ${JSON.stringify(before.content)} cannot move back to ${after.status}`
    }
    if (before.status === 'pending' && after.status === 'completed') {
      return `pending Todo item ${JSON.stringify(before.content)} cannot become completed directly`
    }
    if (before.status === 'pending' && after.status === 'in_progress') {
      if (index !== activeIndex + 1 || activeIndex < 0 || todos[activeIndex]?.status !== 'completed') {
        return `pending Todo item ${JSON.stringify(before.content)} can become active only in order`
      }
    }
    if (before.status === 'in_progress' && after.status === 'pending') {
      return `active Todo item ${JSON.stringify(before.content)} cannot return to pending`
    }
  }

  if (activeIndex >= 0 && todos[activeIndex]?.status === 'completed') {
    return completionEvidenceError(projection, activeIndex, projection.todos[activeIndex]!)
  }
  return undefined
}

function matchingCompletedActivation(
  previous: readonly NativeWorkflowTodoItem[],
  content: string,
  used: Set<number>,
): number | undefined {
  const index = previous.findIndex((todo, candidateIndex) => !used.has(candidateIndex)
    && todo.status === 'completed' && todo.content === content)
  if (index < 0) return undefined
  used.add(index)
  return previous[index]?.activationSeq
}

function foldTodoWrite(
  previous: readonly NativeWorkflowTodoItem[],
  candidate: readonly TodoItem[],
  seq: number,
): NativeWorkflowTodoItem[] {
  const replan = !sameContents(previous, candidate)
  const usedCompleted = new Set<number>()
  return candidate.map((todo, index) => {
    if (!replan) {
      const prior = previous[index]
      if (todo.status === 'in_progress' && prior?.status !== 'in_progress') {
        return { ...todo, activationSeq: seq }
      }
      return prior?.activationSeq === undefined ? { ...todo } : { ...todo, activationSeq: prior.activationSeq }
    }
    if (todo.status === 'in_progress') return { ...todo, activationSeq: seq }
    if (todo.status === 'completed') {
      const activationSeq = matchingCompletedActivation(previous, todo.content, usedCompleted)
      return activationSeq === undefined ? { ...todo } : { ...todo, activationSeq }
    }
    return { ...todo }
  })
}

/** Fold durable DSH Todo and successful native tool evidence through one sequence boundary. */
export function projectNativeWorkflow(
  events: readonly SessionEvent[],
  guardedTools: ReadonlySet<string> | readonly string[],
  throughSeq = Number.POSITIVE_INFINITY,
  fromSeq = 0,
  options: NativeWorkflowProjectionOptions = {},
): NativeWorkflowProjection {
  const guarded = new Set(Array.from(guardedTools, tool => tool.trim().toLowerCase()))
  const ordered = orderedEvents(events, throughSeq, fromSeq)
  const callCounts = new Map<string, number>()
  for (const event of ordered) {
    if (event.type !== 'tool/call' && event.type !== 'tool/code-dispatch-start') continue
    const callId = String(event.type === 'tool/call' ? event.data.callId : event.data.subCallId)
    callCounts.set(callId, (callCounts.get(callId) ?? 0) + 1)
  }

  const calls = new Map<string, RecordedCall>()
  const settled = new Set<string>()
  const pendingTodoWrites = new Map<string, PendingTodoWrite>()
  let todos: NativeWorkflowTodoItem[] = []
  let todoSeq: number | undefined
  const evidence: NativeWorkflowEvidence[] = []
  let replanRequired: NativeWorkflowProjection['replanRequired']
  let replanRefreshSeq: number | undefined
  let validationError: string | undefined

  const restorePendingTodo = (pending: PendingTodoWrite): void => {
    todos = pending.todos.map(todo => ({ ...todo }))
    todoSeq = pending.todoSeq
    evidence.splice(pending.evidenceLength)
    replanRequired = pending.replanRequired
    replanRefreshSeq = pending.replanRefreshSeq
    validationError = pending.validationError
  }

  const settleCall = (call: RecordedCall, resultSeq: number, success: boolean, text: string): void => {
    if (call.name.toLowerCase() === 'todo_write') {
      const pending = pendingTodoWrites.get(call.callId)
      pendingTodoWrites.delete(call.callId)
      if (pending === undefined) {
        // A guard or pre-execute rejection legitimately produces a failed
        // todo_write result without entering the tool body. With no durable
        // snapshot there is nothing to roll back and the prior Todo remains
        // authoritative.
        if (success) {
          validationError = `todo_write result at seq ${resultSeq} has no unique durable todo/write snapshot`
        }
        return
      }
      if (success) return
      restorePendingTodo(pending)
      if (todoSeq === undefined) {
        validationError = `initial todo_write failed at result seq ${resultSeq}; retry the complete initial Todo`
      } else {
        replanRequired = { seq: resultSeq, reason: `todo_write failed at result seq ${resultSeq}` }
        replanRefreshSeq = undefined
      }
      return
    }
    if (call.name === 'lattice_refresh_context' && success) {
      const requiredAfter = replanRequired?.seq ?? todoSeq
      if (requiredAfter !== undefined && call.callSeq > requiredAfter) replanRefreshSeq = resultSeq
      return
    }

    const failureReason = failedExecutionReason(call, success, resultSeq, text, guarded)
    if (todoSeq !== undefined && failureReason !== undefined) {
      replanRequired = { seq: resultSeq, reason: failureReason }
      replanRefreshSeq = undefined
    }
    if (todoSeq !== undefined && success && QUESTION_TOOLS.has(call.name.toLowerCase())) {
      replanRequired = {
        seq: resultSeq,
        reason: `${call.name.toLowerCase()} returned new human authority at result seq ${resultSeq}`,
      }
      replanRefreshSeq = undefined
    }
    if (!success) return

    const kind = classifyEvidence(call, text, guarded)
    if (kind === undefined) return
    const activeIndices = todos.flatMap((todo, index) => todo.status === 'in_progress' ? [index] : [])
    const activeIndex = validationError === undefined && activeIndices.length === 1 ? activeIndices[0] : undefined
    const active = activeIndex === undefined ? undefined : todos[activeIndex]
    evidence.push({
      kind,
      toolName: call.name,
      callId: call.callId,
      callSeq: call.callSeq,
      resultSeq,
      result: text,
      ...(activeIndex === undefined ? {} : { todoIndex: activeIndex }),
      ...(active?.activationSeq === undefined ? {} : { activationSeq: active.activationSeq }),
    })
  }

  for (const event of ordered) {
    if (event.type === 'user/message') {
      if (todoSeq !== undefined && event.seq > todoSeq && event.data.source.kind === 'user') {
        replanRequired = { seq: event.seq, reason: `new root user input arrived at seq ${event.seq}` }
        replanRefreshSeq = undefined
      }
      continue
    }
    if (event.type === 'todo/write') {
      const matchingCalls = [...calls.values()].filter(call => {
        if (settled.has(call.callId) || call.name.toLowerCase() !== 'todo_write' || call.callSeq >= event.seq) return false
        const candidate = candidateItems(call.arguments as NativeTodoCandidate)
        return candidate !== undefined && sameTodoSnapshot(candidate, event.data.todos)
      })
      if (matchingCalls.length > 1) {
        validationError = `todo/write at seq ${event.seq} ambiguously matches multiple unsettled todo_write calls`
        continue
      }
      const matchingCall = matchingCalls[0]
      if (matchingCall === undefined && options.requireSuccessfulTodoResult === true) {
        if (todoSeq === undefined) {
          validationError = `todo/write at seq ${event.seq} has no enclosing todo_write call`
        } else {
          replanRequired = {
            seq: event.seq,
            reason: `unpaired todo/write appeared at seq ${event.seq}`,
          }
          replanRefreshSeq = undefined
        }
        continue
      }
      if (matchingCall !== undefined) {
        pendingTodoWrites.set(matchingCall.callId, {
          callId: matchingCall.callId,
          writeSeq: event.seq,
          todos: todos.map(todo => ({ ...todo })),
          ...(todoSeq === undefined ? {} : { todoSeq }),
          evidenceLength: evidence.length,
          ...(replanRequired === undefined ? {} : { replanRequired: { ...replanRequired } }),
          ...(replanRefreshSeq === undefined ? {} : { replanRefreshSeq }),
          ...(validationError === undefined ? {} : { validationError }),
        })
      }
      const projection: NativeWorkflowProjection = {
        todos,
        ...(todoSeq === undefined ? {} : { todoSeq }),
        evidence,
        ...(replanRequired === undefined ? {} : { replanRequired }),
        ...(replanRefreshSeq === undefined ? {} : { replanRefreshSeq }),
        ...(validationError === undefined ? {} : { validationError }),
      }
      validationError = validateNativeTodoUpdate(projection, event.data.todos)
      todos = foldTodoWrite(todos, event.data.todos, event.seq)
      todoSeq = event.seq
      if (validationError === undefined) {
        replanRequired = undefined
        replanRefreshSeq = undefined
      }
      continue
    }
    if (event.type === 'tool/call') {
      const callId = String(event.data.callId)
      if (callCounts.get(callId) === 1) {
        calls.set(callId, {
          name: event.data.name,
          callId,
          callSeq: event.seq,
          argumentsText: event.data.arguments,
          arguments: parseArguments(event.data.arguments),
          turn: event.data.turn,
          step: event.data.step,
        })
      }
      continue
    }
    if (event.type === 'tool/code-dispatch-start') {
      const callId = String(event.data.subCallId)
      if (callCounts.get(callId) === 1) {
        calls.set(callId, {
          name: event.data.name,
          callId,
          callSeq: event.seq,
          argumentsText: JSON.stringify(event.data.arguments),
          arguments: event.data.arguments,
        })
      }
      continue
    }
    if (event.type === 'tool/code-dispatch') {
      const callId = String(event.data.subCallId)
      if (settled.has(callId)) continue
      settled.add(callId)
      const call = calls.get(callId)
      if (call === undefined
        || call.callSeq >= event.seq
        || call.name !== event.data.name
        || call.argumentsText !== JSON.stringify(event.data.arguments)) continue
      settleCall(call, event.seq, event.data.isError === false, renderedText(event.data.content))
      continue
    }
    if (event.type !== 'tool/result') continue

    const callId = String(event.data.message.source.callId)
    if (settled.has(callId)) continue
    settled.add(callId)
    const call = calls.get(callId)
    if (call === undefined
      || call.callSeq >= event.seq
      || call.turn !== event.data.turn
      || call.step !== event.data.step) {
      continue
    }
    settleCall(call, event.seq, successfulResult(event), resultText(event))
  }

  // A todo/write is emitted inside the tool body, before rc.7 post-execute can
  // still reject the call. Never expose an in-flight or result-less snapshot as
  // executable state. Full-session projections commit it only after the final
  // matching result above succeeds.
  for (const pending of [...pendingTodoWrites.values()].sort((left, right) => right.writeSeq - left.writeSeq)) {
    restorePendingTodo(pending)
  }

  return {
    todos,
    ...(todoSeq === undefined ? {} : { todoSeq }),
    evidence,
    ...(replanRequired === undefined ? {} : { replanRequired }),
    ...(replanRefreshSeq === undefined ? {} : { replanRefreshSeq }),
    ...(validationError === undefined ? {} : { validationError }),
  }
}

/** Return the reason a guarded mutation must wait, or undefined when one active item owns it. */
export function nativeWorkflowMutationBlock(projection: NativeWorkflowProjection): string | undefined {
  if (projection.validationError !== undefined) {
    return `native workflow blocks mutation: ${projection.validationError}`
  }
  if (projection.todoSeq === undefined || projection.todos.length === 0) {
    return 'native workflow blocks mutation: create an initial Todo with at least two ordered items'
  }
  if (projection.replanRequired !== undefined) {
    return `native workflow blocks mutation: replan required after ${projection.replanRequired.reason}; refresh exact authority and rewrite the unfinished Todo first`
  }
  const shapeError = candidateShapeError(projection.todos) ?? orderedStatusError(projection.todos, false)
  if (shapeError !== undefined) return `native workflow blocks mutation: ${shapeError}`
  const active = projection.todos.find(todo => todo.status === 'in_progress')
  if (active?.activationSeq === undefined) {
    return 'native workflow blocks mutation: the in_progress Todo item has no activation sequence'
  }
  return undefined
}

function compactResult(value: string): string {
  const oneLine = value.replace(/\s+/gu, ' ').trim()
  return oneLine.length <= 160 ? oneLine : `${oneLine.slice(0, 157)}...`
}

/** Render a stable, ASCII-only model-facing summary of the projected workflow state. */
export function renderNativeWorkflowState(projection: NativeWorkflowProjection): string {
  const lines = ['Native workflow state']
  if (projection.todoSeq === undefined || projection.todos.length === 0) {
    lines.push('Todo: none')
  } else {
    lines.push(`Todo (write seq ${projection.todoSeq}):`)
    for (let index = 0; index < projection.todos.length; index += 1) {
      const todo = projection.todos[index]!
      const marker = todo.status === 'completed' ? 'x' : todo.status === 'in_progress' ? '>' : ' '
      const activation = todo.activationSeq === undefined ? '' : `; activation seq ${todo.activationSeq}`
      lines.push(`${index + 1}. [${marker}] ${todo.content} (${todo.status}${activation})`)
    }
  }

  lines.push('Evidence:')
  if (projection.evidence.length === 0) {
    lines.push('- none')
  } else {
    for (const item of projection.evidence) {
      const binding = item.todoIndex === undefined ? '' : `; Todo ${item.todoIndex + 1}, activation seq ${item.activationSeq}`
      const result = compactResult(item.result)
      lines.push(`- ${item.kind}: ${item.toolName} call ${item.callSeq} -> result ${item.resultSeq}${binding}${result === '' ? '' : `; ${result}`}`)
    }
  }
  lines.push(projection.replanRefreshSeq === undefined
    ? 'Replan refresh: unavailable'
    : `Replan refresh: available at result seq ${projection.replanRefreshSeq}`)
  if (projection.replanRequired !== undefined) {
    lines.push(`Replan required: ${projection.replanRequired.reason} (event seq ${projection.replanRequired.seq})`)
  }
  if (projection.validationError !== undefined) lines.push(`Todo validation: ${projection.validationError}`)
  const mutationBlock = nativeWorkflowMutationBlock(projection)
  lines.push(mutationBlock === undefined ? 'Mutation: allowed' : `Mutation: blocked (${mutationBlock})`)
  return lines.join('\n')
}
