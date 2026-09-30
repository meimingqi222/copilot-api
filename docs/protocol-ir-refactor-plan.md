# 协议翻译内核重构方案：翻译路径 IR、能力预检与损失契约

状态：**全部跨端点方向已实施；Gemini 公共协议已试点；web_search 意图与事件语义已落地**
日期：2026-09-30
目标：补齐跨协议能力，降低新增协议和上游特性时的重复实现与回归成本。

实施记录（2026-09-30）：

- `src/services/ir/` 已包含类型化请求/结果、增量事件、collector、能力预检和脱敏损失记录；四个 `via-*` wrapper 已切换到 IR codec。
- 路由现在枚举可用端点；原生路径优先，语义拒绝会尝试下一候选且不冷却凭证。`AGENTS.md` 与翻译规约已更新。
- 历史 pair translator 已全部删除。Copilot adapter 内部按模型能力自行做 Chat↔Responses 翻译的私有实现（`chat-to-responses*`、`responses-to-chat`）也随之移除：端点选择统一由 `buildRouteTargets` 负责，翻译统一走 IR wrapper，Copilot 与其它 provider 一样只按 `target.endpoint` 调用本协议端点。WS 直连路径（`createResponses`）的 chat 回退同样改走 `createResponsesViaChat`。
- Gemini 公共协议试点、`messages ↔ responses` 路由和代理级 `web_search` 编排属于新增能力，待有明确客户端需求时实施；不引入未被调用的 codec。

实施记录（Phase 4，2026-09-30）：

- **`messages ↔ responses` 双向开放**。`resolveEndpoints` 的 fallback 表补全为「任一端点可回退到其余三个」；新增 `messages-via-responses.ts` 与 `responses-via-messages.ts`，复用既有 IR codec。`unified-routing.test.ts` 与两个新路由测试覆盖请求/响应两个方向。
- **Gemini 公共协议试点完成**。新增 `IRWire = "gemini"`、`codecs/gemini/`（请求/结果/流）、`protocols/gemini-compatible.ts` adapter、`gemini-compatible` 协议与 `gemini` endpoint、`routes/gemini/`（`/v1beta/models/{model}:generateContent` 与 `:streamGenerateContent`）。真实成本：1 个 wire codec（4 文件）+ 1 个 adapter + 1 个路由 + 1 张表项，**没有与每个既有协议成对新增翻译器**。
- **表驱动翻译路径**。Gemini 的六个方向（gemini→chat/messages/responses 与反向）由 `services/protocols/wire-pairs.ts` 的一张 `WireSpec` 表组装，`createTranslatedCall` 是唯一的预检/编码/调度入口。手写 wrapper 只保留存在专属行为（缓存断点、结构化流 twin、memory trace、SSE 帧形状）的既有四条。
- **`web_search` 代理编排已实施**（见 Phase 5）。IR 新增 `generation.webSearch` / `webSearchOptions`（意图）与 `IRServerToolUsePart` / `IRWebSearchResultPart`（事件）；messages 与 responses 已能双向保留，chat 对当前轮 `reject`、对历史 `drop`，Gemini 只保留 `google_search` 意图。任一目标都无法原生承载时仍然明确拒绝，符合 §3 的「不能静默丢弃」。

## 0. 决策摘要

同协议请求继续由现有 adapter 处理；需要跨端点翻译时，使用类型化的请求 IR、增量流事件和响应结果。翻译前先判断目标是否能承载本次请求，翻译中记录转换和损失。IR 只覆盖本项目承诺支持的语义，不声称能无损容纳未来所有协议字段。

本方案的成功标准是：新增协议或能力时，公共语义只定义一次，协议 codec 只处理本协议的 wire，目标特例有明确归属和测试；客户端不会因静默丢失关键内容而收到貌似成功的回答。

## 1. 第一性原理

跨协议代理必须同时满足三个条件：

1. **有效**：发给上游的请求与回给客户端的响应符合各自协议及目标模型的约束。
2. **保意图**：图片、工具限制、推理块、缓存断点等会影响结果的语义尽量保留；改变位置或表示形式时，转换必须有明确规则。
3. **可解释**：目标无法表达某项语义时，在发送前选择其他候选、明确拒绝，或按已定义策略降级并记录。记录损失不能代替正确选路。

信息一旦在 decode 时被丢弃，encode 无法恢复；目标本身没有的能力，IR 也无法创造。例如 Responses 的 file_id 没有可移植的图片字节或 URL，Anthropic 签名也不能为修改过的 thinking 文本重新签发。因此目标不是“所有协议字段的永久超集”，而是**当前承诺能力的最小充分语义模型**，随能力需求受控扩展。

Chat Completions JSON 继续作为一种外部 wire，不再是跨协议翻译的内部枢纽。同端点路径绕过 IR 可以减少跨协议损失，但 adapter 仍可能做模型名、请求字段和提供方兼容处理；“直通”不等于字节级原样转发。

## 2. 本仓库基线

### 2.1 可借鉴的设计取舍

| 观察                                                   | 本项目取舍                                               |
| ------------------------------------------------------ | -------------------------------------------------------- |
| 请求、内容块、流事件、collector 分层                   | 采用分层，但使用 TypeScript 判别联合，并保留块身份和来源 |
| 同协议转发优先，跨协议才进入 IR                        | 保留现有 adapter 与路由分层                              |
| 流式逐事件 decode → encode，非流式由 collector 汇总    | 采用增量 AsyncIterable，不构造整段 Event 数组            |
| 工具结果图片到 Chat 时调整消息位置                     | 作为明确的目标转换规则，保留图片与工具调用关系           |
| Responses namespace、allowed_tools、file_id 的边界测试 | 作为能力语料；file_id 无法移植时优先原生路径或拒绝       |

### 2.2 当前代码的真实范围

目前由 src/lib/route-target/build.ts 的 resolveEndpoints 和 src/services/dispatch/shared.ts 调度四个跨端点方向：

- Chat → Messages：src/services/protocols/chat-via-messages.ts
- Messages → Chat：src/services/protocols/messages-via-chat.ts
- Chat → Responses：src/services/protocols/chat-via-responses.ts
- Responses → Chat：src/services/protocols/responses-via-chat.ts

字段转换分布在 src/services/protocols/openai、src/services/protocols/anthropic、src/services/copilot/chat-to-responses\*.ts 和 responses-to-chat.ts。旧版方案列出的 routes/messages/non-stream-translation.ts 与 stream-translation.ts 当前不存在，不能据此计算重复代码或删除收益。

> **实施后状态（2026-09-30）**：四个跨端点 wrapper 已全部改走 `src/services/ir/codecs/`
> 的 IR codec；旧 pair translator（`protocols/openai/` 目录、`protocols/anthropic/`
> 的 non-stream-translation.ts 与 stream-translation.ts）已删除。`protocols/anthropic/`
> 的 types/utils 保留 —— 它们是 Anthropic 协议的 wire 层（types 被 IR
> messages-chat codec、`routes/messages`、`services/claude` 等直接引用），不是
> Copilot 私有实现。
> `/v1/messages` 路由统一到 `dispatchMessages` 单一路径，token 计数与 usage
> 估算也已切换 IR codec。上文对重复代码的统计仅存档为迁移前基线。
>
> **第二轮（2026-09-30）**：Copilot 的 Chat↔Responses 私有翻译器与其在 adapter
> 内的端点回退已删除，协议 wire 类型从 `services/copilot/` 迁到
> `services/protocols/{chat,responses}/`。端点能力查询收敛到
> `lib/route-target/model-support.ts`，由 `buildRouteTargets`（含通配 target）
> 与 WS 直连路径共用。保留在 Copilot 目录里的只有：token/headers、模型名归一、
> `sanitizeReasoningEffortForCopilot`，以及 `/v1/messages` 的
> `translateToCopilotMessages`（上游 wire 适配，不是 pair translator）。
>
> **第三轮（Phase 4，2026-09-30）**：可达方向扩展为十二个端点组合
> （chat/messages/responses 两两互通，Gemini 与三者双向互通）；`IRWire` 增至四个。
> Gemini 的六个跨 wire 组合走 `services/protocols/wire-pairs.ts` 的表驱动路径
> （单张 `WireSpec` 表 + `createTranslatedCall`），未新增成对翻译器。
> `web_search` 补齐 IR 意图（`generation.webSearch*`）与事件语义
> （`IRServerToolUsePart` / `IRWebSearchResultPart`）；代理级编排循环仍未实现。

当前 ResponsesInputItem 的 function_call_output 仅建模字符串，部分文件、工具结果图片和命名空间工具尚无完整座位。已有签名、缓存、reasoning 别名、usage 与终止行为必须作为迁移契约，而不是重写时的附带事项。

AGENTS.md 仍把 Chat 写成枢纽并引用已缺失的 docs/translation-conventions.md 与 docs/protocol-translation-pitfalls.md。实施前应核对旧文档的有效条款，恢复或更新引用，并同步修改 AGENTS.md；不能一边运行新架构一边保留相反的项目规约。

## 3. 能力与损失契约

能力决策分为两层：

- **Wire 能力**：协议能否表达某种内容、位置、事件或字段，例如 Messages 的 tool_result 图片、Responses 的 namespace。
- **目标能力**：选中的 ProviderConnection、模型、端点和方向是否接受该表达，例如缓存 TTL、reasoning effort 等级、是否自行放缓存断点、图片媒体类型。

单一的 WireCaps 布尔表只能描述第一层。真正的决策函数接收请求特征、候选 RouteTarget、目标能力与策略，产出转换计划或拒绝原因。encoder 执行具体转换；能力表不替代需要顺序、上下文和状态的代码。

| 能力                                | 保留或转换规则                                                                                          | 不能保留时                                                   |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| 历史 thinking 与签名                | 逐块保留原文、签名和来源；需要签名的目标仅接收有效原块，接受无签名 reasoning 的目标可按自身规则保留文本 | 无安全表示时去掉历史 thinking 并记录；不得伪造签名           |
| 响应中的无签名 thinking             | 可按客户端协议输出供展示；与历史回放分开判断                                                            | 仅当客户端不能表达时按策略处理                               |
| tool_result 图片                    | Messages/Responses 可保留结构；转 Chat 可把图片移到紧随工具结果的用户内容，保留关联和顺序               | 当前轮图片无法送达且无合适候选时拒绝；不能只发图片描述占位   |
| Responses namespace / allowed_tools | 展平名称时保留映射；返回调用时还原；allowed_tools 必须先过滤再执行 required 约束                        | required 集合空或映射碰撞无法解决时拒绝                      |
| Responses file_id                   | 仅在有权解析为图片内容或原生目标可接收时保留                                                            | 当前轮不可移植内容拒绝或改选原生目标；历史内容按明确策略处理 |
| Responses encrypted_content         | 仅在原生目标和来源约束允许时透传，不把摘要当作密文                                                      | 记录无法回放的推理上下文；不跨发行方伪造或复用密文           |
| cache_control / prompt cache        | 保留断点位置、TTL 与目标自行放置策略；Chat 无显式断点                                                   | 不向 Chat 塞非法字段，记录缓存语义损失                       |
| effort / thinking budget            | 根据具体模型接受的等级映射；“关闭思考”和最低努力是不同意图                                              | 无合法映射时使用文档化策略，不默认悄悄开启思考               |
| web_search                          | 区分客户端意图、上游原生搜索和代理编排                                                                  | 编排循环未实现且无原生目标时明确拒绝，不能静默丢弃           |
| usage / stop / error                | 保留来源计数与归一值、终止原因及流错误状态                                                              | 无来源数据时标记估算或缺失，不伪装为精确值                   |

损失策略使用 preserve、transform、synthesize、drop、reject 五类动作。drop 只用于已确认不会误导模型或客户端的可选信息；当前轮图片、required 工具限制等关键语义默认 reject。每次非原样处理记录 path、feature、action、reason、target 和 stage，不记录提示词、图片字节、签名或密文。默认写入现有请求日志与聚合指标，不改变公开 API 响应形状。

## 4. 目标架构

```text
原生候选：client wire → 现有 adapter → upstream

翻译候选：
  client wire → decodeRequest → RequestIR → inspectFeatures
              → capability preflight / target selection → conversion plan
              → encodeRequest → 现有 adapter → upstream
  upstream stream → incremental decode → AsyncIterable<StreamEvent>
                  → incremental encode → client stream
  upstream non-stream response → decodeResponse → ResultIR → encodeResponse
  upstream stream + non-stream client → incremental decode → collector → ResultIR → encodeResponse
```

选路仍优先现有原生候选，但必须在真正发送前检查候选能否承载本次请求的关键特征。一个候选因语义不兼容被跳过时，failover 可以尝试其他候选；所有候选都不合适时，返回客户端可理解的错误。预检使用路由已解析的请求及轻量特征扫描，不要求原生路径完整进入 IR。

当前 resolveEndpoints 只返回第一个可用 fallback。Phase 1 必须让路由层枚举同一模型可用的端点候选，再按现有原生优先层级与本次请求的能力预检筛选；否则“跳过不兼容目标”无法在同一 connection 的其他端点上继续尝试。候选的语义拒绝应进入 failover 记录，但不得伪装成上游 429 或认证故障。

### 4.1 IR 边界

RequestIR 至少包含有序的 system/developer 指令、turn、工具定义与选择、生成参数，以及请求来源。Turn 保留角色和内容顺序。内容使用判别联合；tool_result 的子内容只允许其合法的文本、图片和文件类型，不使用任意递归 Part 数组。图片来源区分 URL 与 base64，文件来源区分 URL 与不可移植的 file ID。

ThinkingPart 保留独立块、原文、签名或密文及来源信息。签名有效性取决于原文与发行方，不能仅凭 signature 非空判断。工具定义保留 namespace、原名、展平名和 allowed_tools 限制，并以请求级映射还原响应调用。

StreamEvent 必须携带消息、内容块或工具调用的稳定身份及顺序索引，明确 start、delta、block end、stop、usage、error、完整与不完整终止。实现以 AsyncIterable 增量消费；collector 只为非流式输出或 encoder 必需的有限状态累积，不能等待整个流才输出首个事件。相邻 thinking 块不能因同 kind 被合并。

ResultIR 与请求 IR 分开。usage 记录输入、输出、缓存读取、缓存写入、reasoning 等标准计数及来源；不明确的值不得从 0 推断为已测量。stop reason 可有归一值与源协议原值，避免多对一映射后误称往返无损。

来源专属扩展只允许目标显式认识时透传。遇到未知字段，应按字段策略记录或拒绝；不把任意 vendor JSON 当作“保真逃生舱”。store、service_tier 等请求级字段不应塞进内容 Part。

### 4.2 Codec 边界

每个公共客户端 wire codec 负责本协议的请求 decode/encode、非流式响应 decode/encode 和流事件 decode/encode。公共 helpers 负责别名读取、usage、工具 ID、图片来源和损失记录；提供方或模型特例放在目标能力解析与明确的 encode policy。私有上游 adapter 保持原有生命周期与 wire 职责，通过其暴露的 Chat、Messages 或 Responses 端点接入，不强制将私有协议内部格式纳入 IR。

“新增协议只改三个文件”不是验收条件。可验证的成本目标是：无需为已有协议逐对新增翻译器；公共能力规则只维护一处，协议特例有局部实现与测试。

## 5. 不变量与测试语料

迁移前从 Git 历史核对 docs/protocol-translation-pitfalls.md 的每条有效结论，并形成当前代码的测试索引。至少覆盖：

- 多个 signed thinking 块逐块还原；响应无签名 thinking 可展示，但历史请求不得伪造签名。
- reasoning_text、reasoning_content、reasoning 的优先级与空字符串语义一致，不能重复拼接。
- Responses reasoning 的顺序和归属不跨 user/tool_result；无 encrypted_content 时不宣称可回放。
- 缓存断点数量、位置、TTL、自行放断点目标；远程图片的 URL source；非空白占位符。
- 多个工具调用及分片参数、allowed_tools 的 required/empty 情况、命名空间名称冲突。
- tool_result 图片在 Chat、Messages、Responses 间的目标表示与顺序；不可移植的当前 file ID 明确拒绝。
- usage-only 帧、错误帧、上游断流、[DONE]、缺失 finish_reason，以及流取消传播。

测试以“同一请求语义、有效 wire、事件顺序和明确损失”为主。流分片边界允许不同；只对协议要求的事件形状与顺序做精确断言。属性测试应比较目标 wire 重新 decode 后与其可表达的 IR 投影，而不是要求目标还原源协议无法表达的信息。

## 6. 迁移阶段

### Phase 0 — 校准契约和基线

- 从 Git 历史核对并恢复或更新缺失的 pitfalls / conventions 内容，同时制定 AGENTS.md 的枢纽规约变更。
- 重新统计当前四条转换路径、重复规则、目标能力缺口与现有测试；记录代表性请求的 TTFT 和内存基线。
- 建脱敏 fixtures：来源包括本仓库已有回归用例，覆盖 namespace、tool image、file ID、prompt cache 等场景。记录原请求、录制的上游响应、期望语义和损失报告。

此阶段会改变项目规约和测试契约，不称为“零风险”；合并前需审阅旧条款是否仍适用。

### Phase 1 — IR、预检和损失策略

新增 RequestIR、ResultIR、StreamEvent、collector、目标能力解析与 loss report。首先用单测证明第 3 节的代表性能力有座位，并让不可移植的当前图片、空 required 工具集合等在发送前拒绝。尚不切生产翻译路径。

### Phase 2 — 一条完整路径验证

先完成 Messages 客户端 → Chat 上游 → Messages 客户端的一整条路径，再完成 Chat 客户端 → Messages 上游 → Chat 客户端。每条路径一次处理请求、非流式响应与流式响应，不把“流侧先切、请求侧后切”当作独立完成状态。

首批能力包括 signed/unsigned thinking 的方向区分、tool_result 图片、缓存断点和 usage/error/stop。新旧实现以录制响应离线对比；达到语义、损失和性能门槛后按方向切换。保留有明确删除时点的回滚开关。

### Phase 3 — Responses 能力与剩余转换

完成 Chat ↔ Responses 两个方向，纳入 namespace、allowed_tools、file_id、reasoning item 和 encrypted_content 的边界策略。随后让四个 via-\* wrapper 只负责选定 codec、调用 adapter 与连接流，不再内联字段映射。每切换一条路径，删除对应旧实现；不长期维护双轨。

### Phase 4 — 扩展验证和收尾（已实施）

以 Gemini 作为新增公共协议的真实成本验证：记录新增 codec、能力策略和测试实际改动的范围，而非预设“三个文件”。messages ↔ responses 是否开放，以真实客户端需求和损失矩阵决定。web_search 的代理编排单独设计，IR 先保留意图与事件语义。

实施结果：

- Gemini 成本 = 1 个 wire codec（`ir/codecs/gemini/{part,request,result,stream}.ts`）+ 1 个 adapter（`protocols/gemini-compatible.ts`）+ 1 个路由（`routes/gemini/`）+ 协议/端点枚举各一行 + `wire-pairs.ts` 一张表项。**没有新增与既有协议成对的翻译器**，公共能力规则仍只在 `ir/capabilities.ts` 维护一处。
- `messages ↔ responses` 双向开放：两个 wrapper（`messages-via-responses.ts`、`responses-via-messages.ts`）复用既有 codec，未引入新 wire 语义。
- `web_search`：IR 意图与事件语义落地；代理编排见 Phase 5。

### Phase 5 — web_search 代理编排（已实施）

分工原则：**目标 wire 自己能承载搜索就透传，不能就由代理接管**。

- 新增 `src/services/search/`：`searcher.ts`（searcher 排序：codex 账号优先 → claude → anthropic-compatible → responses-compatible，以及小模型挑选）、`execute.ts`（对 searcher 发一轮带原生搜索工具的请求，解析正文与命中）、`orchestrate.ts`（wire 无关的 IR 循环，上限 6 轮，复用 `WireSpec`）。
- 接入点收敛为 4 处（不是「所有 wrapper」）：`wire-pairs.ts`、`messages-via-chat.ts`、`responses-via-chat.ts`、`dispatch/shared.ts` 的 chat 原生分支。其余原生直通（messages / responses / gemini 目标）本就能承载搜索，不改。
- 触发补全：chat 客户端此前无法表达搜索意图，现在识别 OpenRouter 的 `plugins:[{id:"web"}]`。
- `TargetCapabilities.orchestratedWebSearch` 让预检把「无法原生搜索」从 `reject` 降级为 `transform`（仅在确实有可用 searcher 时置位；`planTranslation` 保持纯函数）。
- 编码器补齐 `server_tool_use` / `web_search_result` 的呈现（messages 非流式与流式、responses 非流式与流式 → `web_search_call.action.sources`），否则搜索事件会被静默丢弃。
- 运维开关：`SEARCH_ORCHESTRATION=0` 整体关闭；关闭或没有可用 searcher 时回到原有的语义拒绝，行为与 Phase 4 一致。

## 7. 验证与验收

- 当前既有测试、typecheck、lint、format:check 和 build 均通过；测试数量从运行结果读取，不写死。
- 四条当前可达转换路径分别通过请求、流式、非流式和错误 fixtures；同协议 adapter 路径没有引入 IR。
- 关键能力的 preserve/transform/reject 行为均有断言；loss report 只含元数据，可按目标与原因聚合。
- 同一份录制上游响应供新旧路径比较。Shadow 不再次请求真实上游，避免重复费用、工具副作用与状态漂移。
- 对比 Phase 0 的 TTFT、内存和大流性能基线；具体门槛在采样后写入对应阶段任务，明显回退不得仅以“翻译是慢路径”豁免。
- 新增一个协议的试点证明无需增加与每个既有协议成对的翻译器；公共规则没有复制到 routes、protocols、copilot 三处。
- AGENTS.md 与有效文档一致，不再引用死链或同时规定 Chat 枢纽和 IR 枢纽。

## 8. 主要风险

| 风险                                            | 处理                                                                           |
| ----------------------------------------------- | ------------------------------------------------------------------------------ |
| IR 漏字段或过早压平导致新损失                   | Phase 1 先覆盖目标能力；decode、preflight、encode 各阶段记录或拒绝未知关键语义 |
| 能力表膨胀成不可解释的布尔组合                  | 静态 wire 能力与动态目标策略分层；顺序敏感转换保留具名函数和测试               |
| 签名、密文跨提供方被错误复用                    | 保留来源与原文；仅在有明确有效性依据时回放，禁止生成伪造值                     |
| file ID、图片或 required 工具被文本占位伪装成功 | 当前轮关键语义预检；优先可承载目标，否则明确拒绝                               |
| 新旧路径并存期维护翻倍                          | 按完整方向切换，设置回滚和删除时间；不跨多个阶段保留同一方向的双实现           |
| 流状态、取消与终止语义回退                      | 增量事件、有限状态 collector、断流和取消 fixtures、性能基线                    |
