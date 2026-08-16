# V4 Router Failure Analysis

This is a deterministic derived report. The frozen V4 prompts, labels, sources, and results are not modified.

## Dataset

- Samples: 120
- Correct: 61
- Failures: 59
- Accuracy reconstructed from joined rows: 0.5083
- Frozen release gate passed: false

## Failed Classifications

| Expected -> actual | Total | Failures | Failure rate |
| --- | --- | --- | --- |
| bypass->contract | 8 | 8 | 1 |
| bypass->probe | 9 | 9 | 1 |
| contract->bypass | 16 | 16 | 1 |
| contract->lattice | 1 | 1 | 1 |
| contract->probe | 6 | 6 | 1 |
| lattice->bypass | 6 | 6 | 1 |
| lattice->contract | 6 | 6 | 1 |
| lattice->probe | 7 | 7 | 1 |

## Failures by Language

| Language | Total | Failures | Failure rate |
| --- | --- | --- | --- |
| en | 60 | 25 | 0.4167 |
| zh | 60 | 34 | 0.5667 |

## Failures by Source Repository

| Repository | Total | Failures | Failure rate |
| --- | --- | --- | --- |
| Tencent/tdesign-vue-next | 12 | 5 | 0.4167 |
| apache/dubbo | 5 | 4 | 0.8 |
| apache/seatunnel | 4 | 3 | 0.75 |
| astral-sh/ruff | 10 | 1 | 0.1 |
| baomidou/mybatis-plus | 15 | 8 | 0.5333 |
| cockroachdb/cockroach | 3 | 2 | 0.6667 |
| godotengine/godot | 2 | 2 | 1 |
| home-assistant/core | 10 | 7 | 0.7 |
| nextcloud/server | 22 | 11 | 0.5 |
| nodejs/node | 10 | 7 | 0.7 |
| oven-sh/bun | 5 | 4 | 0.8 |
| python/cpython | 1 | 0 | 0 |
| tauri-apps/tauri | 12 | 2 | 0.1667 |
| vuejs/core | 2 | 0 | 0 |
| zed-industries/zed | 7 | 3 | 0.4286 |

## Structural Comparison

| Feature | All mean | Correct mean | Failure mean |
| --- | --- | --- | --- |
| characterCount | 648.39 | 640.56 | 656.49 |
| wordCount | 155.32 | 149.66 | 161.17 |
| headingCount | 0.02 | 0 | 0.03 |
| listItemCount | 0.92 | 0.95 | 0.88 |
| actionClauseCount | 4.17 | 3.85 | 4.51 |
| pathOrCodeReferenceCount | 3.84 | 4.44 | 3.22 |

| Signal | All rate | Correct rate | Failure rate |
| --- | --- | --- | --- |
| acceptance | 0.2917 | 0.3279 | 0.2542 |
| reproduction | 0.5 | 0.6066 | 0.3898 |
| rollback | 0.0167 | 0.0164 | 0.0169 |
| permission | 0.0333 | 0.0164 | 0.0508 |
| sourceOfTruth | 0 | 0 | 0 |
| multipleDeliverables | 0.475 | 0.4918 | 0.4576 |
| stagedStructure | 0.05 | 0.0656 | 0.0339 |

## Confusion Cells

### bypass->bypass

Count: 43. Languages: {"en":23,"zh":20}. Repositories: {"Tencent/tdesign-vue-next":7,"apache/dubbo":1,"apache/seatunnel":1,"astral-sh/ruff":9,"baomidou/mybatis-plus":7,"cockroachdb/cockroach":1,"home-assistant/core":3,"oven-sh/bun":1,"python/cpython":1,"tauri-apps/tauri":7,"vuejs/core":2,"zed-industries/zed":3}.

- [v4-224](https://github.com/baomidou/mybatis-plus/issues/5088) (zh, baomidou/mybatis-plus, critical=false): SqlSessionTemplate无法调用selectById的问题 当前使用版本(必填,否则不予处理) 3.5.3 该问题是如何引起的？(确定最新版也有问题再提!!!) 理论所有版本都有问题 重现步骤(如果有就写完整) [code omitted] 报错信息 There is no getter for property named 'id' in 'class java.lang.reflect.Field' 推断的可能是BaseMapper的selectById...
- [v4-111](https://github.com/zed-industries/zed/issues/12904) (en, zed-industries/zed, critical=false): Assistant Panel: /search (semantic search) still available - but does nothing since the feature was removed. Check for existing issues Completed Describe the bug / provide steps to reproduce it In the Assistant Panel, when typing `/` sem...
- [v4-003](https://github.com/astral-sh/ruff/issues/9572) (en, astral-sh/ruff, critical=false): Bug in order of operations (PLC2801) Hi all! While updating from Ruff 0.1.11 to 0.1.13 I found a small bug in the newly created rule `PLC2801`. I had the code: [code omitted] With the auto linter Ruff fixed this to: [code omitted] The or...
- [v4-226](https://github.com/baomidou/mybatis-plus/issues/5741) (zh, baomidou/mybatis-plus, critical=false): Mybatis-plus 3.5.4 的AOP问题 当前使用版本(必填,否则不予处理) Mybatis-plus 3.5.4 Springboot 3.1.5 该问题是如何引起的？(确定最新版也有问题再提!!!) 使用任何一个batch的方法，比如：removeBatchById等，就会出现错误，这种情况在3.5.4之前的版本不存在。 重现步骤(如果有就写完整) 报错信息 class org.springframework.aop.framework.JdkDynami...
- [v4-158](https://github.com/Tencent/tdesign-vue-next/issues/5470) (zh, Tencent/tdesign-vue-next, critical=false): [Chat] 开发环境没有问题，打包后样式丢失。 tdesign-vue-next 版本 0.0.0 重现链接 _No response_ 重现步骤 1. 按照文档，通过pnpm add @tdesign-vue-next/chat安装依赖 2. 通过按需加载的方法引入 import { Chat as TChat, ChatContent as TChatContent, ChatInput as TChatInput, ChatReasoning as TChatR...

### bypass->contract

Count: 8. Languages: {"en":4,"zh":4}. Repositories: {"Tencent/tdesign-vue-next":2,"godotengine/godot":1,"home-assistant/core":2,"nextcloud/server":2,"zed-industries/zed":1}.

- [v4-103](https://github.com/zed-industries/zed/issues/33281) (en, zed-industries/zed, critical=false): Restoring all workspaces combines windows featuring same folder. Summary When the restoration setting is `"restore_on_startup": "last_session"`, windows are restored improperly across sessions if they happen to contain the same folder. I...
- [v4-067](https://github.com/home-assistant/core/issues/175195) (en, home-assistant/core, critical=false): Volumio: SEEK feature is advertised but media_seek is not implemented (raises NotImplementedError) The problem **The problem** The Volumio integration advertises the SEEK feature in supported_features, so Home Assistant shows a seekable ...
- [v4-149](https://github.com/Tencent/tdesign-vue-next/issues/4264) (zh, Tencent/tdesign-vue-next, critical=false): [image-viewer] 遮罩层打开后的鼠标滚轮缩放问题 tdesign-vue-next 版本 1.9.0 重现链接 _No response_ 重现步骤 使用图片预览控件，mode为默认打开遮罩。预览图片后，滑动鼠标滚轮，图片正常缩放，但是页面同时在滚动，控制台报错“unable to preventDefault inside passive event listener invocation”， 期望结果 我不想在main.js中取消对‘default-pa...
- [v4-162](https://github.com/Tencent/tdesign-vue-next/issues/4540) (zh, Tencent/tdesign-vue-next, critical=false): [t-menu-item] 访问“$router”变量的问题 tdesign-vue-next 版本 1.9.9 重现链接 _No response_ 重现步骤 我正在使用Laravel+inertiajs+vue的方式实现一个后台,路由部分由inertiajs提供,没有使用Vue Router.任何一个地方引入t-menu-item都会提示一个Warn [Vue warn]: Property "$router" was accessed during render ...
- [v4-program-065](https://github.com/nextcloud/server/issues/27278) (zh, nextcloud/server, critical=false): [v22.0.0beta2] 缺少 `./occ migrations` 命令 GitHub 使用方式：* 请使用 👍 表情表示你也受同一问题影响。* 如果没有相关信息要补充，请不要评论，这只会给所有订阅者增加噪声。* 订阅可接收状态变化和新评论通知。复现步骤：1. checkout 当前 master 分支或 v22.0.0beta2。2. 执行 `php ./occ migrations:`。预期行为：列出迁移命令且可以执行。实际行为：错误 `There are n...

### bypass->lattice

Count: 0. Languages: {"en":0,"zh":0}. Repositories: {}.

No samples.

### bypass->probe

Count: 9. Languages: {"en":3,"zh":6}. Repositories: {"Tencent/tdesign-vue-next":2,"apache/seatunnel":1,"baomidou/mybatis-plus":2,"cockroachdb/cockroach":2,"nodejs/node":1,"zed-industries/zed":1}.

- [v4-181](https://github.com/apache/seatunnel/issues/4512) (zh, apache/seatunnel, critical=false): 支持国产数据库吗，如人大金仓Kingbase Search before asking I had searched in the feature and found no similar feature requirement. Description 请问，支持国产数据库了吗？支持粒度咋样，如人大金仓Kingbase Usage Scenario _No response_ Related issues _No response_ Are you willing t...
- [v4-program-011](https://github.com/nodejs/node/issues/42560) (en, nodejs/node, critical=false): tracking issue: MSVC regression for 16.x and 14.x vs2022 > > I am just wondering if we should open an issue to track/identify this problem? > > Sure. I also tried to report the bug to MSVC team yesterday, but report bug entrance only in ...
- [v4-program-111](https://github.com/cockroachdb/cockroach/issues/89685) (zh, cockroachdb/cockroach, critical=false): lint-issue-epic-refs：为 issue 引用添加 `part of` 动词 **问题** 有些人使用 `part of #2392` 引用与变更相关的 issue，但 linter 不支持这个动词。**解决方案** 将 `Part of` 动词加入 linter 接受的动词。Epic DEVINF-261。Jira issue：CRDB-20373
- [v4-213](https://github.com/baomidou/mybatis-plus/issues/5850) (zh, baomidou/mybatis-plus, critical=false): TenantLineHandler 多组户插件问题，@InterceptorIgnore是不是只能忽略一个自定义的mapper 我想忽略一个使用QueryMapper的selectList的查询，目前是通过自己写一个mapper替代QueryMapper方式，再加上注解，是否有更好的方式呢
- [v4-program-115](https://github.com/cockroachdb/cockroach/issues/90303) (en, cockroachdb/cockroach, critical=false): commit msg template: add issue and epic ref templates **The Problem** When writing a commit message, it would be nice to have a template for issue and epic refs both to have at hand to use and as a reminder to add them. **Proposed soluti...

### contract->bypass

Count: 16. Languages: {"en":8,"zh":8}. Repositories: {"Tencent/tdesign-vue-next":1,"apache/dubbo":1,"astral-sh/ruff":1,"baomidou/mybatis-plus":4,"home-assistant/core":3,"nextcloud/server":3,"oven-sh/bun":1,"tauri-apps/tauri":2}.

- [v4-078](https://github.com/home-assistant/core/issues/123217) (en, home-assistant/core, critical=true): Yale Unity Entrance Lock Support Deadlock Feature The problem It would be great if the integration could support the deadlock feature on the Unity Range. In the Yale Home app, when you hold down the lock button while it's showing a red c...
- [v4-064](https://github.com/home-assistant/core/issues/126400) (en, home-assistant/core, critical=true): Tuya AHD monitor don't have main feature - open the lock The problem In the `integration: tuya`, the AHD Monitor is missing a key feature – the ability to open the lock. <img width="1073" alt="Screenshot 2024-09-21 at 21 21 28" src="[lin...
- [v4-219](https://github.com/baomidou/mybatis-plus/issues/5454) (zh, baomidou/mybatis-plus, critical=true): KtQueryWrapper和KtUpdateWrapper泛型限制问题 当前使用版本(必填,否则不予处理) 3.5.3.1 该问题是如何引起的？(确定最新版也有问题再提!!!) 源码中KtQueryWrapper继承的Query接口传的泛型是KProperty<*>，代码如下： [code omitted] 会导致在使用的时候，没有泛型进行约束，比如下面这段代码也可以编译通过 [code omitted] 我目前尝试改动泛型为KMutableProperty1<T, ...
- [v4-022](https://github.com/astral-sh/ruff/issues/10013) (en, astral-sh/ruff, critical=true): Bug report: I001 not working properly Command: `poetry run ruff format` Code: [code omitted] isort via flake8 highlights this as an issue, because it is sorted incorrectly. But ruff doesn't seem to have any issue. Subsection of ruff sett...
- [v4-214](https://github.com/baomidou/mybatis-plus/issues/5873) (zh, baomidou/mybatis-plus, critical=true): 从3.5.3升级到3.5.4.1后遇到的问题 在项目中自定义了字段的加解密的注解和拦截器，当使用selectOne进行查询到数据后，执行解密拦截器，对带有加密注解的字段进行解密，但是拿不到查询到的数据，invocation.proceed() 是空的

### contract->contract

Count: 13. Languages: {"en":9,"zh":4}. Repositories: {"nextcloud/server":9,"nodejs/node":1,"tauri-apps/tauri":3}.

- [v4-047](https://github.com/tauri-apps/tauri/issues/8598) (en, tauri-apps/tauri, critical=true): [bug] Error No available Android Emulator detected Describe the bug I have a bearbone project generated with cargo create-tauri-app --alpha (v2.0.0.alpha.20) that I want to run on android emulator. Everything runs without errors but the ...
- [v4-program-057](https://github.com/nextcloud/server/issues/42359) (zh, nextcloud/server, critical=true): [Bug]：从 27 升级到 28 失败，错误为“Database error when running migration XXX for app core” ⚠️ 此 issue 符合以下事项：⚠️ 这是一个 **bug**，不是问题咨询或配置/Web 服务器/代理问题。Github 或 Nextcloud Community Forum 上**尚未**报告此 issue（我已搜索）。Nextcloud Server **已**更新到最新版本。请参阅 Mainten...
- [v4-program-061](https://github.com/nextcloud/server/issues/39658) (zh, nextcloud/server, critical=true): [Bug]：由于迁移未自动执行，LLM 文本处理 API 失败 ⚠️ 此 issue 符合以下事项：⚠️ 这是一个 **bug**，不是问题咨询或配置/Web 服务器/代理问题。Github 或 Nextcloud Community Forum 上**尚未**报告此 issue（我已搜索）。Nextcloud Server **已**更新到最新版本。请参阅 Maintenance and Release Schedule 了解支持的版本。我同意遵守 Nextcloud...
- [v4-program-053](https://github.com/nextcloud/server/issues/41763) (en, nextcloud/server, critical=true): [Bug]: Database error when running migration 28000Date20230906104802 ⚠️ This issue respects the following points: ⚠️ This is a **bug**, not a question or a configuration/webserver/proxy issue. This issue is **not** already reported on Gi...
- [v4-program-091](https://github.com/nextcloud/server/issues/59631) (en, nextcloud/server, critical=true): [Bug]: Exception: Database error when running migration 33000Date20251023120529 for app core ⚠️ This issue respects the following points: ⚠️ This is a **bug**, not a question or a configuration/webserver/proxy issue. This issue is **not*...

### contract->lattice

Count: 1. Languages: {"en":0,"zh":1}. Repositories: {"nextcloud/server":1}.

- [v4-program-094](https://github.com/nextcloud/server/issues/30103) (zh, nextcloud/server, critical=true): 异常：运行 app core 的最新迁移时数据库错误 GitHub 使用方式：* 请使用 👍 表情表示你也受同一问题影响。* 如果没有相关信息要补充，请不要评论，这只会给所有订阅者增加噪声。* 订阅可接收状态变化和新评论通知。复现步骤：1. 迁移到 Nextcloud 23.0。2. 3. 预期行为：迁移成功完成。实际行为：数据库 schema 更新期间出错；我认为原因是日志中的这一行：[code omitted]。服务器配置：**操作系统：** openSUSE Le...

### contract->probe

Count: 6. Languages: {"en":1,"zh":5}. Repositories: {"apache/dubbo":3,"baomidou/mybatis-plus":1,"godotengine/godot":1,"zed-industries/zed":1}.

- [v4-128](https://github.com/apache/dubbo/issues/12168) (zh, apache/dubbo, critical=true): 2.7这种低版本调用3.x高版本问题很多，尤其是用应用级发现的情况，两个版本元数据差别很大，2.7的使用还存在部分选择cloud-dubbo的干扰，个人感觉还是按服务依赖关系从下到上逐步进行3版本的切换 已经解决了，很小的问题。还是不够细啊！
- [v4-099](https://github.com/zed-industries/zed/issues/14876) (en, zed-industries/zed, critical=true): Add a laser pointer to the collaboration feature Describe the feature Sometimes its hard to follow what the other person is talking about so it would be cool if there is a cursor or laser pointer.
- [v4-132](https://github.com/apache/dubbo/issues/12172) (zh, apache/dubbo, critical=true): mesh模式mock无效问题 版本3.1.8 跟了下代码 staticDirectory 没有 routeChain，最终没有选用mock的invoke 跟云大沟通先建一个issue
- [v4-218](https://github.com/baomidou/mybatis-plus/issues/5976) (zh, baomidou/mybatis-plus, critical=true): page排序机制在高版本下自动被过滤 等于号= 问题 当前使用版本(必填,否则不予处理) 3.5.5 该问题是如何引起的？(确定最新版也有问题再提!!!) 早期代码如下： page.addOrder(OrderItem.asc("dept_name")) .addOrder(OrderItem.asc("CASE " + "WHEN comXX = 'XX' THEN 1 " + "WHEN comXX = 'XX' THEN 2 " + "ELSE 3 " + "EN...
- [v4-144](https://github.com/apache/dubbo/issues/12317) (zh, apache/dubbo, critical=true): Dubbo3 生成Triple协议代码时，.Dubbo3TripleGenerator不支持getSingleTemplateFileName的问题 I have searched the issues of this repository and believe that this is not a duplicate. Ask your question here 目前正在尝试使用Dubbo 3.2.0版本，根据Protobuffer 的IDL文件生成Java源代码...

### lattice->bypass

Count: 6. Languages: {"en":3,"zh":3}. Repositories: {"apache/seatunnel":1,"baomidou/mybatis-plus":1,"home-assistant/core":1,"nextcloud/server":1,"nodejs/node":1,"oven-sh/bun":1}.

- [v4-211](https://github.com/baomidou/mybatis-plus/issues/5918) (zh, baomidou/mybatis-plus, critical=true): 能否在插入或者更新前提供一个排序策略，防止死锁问题 当前使用版本(必填,否则不予处理) 3.5.5 该问题是如何引起的？(确定最新版也有问题再提!!!) 并发更新问题 重现步骤(如果有就写完整) 在并发批量更新时，出现相互等待，出现的索引。 事务1：update A SET xx =1 WHERE id =1, update A SET xx =1 WHERE id =2 事务2：update A SET xx =1 WHERE id =2, update A SET ...
- [v4-program-008](https://github.com/nodejs/node/issues/57739) (zh, nodejs/node, critical=true): tracking-id 网站 <template> <div class="tracking-container"> <h1>跟踪您的货件</h1> <input v-model="trackingID" placeholder="输入跟踪 ID" /> <button @click="fetchTrackingStatus">跟踪</button><div v-if="trackingData"> <h2>状态：{{ trackingData.status }}</h...
- [v4-program-033](https://github.com/oven-sh/bun/issues/17733) (en, oven-sh/bun, critical=true): tracking: get node's node:child_process tests to 100%
- [v4-184](https://github.com/apache/seatunnel/issues/6913) (zh, apache/seatunnel, critical=true): [Feature][Core] The feasibility of seatunnel as an underlying support for an ETL tool（seatunnel作为ETL工具的底层支持的可行性） Search before asking I had searched in the feature and found no similar feature requirement. Description The feasibility of ...
- [v4-085](https://github.com/home-assistant/core/issues/158129) (en, home-assistant/core, critical=true): Feature Request: Support Multiple Streams Per Camera Entity The problem Description: The Problem Home Assistant's camera entity architecture currently supports only one stream source per camera entity. This limitation affects multiple in...

### lattice->contract

Count: 6. Languages: {"en":2,"zh":4}. Repositories: {"apache/seatunnel":1,"home-assistant/core":1,"nextcloud/server":3,"nodejs/node":1}.

- [v4-program-009](https://github.com/nodejs/node/issues/54796) (zh, nodejs/node, critical=true): 讨论/跟踪：为 Node.js 测试增加更多结构 众所周知，其他运行时（Deno、Bun、Workers 等）正在寻求提高与 Node.js 的兼容性。为此，这些运行时需要能够运行 Node.js 的测试，因为这些测试实际上是我们最接近一致性测试套件的东西。然而，挑战在于当前测试语料大多是缺乏结构的代码块，它们将公共 API 测试与内部 API 测试混在一起，并使用依赖 Node.js 特有特性的定制测试框架。这使其他运行时难以部分或选择性地实现 Node.js 兼容性...
- [v4-065](https://github.com/home-assistant/core/issues/127613) (en, home-assistant/core, critical=true): Feature Request: User Login History The problem I believe it would be a valuable addition to Home Assistant to include a feature that displays the history of user logins. This would provide users with a clear record of when and how diffe...
- [v4-program-105](https://github.com/nextcloud/server/issues/57599) (en, nextcloud/server, critical=true): [Bug]: Failed Upgrade to v32.0.4 with failed db-migration ⚠️ This issue respects the following points: ⚠️ This is a **bug**, not a question or a configuration/webserver/proxy issue. This issue is **not** already reported on Github OR Nex...
- [v4-186](https://github.com/apache/seatunnel/issues/5426) (zh, apache/seatunnel, critical=true): [Feature][batch模式增加增量同步] batch模式支持增量同步功能 Search before asking I had searched in the feature and found no similar feature requirement. Description 比如mysql 或者Mongodb经常使用的数据源，希望batch模式增加增量同步，如果是每天同步的话，不需要增量，可以按照时间同步前一天的，但是如果是按照几十分钟或者小时级别同步增...
- [v4-program-098](https://github.com/nextcloud/server/issues/50909) (zh, nextcloud/server, critical=true): 评估从 PHP 逐步迁移到 Rust 的提案 摘要：我建议 Nextcloud 考虑将关键系统组件从 PHP 逐步、战略性地迁移到 Rust，目标是提高性能、安全性和可扩展性。理由：- 性能：Rust 提供可与 C/C++ 相比的速度，同时资源消耗更低。- 安全性：Rust 的所有权系统可防止内存错误和漏洞。- 并发：更好地处理并行操作以提高可扩展性。- 互操作性：在保持与现有 PHP 代码兼容的同时，可以逐步迁移。- 可持续性：该语言的社区和企业支持不断增长。初始用例...

### lattice->lattice

Count: 5. Languages: {"en":3,"zh":2}. Repositories: {"nextcloud/server":2,"nodejs/node":2,"zed-industries/zed":1}.

- [v4-program-079](https://github.com/nextcloud/server/issues/37627) (en, nextcloud/server, critical=false): follow-up to files_trashbin to vue migration Follow-ups to [link] Bugfixes: Improve loading indicator for actions Breadcrumbs show `Foldername.dTIMESTAMP` when browsing a deleted folder, in the old implementation we just showed `Folderna...
- [v4-program-004](https://github.com/nodejs/node/issues/38173) (en, nodejs/node, critical=true): [Tracking Issue] Refactoring DNS This issue just serves as heads up and a tracking issue. I have kicked off a refactoring the dns subsystem within core. The current implementation is aging, inefficient, and rather inflexible. As part of ...
- [v4-program-015](https://github.com/nodejs/node/issues/44014) (zh, nodejs/node, critical=true): 跟踪 issue：运行时用户空间快照中的内置模块支持和 V8 问题 此 issue 用于跟踪运行时用户空间快照的已知 bug 和限制。Node.js 内置模块中当前已知的限制/bug：支持产生系统请求的模块，例如 net、http（不支持这些请求本身的快照，因为我们无法恢复它们；但在所有待处理请求完成后，用户应能够对应用创建快照）。`process` 对象上的某些全局事件监听器需要在快照序列化期间移除，并在反序列化期间重新安装。支持用户空间模块。与 SEA（单一可执行应...
- [v4-092](https://github.com/zed-industries/zed/issues/47040) (en, zed-industries/zed, critical=true): Feature Request: Allow starting new chat sessions within same agent thread context Problem When working on long coding sessions with the Agent panel, the context window fills up (e.g., 8k/129k tokens used). Currently there's no way to st...
- [v4-program-052](https://github.com/nextcloud/server/issues/26237) (zh, nextcloud/server, critical=true): 如果应用安装失败，迁移不会回滚 GitHub 使用方式：* 请使用 👍 表情表示你也受同一问题影响。* 如果没有相关信息要补充，请不要评论，这只会给所有订阅者增加噪声。* 订阅可接收状态变化和新评论通知。一般描述：我们在评估 nextcloud/cookbook#634 时发现一个表明 core 存在问题的现象。这似乎是异常处理流程中的 bug，过去也发生过。因此，这里只是重建当时发生的情况，很抱歉无法更精确。该问题似乎在几个条件同时满足时出现：- NC 安装于预发布（...

### lattice->probe

Count: 7. Languages: {"en":4,"zh":3}. Repositories: {"nextcloud/server":1,"nodejs/node":4,"oven-sh/bun":2}.

- [v4-program-012](https://github.com/nodejs/node/issues/53572) (zh, nodejs/node, critical=false): 跟踪 REPL 变更 大家好！我一直在处理 issue #52965，有人建议我以增量方式提出对当前 REPL 的改进，而不是进行全面重做。此 issue 将跟踪我的进度，这样任何建议都可以在不打扰审查者的情况下提出。以下是我计划实现的变更：**语法高亮** #53571 **仅使用 `vm`，不使用 `inspector` 会话** 迁移为仅使用 VM 后，REPL 将能在重要内部机制被删除后继续工作，因为它会在不同的上下文中运行。此外，它还能让 REPL 同时运行于...
- [v4-program-032](https://github.com/oven-sh/bun/issues/121) (zh, oven-sh/bun, critical=true): 支持边缘打包（跟踪） 什么是边缘打包？不是预先在 CI 中打包和压缩，而是在 HTTP 请求即将发送给客户端之前惰性执行，然后将结果缓存在边缘。“edge bundling”这个说法是我自己创造的。Bun 足够快，可以支持这种做法，但还需要构建更多基础设施才能把它做好。将 esbuild 的 JavaScript 压缩器移植到 Bun 的 JavaScript 解析器。将 esbuild 的 CSS 解析器移植到 Bun（包括压缩器）。实现 tree-shaking。实...
- [v4-program-040](https://github.com/oven-sh/bun/issues/15964) (en, oven-sh/bun, critical=false): `Worker` & `worker_threads` stability tracking issue When using `Worker` or `worker_threads` in Bun, I strongly suggest not calling `.terminate` or otherwise, ensuring they stay alive and reusing them instead of creating temporary ones a...
- [v4-program-001](https://github.com/nodejs/node/issues/35711) (zh, nodejs/node, critical=false): 跟踪 issue：Node.js 核心中的快照集成 这是在我们发布嵌入式快照之后对 [link] 的延续。由于原 issue 中的大部分讨论已经解决，因此新开一个 issue；现在我们重点关注：1. 将更多启动过程移入嵌入式快照 2. 启用用户空间快照。关于技术细节的讨论，请使用设计文档：[link]。此 issue 用于跟踪进度。
- [v4-program-010](https://github.com/nodejs/node/issues/53924) (en, nodejs/node, critical=false): Tracking issue: stabilization of test runner code coverage What is the problem this feature will solve? This issue is for tracking remaining work to stabilize code coverage in the test runner. When this feature originally shipped, it had...
