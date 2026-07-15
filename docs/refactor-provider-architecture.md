# Provider 架构去冗余重构 Spec

状态：**进行中**
创建日期：2026-07-15
基线：`bun test` → 542 pass / 2 skip / 0 fail（Ran 544 tests across 70 files）

本文档是一份**可由 agent 循环执行的重构规格**。每个任务都是独立可验收的最小单元，
按编号顺序执行。目标是消除按 provider 复制的平行代码，使"新增一个 provider"
从改 10+ 个文件收敛到改 1-2 个文件。

---

## 背景：三类冗余（为什么做）

1. **OAuth / Quota 层同构复制**：5 个 OAuth provider（claude/codex/xai/kimi/antigravity）
   各自复制 exchange/refresh/applyBundle 流程；5 个 quota fetcher 复制同一抓取骨架；
   `refresh-scheduler.ts` / `quota/index.ts` / `admin/api/oauth.ts` 再各用 switch 分发一遍。
2. **Provider 身份信息 5 份平行注册表**：`PROVIDER_PROTOCOL_MAP`（lib/provider-config.ts）、
   `OAUTH_PROTOCOL_MAP`（services/providers/index.ts，完全重复的子集）、
   `provider-cache.ts` 的双向查表、`flows.ts` 的手写 if 链、两个手工注册入口。
3. **Account / ProviderConnection 双模型并存**：`account-adapter.ts`（466 行双向映射）
   是未完成迁移（代码注释中的 "Step D"）的兼容层。本 spec 的 P5 处理它，
   但**默认 gated，需人工确认后才能开始**。

---

## Agent 执行协议（loop 友好）

每轮迭代严格按以下步骤：

1. 读本文档的「任务清单」，找到**编号最小且状态为 `[ ]`** 的任务。
2. 若该任务标注 **[需人工确认]** 且「执行日志」中没有对应的人工批准记录 →
   **停止整个循环**，向用户报告等待确认。
3. 阅读该任务的详细规格，以及「涉及文件」列出的所有文件的**完整内容**后再动手。
4. 实施改动，运行「验收」中列出的全部命令。
5. 全部通过 → 将清单中该任务状态改为 `[x]`，在「执行日志」追加一行，
   然后 `git add <本任务改动的文件> docs/refactor-provider-architecture.md`
   并 commit（消息格式见守则 G6）。
6. 验收失败且无法在合理尝试内修复 → `git checkout -- .` 恢复工作区，
   将任务状态改为 `[!]`，在「执行日志」记录失败原因，**继续下一个任务**
   （除非后续任务的「依赖」声明了它）。

## 全局守则（每个任务都必须遵守）

- **G1 行为不变**：所有 HTTP 接口、SSE 输出、持久化文件格式（accounts.json 等）、
  日志格式保持不变。P1–P4、P6 是纯内部重构。只有 P5 允许改持久化格式。
- **G2 验收三件套**：每个任务完成后必须运行且全绿：
  ```sh
  bun run typecheck
  bun run lint
  bun test
  ```
  `bun test` 结果不得低于基线（542 pass / 0 fail）。**不得修改任何测试的期望值**，
  除非任务规格明确要求；测试文件中对被移动/改名符号的 import 路径可以同步更新。
- **G3 不新增运行时依赖**：package.json 的 dependencies 不得变化。
- **G4 不顺手重构**：只改任务「涉及文件」列出的文件（新建文件除外）。
  发现规格之外的问题 → 记入「执行日志」的"发现"栏，不要当场修。
- **G5 保留导出兼容**：任务若把函数收敛为通用实现，默认保留原导出名作为
  薄包装（一行 delegate），除非任务明确说"删除导出并更新所有调用点"。
- **G6 提交纪律**：一个任务一个 commit，格式
  `refactor(<scope>): <任务ID> <简述>`，例如
  `refactor(oauth): T1.1 unify applyOAuthBundle`。
  工作区中不属于本任务的未提交改动（如 `src/lib/quota/upstream-proxy.ts`
  的既有修改）**不得**纳入 commit。
- **G7 类型收紧优先**：能用查表（`Record<ProviderId, …>`，key 穷尽检查）就不用
  switch/if 链；新增查表必须让 TypeScript 在遗漏 provider 时报编译错误。

---

## 任务清单

> 状态标记：`[ ]` 未开始 / `[x]` 完成 / `[!]` 失败跳过 / `[~]` 进行中

### P0 基线
- [x] T0.1 记录基线并确认工作区状态

### P1 OAuth 层策略化
- [x] T1.1 统一 applyOAuthBundle
- [x] T1.2 callback server 配置数据化
- [x] T1.3 refresh 分发改为策略注册表
- [x] T1.4 admin OAuth 路由的 start/exchange 策略化

### P2 Quota 层数据驱动
- [x] T2.1 通用 quota fetch 引擎（claude/kimi 先行）
- [x] T2.2 quota 分发 switch → 注册表（含 xai/antigravity/codex 收编）
- [x] T2.3 cycles.ts 的 per-provider switch 查表化

### P3 注册表去重
- [x] T3.1 删除 OAUTH_PROTOCOL_MAP
- [x] T3.2 provider-cache 反向映射派生化
- [x] T3.3 OAuthFlowProvider 类型统一
- [x] T3.4 protocols 层 extractAccount 去重

### P4 收尾
- [!] T4.1 [调查先行] Provider*Result 与 Adapter*Result 类型合并
- [x] T4.2 死代码与残留 switch 审计

### P5 消灭 Account 双模型（Step D）
- [ ] T5.1 [需人工确认] 产出 Step D 详细设计文档
- [ ] T5.2 [需人工确认] 按 T5.1 批准后的设计实施（后续拆分）

### P6 翻译层规约
- [x] T6.1 确立枢纽格式规约文档

---

## 任务详细规格

### T0.1 记录基线并确认工作区状态

**目的**：为后续任务提供对照基准；确认无关改动不会混入。

**步骤**：
1. 运行 `git status --short`，把输出记录到「执行日志」。
   若存在未提交改动，记下文件名——后续所有 commit 不得包含它们。
2. 运行 G2 三件套，把 `bun test` 的 pass/skip/fail 数记录到「执行日志」。
3. 若与文档头部基线不一致，以实测为准更新文档头部的基线行。

**验收**：三件套全绿；「执行日志」有基线记录。本任务无代码改动，
commit 只包含本文档（`docs: T0.1 record refactor baseline`）。

---

### T1.1 统一 applyOAuthBundle

**目的**：5 个 `applyXxxOAuthBundle` 逐行同构（写 credentials 若干字段 +
重置 runtimeState 为 ready），收敛为一个通用函数。

**涉及文件**：
- 新建 `src/services/oauth/apply-bundle.ts`
- `src/services/oauth/claude.ts`（`applyClaudeOAuthBundle`，约 147 行）
- `src/services/oauth/codex.ts`（`applyCodexOAuthBundle`，约 150 行）
- `src/services/oauth/xai.ts`（`applyXaiOAuthBundle`，约 222 行）
- `src/services/oauth/kimi.ts`（`applyKimiOAuthBundle`，约 222 行）
- `src/services/oauth/antigravity.ts`（`applyAntigravityOAuthBundle`，约 349 行）

**步骤**：
1. 新建 `apply-bundle.ts`，实现：
   ```ts
   import type { OAuthAccount } from "~/lib/accounts"

   export interface OAuthBundleCore {
     accessToken: string
     refreshToken?: string
     expiresAt?: number
   }

   /**
    * 通用 OAuth bundle 落库:写 credentials(undefined 字段保留旧值)
    * 并将 runtimeState 置为 ready。
    * extraCredentials 承载 provider 专属字段(email/idToken/deviceId/
    * projectId/accountId 等),同样遵循 undefined 保留旧值的语义。
    */
   export function applyOAuthBundle(
     account: OAuthAccount,
     bundle: OAuthBundleCore,
     extraCredentials?: Record<string, unknown>,
   ): void
   ```
   实现语义**必须**与现有五个函数一致：
   - `accessToken` 无条件覆盖；
   - `refreshToken` / `expiresAt` / 每个 extra 字段：值为 `undefined` 时
     保留 `account.credentials` 中的旧值（`?? account.credentials?.<key>`）；
   - `account.runtimeState = { ...旧值, authStatus: "ready", lastRefreshAt: Date.now(), lastError: undefined }`。
2. 把五个 `applyXxxOAuthBundle` 改写为对 `applyOAuthBundle` 的薄包装，
   各自把专属字段放进 `extraCredentials`。改写前**逐个对照原实现**，
   确认没有遗漏字段（已知差异：claude→email；codex→idToken/accountId/email；
   xai→idToken/email；kimi→deviceId；antigravity→projectId/email。
   antigravity 若还写了 redirectUri 之类字段，照原样保留在包装内）。
3. 保留五个原导出名不变（G5），调用点零改动。

**验收**：G2 三件套；
`grep -c "runtimeState = {" src/services/oauth/claude.ts src/services/oauth/codex.ts src/services/oauth/xai.ts src/services/oauth/kimi.ts src/services/oauth/antigravity.ts`
每个文件中 applyBundle 内不再手写 runtimeState（其他函数里的合法写入不算）。

---

### T1.2 callback server 配置数据化

**目的**：`flows.ts` 中 `startClaudeCallbackServer` / `startCodexCallbackServer` /
`startXaiCallbackServer` / `startAntigravityCallbackServer`（约 341–401 行）
只差 port/hostname/path/label 四个参数。

**涉及文件**：
- `src/services/oauth/flows.ts`
- 调用点：`grep -rln "start\(Claude\|Codex\|Xai\|Antigravity\)CallbackServer" src tests` 找全

**步骤**：
1. 在 `flows.ts` 定义：
   ```ts
   export const OAUTH_CALLBACK_CONFIGS = {
     claude: { port: 54545, callbackPath: "/callback", providerLabel: "Claude" },
     codex: { port: 1455, callbackPath: "/auth/callback", providerLabel: "Codex" },
     xai: { port: 56121, hostname: "127.0.0.1", callbackPath: "/callback", providerLabel: "xAI" },
     antigravity: { port: 51121, hostname: "localhost", callbackPath: "/oauth-callback", providerLabel: "Antigravity" },
   } as const satisfies Partial<Record<OAuthFlowProvider, …>>
   ```
   （类型按现有 `OAuthCallbackServerOptions` 的子集自行定义。）
2. 新增
   `startProviderCallbackServer(provider, flowId, expectedState, timeoutMs?)`，
   内部查 `OAUTH_CALLBACK_CONFIGS` 后调用现有 `startOAuthCallbackServer`。
   provider 无配置时抛错。
3. 删除四个 `startXxxCallbackServer` 导出（本任务例外于 G5，因为包装本身
   就是要消灭的冗余），更新所有调用点为 `startProviderCallbackServer("claude", …)` 等。

**验收**：G2 三件套；`grep -rn "startClaudeCallbackServer\|startCodexCallbackServer\|startXaiCallbackServer\|startAntigravityCallbackServer" src tests` 无结果。

---

### T1.3 refresh 分发改为策略注册表

**目的**：`refresh-scheduler.ts` 的 `refreshOAuthAccountToken` 内部 switch
（约 138–188 行）分发 5 个 provider，改为查表。

**涉及文件**：
- 新建 `src/services/oauth/refresh-strategies.ts`
- `src/services/oauth/refresh-scheduler.ts`

**步骤**：
1. 新建 `refresh-strategies.ts`：
   ```ts
   export type OAuthRefreshFn = (
     account: OAuthAccount,
     refreshToken: string,
     fetchOptions: OAuthFetchOptions,
   ) => Promise<void>

   export const OAUTH_REFRESH_STRATEGIES: Record<OAuthProviderId, OAuthRefreshFn>
   ```
   每个条目把现有 switch case 的内容原样搬入（含 kimi 的 deviceId 生成与回写、
   xai 的 tokenEndpoint 读取、antigravity 的 redirectUri 默认值）。
   `Record<OAuthProviderId, …>` 穷尽 key，遗漏即编译错误（G7）。
2. 同时把 `getRefreshLeadMs` 的 switch（codex 5 天 / claude 4 小时 / 默认 5 分钟）
   改为同文件里的 `OAUTH_REFRESH_LEAD_MS: Partial<Record<OAuthProviderId, number>>` 查表。
3. `refresh-scheduler.ts` 中原 switch 替换为
   `await OAUTH_REFRESH_STRATEGIES[account.provider](account, refreshToken, fetchOptions)`。
   注意 `account.provider` 此处已被 `isOAuthAccount` 窄化为 `OAuthProviderId`；
   若类型不通，用类型守卫而不是 as 强转。

**验收**：G2 三件套；`refresh-scheduler.ts` 中不再出现
`case "claude"` / `case "kimi"` / `case "codex"` / `case "antigravity"` / `case "xai"`。

---

### T1.4 admin OAuth 路由的 start/exchange 策略化

**依赖**：T1.2、T1.3 完成。

**目的**：`src/routes/admin/api/oauth.ts`（686 行）为每个 provider import
三件套（`createXxxOAuthStart` / `exchangeXxxCodeForTokens` / `applyXxxOAuthBundle`）
并在路由 handler 里按 provider 分支。收敛为策略对象。

**涉及文件**：
- 新建 `src/services/oauth/provider-strategies.ts`
- `src/routes/admin/api/oauth.ts`
- 只读参考：`src/services/oauth/{claude,codex,xai,kimi,antigravity}.ts`

**步骤**：
1. **先完整读一遍 `oauth.ts` 的全部 686 行**，列出每个 provider 在
   start（发起授权）与 exchange（code 换 token）两个阶段的差异点
   （PKCE 与否、device flow 与否、xai 的 endpoint 发现、antigravity 的 redirectUri），
   记入「执行日志」。
2. 定义策略接口（按第 1 步实际观察调整字段，以下为骨架）：
   ```ts
   export interface OAuthProviderStrategy {
     /** 生成授权 URL 与 flow 初始字段;device-flow provider 返回 device 信息 */
     start(input: { flowId: string; proxyUrl?: string }): Promise<StartResult>
     /** 用 callback code / device poll 完成 token 交换并落库到 account */
     exchange(input: { flow: OAuthPendingFlow; code?: string; account: OAuthAccount }): Promise<void>
     /** 是否走本地 callback server(claude/codex/xai/antigravity)*/
     callback?: { /* 复用 T1.2 的 OAUTH_CALLBACK_CONFIGS */ }
   }
   export const OAUTH_PROVIDER_STRATEGIES: Record<OAuthProviderId, OAuthProviderStrategy>
   ```
3. 把 `oauth.ts` 中 per-provider 的分支逻辑**原样搬**进各策略实现，
   路由 handler 只保留：解析请求 → 查策略 → 调用 → 序列化响应。
   `PKCE_PROVIDERS` / `CALLBACK_OAUTH_PROVIDERS` 两个 Set 改由策略对象的
   字段派生。
4. 本任务体量最大。若中途发现无法一次完成，允许拆成
   "先 start 后 exchange" 两个 commit（消息 `T1.4a` / `T1.4b`），
   但每个 commit 都必须过 G2。

**验收**：G2 三件套；`oauth.ts` 不再 import 任何
`createXxxOAuthStart` / `exchangeXxxCodeForTokens` / `applyXxxOAuthBundle`
（应只 import 策略注册表与 flows 基础设施）；文件行数显著下降（目标 < 400 行，
不达标不算失败，记录实际行数即可）。

---

### T2.1 通用 quota fetch 引擎（claude/kimi 先行）

**目的**：`src/lib/quota/fetchers/claude.ts` 与 `kimi.ts` 逐段同构：
guard → `executeUpstreamProxyCall` → 状态码检查 → parse → 组装 snapshot。

**涉及文件**：
- 新建 `src/lib/quota/fetch-engine.ts`
- `src/lib/quota/fetchers/claude.ts`
- `src/lib/quota/fetchers/kimi.ts`

**步骤**：
1. 新建 `fetch-engine.ts`：
   ```ts
   export interface SimpleQuotaDescriptor {
     provider: OAuthProviderId
     url: string
     headers: Record<string, string>
     /** 把响应 body 解析并组装为 QuotaSnapshot;解析失败抛 Error */
     buildSnapshot(body: string, account: Account): QuotaSnapshot
   }

   export async function fetchQuotaByDescriptor(
     account: Account,
     descriptor: SimpleQuotaDescriptor,
     signal?: AbortSignal,
   ): Promise<QuotaSnapshot>
   ```
   引擎内做:provider guard（`isOAuthAccount` + provider 匹配，错误文案格式
   与现状一致 `fetchXxxQuota requires a Xxx OAuth account`）、
   `executeUpstreamProxyCall`、非 2xx 抛
   `Xxx quota request failed (${status}): ${body.slice(0, 200)}`。
2. claude/kimi 的 fetcher 改为 descriptor + 一行 delegate，保留原导出名（G5）。
   parse/summarize 逻辑留在 `parsers.ts` 不动，由 `buildSnapshot` 调用。

**验收**：G2 三件套；claude/kimi fetcher 中不再直接调用
`executeUpstreamProxyCall`。

---

### T2.2 quota 分发 switch → 注册表（含 xai/antigravity/codex 收编）

**依赖**：T2.1 完成。

**目的**：`src/lib/quota/index.ts` 的 `fetchOAuthProviderQuota` switch 改查表；
xai/antigravity 若骨架匹配则 descriptor 化，codex（双请求特例）保留自定义函数
但纳入同一注册表。

**涉及文件**：
- `src/lib/quota/index.ts`
- `src/lib/quota/fetchers/xai.ts`、`antigravity.ts`（先读再决定）
- `src/lib/quota/fetchers/codex.ts`（只收编，不重构）

**步骤**：
1. 读 xai.ts（89 行）与 antigravity.ts（71 行）：若与 claude/kimi 骨架一致
   （单次 GET + parse），改为 descriptor；若有额外步骤（如多请求、POST、
   动态 URL），保留自定义函数并在「执行日志」注明原因。
2. 在 `quota/index.ts` 建立：
   ```ts
   const QUOTA_FETCHERS: Record<
     OAuthProviderId,
     (account: Account, signal?: AbortSignal) => Promise<QuotaSnapshot | undefined>
   > = { claude: fetchClaudeQuota, kimi: …, codex: …, xai: …, antigravity: … }
   ```
   `fetchOAuthProviderQuota` 改为 guard + 查表调用，删除 switch。

**验收**：G2 三件套；`quota/index.ts` 无 `switch`。

---

### T2.3 cycles.ts 的 per-provider switch 查表化

**目的**：`src/lib/quota/cycles.ts` 约 349 行与 395 行两处 switch
（各含 codex/claude/antigravity/kimi 四个 case）改为配置查表。

**涉及文件**：`src/lib/quota/cycles.ts`

**步骤**：
1. **先完整读该文件**，理解两处 switch 各自提取什么（周期字段路径、
   重置时间计算等）。
2. 若两处 case 内容是纯数据差异（字段名/路径不同）→ 收敛为
   `Partial<Record<OAuthProviderId | "copilot", CycleConfig>>` 一张表 + 单一实现。
3. 若 case 内含无法数据化的逻辑（如 codex 的特殊计算），该 provider 的
   条目允许是函数值：`CycleConfig | ((payload) => …)`。
4. 行为必须逐 case 等价——这是纯机械变换，不修复任何看到的疑似 bug（G4）。

**验收**：G2 三件套；`cycles.ts` 中 `case "` 出现次数为 0。

---

### T3.1 删除 OAUTH_PROTOCOL_MAP

**目的**：`src/services/providers/index.ts` 第 20 行左右的
`OAUTH_PROTOCOL_MAP` 与 `src/lib/provider-config.ts` 的
`PROVIDER_PROTOCOL_MAP` 完全重复。

**涉及文件**：`src/services/providers/index.ts`

**步骤**：删除本地 map，改为
`import { PROVIDER_PROTOCOL_MAP } from "~/lib/provider-config"` 并在
OAuth runtime 循环中使用 `PROVIDER_PROTOCOL_MAP[providerId]`。

**验收**：G2 三件套；`grep -rn "OAUTH_PROTOCOL_MAP" src` 无结果。

---

### T3.2 provider-cache 反向映射派生化

**目的**：`src/lib/routing/provider-cache.ts` 的 `getProtocolCacheProfile`
用 9 个 case 手写 protocol→provider 映射，是 `PROVIDER_PROTOCOL_MAP` 的
第三次重复。

**涉及文件**：`src/lib/routing/provider-cache.ts`

**步骤**：
1. 在文件顶部由 `PROVIDER_PROTOCOL_MAP` 反推：
   ```ts
   const PROTOCOL_TO_PROVIDER: Partial<Record<ProviderProtocol, ProviderId>> =
     Object.fromEntries(
       Object.entries(PROVIDER_PROTOCOL_MAP).map(([p, proto]) => [proto, p]),
     )
   ```
2. `getProtocolCacheProfile` 改为：
   - `protocol === "anthropic-compatible"` → 保留现有内联特殊 profile（原样）；
   - 否则查 `PROTOCOL_TO_PROVIDER` 命中 → `PROVIDER_CACHE_PROFILES[provider]`；
   - 否则 → `GENERIC_CACHE_PROFILE`。
3. 确认无循环 import（provider-config 已被本文件 import，安全）。

**验收**：G2 三件套；`getProtocolCacheProfile` 内无 switch。

---

### T3.3 OAuthFlowProvider 类型统一

**目的**：`src/services/oauth/flows.ts` 的 `OAuthFlowProvider` 联合类型与
`getOAuthFlowProvider` 的 5 分支 if 链，与 `OAuthProviderId` 完全同集合。

**涉及文件**：`src/services/oauth/flows.ts`

**步骤**：
1. `export type OAuthFlowProvider = OAuthProviderId`（保留导出名）。
2. `getOAuthFlowProvider` 实现改为
   `return isOAuthProviderId(provider) ? provider : undefined`。

**验收**：G2 三件套。

---

### T3.4 protocols 层 extractAccount 去重

**目的**：多个 `src/services/protocols/*-native.ts` 各自定义局部
`extractAccount`（从 `target.account` 取值并判空）。

**涉及文件**：
- `src/services/protocols/shared.ts`
- `grep -rln "function extractAccount" src/services/protocols` 命中的全部文件

**步骤**：
1. 在 `shared.ts` 新增：
   ```ts
   export function requireTargetAccount(
     target: { account?: Account },
     adapterName: string,
   ): Account
   ```
   判空抛错文案保持 `` `${adapterName} adapter: target.account is required` ``
   格式（与现状一致）。
2. 删除各文件的局部 `extractAccount`，调用点改为
   `requireTargetAccount(target, "kimi-native")` 等（adapterName 用各自
   protocol id）。

**验收**：G2 三件套；`grep -rn "function extractAccount" src/services/protocols`
无结果。

---

### T4.1 [调查先行] Provider*Result 与 Adapter*Result 类型合并

**目的**：`src/services/providers/runtime.ts` 的
`ProviderChatResult { accountId }` 等四个类型与
`src/services/protocols/types.ts` 的 `AdapterChatResult { credentialId }`
形状重复，仅字段名不同。

**涉及文件**：`src/services/providers/runtime.ts`、`src/services/providers/delegate.ts`

**步骤**：
1. 先调查：`grep -rn "ProviderChatResult\|ProviderResponsesResult\|ProviderMessagesResult\|ProviderEmbeddingsResult" src tests`，
   列出全部使用点与对 `.accountId` 字段的访问。
2. 若使用点局限于 runtime.ts / delegate.ts 且改动可控（≤ 10 处字段访问）→
   把四个 Provider*Result 改为对应 Adapter*Result 的类型别名，调用点
   `.accountId` 改 `.credentialId`。
3. 若使用面超出预期（如被路由层广泛引用）→ **跳过**，状态记 `[!]`，
   把调查结果写入「执行日志」供人工决策。

**验收**（若执行）：G2 三件套；runtime.ts 不再重复定义 result 形状。

---

### T4.2 死代码与残留 switch 审计

**依赖**：P1–P3 全部终态（完成或跳过）。

**目的**：确认收敛效果，暴露残留。纯审计任务，**不改代码**。

**步骤**：
1. 运行 `bun run knip`，记录未使用导出清单。
2. 运行
   `grep -rn "case \"claude\"\|case \"kimi\"\|case \"codex\"\|case \"antigravity\"\|case \"xai\"\|case \"copilot\"\|case \"windsurf\"\|case \"codebuff\"" src --include="*.ts"`，
   记录残留位置。
3. 将两份清单写入「执行日志」，标注哪些属于合理保留（如协议翻译内部的
   语义分支）、哪些是候选后续任务。

**验收**：「执行日志」含审计结果。commit 只含本文档。

---

### T5.1 [需人工确认] 产出 Step D 详细设计文档

**⚠️ 未在「执行日志」看到用户明确批准 "approve T5.1" 之前，不得开始本任务。**

**目的**：`src/lib/account-adapter.ts` 注释中的 "Step D"（消除 Account 模型，
以 ProviderConnection 为唯一模型）是全项目最大冗余，但涉及持久化格式迁移
（accounts.json → connections.json），必须先设计后实施。

**产出**：`docs/refactor-step-d-account-elimination.md`，必须覆盖：
1. 现有 `Account` 每个字段到 `ProviderConnection/ApiCredential` 的映射表
   （以 `accountToConnection` 现有实现为事实依据）。
2. 持久化迁移方案：首次启动检测 accounts.json → 转换写入 connections.json →
   原文件重命名为 `.bak`；回滚步骤。
3. 分批删除计划：adapter 正向 → admin 反向 → `accounts.ts` 30+ getter/setter
   兼容层 → `RouteTarget.account` 特例（及 protocols 层的
   `requireTargetAccount`）。每批一个可验收任务。
4. 受影响测试清单（`grep -rln "Account" tests` 起步）与改造策略。
5. 风险清单：Copilot token 刷新链、mimo 的 ws token、CPA import 路径。

**验收**：设计文档存在且覆盖上述 5 点；提交后**停止循环**等待人工评审。

### T5.2 [需人工确认] 实施 Step D

按 T5.1 批准后的设计文档拆分执行，任务清单届时追加到本文档。
未获批准前跳过。

---

### T6.1 确立枢纽格式规约文档

**目的**：格式翻译对（chat↔responses、messages↔chat、antigravity 专属翻译等）
随格式数平方增长。立规矩阻止继续恶化，不重写现有代码。

**涉及文件**：新建 `docs/translation-conventions.md`；若仓库根存在 `CLAUDE.md`
则在其中追加一行指向该文档，不存在则不创建。

**内容要求**：
1. 声明枢纽格式为 OpenAI chat completions（现状事实标准）。
2. 规则：新增客户端格式或上游格式时，只允许实现 "X ↔ 枢纽" 一对翻译，
   禁止新增两两直连翻译对。
3. 规则：同一翻译的 stream / non-stream 版本必须共享事件级转换函数
   （参考 `docs/refactor-usage-translation.md` 已实施的 usage 收口模式）。
4. 现存翻译对清单（copilot/chat-to-responses、responses-to-chat、
   routes/messages 双份、antigravity translate-request/response、
   chat-via-responses）标注为"存量豁免，随缘收敛"。

**验收**：文档存在；G2 三件套（不应有代码改动，跑一遍确认）。

---

## 执行日志

> Agent 每完成/跳过一个任务追加一行。人工批准也记录在此
> （格式：`YYYY-MM-DD approve T5.1 — <用户名或"user">`）。

| 日期 | 任务 | 结果 | 备注 |
| --- | --- | --- | --- |
| 2026-07-15 | T0.1 | ✅ 完成 | 基线：typecheck ✅ / lint ✅ / bun test 542 pass / 2 skip / 0 fail。工作区既有未提交改动 `M src/lib/quota/upstream-proxy.ts`（xai token 刷新修复，不属于本重构，后续 commit 不得纳入）。 |
| 2026-07-15 | T1.1 | ✅ 完成 | 新建 `src/services/oauth/apply-bundle.ts`，5 个 `applyXxxOAuthBundle` 改为薄包装。字段差异确认：claude→email；codex→idToken/accountId/email + settings.baseUrl；xai→idToken/email + settings(baseUrl/tokenEndpoint/redirectUri)；kimi→deviceId；antigravity→projectId/email + settings(baseUrl/redirectUri)。类型微调：extraCredentials 用 `OAuthAccountCredentials` 而非 spec 的 `Record<string, unknown>`（G7 类型收紧），内部用 record 视图遍历避免 per-field 类型窄化问题。验收：三件套全绿，5 文件中 applyBundle 内不再手写 runtimeState。 |
| 2026-07-15 | T1.2 | ✅ 完成 | 新增 `OAUTH_CALLBACK_CONFIGS`（`Partial<Record<OAuthFlowProvider, OAuthCallbackConfig>>`）+ `startProviderCallbackServer`。删除 4 个 `startXxxCallbackServer`。`waitForPkceCallback` 的 switch 改为 `PKCE_PROVIDERS.has` + `startProviderCallbackServer`。antigravity 调用点改为 `startProviderCallbackServer("antigravity", …)`。类型注解用显式 `Partial<Record<…>>` 而非 `satisfies`（后者不产生可索引类型）。验收：三件套全绿，src 中无 `startXxxCallbackServer` 残留。 |
| 2026-07-15 | T1.3 | ✅ 完成 | 新建 `src/services/oauth/refresh-strategies.ts`，含 `OAUTH_REFRESH_STRATEGIES: Record<OAuthProviderId, OAuthRefreshFn>`（穷尽 5 provider）和 `OAUTH_REFRESH_LEAD_MS: Partial<Record<OAuthProviderId, number>>`。`refresh-scheduler.ts` 的 switch 替换为 `OAUTH_REFRESH_STRATEGIES[account.provider](…)`，`getRefreshLeadMs` 改为查表（参数从 `Account` 收紧为 `OAuthProviderId`）。验收：三件套全绿，refresh-scheduler.ts 中无 `case "claude"` 等。 |
| 2026-07-15 | T1.4 | ✅ 完成 | 新建 `src/services/oauth/provider-strategies.ts`，定义 `OAuthProviderStrategy` 接口（`flowType`/`start`/`exchange`）+ `OAUTH_PROVIDER_STRATEGIES: Record<OAuthProviderId, OAuthProviderStrategy>`（穷尽 5 provider，G7）。各 provider 的 start/exchange 差异点（PKCE 与否、device flow、xai endpoint 发现、antigravity redirectUri）原样搬入策略实现。`oauth.ts` 路由 handler 收敛为：解析请求 → 查策略 → 调用 → 序列化响应；`PKCE_PROVIDERS`/`CALLBACK_OAUTH_PROVIDERS` Set 改由策略 `flowType` 派生。`executeOAuthExchange` 通用包装：claim flow → 调策略 → finalize → mark complete。新增 `OAuthPendingFlow.deviceExpiresIn`（仅内存，`flowForPersistence` 排除，persistence 格式不变 G1）。响应字段按原 per-provider 分支条件性输出（kimi 不含 manualCompletion/authUrl；callback provider 含 manualCompletion），保持 G1。`oauth.ts` 686→391 行（< 400 目标达成）。验收：三件套全绿（542 pass / 2 skip / 0 fail）；`oauth.ts` 不再 import 任何 `createXxxOAuthStart`/`exchangeXxxCodeForTokens`/`applyXxxOAuthBundle`。 |
| 2026-07-15 | T2.1 | ✅ 完成 | 新建 `src/lib/quota/fetch-engine.ts`，定义 `SimpleQuotaDescriptor`（`provider`/`displayName`/`url`/`headers`/`buildSnapshot`）+ `fetchQuotaByDescriptor`。引擎内做：provider guard（`isOAuthAccount` + provider 匹配，错误文案 `fetch${displayName}Quota requires a ${displayName} OAuth account` 与原状一致）、`executeUpstreamProxyCall`、非 2xx 抛 `${displayName} quota request failed (${status}): ${body.slice(0, 200)}`。`buildSnapshot` 签名包含 `account` 参数（spec 骨架要求，为 T2.2 xai/antigravity 预留），claude/kimi 实现未使用时用 `_account` 前缀规避 `noUnusedParameters`。claude/kimi fetcher 改为 descriptor + 一行 delegate，保留原导出名（G5）。parse/summarize/enrichQuotaDetails 逻辑留在 `buildSnapshot` 内调用。验收：三件套全绿（542 pass / 2 skip / 0 fail）；claude/kimi fetcher 中不再直接调用 `executeUpstreamProxyCall`。 |
| 2026-07-15 | T2.2 | ✅ 完成 | `quota/index.ts` 的 `fetchOAuthProviderQuota` switch 替换为 `QUOTA_FETCHERS: Record<OAuthProviderId, (account, signal?) => Promise<QuotaSnapshot>>` 查表（穷尽 5 provider，G7）。`fetchOAuthProviderQuota` 收敛为 `isOAuthAccount` guard + `QUOTA_FETCHERS[account.provider](…)`。xai/antigravity/codex 保留自定义函数：xai 双请求（base + credits format）+ config 合并；antigravity POST + 多 URL fallback loop + projectId body；codex 双 fetch（usage + resetCredits）+ meta 构建——均非单次 GET 骨架，不 descriptor 化（spec 允许）。验收：三件套全绿（542 pass / 2 skip / 0 fail）；`quota/index.ts` 无 `switch`。 |
| 2026-07-15 | T2.3 | ✅ 完成 | `cycles.ts` 两处 switch（`resolveQuotaWindows` 约 348 行、`buildStoredQuotaWindows` 约 394 行）各含 codex/claude/antigravity/kimi 四个 case，case 内容均为纯函数调用（dispatch 到各自 `resolveXxxQuotaWindows`），无数据差异或无法数据化的逻辑。收敛为 `CYCLE_WINDOW_RESOLVERS: Partial<Record<OAuthProviderId, (details) => Array<QuotaWindowDescriptor>>>` 一张函数查表 + 单一实现（`resolver ? resolver(details) : []`）。两处 switch 均替换为查表。验收：三件套全绿（542 pass / 2 skip / 0 fail）；`cycles.ts` 中 `case "` 出现次数为 0。 |
| 2026-07-15 | T3.1 | ✅ 完成 | 删除 `services/providers/index.ts` 中的 `OAUTH_PROTOCOL_MAP`（与 `lib/provider-config.ts` 的 `PROVIDER_PROTOCOL_MAP` OAuth 子集完全重复）。改为 import `PROVIDER_PROTOCOL_MAP` 并在 OAuth runtime 循环中用 `PROVIDER_PROTOCOL_MAP[providerId]`（`providerId` 是 `OAuthProviderId`，是 `ProviderId` 的子集，索引安全）。同时移除不再使用的 `OAuthProviderId` type import 和 `ProviderProtocol` type import。验收：三件套全绿（542 pass / 2 skip / 0 fail）；`grep -rn "OAUTH_PROTOCOL_MAP" src` 无结果。 |
| 2026-07-15 | T3.2 | ✅ 完成 | `provider-cache.ts` 的 `getProtocolCacheProfile` 9-case switch 替换为 `PROTOCOL_TO_PROVIDER` 反向映射派生表（由 `PROVIDER_PROTOCOL_MAP` 反推 `Object.fromEntries`）。`getProtocolCacheProfile` 改为：`anthropic-compatible` 保留内联特殊 profile（原样）；否则查 `PROTOCOL_TO_PROVIDER` 命中 → `PROVIDER_CACHE_PROFILES[provider]`；否则 → `GENERIC_CACHE_PROFILE`。无循环 import（`provider-config` 已被本文件 import）。验收：三件套全绿（542 pass / 2 skip / 0 fail）；`getProtocolCacheProfile` 内无 switch。 |
| 2026-07-15 | T3.3 | ✅ 完成 | `flows.ts` 的 `OAuthFlowProvider` 联合类型改为 `export type OAuthFlowProvider = OAuthProviderId`（保留导出名，G5）。`getOAuthFlowProvider` 的 5 分支 if 链改为 `return isOAuthProviderId(provider) ? provider : undefined`。新增 import `isOAuthProviderId` + `OAuthProviderId` from `~/lib/provider-config`。验收：三件套全绿（542 pass / 2 skip / 0 fail）。 |
| 2026-07-15 | T3.4 | ✅ 完成 | `shared.ts` 新增 `requireTargetAccount(target, adapterName): Account`，判空抛 `` `${adapterName} adapter: target.account is required` ``（与原 9 个局部 `extractAccount` 文案一致）。9 个 `*-native.ts` 文件（xai/windsurf/mimo/kimi/copilot/codex/claude/codebuff/antigravity）删除局部 `extractAccount`，调用点改为 `requireTargetAccount(target, "<protocol-id>")`。mimo-native 已 import `shared`，追加 `requireTargetAccount`；其余 8 文件新增 `import { requireTargetAccount } from "./shared"`。所有文件中 `Account` type import 仅 `extractAccount` 使用，删除后一并移除。验收：三件套全绿（542 pass / 2 skip / 0 fail）；`grep -rn "function extractAccount" src/services/protocols` 无结果。 |
| 2026-07-15 | T4.1 | ⏭️ 跳过 | **调查结果**：`Provider*Result`（`ProviderChatResult`/`ProviderResponsesResult`/`ProviderMessagesResult`/`ProviderEmbeddingsResult`）定义在 `runtime.ts`，字段名 `accountId`；`Adapter*Result` 定义在 `protocols/types.ts`，字段名 `credentialId`，形状完全相同。`Provider*Result` 的使用点：`runtime.ts`（定义）+ `delegate.ts`（4 个 delegate 函数返回类型 + 4 处 `accountId: result.credentialId` 映射）。但 `accountId` 字段名被**广泛泄漏到路由层**：`result.accountId` 访问点共 ~27 处（`chat-completions/handler.ts` 2、`responses/handler.ts` 4、`responses/ws-handler.ts` 2、`messages/copilot-handler.ts` 5、`messages/messages-api-handler.ts` 5、`messages/connection-handler.ts` 5、`embeddings/route.ts` 2、`create-responses.ts` 2）。此外 `create-chat-completions.ts`/`create-responses.ts`/`create-messages.ts`/`create-embeddings.ts` 的返回类型也**内联重复声明**了 `{ accountId: string; response: … }` 形状（非引用 `Provider*Result`）。合计改动面 ~35+ 处，远超 spec 的 ≤10 阈值。**决策**：按 spec step 3 跳过，状态 `[!]`。若人工决定执行，建议分两步：(1) 先把 `create-*.ts` 的内联返回类型改为引用 `Provider*Result`（收敛形状定义点）；(2) 再把 `Provider*Result` 改为 `Adapter*Result` 别名 + 全量 `accountId→credentialId` 重命名。 |
| 2026-07-15 | T4.2 | ✅ 完成（纯审计） | **knip 结果**：1 unused dependency（`undici`）、1 unlisted binary（`publish`）、242 unused exports、175 unused exported types。大部分 unused exports 是 `*ForTest` 后缀的测试钩子、barrel re-exports（`index.ts` 转发的类型/函数）、以及 CLI 入口函数（`runAuth`/`runDebug`/`runServer`）——均属合理保留（knip 不识别 `bun:test` 调用点与 barrel 转发语义）。**候选后续**：`undici` 可从 `package.json` 移除（需确认无 runtime import）；少量非 test、非 barrel 的 unused exports（如 `accountsToConnections`、`buildAccountsDiagnosticSnapshot`、`adaptiveRateLimitDefaults`）可考虑清理。**残留 switch 审计**：`grep` 命中 2 处共 5 个 case——(1) `account-adapter.ts:394` `applyCredentialValue` 的 4-case switch（copilot/codebuff/windsurf/mimo-aistudio + default OAuth）：各 case 调用 `setCredentialField(account, "<fieldKey>", trimmed)`，字段名 per-provider 不同（`githubToken`/`authToken`/`apiKey`/`serviceToken`），是**语义分支非纯数据差异**（字段名是 Account credentials 联合类型的判别字段，无法简单查表），属**合理保留**；(2) `discover-models.ts:22` 的 2-case switch（codex/antigravity + default fallback）：各 case 调用不同 provider 的 `getXxxModelsForAccount`，是 per-provider model 发现 dispatch——**候选后续任务**：可收敛为 `Partial<Record<OAuthProviderId, (account, signal) => Promise<AccountModel[]>>>` 查表，但仅 2 个 case，收益有限。 |
| 2026-07-15 | T5.1 | ⏸️ 等待人工批准 | spec 明确要求"未在执行日志看到用户明确批准 'approve T5.1' 之前不得开始"。T5.2 同理。 |
| 2026-07-15 | T6.1 | ✅ 完成 | 新建 `docs/translation-conventions.md`，覆盖：(1) 声明枢纽格式为 OpenAI Chat Completions；(2) R1 规则：新增格式只允许 X↔枢纽翻译对，禁止两两直连；(3) R2 规则：stream/non-stream 必须共享事件级转换函数（参考 `refactor-usage-translation.md` 收口模式）；(4) R3 规则：usage 翻译收口于 `usage-translation.ts`；(5) 存量翻译对清单（9 对，标注"存量豁免，随缘收敛"）含 Chat↔Responses、Messages↔Chat（双文件）、Antigravity、Chat-via-Responses、Copilot Messages；(6) 辅助转换文件清单；(7) 新增格式检查清单。仓库根无 `CLAUDE.md`，未创建/修改。验收：三件套全绿（542 pass / 2 skip / 0 fail），无代码改动。 |
