import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = join(process.cwd(), 'eval', 'router-corpus')
const v2 = join(root, 'v2')

function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex')
}

async function jsonLines<T>(path: string): Promise<{ text: string; rows: T[] }> {
  const text = await readFile(path, 'utf8')
  return { text, rows: text.trim().split('\n').map(line => JSON.parse(line) as T) }
}

describe('router v2 candidate freeze', () => {
  it('retains the source-isolated 120/120 pool and evaluated router binding', async () => {
    const candidates = await jsonLines<{ id: string; language: 'en' | 'zh'; text: string }>(join(v2, 'candidates.jsonl'))
    const sources = await jsonLines<{ id: string; repository: string; url: string }>(join(v2, 'sources.jsonl'))
    const oldSources = await jsonLines<{ repository: string }>(join(root, 'blind-real.sources.jsonl'))
    const manifestText = await readFile(join(v2, 'candidate-manifest.json'), 'utf8')
    const manifest = JSON.parse(manifestText) as {
      counts: { total: number; english: number; chinese: number }
      routerSourceDigest: string
      digests: { candidates: string; sources: string }
    }
    const result = JSON.parse(await readFile(join(v2, 'blind-v2-results.json'), 'utf8')) as {
      routerSourceDigest: string
      releaseGatePassed: boolean
    }

    expect(candidates.rows).toHaveLength(240)
    expect(sources.rows).toHaveLength(240)
    expect(manifest.counts).toEqual({ total: 240, english: 120, chinese: 120 })
    expect(candidates.rows.filter(row => row.language === 'en')).toHaveLength(120)
    expect(candidates.rows.filter(row => row.language === 'zh')).toHaveLength(120)
    expect(new Set(candidates.rows.map(row => row.id)).size).toBe(240)
    expect(new Set(sources.rows.map(row => row.id))).toEqual(new Set(candidates.rows.map(row => row.id)))
    expect(new Set(sources.rows.map(row => row.url)).size).toBe(240)
    expect(sha256(candidates.text)).toBe(manifest.digests.candidates)
    expect(sha256(sources.text)).toBe(manifest.digests.sources)
    expect(result.routerSourceDigest).toBe(manifest.routerSourceDigest)
    expect(result.releaseGatePassed).toBe(false)

    const oldRepositories = new Set(oldSources.rows.map(row => row.repository))
    expect(sources.rows.filter(row => oldRepositories.has(row.repository))).toEqual([])
    expect(candidates.rows.filter(row => /https?:\/\/\S/.test(row.text))).toEqual([])
    expect(candidates.rows.filter(row => /(?:sk|gh[opsu])-[A-Za-z0-9_-]{16,}/.test(row.text))).toEqual([])
    expect(candidates.rows.some(row => 'expected' in row || 'route' in row || 'sourceGroup' in row)).toBe(false)
  })
})
