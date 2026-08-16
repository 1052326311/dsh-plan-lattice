import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'

const root = join(process.cwd(), 'eval/router-corpus/v10')

async function collector() {
  return import(`${pathToFileURL(join(root, 'collect-source-frame.mjs')).href}?t=${Date.now()}`)
}

describe('V10 global source-frame collector', () => {
  it('freezes source searches without exposing the selection seed', async () => {
    const spec = JSON.parse(await readFile(join(root, 'source-frame-spec.json'), 'utf8'))
    const source = await readFile(join(root, 'collect-source-frame.mjs'), 'utf8')
    expect(spec.protocol).toBe('observable-authorization-v10')
    expect(spec.selectionSeedAccess).toBe('forbidden-during-source-frame-collection')
    expect(spec.searches.length).toBeGreaterThanOrEqual(40)
    expect(spec.searches.every((search: { query: string }) => search.query.includes('updated:<=2026-08-15'))).toBe(true)
    expect(source).not.toMatch(/v10-selection-seed|seed-file/i)
  })

  it('uses native-language gates rather than translated variants', async () => {
    const module = await collector()
    const spec = JSON.parse(await readFile(join(root, 'source-frame-spec.json'), 'utf8'))
    expect(module.languageMatches('Please update the parser and preserve every existing fallback behavior in the current implementation.', 'en', spec)).toBe(true)
    expect(module.languageMatches('请更新当前解析器实现，并且保留所有已经存在的回退行为、兼容逻辑、错误处理、配置读取和聚焦回归测试。', 'zh', spec)).toBe(true)
    expect(module.languageMatches('Please update 当前解析器实现 and preserve fallback behavior.', 'en', spec)).toBe(false)
  })

  it('distinguishes mutation requests, unresolved choices, and repository contingencies', async () => {
    const module = await collector()
    expect(module.actionRequest('Please replace the stale branch and add the focused regression test.', 'en')).toBe(true)
    expect(module.actionRequest('请修改这个配置并添加回归测试。', 'zh')).toBe(true)
    expect(module.unresolvedQuestion('Should we preserve the old provider or migrate every caller?', 'en')).toBe(true)
    expect(module.unresolvedQuestion('这里应该保留旧配置还是全部迁移？', 'zh')).toBe(true)
    expect(module.repositoryContingent('If `src/config.ts` already stores the normalized value, keep it; otherwise update the existing config.', 'en')).toBe(true)
    expect(module.repositoryContingent('如果当前配置文件已经包含该字段就保留，否则修改 `config.yaml`。', 'zh')).toBe(true)
  })

  it('accepts inline review feedback as a continuity boundary', async () => {
    const module = await collector()
    const feedback = module.feedbackItems([], [{
      node_id: 'inline-1',
      html_url: 'https://github.com/new-org/new-repo/pull/1#discussion_r1',
      body: 'Please replace this stale branch and add the exact regression test.',
      created_at: '2026-08-10T00:00:00Z',
      updated_at: '2026-08-10T00:00:00Z',
      commit_id: 'a'.repeat(40),
      author_association: 'MEMBER',
      user: { login: 'maintainer', type: 'User' },
      path: 'src/parser.ts',
      diff_hunk: '@@ parser branch @@',
    }], new Set(['MEMBER']), 'en')
    expect(feedback).toHaveLength(1)
    expect(feedback[0].kind).toBe('inline-review')
    expect(feedback[0].path).toBe('src/parser.ts')
  })

  it('extends source isolation through every V9 artifact', async () => {
    const isolation = await import(`${pathToFileURL(join(root, 'source-isolation.mjs')).href}?t=${Date.now()}`)
    const inventory = await isolation.priorSourceInventory()
    expect(inventory.versions.v9).toBeGreaterThan(0)
    expect(inventory.repositories).toContain('preactjs/preact')
  })
})
