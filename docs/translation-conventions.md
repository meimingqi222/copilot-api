# 格式翻译规约

状态：**生效中**
日期：2026-07-15
关联：`docs/refactor-usage-translation.md`（usage 收口模式参考）

## 1. 枢纽格式

本仓库的**枢纽格式（hub format）**为 **OpenAI Chat Completions**。

这是现状事实标准：所有上游 provider 的 native adapter 最终产出 Chat Completions
形状的响应（`ChatCompletionResponse` 或 `AsyncIterable<CopilotStreamEvent>`），
所有客户端格式（Anthropic Messages、OpenAI Responses）的入口翻译都以 Chat
Completions 为中转。

## 2. 新增格式规则

### 规则 R1：只允许 "X ↔ 枢纽" 翻译对

新增客户端格式或上游格式时，**只允许**实现该格式与枢纽格式（Chat Completions）
之间的一对翻译（`X → hub` + `hub → X`）。

**禁止**新增两两直连翻译对（如 Anthropic Messages → Responses、Antigravity →
Messages 等）。任何跨格式需求必须经枢纽中转：
`source → hub → target`。

> 理由：N 种格式的两两直连需要 N×(N-1) 个翻译，而枢纽模式只需 2×N。
> 翻译对随格式数平方增长的复杂度是本仓库已存在的痛点，本规约阻止其继续恶化。

### 规则 R2：stream / non-stream 共享事件级转换

同一翻译对的流式（stream）与非流式（non-stream）版本**必须共享事件级转换函数**。

具体要求：
- 非流式翻译函数处理完整响应对象。
- 流式翻译函数在事件（chunk/event）级别复用非流式的字段映射逻辑，
  而非重新实现一份语义相同的映射。
- 参考已实施模式：`docs/refactor-usage-translation.md` 中 usage 字段的
  收口方式——抽取共享的 `openAIUsageToAnthropic()` 函数，stream 与
  non-stream 路径共同调用。

> 理由：stream 与 non-stream 的语义差异仅在于"增量 vs 批量"，
> 字段映射规则应当一致。重复实现易导致 stream/non-stream 间的字段语义漂移
> （`refactor-usage-translation.md` 记录的 cache_creation 双计 bug 即为此类）。

### 规则 R3：usage 翻译收口

所有 usage（token 计数）字段的格式翻译**必须**经由
`src/lib/usage-translation.ts` 的共享函数（`openAIUsageToAnthropic` 等），
不得在各翻译文件内联实现 usage 映射。

此规则已实施，详见 `docs/refactor-usage-translation.md`。

## 3. 存量翻译对清单（豁免，随缘收敛）

以下翻译对在本规约确立前已存在，标注为"存量豁免"——不强制重写，
但随维护机会逐步收敛至 R1/R2。

| 翻译对 | 方向 | 文件 | stream/non-stream | 备注 |
| --- | --- | --- | --- | --- |
| Chat ↔ Responses | Chat → Responses | `src/services/copilot/chat-to-responses.ts` | 两者 | `translateToResponsesPayload` / `translateChatCompletionToResponses` / `translateChatCompletionsStreamToResponses` |
| Chat ↔ Responses | Responses → Chat | `src/services/copilot/responses-to-chat.ts` | 两者 | `translateResponsesToChatPayload` / `translateResponsesToChatCompletion` / `translateResponsesStreamToChatCompletions` |
| Messages ↔ Chat | Messages → Chat | `src/routes/messages/non-stream-translation.ts` | non-stream | `translateToOpenAI` |
| Messages ↔ Chat | Chat → Messages | `src/routes/messages/non-stream-translation.ts` | non-stream | `translateToAnthropic` |
| Messages ↔ Chat | Chat stream → Messages stream | `src/routes/messages/stream-translation.ts` | stream | `translateChunkToAnthropicEvents` / `translateStreamEndEvents` |
| Antigravity | Chat → Antigravity | `src/services/antigravity/translate-request.ts` | 请求级 | `translateOpenAiChatToAntigravity` |
| Antigravity | Antigravity → Chat | `src/services/antigravity/translate-response.ts` | 两者 | `convertAntigravityStreamChunk` / `convertAntigravityNonStreamResponse` |
| Chat via Responses | Chat → Responses → Chat | `src/services/protocols/chat-via-responses.ts` | 自动检测 | `createChatViaResponses`（用于仅支持 Responses API 的 provider：codex/xai） |
| Copilot Messages | Messages → Copilot Messages | `src/services/copilot/create-messages-translate.ts` | 请求级 | `translateToCopilotMessages` |

### 存量豁免的收敛方向

- **Messages ↔ Chat**：`non-stream-translation.ts` 与 `stream-translation.ts`
  分属两文件，stream 版本的字段映射逻辑与非流式版本有重复。收敛方向：
  抽取共享的事件级转换函数（如 `mapOpenAIStopReasonToAnthropic` 已在
  `utils.ts` 中共享，可进一步扩大共享面）。
- **Chat ↔ Responses**：双向各三个函数（payload / non-stream / stream），
  stream 与 non-stream 间的字段映射逻辑有重复。收敛方向同上。
- **Antigravity**：request/response 各一文件，stream/non-stream 在
  `translate-response.ts` 内共存。收敛方向：抽取 Gemini ↔ Chat 的事件级
  字段映射共享函数。

## 4. 辅助转换（非完整翻译对）

以下文件提供字段级规范化或辅助映射，不属于完整翻译对，但被多个翻译对共享：

| 文件 | 用途 |
| --- | --- |
| `src/lib/usage-translation.ts` | OpenAI usage → Anthropic usage（R3 收口点） |
| `src/routes/chat-completions/normalize.ts` | Copilot 非标准字段 → 标准 OpenAI 字段（`normalizeChunk` / `normalizeResponse`） |
| `src/services/copilot/normalize-responses-stream.ts` | Responses 流 ID 规范化 |
| `src/routes/messages/utils.ts` | 停止原因映射、签名别名提取等辅助函数 |

## 5. 新增格式时的检查清单

新增客户端格式 X 时：
- [ ] 实现 `X → Chat Completions` 请求翻译（`translateXToChatPayload`）
- [ ] 实现 `Chat Completions → X` 响应翻译（非流式 + 流式）
- [ ] stream 与 non-stream 版本共享事件级字段映射函数
- [ ] usage 字段翻译经由 `src/lib/usage-translation.ts`
- [ ] **不得**实现 X 与 Messages/Responses/Antigravity 的直连翻译

新增上游格式 Y 时：
- [ ] 实现 `Chat Completions → Y` 请求翻译
- [ ] 实现 `Y → Chat Completions` 响应翻译（非流式 + 流式）
- [ ] stream 与 non-stream 版本共享事件级字段映射函数
- [ ] **不得**实现 Y 与 Messages/Responses/Antigravity 的直连翻译
