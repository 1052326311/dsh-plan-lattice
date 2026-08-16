export interface TaskInvariantAssessment {
  outcomeClarity: number
  verificationClarity: number
  definitionGap: number
  executionSpan: number
  boundaryCoupling: number
  changeVolatility: number
  authorityImpact: number
  coordinationLoad: number
  reversible: boolean
  existingBehaviorDefect: boolean
  boundedChange: boolean
  productDefinition: boolean
  stateTransition: boolean
  irreversibleSideEffect: boolean
  informationalRequest: boolean
  declaredLongHorizon: boolean
  programCommitment: boolean
  structuralRefactor: boolean
  recoveryUnavailable: boolean
  confidence: 'high' | 'needs-evidence'
  evidence: string[]
}

const EXISTING_BEHAVIOR = /(?:bug|regression|crash|failure|fails?|broken|incorrect|unexpected|does not|doesn't|not working|steps to reproduce|expected behaviou?r|actual behaviou?r|错误|异常|失败|崩溃|无法|不生效|复现步骤|预期行为|实际行为|发生了什么)/i
const CONCRETE_OBSERVATION = /(?:returns?|renders?|prints?|throws?|crashes?|hangs?|times? out|missing|duplicat(?:e|ed)|empty|wrong|expected|actual|error|log|stack|返回|渲染|打印|抛出|崩溃|卡死|超时|丢失|重复|为空|错误|预期|实际|日志|堆栈)/i
const PRODUCT_CREATION = /(?:\b(?:build|create|produce|design|implement|develop|architect|rebuild|redesign)\b(?:\s+(?!in\b|on\b|within\b)\S+){0,6}\s+\b(?:app|application|system|platform|dashboard|portal|service|workflow|agent|website|product|saas|marketplace)\b|\bmake\b(?:\s+(?!in\b|on\b|within\b)\S+){0,3}\s+\b(?:app|application|system|platform|dashboard|portal|service|workflow|agent|website|product|saas|marketplace)\b|(?:做|搭建|开发|设计|实现|创建|制作|重建|改造)(?:一个|一套|一款|完整的?|全套的?)?[^\n，。；]{0,24}(?:系统|应用|平台|后台|工作台|网站|门户|服务|产品|智能体|流程))/i
const CAPABILITY_CHANGE = /(?:feature request|enhancement|add support for|allow .{0,40} to|should support|need the ability|功能(?:请求|建议|需求|描述)|新增.{0,40}功能|建议(?:增加|新增|添加|支持)|希望.{0,40}(?:增加|新增|添加|支持|能够|可以))/i
const BOUNDED_SURFACE = /(?:\b(?:button|icon|command|label|copy|color|tooltip|field|flag|option|parameter|method|component|table column|local variable|unit test|readme|documentation|tutorial)\b|按钮|图标|命令|标签|文案|颜色|提示|字段|开关|选项|参数|方法|组件|表格列|局部变量|单元测试|说明文档|教程)/i
const CROSS_BOUNDARY = /(?:across|cross[- ](?:module|service|tenant)|multiple (?:modules|services|systems)|end[- ]to[- ]end|entire|whole|all tenants?|client and server|frontend and backend|跨模块|跨服务|跨租户|多个(?:模块|服务|系统)|端到端|整个|(?:全部|所有)租户|客户端和服务端|前后端)/i
const PERSISTENT_STATE = /(?:database|storage|schema|records?|state|tenant data|production data|backup|restore|数据库|存储|模式|记录|状态|租户数据|生产数据|备份|恢复)/i
const AUTHORITY = /(?:permissions?|roles?|auth(?:entication|orization)?|oauth|sso|approval|ownership|secrets?|credentials?|license|entitlement|certificates?|\bTLS\b|CA bundle|trusted origins?|development origins?|权限|角色|认证|授权|审批|所有权|密钥|凭据|许可证|证书|信任来源|开发来源|激活)/i
const IRREVERSIBLE_ACTION = /(?:(?:^|[.!?]\s+)(?:(?:please|now|then|also)\s+|(?:can|could|would)\s+you\s+)?(?:delete|drop|publish|deploy|release|charge|send|rotate|grant|revoke)\b|\b(?:please|go ahead and|make sure to)\s+(?:delete|drop|publish|deploy|release|charge|send|rotate|grant|revoke)\b|(?:^|[。！？]\s*)(?:请|现在|然后|直接|同时)?(?:删除|发布|部署|上线|扣款|发送|轮换|授予|撤销))/i
const REVERSIBILITY = /(?:rollback|roll back|undo|restore|revert|dry run|preview|回滚|撤销|恢复|还原|预演|预览)/i
const MIGRATION = /(?:\bmigrat(?:e|ion)\b|\bupgrade\b|\bdowngrade\b|\bbackfill\b|迁移|升级|降级|回填)/i
const STATE_TRANSITION_EXECUTION = /(?:\b(?:migrate|upgrade|downgrade|backfill)\b.{0,100}\b(?:data|database|records?|state|service|system|platform|tenants?|configuration)\b|\b(?:migration|upgrade|downgrade|backfill)\s+(?:plan|tool|execution|rollout|strategy)\b|(?:迁移|升级|降级|回填).{0,60}(?:数据|数据库|记录|状态|服务|系统|平台|租户|配置)|(?:数据|数据库|记录|状态|服务|系统|平台|租户|配置).{0,40}(?:迁移|升级|降级|回填))/i
const DYNAMIC_FACTS = /(?:requirements? (?:may|will|keep) chang(?:e|ing)|evolving requirements?|dynamic requirements?|while (?:we|you) build|facts? (?:may|will|keep) chang(?:e|ing)|需求(?:会|可能|持续)?变化|边做边改|动态需求|过程中调整|事实(?:会|可能|持续)?变化)/i
const COORDINATION = /(?:multi[- ]agent|subagents?|parallel agents?|multi[- ]team|multiple teams?|owners?|handoffs?|多个代理|多代理|子代理|并行代理|多个团队|负责人|交接)/i
const ACCEPTANCE = /(?:acceptance|done when|must pass|verify|validation|success metric|expected behaviou?r|验收|完成标准|必须通过|验证|成功指标|预期行为)/i
const OUTCOME = /(?:goal|outcome|so that|in order to|increase|reduce|prevent|ensure|目标|结果|为了|提升|降低|避免|确保)/i
const SCOPE = /(?:in scope|out of scope|only|exclude|boundary|within|范围|不包含|仅限|边界|只修改|仅修改)/i
const SOURCE_OF_TRUTH = /(?:source of truth|input|output|database|api|file|dataset|event stream|真源|输入|输出|数据库|接口|文件|数据集|事件流)/i
const EXPLICIT_UNKNOWN = /(?:tbd|to be decided|unknown|not sure|unspecified|figure out|待定|未知|不确定|未说明|需要摸索)/i
const SIMPLE_MAINTENANCE = /(?:typo|rename|readme|documentation|dependency bump|version bump|focused test|regression test|错别字|重命名|说明文档|依赖升级|版本升级|聚焦测试|回归测试)/i
const NUMBERED_STEP = /(?:^|\n)\s*(?:\d+[.)]|[-*]\s+\[[ xX]\])\s+/gm
const DELIVERABLE = /(?:deliverable|milestone|phase|workstream|implementation item|code change|docs? change|benchmark|交付物|里程碑|阶段|工作流|实施项|代码修改|文档修改|基准测试)/gi
const INFORMATIONAL_REQUEST = /^(?:what|why|how|where|when|who|is|are|can|could|should|explain|summari[sz]e|review|请问|什么|为什么|怎么|如何|哪里|是否|能否|解释|总结|审查)/i
const PROGRAM_COMMITMENT = /(?:(?:tracking|implementation) issue.{0,100}(?:accepted (?:rfc|design|proposal)|across|pipeline|unresolved design)|accepted (?:rfc|design|proposal).{0,100}(?:implement|across|pipeline)|(?:跟踪|实施)(?:问题|事项).{0,60}(?:已接受|跨|流水线|未解决设计))/i
const STRUCTURAL_REFACTOR = /(?:refactor.{0,80}(?:subsystem|module boundaries|architecture|pipeline|shared framework)|重构.{0,50}(?:子系统|模块边界|架构|流水线|共享框架))/i
const PROGRAM_MILESTONE = /(?:alpha release target|beta release target|stable release target|code (?:change|implementation|deliverable)|docs? (?:change|deliverable)|benchmark (?:change|deliverable|result)|客户端(?:交付|轨道)|服务端(?:交付|轨道)|文档(?:交付|更新|轨道))/gi
const RECOVERY_UNAVAILABLE = /(?:(?:rollback|restore|recovery|downgrade).{0,60}(?:cannot|can't|failed|fails?|unavailable|does not)|(?:cannot|can't|failed|fails?|unavailable).{0,60}(?:rollback|restore|recover|downgrade)|(?:回滚|恢复|降级).{0,40}(?:无法|失败|不能|不可用)|(?:无法|失败|不能).{0,40}(?:回滚|恢复|降级))/i

function clamp(value: number, maximum = 10): number {
  return Math.max(0, Math.min(maximum, value))
}

function countMatches(text: string, pattern: RegExp): number {
  return [...text.matchAll(pattern)].length
}

function explicitStepCount(text: string): number | undefined {
  const match = text.match(/(?:([0-9]{1,3})[-\s]*(?:atomic[-\s]+)?(?:steps?|stages?|phases?)|(?:预计|需要|大约|执行|分为|用)?\s*([0-9]{1,3})\s*(?:个原子)?(?:步|阶段|期))/i)
  if (match === null) return undefined
  const value = Number(match[1] ?? match[2])
  return Number.isSafeInteger(value) ? value : undefined
}

function declaredItemCount(text: string): number {
  const words: Record<string, number> = {
    one: 1, two: 2, three: 3, four: 4, five: 5, six: 6,
    seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12,
  }
  let maximum = 0
  const pattern = /\b(\d{1,3}|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\s+(?:work items?|deliverables?|milestones?|phases?)\b/gi
  for (const match of text.matchAll(pattern)) {
    const raw = match[1].toLowerCase()
    maximum = Math.max(maximum, Number(raw) || words[raw] || 0)
  }
  for (const match of text.matchAll(/([一二三四五六七八九十]|\d{1,3})\s*个?(?:工作项|交付物|里程碑|阶段)/g)) {
    const chinese: Record<string, number> = {
      一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10,
    }
    maximum = Math.max(maximum, Number(match[1]) || chinese[match[1]] || 0)
  }
  return maximum
}

export function assessTaskInvariants(textInput: string, longTaskThreshold = 8): TaskInvariantAssessment {
  const text = textInput.trim()
  const evidence: string[] = []
  const existingBehaviorDefect = EXISTING_BEHAVIOR.test(text) && CONCRETE_OBSERVATION.test(text)
  const productCreation = PRODUCT_CREATION.test(text)
  const capabilityChange = CAPABILITY_CHANGE.test(text)
  const boundedSurface = BOUNDED_SURFACE.test(text)
  const crossBoundary = CROSS_BOUNDARY.test(text)
  const persistentState = PERSISTENT_STATE.test(text)
  const authority = AUTHORITY.test(text)
  const irreversible = IRREVERSIBLE_ACTION.test(text)
  const migrationMention = MIGRATION.test(text)
  const migration = STATE_TRANSITION_EXECUTION.test(text)
  const volatile = DYNAMIC_FACTS.test(text)
  const coordinated = COORDINATION.test(text)
  const acceptance = ACCEPTANCE.test(text)
  const outcome = OUTCOME.test(text)
  const scope = SCOPE.test(text)
  const truth = SOURCE_OF_TRUTH.test(text)
  const unknown = EXPLICIT_UNKNOWN.test(text)
  const maintenance = SIMPLE_MAINTENANCE.test(text)
  const informationalRequest = INFORMATIONAL_REQUEST.test(text)
  const programCommitment = PROGRAM_COMMITMENT.test(text)
  const structuralRefactor = STRUCTURAL_REFACTOR.test(text)
  const recoveryUnavailable = RECOVERY_UNAVAILABLE.test(text) && persistentState
  const explicitSteps = explicitStepCount(text)
  const structuredItems = countMatches(text, NUMBERED_STEP)
  const deliverables = countMatches(text, DELIVERABLE)
  const programMilestones = countMatches(text, PROGRAM_MILESTONE)
  const declaredItems = declaredItemCount(text)
  const declaredLongHorizon = (explicitSteps ?? 0) >= longTaskThreshold
    || declaredItems >= longTaskThreshold
    || structuredItems >= longTaskThreshold
    || programMilestones >= 3
  const actionClauses = text.split(/[.!?。！？；;\n]+/).filter(segment => (
    /(?:\b(?:add|build|change|create|delete|deploy|design|fix|implement|migrate|publish|remove|rename|test|update|verify)\b|增加|搭建|修改|创建|删除|部署|设计|修复|实现|迁移|发布|移除|重命名|测试|更新|验证)/i.test(segment)
  )).length

  let outcomeClarity = 0
  if (existingBehaviorDefect || outcome || acceptance) outcomeClarity += 1
  if (existingBehaviorDefect && /(?:steps to reproduce|expected behaviou?r|actual behaviou?r|复现步骤|预期行为|实际行为)/i.test(text)) outcomeClarity += 1
  outcomeClarity = clamp(outcomeClarity, 2)

  let verificationClarity = 0
  if (acceptance || existingBehaviorDefect) verificationClarity += 1
  if (/(?:test|assert|metric|screenshot|recording|exit code|测试|断言|指标|截图|录屏|退出码)/i.test(text)) verificationClarity += 1
  verificationClarity = clamp(verificationClarity, 2)

  let boundaryCoupling = 0
  if (crossBoundary) boundaryCoupling += 4
  if (persistentState) boundaryCoupling += 2
  if (authority) boundaryCoupling += 2
  if (migration) boundaryCoupling += 2
  if (structuralRefactor) boundaryCoupling += 4
  if (recoveryUnavailable) boundaryCoupling += 2
  if (actionClauses >= 4 || structuredItems >= 4 || deliverables >= 3 || declaredItems >= 4) boundaryCoupling += 2
  boundaryCoupling = clamp(boundaryCoupling)

  let changeVolatility = 0
  if (volatile) changeVolatility += 7
  if (unknown) changeVolatility += 3
  if (coordinated) changeVolatility += 2
  changeVolatility = clamp(changeVolatility)

  let authorityImpact = 0
  if (authority) authorityImpact += 3
  if (irreversible) authorityImpact += 4
  if (persistentState) authorityImpact += 2
  if (/production|customer data|external users?|生产|客户数据|外部用户/i.test(text)) authorityImpact += 2
  authorityImpact = clamp(authorityImpact)

  let coordinationLoad = 0
  if (coordinated) coordinationLoad += 6
  if (actionClauses >= 4 || structuredItems >= 4 || declaredItems >= 4) coordinationLoad += 2
  if (deliverables >= 3 || declaredItems >= 4) coordinationLoad += 2
  coordinationLoad = clamp(coordinationLoad)

  let executionSpan = 0
  if (productCreation) executionSpan += 3
  if (crossBoundary) executionSpan += 3
  if (migration) executionSpan += 3
  if (programCommitment) executionSpan += 4
  if (structuralRefactor) executionSpan += 5
  if (recoveryUnavailable) executionSpan += 5
  if (volatile) executionSpan += 2
  if (coordinated) executionSpan += 3
  if (explicitSteps !== undefined) executionSpan += explicitSteps >= longTaskThreshold ? 5 : explicitSteps >= 4 ? 2 : 0
  if (structuredItems >= 8 || deliverables >= 4 || declaredItems >= longTaskThreshold) executionSpan += 5
  else if (structuredItems >= 4 || deliverables >= 2 || actionClauses >= 4 || declaredItems >= 4) executionSpan += 2
  if (programMilestones >= 3) executionSpan += 5
  if (text.length > 1200) executionSpan += 2
  else if (text.length > 500) executionSpan += 1
  executionSpan = clamp(executionSpan)

  let definitionGap = 0
  const contractShaped = productCreation
    || capabilityChange && !boundedSurface
    || crossBoundary
    || authority
    || migration
    || irreversible
    || structuralRefactor
  if (contractShaped) {
    if (!outcome) definitionGap += 2
    if (!scope) definitionGap += 2
    if (!truth && (persistentState || crossBoundary)) definitionGap += 2
    if (!acceptance) definitionGap += 2
    if (!REVERSIBILITY.test(text) && (irreversible || migration)) definitionGap += 2
  }
  if (unknown) definitionGap += 2
  definitionGap = clamp(definitionGap)

  const boundedChange = (maintenance || boundedSurface || existingBehaviorDefect)
    && !crossBoundary
    && !volatile
    && !coordinated
    && authorityImpact < 4
    && boundaryCoupling < 4
    && (actionClauses <= 2 || structuredItems <= 2)

  if (existingBehaviorDefect) evidence.push('observable existing-behavior defect')
  if (productCreation) evidence.push('new product or system outcome')
  if (capabilityChange) evidence.push('new capability semantics')
  if (boundedChange) evidence.push('single bounded change surface')
  if (crossBoundary) evidence.push('multiple ownership boundaries')
  if (persistentState) evidence.push('persistent state is affected')
  if (authority) evidence.push('authority or access boundary')
  if (irreversible) evidence.push('potentially irreversible side effect')
  if (migration) evidence.push('state transition or migration')
  else if (migrationMention) evidence.push('state-transition vocabulary without an execution object')
  if (volatile) evidence.push('facts or requirements can change during execution')
  if (coordinated) evidence.push('coordination across agents or owners')
  if (explicitSteps !== undefined) evidence.push(`explicit ${explicitSteps}-step horizon`)
  if (structuredItems >= 4) evidence.push(`${structuredItems} structured work items`)
  if (deliverables >= 2) evidence.push(`${deliverables} named deliverables or milestones`)
  if (programMilestones >= 3) evidence.push(`${programMilestones} explicit release or delivery milestones`)
  if (declaredItems >= 4) evidence.push(`${declaredItems} declared work items or deliverables`)
  if (programCommitment) evidence.push('accepted design committed across an implementation boundary')
  if (structuralRefactor) evidence.push('structural refactor across ownership boundaries')
  if (recoveryUnavailable) evidence.push('protected state has no working recovery path')
  if (definitionGap >= 4) evidence.push('outcome-critical contract fields are missing')

  const confidence = text.length === 0
    || (!boundedChange && executionSpan < 4 && definitionGap < 4 && authorityImpact < 4)
    ? 'needs-evidence'
    : 'high'

  return {
    outcomeClarity,
    verificationClarity,
    definitionGap,
    executionSpan,
    boundaryCoupling,
    changeVolatility,
    authorityImpact,
    coordinationLoad,
    reversible: !irreversible || REVERSIBILITY.test(text),
    existingBehaviorDefect,
    boundedChange,
    productDefinition: productCreation || capabilityChange,
    stateTransition: migration,
    irreversibleSideEffect: irreversible,
    informationalRequest,
    declaredLongHorizon,
    programCommitment,
    structuralRefactor,
    recoveryUnavailable,
    confidence,
    evidence,
  }
}
