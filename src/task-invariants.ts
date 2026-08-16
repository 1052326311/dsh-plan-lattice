export interface TaskInvariantAssessment {
  outcomeClarity: number
  verificationClarity: number
  definitionGap: number
  executionSpan: number
  boundaryCoupling: number
  changeVolatility: number
  authorityImpact: number
  coordinationLoad: number
  basisCompleteness: number
  basisExpiryExposure: number
  staleMutationImpact: number
  mutationEpochs: number
  reversible: boolean
  existingBehaviorDefect: boolean
  diagnosticClosure: boolean
  boundedChange: boolean
  productDefinition: boolean
  stateTransition: boolean
  irreversibleSideEffect: boolean
  informationalRequest: boolean
  declaredLongHorizon: boolean
  programCommitment: boolean
  structuralRefactor: boolean
  recoveryUnavailable: boolean
  adaptiveSequence: boolean
  delayedVerification: boolean
  coordinated: boolean
  crossArtifactCommitment: boolean
  targetDiscoveryRequired: boolean
  basisInvalidationChannels: string[]
  confidence: 'high' | 'needs-evidence'
  evidence: string[]
}

const EXISTING_BEHAVIOR = /(?:\b(?:bug|regression|crash|failure|fails?|broken|incorrect|unexpected|not working)\b|does not|doesn't|steps? to reproduce|expected behaviou?r|actual behaviou?r|错误|异常|失败|崩溃|无法|不生效|复现步骤|重现步骤|预期行为|实际行为|发生了什么)/i
const OBSERVED_BEHAVIOR = /(?:returns?|renders?|prints?|throws?|crashes?|breaks?|fails?|hangs?|times? out|removes?|filters? out|drops?|loses?|invisible|not visible|missing|duplicat(?:e|ed)|twice|empty|wrong|undefined|warning|error|stack trace|actual behaviou?r|current behaviou?r|返回|渲染|打印|抛出|崩溃|损坏|中断|卡死|超时|移除|过滤|丢失|不可见|看不到|重复|两次|为空|未定义|警告|错误|失败|无法|堆栈|实际行为|当前行为)/i
const EXPECTED_BEHAVIOR = /(?:expected behaviou?r|expected result|expected (?:the|a|an)\b|should (?:return|render|show|remain|work|allow|prevent|be)|must (?:return|remain|preserve|pass)|instead of|预期行为|预期结果|应当|应该|必须|而不是)/i
const REPRODUCTION = /(?:steps? to reproduce|repro steps?|reproduction|reproduce|repro:|run .{0,80}(?:test|command)|input:|fixture|重现步骤|复现步骤|复现|执行.{0,40}(?:测试|命令)|输入|夹具)/i
const OBVIOUS_INVARIANT_VIOLATION = /(?:empty (?:id|identifier|value)|returns? undefined|wrong (?:icon|label|value)|duplicat(?:e|ed)|twice|crash(?:es|ed)?|breaks? (?:the )?(?:integration|component|app)|(?:integration|component|app).{0,24}breaks?|空(?:标识符|值)|返回未定义|错误的?(?:图标|标签|值)|重复|两次|崩溃|导致(?:集成|组件|应用)(?:损坏|中断)|(?:集成|组件|应用).{0,16}(?:损坏|中断))/i
const PRODUCT_CREATION = /(?:\b(?:build|create|produce|design|implement|develop|architect|rebuild|redesign)\b(?:\s+(?!in\b|on\b|within\b)\S+){0,6}\s+\b(?:app|application|system|platform|dashboard|portal|service|workflow|agent|website|product|saas|marketplace)\b|\bmake\b(?:\s+(?!in\b|on\b|within\b)\S+){0,3}\s+\b(?:app|application|system|platform|dashboard|portal|service|workflow|agent|website|product|saas|marketplace)\b|(?:做|搭建|开发|设计|实现|创建|制作|重建|改造)(?:一个|一套|一款|完整的?|全套的?)?[^\n，。；]{0,24}(?:系统|应用|平台|后台|工作台|网站|门户|服务|产品|智能体|流程))/i
const CAPABILITY_CHANGE = /(?:feature request|\[feature\]|enhancement|add (?:a |an |the )?[\w-]+ (?:command|action|option|field|button)|add .{0,40}(?:login history|audit history|permission history)|add support for|does not support|allow .{0,40} to|allow configurable|should support|need the ability|missing (?:a |the )?(?:feature|ability)|功能(?:请求|建议|需求|描述)|新增.{0,40}功能|建议(?:增加|新增|添加|支持)|希望.{0,40}(?:增加|新增|添加|支持|能够|可以)|缺少.{0,30}(?:功能|能力))/i
const BOUNDED_SURFACE = /(?:\b(?:button|icon|command|control|label|copy|color|tooltip|field|flag|option|parameter|method|component|table|table column|selection|highlight|local variable|unit test|readme|documentation|tutorial|menu item|event handler|search action|permission string|parser)\b|按钮|图标|命令|控件|标签|文案|颜色|提示|字段|开关|选项|参数|方法|组件|表格|表格列|选中|高亮|局部变量|单元测试|说明文档|教程|菜单项|事件处理|搜索操作|权限字符串|解析器)/i
const BOUNDED_CAPABILITY = /(?:add .{0,30}(?:language|locale) support|search document symbols|built[- ]in .{0,30} command|新增.{0,20}(?:语言|本地化)支持|搜索文档符号|内置.{0,20}命令)/i
const LONG_CAPABILITY = /(?:underlying support for .{0,40}(?:ETL|data platform)|multi[- ]table (?:operations?|join|transform)|incremental (?:sync|synchronization).{0,80}(?:checkpoint|batch|state)|batch.{0,40}incremental (?:sync|synchronization)|作为.{0,30}(?:ETL|数据平台).{0,20}底层支持|多表(?:操作|关联|转换)|增量同步.{0,50}(?:检查点|批处理|状态)|batch.{0,30}增量同步)/i
const EXPLICIT_TARGET = /(?:`[^`\n]+`|(?:[\w.-]+\/)+[\w.@-]+|\b[\w$]+\.(?:ts|tsx|js|jsx|py|go|rs|java|kt|cpp|h|md|yml|yaml|json)\b|\b(?:function|method|class|component|command|handler)\s+[`"']?[\w$.:/-]+|第?\s*\d+\s*行|函数|方法|类|组件|命令|处理器)/i
const BROAD_SCOPE = /(?:\b(?:all|every|entire|whole)\s+(?:modules?|services?|systems?|tenants?|integrations?|components?|clients?|databases?|workflows?|documentation|docs?)\b|multiple (?:modules?|services?|systems?|integrations?|clients?|databases?)|across (?:the )?(?:repository|system|platform|stack)|across .{0,30}\bpipeline\b|全部(?:模块|服务|系统|租户|集成|组件|客户端|数据库|流程|文档)|所有(?:模块|服务|系统|租户|集成|组件|客户端|数据库|流程|文档)|多个(?:模块|服务|系统|集成|客户端|数据库)|贯穿(?:仓库|系统|平台|流水线))/i
const CROSS_BOUNDARY = /(?:cross[- ](?:module|service|tenant)|client and server|frontend and backend|storage and (?:api|ui)|api and (?:ui|storage)|multiple ownership boundaries|跨模块|跨服务|跨租户|客户端和服务端|前端和后端|存储和(?:接口|界面)|接口和(?:界面|存储)|多个所有权边界)/i
const PERSISTENT_OBJECT = /(?:database|\bDB\b|storage|schema|tenant data|production data|persisted data|backup|file keys?|audit history|数据库|存储|模式|租户数据|生产数据|持久化数据|备份|文件密钥|审计历史)/i
const PERSISTENT_STATE_MUTATION = /(?:(?:write|store|delete|drop|restore|backfill|persist|encrypt).{0,60}(?:database|records?|storage|schema|tenant data|production data|persisted data|file keys?)|(?:database|records?|storage|schema|tenant data|production data|persisted data|file keys?).{0,60}(?:write|store|delete|drop|restore|backfill|persist|encrypt)|(?:写入|存储|删除|清空|恢复|回填|持久化|加密).{0,40}(?:数据库|记录|存储|模式|租户数据|生产数据|持久化数据|文件密钥)|(?:数据库|记录|存储|模式|租户数据|生产数据|持久化数据|文件密钥).{0,40}(?:写入|存储|删除|清空|恢复|回填|持久化|加密))/i
const STATE_DAMAGE = /(?:data (?:loss|corruption)|records? (?:disappear|lost|corrupt)|cannot (?:be )?(?:accessed|decrypt(?:ed)?)|can no longer be (?:accessed|decrypt(?:ed)?)|no longer accessible|duplicate persisted|transaction deadlocks?|concurrent transaction|数据(?:丢失|损坏)|记录(?:消失|丢失|损坏)|无法解密|无法再访问|再也无法访问|持久化重复|事务死锁|并发事务)/i
const MIGRATION_STATE_FAILURE = /(?:database error.{0,100}migration|migration.{0,80}(?:database error|not executed|was not applied|missing password salt)|postSchemaChange.{0,100}(?:not applied|did not run)|数据库.{0,60}迁移.{0,60}(?:错误|失败)|迁移.{0,60}(?:未执行|未自动执行|未应用|数据库错误|导致缺少表)|passwordsalt migration missing)/i
const DATA_SEMANTICS = /(?:(?:batch|saveBatch).{0,100}(?:generated )?id.{0,100}(?:replaced|wrong|corrupt|duplicate)|pagination.{0,80}(?:total|count).{0,60}(?:records?|rows?).{0,40}(?:mismatch|wrong)|custom (?:sql|query).{0,100}(?:order|filter|cardinality)|(?:page|pagination).{0,80}(?:sorting|order).{0,80}(?:filtered|removed|wrong)|(?:批量|saveBatch).{0,80}(?:自增|生成)?ID.{0,100}(?:替换|错误|错乱|重复)|分页.{0,60}(?:total|总数).{0,50}(?:record|记录).{0,30}(?:不匹配|错误)|自定义.{0,30}(?:SQL|查询).{0,60}(?:排序|过滤|基数)|page.{0,30}排序.{0,50}(?:过滤|移除|错误))/i
const EXTERNAL_STATE_DAMAGE = /(?:breaks? (?:another|other) (?:games?|applications?|clients?)|requires? (?:a )?(?:room|device|environment) reset to recover|破坏其他(?:游戏|应用|客户端)|必须重新(?:设置|初始化)(?:房间|设备|环境)才能恢复)/i
const MULTI_TARGET_MAINTENANCE = /(?:tutorial.{0,60}every script|all (?:examples?|samples?|tutorial scripts?)|tests? (?:that are )?failing.{0,40}(?:are|include)|教程.{0,40}每个脚本|所有(?:示例|样例|教程脚本)|失败的?测试.{0,30}(?:包括|如下))/i
const AUTHORITY_OBJECT = /(?:permissions?|roles?|auth(?:entication|orization)?|oauth|sso|approval|ownership|secrets?|credentials?|license|entitlement|certificates?|\bTLS\b|CA bundle|trusted origins?|development origins?|login history|权限|角色|认证|授权|审批|所有权|密钥|凭据|许可证|证书|信任来源|开发来源|登录历史)/i
const AUTHORITY_MUTATION = /(?:(?:add|allow|change|configure|define|grant|revoke|rotate|store|expose|support).{0,80}(?:permissions?|roles?|auth(?:entication|orization)?|oauth|sso|secrets?|credentials?|login history|\bTLS\b|CA bundle|origins?|file scope)|path not allowed.{0,60}(?:configured )?scope|(?:open|unlock).{0,40}(?:door|lock)|(?:deadlock|double[- ]lock) feature|(?:新增|允许|修改|配置|定义|授予|撤销|轮换|存储|暴露|支持).{0,50}(?:权限|角色|认证|授权|密钥|凭据|登录历史|TLS|证书|来源|文件范围)|路径.{0,30}不允许.{0,30}范围|(?:打开|解锁).{0,30}(?:门|锁)|(?:反锁|双重锁)功能)/i
const IRREVERSIBLE_ACTION = /(?:(?:^|[.!?]\s+)(?:(?:please|now|then|also)\s+|(?:can|could|would)\s+you\s+)?(?:delete|drop|publish|deploy|release|charge|send|rotate|grant|revoke)\b|\b(?:please|go ahead and|make sure to)\s+(?:delete|drop|publish|deploy|release|charge|send|rotate|grant|revoke)\b|\b(?:delete|drop).{0,40}(?:production|customer|tenant) (?:data|records?)\b|(?:^|[。！？]\s*)(?:请|现在|然后|直接|同时)?(?:删除|发布|部署|上线|扣款|发送|轮换|授予|撤销)|(?:删除|清空).{0,30}(?:生产|客户|租户)(?:数据|记录))/i
const REVERSIBILITY = /(?:rollback|roll back|undo|restore|revert|dry run|preview|回滚|撤销|恢复|还原|预演|预览)/i
const MIGRATION_MENTION = /(?:\bmigrat(?:e|ion)\b|\bupgrade\b|\bdowngrade\b|\bbackfill\b|迁移|升级|降级|回填)/i
const STATE_TRANSITION_EXECUTION = /(?:\b(?:migrate|upgrade|downgrade|backfill)\b[^.!?。！？\n]{0,100}\b(?:data|database|records?|storage|service|system|platform|tenants?|configuration)\b|\b(?:data|database|records?|storage|key[- ]storage|schema)[- ]+migration\b|\bmigration\b[^.!?。！？\n]{0,80}(?:completes?|completed|succeeds?|succeeded)|\b(?:migration|upgrade|downgrade|backfill)\s+(?:plan|tool|execution|rollout|strategy)\b|(?:迁移|升级|降级|回填)[^。！？.!?\n]{0,60}(?:数据|数据库|记录|存储|服务|系统|平台|租户|配置)|(?:数据|数据库|记录|存储|服务|系统|平台|租户|配置)[^。！？.!?\n]{0,40}(?:迁移|升级|降级|回填))/i
const DYNAMIC_FACTS = /(?:requirements? (?:may|will|keep) chang(?:e|ing)|evolving requirements?|dynamic requirements?|while (?:we|you) build|facts? (?:may|will|keep) chang(?:e|ing)|dynamic(?:ally)? (?:configuration|config|policy|routing)|sync(?:ed|hronized)? from (?:a )?config(?:uration)? cent(?:er|re)|需求(?:会|可能|持续)?变化|边做边改|动态需求|过程中调整|事实(?:会|可能|持续)?变化|动态(?:修改|更新|配置|策略|路由)|配置中心(?:同步|下发))/i
const EXTERNAL_FACT_CHANGE = /(?:upstream .{0,50}(?:release|rollback|decision|change)|has(?:n't| not) released|before (?:the )?next release|partial rollback|waiting for .{0,40}(?:release|decision|approval)|上游.{0,30}(?:发布|回滚|决定|变更)|等待.{0,30}(?:发布|决定|审批)|下个版本前)/i
const DECLARED_DURATION = /(?:\b(?:several|multiple|two|three|four|five|six|seven|eight|nine|ten|\d+)\s+(?:weeks?|months?)\b|\b\d+\s*(?:hours?|days?)\s+per\s+week\b|连续.{0,12}(?:周|月)|(?:每周|每天).{0,12}(?:小时|天)|\d+\s*(?:周|个月|月|天).{0,20}(?:开发|实施|参与|执行))/i
const ADAPTIVE_SEQUENCE = /(?:based on (?:the )?(?:result|feedback|outcome).{0,80}(?:next|then|decide)|each (?:phase|stage).{0,80}(?:changes|determines|decides) the next|each (?:phase|stage) output.{0,50}(?:next|input)|after each (?:demo|review|phase).{0,80}(?:adjust|revise|decide)|根据(?:结果|反馈).{0,50}(?:下一步|再决定)|每个(?:阶段|步骤).{0,50}(?:改变|决定)下一步|每个(?:阶段|步骤)的?输出.{0,30}(?:下一步|输入)|每次(?:演示|评审|阶段)后.{0,50}(?:调整|修改|决定))/i
const COORDINATION = /(?:multi[- ]agent|subagents?|parallel agents?|multi[- ]team|multiple teams?|handoffs?|多个代理|多代理|子代理|并行代理|多个团队|交接)/i
const DELAYED_VERIFICATION = /(?:only (?:be )?(?:verified|validated|known) after (?:deployment|production|customer traffic|external review)|only (?:after|in) (?:deployment|production|customer traffic|external review)|wait for (?:customer|production|approval|downstream)|post[- ]deploy(?:ment)?|只能在(?:部署|上线|客户流量|外部评审)后|等待(?:客户|生产|审批|下游)|部署后验证|上线后验证)/i
const EXTERNAL_VERIFICATION_DEPENDENCY = /(?:(?:run|start|install|deploy|reproduce|test|open).{0,80}(?:android|ios|mobile|emulator|simulator|physical device|phone|headset|hardware)|(?:android|ios|mobile|emulator|simulator|physical device|phone|headset|hardware).{0,80}(?:run|start|install|deploy|reproduce|test|open)|(?:运行|启动|安装|部署|复现|测试|打开).{0,50}(?:真机|模拟器|移动设备|手机|头显|硬件)|(?:真机|模拟器|移动设备|手机|头显|硬件).{0,50}(?:运行|启动|安装|部署|复现|测试|打开))/i
const ACCEPTANCE = /(?:acceptance|done when|must pass|verify|validation|success metric|expected behaviou?r|expected result|验收|完成标准|必须通过|验证|成功指标|预期行为|预期结果)/i
const OUTCOME = /(?:goal|outcome|so that|in order to|increase|reduce|prevent|ensure|expected behaviou?r|expected result|目标|结果|为了|提升|降低|避免|确保|预期行为|预期结果)/i
const SCOPE = /(?:in scope|out of scope|only|exclude|boundary|within|preserve all other|范围|不包含|仅限|边界|只修改|仅修改|保持其他)/i
const SOURCE_OF_TRUTH = /(?:source of truth|canonical|authoritative|defined by|input|output|api contract|schema defines|真源|规范来源|权威来源|由.{0,30}定义|输入|输出|接口契约|模式定义)/i
const EXPLICIT_UNKNOWN = /(?:tbd|to be decided|undecided|unknown|not sure|unspecified|figure out|which (?:behavior|source|format|policy)|feasibility|consider whether|if at all|待定|未决定|未知|不确定|未说明|需要摸索|哪种(?:行为|来源|格式|策略)|可行性|是否应该)/i
const TARGET_DISCOVERY = /(?:(?:find|locate|identify|determine).{0,60}(?:real|actual|correct)?\s*(?:owner|ownership|responsibility|target).{0,80}(?:may|might|could) (?:be|live)|(?:查找|定位|识别|确定).{0,40}(?:真正|实际|正确)?(?:所有者|归属|责任点|目标).{0,50}(?:可能|也许)(?:位于|在))/i
const OPEN_ENDED_DISCOVERY = /(?:investigate (?:the )?(?:repository|codebase).{0,100}(?:improve|change|fix).{0,40}(?:where appropriate|as needed)|(?:查阅|调查|研究)(?:仓库|代码库).{0,60}(?:适当|按需)(?:改进|修改|修复))/i
const SIMPLE_MAINTENANCE = /(?:(?:fix|correct|change|update|write|rename|summari[sz]e).{0,80}(?:typo|readme|documentation|tutorial|config default|test error message|focused test|regression test|heading|spreadsheet formula|supplied paragraph)|(?:fix|change|update).{0,60}(?:one|single) local .{0,24}(?:function|method|variable|helper)|dependency bump|version bump|(?:修复|纠正|修改|更新|编写|重命名|总结).{0,50}(?:错别字|说明文档|教程|配置默认值|测试错误文案|聚焦测试|回归测试|标题|表格公式|给定段落)|(?:修复|修改|更新).{0,40}一个局部.{0,16}(?:函数|方法|变量|辅助函数)|依赖升级|版本升级)/i
const INFORMATIONAL_REQUEST = /^(?:what|why|how|where|when|who|is|are|do|does|can|could|should|explain|summari[sz]e|review|请问|什么|为什么|怎么|如何|哪里|是否|能否|解释|总结|审查)/i
const TRACKING_INTENT = /(?:\b(?:tracking|umbrella) issue\b|this issue (?:is for|tracks?|will track)\b|(?:this|the) (?:enhancement|issue) tracks?\b|tracks? all (?:coding )?work\b|track(?:ing)? (?:the )?(?:remaining work|progress|implementation|todo items?)|implementation roadmap|epic tracking|follow[- ]ups?|(?:跟踪|追踪)(?:\s*issue|问题|事项|进度|实现|TODO)|此 (?:issue|问题|增强)(?:用于|将)(?:跟踪|追踪)|伞状问题|路线图|后续事项)/im
const PROGRAM_MILESTONE = /(?:alpha release target|beta release target|stable release target|code (?:change|implementation|deliverable)|docs? (?:change|deliverable)|benchmark (?:change|deliverable|result)|客户端(?:交付|轨道)|服务端(?:交付|轨道)|文档(?:交付|更新|轨道))/gi
const ACCEPTED_DESIGN = /(?:accepted (?:rfc|design|proposal)|approved (?:rfc|design|proposal)|已接受的?(?:RFC|设计|提案)|已批准的?(?:RFC|设计|提案))/i
const STRUCTURAL_REFACTOR = /(?:refactor.{0,80}(?:subsystem|module boundaries|architecture|pipeline|shared framework)|re-?architect|重构.{0,50}(?:子系统|模块边界|架构|流水线|共享框架)|重新设计架构)/i
const RECOVERY_UNAVAILABLE = /(?:(?:rollback|restore|recovery|downgrade).{0,60}(?:cannot|can't|failed|fails?|unavailable|does not)|(?:cannot|can't|failed|fails?|unavailable|no reliable|no working|no).{0,60}(?:rollback|restore|recover|recovery|downgrade)|(?:回滚|恢复|降级).{0,40}(?:无法|失败|不能|不可用)|(?:无法|失败|不能|没有可靠|没有可用|无).{0,40}(?:回滚|恢复|降级))/i
const ACTION = /(?:\b(?:add|build|change|configure|create|delete|deploy|design|fix|implement|migrate|move|publish|refactor|remove|rename|replace|restore|support|test|track|update|verify|write)\b|增加|搭建|修改|配置|创建|删除|部署|设计|修复|实现|迁移|移动|发布|重构|移除|重命名|替换|恢复|支持|测试|跟踪|更新|验证|写入)/i
const MUTATION_REQUEST = /(?:\b(?:add|architect|build|change|configure|create|delete|deploy|design|develop|fix|implement|make|migrate|move|produce|publish|rebuild|redesign|refactor|remove|rename|replace|restore|test|track|update|verify|write)\b|增加|做|搭建|开发|修改|配置|创建|制作|删除|部署|设计|修复|实现|迁移|移动|发布|重建|改造|重构|移除|重命名|替换|恢复|测试|跟踪|更新|验证|写入)/i
const ARTIFACT = /(?:\b(api|client|server|frontend|backend|database|storage|schema|protocol|ui|cli|docs?|documentation|tests?|migration|plugin|core|integration|generator|website)\b|(接口|客户端|服务端|前端|后端|数据库|存储|模式|协议|界面|命令行|文档|测试|迁移|插件|核心|集成|生成器|网站))/gi

function clamp(value: number, maximum = 10): number {
  return Math.max(0, Math.min(maximum, value))
}

function countMatches(text: string, pattern: RegExp): number {
  return [...text.matchAll(pattern)].length
}

function explicitStepCount(text: string): number | undefined {
  const match = text.match(/(?:([0-9]{1,3})[-\s]*(?:atomic[-\s]+)?(?:steps?|stages?|phases?)\b(?!\s+to\s+(?:reproduce|repro))|(?:预计|需要|大约|执行|分为|用)?\s*([0-9]{1,3})\s*(?:个原子)?(?:步|阶段|期))/i)
  if (match === null) return undefined
  const value = Number(match[1] ?? match[2])
  return Number.isSafeInteger(value) ? value : undefined
}

function structuralItemCount(text: string): number {
  const lineItems = countMatches(text, /(?:^|\n)\s*(?:[-*+]\s+(?:\[[ xX]\]\s+)?|\d+[.)]\s+)\S/gm)
  const inlineItems = countMatches(text, /(?:^|\s)(?:\d+[.)]|[-*+]\s+)\s*(?=\*{0,2}[\p{L}\p{N}`])/gu)
  const boldHeadings = countMatches(text, /\*\*[^*\n]{2,80}\*\*/g)
  return Math.max(lineItems, inlineItems, boldHeadings)
}

function declaredItemCount(text: string): number {
  const words: Record<string, number> = {
    one: 1, two: 2, three: 3, four: 4, five: 5, six: 6,
    seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12,
  }
  let maximum = 0
  const pattern = /\b(\d{1,3}|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\s+(?:work items?|deliverables?|milestones?|phases?|stages?)\b/gi
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

function actionClauseCount(text: string): number {
  return text.split(/[.!?。！？；;\n]+/).filter(segment => ACTION.test(segment)).length
}

function artifactKindCount(text: string): number {
  return new Set([...text.matchAll(ARTIFACT)].map(match => (match[1] ?? match[2]).toLowerCase())).size
}

function withoutEmptyTemplateFields(text: string): string {
  return text
    .replace(/(?:reproduction|expected behaviou?r|actual behaviou?r|additional context|usage scenario|related issues|重现链接|重现步骤|复现步骤|预期行为|预期结果|实际行为|实际结果|补充说明)[^\n]{0,80}_No response_/gi, '')
    .replace(/(?:check for existing issues\s+completed|search before asking\s+I had searched[^\n]*|code of conduct\s+I agree[^\n]*)/gi, '')
    .replace(/(?:^|\n)\s*(?:#{1,6}\s*)?severity\s+(?:🚨\s*)?critical:\s*data loss,?\s*app crash,?\s*security issue\s*(?=\n|$)/gim, '')
}

function withoutEnvironmentAppendix(text: string): string {
  const marker = /(?:^|\n|\s|[.!?。！？]\s*)(?:server configuration|installation method|nextcloud server version|configuration report|服务器配置|客户端配置|安装方式|Nextcloud Server 版本)\s*[:：]?/i
  const match = marker.exec(text)
  return match === null ? text : text.slice(0, match.index)
}

export function assessTaskInvariants(textInput: string, longTaskThreshold = 8): TaskInvariantAssessment {
  const text = textInput.trim()
  const semanticText = withoutEmptyTemplateFields(text)
  const coreText = withoutEnvironmentAppendix(semanticText)
  const evidence: string[] = []
  const existingBehaviorDefect = EXISTING_BEHAVIOR.test(coreText) && OBSERVED_BEHAVIOR.test(coreText)
  const expectedBehavior = EXPECTED_BEHAVIOR.test(coreText)
  const reproduction = REPRODUCTION.test(coreText)
  const explicitTarget = EXPLICIT_TARGET.test(coreText)
  const productCreation = PRODUCT_CREATION.test(coreText) && !existingBehaviorDefect
  const capabilityChange = CAPABILITY_CHANGE.test(coreText)
  const boundedSurface = BOUNDED_SURFACE.test(coreText) || BOUNDED_CAPABILITY.test(coreText) || explicitTarget
  const diagnosticClosure = existingBehaviorDefect
    && ((expectedBehavior || reproduction) && (boundedSurface || reproduction)
      || boundedSurface && OBVIOUS_INVARIANT_VIOLATION.test(coreText) && !capabilityChange)
  const broadScope = BROAD_SCOPE.test(coreText)
  const crossBoundary = CROSS_BOUNDARY.test(coreText) || broadScope
  const persistentObject = PERSISTENT_OBJECT.test(coreText)
  const stateDamage = STATE_DAMAGE.test(coreText)
  const migrationStateFailure = MIGRATION_STATE_FAILURE.test(coreText)
  const dataSemantics = DATA_SEMANTICS.test(coreText)
  const externalStateDamage = EXTERNAL_STATE_DAMAGE.test(coreText)
  const multiTargetMaintenance = MULTI_TARGET_MAINTENANCE.test(coreText)
  const crossDatabaseConcurrency = stateDamage
    && /(?:across|all|multiple|supported).{0,40}databases?|(?:跨|所有|多个|支持的?).{0,30}数据库/i.test(coreText)
  const authorityObject = AUTHORITY_OBJECT.test(coreText)
  const authorityMutation = AUTHORITY_MUTATION.test(coreText)
  const irreversible = IRREVERSIBLE_ACTION.test(coreText)
  const migrationMention = MIGRATION_MENTION.test(coreText)
  const migration = STATE_TRANSITION_EXECUTION.test(coreText)
  const volatile = DYNAMIC_FACTS.test(coreText)
  const externalFactChange = EXTERNAL_FACT_CHANGE.test(coreText)
  const adaptiveSequence = ADAPTIVE_SEQUENCE.test(coreText)
  const coordinated = COORDINATION.test(coreText)
  const delayedVerification = DELAYED_VERIFICATION.test(coreText)
  const externalVerificationDependency = EXTERNAL_VERIFICATION_DEPENDENCY.test(coreText)
  const acceptance = ACCEPTANCE.test(coreText)
  const outcome = OUTCOME.test(coreText) || expectedBehavior
  const scope = SCOPE.test(coreText)
  const truth = SOURCE_OF_TRUTH.test(coreText)
  const unknown = EXPLICIT_UNKNOWN.test(coreText.replace(/unknown error/gi, ''))
  const targetDiscoveryRequired = TARGET_DISCOVERY.test(coreText)
    || OPEN_ENDED_DISCOVERY.test(coreText)
    || /^(?:the )?(?:parser|build|command|app|system) (?:fails?|is broken)\.?\s*(?:fix it\.?)?$/i.test(coreText)
  const maintenance = SIMPLE_MAINTENANCE.test(coreText)
  const informationalRequest = (INFORMATIONAL_REQUEST.test(text)
      || /^[^\n]{0,100}(?:吗|么)[^\n]{0,40}(?:\n|$)/u.test(text))
    && !MUTATION_REQUEST.test(text)
  const tracking = TRACKING_INTENT.test(coreText)
  const structuralRefactor = STRUCTURAL_REFACTOR.test(coreText)
  const recoveryUnavailable = (RECOVERY_UNAVAILABLE.test(coreText)
      || /data format.{0,120}already migrated/i.test(coreText) && /(?:does not|won't|cannot) start/i.test(coreText)
      || /(?:migration|upgrade).{0,80}(?:bring|brings|brought) down (?:the )?(?:upgrade|server)/i.test(coreText)
      || migration && stateDamage)
    && (persistentObject || migration)
  const explicitSteps = explicitStepCount(coreText)
  const structuredItems = structuralItemCount(coreText)
  const declaredItems = declaredItemCount(coreText)
  const actionClauses = actionClauseCount(coreText)
  const artifactKinds = artifactKindCount(coreText)
  const issueReferences = countMatches(coreText, /(?:#\d{2,}|(?:issues?|pull)\/\d+)/gi)
  const programMilestones = countMatches(coreText, PROGRAM_MILESTONE)
  const multiItemProgram = Math.max(structuredItems, declaredItems, actionClauses, issueReferences, programMilestones) >= 3
  const programCommitment = (tracking && (multiItemProgram
      || ACCEPTED_DESIGN.test(coreText)
      || /unresolved design|未解决的?设计/i.test(coreText)
      || /tracks? all (?:coding )?work|various TODO items|from (?:alpha|beta) to (?:GA|stable)|跟踪全部(?:编码|实现)工作|从(?:alpha|beta).{0,20}(?:GA|稳定版)/i.test(coreText)))
    || ACCEPTED_DESIGN.test(coreText) && (crossBoundary || actionClauses >= 2)
    || /follow[- ]ups? to .{0,80}migration|(?:迁移|重构).{0,40}后续事项/i.test(coreText)
    || programMilestones >= 3
  const crossArtifactCommitment = crossBoundary
    || programCommitment && artifactKinds >= 2
  const stateImpact = migration || stateDamage || migrationStateFailure
    || PERSISTENT_STATE_MUTATION.test(coreText)

  let mutationEpochs = 1
  const boundedCapability = BOUNDED_CAPABILITY.test(coreText)
  const executionStructureRelevant = programCommitment
    || productCreation
    || structuralRefactor
    || capabilityChange && !boundedCapability
  mutationEpochs = Math.max(mutationEpochs, explicitSteps ?? 0, declaredItems)
  if (executionStructureRelevant) {
    mutationEpochs = Math.max(mutationEpochs, actionClauses, Math.ceil(structuredItems / 2))
  }
  if (crossArtifactCommitment) mutationEpochs = Math.max(mutationEpochs, 3)
  if (multiTargetMaintenance) mutationEpochs = Math.max(mutationEpochs, 3)
  if (crossDatabaseConcurrency) mutationEpochs = Math.max(mutationEpochs, longTaskThreshold)
  if (broadScope && artifactKinds >= 3) mutationEpochs = Math.max(mutationEpochs, longTaskThreshold)
  if (programCommitment) mutationEpochs = Math.max(mutationEpochs, 5)
  if (migration && broadScope) mutationEpochs = Math.max(mutationEpochs, longTaskThreshold)
  if (structuralRefactor && (crossBoundary || authorityObject)) mutationEpochs = Math.max(mutationEpochs, longTaskThreshold)
  if (LONG_CAPABILITY.test(coreText) && capabilityChange && !existingBehaviorDefect) {
    mutationEpochs = Math.max(mutationEpochs, longTaskThreshold)
  }
  if (adaptiveSequence || coordinated) mutationEpochs = Math.max(mutationEpochs, 4)

  const declaredLongHorizon = (explicitSteps ?? 0) >= longTaskThreshold
    || declaredItems >= longTaskThreshold
    || programCommitment
    || DECLARED_DURATION.test(coreText)

  let outcomeClarity = 0
  if (existingBehaviorDefect || outcome || acceptance) outcomeClarity += 1
  if (diagnosticClosure || outcome && acceptance) outcomeClarity += 1
  outcomeClarity = clamp(outcomeClarity, 2)

  let verificationClarity = 0
  if (expectedBehavior || acceptance || diagnosticClosure) verificationClarity += 1
  if (/(?:test|assert|metric|screenshot|recording|exit code|fixture|测试|断言|指标|截图|录屏|退出码|夹具)/i.test(text)) verificationClarity += 1
  verificationClarity = clamp(verificationClarity, 2)

  let staleMutationImpact = 0
  if (stateImpact) staleMutationImpact += 3
  if (dataSemantics) staleMutationImpact += 4
  if (externalStateDamage) staleMutationImpact += 3
  if (authorityMutation) staleMutationImpact += 4
  else if (authorityObject && !diagnosticClosure) staleMutationImpact += 2
  if (irreversible) staleMutationImpact += 5
  if (crossBoundary) staleMutationImpact += 2
  if (recoveryUnavailable) staleMutationImpact += 4
  if (/(?:public api|wire protocol|backward compatibility|external users?|customer data|production|公共接口|线协议|向后兼容|外部用户|客户数据|生产)/i.test(coreText)) staleMutationImpact += 2
  staleMutationImpact = clamp(staleMutationImpact)

  let basisExpiryExposure = 0
  if (declaredLongHorizon) basisExpiryExposure += 6
  else if (mutationEpochs >= 4 && executionStructureRelevant) basisExpiryExposure += 3
  else if (mutationEpochs >= 2 && executionStructureRelevant) basisExpiryExposure += 1
  if (programCommitment) basisExpiryExposure += 4
  if (crossArtifactCommitment) basisExpiryExposure += 2
  if (crossDatabaseConcurrency) basisExpiryExposure += 5
  if (migration && broadScope) basisExpiryExposure += 5
  if (structuralRefactor && (crossBoundary || authorityObject)) basisExpiryExposure += 5
  if (volatile) basisExpiryExposure += 6
  if (externalFactChange) basisExpiryExposure += 6
  if (adaptiveSequence) basisExpiryExposure += 7
  if (coordinated) basisExpiryExposure += 6
  if (delayedVerification) basisExpiryExposure += 3
  if (authorityObject && capabilityChange && mutationEpochs >= 4) basisExpiryExposure += 4
  basisExpiryExposure = clamp(basisExpiryExposure)

  const basisInvalidationChannels = [
    ...(declaredLongHorizon ? ['long-horizon context replacement'] : []),
    ...(programCommitment ? ['multi-stage program state'] : []),
    ...(crossArtifactCommitment && mutationEpochs >= 3 ? ['cross-artifact intermediate state'] : []),
    ...(volatile ? ['changing accepted facts or requirements'] : []),
    ...(externalFactChange ? ['changing external source of truth'] : []),
    ...(adaptiveSequence ? ['earlier-stage feedback'] : []),
    ...(coordinated ? ['executor handoff or parallel copies'] : []),
    ...(delayedVerification ? ['verification delayed beyond later mutations'] : []),
  ]

  let definitionGap = 0
  const definitionSensitive = productCreation
    || capabilityChange && !boundedSurface
    || unknown
    || authorityMutation
    || stateImpact
    || crossArtifactCommitment
    || structuralRefactor
  if (definitionSensitive) {
    if (!outcome) definitionGap += 2
    if (!boundedSurface && !scope) definitionGap += 2
    if (!truth && (stateImpact || crossArtifactCommitment || authorityMutation)) definitionGap += 2
    if (!acceptance && !diagnosticClosure) definitionGap += 2
    if (!REVERSIBILITY.test(coreText) && (irreversible || migration)) definitionGap += 2
  }
  if (unknown) definitionGap += 2
  if (externalVerificationDependency) definitionGap += 4
  if (existingBehaviorDefect && !diagnosticClosure && !boundedSurface) definitionGap += 2
  definitionGap = clamp(definitionGap)
  const basisCompleteness = clamp(10 - definitionGap)

  const boundaryCoupling = clamp(
    (crossBoundary ? 4 : 0)
      + (stateImpact ? 2 : 0)
      + (authorityMutation ? 2 : 0)
      + (structuralRefactor ? 4 : 0)
      + (crossArtifactCommitment ? 2 : 0),
  )
  const changeVolatility = clamp((volatile ? 7 : 0) + (unknown ? 3 : 0) + (adaptiveSequence ? 3 : 0))
  const authorityImpact = staleMutationImpact
  const coordinationLoad = clamp((coordinated ? 6 : 0) + (programCommitment ? 3 : 0) + (mutationEpochs >= 4 ? 2 : 0))
  const executionSpan = clamp(basisExpiryExposure + (productCreation ? 2 : 0) + (structuralRefactor ? 2 : 0))
  const reversible = !irreversible || REVERSIBILITY.test(coreText)
  const singleMutationEpoch = mutationEpochs <= 2

  const boundedCapabilityChange = (capabilityChange || boundedCapability)
    && boundedSurface
    && !unknown
    && !broadScope
    && (boundedCapability || actionClauses <= 2)
  const directBoundedAction = boundedSurface
    && !productCreation
    && (!capabilityChange || boundedCapabilityChange)
    && (existingBehaviorDefect || acceptance || outcome || verificationClarity > 0 || actionClauses <= 1)
  const boundedChange = (maintenance || diagnosticClosure || boundedCapabilityChange || directBoundedAction)
    && singleMutationEpoch
    && !crossArtifactCommitment
    && !volatile
    && !adaptiveSequence
    && !coordinated
    && !delayedVerification
    && !structuralRefactor
    && staleMutationImpact <= 3
    && definitionGap <= 2
    && reversible

  if (diagnosticClosure) evidence.push('closed observable defect oracle')
  else if (existingBehaviorDefect) evidence.push('observable defect with an incomplete mutation basis')
  if (productCreation) evidence.push('new product or system outcome')
  if (capabilityChange) evidence.push('new capability semantics')
  if (boundedChange) evidence.push('one stable mutation epoch with a closed basis')
  if (crossArtifactCommitment) evidence.push('intent must remain aligned across artifacts or boundaries')
  if (stateImpact) evidence.push('persistent state semantics are changed or damaged')
  if (authorityMutation) evidence.push('authority semantics are changed')
  if (irreversible) evidence.push('potentially irreversible side effect')
  if (migration) evidence.push('state transition or migration execution')
  else if (migrationMention) evidence.push('state-transition vocabulary without an execution object')
  if (volatile) evidence.push('authoritative facts can change during execution')
  if (externalFactChange) evidence.push('an external source of truth can change before completion')
  if (adaptiveSequence) evidence.push('later work depends on feedback from earlier work')
  if (coordinated) evidence.push('multiple executors can hold divergent intent copies')
  if (delayedVerification) evidence.push('verification arrives after additional mutation opportunities')
  if (mutationEpochs >= 3) evidence.push(`${mutationEpochs} estimated mutation epochs`)
  if (programCommitment) evidence.push('multi-item program or accepted design commitment')
  if (structuralRefactor) evidence.push('structural refactor across ownership boundaries')
  if (recoveryUnavailable) evidence.push('protected state has no working recovery path')
  if (definitionGap >= 4) evidence.push('outcome-critical authority basis is incomplete')
  if (targetDiscoveryRequired) evidence.push('repository evidence is required to locate the mutation owner')

  const confidence = text.length === 0
    || (!boundedChange && basisExpiryExposure < 4 && definitionGap < 4 && staleMutationImpact < 4)
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
    basisCompleteness,
    basisExpiryExposure,
    staleMutationImpact,
    mutationEpochs,
    reversible,
    existingBehaviorDefect,
    diagnosticClosure,
    boundedChange,
    productDefinition: productCreation || capabilityChange,
    stateTransition: migration,
    irreversibleSideEffect: irreversible,
    informationalRequest,
    declaredLongHorizon,
    programCommitment,
    structuralRefactor,
    recoveryUnavailable,
    adaptiveSequence,
    delayedVerification,
    coordinated,
    crossArtifactCommitment,
    targetDiscoveryRequired,
    basisInvalidationChannels,
    confidence,
    evidence,
  }
}
