import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { routeRequest, type ControlLevel, type RouteConfig } from '../src/router.js'

interface CorpusRow {
  id: string
  split: 'development' | 'blind'
  sourceGroup: string
  expected: ControlLevel
  expectedClarificationPolicy?: 'never'
  outcomeCritical: boolean
  override: 'bypass' | 'lattice' | 'no-questions' | null
  text: string
}

const config: RouteConfig = {
  activationMode: 'auto',
  clarificationPolicy: 'critical',
  controlCeiling: 'lattice',
  longTaskThreshold: 8,
}

async function corpus(split: 'development' | 'blind'): Promise<CorpusRow[]> {
  const content = await readFile(join(process.cwd(), 'eval/router-corpus', `${split}.jsonl`), 'utf8')
  return content.trim().split('\n').map(line => JSON.parse(line) as CorpusRow)
}

describe('frozen activation corpus', () => {
  it('contains 120 source-isolated cases per split with no duplicate text', async () => {
    const development = await corpus('development')
    const blind = await corpus('blind')
    expect(development).toHaveLength(120)
    expect(blind).toHaveLength(120)
    expect(new Set(development.map(row => row.sourceGroup))).toEqual(new Set(['development-authored']))
    expect(new Set(blind.map(row => row.sourceGroup))).toEqual(new Set(['blind-paraphrase']))
    const hashes = [...development, ...blind].map(row => createHash('sha256').update(row.text.trim().toLowerCase()).digest('hex'))
    expect(new Set(hashes).size).toBe(240)
  })

  it('development meets the regression routing thresholds', async () => {
    const rows = await corpus('development')
    const results = rows.map(row => ({ row, route: routeRequest(row.text, config) }))
    const simple = results.filter(result => result.row.expected === 'bypass' && result.row.override !== 'lattice')
    const simpleFalseActivation = simple.filter(result => result.route.phase !== 'bypass').length / simple.length
    const complex = results.filter(result => result.row.expected !== 'bypass')
    const complexRecall = complex.filter(result => result.route.phase !== 'bypass').length / complex.length
    expect(simpleFalseActivation).toBeLessThanOrEqual(0.05)
    expect(complexRecall).toBeGreaterThanOrEqual(0.9)
    expect(results.filter(result => result.row.outcomeCritical && result.route.phase === 'bypass')).toEqual([])
    expect(results.filter(result => result.row.override !== null && (
      result.route.phase !== result.row.expected
      || result.row.expectedClarificationPolicy !== undefined
        && result.route.clarificationPolicy !== result.row.expectedClarificationPolicy
    ))).toEqual([])
  })

  it('keeps the revealed synthetic blind split as diagnostics, not release evidence', async () => {
    const rows = await corpus('blind')
    const results = rows.map(row => ({ row, route: routeRequest(row.text, config) }))

    expect(results.filter(result => result.row.override !== null && (
      result.route.phase !== result.row.expected
      || result.row.expectedClarificationPolicy !== undefined
        && result.route.clarificationPolicy !== result.row.expectedClarificationPolicy
    ))).toEqual([])
    const archived = JSON.parse(await readFile(
      join(process.cwd(), 'eval/router-corpus', 'blind-real-results.json'),
      'utf8',
    )) as { releaseGatePassed: boolean }
    expect(archived.releaseGatePassed).toBe(false)
  })
})
