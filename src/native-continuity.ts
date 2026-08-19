import { createHash } from 'node:crypto'
import type { SessionEvent } from '@deepseek-ai/dsh-session/types'

export interface NativeApprovedPlan {
  callId: string
  plan: string
  resultSeq: number
}

export interface NativeTodoItem {
  content: string
  status: 'pending' | 'in_progress' | 'completed'
}

export interface NativeDelegatedOutcome {
  callId: string
  description?: string
  promptDigest: string
  result: string
  resultDigest: string
  resultSeq: number
}

export interface NativeContinuityProjection {
  approvedPlan?: NativeApprovedPlan
  todos: NativeTodoItem[]
  delegatedOutcomes: NativeDelegatedOutcome[]
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function parseArguments(value: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(value)
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : undefined
  } catch {
    return undefined
  }
}

function resultText(event: SessionEvent<'tool/result'>): string {
  return event.data.message.content[0].content.flatMap(block => {
    if (block.type === 'text') return [block.text]
    return []
  }).join('')
}

function successfulResult(event: SessionEvent<'tool/result'>): boolean {
  return event.data.error === undefined && event.data.message.content[0].isError === false
}

function isSubagentCall(name: string, args: Record<string, unknown>): boolean {
  return /(?:^|[_-])subagent(?:$|[_-])/i.test(name)
    || (typeof args.prompt === 'string'
      && typeof args.description === 'string'
      && ('run_in_background' in args || 'agentOptions' in args))
}

function isBackgroundStart(args: Record<string, unknown>, result: string): boolean {
  return args.run_in_background === true
    || /^started (?:background )?subagent(?: job)?\s/i.test(result.trim())
}

/**
 * Fold only state that DSH already owns. This is a recovery projection over
 * the append-only Session log, never a second planner or scheduler.
 */
export function projectNativeContinuity(events: readonly SessionEvent[]): NativeContinuityProjection {
  const calls = new Map<string, SessionEvent<'tool/call'>>()
  let approvedPlan: NativeApprovedPlan | undefined
  let todos: NativeTodoItem[] = []
  const delegatedOutcomes: NativeDelegatedOutcome[] = []

  for (const event of events) {
    if (event.type === 'turn/start') {
      todos = []
      continue
    }
    if (event.type === 'todo/write') {
      todos = event.data.todos.map(todo => ({ ...todo }))
      continue
    }
    if (event.type === 'tool/call') {
      calls.set(String(event.data.callId), event)
      continue
    }
    if (event.type !== 'tool/result' || !successfulResult(event)) continue

    const callId = String(event.data.message.source.callId)
    const call = calls.get(callId)
    if (call === undefined) continue
    const args = parseArguments(call.data.arguments)
    if (args === undefined) continue

    if (call.data.name === 'exit_plan_mode' && typeof args.plan === 'string' && args.plan.trim() !== '') {
      approvedPlan = { callId, plan: args.plan, resultSeq: event.seq }
      continue
    }
    if (!isSubagentCall(call.data.name, args) || typeof args.prompt !== 'string') continue
    const result = resultText(event)
    if (result.trim() === '' || isBackgroundStart(args, result)) continue
    delegatedOutcomes.push({
      callId,
      ...(typeof args.description === 'string' && args.description.trim() !== ''
        ? { description: args.description }
        : {}),
      promptDigest: sha256(args.prompt),
      result,
      resultDigest: sha256(result),
      resultSeq: event.seq,
    })
  }

  // `todo/write` is a standing plan only inside its native DSH turn. The fold
  // above intentionally clears it at every later turn/start.
  return { approvedPlan, todos, delegatedOutcomes: delegatedOutcomes.slice(-3) }
}
