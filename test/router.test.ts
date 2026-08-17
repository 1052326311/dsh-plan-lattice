import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import { apply } from '../src/index.js'
import { routeRequest, type RouteConfig } from '../src/router.js'

const config: RouteConfig = {
  activationMode: 'auto',
  clarificationPolicy: 'critical',
  controlCeiling: 'lattice',
  longTaskThreshold: 8,
}

describe('zero-call activation router', () => {
  it.each([
    ['Fix the typo in README line 14.', 'bypass'],
    ['把保存按钮的文案改成“提交”。', 'bypass'],
    ['What does this parser return for an empty array?', 'bypass'],
    ['Build a customer support application.', 'contract'],
    ['做一个销售管理系统。', 'contract'],
    ['Deploy this migration to production and delete the old records.', 'contract'],
    ['Build a production-ready multi-agent application from scratch.', 'lattice'],
    ['搭建完整平台，需求会在过程中持续变化，并行子代理执行。', 'lattice'],
    ['Implement this change in 12 atomic steps.', 'lattice'],
  ])('routes %s to %s', (text, expected) => {
    expect(routeRequest(text, config).phase).toBe(expected)
  })

  it('honors all task-level overrides before heuristics', () => {
    expect(routeRequest('不要使用 Plan Lattice，直接搭建完整系统。', config).phase).toBe('bypass')
    expect(routeRequest('使用完整 Lattice，修复这个拼写。', config).phase).toBe('lattice')
    expect(routeRequest('搭建一个系统，不要提问，合理假设。', config).clarificationPolicy).toBe('never')
  })

  it('never bypasses outcome-critical ambiguity', () => {
    const route = routeRequest('Publish the application and rotate its production secrets.', config)
    expect(route.outcomeCritical).toBe(true)
    expect(route.phase).not.toBe('bypass')
  })

  it.each([
    'Can you build a customer support application?',
    'Could you design a CRM system?',
    '能否帮我做一个客服系统？',
  ])('treats a polite product-building question as an action request: %s', text => {
    const route = routeRequest(text, config)
    expect(route.phase).toBe('contract')
    expect(route.outcomeCritical).toBe(true)
  })

  it('uses probe instead of guessing when the evidence is insufficient', () => {
    const route = routeRequest('Investigate the repository carefully and improve the implementation where appropriate, preserving every existing behavior and validating the result against the surrounding architecture before making any change.', config)
    expect(route.phase).toBe('probe')
    expect(route.confidence).toBe('needs-evidence')
  })

  it('keeps a detailed single-boundary bug report on the zero-overhead path', () => {
    const route = routeRequest(`Bug description: the parser returns an empty value for one valid local fixture.
Steps to reproduce: run parser.test.ts with the attached fixture.
Expected behavior: the existing parser returns the identifier.
Actual behavior: it returns undefined. Add a focused regression test and preserve all other behavior.`, config)
    expect(route.phase).toBe('bypass')
  })

  it('bypasses an explicit one-file task even when its contract uses several clauses', () => {
    const route = routeRequest(`Add and export a clamp(value, min, max) function in src/clamp.js.
Throw RangeError when min is greater than max.
Do not add dependencies or change other files.`, config)

    expect(route).toMatchObject({
      phase: 'bypass',
      confidence: 'high',
      executionSpan: 0,
      productDefinitionGap: 0,
    })
  })

  it.each([
    ['Bug: selection in this application is not visible when I make a terminal selection.', 'bypass'],
    ['[Bug] Website proxy generation drops the requested port before the backend service receives it. Steps to reproduce: enable SSL and inspect the generated config.', 'bypass'],
    ['[BUG] 从 1.10.7 升级到 1.10.10 失败。重现步骤：执行内置升级后查看日志。', 'bypass'],
    ['Feature request: add support for organization SSO in the admin console.', 'contract'],
    ['[FEATURE] Add a built-in release-notes command.\n\nWhat feature would you like to see? Users should view updates without leaving the terminal.', 'bypass'],
    ['Support custom CA bundle per model provider.\n\nWhat feature would you like to see? Allow configuring a custom CA path.', 'contract'],
    ['Allow configurable Next.js development origins.', 'contract'],
    ['Milvus vector store does not support explicit TLS configuration.', 'contract'],
    ['建议增加租户级审批功能。', 'contract'],
    ['新增原生调用 vLLM 部署模型功能。\n\n**功能描述** 希望可以不经过第三方网关。', 'contract'],
    ['Tracking issue for implementing the accepted RFC across the compiler pipeline.', 'lattice'],
    ['Refactor the authentication subsystem and its module boundaries.', 'contract'],
    ['Migrate all tenant databases to the new storage service.', 'lattice'],
  ] as const)('separates report vocabulary from requested action: %s', (text, expected) => {
    expect(routeRequest(text, config).phase).toBe(expected)
  })

  it('treats explicit real-world side effects as contract work, not mere mentions', () => {
    expect(routeRequest('Deploy this migration to production and delete the old records.', config).phase).toBe('contract')
    expect(routeRequest('[Bug] deleting a draft unexpectedly removes its local preview. Steps to reproduce are attached.', config).phase).toBe('bypass')
  })

  it('raises control only when a state transition threatens a protected boundary', () => {
    expect(routeRequest('[Bug] the upgrade button has the wrong icon.', config).phase).toBe('bypass')
    expect(routeRequest('[Bug] after upgrade, tenant database records disappeared and rollback cannot restore them.', config).phase).toBe('contract')
    expect(routeRequest('[Bug] the public endpoint exposes sensitive data across tenants.', config).phase).toBe('contract')
  })

  it('is invariant to issue-template boilerplate on a bounded bug', () => {
    const report = '[Bug] the local parser returns undefined for one fixture.'
    const boilerplate = `${report}\n\nI have read the complete README. I use my own key and a private deployment. Issues that ignore the template may be closed directly.`
    expect(routeRequest(report, config).phase).toBe('bypass')
    expect(routeRequest(boilerplate, config).phase).toBe('bypass')
  })

  it('recognizes long structured bug reports from their behavior oracle, not length', () => {
    const report = `Type: <b>Bug</b>\nRepro Steps: open the terminal and select one completion.\nActual Result: the selected completion is inserted twice.\nExpected Result: it is inserted once.\n${'Environment details and diagnostic output. '.repeat(40)}`
    expect(routeRequest(report, config).phase).toBe('bypass')
  })

  it('uses action-object coupling instead of unrelated word co-occurrence', () => {
    expect(routeRequest('Bug: I make a selection in this platform but the highlight is invisible.', config).phase).toBe('bypass')
    expect(routeRequest('Make a customer support platform.', config).phase).toBe('contract')
  })

  it('separates migration information from migration execution', () => {
    expect(routeRequest('Write a short tutorial explaining the migration command.', config).phase).toBe('bypass')
    expect(routeRequest('Migrate all tenant data and configuration, preserving rollback compatibility.', config).phase).toBe('lattice')
  })

  it('separates a bounded product surface from outcome-critical product semantics', () => {
    expect(routeRequest('Show existing tags in the audit log table.', config).phase).toBe('bypass')
    expect(routeRequest('Define how tags propagate across writes, storage, tenant permissions, and queries.', config).phase).toBe('contract')
    expect(routeRequest('Support configuring third-party login with OAuth.', config).phase).toBe('contract')
  })

  it('requires populated program milestones before a template becomes lattice work', () => {
    expect(routeRequest('Kubernetes Enhancement Proposal: fix one readiness result.', config).phase).not.toBe('lattice')
    expect(routeRequest('Kubernetes Enhancement Proposal. Alpha release target, beta release target, stable release target, code implementation and docs change.', config).phase).toBe('lattice')
  })

  it('does not let a tracking issue describe itself as a bug report and bypass control', () => {
    const route = routeRequest('Tracking issue for RFC-42. This is not a bug report; track implementation and unresolved design questions across the compiler pipeline.', config)
    expect(route.phase).toBe('lattice')
  })

  it.each([
    ['Build a customer support application.', '做一个客服管理应用。', 'contract'],
    ['Migrate all tenant databases to the new service.', '迁移所有租户数据库到新服务。', 'lattice'],
    ['Bug: the parser returns an empty identifier.', '【Bug】解析器返回了空标识符。', 'bypass'],
  ] as const)('keeps English and Chinese intent-equivalent routes aligned', (english, chinese, expected) => {
    expect(routeRequest(english, config).phase).toBe(expected)
    expect(routeRequest(chinese, config).phase).toBe(expected)
  })

  it('does not let bug-report vocabulary hide a dynamic cross-boundary task', () => {
    const route = routeRequest('Bug description: rebuild the complete platform across multiple modules while requirements keep changing and parallel subagents execute the migration.', config)
    expect(route.phase).toBe('lattice')
  })

  it.each([
    'Rename one local variable and run its focused test.',
    'Correct one heading in the quarterly report and verify the rendered page.',
    'Fix one spreadsheet formula in cell B7 and confirm its expected value.',
    'Summarize this supplied paragraph in three bullet points.',
  ])('keeps clear single-boundary work on the zero-overhead route: %s', text => {
    expect(routeRequest(text, config).phase).toBe('bypass')
  })

  it.each([
    'Build a customer approval application.',
    'Design an incident-response workflow for the operations team.',
    'Create a research evidence portal.',
    '搭建一个跨部门预算审批系统。',
  ])('contracts underspecified outcomes across product domains: %s', text => {
    expect(routeRequest(text, config).phase).toBe('contract')
  })

  it.each([
    'Migrate every department workflow and database in 12 stages while policy facts keep changing and parallel teams execute the work.',
    'Produce a multi-volume research synthesis with 10 deliverables while source evidence changes and multiple subagents work in parallel.',
    '把所有业务部门的数据和权限分 12 个阶段迁移，过程中政策事实持续变化，并由多个子代理并行执行。',
  ])('uses full control for long changing work independent of domain nouns: %s', text => {
    expect(routeRequest(text, config).phase).toBe('lattice')
  })

  it('routes causal structure rather than task-form labels', () => {
    expect(routeRequest('Tracking issue: fix one typo in README.', config).phase).toBe('bypass')
    expect(routeRequest('Feature: delete production records now.', config).phase).toBe('contract')
    expect(routeRequest(
      'Bug: rebuild every subsystem in 12 stages while requirements change and parallel agents coordinate the migration.',
      config,
    ).phase).toBe('lattice')
  })

  it('respects a contract ceiling for long work', () => {
    expect(routeRequest('Build a production-ready multi-agent application from scratch.', {
      ...config,
      controlCeiling: 'contract',
    }).phase).toBe('contract')
    expect(routeRequest('Use the full Lattice to fix this typo.', {
      ...config,
      controlCeiling: 'contract',
    })).toMatchObject({
      phase: 'contract',
      reasons: ['explicit full-lattice override capped by controlCeiling'],
    })
  })

  it('keeps legacy configuration unambiguous', () => {
    expect(() => apply(new Context(), {
      intakeMode: 'guided',
      activationMode: 'auto',
    })).toThrow('cannot be mixed')
  })

  it('turns all automatic control off when activationMode is off', () => {
    expect(routeRequest('Build a production-ready multi-agent platform.', {
      ...config,
      activationMode: 'off',
    }).phase).toBe('bypass')
  })
})
