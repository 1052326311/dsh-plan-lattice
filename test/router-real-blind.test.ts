import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { ControlLevel } from '../src/router.js'

interface PromptRow {
  id: string
  split: 'blind'
  sourceGroup: string
  language: 'en' | 'zh'
  text: string
}

interface LabelRow {
  id: string
  expected: ControlLevel
  outcomeCritical: boolean
  rubric: string
}

interface SourceRow {
  id: string
  repository: string
  issueNumber: number
  url: string
  titleDigest: string
  sourceContentDigest: string
  queryGroup: string
}

const root = join(process.cwd(), 'eval', 'router-corpus')
function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex')
}

async function jsonLines<T>(name: string): Promise<{ text: string; rows: T[] }> {
  const text = await readFile(join(root, name), 'utf8')
  return { text, rows: text.trim().split('\n').map(line => JSON.parse(line) as T) }
}

describe('archived v0.4 real-source router blind result', () => {
  it('keeps prompts, labels, sources, and the evaluated router digest independently hashed', async () => {
    const prompts = await jsonLines<PromptRow>('blind-real.prompts.jsonl')
    const labels = await jsonLines<LabelRow>('blind-real.labels.jsonl')
    const sources = await jsonLines<SourceRow>('blind-real.sources.jsonl')
    const manifest = JSON.parse(await readFile(join(root, 'blind-real.manifest.json'), 'utf8')) as {
      routerSourceDigest: string
      counts: Record<string, number>
      digests: Record<string, string>
    }
    const archived = JSON.parse(await readFile(join(root, 'blind-real-results.json'), 'utf8')) as {
      routerSourceDigest: string
    }

    expect(prompts.rows).toHaveLength(120)
    expect(labels.rows).toHaveLength(120)
    expect(sources.rows).toHaveLength(120)
    expect(new Set(prompts.rows.map(row => row.id))).toEqual(new Set(labels.rows.map(row => row.id)))
    expect(new Set(prompts.rows.map(row => row.id))).toEqual(new Set(sources.rows.map(row => row.id)))
    expect(new Set(sources.rows.map(row => row.url)).size).toBe(120)
    expect(sources.rows.every(row => row.url.startsWith('https://github.com/'))).toBe(true)
    expect(manifest.counts).toMatchObject({ total: 120, english: 60, chinese: 60, bypass: 40, contract: 40, lattice: 40 })
    expect(sha256(prompts.text)).toBe(manifest.digests.prompts)
    expect(sha256(labels.text)).toBe(manifest.digests.labels)
    expect(sha256(sources.text)).toBe(manifest.digests.sources)
    expect(archived.routerSourceDigest).toBe(manifest.routerSourceDigest)
  })

  it('retains the failed gate instead of retuning or overwriting the reveal', async () => {
    const archived = JSON.parse(await readFile(join(root, 'blind-real-results.json'), 'utf8')) as {
      releaseGatePassed: boolean
      metrics: {
        simpleFalseActivationRate: number
        complexCriticalRecall: number
        outcomeCriticalBypassCount: number
      }
    }
    expect(archived.releaseGatePassed).toBe(false)
    expect(archived.metrics).toEqual({
      simpleFalseActivationRate: 0.575,
      complexCriticalRecall: 0.8625,
      outcomeCriticalBypassCount: 11,
    })
  })

  it('contains no credential-shaped material in model-visible excerpts', async () => {
    const { rows } = await jsonLines<PromptRow>('blind-real.prompts.jsonl')
    expect(rows.filter(row => /(?:sk|gh[opsu])-[A-Za-z0-9_-]{16,}/.test(row.text))).toEqual([])
  })
})
