import { assessTaskInvariants } from './task-invariants.js'

export interface SparseRouterFeatures {
  indices: number[]
  values: number[]
}

function fnv1a(value: string): number {
  let hash = 0x811c9dc5
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return hash >>> 0
}

function add(counts: Map<number, number>, feature: string, dimensions: number, amount = 1): void {
  const index = fnv1a(feature) % dimensions
  counts.set(index, (counts.get(index) ?? 0) + amount)
}

const SEMANTIC_SIGNALS = {
  bugTitle: /^(?:\[[^\]]*bug[^\]]*\]|bug\s*:|(?:bug|regression|crash|failure|broken|incorrect)\b|【?(?:bug|错误|缺陷)】?|错误|异常|失败|崩溃|无法|不生效)/i,
  bugTemplate: /(?:steps to reproduce|expected behaviou?r|actual behaviou?r|describe the bug|repro(?:duction)?|stack trace|version:|是什么版本出现了此问题|复现步骤|预期行为|实际行为|发生了什么|相关日志)/i,
  concreteFailure: /(?:throws?|fails?|returns?|renders?|prints?|crashes?|hangs?|times? out|missing|duplicat(?:e|ed)|incorrect|unexpected|报错|返回|渲染|打印|崩溃|卡死|超时|丢失|重复|不正确|异常)/i,
  featureRequest: /(?:feature request|enhancement|add support for|allow (?:users?|admins?|operators?) to|should support|need the ability|功能(?:请求|建议|需求)|新增功能|增加对.+支持|建议(?:增加|新增|添加|支持)|希望.+(?:增加|新增|支持|能够))/i,
  productBuild: /(?:\b(?:build|create|design|implement|develop|architect|rebuild|redesign)\b.{0,80}\b(?:app|application|system|platform|dashboard|portal|service|workflow|agent|website|product|saas|marketplace)\b|(?:做|搭建|开发|设计|实现|创建|重建|改造).{0,40}(?:系统|应用|平台|后台|工作台|网站|门户|服务|产品|智能体|流程))/i,
  trackingProgram: /(?:tracking issue|implementation tracking|roadmap|work items?|epic|milestones?|kubernetes enhancement proposal|\bKEP\b|\bRFC\b|\bADR\b|跟踪(?:问题|实现)|路线图|工作项|里程碑|实施提案|阶段计划)/i,
  architecture: /(?:re-?architect|architecture (?:change|migration|refactor)|cross[- ]module|multiple modules|subsystem|pipeline|架构(?:改造|调整|迁移|重构)|跨模块|多个模块|子系统|流水线)/i,
  migration: /(?:\bmigrat(?:e|ion)\b|\bupgrade\b|\bdowngrade\b|\brollback\b|\bbackfill\b|迁移|升级|降级|回滚|回填)/i,
  persistentState: /(?:database|storage|schema|tenant data|production data|backups?|restore|数据库|存储|模式|租户数据|生产数据|备份|恢复)/i,
  security: /(?:auth(?:entication|orization)?|oauth|sso|permissions?|roles?|secrets?|credentials?|license|entitlement|cross[- ]tenant|认证|授权|权限|角色|密钥|凭据|许可证|跨租户)/i,
  irreversible: /(?:\b(?:delete|drop|publish|deploy|release|charge|send|rotate|grant)\b|删除|发布|部署|上线|扣款|发送|轮换|授予)/i,
  dynamic: /(?:requirements? (?:may|will|keep) change|evolving requirements?|dynamic requirements?|while (?:we|you) build|需求(?:会|可能|持续)?变化|边做边改|动态需求|过程中调整)/i,
  multiAgent: /(?:multi[- ]agent|subagents?|parallel agents?|多个代理|多代理|子代理|并行代理)/i,
  acceptance: /(?:acceptance|done when|must pass|verify|validation|success metric|验收|完成标准|必须通过|验证|成功指标)/i,
  scope: /(?:in scope|out of scope|only|exclude|boundary|范围|不包含|仅限|边界)/i,
  authority: /(?:approval|permission|authorize|owner|side effect|审批|权限|授权|负责人|副作用)/i,
  question: /^(?:what|why|how|where|when|who|is|are|can|could|should|请问|什么|为什么|怎么|如何|哪里|是否|能否)\b/i,
  maintenance: /(?:typo|rename|readme|documentation|dependency bump|version bump|错别字|重命名|说明文档|依赖升级|版本升级)/i,
} as const

export function normalizeRouterText(text: string): string {
  return text
    .normalize('NFKC')
    .toLocaleLowerCase('en-US')
    .replace(/\d+/g, '#')
    .replace(/\s+/g, ' ')
    .trim()
}

export function extractRouterFeatures(text: string, dimensions: number): SparseRouterFeatures {
  const normalized = normalizeRouterText(text)
  const title = normalizeRouterText(text.split(/\r?\n/, 1)[0] ?? text)
  const counts = new Map<number, number>()
  const characters = [...normalized.slice(0, 2400)]
  const titleCharacters = [...title.slice(0, 240)]
  const lines = text.split(/\r?\n/)
  const checklistItems = lines.filter(line => /^\s*[-*]\s+\[[ xX]\]/.test(line)).length
  const listItems = lines.filter(line => /^\s*(?:[-*]|\d+[.)])\s+/.test(line)).length
  const invariants = assessTaskInvariants(text)

  add(counts, 'bias:text', dimensions)
  add(counts, `length:${Math.min(12, Math.floor(characters.length / 160))}`, dimensions)
  add(counts, `lines:${Math.min(10, Math.floor(lines.length / 4))}`, dimensions)
  add(counts, `lists:${Math.min(8, Math.floor(listItems / 2))}`, dimensions)
  add(counts, `checks:${Math.min(8, Math.floor(checklistItems / 2))}`, dimensions)
  add(counts, `basis:complete:${Math.floor(invariants.basisCompleteness / 2)}`, dimensions, 5)
  add(counts, `basis:expiry:${Math.floor(invariants.basisExpiryExposure / 2)}`, dimensions, 5)
  add(counts, `basis:impact:${Math.floor(invariants.staleMutationImpact / 2)}`, dimensions, 5)
  add(counts, `basis:epochs:${Math.min(8, invariants.mutationEpochs)}`, dimensions, 4)
  for (const [name, active] of Object.entries({
    diagnosticClosure: invariants.diagnosticClosure,
    boundedChange: invariants.boundedChange,
    programCommitment: invariants.programCommitment,
    adaptiveSequence: invariants.adaptiveSequence,
    delayedVerification: invariants.delayedVerification,
    crossArtifactCommitment: invariants.crossArtifactCommitment,
    targetDiscoveryRequired: invariants.targetDiscoveryRequired,
    recoveryUnavailable: invariants.recoveryUnavailable,
  })) {
    if (active) add(counts, `basis:${name}`, dimensions, 5)
  }
  if (/```|\[code omitted\]/i.test(text)) add(counts, 'shape:code', dimensions, 2)
  if (/^\s*#{1,6}\s+/m.test(text)) add(counts, 'shape:headings', dimensions, 2)
  if (/https?:\/\/|\[link\]/i.test(text)) add(counts, 'shape:links', dimensions)
  for (const [name, pattern] of Object.entries(SEMANTIC_SIGNALS)) {
    if (pattern.test(text)) add(counts, `semantic:${name}`, dimensions, 3)
  }
  const semanticNames = Object.entries(SEMANTIC_SIGNALS)
    .filter(([, pattern]) => pattern.test(text))
    .map(([name]) => name)
    .sort()
  for (let left = 0; left < semanticNames.length; left += 1) {
    for (let right = left + 1; right < semanticNames.length; right += 1) {
      add(counts, `semantic-pair:${semanticNames[left]}+${semanticNames[right]}`, dimensions)
    }
  }
  for (let size = 2; size <= 5; size += 1) {
    for (let index = 0; index + size <= characters.length; index += 1) {
      add(counts, `c${size}:${characters.slice(index, index + size).join('')}`, dimensions)
    }
  }
  for (let size = 2; size <= 4; size += 1) {
    for (let index = 0; index + size <= titleCharacters.length; index += 1) {
      add(counts, `t${size}:${titleCharacters.slice(index, index + size).join('')}`, dimensions, 2)
    }
  }

  const words = normalized.match(/[\p{L}\p{N}_@./:-]+/gu) ?? []
  for (let index = 0; index < words.length; index += 1) {
    add(counts, `w:${words[index]}`, dimensions, 2)
    if (index > 0) add(counts, `b:${words[index - 1]} ${words[index]}`, dimensions)
  }

  const entries = [...counts.entries()].sort((left, right) => left[0] - right[0])
  const norm = Math.sqrt(entries.reduce((sum, [, count]) => sum + Math.log1p(count) ** 2, 0)) || 1
  return {
    indices: entries.map(([index]) => index),
    values: entries.map(([, count]) => Math.log1p(count) / norm),
  }
}
