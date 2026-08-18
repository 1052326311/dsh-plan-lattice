import assert from 'node:assert/strict'
import test from 'node:test'
import { recoverableHarnessTerminal } from '../../pilots/driver/lib/runtime.mjs'

test('pilot recovery accepts only preregistered durable terminal reasons', () => {
  assert.equal(recoverableHarnessTerminal({
    kind: 'error', error: { code: 'STREAM_CLOSED', message: 'stream ended' },
  }), 'stream_closed')
  assert.equal(recoverableHarnessTerminal({ kind: 'interrupted' }), 'interrupted')
  assert.equal(recoverableHarnessTerminal({
    kind: 'error', error: { code: 'HTTP_429', message: 'rate limited' },
  }), undefined)
  assert.equal(recoverableHarnessTerminal({ kind: 'completed' }), undefined)
  assert.equal(recoverableHarnessTerminal(undefined), undefined)
})
