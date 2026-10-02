# 协议翻译规约

状态：**生效中**  
日期：2026-09-30  
设计依据：`docs/protocol-ir-refactor-plan.md`  
回归索引：`docs/protocol-translation-pitfalls.md`

## 1. 入口与边界

Chat Completions、Anthropic Messages、OpenAI Responses 均是外部 wire 协议。
请求端点和目标端点相同时，沿用协议 adapter，不经过公共 IR。跨端点请求先
decode 为 `RequestIR`，按目标能力预检，再 encode 成目标 wire；响应经
`ResultIR` 或增量 `StreamEvent` 返回客户端。IR 是当前承诺语义的最小充分模型，
不是任意 vendor JSON 的无损容器。

新增公共协议时，应实现该协议到 IR 的请求 decode、从 IR 的请求 encode、
响应 decode/encode 和增量流 decode/encode。不得为每一对协议新增独立翻译器。
提供方私有协议及原生 adapter 仍由各自模块负责。

## 2. 能力与损失

发出上游请求前，调用 `planTranslation()` 检查请求特征、目标 wire、连接和模型
能力。目标无法表达关键语义时，抛出 `LocalPayloadUnsupportedError`，让 failover
尝试其他候选，不冷却凭证。所有候选均不适合时返回明确的客户端错误。

`LossRecord` 只记录路径、特征、动作、原因、目标和阶段。不得写入提示词、
图片字节、签名或密文。`drop` 只适用于已确认不会误导结果的可选信息；当前轮
图片、必选工具集合和无法移植的 file ID 应拒绝。跨发行方的签名和密文不能伪造。

`buildRouteTargets()` 为同一模型列出全部可用端点；选择器先选原生端点，
Chat 的翻译候选按 Responses、Messages 顺序尝试。候选的语义拒绝进入 failover，
不视为上游 429 或认证故障。

## 3. 流与非流

流式 codec 逐事件消费和产出，保留消息、内容块和工具调用的身份及顺序。
不能为了翻译把整个上游流缓存到首个下游事件前。非流式响应使用同一语义映射；
需要由流汇总时，使用 collector。usage、stop reason 和 error 保留来源信息，
缺失计数不能假装成精确的 0。

reasoning 的三个顶层别名 `reasoning_text`、`reasoning_content`、`reasoning`
按相同优先级读取；空字符串视为缺失。已由别名提供的文本，不再从 details 或
content parts 重复拼接。多个带签名 thinking 块保持独立，签名只用于其原文。

## 4. 协议特有规则

- Messages 的 `cache_control` 位置与 TTL 要保留。Chat 无显式断点，不能塞入
  无效字段。Chat 转 Messages 时，目标若不自行放断点，由 wrapper 补默认断点；
  自行处理缓存的目标跳过此步。
- Messages 的 tool_result 图片转 Chat 时，图片跟随对应工具结果放到 user 内容，
  保留顺序和关联；不得只发送占位描述。
- `planTranslation` 只在目标 wire 整体不支持图片时拒绝；编码层对单个无法表示的
  图片编码（`blob:` 等 URL scheme、目标不接受的 media type）按 pitfalls §3.8
  丢弃，不拒绝整个请求。
- Responses 的 namespace 工具名须可逆映射。`allowed_tools` 先筛选定义，再
  执行 required 约束；空的必选集合拒绝。
- Responses 的 `file_id` 只可交给能识别相同发行方 ID 的目标；其他目标需要
  可读取的内容才能转换，否则拒绝。`encrypted_content` 不跨发行方回放。
- `web_search` 区分客户端意图和上游原生能力：目标 wire 能承载（messages /
  responses / gemini）就透传原生声明；只有 chat 目标由代理接管，用
  `services/search/` 的循环执行并把结果渲染成 `server_tool_use` /
  `web_search_result`。既没有原生能力也没有可用 searcher 时拒绝，
  `SEARCH_ORCHESTRATION=0` 可关。见 pitfalls §6。
- Gemini 是新公共协议：`IRWire` 含 `gemini`，`thoughtSignature` 只能回放给
  Gemini，工具结果以 `functionResponse` 表达且不支持图片。流式由方法名
  （`streamGenerateContent`）而非 body 字段决定，路由在 dispatch 前写入
  `stream`。

`service_tier` 在 Chat ↔ Responses 之间保留（`auto/default/flex/priority/scale`）。
Messages 只编码 `auto/standard_only`；不可表达的 tier（含 Gemini 的所有 tier）
记录 `service_tier` / `drop` 损失，不把 OpenAI priority 或 flex 冒充为 Anthropic auto。
原生请求遵循提供方契约：Codex `/responses` 和 `/responses/compact` 只发送
`priority/flex`，其他值省略；Copilot 和通用 OpenAI 兼容连接保留原生透传。
`x-codex-routing-hint` 是独立的 advisory 头，转发它不覆盖 body 的 `service_tier`。

## 5. 翻译路径的选择

| 情形                                                     | 走哪条路                         |
| -------------------------------------------------------- | -------------------------------- |
| 目标 endpoint 与请求一致                                 | 对应 adapter 的原生方法，不进 IR |
| 组合需要专属行为（缓存断点、流 twin、memory trace、SSE） | 手写的 `*-via-*.ts` wrapper      |
| 其余跨 wire 组合（当前：全部 Gemini 方向）               | `wire-pairs.ts` 的 `WireSpec` 表 |

新增一条翻译路径时先问：它需要上面第二种的专属行为吗？不需要就往
`WireSpec` 表加一项，不要在 dispatch 里内联字段映射。

## 6. 验证

每条可达方向都应覆盖请求、非流式、流式、错误和终止事件。
对照 `docs/protocol-translation-pitfalls.md` 的回归用例检查语义与损失记录；
不要求 SSE 分片边界逐字相同。原生路径仍需覆盖，以确认它没有被公共 IR 改写。
