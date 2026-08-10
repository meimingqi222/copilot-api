# 协议转换陷阱（Chat / Messages / Responses）

状态：**生效中**
日期：2026-08-09
关联：`docs/translation-conventions.md`（枢纽规约 R1/R2/R3）、`docs/refactor-usage-translation.md`

本文记录三种客户端/上游协议（OpenAI Chat Completions、Anthropic Messages、
OpenAI Responses）互转时**无法消除的信息落差**，以及已经踩过、不要再踩回去的坑。

改动任何 `src/services/protocols/**` 或 `src/services/copilot/{chat-to-responses,
responses-to-chat}.ts` 之前先读这里。第 2 节的每一条都不是 bug，**不要"修"它们**；
第 3 节的每一条都是真 bug，已修并有回归测试锁定，**不要回退**。

---

## 1. 可达性矩阵

`src/lib/route-target/build.ts` 的 `resolveEndpoints()` 决定一个请求 endpoint 能落到
哪些上游 endpoint 上。当前 fallback 表：

| 请求 endpoint | 可落到的上游 endpoint |
| --- | --- |
| `chat` | `chat`（原生）、`responses`、`messages` |
| `messages` | `messages`（原生）、`chat` |
| `responses` | `responses`（原生）、`chat` |
| `embeddings` | `embeddings`（不做 fallback） |

**`messages` ↔ `responses` 之间不可直达。** 这是 `docs/translation-conventions.md`
规则 R1 的直接后果：只允许 "X ↔ 枢纽(Chat Completions)" 翻译对，禁止两两直连。
若要打通，正确做法是**经枢纽二级串联**（`messages → chat → responses`），不是新增
直连翻译器——但串联会叠加第 2 节的两段落差，实现前先读第 4 节。

### 选路层级

`selectRouteTarget()`（`src/lib/route-target/select.ts`）的分层判别**优先于**
`connectionPriority`：

```
专用原生  >  专用转换  >  通配原生  >  通配转换
```

回退到非原生 endpoint 的 target 由 `build.ts` 打上 `RouteTarget.isTranslated`。
**不要**把 `isTranslated` 或 `isWildcard` 编码成 priority 标量偏移——历史上的
`WILDCARD_PRIORITY_BASE` 就是这么写的，已经废弃。failover 把原生候选 exclude 之后，
转换 target 仍会作为后备被选中，这是有意的。

---

## 2. 不可修的协议落差

### 2.1 chat → responses：合成的 reasoning item 没有 `encrypted_content`

`buildResponsesOutputFromChatMessage()`（`src/services/copilot/chat-to-responses.ts`）
用上游的 `reasoning_content` 合成一个 `{ type: "reasoning", id, summary }` item。

**为什么不可修**：`encrypted_content` 是 OpenAI 服务端签发的密文，Chat Completions
上游根本不产出。没有它，Responses 客户端（Codex CLI）下一轮 replay 时丢失推理上下文，
`src/lib/cache/reasoning-replay-cache.ts` 在这条路上也帮不上忙——它缓存的是
codex-native 直连路径拿到的真实 blob。

**不要做**：不要伪造 `encrypted_content`（上游会拒），不要为了"补全"去调
codex-native 拿一个不属于本次对话的 blob。

### 2.2 chat → messages：无签名的历史 thinking 会被剥离

`translateAssistantMessage()` / `addSignedReasoning()`
（`src/services/protocols/openai/chat-to-messages.ts`）只在 `signature` 存在时
才生成 `thinking` block；剥空的 assistant turn 用 `EMPTY_TEXT_PLACEHOLDER`
（`"(no content)"`）兜底，因为 Anthropic 拒绝空 content 数组和纯空白 text block。
**占位符必须是非空白文本**（见 §3.9）。

**为什么不可修**：Anthropic 拒收无签名的历史 thinking block（400）。响应侧
（`messages-to-chat.ts`）**已经**把签名透出去了——非流式在
`reasoning_details[].signature`，流式在 `delta.signature`——但绝大多数 OpenAI 客户端
不会回传这两个字段。落差在客户端，不在本仓库。

**后果**：转换路径重建出的 assistant turn 与 Claude 实际产出的 block 序列不一致。
对 prompt cache 无害（缓存断点写在上一轮请求末尾，在该 turn 之前），但推理上下文会丢。

**不要做**：不要为了"保住" thinking 而伪造 signature；不要移除
`EMPTY_TEXT_PLACEHOLDER` 兜底。

### 2.3 messages → chat：`cache_control` 断点被丢弃

Chat Completions 上游没有显式缓存断点的概念，只能吃上游自己的隐式前缀缓存。
这是**正确行为**，不要试图把 `cache_control` 塞进 chat payload。

### 2.4 stop_reason 映射是多对一，不可逆

`mapAnthropicStopReasonToOpenAI()`（`src/services/protocols/openai/messages-to-chat.ts`）
把 `end_turn` / `stop_sequence` / `pause_turn` / `refusal` 全部收敛成 `"stop"`。
`refusal` 的拒绝文本本身保留在 content 里。往返转换不会还原原始值。

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

签名只对**签发它的那段原文**有效。`handleAssistantMessage()`
（`src/services/protocols/anthropic/non-stream-translation.ts`）曾把一个 assistant turn
里的多个 thinking block `join("\n\n")` 成单个 `reasoning_content`，签名用 `.find(...)`
只取第一个 —— 这段"拼接文本 + 第一个签名"的组合送回任何会校验签名的 Anthropic 上游
都会 400。

**锁定**：2 个及以上 thinking block 时额外输出有序的 `reasoning_details`
（`{ type: "reasoning.text", text, signature }` 逐块一条）。
`translateAssistantMessage()`（`src/services/protocols/openai/chat-to-messages.ts`）
优先读这个字段并逐块还原。

**只有一个 block 时不输出 `reasoning_details`** —— 此时 `reasoning_content` + 顶层
`signature` 已经是无损的，保持原有 wire format 不变，避免给不认识该字段的上游增加
风险。新增读取历史 reasoning 的代码请沿用这个"仅在会丢信息时才加字段"的取舍。

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
`switch` 在 `source.type` 上（反向的 `mapContent()` 会把两者收敛回 OpenAI 单一的
`url` 字段）。既不是 `data:` 也不是 http(s) 的（`blob:` / `file:`）以及 Anthropic
不接受的 media type 仍然丢弃，但**带 warn 日志**。

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

## 4. 如果要打通 messages ↔ responses

按规则 R1，**不新增直连翻译器**，走枢纽二级串联。

**已就绪**：签名保真（3.5）已经修好，枢纽上的 `Message` 现在能无损承载多个带签名的
thinking block，串联不会再把它放大成 400。

**待办**：

1. 明确两段落差叠加后的可接受范围：
   - `messages → chat → responses`：Anthropic thinking → `reasoning_details` →
     合成 reasoning item（无 `encrypted_content`，见 2.1）。签名一路带到底但对
     Responses 上游无意义。**可用。**
   - `responses → chat → messages`：replay 的 reasoning summary → `reasoning_content`
     → **被剥离**（Responses 的 summary 本来就没有 Anthropic 签名，见 2.2）。
     等于推理上下文全丢。**这不是实现缺陷，是协议落差**——3.5 修的是"本来有签名却弄丢"，
     这里是"源头就没有签名"。
2. 缓存：`responses → messages` 这段要复用 `withPromptCacheBreakpoints()`，
   否则重蹈 3.2。
3. `resolveEndpoints()` 的 fallback 表加 `messages: ["chat", "responses"]` /
   `responses: ["chat", "messages"]`，并确认 `isTranslated` 分层仍能让原生优先。
4. dispatch 层（`src/services/dispatch/shared.ts`）目前是单跳分派
   （`target.endpoint === X` → 对应 adapter 方法），串联需要显式的两跳组合器。

结论：**可以实现，但不是小改动**。`messages → responses` 方向落差可接受；
`responses → messages` 方向推理上下文全丢（第 1 步），实践中可能不值得——
优先考虑给这类模型配一个原生 endpoint 的 connection。
