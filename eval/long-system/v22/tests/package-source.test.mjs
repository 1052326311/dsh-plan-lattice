import test from 'node:test'
import assert from 'node:assert/strict'
import { packageArchivePathsAtCommit } from '../driver/runtime.mjs'
import { CANDIDATE_COMMIT } from '../manifest.mjs'

test('candidate packaging reads only the commit-owned build and publication closure', () => {
  const paths = packageArchivePathsAtCommit(CANDIDATE_COMMIT)
  assert.deepEqual(paths, [...paths].sort())
  assert.equal(new Set(paths).size, paths.length)
  assert.ok(paths.includes('src'))
  assert.ok(paths.includes('tsconfig.json'))
  assert.ok(paths.includes('package.json'))
  assert.ok(paths.includes('pnpm-lock.yaml'))
  assert.ok(paths.includes('docs'))
  assert.ok(paths.includes('README.md'))
  assert.ok(paths.some(path => path.startsWith('demo/')))
  assert.ok(!paths.includes('lib'))
  assert.ok(paths.every(path => !/^(?:eval|test|prospective|scripts|\.github)(?:\/|$)/.test(path)))
})
