# 协议转换陷阱（Chat / Messages / Responses）

状态：**生效中**
日期：2026-09-30
关联：`docs/translation-conventions.md`、`docs/protocol-ir-refactor-plan.md`

本文记录三种客户端/上游协议（OpenAI Chat Completions、Anthropic Messages、
OpenAI Responses）互转时的信息落差，以及历史回归。下文列出的旧翻译函数
是问题来源和测试索引；新跨端点执行路径以 `src/services/ir/` 和协议 codec 为准。

改动 `src/services/ir/**`、`src/services/protocols/**` 或相关 adapter 前先读这里。
不可移植的语义需要预检、转换或明确记录损失；不把旧行为当作必须保留的缺陷。
第 3 节列出的回归用例应继续锁定目标语义。

---

## 1. 可达性矩阵

`src/lib/route-target/build.ts` 的 `resolveEndpoints()` 枚举一个请求 endpoint 能落到
的所有上游 endpoint。当前候选表：

| 请求 endpoint | 可落到的上游 endpoint                             |
| ------------- | ------------------------------------------------- |
| `chat`        | `chat`（原生）、`responses`、`messages`、`gemini` |
| `messages`    | `messages`（原生）、`chat`、`responses`、`gemini` |
| `responses`   | `responses`（原生）、`chat`、`messages`、`gemini` |
| `gemini`      | `gemini`（原生）、`chat`、`messages`、`responses` |
| `embeddings`  | `embeddings`（不做 fallback）                     |

`messages ↔ responses` 已开放（§4），两个方向各自有 wrapper
（`messages-via-responses.ts`、`responses-via-messages.ts`），不经 Chat 串联。

Gemini 的六个方向走 `src/services/protocols/wire-pairs.ts` 的表驱动路径。
**新增跨 wire 组合时优先往那张表加 `WireSpec` 项**，不要再写一份手写 wrapper；
只有该组合需要专属行为（缓存断点、结构化流 twin、memory trace、SSE 帧形状）时
才值得单独成文件——现有四条手写 wrapper 正是因为这个原因保留。

### 选路层级

`selectRouteTarget()`（`src/lib/route-target/select.ts`）的分层判别**优先于**
`connectionPriority`：

```
专用原生  >  专用转换  >  通配原生  >  通配转换
```

回退到非原生 endpoint 的 target 由 `build.ts` 打上 `RouteTarget.isTranslated`。
**不要**把 `isTranslated` 或 `isWildcard` 编码成 priority 标量偏移——历史上的
`WILDCARD_PRIORITY_BASE` 就是这么写的，已经废弃。failover 把原生候选 exclude 之后，
转换 target 仍会作为后备被选中；同一连接同时支持 Responses 和 Messages 时，
Chat 翻译先尝试 Responses，再尝试 Messages。

---

## 2. 不可修的协议落差

### 2.1 chat → responses：合成的 reasoning item 没有 `encrypted_content`

`encodeResponsesResult()`（`src/services/ir/codecs/responses/result.ts`）
用上游的 `reasoning_content` 合成一个 `{ type: "reasoning", id, summary }` item。

**为什么不可修**：`encrypted_content` 是 OpenAI 服务端签发的密文，Chat Completions
上游根本不产出。没有它，Responses 客户端（Codex CLI）下一轮 replay 时丢失推理上下文，
`src/lib/cache/reasoning-replay-cache.ts` 在这条路上也帮不上忙——它缓存的是
codex-native 直连路径拿到的真实 blob。

**不要做**：不要伪造 `encrypted_content`（上游会拒），不要为了"补全"去调
codex-native 拿一个不属于本次对话的 blob。

### 2.2 chat → messages：无签名的历史 thinking 会被剥离

chat→messages 请求路径（`src/services/ir/codecs/messages-chat/request.ts` 的
`encodeMessagesRequest`）只在 `signature` 存在且对该文本有效时才生成 `thinking`
block；剥空的 assistant turn 用 `EMPTY_TEXT_PLACEHOLDER`（`"(no content)"`）兜底，
因为 Anthropic 拒绝空 content 数组和纯空白 text block。
**占位符必须是非空白文本**（见 §3.9）。连续 assistant turn 合并时，占位符只在
**合并后的整 turn 为空**时注入，不在中间 turn 之间垫占位块（语义等价、更干净）。

**为什么不可修**：Anthropic 拒收无签名的历史 thinking block（400）。响应侧
（`response.ts` / `stream.ts`）**已经**把签名透出去了——非流式在顶层
`signature`（单块）或 `reasoning_details[].signature`（多块），流式在
`delta.signature`——但绝大多数 OpenAI 客户端不会回传这两个字段。落差在客户端，
不在本仓库。

**后果**：转换路径重建出的 assistant turn 与 Claude 实际产出的 block 序列不一致。
对 prompt cache 无害（缓存断点写在上一轮请求末尾，在该 turn 之前），但推理上下文会丢。

**不要做**：不要为了"保住" thinking 而伪造 signature；不要移除
`EMPTY_TEXT_PLACEHOLDER` 兜底。

### 2.3 messages → chat：`cache_control` 断点被丢弃

Chat Completions 上游没有显式缓存断点的概念，只能吃上游自己的隐式前缀缓存。
这是**正确行为**，不要试图把 `cache_control` 塞进 chat payload。

### 2.4 stop_reason 映射是多对一，不可逆

messages→chat 的 stop 映射（`src/services/ir/codecs/messages-chat/response.ts` 的
`chatFinishReason`）把 `end_turn` / `stop_sequence` / `pause_turn` / `refusal`
全部收敛成 `"stop"`。`refusal` 的拒绝文本本身保留在 content 里。往返转换不会
还原原始值。

---

## 3. 已修复的坑（不要回退）

### 3.1 同优先级下不要让协议转换抢占原生 endpoint

**症状**：两个 connection 同 `priority`、提供同一模型，一个只暴露 `messages`、
一个只暴露 `chat`。chat 请求会按 fill-first 的 `connectionId` 字典序选中前者，
白白走一趟协议转换。

**锁定**：`RouteTarget.isTranslated` + `selectRouteTarget` 的分层过滤。
测试：`tests/unified-routing.test.ts` →
`"native-endpoint target wins over a same-priority translated target"`。

### 3.2 chat → messages 必须自己放缓存断点

Chat Completions schema 无法表达 `cache_control`，而 `anthropic-compatible` adapter
是纯透传、自己不放断点。不补的话上游收到**零个**断点，只能吃隐式缓存，命中率明显低于
客户端自己放断点的 `/v1/messages` 直连路径。

`withPromptCacheBreakpoints()`（`src/services/protocols/chat-via-messages.ts`）补齐：

- 复用 `applyPromptCaching()`（`src/services/claude/prompt-cache.ts`，上限 4 个断点）
- `system` 从字符串提升成单个 text block 以便挂断点
- TTL 用 `{ type: "ephemeral" }`（默认 5m）。**不要**改成 `ttl: "1h"`——那需要
  `extended-cache-ttl` beta，第三方 Anthropic 兼容端点不一定认
- `SELF_CACHING_PROTOCOLS` 白名单跳过 `claude-native`，它在
  `create-messages-once.ts` 里有自己的 CC 布局（含 1h TTL）；预置断点会把它抑制掉。
  **新增会自行放断点的 protocol 时，记得加进这个集合。**

客户端若按 OpenRouter 约定在 content part 里放了 `cache_control`，会被透传并优先于
自动放置（`applyPromptCaching` 先 `countBreakpoints` 再跳过已有的）。

测试：`tests/chat-via-messages.test.ts` → `"places prompt-cache breakpoints…"` /
`"preserves a client-supplied cache_control breakpoint…"` /
`"leaves claude-native payloads alone…"`。

### 3.3 responses → chat：`input` 里的 reasoning item 不能落到 tool 分支

**症状**：`translateResponsesInputToMessages()` 曾用 if/if/else 结构，reasoning item
落进最后的 `function_call_output` 分支，产出
`{ role: "tool", tool_call_id: undefined, content: undefined }`。Codex CLI 每轮都
replay reasoning item，于是每次多轮请求都往 prefix 中间插一条畸形消息——严格上游 400，
宽松上游前缀被污染、缓存对不齐。

**锁定**：`ResponsesInputItem` 联合类型显式建模 `reasoning` 变体，翻译改成
`switch` + 显式 `default: break`。**新增 Responses input item 类型时必须同时更新这两处**，
否则会重新落进兜底分支。

测试：`tests/chat-to-responses-reasoning.test.ts` →
`"never emits a tool message without tool_call_id"`。

### 3.4 reasoning 字段的三种拼写必须一致处理

`reasoning_text` / `reasoning_content` / `reasoning` 都要认。流式侧的
`getReasoningDelta()` 一直是对的；非流式侧的 `getChatMessageReasoningText()`
曾只读 `reasoning_text`，导致 DeepSeek/Kimi/Qwen/GLM 这类只发 `reasoning_content`
的上游在 `/v1/responses` 非流式路径上思考被静默丢弃。

**规约**：新增任何读取 reasoning 的代码，stream 与 non-stream 必须走同一套字段优先级
（`docs/translation-conventions.md` 规则 R2）。

**顺序也是规约的一部分**：顶层别名 → `reasoning_details` → content parts，取第一个
非空的，**不拼接**。拼接会把同时回显两处的上游（OpenRouter 常见）的思考在用户可见的
summary 里翻倍。`getReasoningDelta()` 与 `getChatMessageReasoningText()` 走同一顺序。

测试：`tests/chat-to-responses-reasoning.test.ts` →
`"picks up message.reasoning_content, not just reasoning_text"` /
`"picks up delta.reasoning_details when no top-level alias is set"` /
`"does not duplicate reasoning echoed under both an alias and details"`。

### 3.5 多个 thinking block 必须逐块保签名

签名只对**签发它的那段原文**有效。旧翻译器曾把一个 assistant turn 里的多个
thinking block `join("\n\n")` 成单个 `reasoning_content`，签名用 `.find(...)`
只取第一个 —— 这段"拼接文本 + 第一个签名"的组合送回任何会校验签名的 Anthropic 上游
都会 400。

**锁定**：2 个及以上 thinking block 时额外输出有序的 `reasoning_details`
（`{ type: "reasoning.text", text, signature }` 逐块一条）。chat→messages 的
`decodeChatRequest()`（`src/services/ir/codecs/messages-chat/request.ts`）
优先读这个字段并逐块还原。

**只有一个 block 时不输出 `reasoning_details`** —— 此时 `reasoning_content` + 顶层
`signature` 已经是无损的，保持原有 wire format 不变，避免给不认识该字段的上游增加
风险。新增读取历史 reasoning 的代码请沿用这个"仅在会丢信息时才加字段"的取舍。
请求方向（`encodeChatRequest`）与响应方向（`encodeChatResponse`）在 IR 里已统一为
这一约定。

测试：`tests/anthropic-request.test.ts` →
`"multiple thinking blocks round-trip with their own signatures"`（含经枢纽往返的
逐块还原断言）。

### 3.6 Responses `output` 里 reasoning item 必须排在最前

Responses 客户端按 `output` 顺序 replay，reasoning item 必须出现在它所解释的
`message` / `function_call` **之前**。顺序：`reasoning → message → function_call`。

测试：`tests/chat-to-responses-reasoning.test.ts` →
`"emits the reasoning item before the message and function_call"`。

### 3.7 空字符串在 reasoning 别名链里等于「缺失」

上游在**不使用**的那个拼写上回填 `""` 是常态：一轮没有思考的对话会带回
`reasoning_content: ""`，而真正的思考在 `reasoning_text` 里。因此
`~/lib/thinking` 的三个 extractor 一律用 `||` 而非 `??`。

`routes/chat-completions/normalize.ts` 曾用 `delta.reasoning_content !== undefined`
判定"已存在"，把 `""` 当成有值直接短路返回，与别名链的语义相反 —— 客户端拿到空的
`reasoning_content`，真文本就在隔壁字段里。

**规约**：任何"这个 reasoning 字段有没有值"的判断都用真值判断，不要用
`!== undefined` / `!= null`。

测试：`tests/chat-completions-normalize.test.ts` →
`"an empty reasoning_content does not shadow a populated alias"`。

### 3.8 chat → messages：远程图片翻成 `url` source，不要丢弃

`image_url` 里的 http(s) URL 曾被直接 `return undefined` 跳过，理由是"Anthropic 只收
base64"。这已经过时：Anthropic 支持 `source: { type: "url", url }` 并自行抓取。丢弃的
后果是模型在没有任何线索的情况下用纯文本回答图片问题 —— 静默降级比一个响亮的 400
更难排查。

**锁定**：`AnthropicImageBlock.source` 是 `base64 | url` 的联合类型，消费方必须
`switch` 在 `source.type` 上（反向的 `imageToChat` 会把两者收敛回 OpenAI 单一的
`url` 字段）。既不是 `data:` 也不是 http(s) 的（`blob:` / `file:`）以及 Anthropic
不接受的 media type，由 messages 编码器（`imageToMessages`）**丢弃**而非拒绝整个
请求——chat 客户端重放带浏览器本地 `blob:` 图片的历史时，拒绝会卡死整段对话，
丢弃只损失那一张本来就无处可去的图。user turn 只要携带过图片（即使全被丢弃）就
保持 block 数组形态，纯文本 turn 折叠为字符串，维持客户端发出的 wire 形状。

测试：`tests/chat-via-messages.test.ts` →
`"maps base64 image parts to base64 sources and remote URLs to url sources"` /
`"drops data: images whose media type Anthropic does not accept"`。

### 3.9 空 turn 占位符不能是空白字符

`EMPTY_TEXT_PLACEHOLDER` 曾是单个空格。Anthropic 同时拒绝两件事：空 content 数组，
以及**结尾带空白的末条 assistant 消息**（"final assistant content cannot end with
trailing whitespace"）。剥空的 assistant turn 若正好落在数组末尾（prefill），单空格
等于把一个 400 换成了另一个 400。

**规约**：占位符必须是非空白文本（当前 `"(no content)"`）。

测试：`tests/chat-via-messages.test.ts` →
`"placeholder is not whitespace, so a trailing assistant turn is a valid prefill"`。

### 3.10 responses → chat：reasoning 只归属紧随其后的 assistant turn

`pendingReasoning` 曾只在 assistant / function_call 分支被消费，user 消息和
`function_call_output` 都不清它。于是一条没等到 assistant turn 的 reasoning item
会一直挂着，最终贴到**后面某个不相关的** assistant turn 上 —— 上一轮的思考被当成
这一轮的报告出去。

**规约**：任何 push 非 assistant 消息的分支都要 `pendingReasoning = undefined`。

测试：`tests/chat-to-responses-reasoning.test.ts` →
`"does not carry a summary past an intervening tool result"` /
`"does not carry a summary past an intervening user turn"`。

---

## 4. messages ↔ responses（已开放）

IR 不经 Chat 枢纽，两个方向各自直连：

- `messages-via-responses.ts` — Messages 客户端 → `createResponses` 上游
- `responses-via-messages.ts` — Responses 客户端 → `createMessages` 上游

开放时验证过的契约，回归时不要回退：

1. Messages 的带签名 thinking 转 Responses **不冒充** `encrypted_content`：
   `encodeResponsesResult()` 只在 `part.source.wire === "responses"` 时透传
   密文，其余来源的 thinking 变成可读的 `[historical reasoning]` 文本。
   Responses reasoning summary 转 Messages 时同样不会伪造 Anthropic 签名。
2. Messages 的 `cache_control` 断点在 Responses 目标上按 §3 的能力表记录损失
   （`drop` + `cache_breakpoint_unsupported`）；Responses 的 `file_id` 只留给
   同发行方可识别的目标，否则在预检阶段 `reject`。
3. namespace、allowed_tools、tool_result 图片和 usage/stop/error 的转换有双向
   测试（`tests/messages-via-responses.test.ts`、
   `tests/responses-via-messages.test.ts`）。
4. 语义不兼容时由 `planTranslation` 拒绝并交给 failover 尝试其他候选，**不计入
   目标凭证冷却**（`LocalPayloadUnsupportedError` → `semantic_unsupported`）。

## 5. Gemini（generateContent）

Gemini 是新公共协议，不是某个既有 wire 的方言，因此它在
`WIRE_CAPABILITIES` 里有独立一列，`IRWire` 也增至四个值。

- **流式由方法名决定**：`POST /v1beta/models/{model}:generateContent` 与
  `:streamGenerateContent` 是同一 body 的两个方法。路由在 dispatch 前把
  `stream` 写进 payload，下游 codec/adapter 只读该字段。
- **签名用途不同**：Gemini 用 `thoughtSignature` 标记 thought part，只能回放给
  Gemini（`feature.source.wire !== "gemini"` 时预检 `drop`）。反向也成立：
  Anthropic 签名不能当作 `thoughtSignature` 发出去。
- **工具结果位置不同**：Gemini 用 `functionResponse` part 而非独立 tool 角色，
  且工具结果图片不可表达（`toolResultImages: false`）→ 当前轮 `reject`。
- **`google_search` 只表达意图**：接地检索的结果以 `groundingMetadata` 返回，
  IR 不建模，因此 Gemini 的 `serverToolUse` / `webSearchResults` 都是 `false`。

## 6. web_search：代理级编排

编排实现在 `src/services/search/`。分工原则：**目标 wire 自己能承载搜索就透传，不能就由代理接管**。

判定只看目标 wire（`needsSearchOrchestration`）：messages / responses / gemini 的 wire 本身能表达搜索
（`WIRE_CAPABILITIES[wire].webSearch` 为 `true`），只有 **chat** 不能 —— 因此只有 chat 目标会触发循环，
其余路径保持单次调用。

**代理循环**（`orchestrate.ts`，最多 6 轮）：往目标请求注入内部工具
`web_search`（与客户端工具重名时降级为 `__proxy_web_search`），模型每要一次搜索，代理就用一个
**会搜索的账号**执行（`execute/executeWebSearch`），把 `assistant(tool_call)` + `tool(tool_result)`
追加进历史再问；收尾时把内部 tool_call 换成 `server_tool_use` + `web_search_result`（Responses 目标折进
`web_search_call.action.sources`）。

searcher 优先级（`searcher.ts`，`SEARCH_PROTOCOLS`）：**codex 账号** → claude 账号 →
xAI / Grok 账号（`xai-native`，Responses 原生搜索）→ `anthropic-compatible` → `openai-responses-compatible`。codex 排第一是因为它的 ChatGPT 后端原生支持
Responses `web_search`，且本仓库 `services/codex/` 已透明透传该工具。用 `SEARCH_ORCHESTRATION=0` 整体关闭。

回归时不要回退的契约：

1. **内部工具名绝不下发**：客户端不得看到 `tool_use` / `function_call` 形式的 `web_search`；chat 客户端
   只看得到正文（搜索结果以 `Sources:` 文本喂给模型，不是喂给客户端）。
2. **搜索失败不得让用户请求失败**：单个 searcher 失败时 `executeWebSearch` 换下一个；全部失败则该轮
   tool result 标 `isError` 并把 `Search failed: …` 交给模型自答。只有「一个 searcher 都没有」才回到
   `web_search_unsupported` 的语义拒绝。
3. **搜索子请求不得污染调用方会话**：`execute.ts` 的 `searchContext()` 故意不带
   `transcriptScopeId` / `executionSessionId` / `downstreamWebsocket` / `memoryTraceId` —— 否则搜索轮会
   被写进调用方的 Codex 转录缓存。
4. **直调 adapter 必须自行补偿限流**：编排绕过 `executeWithFailover`，所以 `executeWebSearch` 自己做
   `checkRateLimit`、429 上报与 401/403 冷却；漏掉这步会让被限流的 searcher 反复挨打。
5. **流式必须重编号**：每轮上游 index 从 0 重开，shim 统一重编号并只透传第一个 `message_start`、
   屏蔽中间 `message_end`、usage 求和（`encodeMessagesStream` 直接用 `event.index` 当
   `content_block.index`，冲突会让客户端收到重号块）。
6. **声明版本按 wire 校验**：`web_search_20250305`（Anthropic）与 `web_search` /
   `web_search_preview`（Responses）前缀相同，各自用正则限定，避免把 Anthropic 的版本号塞进
   Responses 请求。

IR 侧的意图与事件语义仍然是基础，下述规则不变：

- **意图**：`generation.webSearch` + `webSearchOptions`（`wireType`、`maxUses`、
  `allowedDomains`、`blockedDomains`）。messages 的 `web_search_20250305` server
  tool、responses 的 `web_search`、Gemini 的 `google_search` 都归一到此。
  目标是 chat 时按 §3 的 `reject`（"target has no native or orchestrated web
  search"）——绝不静默丢弃。
- **事件**：`IRServerToolUsePart`（上游自己执行的调用，对应 Anthropic
  `server_tool_use` 与 Responses `web_search_call`）和 `IRWebSearchResultPart`
  （Anthropic `web_search_tool_result`）。

区分要点：`server_tool_use` / `web_search_result` 出现在**当前轮**时是调用方在请求
一次新的搜索，能力不足必须 `reject`；出现在**历史**时只是回放，能力不足按 `drop`
记录即可（`planTranslation` 用 `feature.current` 区分）。把它们当成普通
`tool_call` / `tool_result` 处理会让客户端以为要自己执行搜索。
