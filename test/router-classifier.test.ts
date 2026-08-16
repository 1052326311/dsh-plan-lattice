import { describe, expect, it } from 'vitest'
import { classifyRouteText } from '../src/router-classifier.js'
import { ROUTER_MODEL } from '../src/router-model.js'

describe('offline router classifier', () => {
  it('ships a dimensionally consistent generated model', () => {
    expect(ROUTER_MODEL.classes).toEqual(['bypass', 'contract', 'lattice'])
    expect(ROUTER_MODEL.weights).toHaveLength(ROUTER_MODEL.classes.length)
    expect(ROUTER_MODEL.biases).toHaveLength(ROUTER_MODEL.classes.length)
    for (const weights of ROUTER_MODEL.weights) expect(weights).toHaveLength(ROUTER_MODEL.dimensions)
  })

  it('is deterministic and returns normalized probabilities', () => {
    const text = 'Build a multi-tenant approval system while permissions and requirements keep changing.'
    const first = classifyRouteText(text)
    const second = classifyRouteText(text)

    expect(second).toEqual(first)
    expect(Object.values(first.probabilities).reduce((sum, value) => sum + value, 0)).toBeCloseTo(1, 12)
    expect(first.confidence).toBeGreaterThanOrEqual(1 / 3)
    expect(first.margin).toBeGreaterThanOrEqual(0)
  })

  it('keeps clear maintenance and long-running program examples separable', () => {
    expect(classifyRouteText('Fix the typo in README.').label).toBe('bypass')
    expect(classifyRouteText(
      'Implementation tracking: migrate every tenant database in twelve stages with rollback, parallel agents, and changing acceptance criteria.',
    ).label).toBe('lattice')
  })
})
