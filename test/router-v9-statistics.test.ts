import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'

const statisticsUrl = pathToFileURL(join(process.cwd(), 'eval/router-corpus/v9/statistics.mjs')).href

type Route = 'bypass' | 'contract' | 'lattice' | 'probe'

function familyRows(route: Route, successes: number, options: {
  language?: string
  families?: number
  variants?: number
} = {}) {
  const language = options.language ?? 'en'
  const families = options.families ?? 60
  const variants = options.variants ?? 1
  return Array.from({ length: families }, (_, familyIndex) => Array.from({ length: variants }, (_, variantIndex) => ({
    id: `${language}-${route}-${familyIndex}-${variantIndex}`,
    language,
    expected: route,
    actual: familyIndex < successes || variantIndex > 0
      ? route
      : route === 'bypass' ? 'contract' : route === 'contract' ? 'lattice' : 'contract',
    outcomeCritical: route === 'contract',
    sourceFamily: `${route}-family-${familyIndex}`,
    repository: `owner/repository-${familyIndex % 12}`,
  }))).flat()
}

function passingRows(language: string, latticeSuccesses = 59) {
  return [
    ...familyRows('lattice', latticeSuccesses, { language }),
    ...familyRows('probe', 56, { language }),
    ...familyRows('contract', 56, { language }),
    ...familyRows('bypass', 60, { language }),
  ]
}

describe('V9 confidence-bound route statistics', () => {
  it('computes the preregistered one-sided 95% Clopper-Pearson boundaries', async () => {
    const statistics = await import(`${statisticsUrl}?cp=${Date.now()}`)
    const lattice59 = statistics.clopperPearsonLowerBound(59, 60)
    const lattice58 = statistics.clopperPearsonLowerBound(58, 60)
    const probe56 = statistics.clopperPearsonLowerBound(56, 60)
    const noFalseActivations = statistics.clopperPearsonUpperBound(0, 60)

    expect(lattice59).toBeGreaterThan(0.9)
    expect(lattice58).toBeLessThan(0.9)
    expect(probe56).toBeGreaterThanOrEqual(0.85)
    expect(noFalseActivations).toBeLessThanOrEqual(0.05)
    expect(noFalseActivations).toBeCloseTo(1 - 0.05 ** (1 / 60), 14)
  })

  it('passes 59/60 lattice, 56/60 probe, and 0/60 bypass false activation on confidence bounds', async () => {
    const { evaluateRouteHardGate } = await import(`${statisticsUrl}?pass=${Date.now()}`)
    const result = evaluateRouteHardGate([
      ...passingRows('en'),
      ...passingRows('zh'),
    ])

    expect(result.hardGatePassed).toBe(true)
    expect(result.checks).toHaveLength(12)
    expect(result.checks.every((check: { passed: boolean }) => check.passed)).toBe(true)
    expect(result.byLanguageRoute.en.lattice.recall).toMatchObject({ successes: 59, trials: 60 })
    expect(result.byLanguageRoute.en.probe.recall).toMatchObject({ successes: 56, trials: 60 })
    expect(result.byLanguageRoute.en.bypass.bypassFalseActivation).toMatchObject({
      falseActivations: 0,
      trials: 60,
      pointEstimate: 0,
    })
  })

  it('fails 58/60 lattice even though its point estimate exceeds the threshold', async () => {
    const { evaluateRouteHardGate } = await import(`${statisticsUrl}?fail=${Date.now()}`)
    const result = evaluateRouteHardGate([
      ...passingRows('en', 58),
      ...passingRows('zh'),
    ])
    const lattice = result.checks.find((check: { language: string; route: string }) => (
      check.language === 'en' && check.route === 'lattice'
    ))

    expect(lattice.pointEstimate).toBe(58 / 60)
    expect(lattice.pointEstimate).toBeGreaterThan(0.9)
    expect(lattice.confidenceBound).toBeLessThan(0.9)
    expect(lattice.passed).toBe(false)
    expect(result.hardGatePassed).toBe(false)
  })

  it('counts every source family once and requires an exact outcome across its variants', async () => {
    const { computeRouteStatistics } = await import(`${statisticsUrl}?families=${Date.now()}`)
    const rows = familyRows('lattice', 59, { language: 'zh', variants: 3 })
    const statistics = computeRouteStatistics(rows)
    const lattice = statistics.byLanguageRoute.zh.lattice

    expect(lattice.rowCount).toBe(180)
    expect(lattice.familyCount).toBe(60)
    expect(lattice.exactOutcomeCount).toBe(59)
    expect(lattice.recall).toMatchObject({ successes: 59, trials: 60, pointEstimate: 59 / 60 })
    expect(statistics.familyOutcomes.filter((family: { exactOutcome: boolean }) => !family.exactOutcome)).toHaveLength(1)
  })

  it('supports an explicit repository-cluster sensitivity analysis', async () => {
    const { computeRouteStatistics } = await import(`${statisticsUrl}?repositories=${Date.now()}`)
    const statistics = computeRouteStatistics([
      { language: 'en', expected: 'bypass', actual: 'bypass', outcomeCritical: false, sourceFamily: 'one-a', repository: 'owner/one' },
      { language: 'en', expected: 'bypass', actual: 'contract', outcomeCritical: false, sourceFamily: 'one-b', repository: 'owner/one' },
      { language: 'en', expected: 'bypass', actual: 'bypass', outcomeCritical: false, sourceFamily: 'two-a', repository: 'owner/two' },
    ], { clusterUnit: 'repository' })
    const bypass = statistics.byLanguageRoute.en.bypass

    expect(bypass.rowCount).toBe(3)
    expect(bypass.familyCount).toBe(2)
    expect(bypass.exactOutcomeCount).toBe(1)
    expect(bypass.bypassFalseActivation).toMatchObject({ falseActivations: 1, trials: 2, pointEstimate: 0.5 })
  })

  it('fails any outcome-critical bypass or excessive probe false positives', async () => {
    const { evaluateRouteHardGate } = await import(`${statisticsUrl}?safety=${Date.now()}`)
    const rows = [...passingRows('en'), ...passingRows('zh')]
    const critical = rows.find(row => row.language === 'en' && row.expected === 'contract')!
    critical.actual = 'bypass'
    for (const falseProbe of rows.filter(row => row.language === 'zh' && row.expected === 'bypass').slice(0, 20)) {
      falseProbe.actual = 'probe'
    }
    const result = evaluateRouteHardGate(rows)

    expect(result.checks.find((check: { language: string; metric: string }) => (
      check.language === 'en' && check.metric === 'bypass-count'
    ))).toMatchObject({ pointEstimate: 1, passed: false })
    expect(result.checks.find((check: { language: string; metric: string }) => (
      check.language === 'zh' && check.metric === 'probe-false-positive'
    ))).toMatchObject({ passed: false })
    expect(result.hardGatePassed).toBe(false)
  })
})
