# 通用 Provider 与模型路由机制实施方案

## 背景

当前 `copilot-api` 已经具备 provider runtime、账号可用性、模型缓存、优先级排序、429 冷却和跨账号 failover 等基础能力，但 provider 和账号模型仍然偏静态：

- `ProviderId` 固定为 `copilot`、`codebuff`、`windsurf`。
- `Account` 类型按具体 provider 分叉，新增 provider 需要新增 provider-specific account 类型和 settings getter/setter。
- admin 账号新增、更新、凭据判断逻辑按 provider 写分支。
- 每接入一个 OpenAI-compatible 或 Anthropic-compatible 服务商，都可能复制一套 runtime、model discovery 和 auth 逻辑。

目标是把“服务商是谁”和“协议怎么调”拆开，让 DeepSeek、OpenRouter、自建 vLLM、企业内网 OpenAI-compatible 服务、Anthropic-compatible 服务都可以通过配置接入，同时保留 Copilot、Windsurf、Codebuff 这类特殊协议的 custom adapter 能力。

## 设计目标

1. 支持通用 OpenAI-compatible provider 代理。
2. 支持通用 Anthropic-compatible provider 代理。
3. 支持同一 provider 下多个 API key 轮询、限流 failover、失效 key 自动禁用和手动恢复。
4. 支持 provider 从模型端点自动发现模型，也支持手工声明可用模型和别名。
5. 支持不同 provider 提供同名模型时按优先级和权重负载均衡。
6. 减少 provider-specific 分支，后续新增标准协议服务商不需要新增 TypeScript runtime 文件。
7. 保持现有 Copilot、Codebuff、Windsurf 行为兼容，分阶段迁移。

## 核心原则

### Provider 不再等于协议

Provider connection 表示一个上游服务实例，例如：

- `deepseek`
- `openrouter`
- `siliconflow`
- `company-vllm`

Protocol adapter 表示调用协议，例如：

- `openai-compatible`
- `anthropic-compatible`
- `copilot-native`
- `windsurf-native`
- `codebuff-native`

这样新增 DeepSeek 不需要新增 `deepseek.ts`，只需要新增一条 provider connection 配置，复用 `openai-compatible` adapter。

### 调度单位不是 Account，而是 RouteTarget

当前账号选择以 `Account` 为中心。通用化后应把 provider connection 和 credential 展平为可调度的 route target：

```typescript
interface RouteTarget {
  providerId: string
  providerName: string
  protocol: ProviderProtocol
  credentialId: string
  publicModelId: string
  upstreamModelId: string
  endpoint: ModelEndpoint
  providerPriority: number
  providerWeight: number
  credentialPriority: number
  credentialWeight: number
  availability: TargetAvailability
}
```

路由层只关心 `RouteTarget` 是否支持当前模型和 endpoint，不再关心它来自 Copilot 账号、DeepSeek key 还是 OpenRouter key。

## 数据模型

### ProviderConnection

```typescript
type ProviderProtocol =
  | "openai-compatible"
  | "anthropic-compatible"
  | "copilot-native"
  | "windsurf-native"
  | "codebuff-native"

interface ProviderConnection {
  id: string
  name: string
  protocol: ProviderProtocol
  baseUrl: string
  enabled: boolean
  priority: number
  weight?: number
  headers?: Record<string, string>
  modelDiscovery?: ModelDiscoveryConfig
  models?: Array<ModelMapping>
  credentials: Array<ApiCredential>
  createdAt: number
  updatedAt?: number
}
```

字段说明：

- `id`: provider connection 的稳定 ID，也是强制指定 provider 时的前缀，例如 `deepseek/deepseek-v4-flash`。
- `protocol`: 选择哪个 protocol adapter。
- `baseUrl`: 上游服务根地址，例如 `https://api.deepseek.com/v1`。
- `priority`: provider 级优先级，数字越小越优先。
- `weight`: 同优先级 provider 之间的轮询权重，默认 `1`。
- `headers`: provider 级固定 header，不包含 secret。
- `modelDiscovery`: 是否从上游模型端点自动发现模型。
- `models`: 手工声明、覆盖或补充模型。
- `credentials`: 此 provider 下的 API key 池。

### ApiCredential

```typescript
type CredentialAuthMode = "bearer" | "header"

> **实现说明**：原方案的 `api-key-header`（固定 `X-Api-Key` 头）与 `custom-header`（任意 header 名）本质相同，实现中合并为单一 `header` 模式，配合可选的 `headerName` 字段。读取旧配置时 `api-key-header` 和 `custom-header` 自动迁移为 `header`。

type CredentialStatus =
  | "ready"
  | "cooldown"
  | "auth_error"
  | "quota_exhausted"
  | "disabled"

interface ApiCredential {
  id: string
  label?: string
  authMode: CredentialAuthMode
  value: string
  headerName?: string
  enabled: boolean
  priority?: number
  weight?: number
  status: CredentialStatus
  cooldownUntil?: number
  lastRateLimitAt?: number
  lastErrorAt?: number
  lastError?: string
  createdAt: number
}
```

状态语义：

- `ready`: 可参与调度。
- `cooldown`: 遇到 429、临时配额限制或上游建议重试时间，冷却到期后自动恢复。
- `auth_error`: 遇到 401/403 或明确鉴权失败，自动禁用调度，需要手动激活。
- `quota_exhausted`: 遇到明确余额/配额耗尽错误，默认 24 小时后自动恢复（覆盖大多数 API 每日配额重置周期）；也可通过 admin API 手动 reset。
- `disabled`: 用户手动禁用。

### ModelMapping

```typescript
type ModelEndpoint =
  | "chat"
  | "responses"
  | "messages"
  | "embeddings"

interface ModelMapping {
  publicId: string
  upstreamId: string
  aliases?: Array<string>
  name?: string
  vendor?: string
  endpoints: Array<ModelEndpoint>
  enabled: boolean
  pickerEnabled?: boolean
  pickerCategory?: string
  metadata?: Record<string, unknown>
}
```

字段说明：

- `publicId`: 对客户端暴露的模型名，例如 `deepseek-v4-flash`。
- `upstreamId`: 请求上游时使用的模型名。
- `aliases`: 客户端可用的额外模型别名。
- `endpoints`: 此模型支持哪些入口。

### ModelDiscoveryConfig

```typescript
interface ModelDiscoveryConfig {
  enabled: boolean
  endpoint?: string
  intervalMs?: number
  mode?: "merge" | "replace" | "manual-only"
  include?: Array<string>
  exclude?: Array<string>
}
```

推荐默认：

- OpenAI-compatible: `GET /models` 或 `GET /v1/models`，根据 `baseUrl` 是否已经带 `/v1` 决定。
- Anthropic-compatible: 优先使用配置的 `endpoint`，因为 Anthropic-compatible 服务不一定有统一模型列表标准。
- `mode: "merge"`: 自动发现模型和手工模型合并，手工配置优先。

## 配置示例

### DeepSeek OpenAI-compatible Provider

```json
{
  "id": "deepseek",
  "name": "DeepSeek",
  "protocol": "openai-compatible",
  "baseUrl": "https://api.deepseek.com/v1",
  "enabled": true,
  "priority": 10,
  "weight": 1,
  "modelDiscovery": {
    "enabled": true,
    "mode": "merge"
  },
  "models": [
    {
      "publicId": "deepseek-v4-flash",
      "upstreamId": "deepseek-v4-flash",
      "aliases": ["deepseek/flash"],
      "endpoints": ["chat"],
      "enabled": true,
      "pickerEnabled": true
    }
  ],
  "credentials": [
    {
      "id": "key-a",
      "label": "main",
      "authMode": "bearer",
      "value": "sk-...",
      "enabled": true,
      "status": "ready",
      "priority": 0,
      "weight": 1,
      "createdAt": 1778600000000
    },
    {
      "id": "key-b",
      "label": "backup",
      "authMode": "bearer",
      "value": "sk-...",
      "enabled": true,
      "status": "ready",
      "priority": 0,
      "weight": 1,
      "createdAt": 1778600000000
    }
  ],
  "createdAt": 1778600000000
}
```

### 自建 OpenAI-compatible Provider

```json
{
  "id": "company-vllm",
  "name": "Company vLLM",
  "protocol": "openai-compatible",
  "baseUrl": "https://llm.internal.example.com/v1",
  "enabled": true,
  "priority": 20,
  "modelDiscovery": {
    "enabled": false
  },
  "models": [
    {
      "publicId": "qwen3-coder",
      "upstreamId": "Qwen3-Coder-480B-A35B-Instruct",
      "endpoints": ["chat"],
      "enabled": true
    }
  ],
  "credentials": [
    {
      "id": "internal-key",
      "authMode": "header",
      "headerName": "X-API-Key",
      "value": "internal-secret",
      "enabled": true,
      "status": "ready",
      "createdAt": 1778600000000
    }
  ],
  "createdAt": 1778600000000
}
```

## 路由选择流程

### 1. 解析模型引用

支持三种形式：

- `deepseek-v4-flash`: 不指定 provider，在所有 provider 中查找支持该模型的 route target。
- `deepseek/deepseek-v4-flash`: 强制使用 provider connection `deepseek`。
- alias，例如 `deepseek/flash`: 解析到目标 provider 和 `publicId` 或 `upstreamId`。

不建议把 credential ID 暴露到公开模型名里，例如 `deepseek/key-a/deepseek-v4-flash`。key 级调试应通过 admin API 或 debug API 实现，避免客户端绑定具体 key。

### 2. 构造候选 RouteTarget

候选条件：

- provider enabled。
- credential enabled 且 status 可用。
- 模型支持请求 endpoint。
- 如果请求显式指定 provider，则只保留该 provider。
- 如果请求未指定 provider，则保留所有支持该模型的 provider。

### 3. 可用性过滤

过滤顺序：

1. `disabled` 排除。
2. `auth_error` 排除。
3. `quota_exhausted` 排除。
4. `cooldownUntil > Date.now()` 排除。
5. provider 或 credential 不支持模型排除。

如果所有候选都被过滤，需要返回可诊断错误：

- 全部 cooldown: `429`，带最小 `Retry-After`。
- 全部 quota exhausted: `503`。
- 全部 auth_error: `503`，提示需要检查 key。
- 无 provider 支持模型: `503`，提示模型不可用。

### 4. 优先级与负载均衡

推荐算法：

1. 按 `providerPriority` 找到最高可用层。
2. 在该 provider 优先级层内按 provider weight 做 weighted round-robin。
3. 选中 provider 后，在其 credential 池内按 credential priority 找到最高可用层。
4. 在 credential 优先级层内按 credential weight 做 weighted round-robin。
5. 如果请求失败且错误可 failover，则先换同 provider 的下一个 credential，再换同模型的下一个 provider。

这样可以满足：

- DeepSeek 多 key 自动轮询。
- DeepSeek key-a 429 后自动切 key-b。
- DeepSeek 整体不可用后 fallback 到 OpenRouter 上的同名模型。
- Copilot 优先级高于第三方时，默认先走 Copilot；Copilot 429 后再走第三方。

### 5. Failover 策略

错误分类建议：

| 上游结果 | 处理方式 |
| --- | --- |
| `429` | 当前 credential 进入 cooldown，解析 `Retry-After`；同 provider 换 key；都不可用再换 provider |
| `401` / `403` | 当前 credential 标记 `auth_error`，不再自动使用，需要手动激活 |
| 明确余额不足 / quota exhausted | 当前 credential 标记 `quota_exhausted` |
| `5xx` | 短 cooldown，可配置 30 到 120 秒 |
| 网络错误 / timeout | 短 cooldown，允许后续自动恢复 |
| 请求参数错误 `400` | 不 failover，直接返回；因为换 key 或 provider 通常无意义 |
| 模型不存在 `404` | 如果 provider 模型发现结果过期，可标记此 model mapping stale；可尝试其他 provider |

## Protocol Adapter 设计

### Adapter 接口

```typescript
interface ProtocolAdapter {
  protocol: ProviderProtocol

  discoverModels?(
    connection: ProviderConnection,
    credential: ApiCredential,
    signal?: AbortSignal,
  ): Promise<Array<ModelMapping>>

  createChatCompletions(
    target: RouteTarget,
    payload: ChatCompletionsPayload,
    signal?: AbortSignal,
    ctx?: RequestExecutionContext,
  ): Promise<ProviderChatResult>

  createMessages?(
    target: RouteTarget,
    payload: AnthropicMessagesPayload,
    signal?: AbortSignal,
    ctx?: RequestExecutionContext,
  ): Promise<ProviderMessagesResult>

  createResponses?(
    target: RouteTarget,
    payload: ResponsesPayload,
    signal?: AbortSignal,
    ctx?: RequestExecutionContext,
  ): Promise<ProviderResponsesResult>

  createEmbeddings?(
    target: RouteTarget,
    payload: EmbeddingRequest,
    signal?: AbortSignal,
  ): Promise<ProviderEmbeddingsResult>
}
```

### OpenAI-compatible Adapter

职责：

- `POST {baseUrl}/chat/completions`
- `GET {baseUrl}/models`
- 可选 `POST {baseUrl}/embeddings`
- 设置鉴权 header。
- 把 public model 替换为 `upstreamModelId`。
- 原样透传 OpenAI-compatible 非流式响应。
- 原样透传 OpenAI-compatible SSE 流。

Anthropic `/v1/messages` 入口走现有 Anthropic -> OpenAI 翻译链路，再调用 `createChatCompletions`。

### Anthropic-compatible Adapter

职责：

- `POST {baseUrl}/messages` 或 `POST {baseUrl}/v1/messages`。
- 设置 `anthropic-version`、`anthropic-beta` 等 header。
- 把 public model 替换为 `upstreamModelId`。
- 原样透传 Anthropic 非流式响应和 SSE。

OpenAI `/chat/completions` 入口如果需要走 Anthropic-compatible provider，应引入 OpenAI -> Anthropic 翻译。这个能力建议作为第二阶段实现，因为转换损耗和边界更多。

### Custom Adapter

Copilot、Windsurf、Codebuff 继续使用 custom adapter：

- Copilot 保留 `/responses`、`/v1/messages`、token refresh、quota 等特殊能力。
- Windsurf 保留现有 JWT/protobuf-like 流式协议。
- Codebuff 保留现有 agent/costMode 等特殊参数。

长期可以把它们也注册成 `ProtocolAdapter`，但不要求它们完全配置化。

## 模型缓存与公开模型列表

现有 `cacheModels()` 已经做了模型聚合和同名模型 provider 前缀展示，可以保留思路并调整数据来源。

推荐公开模型规则：

1. 如果某个 `publicId` 只由一个 provider 提供，公开 `publicId`。
2. 如果多个 provider 提供同一个 `publicId`，公开：
   - `publicId`: 自动负载均衡入口。
   - `providerId/publicId`: 强制 provider 入口。
3. 如果配置了 alias，也按同样规则公开 alias。
4. 对同一个模型的多个 credential 不生成额外公开模型。

示例：

```json
{
  "id": "deepseek-v4-flash",
  "routing": "auto"
}
```

```json
{
  "id": "deepseek/deepseek-v4-flash",
  "routing": "provider-pinned"
}
```

## Admin API 调整

### Provider Connections

新增 API：

- `GET /admin/api/provider-connections`
- `POST /admin/api/provider-connections`
- `GET /admin/api/provider-connections/:id`
- `PUT /admin/api/provider-connections/:id`
- `DELETE /admin/api/provider-connections/:id`
- `POST /admin/api/provider-connections/:id/refresh-models`

### Credentials

新增 API：

- `POST /admin/api/provider-connections/:id/credentials`
- `PUT /admin/api/provider-connections/:id/credentials/:credentialId`
- `DELETE /admin/api/provider-connections/:id/credentials/:credentialId`
- `POST /admin/api/provider-connections/:id/credentials/:credentialId/enable`
- `POST /admin/api/provider-connections/:id/credentials/:credentialId/disable`
- `POST /admin/api/provider-connections/:id/credentials/:credentialId/reset-status`

### 兼容现有 Accounts API

短期保留现有 `accounts` API：

- Copilot/Codebuff/Windsurf 继续通过原 API 管理。
- 新通用 provider connection 使用新 API。
- 后续 admin UI 可以把二者统一展示成“上游账号/连接”，但后端不必一次迁移。

## 状态持久化

建议新增独立文件：

- `provider-connections.json`: 持久化 provider connection、models、credentials。
- `provider-runtime-state.json`: 可选，持久化 cooldown、auth_error、quota_exhausted 等运行状态。

也可以先把 runtime 状态写回 `provider-connections.json`，但长期建议拆开，避免频繁写 secret 配置文件。

Secret 处理建议：

- 导出配置时默认脱敏 credential `value`。
- 提供明确的 `includeSecrets` 参数才导出完整密钥。
- admin API 响应永远不返回完整 key，只返回 `hasSecret`、尾号或 hash。

## 与现有代码的映射

### 可以复用

- `src/lib/account-availability.ts` 的 cooldown 和可用性思路。
- `src/lib/account-selection.ts` 的模型匹配、优先级排序、错误诊断思路。
- `src/services/providers/execution.ts` 的 request retry/failover 思路。
- `src/lib/utils.ts` 的模型缓存和重复模型 provider 前缀思路。
- `src/routes/messages/non-stream-translation.ts` 的 Anthropic -> OpenAI 翻译能力。
- `src/services/copilot/responses-api.ts` 里的 Responses/Chat 转换能力。

### 需要重构

- `src/lib/provider-config.ts`
  - 从静态 provider IDs 扩展为内置协议 descriptors + dynamic provider connection descriptors。

- `src/lib/accounts.ts`
  - 保留 legacy account 类型。
  - 新增 provider connection 类型。
  - 把 `parseModelReference()` 从 `ProviderId` 静态判断改成基于动态 provider connection ID 判断。

- `src/lib/account-selection.ts`
  - 抽出通用 `route-target-selection.ts`。
  - 输入从 `state.accounts` 改为 `buildRouteTargets()`。
  - 保留 legacy account 到 route target 的适配层。

- `src/services/providers/registry.ts`
  - 从 provider runtime registry 调整为 protocol adapter registry。
  - provider connection 根据 `protocol` 找 adapter。

- `src/routes/admin/api/accounts.ts`
  - 新通用 provider 不再增加 provider-specific 分支。
  - 通用 provider 使用 provider connection API。

## 分阶段实施计划

### 阶段 1: 类型和存储基础

目标：

- 新增 `ProviderConnection`、`ApiCredential`、`ModelMapping`、`RouteTarget` 类型。
- 新增 provider connection store。
- 新增 provider connection admin API，先不接入请求路由。

验收：

- 可以通过 API 新增 DeepSeek connection 和多个 key。
- 配置可以持久化、读取、脱敏返回。
- 不影响现有 accounts API 和 Copilot 请求。

### 阶段 2: OpenAI-compatible Adapter

目标：

- 实现 `openai-compatible` adapter。
- 支持 `/chat/completions` 非流式和流式。
- 支持 `/models` 自动发现。
- 支持模型 publicId -> upstreamId 替换。

验收：

- 配置 DeepSeek 后可请求 `deepseek/deepseek-v4-flash`。
- 配置多个 key 后，同 provider 内能轮询。
- 429 后能切换到同 provider 的下一个 key。
- 401/403 后 key 标记为 `auth_error`，不再自动使用。

### 阶段 3: RouteTarget 选择器

目标：

- 抽象统一 route target 选择。
- 未指定 provider 时，支持跨 provider 同名模型负载均衡。
- 支持 provider priority、provider weight、credential priority、credential weight。

验收：

- `deepseek-v4-flash` 可以在多个 provider 间按优先级/权重选择。
- `deepseek/deepseek-v4-flash` 只走 DeepSeek。
- 同名模型公开列表包含自动入口和 provider-pinned 入口。
- 所有候选不可用时错误信息能区分 cooldown、quota、auth_error、unsupported。

### 阶段 4: Anthropic-compatible Adapter

目标：

- 实现 Anthropic-compatible `/v1/messages` 直通。
- 支持 Anthropic SSE 透传。
- 支持手工模型配置和可选模型发现。

验收：

- Anthropic-compatible provider 可处理 `/v1/messages`。
- OpenAI-compatible provider 仍可通过现有 Anthropic -> OpenAI 翻译处理 `/v1/messages`。
- thinking/reasoning 相关字段不因错误路由被意外降级。

### 阶段 5: Legacy Provider 兼容与收敛

目标：

- Copilot、Windsurf、Codebuff 保持 custom adapter。
- 逐步把 provider registry 从 provider runtime 改为 protocol adapter + legacy adapter。
- admin UI 统一展示 provider connection 和 legacy account。

验收：

- 现有测试通过。
- 现有 Copilot device flow、quota、Responses API、Messages API 行为不变。
- 新 provider 不需要新增 provider-specific account 分支。

## 测试策略

### 单元测试

覆盖：

- 模型引用解析。
- model mapping 和 alias 匹配。
- route target 构造。
- provider priority 排序。
- credential priority 排序。
- weighted round-robin。
- 429、401、403、5xx、network error 分类。
- 自动发现模型 merge/replace/manual-only。

### 集成测试

使用 mock upstream：

- OpenAI-compatible `/chat/completions` 非流式。
- OpenAI-compatible `/chat/completions` 流式。
- OpenAI-compatible `/models`。
- Anthropic-compatible `/v1/messages` 非流式。
- Anthropic-compatible `/v1/messages` 流式。
- 多 key 429 failover。
- key auth_error 后手动 reset。
- 同名模型跨 provider failover。

### 回归测试

重点覆盖现有高风险路径：

- Copilot `/chat/completions`。
- Copilot `/responses`。
- Copilot `/v1/messages` 原生路径。
- Anthropic -> OpenAI translation fallback。
- 模型列表 `/v1/models`。
- admin accounts API。

## 风险与边界

### OpenAI-compatible 并不完全一致

不同服务商对 OpenAI 协议支持不一致，例如：

- reasoning 字段名称不同。
- tool call 流式 delta 不完全一致。
- `response_format` 支持不一致。
- `/models` 返回结构可能扩展。

处理策略：

- adapter 先做最小规范透传。
- provider connection 支持 capability overrides。
- 对明确不支持的字段可按 provider 配置过滤或报错。

### Anthropic-compatible 模型发现不统一

Anthropic-compatible 服务不一定有标准模型发现端点。

处理策略：

- 第一版以手工模型配置为主。
- `modelDiscovery.endpoint` 允许用户指定非标准模型端点。

### 错误分类依赖上游响应

余额不足、额度耗尽等错误不一定有统一状态码。

处理策略：

- 第一版基于 HTTP status 分类。
- 后续增加 provider-level `errorClassifiers` 配置，按 status、body regex、header 匹配。

### 跨 provider 同名模型的语义差异

不同服务商的同名模型可能不是完全相同快照或参数策略。

处理策略：

- 默认只把相同 `publicId` 视为可负载均衡。
- 用户可以通过不同 publicId 区分，例如 `deepseek-v4-flash-openrouter`。
- provider-pinned 模型始终可用于强制指定。

## 推荐的最小首版范围

首版不要一次性迁移所有 provider。推荐只做：

1. 新增 provider connection store 和 admin API。
2. 新增 OpenAI-compatible adapter。
3. 支持 DeepSeek 这类 provider 的多 key 轮询。
4. 支持同名模型跨 provider 按 priority failover。
5. 保留 legacy accounts 和 custom providers。

不建议首版做：

- 把 Copilot/Windsurf/Codebuff 全量迁移到新模型。
- OpenAI -> Anthropic 的完整翻译。
- 复杂的成本感知调度。
- 自动余额查询。

这样可以先解决“新增通用 API 提供商代理”和“多 key/多 provider 负载均衡”的核心问题，同时控制对现有 Copilot 路径的影响面。
