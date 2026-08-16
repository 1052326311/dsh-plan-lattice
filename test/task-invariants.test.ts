import { describe, expect, it } from 'vitest'
import { assessTaskInvariants } from '../src/task-invariants.js'

describe('task invariant assessment', () => {
  it('separates a bounded observable defect from a product-definition gap', () => {
    const defect = assessTaskInvariants('Bug: parser returns an empty id. Repro: parse `a:b`; expected `a`, actual empty. Add a regression test.')
    const product = assessTaskInvariants('Build a customer support application.')

    expect(defect.boundedChange).toBe(true)
    expect(defect.verificationClarity).toBe(2)
    expect(product.definitionGap).toBeGreaterThanOrEqual(4)
    expect(product.boundedChange).toBe(false)
  })

  it('scores changing cross-boundary work independently of product names', () => {
    const first = assessTaskInvariants('Migrate every tenant database across the client and server in 12 steps while requirements keep changing; parallel agents will execute it.')
    const second = assessTaskInvariants('迁移全部租户数据库，跨客户端和服务端分 12 步执行，过程中需求持续变化，并由多个子代理并行处理。')

    for (const assessment of [first, second]) {
      expect(assessment.executionSpan).toBeGreaterThanOrEqual(8)
      expect(assessment.changeVolatility).toBeGreaterThanOrEqual(7)
      expect(assessment.coordinationLoad).toBeGreaterThanOrEqual(6)
      expect(assessment.boundaryCoupling).toBeGreaterThanOrEqual(4)
    }
  })

  it('does not confuse a form word with a long-running program', () => {
    const oneFix = assessTaskInvariants('Tracking issue: rename one local helper and run its focused test.')
    const program = assessTaskInvariants('Tracking issue with eight work items, four deliverables, a database migration, rollback, and changing acceptance across teams.')

    expect(oneFix.executionSpan).toBeLessThan(4)
    expect(program.executionSpan).toBeGreaterThanOrEqual(8)
    expect(program.boundaryCoupling).toBeGreaterThan(oneFix.boundaryCoupling)
  })

  it('treats reversibility as a causal property rather than an action name', () => {
    const direct = assessTaskInvariants('Deploy the release to production now.')
    const preview = assessTaskInvariants('Prepare a deployment preview with a dry run and rollback plan; do not publish it.')

    expect(direct.reversible).toBe(false)
    expect(direct.authorityImpact).toBeGreaterThan(preview.authorityImpact - 1)
    expect(preview.reversible).toBe(true)
  })

  it('preserves the risk vector across non-code domains', () => {
    const software = assessTaskInvariants('Build a multi-team platform in 10 stages while requirements keep changing.')
    const research = assessTaskInvariants('Produce a multi-team research system in 10 stages while evidence requirements keep changing.')

    expect(research.executionSpan).toBe(software.executionSpan)
    expect(research.changeVolatility).toBe(software.changeVolatility)
    expect(research.coordinationLoad).toBe(software.coordinationLoad)
    expect(research.declaredLongHorizon).toBe(software.declaredLongHorizon)
  })
})
