import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = join(process.cwd(), 'eval', 'router-corpus', 'v3')
const sha256 = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex')

async function jsonLines<T>(name: string): Promise<{ text: string; rows: T[] }> {
  const text = await readFile(join(root, name), 'utf8')
  return { text, rows: text.trim().split('\n').map(line => JSON.parse(line) as T) }
}

describe('router v3 long-program supplement', () => {
  it('binds disjoint sources to a 60/60 bilingual candidate set', async () => {
    const raw = await jsonLines<{ id: string; text: string }>('supplement-raw.jsonl')
    const input = await jsonLines<{ id: string; text: string }>('supplement-translation-input.jsonl')
    const translations = await jsonLines<{ id: string; text: string }>('supplement-translations-zh.jsonl')
    const english = await jsonLines<{ id: string; language: string; text: string }>('supplement-english.jsonl')
    const candidates = await jsonLines<{ id: string; language: string; text: string }>('supplement-candidates.jsonl')
    const sources = await jsonLines<{ id: string; url: string }>('supplement-source-records.jsonl')
    const manifest = JSON.parse(await readFile(join(root, 'supplement-manifest.json'), 'utf8')) as {
      routerSourceDigest: string
      counts: Record<string, number>
      digests: Record<string, string>
    }
    const blindManifest = JSON.parse(await readFile(join(root, 'blind-v3.manifest.json'), 'utf8')) as {
      routerSourceDigest: string
    }

    expect(raw.rows).toHaveLength(120)
    expect(input.rows).toHaveLength(60)
    expect(translations.rows).toHaveLength(60)
    expect(english.rows).toHaveLength(60)
    expect(candidates.rows).toHaveLength(120)
    expect(sources.rows).toHaveLength(120)
    expect(candidates.rows.filter(row => row.language === 'en')).toHaveLength(60)
    expect(candidates.rows.filter(row => row.language === 'zh')).toHaveLength(60)
    expect(new Set(sources.rows.map(row => row.url)).size).toBe(120)
    expect(input.rows.map(row => row.id)).toEqual(translations.rows.map(row => row.id))
    expect(translations.rows.some((row, index) => row.text === input.rows[index].text)).toBe(false)
    expect(translations.rows.every(row => /[\u3400-\u9fff]/u.test(row.text))).toBe(true)
    expect(manifest.counts).toEqual({ total: 120, english: 60, chineseTranslation: 60 })
    expect(sha256(raw.text)).toBe(manifest.digests.raw)
    expect(sha256(input.text)).toBe(manifest.digests.translationInput)
    expect(sha256(english.text)).toBe(manifest.digests.englishCandidates)
    expect(manifest.routerSourceDigest).toMatch(/^[a-f0-9]{64}$/)
    expect(manifest.routerSourceDigest).toBe(blindManifest.routerSourceDigest)
  })
})
