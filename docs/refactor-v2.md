# 双向协议转换重构方案 v2

状态：**已实施，持续修复中**
日期：2026-08-01
范围：messages→chat 保真度修复 + 新增 chat→messages 方向
（替代 `refactor-chat-messages-bidirectional-translation.md`：不做共享
mapping 层大抽取、不新增连接级配置字段，先做真实 bug 修复再补新方向）

## 背景与现状（已核实）

### messages→chat 已存在，但有三个保真度缺口

1. **历史思考块无条件剥离，导致 DeepSeek 工具轮次 400。**
   `anthropic/non-stream-translation.ts` 的 `handleAssistantMessage` 无条件
   剥离历史 assistant 消息中的 thinking——这只对 Copilot 后端是硬约束
   （代码注释：Copilot API rejects reasoning_text in historical assistant
   messages）。但 DeepSeek thinking mode + 工具调用**硬性要求**回传
   `reasoning_content`，否则 400
   （`Missing reasoning_content field in the assistant message`，见官方
   文档 thinking_mode#tool-calls）；Kimi/Qwen/xAI 也接受该字段。
   `messages-via-chat.ts` 复用 `translateToOpenAI()`，把剥离无差别套用
   到所有 openai-compatible 上游——这是当前真实可复现的线上 bug。

2. **`thinking` → `reasoning_effort` 映射产生非标值。**
   `non-stream-translation.ts` 的
   `translateAnthropicThinkingToReasoningEffort`：
   `adaptive → "auto"`（OpenAI `reasoning_effort` 没有 `"auto"` 这个合法
   值）、`disabled → "none"`（大量第三方上游不识别）。

3. **`chat-to-responses.ts` 的 `getReasoningDelta` 漏读
   `reasoning_content`**（现为 `reasoning_text ?? reasoning ?? thinking
   ?? ""`）。注意：anthropic 侧的 `stream-translation.ts`
   `getThinkingDelta` 别名链**已包含** `reasoning_content`，无需修改——
   早期调研中"流式不读 reasoning_content"的说法对 anthropic 侧已过时，
   只剩 responses 侧这一处。

### chat→messages 完全缺失

- `dispatch/shared.ts` 的 chat 分支硬性要求 `adapter.createChatCompletions`，
  否则 501；没有镜像 messages 分支的 fallback。
- `route-target/build.ts` 的 `resolveEndpoints` fallbackMap 是单值映射，
  且 `chat` 已被 `"responses"` 占用，没有 `chat→messages` 条目。
- `claude-native` / `anthropic-compatible` adapter 只实现 `createMessages`
  （`mimo-native` 同时实现了 `createChatCompletions`，不受影响）。

### 可复用原语

- `~/lib/id-sanitizer` 的 `sanitizeId`（tool_call id 清洗）
- `~/lib/thinking` 的 `LEVEL_TO_BUDGET` / `budgetToLevel`
- `~/lib/usage-translation` 的 `openAIUsageToAnthropic`（需补反向）
- `anthropic/stream-translation.ts` 的 `createInitialStreamState`（流式
  状态机范式）
- `mapOpenAIStopReasonToAnthropic`（需补反向）
- `messages-via-chat.ts` 的包装器模式（类型守卫分流 + executor 委托）
- `AnthropicMessagesPayload` 类型已建模 `thinking.type: "adaptive"` 与
  `output_config.effort: "low" | "medium" | "high" | null`，chat→messages
  的 thinking 映射可直接使用

## Phase 1 — messages→chat 保真度修复（小步、低风险）

### 1.1 `anthropicUsageToOpenAI`（`src/lib/usage-translation.ts`）

`openAIUsageToAnthropic` 的严格反向：净值 + cache buckets =
`prompt_tokens`。供 Phase 2 响应翻译使用。

### 1.2 流式 `reasoning_content` 读取修复

只改 `src/services/copilot/chat-to-responses.ts` 的 `getReasoningDelta`，
别名链补上 `reasoning_content`，与 anthropic 侧对齐：

```ts
return (
  delta.reasoning_text ?? delta.reasoning_content ?? delta.reasoning
  ?? delta.thinking ?? ""
)
```

### 1.3 `thinking` → `reasoning_effort` 映射修正（non-stream-translation.ts）

- `adaptive` → 不再发 `"auto"`，改为**省略** `reasoning_effort`（让上游
  用各自默认）
- `disabled` → 不再发 `"none"`，改为**省略**（跨上游无法可靠关闭推理；
  xAI/grok 本就不允许关）
- 客户端显式传 `reasoning_effort: "auto"` 或 `"none"` 同样省略；但
  `thinking: { type: "enabled", budget_tokens: 0 }` 推导出的 `"none"`
  保留，作为显式 Anthropic 预算关闭语义，交由 provider-specific sanitizer
  决定最终 wire 行为
- `enabled + budget_tokens` → `budgetToLevel` 保留不变

### 1.4 历史思考保留（核心保真度项）

- `create-chat-completions.ts` 的 `Message` 输入类型补
  `reasoning_content?: string` 字段
- `translateToOpenAI(payload, options?: { preserveHistoricalReasoning?:
  boolean })`：开启时，历史 assistant 消息的 thinking 块转成
  `reasoning_content` 保留，替换现在的无条件剥离。**默认 `false`，向后
  兼容**
- `messages-via-chat.ts` 按 `target.protocol !== "copilot-native"` 传入
  （copilot-native 是唯一已知拒绝历史 reasoning 的上游；DeepSeek 是硬性
  要求，其余接受即无害）
- `routes/messages/copilot-handler.ts` 保持默认（剥离），Copilot 原生
  路径行为不变

## Phase 2 — 新增 chat→messages 转换层（镜像 messages-via-chat）

### 2.1 新模块 `src/services/protocols/openai/`（镜像 `anthropic/` 目录）

```
openai/
  types.ts            # ChatViaMessagesStreamState 反向流状态机
  chat-to-messages.ts # 请求翻译：ChatCompletionsPayload → AnthropicMessagesPayload
  messages-to-chat.ts # 响应翻译：非流式 + translateAnthropicStreamToChatEvents
  (chat-via-messages.ts 放在 protocols/ 根，与 messages-via-chat.ts 同级)
```

### 2.2 请求翻译 `translateChatPayloadToAnthropic`

- `system`/`developer` → Anthropic `system`；`user`/`assistant`/`tool`
  消息映射
- `tool_calls` → `tool_use` 块（`sanitizeId` + `arguments` JSON.parse）；
  `tool` 消息 → `tool_result` 块（保持顺序）
- 历史 assistant 的 `reasoning_text`/`reasoning_content` → `thinking` 块，
  **仅当携带 `signature` 才保留，否则剥离**——Claude 拒绝历史中无签名的
  thinking 块，宁可丢也不发无效 block
- `reasoning_effort` → `thinking: { type: "adaptive" }` +
  `output_config.effort`（`AnthropicMessagesPayload` 类型已支持）。
  **映射收窄**：`output_config.effort` 只有 `low/medium/high` 三档，
  `minimal → low`、`xhigh → high`；客户端显式 `"none"` → 省略 `thinking`
  字段
- `tools`/`tool_choice`/`stop`/`temperature`/`top_p`/`user` 全映射
- **`max_tokens` 兜底**：Anthropic 协议必填，OpenAI 客户端可能未传。
  新增专用常量 `DEFAULT_VIA_MESSAGES_MAX_TOKENS = 64000`（对齐现有先例：
  windsurf 的 `payload.max_tokens ?? 64000`、Claude Code OAuth 的 64k
  输出上限 clamp）
- v1 丢弃并文档记录：`n`、`seed`、`logprobs`、`logit_bias`、
  `frequency/presence_penalty`、`response_format`、`stream_options`

### 2.3 响应翻译 `messages-to-chat.ts`

- 非流式 `translateAnthropicResponseToChat`：`thinking` →
  `reasoning_content`、`tool_use` → `tool_calls`、`stop_reason` →
  `finish_reason` 反向映射（多对一有损，注释标注不可逆）、usage 反向
  换算（用 1.1 的 `anthropicUsageToOpenAI`，cache buckets 丢弃）
- 流式 `translateAnthropicStreamToChatEvents`：`message_start` → 首 chunk、
  `thinking_delta` → `delta.reasoning_content`、`signature_delta` →
  `delta.signature`、`text_delta` → `delta.content`、`input_json_delta` →
  `delta.tool_calls` 分片、`message_delta` → `finish_reason` + usage 尾
  chunk、`message_stop` → `[DONE]`

### 2.4 包装器与接线

- `chat-via-messages.ts` 的 `createChatViaMessages` 完全镜像
  `messages-via-chat.ts`：类型守卫区分流式/非流式，委托
  `messagesExecutor`
- `dispatch/shared.ts` chat 分支：`adapter.createChatCompletions` 原生
  优先；否则若 `adapter.createMessages` 存在 → `createChatViaMessages`
  （模型已重写为 `upstreamModelId`）；仍无 → 501。仅
  claude-native/anthropic-compatible 会触发，现有路径零影响
- `build.ts` 的 `resolveEndpoints`：`chat` 的 fallback 从单值
  `"responses"` 改为**有序候选** `["responses", "messages"]`（首个命中），
  `responses→chat`、`messages→chat` 条目不变。使 endpoints 为
  `["messages"]` 的模型可被 chat 请求选中
- **fallback target 不做降优先级**：与现有 `messages→chat` /
  `responses→chat` fallback 行为一致（它们也没有降权）；原生 vs 转换的
  取舍由 connection priority 显式控制。未来若要降权应三方向统一改

## Phase 3 — 测试与收尾

新测试（沿用现有风格：`bun:test` + `~/*` 导入 + 流式全序列 `toEqual`
断言）：

- `tests/chat-via-messages.test.ts`：请求翻译（system/tools/tool_calls/
  思考保留与 signature 降级/effort 映射收窄/max_tokens 兜底/丢弃项）、
  非流式响应翻译、流式全序列（Anthropic SSE → OpenAI chunks）
- `tests/chat-completions-via-messages.test.ts`：路由级集成——
  `/v1/chat/completions` → anthropic-compatible 连接，mock fetch 打上游
  `/v1/messages`，断言翻译后载荷与响应（镜像 `messages-route.test.ts`）
- 补测试：`usage-translation.test.ts`（`anthropicUsageToOpenAI` 反向
  守恒）、`anthropic-response.test.ts`（responses 侧 reasoning_content
  delta）、`anthropic-request.test.ts`（历史保留 + adaptive/disabled
  修正）、`unified-routing.test.ts`（chat→messages endpoint fallback，
  且 chat→responses 优先不回归）

收尾：README 协议矩阵更新 + 丢弃参数文档；`bun run typecheck`、
`bun run lint`、`bun test` 全绿。

## 明确不做（v1 范围外）

- `response_format` 的隐藏工具强制（v1 丢弃）
- Anthropic `cache_control` 在 OpenAI 上游的语义映射（上游无此概念，
  两个方向都丢弃）
- 远程 image URL 拉取转 base64
- 每连接思考保留的配置开关（Phase 1 按 protocol 自动判定已够用）
- 共享 `mapping/` 双向映射层大抽取（原 v1 方案的 Phase 0；镜像目录 +
  复用原语已够，避免无行为变化的纯 churn）
- `budget_tokens` 路径：chat→messages 方向统一走 adaptive+effort。若
  旧模型/三方网关拒绝 adaptive，届时再按模型分流，v1 不预判

## 风险与决策

- **历史保留默认开**（非 copilot-native 即保留）：风险是严格 schema 的
  OpenAI 上游可能拒绝 `reasoning_content`；缓解——仅当客户端历史里确有
  thinking 块才发送。DeepSeek 当前工具轮次已 400，保留是净修复
- **chat→messages 仅对无 `createChatCompletions` 的 adapter 触发**，
  现有原生路径零影响
- **claude-native 叠加 CC-stealth 变换**（cch/tool-prefix/prompt-cache）：
  翻译载荷用 Anthropic 原生结构（`input_schema` 工具、adaptive
  thinking）即兼容，已纳入设计
- **`max_tokens` 默认 64000 兜底**：客户端未传时保证 Anthropic 必填
  字段存在；connection 级覆盖留作后续扩展
- **effort 三档收窄**（minimal→low、xhigh→high）是有损映射，写入代码
  注释避免后续被当 bug 修

## 验收标准

- `bun test` 全量通过，现有 `tests/anthropic-*.test.ts` 不回归
- `bun run typecheck` 与 `bun run lint` 通过
- DeepSeek 场景回归：thinking mode + 多轮工具调用历史中的
  `reasoning_content` 被保留（Phase 1 核心验收项）
- 端到端：仅配置 claude-native/anthropic-compatible connection，打
  `/v1/chat/completions`（非流式 + 流式）返回正确 OpenAI 形状响应
