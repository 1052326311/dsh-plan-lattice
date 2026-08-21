import assert from 'node:assert/strict'
import test from 'node:test'
import { isV25ScorableTerminal } from '../driver/support-plugin/index.js'

test('scores completed and max-token stage terminals symmetrically', () => {
  assert.equal(isV25ScorableTerminal({ kind: 'completed' }), true)
  assert.equal(isV25ScorableTerminal({ kind: 'max-tokens' }), true)
  assert.equal(isV25ScorableTerminal({ kind: 'error' }), false)
  assert.equal(isV25ScorableTerminal(undefined), false)
})
