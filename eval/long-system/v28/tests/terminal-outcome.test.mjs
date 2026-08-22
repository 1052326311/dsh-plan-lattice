import assert from 'node:assert/strict'
import test from 'node:test'
import {
  isV28ScorableTerminal,
  validateV28Acknowledgement,
} from '../driver/support-plugin/index.js'
import { validateV28TerminalEchoes } from '../driver/evocode-runner.mjs'

test('scores completed and max-token stage terminals symmetrically', () => {
  assert.equal(isV28ScorableTerminal({ kind: 'completed' }), true)
  assert.equal(isV28ScorableTerminal({ kind: 'max-tokens' }), true)
  assert.equal(isV28ScorableTerminal({ kind: 'error' }), false)
  assert.equal(isV28ScorableTerminal(undefined), false)
})

test('accepts a budget terminal only through a receipt-backed host acknowledgement', () => {
  const stage = { id: 'round-3', kind: 'product', revision: 'revision-123' }
  const terminal = validateV28Acknowledgement(
    stage,
    { kind: 'error', error: { status: 429, code: 'RATE_LIMIT' } },
    {
      revision: stage.revision,
      decision: 'terminal',
      continue: false,
      effectiveTerminal: { kind: 'attempt-budget-exhausted' },
      receiptDigest: 'a'.repeat(64),
      budgetTerminalId: 'b'.repeat(64),
    },
  )
  assert.deepEqual(terminal, { kind: 'attempt-budget-exhausted' })

  assert.throws(() => validateV28Acknowledgement(stage, { kind: 'error' }, {
    revision: stage.revision,
    decision: 'terminal',
    continue: false,
    effectiveTerminal: { kind: 'attempt-budget-exhausted' },
    receiptDigest: 'a'.repeat(64),
    budgetTerminalId: null,
  }), /budget terminal identity/)
})

test('refuses to rewrite a generic error as max-tokens or continue it', () => {
  const stage = { id: 'round-1', kind: 'product', revision: 'revision-123' }
  assert.throws(() => validateV28Acknowledgement(stage, { kind: 'error' }, {
    revision: stage.revision,
    decision: 'terminal',
    continue: false,
    effectiveTerminal: { kind: 'max-tokens' },
    receiptDigest: 'a'.repeat(64),
  }), /rewrote a non-max-token/)
  assert.throws(() => validateV28Acknowledgement(stage, { kind: 'error' }, {
    revision: stage.revision,
    decision: 'continue',
    continue: true,
    effectiveTerminal: { kind: 'completed' },
    receiptDigest: 'a'.repeat(64),
  }), /inconsistent continuation/)
})

test('requires exactly one terminal echo for every terminal acknowledgement', () => {
  const decision = {
    epoch: 1,
    stageId: 'round-3',
    stageIndex: 2,
    kind: 'product',
    revision: 'revision-123',
    decision: 'terminal',
    effectiveTerminal: { kind: 'attempt-budget-exhausted' },
    receiptDigest: 'a'.repeat(64),
    budgetTerminalId: 'b'.repeat(64),
    sessionId: 'plan-lattice-v28-terminal-session',
  }
  const marker = {
    type: 'attempt-terminal',
    epoch: decision.epoch,
    stageId: decision.stageId,
    stageIndex: decision.stageIndex,
    kind: decision.kind,
    revision: decision.revision,
    terminalReason: decision.effectiveTerminal,
    receiptDigest: decision.receiptDigest,
    budgetTerminalId: decision.budgetTerminalId,
    sessionId: decision.sessionId,
  }
  assert.doesNotThrow(() => validateV28TerminalEchoes([decision], [marker]))
  assert.throws(() => validateV28TerminalEchoes([decision], []), /one-to-one/)
  assert.throws(() => validateV28TerminalEchoes([decision], [marker, marker]), /one-to-one/)
  assert.throws(() => validateV28TerminalEchoes([decision], [{ ...marker, receiptDigest: 'c'.repeat(64) }]), /receipt authority/)
  assert.throws(() => validateV28TerminalEchoes([decision], [{ ...marker, sessionId: 'wrong-session' }]), /receipt authority/)
  assert.throws(() => validateV28TerminalEchoes([decision], [{ ...marker, epoch: 2 }]), /receipt authority/)
})
