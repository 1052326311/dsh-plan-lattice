import { createHash } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))

const sources = {
  development: {
    sourceGroup: 'development-authored',
    bypass: [
      'Fix the typo in README section {n}.',
      'Rename the local variable in parser test {n}.',
      'Explain why this unit test returns false in case {n}.',
      'Update the button copy in fixture {n}.',
      'Add one regression test for the null branch in case {n}.',
      '修复 README 第 {n} 节的错别字。',
      '把测试 {n} 里的局部变量改名。',
      '解释这个函数在样例 {n} 中为什么返回空值。',
      '修改夹具 {n} 的按钮文案。',
      '给空值分支增加一个聚焦回归测试，编号 {n}。',
    ],
    contract: [
      'Build a customer support application for scenario {n}.',
      'Create an inventory management system for team {n}.',
      'Design a billing dashboard for workspace {n}.',
      'Implement an approval workflow service for group {n}.',
      'Publish the release artifact for module {n}.',
      '做一个客服管理应用，场景编号 {n}。',
      '搭建一个库存管理系统，团队编号 {n}。',
      '设计一个账单后台，工作区编号 {n}。',
      '实现一个审批流程服务，组编号 {n}。',
      '发布模块 {n} 的正式产物。',
    ],
    lattice: [
      'Build a production-ready multi-agent platform from scratch for domain {n}.',
      'Create a complete application across multiple modules; requirements will keep changing in wave {n}.',
      'Migrate the entire service in 12 atomic steps and deploy it for cohort {n}.',
      'Design an end-to-end workflow with parallel subagents and evolving acceptance for case {n}.',
      'Rebuild the whole system while production data and permissions change in phase {n}.',
      '从零搭建完整多代理平台，业务编号 {n}。',
      '跨多个模块开发完整应用，需求会在第 {n} 轮持续变化。',
      '用 12 个原子步骤迁移整个服务并部署，批次 {n}。',
      '设计端到端流程，由并行子代理执行且验收动态变化，案例 {n}。',
      '重构整个系统，过程中生产数据和权限边界会变化，阶段 {n}。',
    ],
  },
  blind: {
    sourceGroup: 'blind-paraphrase',
    bypass: [
      'Correct one misspelling in changelog item {n}.',
      'Change a test helper name in example {n}.',
      'What does the reducer do with an empty input in sample {n}?',
      'Replace one label in dialog fixture {n}.',
      'Cover the missing undefined branch with one test, variant {n}.',
      '纠正文档条目 {n} 中的一个拼写。',
      '调整示例 {n} 的测试辅助函数名称。',
      '说明 reducer 在空输入样例 {n} 下的行为。',
      '替换弹窗夹具 {n} 中的一处标签。',
      '只补一个 undefined 分支测试，变体 {n}。',
    ],
    contract: [
      'Develop a scheduling portal for department {n}.',
      'Make a claims processing app for queue {n}.',
      'Architect a reporting service for tenant {n}.',
      'Create a sales operations dashboard for region {n}.',
      'Delete the production export for batch {n}.',
      '开发一个排班门户，部门编号 {n}。',
      '制作一个理赔处理应用，队列编号 {n}。',
      '设计一个报表服务，租户编号 {n}。',
      '创建销售运营后台，区域编号 {n}。',
      '删除批次 {n} 的生产导出数据。',
    ],
    lattice: [
      'Implement a long-running multi-agent product end to end for track {n}.',
      'Build the complete platform across services while the specification evolves in round {n}.',
      'Carry out a 15-step system migration with production rollout for lane {n}.',
      'Create the whole workflow with delegated agents and changing requirements for ticket {n}.',
      'Re-architect every module while access rules and deployment facts move in stage {n}.',
      '端到端实现长期运行的多智能体产品，路线 {n}。',
      '跨服务构建完整平台，规格在第 {n} 轮持续调整。',
      '执行 15 步系统迁移并上线生产，通道 {n}。',
      '创建全流程并交给多个子代理，工单 {n} 的需求动态变化。',
      '重做所有模块，阶段 {n} 的权限和部署事实会变化。',
    ],
  },
}

function fill(templates, count, split, expected, outcomeCritical) {
  return Array.from({ length: count }, (_, index) => ({
    id: `${split}-${expected}-${String(index + 1).padStart(3, '0')}`,
    split,
    sourceGroup: sources[split].sourceGroup,
    expected,
    outcomeCritical,
    override: null,
    text: templates[index % templates.length].replace('{n}', String(index + 1)),
  }))
}

function build(split) {
  const source = sources[split]
  const rows = [
    ...fill(source.bypass, 36, split, 'bypass', false),
    ...fill(source.contract, 36, split, 'contract', true),
    ...fill(source.lattice, 36, split, 'lattice', true),
  ]
  for (let index = 1; index <= 4; index += 1) rows.push({
    id: `${split}-override-bypass-${index}`,
    split,
    sourceGroup: source.sourceGroup,
    expected: 'bypass',
    outcomeCritical: false,
    override: 'bypass',
    text: split === 'development'
      ? `不要使用 Plan Lattice，直接处理完整多代理平台任务 ${index}。`
      : `Do not use Plan Lattice for the complete multi-agent platform request ${index}.`,
  })
  for (let index = 1; index <= 4; index += 1) rows.push({
    id: `${split}-override-lattice-${index}`,
    split,
    sourceGroup: source.sourceGroup,
    expected: 'lattice',
    outcomeCritical: false,
    override: 'lattice',
    text: split === 'development'
      ? `使用完整 Lattice，只改第 ${index} 个拼写。`
      : `Use the full Lattice to fix typo ${index}.`,
  })
  for (let index = 1; index <= 4; index += 1) rows.push({
    id: `${split}-override-no-questions-${index}`,
    split,
    sourceGroup: source.sourceGroup,
    expected: 'contract',
    expectedClarificationPolicy: 'never',
    outcomeCritical: true,
    override: 'no-questions',
    text: split === 'development'
      ? `搭建一个运营系统 ${index}，不要提问，合理假设。`
      : `Build an operations application ${index}; do not ask questions and make reasonable assumptions.`,
  })
  if (rows.length !== 120) throw new Error(`${split} corpus has ${rows.length} rows`)
  return rows
}

const allHashes = new Set()
for (const split of ['development', 'blind']) {
  const rows = build(split)
  for (const row of rows) {
    const hash = createHash('sha256').update(row.text.trim().toLowerCase()).digest('hex')
    if (allHashes.has(hash)) throw new Error(`duplicate corpus text: ${row.text}`)
    allHashes.add(hash)
  }
  await mkdir(here, { recursive: true })
  await writeFile(join(here, `${split}.jsonl`), `${rows.map(row => JSON.stringify(row)).join('\n')}\n`, 'utf8')
}

