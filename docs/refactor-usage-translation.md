# Usage 翻译收口与守恒测试重构方案

状态：**已实施**（2026-07-11，详见文末"实施记录"）
日期：2026-07-11
关联问题：OpenAI 形状 usage → Anthropic Messages 协议翻译时，
`cache_creation_input_tokens` 未从 `input_tokens` 中扣除，导致下游
（如 crush 的 Anthropic 分支 `InputTokens + CacheCreationTokens +
CacheReadTokens`）把 cache_creation 计两次。

## 背景与根因

1. usage 翻译逻辑散落在四处，语义靠注释维持：
   - `src/routes/messages/stream-translation.ts`（`buildAnthropicStreamUsage`
     约 14 行起，及 `message_start` 构造约 243 行起）
   - `src/routes/messages/non-stream-translation.ts`（约 351-368 行）
   - `src/services/copilot/chat-to-responses.ts`（`translateChatUsageToResponsesUsage`，约 839 行）
   - `src/services/copilot/responses-to-chat.ts`（`translateUsage`，约 479 行）
2. 已确认的真实 bug：`src/services/windsurf/chunk-builders.ts:118-121` 会把
   Windsurf 的 `cache_write_tokens` 写入 OpenAI 形状的
   `prompt_tokens_details.cache_creation_input_tokens`。该 usage 若再经
   Anthropic Messages 协议输出，`input_tokens = prompt_tokens - cached_tokens`
   只扣了 cache_read、没扣 cache_creation —— Anthropic 语义要求
   `input_tokens` **同时排除** cache_read 与 cache_creation（两者单列）。

## 语义约定（本仓库内部统一）

OpenAI 形状（chat / responses）：
- `prompt_tokens` / `input_tokens` = 含 cache_read 与 cache_creation 的总量。
- 明细在 `prompt_tokens_details.cached_tokens` /
  `input_tokens_details.cached_tokens` 与（本仓库扩展的）
  `*_details.cache_creation_input_tokens`。

Anthropic 形状：
- `input_tokens` = 不含任何 cache token 的净值；
  `cache_read_input_tokens`、`cache_creation_input_tokens` 单列。

守恒不变量：任何一次翻译前后，
`总输入(净值 + cache_read + cache_creation) + 输出` 不变。

## Phase C1：抽取共享翻译函数并修复双计

1. 新建 `src/lib/usage-translation.ts`，导出：

   ```ts
   /** OpenAI 形状 usage → Anthropic 形状 usage（净值语义）。 */
   export function openAIUsageToAnthropic(usage: {
     prompt_tokens: number
     completion_tokens: number
     prompt_tokens_details?: {
       cached_tokens?: number
       cache_creation_input_tokens?: number
     }
   }): {
     input_tokens: number // = prompt - cached - cache_creation，clamp ≥ 0
     output_tokens: number
     cache_read_input_tokens?: number
     cache_creation_input_tokens?: number
   }
   ```

2. 三个 Anthropic 输出点全部改用该函数：
   - `stream-translation.ts` 的 `buildAnthropicStreamUsage`
   - `stream-translation.ts` 中 `message_start` 的 usage 构造
   - `non-stream-translation.ts` 的非流式 usage 构造

   修复点：`input_tokens` 计算改为
   `max(0, prompt_tokens - cached_tokens - cache_creation_input_tokens)`。

3. **注意**：实施前先核实 Windsurf 上游 `usage.prompt_tokens` 是否确实包含
   cache_write 部分（见 `src/services/windsurf/response-parsers.ts` 等解析
   处）。若 Windsurf 的 prompt_tokens 不含 cache_write，则应改
   `chunk-builders.ts` 使其符合上文 OpenAI 形状约定（prompt_tokens 为总量），
   而不是在 Anthropic 侧扣减两次。两种情况只能取其一，以守恒不变量为准。

## Phase C2：守恒测试

新增 `tests/usage-translation.test.ts`：

1. `openAIUsageToAnthropic` 单测：含/不含 cached、含/不含 cache_creation
   四种组合，断言净值与守恒。
2. 往返守恒测试：构造带 cache 明细的 usage，经
   `translateChatUsageToResponsesUsage` → `translateUsage`（responses→chat）
   往返，断言 `prompt_tokens`、`completion_tokens`、`cached_tokens` 不丢失
   不变形（`cache_creation` 明细在 responses→chat 方向目前会丢失——本次
   一并补上，把 `input_tokens_details.cache_creation_input_tokens` 带回
   `prompt_tokens_details`）。
3. Anthropic 方向回归测试：给定
   `prompt=1000, cached=600, cache_creation=200, completion=50`，断言
   Anthropic 输出为 `input_tokens=200, cache_read=600, cache_creation=200,
   output=50`（总量守恒 = 1050）。

## 验收标准

- `bun run lint`（或仓库现有 lint 命令）与 `bun test` 全部通过，
  现有测试（尤其 `tests/anthropic-response.test.ts`）不回归；若现有测试
  断言的是错误的旧行为（未扣 cache_creation），更新断言并在提交说明里注明。
- 不修改 `/responses` 透传路径的行为（该路径无需改动）。

## 实施记录

状态：**已实施**（2026-07-11）

- [x] Phase C1 完成，涉及文件：
  - 新增 `src/lib/usage-translation.ts`：导出 `openAIUsageToAnthropic`，
    净值计算改为 `max(0, prompt_tokens - cached_tokens -
    cache_creation_input_tokens)`。
  - `src/routes/messages/stream-translation.ts`：`buildAnthropicStreamUsage`
    与 `message_start` 的 usage 构造均改用共享函数。
  - `src/routes/messages/non-stream-translation.ts`：`translateToAnthropic`
    的非流式 usage 构造改用共享函数。
  - `src/services/copilot/responses-to-chat.ts`：`translateUsage`
    （responses→chat）补回 `cache_creation_input_tokens`，避免它在这个方向
    丢失（否则二次经过 `openAIUsageToAnthropic` 时会把 cache-write 部分
    误算作净输入）。
  - `src/services/copilot/responses-api-types.ts`：`ResponsesUsage.
    input_tokens_details` 补充 `cache_creation_input_tokens?: number` 字段
    声明（此前 `chat-to-responses.ts` 已经在往这个字段写值，但类型上没有
    声明，靠对象展开绕过了多余属性检查；这次顺手把类型补上，
    `responses-to-chat.ts` 需要显式读取该字段，不能再依赖展开绕过）。
  - `src/services/copilot/chat-to-responses.ts`（`translateChatUsageToResponsesUsage`）
    与三个 Anthropic 输出点以外的其它路径未改动，符合"不改 /responses
    透传路径"的约束。

- [x] Phase C2 完成，新增测试：`tests/usage-translation.test.ts`
  - `openAIUsageToAnthropic` 单测：无缓存 / 仅 cache_read / 仅
    cache_creation / 两者都有 / clamp 到 0，共 5 个用例。
  - Anthropic 方向回归测试：`prompt=1000, cached=600, cache_creation=200,
    completion=50` → `input_tokens=200, cache_read=600, cache_creation=200,
    output=50`，总量守恒 1050。
  - 往返守恒测试：`ChatCompletionResponse.usage` 经
    `translateChatCompletionToResponses` → `translateResponsesToChatCompletion`
    往返后，`prompt_tokens`、`completion_tokens`、`cached_tokens`、
    `cache_creation_input_tokens` 均不丢失；并验证往返后的 usage 再喂给
    `openAIUsageToAnthropic` 仍满足守恒不变量。

- [x] Windsurf prompt_tokens 语义核实结论：
  **`cache_write_tokens` 在当前 Windsurf 解析管线中从未被真正赋值** ——
  `src/services/windsurf/response-parsers.ts` 的 protobuf 解析只产出
  `cached_tokens` / `cache_read_tokens`（field 33、field 28 的
  `cached_input_tokens`），没有任何已知字段对应"cache 写入"；
  `src/services/windsurf/create-chat-completions.ts` 的跨帧合并对象字面量
  （约 287-300 行）也没有把 `cache_write_tokens` 透传下去。因此
  `chunk-builders.ts:118-121` 里 `cache_creation_input_tokens:
  usage.cache_write_tokens` 这个分支在真实流量下恒为 `undefined`，
  目前不会触发双计问题。
  就现有代码而言，Windsurf 的 `promptTokensOpenAI = inputTokens +
  cachedTokens`（field 28 语义：`input_tokens` 是"非缓存的真实 prompt 部分"）
  已经符合仓库约定的"prompt_tokens = 总量"语义——若未来
  Windsurf 真的开放了 cache 写入统计，其数值在概念上也只会是
  field 28 `input_tokens`（本就计入 promptTokensOpenAI 的非缓存部分）的一个
  子集，而不是需要额外叠加的量，因此**不需要改动
  `chunk-builders.ts` 或 Windsurf 侧的 prompt_tokens 计算**。
  按方案文档的判断规则（两种情况只能取其一，以守恒不变量为准），
  选择在 Anthropic 输出侧同时扣减 `cached_tokens` 与
  `cache_creation_input_tokens`（Phase C1 第 2 点），这也是本次唯一需要
  修复的一侧。

- [x] 全量测试通过：`bun test` → 502 pass / 2 skip / 0 fail
  （504 个测试，64 个文件，含新增的 `tests/usage-translation.test.ts` 8 个
  用例）；`tests/anthropic-response.test.ts`（17 个用例）全部保持通过，
  未发现断言旧（未扣 cache_creation）行为的用例，因此无需更新其断言。
  `bun run lint:all`（eslint --cache .）与 `bun run typecheck`（tsc）均无
  错误。
