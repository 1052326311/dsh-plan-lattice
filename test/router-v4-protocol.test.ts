import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex')
}

async function jsonLines(path: string): Promise<Record<string, unknown>[]> {
  const text = await readFile(path, 'utf8')
  return text.trim().split('\n').filter(Boolean).map(line => JSON.parse(line) as Record<string, unknown>)
}

describe('source-disjoint V4 router protocol', () => {
  const root = process.cwd()
  const v4 = join(root, 'eval/router-corpus/v4')

  it('freezes 240 balanced real-source candidates after the router code freeze', async () => {
    const [candidatesText, sourcesText, manifestText] = await Promise.all([
      readFile(join(v4, 'candidates.jsonl'), 'utf8'),
      readFile(join(v4, 'sources.jsonl'), 'utf8'),
      readFile(join(v4, 'candidate-manifest.json'), 'utf8'),
    ])
    const candidates = candidatesText.trim().split('\n').map(line => JSON.parse(line) as { id: string; language: string })
    const sources = sourcesText.trim().split('\n').map(line => JSON.parse(line) as { id: string; repository: string; url: string })
    const manifest = JSON.parse(manifestText) as {
      codeFreezeCommit: string
      runtimeDigest: string
      counts: { total: number; english: number; chinese: number }
      sourceIsolation: { overlappingRepositories: string[]; overlappingUrls: string[] }
      digests: { candidates: string; sources: string }
    }
    expect(candidates).toHaveLength(240)
    expect(sources).toHaveLength(240)
    expect(new Set(candidates.map(row => row.id)).size).toBe(240)
    expect(new Set(sources.map(row => row.url)).size).toBe(240)
    expect(candidates.filter(row => row.language === 'en')).toHaveLength(120)
    expect(candidates.filter(row => row.language === 'zh')).toHaveLength(120)
    expect(manifest.counts).toEqual({ total: 240, english: 120, chinese: 120 })
    expect(manifest.codeFreezeCommit).toBe('97ba3b3fe2dc9d72453735900e73c6f03bf8dd7c')
    expect(manifest.digests.candidates).toBe(sha256(candidatesText))
    expect(manifest.digests.sources).toBe(sha256(sourcesText))
    expect(manifest.sourceIsolation.overlappingRepositories).toEqual([])
    expect(manifest.sourceIsolation.overlappingUrls).toEqual([])

    const runtimeFiles = ['src/router.ts', 'src/task-invariants.ts', 'src/router-classifier.ts', 'src/router-model.ts']
    const runtimeBodies = await Promise.all(runtimeFiles.map(path => readFile(join(root, path))))
    expect(manifest.runtimeDigest).toBe(sha256(runtimeBodies.map(body => sha256(body)).join('\n')))
  })

  it('shares no repository or issue URL with any revealed development corpus', async () => {
    const current = await jsonLines(join(v4, 'sources.jsonl'))
    const prior = (await Promise.all([
      'eval/router-corpus/blind-real.sources.jsonl',
      'eval/router-corpus/v2/sources.jsonl',
      'eval/router-corpus/v3/sources.jsonl',
      'eval/router-corpus/v3/supplement-source-records.jsonl',
    ].map(path => jsonLines(join(root, path))))).flat()
    const priorRepositories = new Set(prior.map(row => String(row.repository).toLowerCase()))
    const priorUrls = new Set(prior.map(row => String(row.url)))
    expect(current.filter(row => priorRepositories.has(String(row.repository).toLowerCase()))).toEqual([])
    expect(current.filter(row => priorUrls.has(String(row.url)))).toEqual([])
  })

  it('freezes a separate bilingual long-program supplement without source reuse', async () => {
    const [raw, english, translationInput, translations, assembled, supplementSources, manifestText] = await Promise.all([
      jsonLines(join(v4, 'supplement-raw.jsonl')),
      jsonLines(join(v4, 'supplement-english.jsonl')),
      jsonLines(join(v4, 'supplement-translation-input.jsonl')),
      jsonLines(join(v4, 'supplement-translations-zh.jsonl')),
      jsonLines(join(v4, 'supplement-candidates.jsonl')),
      jsonLines(join(v4, 'supplement-source-records.jsonl')),
      readFile(join(v4, 'supplement-manifest.json'), 'utf8'),
    ])
    const manifest = JSON.parse(manifestText) as {
      codeFreezeCommit: string
      runtimeDigest: string
      counts: { total: number; english: number; chineseTranslation: number }
      sourceIsolation: { overlappingRepositories: string[]; overlappingUrls: string[] }
    }
    expect(raw).toHaveLength(120)
    expect(english).toHaveLength(60)
    expect(translationInput).toHaveLength(60)
    expect(translations).toHaveLength(60)
    expect(assembled).toHaveLength(120)
    expect(supplementSources).toHaveLength(120)
    expect(new Set([...english, ...translationInput].map(row => row.id)).size).toBe(120)
    expect(translations.map(row => row.id)).toEqual(translationInput.map(row => row.id))
    expect(translations.every((row, index) => row.text !== translationInput[index]?.text)).toBe(true)
    expect(assembled.filter(row => row.language === 'en')).toHaveLength(60)
    expect(assembled.filter(row => row.language === 'zh')).toHaveLength(60)
    expect(manifest.counts).toEqual({ total: 120, english: 60, chineseTranslation: 60 })
    expect(manifest.codeFreezeCommit).toBe('97ba3b3fe2dc9d72453735900e73c6f03bf8dd7c')
    expect(manifest.sourceIsolation.overlappingRepositories).toEqual([])
    expect(manifest.sourceIsolation.overlappingUrls).toEqual([])

    const baseSources = await jsonLines(join(v4, 'sources.jsonl'))
    const usedRepositories = new Set(baseSources.map(row => String(row.repository).toLowerCase()))
    const usedUrls = new Set(baseSources.map(row => String(row.url)))
    expect(supplementSources.filter(row => usedRepositories.has(String(row.repository).toLowerCase()))).toEqual([])
    expect(supplementSources.filter(row => usedUrls.has(String(row.url)))).toEqual([])
  })

  it('preserves the first V4 reveal as a failed release gate', async () => {
    const [promptsText, labelsText, sourcesText, manifestText, resultsText] = await Promise.all([
      readFile(join(v4, 'blind-v4.prompts.jsonl'), 'utf8'),
      readFile(join(v4, 'blind-v4.labels.jsonl'), 'utf8'),
      readFile(join(v4, 'blind-v4.sources.jsonl'), 'utf8'),
      readFile(join(v4, 'blind-v4.manifest.json'), 'utf8'),
      readFile(join(v4, 'blind-v4-results.json'), 'utf8'),
    ])
    const manifest = JSON.parse(manifestText) as {
      codeFreezeCommit: string
      counts: { total: number; english: number; chinese: number; bypass: number; contract: number; lattice: number }
      digests: { prompts: string; labels: string; sources: string }
    }
    const results = JSON.parse(resultsText) as {
      codeFreezeCommit: string
      metrics: { exactAccuracy: number; outcomeCriticalBypass: number }
      checks: Record<string, boolean>
      releaseGatePassed: boolean
      failures: unknown[]
    }

    expect(manifest.codeFreezeCommit).toBe('97ba3b3fe2dc9d72453735900e73c6f03bf8dd7c')
    expect(manifest.counts).toMatchObject({
      total: 120, english: 60, chinese: 60, bypass: 60, contract: 36, lattice: 24,
    })
    expect(manifest.digests).toMatchObject({
      prompts: sha256(promptsText), labels: sha256(labelsText), sources: sha256(sourcesText),
    })
    expect(results.codeFreezeCommit).toBe(manifest.codeFreezeCommit)
    expect(results.releaseGatePassed).toBe(false)
    expect(Object.values(results.checks).every(value => value === false)).toBe(true)
    expect(results.metrics.exactAccuracy).toBeCloseTo(61 / 120, 12)
    expect(results.metrics.outcomeCriticalBypass).toBe(21)
    expect(results.failures).toHaveLength(59)
  })
})
