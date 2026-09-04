# Provider Presets 与在线模型勾选重构方案

状态：**待实施**
日期：2026-08-27
范围：前端添加连接 UI 重构 + 后端即时模型探测接口 + 内置预制提供商目录

## 1. 背景与现状

### 1.1 当前痛点

当前添加一个外部 Provider Connection 的完整流程：

1. 点击"添加连接" → 弹出全空白表单
2. 手动填写 Name、Base URL（容易记错末尾是否带 `/v1`）
3. 手动选择 Protocol（3 个选项，新手不知道选哪个）
4. 手动粘贴 API Key
5. 保存连接 —— 此时 `models` 列表为空
6. 再点击"手动添加模型"，逐个输入 `publicId`、`upstreamId`
7. 或者用批量粘贴功能，但仍需手动获取上游模型清单

接入 DeepSeek（2 个模型）尚可忍受，接入 OpenRouter（数百个模型）几乎不可用。

### 1.2 axonhub 的参考机制

调研 `/Users/yuqiang/work/code/axonhub/` 后确认两个关键支柱：

**预置提供商元数据**（`config_providers.ts` + `config_channels.ts`，共 1146 行硬编码）：

- 29 个 Provider、80+ 个 Channel Type
- 每个 Provider 配置包含：默认 baseURL、默认协议格式、默认预选模型列表、品牌图标
- 支持 4 种 API 格式：`openai/chat_completions`、`openai/responses`、`anthropic/messages`、`gemini/contents`

**在线拉取模型与自由勾选**（`useFetchModels` + 模型选择面板）：

- 用户输入 API Key 后点击"获取模型"按钮
- 后端用临时配置探测上游 `/models` 端点
- 前端弹窗展示 checkbox 列表（带搜索、全选、虚拟滚动）
- 用户勾选后确认，只接入勾选的模型

### 1.3 copilot-api 与 axonhub 的协议映射

copilot-api 只有 3 个 `*-compatible` 协议（外部 provider 管理面），axonhub 有 4 种 API 格式：

| axonhub apiFormat         | copilot-api protocol          | 备注                                                                  |
| ------------------------- | ----------------------------- | --------------------------------------------------------------------- |
| `openai/chat_completions` | `openai-compatible`           | 直接映射                                                              |
| `openai/responses`        | `openai-responses-compatible` | 直接映射                                                              |
| `anthropic/messages`      | `anthropic-compatible`        | 直接映射                                                              |
| `gemini/contents`         | **无对应**                    | 排除（`gemini_openai` 走 openai 兼容端点可用）                        |
| `ollama/chat`             | **无对应**                    | 排除（Ollama 的 `/v1/chat/completions` 端点可用 `openai-compatible`） |

排除项：

- `gemini` / `gemini_vertex` / `antigravity` — gemini/contents 格式无对应协议
- `ollama` 原生格式 — 但 Ollama 的 OpenAI 兼容端点可用 `openai-compatible`
- `anthropic_aws` / `anthropic_gcp` — 需要 AWS/GCP 云平台鉴权，不是简单 API Key
- `codex` / `github_copilot` / `claudecode` / `xai_subscription` — OAuth 原生协议，属于 `*-native`，走账号管理而非连接管理
- `*_fake` — 测试用

## 2. 整体架构

### 2.1 设计原则

1. **内置默认 + 用户覆盖**：33 个常见提供商写死在代码里随版本发布，用户可通过数据目录的配置文件覆盖或新增
2. **探测先于保存**：用户输入 API Key 后即可在线探测可用模型，无需先创建连接再刷新
3. **一键接入**：选预设 → 填 Key → 探测/勾选模型 → 一次保存调用完成连接创建 + 凭据添加 + 模型配置
4. **零后端 schema 变更**：`ProviderConnection` 数据模型不变，预设只是前端自动填充表单字段

### 2.2 架构图

```
┌─────────────────────────────────────────────────────────────┐
│                        前端 (Alpine.js)                       │
│                                                             │
│  ┌─────────────┐    ┌──────────────┐    ┌───────────────┐  │
│  │ 内置预设     │    │ 用户自定义    │    │ 后端合并 API   │  │
│  │ (JS 常量)    │    │ (JSON 文件)   │    │ /admin/api/   │  │
│  │ 33 个默认    │    │ 覆盖+新增     │    │ provider-     │  │
│  │              │    │              │    │ presets       │  │
│  └──────┬───────┘    └──────┬───────┘    └───────┬───────┘  │
│         │                   │                    │          │
│         └─────────┬─────────┘                    │          │
│                   ▼                              │          │
│         ┌─────────────────┐                      │          │
│         │ 合并后的预设列表 │ ◄────────────────────┘          │
│         │ (前端缓存)       │                                │
│         └────────┬────────┘                                │
│                  │                                          │
│         ┌────────▼────────┐    ┌────────────────────┐      │
│         │ Provider 选择   │───▶│ 即时模型探测面板    │      │
│         │ (分类 Tab+卡片) │    │ (搜索/勾选/全选)    │      │
│         └────────┬────────┘    └─────────┬──────────┘      │
│                  │                       │                  │
│                  ▼                       ▼                  │
│         ┌─────────────────────────────────────────┐        │
│         │ 一次保存: 创建连接 + 凭据 + 模型列表      │        │
│         │ POST /admin/api/provider-connections     │        │
│         └─────────────────────────────────────────┘        │
└─────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────┐
│                        后端 (Hono)                           │
│                                                             │
│  ┌──────────────────────┐  ┌───────────────────────────┐  │
│  │ GET /provider-presets │  │ POST /provider-connections │  │
│  │ 返回合并后的预设列表   │  │   /fetch-models            │  │
│  │ (内置 + 用户覆盖)     │  │ 即时探测(不落盘)            │  │
│  └──────────────────────┘  └───────────────────────────┘  │
│                                                             │
│  ┌──────────────────────────────────────────────────────┐  │
│  │  Protocol Adapter.discoverModels                      │  │
│  │  (复用现有实现, 接收临时 connection 对象)              │  │
│  └──────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────┘
```

## 3. 数据结构

### 3.1 ProviderPreset（前端 + 后端共享）

```typescript
/**
 * 预制提供商配置。前端用于自动填充表单，后端用于合并内置与用户自定义。
 */
interface ProviderPreset {
  /** 唯一标识，如 "deepseek"、"openrouter" */
  id: string
  /** 显示名称，如 "DeepSeek (深度求索)" */
  name: string
  /** 分类，用于 UI Tab 过滤 */
  category:
    | "popular"
    | "domestic"
    | "international"
    | "aggregator"
    | "local"
    | "custom"
  /** copilot-api 协议 */
  protocol:
    | "openai-compatible"
    | "openai-responses-compatible"
    | "anthropic-compatible"
  /** 默认 Base URL */
  baseUrl: string
  /** 鉴权模式 */
  authMode: "bearer" | "header"
  /** 当 authMode === "header" 时的 header 名，默认 "x-api-key" */
  headerName?: string
  /** API Key 输入框 placeholder */
  keyPlaceholder?: string
  /** 官方控制台申请 API Key 的直达链接 */
  portalUrl?: string
  /** 简短描述（一句话） */
  description?: string
  /** 预置主力模型列表（用户可在此基础上增删） */
  defaultModels?: Array<{
    publicId: string
    upstreamId: string
    name?: string
    endpoints?: Array<"chat" | "embeddings" | "responses" | "messages">
  }>
  /** 是否默认开启自动模型发现 */
  discoveryEnabled?: boolean
  /** 模型发现模式 */
  discoveryMode?: "merge" | "replace" | "manual-only"
  /** 是否支持在线探测（少数 provider 不提供 /models 端点） */
  fetchable?: boolean
}
```

### 3.2 即时探测请求/响应

```typescript
// POST /admin/api/provider-connections/fetch-models
// 请求体（临时配置，不落盘）
interface FetchModelsRequest {
  protocol: ProviderProtocol
  baseUrl: string
  apiKey: string
  authMode: "bearer" | "header"
  headerName?: string
  /** 可选：自定义模型列表端点（相对 baseUrl 或绝对 URL） */
  discoveryEndpoint?: string
}

// 响应体
interface FetchModelsResponse {
  models: Array<{
    publicId: string
    upstreamId: string
    vendor?: string
    endpoints: Array<"chat" | "embeddings" | "responses" | "messages">
  }>
}

// 错误响应
interface FetchModelsError {
  error: string
  /** 友好提示，如 "API Key 无效"、"上游无响应" */
  hint?: string
}
```

### 3.3 用户自定义预设配置文件

存放路径：`~/.local/share/copilot-api/provider-presets.json`（与 `provider-connections.json` 同目录）

```json
{
  "presets": [
    {
      "id": "my-internal-gateway",
      "name": "公司内部网关",
      "category": "custom",
      "protocol": "openai-compatible",
      "baseUrl": "https://internal.company.com/v1",
      "authMode": "bearer",
      "description": "公司内部 LLM 网关",
      "fetchable": true
    },
    {
      "id": "deepseek",
      "name": "DeepSeek (内部代理)",
      "category": "domestic",
      "protocol": "openai-compatible",
      "baseUrl": "https://gateway.company.com/deepseek/v1",
      "authMode": "bearer"
    }
  ]
}
```

**合并规则**：用户配置中同 `id` 的预设覆盖内置默认，不同 `id` 的预设追加到列表末尾。

## 4. 内置预制提供商完整清单

基于 axonhub `config_channels.ts` 的完整数据，经协议映射后保留 33 个可用提供商。

### 4.1 国内主流 (domestic)

| ID                   | 名称                         | Base URL                                            | 协议                 | 预置模型                                                                              | Key 获取                              |
| -------------------- | ---------------------------- | --------------------------------------------------- | -------------------- | ------------------------------------------------------------------------------------- | ------------------------------------- |
| `deepseek`           | DeepSeek (深度求索)          | `https://api.deepseek.com/v1`                       | openai-compatible    | deepseek-chat, deepseek-reasoner                                                      | platform.deepseek.com/api_keys        |
| `deepseek-anthropic` | DeepSeek (Anthropic 兼容)    | `https://api.deepseek.com/anthropic`                | anthropic-compatible | deepseek-chat, deepseek-reasoner                                                      | platform.deepseek.com/api_keys        |
| `siliconflow`        | SiliconFlow (硅基流动)       | `https://api.siliconflow.cn/v1`                     | openai-compatible    | zai-org/GLM-4.6, Qwen/Qwen3-Coder-480B-A35B-Instruct, deepseek-ai/DeepSeek-V3         | cloud.siliconflow.cn/account/ak       |
| `moonshot`           | Moonshot (Kimi)              | `https://api.moonshot.cn/v1`                        | openai-compatible    | kimi-k2-thinking, kimi-k2-0905-preview, kimi-k2-turbo-preview                         | platform.moonshot.cn/console/api-keys |
| `moonshot-anthropic` | Moonshot (Anthropic 兼容)    | `https://api.moonshot.cn/anthropic`                 | anthropic-compatible | kimi-k2-thinking, kimi-k2-0905-preview                                                | platform.moonshot.cn/console/api-keys |
| `moonshot-coding`    | Kimi Coding                  | `https://api.kimi.com/coding`                       | anthropic-compatible | kimi-k2-thinking, kimi-k2-0905-preview, kimi-k2-turbo-preview                         | platform.moonshot.cn                  |
| `zhipu`              | Zhipu AI (智谱 GLM)          | `https://open.bigmodel.cn/api/paas/v4`              | openai-compatible    | glm-5.2, glm-5.1, glm-5, glm-5-turbo, glm-4.7, glm-4.5-air                            | open.bigmodel.cn/usercenter/apikeys   |
| `zhipu-anthropic`    | Zhipu AI (Anthropic 兼容)    | `https://open.bigmodel.cn/api/anthropic`            | anthropic-compatible | glm-5.2, glm-5.1, glm-4.7                                                             | open.bigmodel.cn/usercenter/apikeys   |
| `zai`                | Z.AI (智谱海外)              | `https://api.z.ai/api/paas/v4`                      | openai-compatible    | glm-5.2, glm-5.1, glm-5, glm-5-turbo, glm-4.7, glm-4.5-air                            | z.ai                                  |
| `zai-anthropic`      | Z.AI (Anthropic 兼容)        | `https://api.z.ai/api/anthropic`                    | anthropic-compatible | glm-5.2, glm-5.1, glm-4.7                                                             | z.ai                                  |
| `minimax`            | MiniMax                      | `https://api.minimaxi.com/v1`                       | openai-compatible    | MiniMax-M3, MiniMax-M2.7, MiniMax-M2.7-highspeed                                      | platform.minimaxi.com                 |
| `minimax-anthropic`  | MiniMax (Anthropic 兼容)     | `https://api.minimaxi.com/anthropic`                | anthropic-compatible | MiniMax-M3, MiniMax-M2.7                                                              | platform.minimaxi.com                 |
| `doubao`             | 火山引擎 (豆包)              | `https://ark.cn-beijing.volces.com/api/v3`          | openai-compatible    | doubao-seed-2.0-mini, doubao-seed-2.0-lite, doubao-seed-2.0-code, doubao-seed-2.0-pro | console.volcengine.com/ark            |
| `doubao-anthropic`   | 火山引擎 (Anthropic 兼容)    | `https://ark.cn-beijing.volces.com/api/coding`      | anthropic-compatible | doubao-seed-2.0-mini, doubao-seed-2.0-code                                            | console.volcengine.com/ark            |
| `volcengine`         | 火山引擎 (聚合)              | `https://ark.cn-beijing.volces.com/api/v3`          | openai-compatible    | doubao-seed-2.0-mini, deepseek-v4-pro, deepseek-v4-flash, kimi-k2.6, glm-5.1          | console.volcengine.com/ark            |
| `bailian`            | 阿里百炼 (DashScope)         | `https://dashscope.aliyuncs.com/compatible-mode/v1` | openai-compatible    | qwen3.7-max, qwen3.7-plus, qwen3-coder-plus, deepseek-v4-pro, kimi-k2.6, glm-5.1      | bailian.console.aliyun.com            |
| `bailian-anthropic`  | 阿里百炼 (Anthropic 兼容)    | `https://dashscope.aliyuncs.com/apps/anthropic`     | anthropic-compatible | qwen3.7-max, qwen3.7-plus, qwen3-coder-plus                                           | bailian.console.aliyun.com            |
| `modelscope`         | ModelScope (魔搭)            | `https://api-inference.modelscope.cn/v1`            | openai-compatible    | qwen-plus, qwen-turbo, qwen-max, qwen2.5-72b-instruct                                 | modelscope.cn                         |
| `longcat`            | LongCat (美团)               | `https://api.longcat.chat/openai/v1`                | openai-compatible    | LongCat-Flash-Chat, LongCat-Flash-Thinking                                            | longcat.chat                          |
| `longcat-anthropic`  | LongCat (Anthropic 兼容)     | `https://api.longcat.chat/anthropic`                | anthropic-compatible | LongCat-Flash-Chat, LongCat-Flash-Thinking                                            | longcat.chat                          |
| `xiaomi`             | Xiaomi MiMo (小米)           | `https://api.xiaomimimo.com/v1`                     | openai-compatible    | mimo-v2.5-pro, mimo-v2.5                                                              | xiaomimimo.com                        |
| `xiaomi-anthropic`   | Xiaomi MiMo (Anthropic 兼容) | `https://token-plan-cn.xiaomimimo.com/anthropic`    | anthropic-compatible | mimo-v2.5-pro, mimo-v2.5                                                              | xiaomimimo.com                        |
| `qiniu`              | Qiniu (七牛)                 | `https://api.qnaigc.com/v1`                         | openai-compatible    | deepseek-v3                                                                           | qnaigc.com                            |
| `qiniu-anthropic`    | Qiniu (Anthropic 兼容)       | `https://api.qnaigc.com`                            | anthropic-compatible | deepseek-v3                                                                           | qnaigc.com                            |

### 4.2 海外大厂 (international)

| ID                 | 名称                        | Base URL                                                  | 协议                        | 预置模型                                                                                                     | Key 获取                            |
| ------------------ | --------------------------- | --------------------------------------------------------- | --------------------------- | ------------------------------------------------------------------------------------------------------------ | ----------------------------------- |
| `openai`           | OpenAI                      | `https://api.openai.com/v1`                               | openai-compatible           | gpt-4o, gpt-4o-mini, gpt-5, gpt-5.1                                                                          | platform.openai.com/api-keys        |
| `openai-responses` | OpenAI (Responses API)      | `https://api.openai.com/v1`                               | openai-responses-compatible | gpt-4o, gpt-4o-mini, gpt-5, gpt-5.1                                                                          | platform.openai.com/api-keys        |
| `anthropic`        | Anthropic (Claude)          | `https://api.anthropic.com`                               | anthropic-compatible        | claude-opus-4-5, claude-sonnet-4-5                                                                           | console.anthropic.com/settings/keys |
| `gemini-openai`    | Google Gemini (OpenAI 兼容) | `https://generativelanguage.googleapis.com/v1beta/openai` | openai-compatible           | gemini-2.5-pro, gemini-2.5-flash                                                                             | aistudio.google.com/apikey          |
| `xai`              | xAI (Grok)                  | `https://api.x.ai/v1`                                     | openai-compatible           | grok-4, grok-3, grok-3-mini, grok-code-fast, grok-4-fast-reasoning, grok-4-fast-non-reasoning                | console.x.ai                        |
| `xai-responses`    | xAI (Responses API)         | `https://api.x.ai/v1`                                     | openai-responses-compatible | grok-4, grok-3, grok-3-mini                                                                                  | console.x.ai                        |
| `groq`             | Groq                        | `https://api.groq.com/openai/v1`                          | openai-compatible           | openai/gpt-oss-120b, openai/gpt-oss-20b, whisper-large-v3, whisper-large-v3-turbo                            | console.groq.com/keys               |
| `cerebras`         | Cerebras                    | `https://api.cerebras.ai/v1`                              | openai-compatible           | llama3.1-8b, llama3.1-70b, llama-3.3-70b                                                                     | cloud.cerebras.ai                   |
| `deepinfra`        | DeepInfra                   | `https://api.deepinfra.com/v1/openai`                     | openai-compatible           | deepseek-ai/DeepSeek-V3.2, moonshotai/Kimi-K2-Thinking                                                       | deepinfra.com                       |
| `fireworks`        | Fireworks AI                | `https://api.fireworks.ai/inference/v1`                   | openai-compatible           | accounts/fireworks/models/minimax-m2p5, accounts/fireworks/models/glm-5, accounts/fireworks/models/kimi-k2p5 | fireworks.ai/account/api-keys       |
| `github`           | GitHub Models               | `https://models.github.ai/inference`                      | openai-compatible           | openai/gpt-4.1, openai/gpt-4o, anthropic/claude-sonnet-4, deepseek/DeepSeek-V3-0324                          | models.github.ai                    |
| `jina`             | Jina AI                     | `https://api.jina.ai/v1`                                  | openai-compatible           | jina-embeddings-v3, jina-reranker-v3                                                                         | jina.ai                             |

### 4.3 聚合中转 (aggregator)

| ID                   | 名称                      | Base URL                            | 协议                        | 预置模型                                                                                                                    | Key 获取           |
| -------------------- | ------------------------- | ----------------------------------- | --------------------------- | --------------------------------------------------------------------------------------------------------------------------- | ------------------ |
| `openrouter`         | OpenRouter                | `https://openrouter.ai/api/v1`      | openai-compatible           | moonshotai/kimi-k2:free, z-ai/glm-4.7, anthropic/claude-opus-4, anthropic/claude-sonnet-4                                   | openrouter.ai/keys |
| `aihubmix`           | AiHubMix                  | `https://aihubmix.com/v1`           | openai-compatible           | DeepSeek-V3.2-Exp, gemini-3-flash, claude-sonnet-4-5, gpt-4o, Kimi-K2-0905, glm-4.7                                         | aihubmix.com       |
| `aihubmix-anthropic` | AiHubMix (Anthropic 兼容) | `https://aihubmix.com`              | anthropic-compatible        | DeepSeek-V3.2-Exp, claude-sonnet-4-5, gpt-4o, gemini-3-pro                                                                  | aihubmix.com       |
| `vercel`             | Vercel AI Gateway         | `https://ai-gateway.vercel.sh/v1`   | openai-compatible           | deepseek/deepseek-v3.2-exp-thinking, moonshotai/kimi-k2-thinking, moonshotai/kimi-k2                                        | vercel.com         |
| `ppio`               | PPIO                      | `https://api.ppinfra.com/openai/v1` | openai-compatible           | deepseek/deepseek-v3.2-exp, qwen/qwen3-coder-480b-a35b-instruct, zai-org/glm-4.6, moonshotai/kimi-k2-0905                   | ppinfra.com        |
| `atlascloud`         | AtlasCloud                | `https://api.atlascloud.ai/v1`      | openai-compatible           | deepseek-v3, qwen-plus, kimi-k2, glm-4.7                                                                                    | atlascloud.ai      |
| `fenno`              | Fenno                     | `https://api.fenno.ai`              | openai-responses-compatible | gpt-5.2, gpt-5.2-codex                                                                                                      | fenno.ai           |
| `nanogpt`            | NanoGPT                   | `https://nano-gpt.com/api/v1`       | openai-compatible           | hidream, flux-kontext, zai-org/glm-4.7:thinking, zai-org/glm-4.7, zai-org/glm-4.6                                           | nano-gpt.com       |
| `burncloud`          | BurnCloud                 | `https://ai.burncloud.com/v1`       | openai-compatible           | claude-sonnet-4-5, deepseek-chat, deepseek-reasoner, gemini-2.5-pro, gpt-5, grok-4, qwen3-coder-480b-a35b-instruct          | burncloud.com      |
| `evolink`            | Evolink                   | `https://direct.evolink.ai/v1`      | openai-compatible           | gpt-5.2, gpt-5.4, deepseek-v4-pro, gemini-3.0-pro, minimax-m3, doubao-seed-2.0                                              | evolink.ai         |
| `evolink-anthropic`  | Evolink (Anthropic 兼容)  | `https://direct.evolink.ai`         | anthropic-compatible        | claude-opus-4-8, claude-opus-4-7, claude-sonnet-4-6, claude-haiku-4-5                                                       | evolink.ai         |
| `opencode-go`        | OpenCode Go               | `https://opencode.ai/zen/go`        | openai-compatible           | glm-5.1, glm-5, kimi-k2.5, kimi-k2.6, deepseek-v4-pro, deepseek-v4-flash, mimo-v2.5, mimo-v2.5-pro                          | opencode.ai        |
| `cline`              | Cline Pass                | `https://api.cline.bot/api/v1`      | openai-compatible           | cline-pass/deepseek-v4-flash, cline-pass/deepseek-v4-pro, cline-pass/qwen3.7-plus, cline-pass/kimi-k2.6, cline-pass/glm-5.2 | cline.bot          |

### 4.4 自建 (local)

| ID       | 名称            | Base URL                    | 协议              | 预置模型          | 备注                                        |
| -------- | --------------- | --------------------------- | ----------------- | ----------------- | ------------------------------------------- |
| `ollama` | Ollama (本地)   | `http://localhost:11434/v1` | openai-compatible | （在线探测）      | 无需 API Key，authMode=bearer 但 value 留空 |
| `vllm`   | vLLM (本地)     | `http://localhost:8000/v1`  | openai-compatible | （在线探测）      | 无需 API Key                                |
| `custom` | 自定义 Provider | （用户填写）                | 用户选择          | （用户填写/探测） | 兜底选项                                    |

### 4.5 火山引擎（豆包）特殊说明

火山引擎不使用固定模型名，而是每个用户在控制台创建 Inference Endpoint，模型 ID 形如 `ep-20240xxx-xxxxx`。因此：

- `doubao` / `doubao-anthropic` / `volcengine` 的 `defaultModels` 仅作参考，实际调用需要用户自己的 Endpoint ID
- 强烈建议用户接入火山引擎时使用"在线获取模型"功能
- `fetchable: true` 但探测结果取决于用户是否已创建 Endpoint

## 5. 后端实现

### 5.1 新增：预设目录 API

#### `GET /admin/api/provider-presets`

返回合并后的预设列表（内置 + 用户自定义覆盖）。

```typescript
// src/routes/admin/api/provider-presets.ts (新建)

import { Hono } from "hono"
import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { PATHS } from "~/lib/paths"
import { logger } from "~/lib/logger"

const providerPresetRoutes = new Hono()

// 内置默认预设（写死在代码里，随版本发布）
const BUILTIN_PRESETS: ProviderPreset[] = [
  // ... 33 个预设（见第 4 节完整清单）
]

/**
 * 读取用户自定义预设配置文件。
 * 路径：~/.local/share/copilot-api/provider-presets.json
 * 文件不存在时返回空数组（不报错）。
 */
async function readUserPresets(): Promise<ProviderPreset[]> {
  try {
    const filePath = join(PATHS.dataDir, "provider-presets.json")
    const content = await readFile(filePath, "utf-8")
    const parsed = JSON.parse(content) as { presets?: ProviderPreset[] }
    return Array.isArray(parsed.presets) ? parsed.presets : []
  } catch (error) {
    // 文件不存在是正常情况，不记 warn
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      logger.warn(
        `Failed to read provider-presets.json: ${(error as Error).message}`,
      )
    }
    return []
  }
}

/**
 * 合并内置预设与用户自定义预设。
 * 同 id 的用户预设覆盖内置默认，不同 id 的追加到末尾。
 */
function mergePresets(
  builtin: ProviderPreset[],
  user: ProviderPreset[],
): ProviderPreset[] {
  const userMap = new Map(user.map((p) => [p.id, p]))
  const merged: ProviderPreset[] = []
  const seen = new Set<string>()

  for (const preset of builtin) {
    seen.add(preset.id)
    merged.push(userMap.get(preset.id) ?? preset)
  }

  for (const preset of user) {
    if (!seen.has(preset.id)) {
      merged.push(preset)
    }
  }

  return merged
}

providerPresetRoutes.get("/", async (c) => {
  const userPresets = await readUserPresets()
  const presets = mergePresets(BUILTIN_PRESETS, userPresets)
  return c.json({ presets })
})

export { providerPresetRoutes }
```

#### 路由注册

在 `src/routes/admin/api/provider-connections.ts` 中挂载：

```typescript
import { providerPresetRoutes } from "./provider-presets"

// ... 现有路由 ...

// 预设目录（不需要 connection guard）
providerConnectionApiRoutes.route("/presets", providerPresetRoutes)
```

### 5.2 新增：即时模型探测 API

#### `POST /admin/api/provider-connections/fetch-models`

接收临时配置，调用 protocol adapter 的 `discoverModels`，返回可用模型列表。**不落盘、不创建连接。**

```typescript
// src/routes/admin/api/provider-connections.ts 中新增

providerConnectionApiRoutes.post("/fetch-models", async (c) => {
  initializeProtocolAdapters()

  let payload: Record<string, unknown>
  try {
    payload = await readJsonBody(c.req.raw)
  } catch {
    return c.json({ error: "Invalid JSON" }, 400)
  }

  const protocol =
    typeof payload.protocol === "string" ? payload.protocol : undefined
  const baseUrl =
    typeof payload.baseUrl === "string" ? payload.baseUrl : undefined
  const apiKey = typeof payload.apiKey === "string" ? payload.apiKey : undefined

  if (!protocol || !isProviderProtocol(protocol)) {
    return c.json({ error: "Invalid `protocol`" }, 400)
  }
  if (isAccountManagedProtocol(protocol)) {
    return c.json(
      { error: "Account-managed protocols are not supported here" },
      400,
    )
  }
  if (!baseUrl) return c.json({ error: "`baseUrl` is required" }, 400)
  if (!apiKey) return c.json({ error: "`apiKey` is required" }, 400)

  // SSRF 防护：只允许 http/https 协议
  try {
    const parsed = new URL(baseUrl)
    if (!["http:", "https:"].includes(parsed.protocol)) {
      return c.json({ error: "Only http/https baseUrl is allowed" }, 400)
    }
  } catch {
    return c.json({ error: "Invalid `baseUrl`" }, 400)
  }

  const adapter = getProtocolAdapter(protocol)
  if (!adapter?.discoverModels) {
    return c.json(
      { error: `Protocol "${protocol}" does not support model discovery` },
      400,
    )
  }

  const authMode =
    typeof payload.authMode === "string" && payload.authMode === "header" ?
      "header"
    : "bearer"
  const headerName =
    typeof payload.headerName === "string" ? payload.headerName : "x-api-key"

  // 构造临时 connection 和 credential 对象（不落盘）
  const tempConnection: ProviderConnection = {
    id: "__fetch_models_temp__",
    name: "__fetch_models_temp__",
    protocol,
    baseUrl,
    enabled: true,
    priority: 0,
    credentials: [],
    createdAt: Date.now(),
    modelDiscovery: {
      enabled: true,
      mode: "manual-only",
      endpoint:
        typeof payload.discoveryEndpoint === "string" ?
          payload.discoveryEndpoint
        : undefined,
    },
  }
  const tempCredential: ApiCredential = {
    id: "__fetch_models_temp__",
    authMode,
    headerName: authMode === "header" ? headerName : undefined,
    value: apiKey,
    enabled: true,
    status: "ready",
    createdAt: Date.now(),
  }

  // 10 秒超时（/models 端点不应该慢）
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 10_000)

  try {
    const models = await adapter.discoverModels({
      connection: tempConnection,
      credential: tempCredential,
      signal: controller.signal,
    })
    return c.json({
      models: models.map((m) => ({
        publicId: m.publicId,
        upstreamId: m.upstreamId,
        vendor: m.vendor,
        endpoints: m.endpoints,
      })),
    })
  } catch (error) {
    // 友好错误提示
    const message = (error as Error).message
    let hint: string | undefined
    if (message.includes("401") || message.includes("403")) {
      hint = "API Key 无效或权限不足"
    } else if (message.includes("abort") || message.includes("timeout")) {
      hint = "上游无响应，请检查 Base URL 是否正确"
    } else if (
      message.includes("fetch failed")
      || message.includes("ECONNREFUSED")
    ) {
      hint = "无法连接到上游，请检查 Base URL 和网络"
    }
    return c.json({ error: message, hint }, 502)
  } finally {
    clearTimeout(timeout)
    // 确保临时凭据不被日志记录（buildBaseHeaders 不记录 value，但这里再显式清理）
  }
})
```

**安全边界**：

- 临时凭据 `tempCredential` 不写入 `provider-connections.json`，不写入任何日志
- `buildBaseHeaders`（在 `shared.ts` 中）已经不会记录 credential value
- 10 秒超时防止挂起
- SSRF 防护：只允许 http/https 协议
- 与现有 `testConnection` endpoint 的安全模型一致（也是用用户输入的凭据探测上游）

### 5.3 不需要改动的部分

- `ProviderConnection` 类型 — 数据模型不变
- `ProtocolAdapter` 接口 — `discoverModels` 签名不变，只是传入临时对象
- `createConnection` / `updateConnection` — 保存逻辑不变
- 现有 `POST /:id/refresh-models` — 保留，用于已保存连接的模型刷新

## 6. 前端实现

### 6.1 新建：`pages/js/provider-presets.js`

内置 33 个预设的数据文件。这是纯数据，不含逻辑。

```javascript
// pages/js/provider-presets.js

/**
 * 内置预制提供商列表。
 * 用户可通过 ~/.local/share/copilot-api/provider-presets.json 覆盖或新增。
 * 完整清单见 docs/refactor-provider-presets.md 第 4 节。
 */
const BUILTIN_PROVIDER_PRESETS = [
  // ── 国内主流 ──
  {
    id: "deepseek",
    name: "DeepSeek (深度求索)",
    category: "domestic",
    protocol: "openai-compatible",
    baseUrl: "https://api.deepseek.com/v1",
    authMode: "bearer",
    keyPlaceholder: "sk-...",
    portalUrl: "https://platform.deepseek.com/api_keys",
    description: "DeepSeek V3/R1 系列，性价比高",
    fetchable: true,
    discoveryEnabled: true,
    discoveryMode: "merge",
    defaultModels: [
      {
        publicId: "deepseek-chat",
        upstreamId: "deepseek-chat",
        endpoints: ["chat"],
      },
      {
        publicId: "deepseek-reasoner",
        upstreamId: "deepseek-reasoner",
        endpoints: ["chat"],
      },
    ],
  },
  // ... 其余 32 个预设 ...
]

// 导出给前端使用
window.BUILTIN_PROVIDER_PRESETS = BUILTIN_PROVIDER_PRESETS
```

### 6.2 修改：`pages/js/api.js`

新增两个 API 方法：

```javascript
// pages/js/api.js 中 providerConnections 部分新增

providerConnections: {
  // ... 现有方法 ...

  /**
   * 获取合并后的预设列表（内置 + 用户自定义）。
   */
  async presets() {
    return fetch("/admin/api/provider-connections/presets", {
      headers: API.authHeaders(),
    }).then((r) => r.json())
  },

  /**
   * 即时探测上游可用模型（不创建连接）。
   * @param {{ protocol, baseUrl, apiKey, authMode, headerName?, discoveryEndpoint? }} payload
   */
  async fetchModels(payload) {
    return fetch("/admin/api/provider-connections/fetch-models", {
      method: "POST",
      headers: { ...API.authHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    }).then((r) => r.json())
  },
}
```

### 6.3 修改：`pages/js/views/connections.js`

#### 新增状态字段

```javascript
function connectionsView() {
  return {
    loading: false,
    connections: [],
    // ... 现有字段 ...

    // ── 预设相关 ──
    presets: [], // 合并后的预设列表（从后端加载）
    presetCategory: "popular", // 当前选中的分类 Tab
    selectedPresetId: "", // 当前选中的预设 ID
    // ... 现有 connForm ...

    // ── 在线模型探测相关 ──
    fetchedModels: [], // 探测到的模型列表
    fetchingModels: false, // 探测中状态
    modelSearchQuery: "", // 模型搜索关键词
    selectedModelIds: new Set(), // 已勾选的模型 ID 集合
    showFetchedModelsPanel: false, // 是否展示探测结果面板

    // ... 其余现有字段 ...
  }
}
```

#### 新增方法

```javascript
// 加载预设列表
async loadPresets() {
  try {
    const data = await API.providerConnections.presets()
    this.presets = data.presets || []
  } catch (e) {
    // 预设加载失败时降级为空列表，不阻塞连接管理
    this.presets = []
  }
},

// 按分类过滤预设
get filteredPresets() {
  if (this.presetCategory === "popular") {
    // 常用热门：取各分类的前几个
    const popularIds = ["deepseek", "openai", "anthropic", "openrouter", "siliconflow", "groq"]
    return this.presets.filter((p) => popularIds.includes(p.id))
  }
  return this.presets.filter((p) => p.category === this.presetCategory)
},

// 选择预设 → 自动填充表单
selectPreset(preset) {
  this.selectedPresetId = preset.id
  this.connForm.name = preset.name
  this.connForm.protocol = preset.protocol
  this.connForm.baseUrl = preset.baseUrl
  this.connForm.discoveryEnabled = preset.discoveryEnabled ?? false
  this.connForm.discoveryMode = preset.discoveryMode ?? "merge"
  // 预置模型直接勾选
  this.selectedModelIds = new Set(
    (preset.defaultModels || []).map((m) => m.publicId)
  )
  this.fetchedModels = preset.defaultModels || []
  this.showFetchedModelsPanel = true
  // 清空 API Key，用户需要手动输入
  this.connForm.apiKey = ""
},

// 选择"自定义"预设 → 清空所有自动填充
selectCustomPreset() {
  this.selectedPresetId = "custom"
  this.connForm.name = ""
  this.connForm.protocol = "openai-compatible"
  this.connForm.baseUrl = ""
  this.connForm.apiKey = ""
  this.connForm.discoveryEnabled = false
  this.connForm.discoveryMode = "merge"
  this.fetchedModels = []
  this.selectedModelIds = new Set()
  this.showFetchedModelsPanel = false
},

// 在线获取上游可用模型
async fetchRemoteModels() {
  const form = this.connForm
  if (!form.baseUrl) {
    this.showToast("请先填写 Base URL", "error")
    return
  }
  if (!form.apiKey) {
    this.showToast("请先填写 API Key", "error")
    return
  }

  const preset = this.presets.find((p) => p.id === this.selectedPresetId)
  const authMode = preset?.authMode || "bearer"
  const headerName = preset?.headerName

  this.fetchingModels = true
  try {
    const res = await API.providerConnections.fetchModels({
      protocol: form.protocol,
      baseUrl: form.baseUrl,
      apiKey: form.apiKey,
      authMode,
      headerName,
    })
    if (res.error) {
      this.showToast((res.hint ? res.hint + "：" : "") + res.error, "error")
      return
    }
    this.fetchedModels = res.models || []
    this.showFetchedModelsPanel = true
    // 默认全选探测到的模型
    this.selectedModelIds = new Set(this.fetchedModels.map((m) => m.publicId))
    this.showToast(`获取到 ${this.fetchedModels.length} 个模型`, "success")
  } catch (e) {
    this.showToast(e.message || "获取模型失败", "error")
  } finally {
    this.fetchingModels = false
  }
},

// 过滤后的模型列表（用于展示）
get filteredFetchedModels() {
  const q = this.modelSearchQuery.trim().toLowerCase()
  if (!q) return this.fetchedModels
  return this.fetchedModels.filter(
    (m) =>
      m.publicId.toLowerCase().includes(q) ||
      m.upstreamId.toLowerCase().includes(q) ||
      (m.vendor || "").toLowerCase().includes(q),
  )
},

// 全选/取消全选
toggleSelectAllModels() {
  if (this.selectedModelIds.size === this.fetchedModels.length) {
    this.selectedModelIds = new Set()
  } else {
    this.selectedModelIds = new Set(this.fetchedModels.map((m) => m.publicId))
  }
},

// 切换单个模型勾选
toggleModelSelection(publicId) {
  const next = new Set(this.selectedModelIds)
  if (next.has(publicId)) {
    next.delete(publicId)
  } else {
    next.add(publicId)
  }
  this.selectedModelIds = next
},

// 清空所有勾选
clearModelSelection() {
  this.selectedModelIds = new Set()
},
```

#### 修改 `openCreate()`

```javascript
openCreate() {
  this.connForm = {
    id: null,
    name: "",
    protocol: "openai-compatible",
    baseUrl: "",
    priority: 10,
    weight: 1,
    enabled: true,
    discoveryEnabled: false,
    discoveryMode: "merge",
    apiKey: "",
    _credentialId: null,
  }
  this.selectedPresetId = ""
  this.presetCategory = "popular"
  this.fetchedModels = []
  this.selectedModelIds = new Set()
  this.modelSearchQuery = ""
  this.showFetchedModelsPanel = false
  this.showConnModal = true
  // 加载预设列表（如果尚未加载）
  if (this.presets.length === 0) {
    this.loadPresets()
  }
  this.$nextTick(() => lucide.createIcons())
},
```

#### 修改 `saveConn()`

在保存时将勾选的模型一并写入连接：

```javascript
async saveConn() {
  const form = this.connForm
  if (!form.name || !form.baseUrl) {
    this.showToast("Name and Base URL are required", "error")
    return
  }

  // 构造勾选的模型列表
  const selectedModels = this.fetchedModels
    .filter((m) => this.selectedModelIds.has(m.publicId))
    .map((m) => ({
      publicId: m.publicId,
      upstreamId: m.upstreamId,
      vendor: m.vendor,
      endpoints: m.endpoints || ["chat"],
      enabled: true,
      pickerEnabled: true,
    }))

  const payload = {
    name: form.name,
    protocol: form.protocol,
    baseUrl: form.baseUrl,
    priority: form.priority,
    weight: form.weight,
    enabled: form.enabled,
    modelDiscovery: {
      enabled: form.discoveryEnabled,
      mode: form.discoveryMode,
    },
    // 一次性把勾选的模型写入连接
    models: selectedModels.length > 0 ? selectedModels : undefined,
  }

  const credAuth =
    form.protocol === "anthropic-compatible"
      ? { authMode: "header", headerName: "x-api-key" }
      : { authMode: "bearer" }

  try {
    let connId
    if (form.id) {
      await API.providerConnections.update(form.id, payload)
      connId = form.id
      if (form.apiKey) {
        const credPayload = { ...credAuth, value: form.apiKey }
        await (form._credentialId
          ? API.providerConnections.updateCredential(connId, form._credentialId, credPayload)
          : API.providerConnections.addCredential(connId, { ...credPayload, enabled: true }))
      }
    } else {
      // 创建连接时同时传入凭据和模型
      const createPayload = {
        ...payload,
        credentials: form.apiKey
          ? [{ ...credAuth, value: form.apiKey, enabled: true }]
          : undefined,
      }
      const res = await API.providerConnections.create(createPayload)
      connId = res.connection.id
    }
    this.showConnModal = false
    await this.load()
    this.showToast("Saved", "success")
  } catch (e) {
    this.showToast(e.message || "Save failed", "error")
  }
},
```

**注意**：现有 `POST /admin/api/provider-connections` 已支持 `credentials` 数组（见 `provider-connections.ts:162-165`），所以创建时可以一次性传入凭据，无需二次调用 `addCredential`。

### 6.4 修改：`pages/index.html`

#### 引入预设文件

```html
<!-- 在现有 JS 引入之后添加 -->
<script src="/js/provider-presets.js"></script>
```

#### 改造 Connection Modal

将现有的 `<div class="modal-body space-y-4">` 替换为以下结构：

```html
<div class="modal-body space-y-4">
  <!-- ── Provider 预设选择区 ── -->
  <div x-show="!connForm.id" class="space-y-3">
    <!-- 分类 Tab -->
    <div class="flex gap-1.5 flex-wrap">
      <button
        @click="presetCategory = 'popular'"
        :class="presetCategory === 'popular' ? 'btn-tab-active' : 'btn-tab'"
        class="px-3 py-1.5 text-xs font-medium rounded-lg transition-colors"
      >
        🌟 常用热门
      </button>
      <button
        @click="presetCategory = 'domestic'"
        :class="presetCategory === 'domestic' ? 'btn-tab-active' : 'btn-tab'"
        class="px-3 py-1.5 text-xs font-medium rounded-lg transition-colors"
      >
        🇨🇳 国内主流
      </button>
      <button
        @click="presetCategory = 'international'"
        :class="presetCategory === 'international' ? 'btn-tab-active' : 'btn-tab'"
        class="px-3 py-1.5 text-xs font-medium rounded-lg transition-colors"
      >
        🌍 海外大厂
      </button>
      <button
        @click="presetCategory = 'aggregator'"
        :class="presetCategory === 'aggregator' ? 'btn-tab-active' : 'btn-tab'"
        class="px-3 py-1.5 text-xs font-medium rounded-lg transition-colors"
      >
        🔀 聚合中转
      </button>
      <button
        @click="presetCategory = 'local'"
        :class="presetCategory === 'local' ? 'btn-tab-active' : 'btn-tab'"
        class="px-3 py-1.5 text-xs font-medium rounded-lg transition-colors"
      >
        ⚙️ 自建
      </button>
      <button
        @click="selectCustomPreset()"
        :class="selectedPresetId === 'custom' ? 'btn-tab-active' : 'btn-tab'"
        class="px-3 py-1.5 text-xs font-medium rounded-lg transition-colors"
      >
        ✏️ 自定义
      </button>
    </div>

    <!-- 预设卡片网格 -->
    <div class="grid grid-cols-3 sm:grid-cols-4 gap-2 max-h-32 overflow-y-auto">
      <template x-for="preset in filteredPresets" :key="preset.id">
        <button
          @click="selectPreset(preset)"
          :class="selectedPresetId === preset.id ? 'preset-card-active' : 'preset-card'"
          class="p-2.5 rounded-lg border text-left transition-all"
        >
          <div class="text-sm font-medium truncate" x-text="preset.name"></div>
          <div
            class="text-xs text-[var(--apple-text-tertiary)] truncate mt-0.5"
            x-text="preset.description || preset.baseUrl"
          ></div>
        </button>
      </template>
    </div>
  </div>

  <!-- ── 表单字段（自动填充，可修改）── -->
  <div>
    <label class="form-label" x-text="t('connections.name')"></label>
    <input
      type="text"
      x-model="connForm.name"
      class="form-input"
      placeholder="DeepSeek Production"
    />
  </div>

  <div class="grid grid-cols-2 gap-3">
    <div>
      <label class="form-label" x-text="t('connections.protocol')"></label>
      <select x-model="connForm.protocol" class="form-input">
        <option value="openai-compatible">openai-compatible</option>
        <option value="openai-responses-compatible">
          openai-responses-compatible
        </option>
        <option value="anthropic-compatible">anthropic-compatible</option>
      </select>
    </div>
    <div>
      <label class="form-label" x-text="t('connections.priority')"></label>
      <input
        type="number"
        x-model.number="connForm.priority"
        class="form-input"
        placeholder="10"
        min="0"
      />
    </div>
  </div>

  <div>
    <label class="form-label" x-text="t('connections.baseUrl')"></label>
    <input
      type="text"
      x-model="connForm.baseUrl"
      class="form-input"
      placeholder="https://api.deepseek.com/v1"
    />
    <p
      class="text-xs text-[var(--apple-text-tertiary)] mt-1.5"
      x-text="t('connections.baseUrlHint')"
    ></p>
  </div>

  <!-- API Key + 获取链接 -->
  <div>
    <div class="flex items-center justify-between">
      <label class="form-label" x-text="t('connections.apiKey')"></label>
      <template x-if="selectedPreset && selectedPreset.portalUrl">
        <a
          :href="selectedPreset.portalUrl"
          target="_blank"
          rel="noopener"
          class="text-xs text-[var(--apple-blue)] hover:underline flex items-center gap-1"
        >
          <i data-lucide="external-link" class="w-3 h-3"></i>
          <span x-text="t('connections.getApiKey')"></span>
        </a>
      </template>
    </div>
    <input
      type="password"
      x-model="connForm.apiKey"
      class="form-input"
      :placeholder="connForm._credentialId ? t('connections.leaveBlank') : (selectedPreset?.keyPlaceholder || 'sk-...')"
    />
  </div>

  <!-- ── 在线模型探测面板 ── -->
  <div class="space-y-2">
    <div class="flex items-center justify-between">
      <label class="form-label">
        <span x-text="t('connections.supportedModels')"></span>
        <span
          class="text-xs text-[var(--apple-text-tertiary)] ml-1"
          x-show="selectedModelIds.size > 0"
          x-text="'(' + selectedModelIds.size + ' 已选)'"
        ></span>
      </label>
      <div class="flex gap-2">
        <button
          @click="fetchRemoteModels()"
          :disabled="fetchingModels || !connForm.baseUrl || !connForm.apiKey"
          class="btn btn-secondary text-xs py-1 px-2.5 flex items-center gap-1.5"
        >
          <i
            data-lucide="zap"
            class="w-3.5 h-3.5"
            :class="fetchingModels ? 'animate-spin' : ''"
          ></i>
          <span
            x-text="fetchingModels ? t('connections.fetching') : t('connections.fetchModels')"
          ></span>
        </button>
        <template x-if="showFetchedModelsPanel">
          <div class="flex gap-1.5">
            <button
              @click="toggleSelectAllModels()"
              class="btn btn-secondary text-xs py-1 px-2"
              x-text="t('connections.selectAll')"
            ></button>
            <button
              @click="clearModelSelection()"
              class="btn btn-secondary text-xs py-1 px-2"
              x-text="t('connections.clearAll')"
            ></button>
          </div>
        </template>
      </div>
    </div>

    <!-- 搜索框（探测结果展示时显示） -->
    <template x-if="showFetchedModelsPanel && fetchedModels.length > 5">
      <div class="relative">
        <i
          data-lucide="search"
          class="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-[var(--apple-text-tertiary)]"
        ></i>
        <input
          type="text"
          x-model="modelSearchQuery"
          class="form-input pl-9"
          :placeholder="t('connections.searchModels')"
        />
      </div>
    </template>

    <!-- 模型勾选列表 -->
    <template x-if="showFetchedModelsPanel">
      <div
        class="border rounded-lg max-h-48 overflow-y-auto divide-y divide-[var(--apple-border)]"
      >
        <template x-for="model in filteredFetchedModels" :key="model.publicId">
          <label
            class="flex items-center gap-2.5 p-2.5 cursor-pointer hover:bg-[var(--apple-hover)] transition-colors"
          >
            <input
              type="checkbox"
              :checked="selectedModelIds.has(model.publicId)"
              @change="toggleModelSelection(model.publicId)"
              class="w-4 h-4 rounded accent-[var(--apple-blue)]"
            />
            <div class="flex-1 min-w-0">
              <div
                class="text-sm font-medium truncate"
                x-text="model.publicId"
              ></div>
              <div
                class="text-xs text-[var(--apple-text-tertiary)] truncate"
                x-show="model.upstreamId !== model.publicId"
                x-text="model.upstreamId"
              ></div>
            </div>
            <div
              class="flex gap-1"
              x-show="model.endpoints && model.endpoints.length > 0"
            >
              <template x-for="ep in model.endpoints" :key="ep">
                <span
                  class="text-xs px-1.5 py-0.5 rounded bg-[var(--apple-tag-bg)] text-[var(--apple-text-secondary)]"
                  x-text="ep"
                ></span>
              </template>
            </div>
          </label>
        </template>
        <div
          x-show="filteredFetchedModels.length === 0"
          class="p-4 text-center text-sm text-[var(--apple-text-tertiary)]"
        >
          <span
            x-text="modelSearchQuery ? t('connections.noModelsFound') : t('connections.noModels')"
          ></span>
        </div>
      </div>
    </template>
  </div>

  <!-- ── 高级选项（折叠）── -->
  <details class="group">
    <summary
      class="cursor-pointer text-sm font-medium text-[var(--apple-text-secondary)] flex items-center gap-1.5"
    >
      <i
        data-lucide="chevron-right"
        class="w-4 h-4 group-open:rotate-90 transition-transform"
      ></i>
      <span x-text="t('connections.advancedOptions')"></span>
    </summary>
    <div class="mt-3 space-y-3">
      <div class="grid grid-cols-2 gap-3">
        <div>
          <label class="form-label" x-text="t('connections.weight')"></label>
          <input
            type="number"
            x-model.number="connForm.weight"
            class="form-input"
            placeholder="1"
            min="1"
          />
        </div>
        <div class="flex items-end pb-0.5">
          <label class="flex items-center gap-2.5 cursor-pointer">
            <input
              type="checkbox"
              x-model="connForm.enabled"
              class="w-4 h-4 rounded accent-[var(--apple-blue)]"
            />
            <span class="text-sm font-medium" x-text="t('enabled')"></span>
          </label>
        </div>
      </div>
      <div>
        <label
          class="form-label"
          x-text="t('connections.modelDiscovery')"
        ></label>
        <div class="flex items-center gap-3">
          <label class="flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              x-model="connForm.discoveryEnabled"
              class="w-4 h-4 rounded accent-[var(--apple-blue)]"
            />
            <span
              class="text-sm"
              x-text="t('connections.discoveryEnabled')"
            ></span>
          </label>
          <select
            x-model="connForm.discoveryMode"
            class="form-input flex-1"
            :disabled="!connForm.discoveryEnabled"
          >
            <option value="merge">merge</option>
            <option value="replace">replace</option>
            <option value="manual-only">manual-only</option>
          </select>
        </div>
      </div>
    </div>
  </details>
</div>
```

#### 空状态推荐卡片

在连接列表为空时展示快捷接入卡片：

```html
<!-- 在连接列表容器内，connections.length === 0 时展示 -->
<template x-if="!loading && connections.length === 0">
  <div class="text-center py-12 space-y-6">
    <div class="space-y-2">
      <i
        data-lucide="plug-zap"
        class="w-12 h-12 mx-auto text-[var(--apple-text-tertiary)]"
      ></i>
      <h3 class="text-title-3" x-text="t('connections.emptyTitle')"></h3>
      <p
        class="text-sm text-[var(--apple-text-tertiary)]"
        x-text="t('connections.emptyHint')"
      ></p>
    </div>
    <div class="grid grid-cols-2 sm:grid-cols-3 gap-3 max-w-lg mx-auto">
      <template x-for="preset in popularPresets" :key="preset.id">
        <button
          @click="openCreate(); $nextTick(() => selectPreset(preset))"
          class="p-4 rounded-xl border border-[var(--apple-border)] hover:border-[var(--apple-blue)] hover:bg-[var(--apple-hover)] transition-all text-left"
        >
          <div class="text-sm font-medium" x-text="preset.name"></div>
          <div
            class="text-xs text-[var(--apple-text-tertiary)] mt-1"
            x-text="preset.description"
          ></div>
        </button>
      </template>
    </div>
  </div>
</template>
```

### 6.5 修改：`pages/css/apple-theme.css`

新增样式：

```css
/* ── 预设卡片 ── */
.preset-card {
  border-color: var(--apple-border);
  background: var(--apple-surface);
}
.preset-card:hover {
  border-color: var(--apple-blue);
  background: var(--apple-hover);
}
.preset-card-active {
  border-color: var(--apple-blue);
  background: rgba(0, 122, 255, 0.08);
  box-shadow: 0 0 0 1px var(--apple-blue);
}

/* ── 分类 Tab ── */
.btn-tab {
  background: var(--apple-surface);
  color: var(--apple-text-secondary);
  border: 1px solid var(--apple-border);
}
.btn-tab:hover {
  background: var(--apple-hover);
}
.btn-tab-active {
  background: var(--apple-blue);
  color: white;
  border: 1px solid var(--apple-blue);
}

/* ── 模型勾选列表 ── */
.model-checkbox-item {
  transition: background-color 0.15s;
}
.model-checkbox-item:hover {
  background: var(--apple-hover);
}
```

### 6.6 修改：`pages/js/i18n.js`

新增词条：

```javascript
// 中文
{
  "connections.getApiKey": "获取 API Key",
  "connections.fetchModels": "在线获取模型",
  "connections.fetching": "获取中...",
  "connections.selectAll": "全选",
  "connections.clearAll": "清空",
  "connections.searchModels": "搜索模型...",
  "connections.supportedModels": "支持的模型",
  "connections.noModels": "暂无模型，请点击「在线获取模型」",
  "connections.noModelsFound": "未找到匹配的模型",
  "connections.advancedOptions": "高级选项",
  "connections.emptyTitle": "还没有外部 Provider 连接",
  "connections.emptyHint": "选择下方常用 Provider 快速接入，或点击添加连接自定义配置",
}

// 英文
{
  "connections.getApiKey": "Get API Key",
  "connections.fetchModels": "Fetch Models",
  "connections.fetching": "Fetching...",
  "connections.selectAll": "Select All",
  "connections.clearAll": "Clear",
  "connections.searchModels": "Search models...",
  "connections.supportedModels": "Supported Models",
  "connections.noModels": "No models yet. Click \"Fetch Models\" to discover.",
  "connections.noModelsFound": "No models match your search",
  "connections.advancedOptions": "Advanced Options",
  "connections.emptyTitle": "No external provider connections yet",
  "connections.emptyHint": "Quick-add a popular provider below, or click Add to customize.",
}
```

## 7. 实施步骤

### 阶段 1：后端（不破坏现有功能）

| 步骤 | 文件                                           | 改动                                                      |
| ---- | ---------------------------------------------- | --------------------------------------------------------- |
| 1.1  | `src/routes/admin/api/provider-presets.ts`     | **新建**：预设目录 API，内置 33 个预设 + 用户配置文件合并 |
| 1.2  | `src/routes/admin/api/provider-connections.ts` | **新增** `POST /fetch-models` 即时探测接口                |
| 1.3  | `src/routes/admin/api/provider-connections.ts` | **挂载** `providerPresetRoutes`                           |
| 1.4  | 验证                                           | `curl` 测试两个新接口                                     |

### 阶段 2：前端数据层

| 步骤 | 文件                           | 改动                                         |
| ---- | ------------------------------ | -------------------------------------------- |
| 2.1  | `pages/js/provider-presets.js` | **新建**：33 个内置预设数据（纯数据文件）    |
| 2.2  | `pages/js/api.js`              | **新增** `presets()` 和 `fetchModels()` 方法 |
| 2.3  | `pages/index.html`             | **引入** `provider-presets.js`               |

### 阶段 3：前端 UI

| 步骤 | 文件                            | 改动                                                  |
| ---- | ------------------------------- | ----------------------------------------------------- |
| 3.1  | `pages/js/views/connections.js` | 新增预设/探测/勾选相关状态和方法                      |
| 3.2  | `pages/js/views/connections.js` | 修改 `openCreate()`、`saveConn()`                     |
| 3.3  | `pages/index.html`              | 改造 Connection Modal（预设区 + 探测面板 + 高级折叠） |
| 3.4  | `pages/index.html`              | 新增空状态推荐卡片                                    |
| 3.5  | `pages/css/apple-theme.css`     | 新增预设卡片、Tab、模型列表样式                       |
| 3.6  | `pages/js/i18n.js`              | 新增中英文词条                                        |

### 阶段 4：验证

| 步骤 | 验证内容                                                                 |
| ---- | ------------------------------------------------------------------------ |
| 4.1  | 选 DeepSeek 预设 → 自动填充 → 填 Key → 探测 → 勾选 → 保存 → 连接可用     |
| 4.2  | 选自定义 → 手动填写 → 保存 → 连接可用                                    |
| 4.3  | 编辑已有连接 → 预设区不显示（`x-show="!connForm.id"`）→ 模型面板可用     |
| 4.4  | 用户配置文件覆盖测试：写入 `provider-presets.json` → 重启 → 验证覆盖生效 |
| 4.5  | 错误场景：错误 API Key → 探测返回友好提示；错误 Base URL → 连接失败提示  |

## 8. 风险与注意事项

### 8.1 火山引擎（豆包）Endpoint 模型

火山引擎不使用固定模型名，而是用户在控制台创建 Inference Endpoint。预置的 `doubao-seed-2.0-*` 模型名可能无法直接调用。处理方式：

- 预置模型仅作参考，UI 上标注"建议使用在线获取"
- `fetchable: true`，探测会返回用户已创建的 Endpoint 模型

### 8.2 Ollama / vLLM 本地服务

- 无需 API Key，但当前 `fetchModels` 接口要求 `apiKey` 必填
- **处理方案**：对 `ollama` / `vllm` 预设，`apiKey` 字段允许传空字符串或任意占位符（Ollama 的 `/v1/models` 不校验 Authorization）
- 后端 `fetch-models` 接口对 `authMode: "bearer"` 且 `apiKey` 为空时，不附加 Authorization header

### 8.3 Ollama `/v1/models` 响应格式

Ollama 的 OpenAI 兼容端点 `/v1/models` 返回格式与标准 OpenAI 一致（`{ data: [{ id, object, owned_by }] }`），现有 `openAICompatibleAdapter.discoverModels` 可以正确解析。但需要验证 Ollama 是否默认开启 OpenAI 兼容端点（`OLLAMA_HOST` 配置）。

### 8.4 即时探测的安全边界

- 临时凭据**不落盘**、不写日志（与现有 `testConnection` 一致）
- 10 秒超时
- SSRF 防护：只允许 http/https 协议
- 不允许 `*-native` 协议（与现有 `POST /` 一致）

### 8.5 预设数据维护

内置预设随代码版本发布，模型列表可能过时。处理方式：

- `defaultModels` 只放最稳定的主力模型（如 `deepseek-chat` 而非 `deepseek-coder-0924`）
- `discoveryEnabled: true` 让连接创建后自动发现新模型
- 用户可通过 `provider-presets.json` 覆盖过时的内置预设

### 8.6 向后兼容

- 现有 `POST /admin/api/provider-connections` 接口不变，只是前端在创建时多传了 `models` 和 `credentials` 数组（这两个字段接口已支持）
- 现有 `POST /:id/refresh-models` 接口保留，用于已保存连接的模型刷新
- 现有批量添加模型功能保留，作为模型勾选的补充手段
- 现有导入/导出功能不受影响

## 9. 文件变更清单

| 文件                                           | 操作     | 说明                                       |
| ---------------------------------------------- | -------- | ------------------------------------------ |
| `src/routes/admin/api/provider-presets.ts`     | **新建** | 预设目录 API + 33 个内置预设               |
| `src/routes/admin/api/provider-connections.ts` | **修改** | 新增 `fetch-models` 接口 + 挂载预设路由    |
| `pages/js/provider-presets.js`                 | **新建** | 前端内置预设数据（可选，也可只从后端加载） |
| `pages/js/api.js`                              | **修改** | 新增 `presets()` 和 `fetchModels()`        |
| `pages/js/views/connections.js`                | **修改** | 预设/探测/勾选状态和方法                   |
| `pages/index.html`                             | **修改** | Modal 改造 + 空状态卡片                    |
| `pages/css/apple-theme.css`                    | **修改** | 新增样式                                   |
| `pages/js/i18n.js`                             | **修改** | 新增词条                                   |
| `docs/refactor-provider-presets.md`            | **新建** | 本文档                                     |

**不需要改动的文件**：

- `src/lib/provider-connections/types.ts` — 数据模型不变
- `src/services/protocols/*.ts` — adapter 不变
- `src/services/protocols/types.ts` — 接口不变
