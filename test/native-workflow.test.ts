import { CallId, createToolResultMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { SessionEvent, TodoItem } from '@deepseek-ai/dsh-session/types'
import { describe, expect, it } from 'vitest'
import {
  nativeWorkflowMutationBlock,
  nativeWorkflowToolClass,
  projectNativeWorkflow,
  renderNativeWorkflowState,
  validateNativeTodoUpdate,
} from '../src/native-workflow.js'

function event<T extends SessionEvent['type']>(
  type: T,
  seq: number,
  data: Extract<SessionEvent, { type: T }>['data'],
): Extract<SessionEvent, { type: T }> {
  return { type, seq, time: seq, data } as Extract<SessionEvent, { type: T }>
}

function todo(seq: number, todos: TodoItem[]): SessionEvent<'todo/write'> {
  return event('todo/write', seq, { todos })
}

function call(
  seq: number,
  callId: string,
  name: string,
  arguments_: unknown,
  turn = 1,
  step = seq,
): SessionEvent<'tool/call'> {
  return event('tool/call', seq, {
    turn,
    step,
    callId: CallId(callId),
    name,
    arguments: JSON.stringify(arguments_),
  })
}

function result(
  seq: number,
  callId: string,
  text: string,
  options: {
    isError?: boolean
    nativeError?: boolean
    turn?: number
    step?: number
  } = {},
): SessionEvent<'tool/result'> {
  return event('tool/result', seq, {
    turn: options.turn ?? 1,
    step: options.step ?? seq - 1,
    message: createToolResultMessage({
      callId: CallId(callId),
      content: [{ type: 'text', text }],
      isError: options.isError ?? false,
    }),
    ...(options.nativeError ? { error: { name: 'ToolError', code: 'FAILED' } } : {}),
  })
}

const INITIAL: TodoItem[] = [
  { content: 'Implement workflow', status: 'in_progress' },
  { content: 'Verify behavior', status: 'pending' },
  { content: 'Render state', status: 'pending' },
]

const GUARDED = ['write', 'edit', 'str_replace_editor', 'bash', 'pwsh', 'deploy']

describe('native workflow projection', () => {
  it('commits todo/write only when the matching todo_write result succeeds', () => {
    const failedInitial = projectNativeWorkflow([
      call(1, 'todo-failed', 'todo_write', { todos: INITIAL }),
      todo(2, INITIAL),
      result(3, 'todo-failed', 'post-execute rejected Todo', { isError: true, step: 1 }),
    ], GUARDED)
    expect(failedInitial.todos).toEqual([])
    expect(failedInitial.todoSeq).toBeUndefined()
    expect(failedInitial.validationError).toMatch(/initial todo_write failed/i)

    const successful = projectNativeWorkflow([
      call(1, 'todo-ok', 'todo_write', { todos: INITIAL }),
      todo(2, INITIAL),
      result(3, 'todo-ok', 'Updated todo list', { step: 1 }),
    ], GUARDED)
    expect(successful.todos).toEqual([
      { ...INITIAL[0]!, activationSeq: 2 },
      INITIAL[1],
      INITIAL[2],
    ])
    expect(successful.validationError).toBeUndefined()
  })

  it('fails closed on a bare todo/write in strict production projection mode', () => {
    const projection = projectNativeWorkflow(
      [todo(1, INITIAL)],
      GUARDED,
      Number.POSITIVE_INFINITY,
      0,
      { requireSuccessfulTodoResult: true },
    )
    expect(projection.todos).toEqual([])
    expect(projection.todoSeq).toBeUndefined()
    expect(projection.validationError).toMatch(/no enclosing todo_write call/i)
    expect(nativeWorkflowMutationBlock(projection)).toMatch(/no enclosing todo_write call/i)
  })

  it('keeps the latest Todo across turns, records activation seq, and honors throughSeq', () => {
    const events: SessionEvent[] = [
      event('turn/start', 1, { turn: 1 }),
      todo(2, INITIAL),
      event('turn/end', 3, { turn: 1, reason: { kind: 'stop' } }),
      event('turn/start', 4, { turn: 2 }),
      call(5, 'read-1', 'read', { file_path: 'src/native-workflow.ts' }, 2, 1),
      result(6, 'read-1', 'source inspected', { turn: 2, step: 1 }),
    ]

    const atTurnBoundary = projectNativeWorkflow(events, GUARDED, 4)
    expect(atTurnBoundary.todos).toEqual([
      { ...INITIAL[0]!, activationSeq: 2 },
      INITIAL[1],
      INITIAL[2],
    ])
    expect(atTurnBoundary.evidence).toEqual([])
    expect(nativeWorkflowMutationBlock(atTurnBoundary)).toBeUndefined()

    const current = projectNativeWorkflow(events, GUARDED)
    expect(current.todoSeq).toBe(2)
    expect(current.evidence).toEqual([expect.objectContaining({
      kind: 'observation', toolName: 'read', callSeq: 5, resultSeq: 6,
      todoIndex: 0, activationSeq: 2,
    })])
    expect(renderNativeWorkflowState(current)).toContain('Todo (write seq 2)')
    expect(renderNativeWorkflowState(current)).toContain('observation: read call 5 -> result 6')
  })

  it('uses seq order and only unique, matching, successful call/result pairs as evidence', () => {
    const observational: TodoItem[] = [
      { content: 'Inspect workflow', status: 'in_progress' },
      { content: 'Verify behavior', status: 'pending' },
      { content: 'Render state', status: 'pending' },
    ]
    const events: SessionEvent[] = [
      result(4, 'late-call', 'cannot precede its call', { step: 5 }),
      call(5, 'late-call', 'read', { file_path: 'late.ts' }, 1, 5),
      call(1, 'pre-activation', 'read', { file_path: 'old.ts' }, 1, 1),
      todo(2, observational),
      result(3, 'pre-activation', 'read completed', { step: 1 }),
      call(6, 'failed-read', 'read', { file_path: 'failed.ts' }, 1, 6),
      result(7, 'failed-read', 'failed', { isError: true, step: 6 }),
      call(8, 'native-failed-read', 'read', { file_path: 'failed.ts' }, 1, 8),
      result(9, 'native-failed-read', 'failed', { nativeError: true, step: 8 }),
      call(10, 'wrong-step', 'read', { file_path: 'wrong.ts' }, 1, 10),
      result(11, 'wrong-step', 'wrong pair', { step: 11 }),
      call(12, 'duplicate', 'read', { file_path: 'one.ts' }, 1, 12),
      call(13, 'duplicate', 'read', { file_path: 'two.ts' }, 1, 13),
      result(14, 'duplicate', 'ambiguous', { step: 13 }),
      call(15, 'good-read', 'read', { file_path: 'good.ts' }, 1, 15),
      result(16, 'good-read', 'durable observation', { step: 15 }),
    ]

    const projection = projectNativeWorkflow(events, GUARDED)
    expect(projection.evidence.map(item => item.callId)).toEqual(['pre-activation', 'good-read'])
    expect(projection.evidence[0]).toMatchObject({ todoIndex: 0, activationSeq: 2, callSeq: 1 })
    expect(projection.evidence[1]).toMatchObject({ todoIndex: 0, activationSeq: 2 })
    expect(validateNativeTodoUpdate(projectNativeWorkflow(events, GUARDED, 14), [
      { content: 'Inspect workflow', status: 'completed' },
      { content: 'Verify behavior', status: 'in_progress' },
      { content: 'Render state', status: 'pending' },
    ])).toMatch(/requires observation or verification/i)
    expect(validateNativeTodoUpdate(projection, [
      { content: 'Inspect workflow', status: 'completed' },
      { content: 'Verify behavior', status: 'in_progress' },
      { content: 'Render state', status: 'pending' },
    ])).toBeUndefined()
  })

  it('requires verification to start after the last mutation settles, not merely commit later', () => {
    const events: SessionEvent[] = [
      todo(1, INITIAL),
      call(2, 'parallel-write', 'write', { file_path: 'a.ts', content: 'changed' }, 1, 2),
      call(3, 'parallel-test', 'bash', { command: 'pnpm test' }, 1, 2),
      result(4, 'parallel-write', 'write applied', { step: 2 }),
      result(5, 'parallel-test', '12 tests passed\n[exit code: 0]', { step: 2 }),
    ]
    const projection = projectNativeWorkflow(events, GUARDED)
    expect(projection.evidence.map(item => [item.kind, item.callSeq, item.resultSeq])).toEqual([
      ['mutation', 2, 4],
      ['verification', 3, 5],
    ])
    expect(validateNativeTodoUpdate(projection, [
      { content: 'Implement workflow', status: 'completed' },
      { content: 'Verify behavior', status: 'in_progress' },
      { content: 'Render state', status: 'pending' },
    ])).toMatch(/verification after the last mutation settled/i)

    const causallyVerified = projectNativeWorkflow([
      ...events.slice(0, 4),
      call(5, 'later-test', 'bash', { command: 'pnpm test' }, 1, 3),
      result(6, 'later-test', '12 tests passed\n[exit code: 0]', { step: 3 }),
    ], GUARDED)
    expect(validateNativeTodoUpdate(causallyVerified, [
      { content: 'Implement workflow', status: 'completed' },
      { content: 'Verify behavior', status: 'in_progress' },
      { content: 'Render state', status: 'pending' },
    ])).toBeUndefined()
  })

  it('scopes Todo and evidence to the exact current root-task boundary', () => {
    const events: SessionEvent[] = [
      todo(1, [
        { content: 'Implement stale task', status: 'completed' },
        { content: 'Verify stale task', status: 'completed' },
      ]),
      call(2, 'stale-write', 'write', { file_path: 'stale.ts', content: 'old' }, 1, 2),
      result(3, 'stale-write', 'wrote stale.ts', { step: 2 }),
      todo(10, INITIAL),
      call(11, 'current-write', 'write', { file_path: 'current.ts', content: 'new' }, 2, 1),
      result(12, 'current-write', 'wrote current.ts', { turn: 2, step: 1 }),
    ]

    const projection = projectNativeWorkflow(events, GUARDED, Number.POSITIVE_INFINITY, 10)
    expect(projection.todoSeq).toBe(10)
    expect(projection.todos.map(item => item.content)).toEqual(INITIAL.map(item => item.content))
    expect(projection.evidence.map(item => item.callId)).toEqual(['current-write'])
  })

  it('treats generic reads as observation and every unproven or delegated capability as mutation', () => {
    const events: SessionEvent[] = [
      todo(1, INITIAL),
      call(2, 'write-1', 'write', { file_path: 'a.ts', content: 'x' }, 1, 2),
      result(3, 'write-1', 'wrote a.ts', { step: 2 }),
      call(4, 'view-editor', 'str_replace_editor', { command: 'view', path: 'a.ts' }, 1, 4),
      result(5, 'view-editor', 'viewed a.ts', { step: 4 }),
      call(6, 'deploy-1', 'deploy', { target: 'staging' }, 1, 6),
      result(7, 'deploy-1', 'deployed', { step: 6 }),
      call(8, 'plain-subagent', 'subagent', {
        prompt: 'Implement the remaining behavior.', run_in_background: false,
      }, 1, 8),
      result(9, 'plain-subagent', 'implementation returned', { step: 8 }),
      call(10, 'audit-subagent', 'subagent', { prompt: 'Audit and review the implementation.' }, 1, 10),
      result(11, 'audit-subagent', 'audit returned', { step: 10 }),
      call(12, 'browser-1', 'browser', { url: 'http://localhost' }, 1, 12),
      result(13, 'browser-1', 'page rendered', { step: 12 }),
      call(14, 'fork-1', 'subagent_fork', {
        prompt: 'Implement the remaining module.', run_in_background: false,
      }, 1, 14),
      result(15, 'fork-1', 'implementation returned', { step: 14 }),
      call(16, 'fork-inspect', 'subagent_fork', { prompt: 'Inspect validation behavior.' }, 1, 16),
      result(17, 'fork-inspect', 'inspection returned', { step: 16 }),
    ]

    expect(projectNativeWorkflow(events, GUARDED).evidence.map(item => item.kind)).toEqual([
      'mutation', 'observation', 'mutation', 'mutation', 'mutation', 'mutation',
    ])
  })

  it('fails closed for unknown capabilities and multi-action DSH transports', () => {
    expect(nativeWorkflowToolClass('read', { file_path: 'a.ts' }, GUARDED)).toBe('read')
    expect(nativeWorkflowToolClass('verify_read', { target: 'a.ts' }, GUARDED)).toBe('mutation')
    expect(nativeWorkflowToolClass('read_and_write', { target: 'a.ts' }, GUARDED)).toBe('mutation')
    expect(nativeWorkflowToolClass('browser', { url: 'http://localhost' }, GUARDED)).toBe('mutation')
    expect(nativeWorkflowToolClass('custom_plugin_action', {}, GUARDED)).toBe('mutation')
    expect(nativeWorkflowToolClass('run_code', {}, GUARDED)).toBe('control')
    for (const name of ['terminal_send', 'workflow', 'ralph', 'schedule_create', 'cordis_run']) {
      expect(nativeWorkflowToolClass(name, {}, GUARDED)).toBe('unsupported')
    }
  })

  it('rejects shell and subagent execution that can outlive the observed tool result', () => {
    expect(nativeWorkflowToolClass('bash', { command: 'pnpm test', run_in_background: true }, GUARDED))
      .toBe('unsupported')
    expect(nativeWorkflowToolClass('subagent', {
      description: 'Implement module', prompt: 'Implement the current Todo.',
    }, GUARDED)).toBe('unsupported')
    expect(nativeWorkflowToolClass('subagent', {
      description: 'Implement module', prompt: 'Implement the current Todo.', run_in_background: true,
    }, GUARDED)).toBe('unsupported')
    expect(nativeWorkflowToolClass('subagent', {
      description: 'Implement module', prompt: 'Implement the current Todo.', run_in_background: false,
    }, GUARDED)).toBe('mutation')

    const historicalBackground = projectNativeWorkflow([
      todo(1, INITIAL),
      call(2, 'background-test', 'bash', { command: 'pnpm test', run_in_background: true }, 1, 2),
      result(3, 'background-test', '12 tests passed\n[exit code: 0]', { step: 2 }),
    ], GUARDED)
    expect(historicalBackground.evidence).toEqual([])
    expect(historicalBackground.replanRequired?.reason).toMatch(/unsupported background/i)
  })

  it('does not classify PowerShell readers with nested execution as observation', () => {
    expect(nativeWorkflowToolClass('pwsh', { command: 'Get-Content README.md' }, GUARDED)).toBe('read')
    expect(nativeWorkflowToolClass('pwsh', {
      command: 'Get-Content $(Set-Content changed.txt owned)',
    }, GUARDED)).toBe('mutation')
    expect(nativeWorkflowToolClass('pwsh', {
      command: 'Get-Content README.md; & ./mutate.ps1',
    }, GUARDED)).toBe('mutation')
  })
})

describe('native Todo lifecycle validation', () => {
  it('requires a valid ordered initial Todo before mutation', () => {
    const empty = projectNativeWorkflow([], GUARDED)
    expect(validateNativeTodoUpdate(empty, [INITIAL[0]!])).toMatch(/at least two/i)
    expect(validateNativeTodoUpdate(empty, [
      { content: 'Already done', status: 'completed' },
      { content: 'Next', status: 'in_progress' },
    ])).toMatch(/cannot contain completed/i)
    expect(validateNativeTodoUpdate(empty, [
      { content: 'Skipped', status: 'pending' },
      { content: 'Later', status: 'in_progress' },
    ])).toMatch(/before the in_progress item/i)
    expect(validateNativeTodoUpdate(empty, INITIAL)).toBeUndefined()
    expect(nativeWorkflowMutationBlock(empty)).toMatch(/initial Todo/i)

    const bypassed = projectNativeWorkflow([todo(1, [INITIAL[0]!])], GUARDED)
    expect(bypassed.validationError).toMatch(/at least two/i)
    expect(nativeWorkflowMutationBlock(bypassed)).toMatch(/at least two/i)
  })

  it('rejects status rollback, skipped activation, and pending-to-completed shortcuts', () => {
    const projection = projectNativeWorkflow([
      todo(1, INITIAL),
      call(2, 'edit-1', 'edit', { file_path: 'a.ts' }, 1, 2),
      result(3, 'edit-1', 'edited', { step: 2 }),
      call(4, 'verify-1', 'bash', { command: 'pnpm test' }, 1, 4),
      result(5, 'verify-1', '12 tests passed\nexit code 0', { step: 4 }),
      todo(6, [
        { content: 'Implement workflow', status: 'completed' },
        { content: 'Verify behavior', status: 'in_progress' },
        { content: 'Render state', status: 'pending' },
      ]),
    ], GUARDED)

    expect(projection.todos[1]).toMatchObject({ status: 'in_progress', activationSeq: 6 })
    expect(validateNativeTodoUpdate(projection, [
      { content: 'Implement workflow', status: 'in_progress' },
      { content: 'Verify behavior', status: 'pending' },
      { content: 'Render state', status: 'pending' },
    ])).toMatch(/completed.*cannot move back/i)
    expect(validateNativeTodoUpdate(projection, [
      { content: 'Implement workflow', status: 'completed' },
      { content: 'Verify behavior', status: 'completed' },
      { content: 'Render state', status: 'pending' },
    ])).toMatch(/exactly one in_progress/i)
    expect(validateNativeTodoUpdate(projection, [
      { content: 'Implement workflow', status: 'completed' },
      { content: 'Verify behavior', status: 'in_progress' },
      { content: 'Render state', status: 'completed' },
    ])).toMatch(/after the in_progress item/i)
  })

  it('requires evidence after activation and verification after the last mutation', () => {
    const base: SessionEvent[] = [
      todo(1, INITIAL),
      call(2, 'verify-before', 'bash', { command: 'pnpm test' }, 1, 2),
      result(3, 'verify-before', '12 tests passed\nexit code 0', { step: 2 }),
      call(4, 'edit-1', 'edit', { file_path: 'a.ts', old_string: 'a', new_string: 'b' }, 1, 4),
      result(5, 'edit-1', 'edited a.ts', { step: 4 }),
      call(6, 'observe-after', 'read', { file_path: 'a.ts' }, 1, 6),
      result(7, 'observe-after', 'observed edit', { step: 6 }),
    ]
    const completed: TodoItem[] = [
      { content: 'Implement workflow', status: 'completed' },
      { content: 'Verify behavior', status: 'in_progress' },
      { content: 'Render state', status: 'pending' },
    ]

    const unverified = projectNativeWorkflow(base, GUARDED)
    expect(validateNativeTodoUpdate(unverified, completed)).toMatch(/verification after the last mutation.*seq 5/i)

    const verified = projectNativeWorkflow([
      ...base,
      call(8, 'verify-after', 'bash', { command: 'pnpm test' }, 1, 8),
      result(9, 'verify-after', '12 tests passed\nexit code 0', { step: 8 }),
    ], GUARDED)
    expect(validateNativeTodoUpdate(verified, completed)).toBeUndefined()

    const mutatedAgain = projectNativeWorkflow([
      ...base,
      call(8, 'verify-after', 'bash', { command: 'pnpm test' }, 1, 8),
      result(9, 'verify-after', '12 tests passed\nexit code 0', { step: 8 }),
      call(10, 'write-after', 'write', { file_path: 'b.ts', content: 'new' }, 1, 10),
      result(11, 'write-after', 'wrote b.ts', { step: 10 }),
    ], GUARDED)
    expect(validateNativeTodoUpdate(mutatedAgain, completed)).toMatch(/last mutation.*seq 11/i)
  })

  it('treats an implementation child as mutation until the parent records later verification', () => {
    const implemented: SessionEvent[] = [
      todo(1, INITIAL),
      call(2, 'child-implement', 'subagent_fork', {
        prompt: 'Implement the workflow module.', run_in_background: false,
      }, 1, 2),
      result(3, 'child-implement', 'Implemented the requested module.', { step: 2 }),
      call(4, 'parent-read', 'read', { file_path: 'src/native-workflow.ts' }, 1, 4),
      result(5, 'parent-read', 'Parent inspected the file.', { step: 4 }),
    ]
    const completed: TodoItem[] = [
      { content: 'Implement workflow', status: 'completed' },
      { content: 'Verify behavior', status: 'in_progress' },
      { content: 'Render state', status: 'pending' },
    ]
    expect(validateNativeTodoUpdate(projectNativeWorkflow(implemented, GUARDED), completed))
      .toMatch(/verification after the last mutation.*seq 3/i)

    const parentVerified = projectNativeWorkflow([
      ...implemented,
      call(6, 'parent-test', 'bash', { command: 'pnpm test' }, 1, 6),
      result(7, 'parent-test', '12 tests passed\nexit code 0', { step: 6 }),
    ], GUARDED)
    expect(validateNativeTodoUpdate(parentVerified, completed)).toBeUndefined()
  })

  it('allows all-completed only as the final normal progression', () => {
    const events: SessionEvent[] = [
      todo(1, [
        { content: 'Inspect first', status: 'in_progress' },
        { content: 'Inspect last', status: 'pending' },
      ]),
      call(2, 'read-first', 'read', { file_path: 'first.ts' }, 1, 2),
      result(3, 'read-first', 'observed first', { step: 2 }),
      todo(4, [
        { content: 'Inspect first', status: 'completed' },
        { content: 'Inspect last', status: 'in_progress' },
      ]),
      call(5, 'read-last', 'read', { file_path: 'last.ts' }, 1, 5),
      result(6, 'read-last', 'observed last', { step: 5 }),
    ]
    const projection = projectNativeWorkflow(events, GUARDED)
    expect(validateNativeTodoUpdate(projection, [
      { content: 'Inspect first', status: 'completed' },
      { content: 'Inspect last', status: 'completed' },
    ])).toBeUndefined()
  })

  it.each([
    'Inspect and implement persistence',
    '检查并修复持久化逻辑',
  ])('does not let a mixed observation and mutation Todo complete from a read: %s', content => {
    const projection = projectNativeWorkflow([
      todo(1, [
        { content, status: 'in_progress' },
        { content: 'Verify the final behavior', status: 'pending' },
      ]),
      call(2, 'mixed-read', 'read', { file_path: 'store.ts' }, 1, 2),
      result(3, 'mixed-read', 'source inspected', { step: 2 }),
    ], GUARDED)
    expect(validateNativeTodoUpdate(projection, [
      { content, status: 'completed' },
      { content: 'Verify the final behavior', status: 'in_progress' },
    ])).toMatch(/requires concrete mutation evidence/i)
  })

  it('does not accept a generic subagent audit as post-mutation verification', () => {
    const projection = projectNativeWorkflow([
      todo(1, INITIAL),
      call(2, 'edit', 'write', { file_path: 'a.ts', content: 'changed' }, 1, 2),
      result(3, 'edit', 'write applied', { step: 2 }),
      call(4, 'audit', 'subagent', {
        prompt: 'Verify and audit the change.', run_in_background: false,
      }, 1, 4),
      result(5, 'audit', 'Everything looks correct.', { step: 4 }),
    ], GUARDED)
    expect(validateNativeTodoUpdate(projection, [
      { content: 'Implement workflow', status: 'completed' },
      { content: 'Verify behavior', status: 'in_progress' },
      { content: 'Render state', status: 'pending' },
    ])).toMatch(/verification after the last mutation.*seq 5/i)
  })
})

describe('shell verification evidence', () => {
  it('accepts successful Node TAP output whose summary contains fail 0', () => {
    const projection = projectNativeWorkflow([
      todo(1, INITIAL),
      call(2, 'node-tap', 'bash', { command: 'node --test .v23-shell-probe.test.mjs' }, 1, 2),
      result(3, 'node-tap', [
        'TAP version 13',
        '# Subtest: V23 real Bash execution',
        'ok 1 - V23 real Bash execution',
        '1..1',
        '# tests 1',
        '# pass 1',
        '# fail 0',
        '# cancelled 0',
      ].join('\n'), { step: 2 }),
    ], GUARDED)

    expect(projection.replanRequired).toBeUndefined()
    expect(projection.evidence.map(item => [item.callId, item.kind])).toEqual([
      ['node-tap', 'verification'],
    ])
  })

  it('does not trust isError=false when durable shell text reports exit code 1', () => {
    const projection = projectNativeWorkflow([
      todo(1, INITIAL),
      call(2, 'bad-test', 'bash', { command: 'pnpm exec vitest run test/native-workflow.test.ts' }, 1, 2),
      result(3, 'bad-test', 'Tests: 4 passed\nProcess exited with code 1', { step: 2 }),
    ], GUARDED)
    expect(projection.evidence).toEqual([])
    expect(validateNativeTodoUpdate(projection, [
      { content: 'Implement workflow', status: 'completed' },
      { content: 'Verify behavior', status: 'in_progress' },
      { content: 'Render state', status: 'pending' },
    ])).toMatch(/replan required.*non-zero/i)
  })

  it('withholds verification for ambiguous or failed shell output and accepts reliable success', () => {
    const events: SessionEvent[] = [
      todo(1, INITIAL),
      call(2, 'ambiguous-test', 'bash', { command: 'npm run typecheck' }, 1, 2),
      result(3, 'ambiguous-test', 'command completed', { step: 2 }),
      call(4, 'failed-test', 'bash', { command: 'pytest -q' }, 1, 4),
      result(5, 'failed-test', '1 failed, 8 passed\nexit code 0', { step: 4 }),
      call(6, 'good-test', 'bash', { command: 'cargo test' }, 1, 6),
      result(7, 'good-test', 'test result: ok. 8 passed; 0 failed\nexit code 0', { step: 6 }),
      call(8, 'readonly-shell', 'bash', { command: 'rg -n TODO src' }, 1, 8),
      result(9, 'readonly-shell', 'src/a.ts:1:TODO', { step: 8 }),
    ]
    expect(projectNativeWorkflow(events, GUARDED).evidence.map(item => [item.callId, item.kind])).toEqual([
      ['good-test', 'verification'],
      ['readonly-shell', 'observation'],
    ])
  })

  it('folds nested rc.7 Code Mode dispatches as native mutation and verification evidence', () => {
    const events: SessionEvent[] = [
      todo(1, INITIAL),
      event('tool/code-dispatch-start', 2, {
        rootCallId: CallId('outer-code'), parentCallId: CallId('outer-code'),
        subCallId: CallId('outer-code:code:1'), name: 'write',
        arguments: { file_path: 'a.ts', content: 'changed' },
      }),
      event('tool/code-dispatch', 3, {
        rootCallId: CallId('outer-code'), parentCallId: CallId('outer-code'),
        subCallId: CallId('outer-code:code:1'), name: 'write',
        arguments: { file_path: 'a.ts', content: 'changed' },
        isError: false, content: [{ type: 'text', text: 'write applied' }],
      }),
      event('tool/code-dispatch-start', 4, {
        rootCallId: CallId('outer-code'), parentCallId: CallId('outer-code'),
        subCallId: CallId('outer-code:code:2'), name: 'bash', arguments: { command: 'pnpm test' },
      }),
      event('tool/code-dispatch', 5, {
        rootCallId: CallId('outer-code'), parentCallId: CallId('outer-code'),
        subCallId: CallId('outer-code:code:2'), name: 'bash', arguments: { command: 'pnpm test' },
        isError: false, content: [{ type: 'text', text: '12 tests passed\nexit code 0' }],
      }),
    ]
    expect(projectNativeWorkflow(events, GUARDED).evidence.map(item => [item.callId, item.kind])).toEqual([
      ['outer-code:code:1', 'mutation'],
      ['outer-code:code:2', 'verification'],
    ])
  })
})

describe('native Todo replanning', () => {
  const completedFirst: TodoItem[] = [
    { content: 'Implement workflow', status: 'completed' },
    { content: 'Verify behavior', status: 'in_progress' },
    { content: 'Render state', status: 'pending' },
  ]

  function beforeReplan(): SessionEvent[] {
    return [
      todo(1, INITIAL),
      call(2, 'write-first', 'write', { file_path: 'a.ts', content: 'implemented' }, 1, 2),
      result(3, 'write-first', 'wrote a.ts', { step: 2 }),
      call(4, 'verify-first', 'bash', { command: 'pnpm test' }, 1, 4),
      result(5, 'verify-first', '12 tests passed\nexit code 0', { step: 4 }),
      todo(6, completedFirst),
      call(7, 'refresh-1', 'lattice_refresh_context', {}, 1, 7),
      result(8, 'refresh-1', 'context refreshed', { step: 7 }),
    ]
  }

  it('requires a fresh successful refresh and carries forward only prior completions', () => {
    const withoutRefresh = projectNativeWorkflow(beforeReplan(), GUARDED, 6)
    expect(validateNativeTodoUpdate(withoutRefresh, [
      { content: 'Implement workflow', status: 'completed' },
      { content: 'New verification', status: 'in_progress' },
    ])).toMatch(/lattice_refresh_context/i)

    const refreshed = projectNativeWorkflow(beforeReplan(), GUARDED)
    expect(refreshed.replanRefreshSeq).toBe(8)
    expect(validateNativeTodoUpdate(refreshed, [
      { content: 'Implement workflow', status: 'completed' },
      { content: 'New verification', status: 'in_progress' },
    ])).toBeUndefined()
    expect(validateNativeTodoUpdate(refreshed, [
      { content: 'New completed claim', status: 'completed' },
      { content: 'New verification', status: 'in_progress' },
    ])).toMatch(/preserve completed Todo prefix/i)
    expect(validateNativeTodoUpdate(refreshed, [
      { content: 'Implement workflow', status: 'completed' },
      { content: 'New completed claim', status: 'completed' },
    ])).toMatch(/cannot make every Todo item completed/i)
  })

  it('consumes refresh on the next todo/write and gives the replanned active item a new activation seq', () => {
    const replanned: TodoItem[] = [
      { content: 'Implement workflow', status: 'completed' },
      { content: 'New verification', status: 'in_progress' },
    ]
    const projection = projectNativeWorkflow([
      ...beforeReplan(),
      todo(9, replanned),
    ], GUARDED)
    expect(projection.replanRefreshSeq).toBeUndefined()
    expect(projection.todos[1]).toMatchObject({ content: 'New verification', activationSeq: 9 })
    expect(validateNativeTodoUpdate(projection, [
      { content: 'Implement workflow', status: 'completed' },
      { content: 'Another plan', status: 'in_progress' },
    ])).toMatch(/lattice_refresh_context/i)
  })

  it('does not carry refresh across an intervening normal write or a call started before that write', () => {
    const consumedByNormalWrite = projectNativeWorkflow([
      ...beforeReplan(),
      todo(9, completedFirst),
    ], GUARDED)
    expect(consumedByNormalWrite.replanRefreshSeq).toBeUndefined()

    const crossedWrite = projectNativeWorkflow([
      todo(1, INITIAL),
      call(2, 'early-refresh', 'lattice_refresh_context', {}, 1, 2),
      todo(3, INITIAL),
      result(4, 'early-refresh', 'context refreshed', { step: 2 }),
    ], GUARDED)
    expect(crossedWrite.replanRefreshSeq).toBeUndefined()

    const failedRefresh = projectNativeWorkflow([
      todo(1, INITIAL),
      call(2, 'failed-refresh', 'lattice_refresh_context', {}, 1, 2),
      result(3, 'failed-refresh', 'refresh failed', { isError: true, step: 2 }),
    ], GUARDED)
    expect(failedRefresh.replanRefreshSeq).toBeUndefined()
  })

  it('persists replan debt after a failed mutation until exact authority is refreshed and Todo is rewritten', () => {
    const failed = projectNativeWorkflow([
      todo(1, INITIAL),
      call(2, 'failed-write', 'write', { file_path: 'a.ts', content: 'x' }, 1, 2),
      result(3, 'failed-write', 'permission denied', { isError: true, step: 2 }),
    ], GUARDED)
    expect(failed.replanRequired).toMatchObject({ seq: 3 })
    expect(nativeWorkflowMutationBlock(failed)).toMatch(/replan required/i)
    expect(validateNativeTodoUpdate(failed, INITIAL)).toMatch(/lattice_refresh_context/i)

    const refreshed = projectNativeWorkflow([
      todo(1, INITIAL),
      call(2, 'failed-write', 'write', { file_path: 'a.ts', content: 'x' }, 1, 2),
      result(3, 'failed-write', 'permission denied', { isError: true, step: 2 }),
      call(4, 'refresh', 'lattice_refresh_context', {}, 1, 4),
      result(5, 'refresh', 'context refreshed', { step: 4 }),
    ], GUARDED)
    expect(validateNativeTodoUpdate(refreshed, INITIAL)).toBeUndefined()

    const reaffirmed = projectNativeWorkflow([
      todo(1, INITIAL),
      call(2, 'failed-write', 'write', { file_path: 'a.ts', content: 'x' }, 1, 2),
      result(3, 'failed-write', 'permission denied', { isError: true, step: 2 }),
      call(4, 'refresh', 'lattice_refresh_context', {}, 1, 4),
      result(5, 'refresh', 'context refreshed', { step: 4 }),
      todo(6, INITIAL),
    ], GUARDED)
    expect(reaffirmed.replanRequired).toBeUndefined()
    expect(reaffirmed.replanRefreshSeq).toBeUndefined()
    expect(nativeWorkflowMutationBlock(reaffirmed)).toBeUndefined()
  })

  it('treats an answer returned by the native question tool as replan authority', () => {
    const answered = projectNativeWorkflow([
      todo(1, INITIAL),
      call(2, 'question-1', 'ask_user_question', { questions: [{ question: 'Database?' }] }, 1, 2),
      result(3, 'question-1', 'Use PostgreSQL and retain audit history.', { step: 2 }),
    ], GUARDED)

    expect(answered.replanRequired?.reason).toMatch(/new human authority/i)
    expect(answered.evidence).toEqual([expect.objectContaining({
      kind: 'observation', toolName: 'ask_user_question', result: 'Use PostgreSQL and retain audit history.',
    })])
    expect(nativeWorkflowMutationBlock(answered)).toMatch(/replan required/i)
  })

  it('requires replanning after later human input and preserves the completed prefix exactly', () => {
    const request = createUserMessage({
      content: [{ type: 'text', text: 'The accepted source of truth has changed.' }],
      source: { kind: 'user' },
    })
    const projection = projectNativeWorkflow([
      ...beforeReplan().slice(0, -2),
      event('user/message', 7, request),
      call(8, 'refresh-after-user', 'lattice_refresh_context', {}, 1, 8),
      result(9, 'refresh-after-user', 'context refreshed', { step: 8 }),
    ], GUARDED)
    expect(projection.replanRequired).toMatchObject({ seq: 7 })
    expect(validateNativeTodoUpdate(projection, [
      { content: 'Verify behavior', status: 'in_progress' },
      { content: 'Render state', status: 'pending' },
    ])).toMatch(/preserve completed Todo prefix/i)
    expect(validateNativeTodoUpdate(projection, [
      { content: 'Renamed completed work', status: 'completed' },
      { content: 'Verify changed behavior', status: 'in_progress' },
    ])).toMatch(/preserve completed Todo prefix/i)
    expect(validateNativeTodoUpdate(projection, [
      { content: 'Implement workflow', status: 'completed' },
      { content: 'Verify changed behavior', status: 'in_progress' },
      { content: 'Render changed state', status: 'pending' },
    ])).toBeUndefined()
  })
})
