import { createMessage, createToolResultMessage, CallId } from '@deepseek-ai/dsh-llm'
import type { SessionEvent } from '@deepseek-ai/dsh-session/types'
import { describe, expect, it } from 'vitest'
import { projectNativeContinuity } from '../src/native-continuity.js'

function event<T extends SessionEvent['type']>(
  type: T,
  seq: number,
  data: Extract<SessionEvent, { type: T }>['data'],
): Extract<SessionEvent, { type: T }> {
  return { type, seq, time: seq, data } as Extract<SessionEvent, { type: T }>
}

describe('DSH-native continuity projection', () => {
  it('folds approved native plans, current-turn Todo, and returned subagent results', () => {
    const events: SessionEvent[] = [
      event('turn/start', 1, { turn: 1 }),
      event('tool/call', 2, {
        turn: 1, step: 1, callId: CallId('plan-1'), name: 'exit_plan_mode',
        arguments: JSON.stringify({ plan: '# Approved plan\n\nShip the verified stages.' }),
      }),
      event('tool/result', 3, {
        turn: 1, step: 1,
        message: createToolResultMessage({
          callId: CallId('plan-1'), content: [{ type: 'text', text: 'Plan approved' }], isError: false,
        }),
      }),
      event('todo/write', 4, { todos: [
        { content: 'Implement API', status: 'completed' },
        { content: 'Verify UI', status: 'in_progress' },
      ] }),
      event('tool/call', 5, {
        turn: 1, step: 2, callId: CallId('child-1'), name: 'subagent',
        arguments: JSON.stringify({
          description: 'Audit persistence', prompt: 'Inspect persistence and return exact failures.', run_in_background: false,
        }),
      }),
      event('tool/result', 6, {
        turn: 1, step: 2,
        message: createToolResultMessage({
          callId: CallId('child-1'), content: [{ type: 'text', text: 'Migration test still fails at revision 4.' }], isError: false,
        }),
      }),
    ]

    const projection = projectNativeContinuity(events)
    expect(projection.approvedPlan).toMatchObject({
      callId: 'plan-1', plan: '# Approved plan\n\nShip the verified stages.', resultSeq: 3,
    })
    expect(projection.todos).toEqual([
      { content: 'Implement API', status: 'completed' },
      { content: 'Verify UI', status: 'in_progress' },
    ])
    expect(projection.delegatedOutcomes).toHaveLength(1)
    expect(projection.delegatedOutcomes[0]).toMatchObject({
      callId: 'child-1', description: 'Audit persistence',
      result: 'Migration test still fails at revision 4.', resultSeq: 6,
    })
    expect(projection.delegatedOutcomes[0]?.promptDigest).toMatch(/^[0-9a-f]{64}$/)
  })

  it('uses DSH Todo turn semantics and ignores failed plan or child calls', () => {
    const events: SessionEvent[] = [
      event('turn/start', 1, { turn: 1 }),
      event('todo/write', 2, { todos: [{ content: 'Old turn', status: 'in_progress' }] }),
      event('turn/start', 3, { turn: 2 }),
      event('tool/call', 4, {
        turn: 2, step: 1, callId: CallId('bad-plan'), name: 'exit_plan_mode',
        arguments: JSON.stringify({ plan: '# Rejected plan' }),
      }),
      event('tool/result', 5, {
        turn: 2, step: 1,
        message: createToolResultMessage({
          callId: CallId('bad-plan'), content: [{ type: 'text', text: 'Keep planning' }], isError: true,
        }),
      }),
      event('tool/call', 6, {
        turn: 2, step: 1, callId: CallId('background-child'), name: 'subagent',
        arguments: JSON.stringify({
          description: 'Background audit', prompt: 'Audit in the background.', run_in_background: true,
        }),
      }),
      event('tool/result', 7, {
        turn: 2, step: 1,
        message: createToolResultMessage({
          callId: CallId('background-child'),
          content: [{ type: 'text', text: 'started background subagent job job-7' }],
          isError: false,
        }),
      }),
      event('tool/call', 8, {
        turn: 2, step: 1, callId: CallId('continuable-child'), name: 'subagent',
        arguments: JSON.stringify({ description: 'Continuable audit', prompt: 'Audit as a continuable child.' }),
      }),
      event('tool/result', 9, {
        turn: 2, step: 1,
        message: createToolResultMessage({
          callId: CallId('continuable-child'),
          content: [{ type: 'text', text: 'started subagent child-session-9' }],
          isError: false,
        }),
      }),
    ]

    expect(projectNativeContinuity(events)).toEqual({
      approvedPlan: undefined,
      todos: [],
      delegatedOutcomes: [],
    })
  })

  it('freezes native state at the replacement boundary instead of following later events', () => {
    const events: SessionEvent[] = [
      event('turn/start', 1, { turn: 1 }),
      event('tool/call', 2, {
        turn: 1, step: 1, callId: CallId('plan-before'), name: 'exit_plan_mode',
        arguments: JSON.stringify({ plan: 'Approved before replacement.' }),
      }),
      event('tool/result', 3, {
        turn: 1, step: 1,
        message: createToolResultMessage({
          callId: CallId('plan-before'), content: [{ type: 'text', text: 'Plan approved' }], isError: false,
        }),
      }),
      event('todo/write', 4, { todos: [{ content: 'Boundary task', status: 'in_progress' }] }),
      event('turn/start', 5, { turn: 2 }),
      event('todo/write', 6, { todos: [{ content: 'Later visible task', status: 'in_progress' }] }),
      event('tool/call', 7, {
        turn: 2, step: 1, callId: CallId('child-after'), name: 'subagent',
        arguments: JSON.stringify({
          description: 'Later child', prompt: 'This result remains on the native surface.', run_in_background: false,
        }),
      }),
      event('tool/result', 8, {
        turn: 2, step: 1,
        message: createToolResultMessage({
          callId: CallId('child-after'), content: [{ type: 'text', text: 'Later child result' }], isError: false,
        }),
      }),
    ]

    expect(projectNativeContinuity(events, 4)).toEqual({
      approvedPlan: { callId: 'plan-before', plan: 'Approved before replacement.', resultSeq: 3 },
      todos: [{ content: 'Boundary task', status: 'in_progress' }],
      delegatedOutcomes: [],
    })
  })

  it('binds an approved plan to the assistant message that carried its native tool call', () => {
    const events: SessionEvent[] = [
      event('assistant/message', 1, {
        turn: 1,
        step: 1,
        message: createMessage({
          role: 'assistant',
          content: [{
            type: 'tool-call',
            id: CallId('approved-plan'),
            name: 'exit_plan_mode',
            arguments: JSON.stringify({ plan: 'Keep the exact approved plan.' }),
          }],
          source: { kind: 'model', provider: 'mock', model: 'mock' },
        }),
      }),
      event('tool/call', 2, {
        turn: 1, step: 1, callId: CallId('approved-plan'), name: 'exit_plan_mode',
        arguments: JSON.stringify({ plan: 'Keep the exact approved plan.' }),
      }),
      event('tool/result', 3, {
        turn: 1, step: 1,
        message: createToolResultMessage({
          callId: CallId('approved-plan'), content: [{ type: 'text', text: 'Plan approved' }], isError: false,
        }),
      }),
    ]

    expect(projectNativeContinuity(events).approvedPlan).toEqual({
      callId: 'approved-plan',
      messageSeq: 1,
      plan: 'Keep the exact approved plan.',
      resultSeq: 3,
    })
  })

  it('does not recover a previous task plan or Todo across a root-task boundary', () => {
    const events: SessionEvent[] = [
      event('tool/call', 1, {
        turn: 1, step: 1, callId: CallId('old-plan'), name: 'exit_plan_mode',
        arguments: JSON.stringify({ plan: 'Old task plan' }),
      }),
      event('tool/result', 2, {
        turn: 1, step: 1,
        message: createToolResultMessage({
          callId: CallId('old-plan'), content: [{ type: 'text', text: 'Plan approved' }], isError: false,
        }),
      }),
      event('todo/write', 3, { todos: [{ content: 'Old task', status: 'in_progress' }] }),
      event('turn/start', 10, { turn: 2 }),
      event('todo/write', 11, { todos: [{ content: 'Current task', status: 'in_progress' }] }),
    ]

    expect(projectNativeContinuity(events, Number.POSITIVE_INFINITY, 10)).toEqual({
      approvedPlan: undefined,
      todos: [{ content: 'Current task', status: 'in_progress' }],
      delegatedOutcomes: [],
    })
  })
})
