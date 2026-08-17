import { describe, expect, it } from 'vitest'
import { digestGitPaths, resolveCommit } from '../prospective/model-rc4-study/integrity.mjs'

describe('RC.4 model execution Git integrity', () => {
  it('hashes exact Git objects instead of mutable working-tree files', () => {
    const commit = resolveCommit('0414dfa5035e6ca5cdc511964883b64be62ad44e', 'test base')
    const first = digestGitPaths(commit, ['eval/v0.4/benchmark-lock.json', 'eval/v0.4/simple-tasks.json'])
    const second = digestGitPaths(commit, ['eval/v0.4/simple-tasks.json', 'eval/v0.4/benchmark-lock.json'])
    expect(first).toEqual(second)
    expect(first.files).toEqual([
      'eval/v0.4/benchmark-lock.json',
      'eval/v0.4/simple-tasks.json',
    ])
    expect(first.digest).toMatch(/^[a-f0-9]{64}$/u)
  })

  it('expands frozen glob selectors without passing unsupported magic to ls-tree', () => {
    const result = digestGitPaths('HEAD', [':(glob)test/model-rc4-*.test.ts'])
    expect(result.files).toContain('test/model-rc4-integrity.test.ts')
    expect(result.files.every(path => /^test\/model-rc4-.*\.test\.ts$/u.test(path))).toBe(true)
  })
})
