import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = join(process.cwd(), 'eval', 'router-corpus')
const v3 = join(root, 'v3')

function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex')
}

async function jsonLines<T>(path: string): Promise<{ text: string; rows: T[] }> {
  const text = await readFile(path, 'utf8')
  return { text, rows: text.trim().split('\n').map(line => JSON.parse(line) as T) }
}

describe('router v3 candidate freeze', () => {
  it('preserves the frozen router binding for the revealed bilingual candidate pool', async () => {
    const candidates = await jsonLines<{ id: string; language: 'en' | 'zh'; text: string }>(join(v3, 'candidates.jsonl'))
    const sources = await jsonLines<{ id: string; repository: string; url: string }>(join(v3, 'sources.jsonl'))
    const v1Sources = await jsonLines<{ repository: string }>(join(root, 'blind-real.sources.jsonl'))
    const v2Sources = await jsonLines<{ repository: string }>(join(root, 'v2', 'sources.jsonl'))
    const manifest = JSON.parse(await readFile(join(v3, 'candidate-manifest.json'), 'utf8')) as {
      counts: { total: number; english: number; chinese: number }
      routerSourceDigest: string
      digests: { candidates: string; sources: string }
    }
    const blindManifest = JSON.parse(await readFile(join(v3, 'blind-v3.manifest.json'), 'utf8')) as {
      routerSourceDigest: string
    }

    expect(candidates.rows).toHaveLength(240)
    expect(sources.rows).toHaveLength(240)
    expect(manifest.counts).toEqual({ total: 240, english: 120, chinese: 120 })
    expect(sha256(candidates.text)).toBe(manifest.digests.candidates)
    expect(sha256(sources.text)).toBe(manifest.digests.sources)
    expect(manifest.routerSourceDigest).toMatch(/^[a-f0-9]{64}$/)
    expect(manifest.routerSourceDigest).toBe(blindManifest.routerSourceDigest)
    expect(new Set(sources.rows.map(row => row.url)).size).toBe(240)

    const previousRepositories = new Set([
      ...v1Sources.rows.map(row => row.repository),
      ...v2Sources.rows.map(row => row.repository),
    ])
    expect(sources.rows.filter(row => previousRepositories.has(row.repository))).toEqual([])
    expect(candidates.rows.filter(row => /https?:\/\/\S/.test(row.text))).toEqual([])
    expect(candidates.rows.filter(row => /(?:sk|gh[opsu])-[A-Za-z0-9_-]{16,}/.test(row.text))).toEqual([])
    expect(candidates.rows.some(row => 'expected' in row || 'route' in row || 'sourceGroup' in row)).toBe(false)
  })
})
