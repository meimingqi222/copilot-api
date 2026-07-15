# Step D：消除 Account 双模型 — 详细设计文档

状态：**待人工评审**（T5.1 产出）
创建日期：2026-07-15
关联 spec：`docs/refactor-provider-architecture.md` P5

本文档是 `account-adapter.ts` 注释中"Step D"的详细设计。目标是消除
`Account`（扁平 interface + provider-specific credentials/settings 通用 record）
与 `ProviderConnection` / `ApiCredential`（规范化连接模型）并存的双模型，
使 `ProviderConnection` 成为唯一的运行时与持久化模型。

---

## 1. 现有 Account 字段到 ProviderConnection/ApiCredential 的映射表

以 `accountToConnection`（`src/lib/account-adapter.ts:232`）现有实现为
事实依据。下表逐字段列出正向映射（Account → Connection/Credential/Metadata）
与反向写入语义（admin patch → Account 字段，由 `applyConnectionPatchToAccount`
实现）。

### 1.1 顶层 Account → ProviderConnection 字段映射

| Account 字段 | ProviderConnection 字段 | 映射方式 | 备注 |
| --- | --- | --- | --- |
| `id` | `id` | 直接复制 | 同一 id 复用 |
| `label` | `name` | 直接复制 | admin patch.label → name |
| `provider` | `protocol` | `getAccountProtocol(account)` 查 `PROVIDER_PROTOCOL_MAP` | copilot→copilot-native 等 |
| —（无对应） | `baseUrl` | 硬编码 `""` | account 路径的 baseUrl 由 settings/proxyUrl 承载，非 connection.baseUrl |
| `enabled` | `enabled` | 直接复制 | admin patch.enabled 同步 |
| `priority` | `priority` | 直接复制 | admin patch.priority（clamp 0-100） |
| —（无对应） | `weight` | 默认 `DEFAULTS.CONNECTION_WEIGHT` | Account 无 weight 概念 |
| —（无对应） | `headers` | 不设置 | Account 无 connection-level 固定 header |
| —（无对应） | `modelDiscovery` | 不设置 | Account 路径的模型发现由 `refreshModelsForAccount` 驱动 |
| `availableModels` | `models` | `account.availableModels.map(accountModelToMapping)` | undefined → undefined（通配 target 语义）；`AccountModel.id`→`publicId`，`upstreamId ?? id`→`upstreamId`，`supportedEndpoints`→`endpoints`（chat/messages/responses/embeddings/images/videos 映射） |
| `createdAt` | `createdAt` | 直接复制 | |
| —（无对应） | `updatedAt` | 不设置 | Account 无 updatedAt |
| 见 1.4 | `metadata` | `getAccountMetadata(account)` | provider-specific 字段塞入 metadata |

### 1.2 Account → ApiCredential 字段映射（单一 credential）

`accountToConnection` 始终生成**单一** credential（`credentials: [credential]`）。
`credential.id = account.id`（与 connection.id 相同）。

| Account 字段 | ApiCredential 字段 | 映射方式 | 备注 |
| --- | --- | --- | --- |
| `id` | `id` | 直接复制 | |
| —（无对应） | `label` | 不设置 | |
| —（无对应） | `authMode` | 硬编码 `"bearer"` | 所有 account-backed provider 均用 Bearer |
| —（无对应） | `headerName` | 不设置 | |
| 见 1.3 | `value` | `getAccountTokenValue(account)` | provider-specific token 字段 |
| `enabled` | `enabled` | 直接复制 | |
| —（无对应） | `priority` | 默认 `DEFAULTS.CREDENTIAL_PRIORITY` | |
| —（无对应） | `weight` | 默认 `DEFAULTS.CREDENTIAL_WEIGHT` | |
| `quotaState` + `cooldownUntil` + `runtimeState.authStatus` | `status` | `mapQuotaStateToCredentialStatus` | authStatus=error→auth_error；quotaState=exhausted→quota_exhausted；cooldownUntil>now→cooldown；否则 ready |
| `cooldownUntil` | `cooldownUntil` | 直接复制 | |
| —（无对应） | `lastRateLimitAt` | 不设置 | Account 用 `lastRateLimitAt` 顶层字段，未映射到 credential |
| —（无对应） | `lastErrorAt` | 不设置 | |
| `runtimeState.lastError`（当 authStatus=error） | `lastError` | 条件复制 | |
| `createdAt` | `createdAt` | 直接复制 | |
| —（无对应） | `updatedAt` | 不设置 | |
| 见 1.3 | `refresherType` | `getRefresherType(account)` | copilot→copilot-token；oauth→oauth-token；windsurf→windsurf-jwt；其余→static |
| 见 1.5 | `context` | `getAccountContext(account)` | 刷新源材料 |

### 1.3 `value` 与 `refresherType` 的 provider-specific 映射

`getAccountTokenValue` / `getRefresherType` 的分支逻辑：

| provider | credential.value 来源 | refresherType | admin patch.credentialValue 写入字段 |
| --- | --- | --- | --- |
| `copilot` | `runtimeState.copilotToken` | `copilot-token` | `credentials.githubToken` |
| `codebuff` | `credentials.authToken` | `static` | `credentials.authToken` |
| `windsurf` | `credentials.apiKey` | `windsurf-jwt` | `credentials.apiKey` |
| `mimo-aistudio` | `credentials.serviceToken` | `static` | `credentials.serviceToken` |
| OAuth（claude/codex/xai/kimi/antigravity） | `credentials.accessToken` | `oauth-token` | `credentials.accessToken`（admin 一般不直接改，走刷新流程） |

### 1.4 `metadata`（connection.metadata）承载的 provider-specific 字段

`getAccountMetadata` 把以下字段塞入 `connection.metadata`，供 routing/refresher/admin
序列化读取：

**所有 provider 通用：**
| Account 字段 | metadata key | 备注 |
| --- | --- | --- |
| `provider` | `provider` | admin 视图 |
| `runtimeState.authStatus` | `authStatus` | admin 视图，默认 "ready" |
| `runtimeState.lastError` | `authError` | admin 视图，默认 null |
| `exhaustedAt` | `exhaustedAt` | admin 视图 |
| `quotaState` | `quotaState` | admin 视图，默认 "unknown" |
| `quotaInfo` | `quotaInfo` | admin 视图 |
| `settings` | `settings` | 整个 settings record |

**仅 OAuth provider：**
| Account 字段 | metadata key | 备注 |
| --- | --- | --- |
| `cpaMetadata` | `cpaMetadata` | OAuth import 元数据 |
| `settings.proxyUrl` | `proxyUrl` | routing 读取 |
| `settings.modelPrefix` | `modelPrefix` | routing 读取 |
| `settings.tokenEndpoint` | `tokenEndpoint` | xai 刷新读取 |
| `settings.redirectUri` | `redirectUri` | antigravity 刷新读取 |
| `credentials.email`/`projectId`/`accountId` 派生 | `subtitle` | admin 视图，`getOAuthAccountSubtitle` |

**仅 mimo-aistudio：**
| Account 字段 | metadata key | 备注 |
| --- | --- | --- |
| `settings.proxy` | `proxy` | |
| `settings.userId` | `userId` | |

### 1.5 `context`（credential.context）承载的刷新源材料

`getAccountContext` 把刷新所需字段塞入 `credential.context`，供
`CredentialRefresher` 实现反查 `state.accounts` 并执行刷新：

**通用：** `accountId`（= account.id，用于 `findAccountById` 反查）

| provider | context 额外字段 | 备注 |
| --- | --- | --- |
| `copilot` | `githubToken`, `copilotTokenExpiry` | |
| `windsurf` | `windsurfJwt`, `windsurfJwtFetchedAt` | |
| OAuth | `accessToken`, `refreshToken`, `expiresAt`, `idToken`, `oauthAccountId`（= credentials.accountId，上游 id）, `projectId`, `deviceId`, `apiKey` | |
| 其余 | 无额外 | |

### 1.6 反向映射（admin patch → Account 写入）

`applyConnectionPatchToAccount`（`account-adapter.ts:330`）+ `parseBodyToPatch`
（`account-update.ts:36`）实现反向映射：

| Patch 字段 | Account 写入目标 | 备注 |
| --- | --- | --- |
| `label` | `account.label` | |
| `enabled` | `account.enabled` | |
| `priority` | `account.priority` | clamp 0-100 |
| `credentialValue` | provider-specific credentials 字段（见 1.3 第 4 列） | `applyCredentialValue` switch 分发 |
| `credentialExtras` | mimo: `credentials.xiaomichatbotPh` / `settings.userId` / `settings.proxy` | 仅 mimo 使用 |
| `settings` | OAuth: 白名单字段（baseUrl/proxyUrl/modelPrefix/tokenEndpoint/redirectUri）trim+clear；其余: 直接合并 | `applySettingsPatch` |

---

## 2. 持久化迁移方案

### 2.1 现状

- **accounts.json**：`Array<Record<string, unknown>>`，由 `account-file-store.ts` +
  `account-store.ts:serializeAccount` 写入。包含 credentials（含 secret）、
  settings、quotaInfo、availableModels、cooldownUntil 等。**不含 runtimeState**
  （copilotToken/windsurfJwt/authStatus 等短生命周期字段仅内存）。
- **provider-connections.json**：`{ version: 1, connections: Array<ProviderConnection> }`，
  由 `provider-connections/store.ts` 写入。包含 credential.value（secret）、
  context、metadata、models 等。
- 两者独立加载（`loadAccounts` / `initializeProviderConnections`），独立持久化
  （`saveAccounts` / `saveProviderConnections`），独立 .bak 恢复契约。

### 2.2 目标格式

迁移后 `accounts.json` 废弃，`provider-connections.json` 成为唯一持久化文件。
但需保留 account 路径特有的字段（quotaInfo、availableModels、cooldownUntil、
runtimeState 内存态等），这些字段当前不在 `ProviderConnection` 标准形状内。

**方案：扩展 `ProviderConnection.metadata` 为规范化承载区**，并定义
`metadata` 内的 account-legacy 子模式（key 前缀 `account:`）：

```ts
// provider-connections.json 中 migrated connection 的 metadata 形状
interface AccountLegacyMetadata {
  // 原 Account 顶层字段
  provider: ProviderId              // 冗余于 protocol，但保留供 admin 视图
  quotaState: AccountQuotaState
  quotaInfo?: QuotaSnapshot
  quotaExhaustedAt?: number
  exhaustedAt?: number
  cooldownUntil?: number
  lastRateLimitAt?: number
  lastRateLimitReason?: string
  availableModels?: Array<AccountModel>  // 原始形状，build.ts 仍可消费
  // runtimeState 的可持久化子集（当前 runtimeState 整体不持久化，
  // 但 copilotTokenExpiry / windsurfJwtFetchedAt 等时间戳可考虑持久化以减少冷启动刷新）
  // 决策：runtimeState 仍仅内存，不持久化（与现状一致，G1）
  // OAuth-specific
  cpaMetadata?: Record<string, unknown>
  subtitle?: string
  // provider-specific settings（原 account.settings）
  settings?: Record<string, unknown>
  // provider-specific credentials extras（非 token 字段）
  // 如 mimo 的 xiaomichatbotPh / mimoWsToken
  // OAuth 的 email / accountId / projectId / deviceId / apiKey / idToken / refreshToken
  credentialExtras?: Record<string, unknown>
}
```

**credential.context** 承载刷新源材料（与现状一致，已持久化）。
**credential.value** 承载 secret（与现状一致，已持久化）。

### 2.3 迁移触发时机

在 `loadAccounts()` / `initializeProviderConnections()` 启动序列中检测。
**核心原则：迁移后 accounts.json 永不复活**——`saveAccounts()` 内部直接
委托 `saveProviderConnections()`（见批次 1），不再写 accounts.json。这避免了
"双写复活 accounts.json → 下次启动触发重迁移 → 覆盖用户通过 admin 直接创建
的非 account 来源 connection（如 openai-compatible）"的死循环。

1. 若 `provider-connections.json` 存在且 `accounts.json` 不存在 → 已迁移，
   正常加载 connections。
2. 若 `accounts.json` 存在且 `provider-connections.json` 不存在 → **首次迁移**：
   - 逐条 `accountToConnectionForPersistence(account)` 转换（见 2.4）。
   - 合并到 `stateRoot.connections`。
   - 调用 `saveProviderConnections()` 写入 `provider-connections.json`。
   - 将 `accounts.json` 重命名为 `accounts.json.migrated-<timestamp>.bak`
     （**不删除**，供回滚）。
   - 日志记录迁移条数。
3. 若两者都存在 → **connections 优先**：
   - 正常加载 `provider-connections.json`，**忽略 accounts.json**。
   - 打警告日志：`accounts.json exists alongside provider-connections.json;
     ignoring accounts.json (already migrated). Set
     COPILOT_API_FORCE_REMIGRATE=1 to re-migrate from accounts.json.`。
   - **不使用 mtime 启发式**（备份恢复、Docker volume、rsync 等都会破坏 mtime，
     不可靠）。
   - **强制重迁移**仅在显式环境变量 `COPILOT_API_FORCE_REMIGRATE=1` 时触发，
     且必须**按 connection.id 合并**（accounts.json 迁移出的 connection 按 id
     覆盖同名 connection，其余 connection 保留），**永远不整体覆盖**
     provider-connections.json。重迁移后同样重命名 accounts.json。
4. 若都不存在 → 空状态，正常初始化。

### 2.4 迁移函数实现要点

新建 `src/lib/provider-connections/migrate-from-accounts.ts`：

```ts
export async function migrateAccountsToConnections(
  accounts: Array<Account>,
): Promise<Array<ProviderConnection>>
```

- 内部调用增强版 `accountToConnectionForPersistence(account)`，确保 `metadata`
  包含完整 `AccountLegacyMetadata`（含 `availableModels`、`quotaInfo`、
  `credentialExtras` 等当前 `accountToConnection` 未塞入的字段）。
- **不迁移 runtimeState**（copilotToken/windsurfJwt/authStatus 等短生命周期）。
  迁移后由 `scheduleOAuthRefreshForAllAccounts` / `refreshCopilotToken` 在
  启动时重新获取。这与现状一致（`loadAccounts` 也不恢复 runtimeState）。
- **保留 credential.value 中的 secret**：OAuth accessToken / refreshToken、
  copilot githubToken（注意：copilot 的 credential.value 是 runtimeState.copilotToken
  而非 githubToken，迁移后 value 为空，需在 context 中保留 githubToken，
  启动时 refreshCopilotToken 重新获取 copilotToken）。

### 2.5 反向映射器 `connectionToAccount`

新建 `src/lib/provider-connections/connection-to-account.ts`：

```ts
export function connectionToAccount(
  connection: ProviderConnection,
): Account
```

- `accountToConnectionForPersistence` 的逆函数：从 `ProviderConnection` +
  `ApiCredential` + `metadata`（含 `AccountLegacyMetadata`）反构造 `Account`。
- **过渡期承重墙**：批次 1 用它从 `stateRoot.connections` 反构造
  `state.accounts`，使 Account 保持为内存真相（见批次 1 编排理由）。
- **round-trip 测试**（批次 0 交付物）：对 5 个 provider 各构造一个
  `Account` fixture → `accountToConnectionForPersistence` →
  `connectionToAccount` → 与原 `Account` 深度相等（忽略 `runtimeState` 等
  不持久化字段）。此测试同时兜住 5.4 节的"迁移字段遗漏"风险，比逐字段
  断言更省力也更严。

### 2.6 `AccountLegacyMetadata` 类型化读取器

新建 `src/lib/provider-connections/connection-metadata.ts`：

```ts
export function readAccountLegacyMetadata(
  connection: ProviderConnection,
): AccountLegacyMetadata | undefined

// 类型安全的字段读取器（替代散装 metadata.xxx as string 强转）
export function getConnectionProvider(conn: ProviderConnection): ProviderId | undefined
export function getConnectionQuotaState(conn: ProviderConnection): AccountQuotaState
export function getConnectionQuotaInfo(conn: ProviderConnection): QuotaSnapshot | undefined
export function getConnectionCredentialExtras(conn: ProviderConnection): Record<string, unknown> | undefined
export function getConnectionSettings(conn: ProviderConnection): Record<string, unknown> | undefined
// ... 其余 AccountLegacyMetadata 字段的读取器
```

- 批次 2 删除 `accounts.ts` 30+ getter/setter 后，各调用点改为通过这些
  类型化读取器访问 `connection.metadata`，避免散装 `metadata.xxx as string`
  强转（冗余换了个形态回来）。
- 批次 0 交付此模块 + 单元测试。

### 2.7 回滚步骤

若迁移后出现问题，手动回滚：

1. 停止服务。
2. 删除或重命名 `provider-connections.json`（及 `.bak`）。
3. 将 `accounts.json.migrated-<timestamp>.bak` 重命名回 `accounts.json`。
4. 重启服务 → 检测到 accounts.json 存在、provider-connections.json 不存在 →
   重新迁移（或回滚到迁移前版本的二进制）。

**自动回滚**（可选，T5.2 实施时决定）：若迁移后首次 `bun test` 或启动
健康检查失败，自动恢复 accounts.json。但自动回滚风险高于手动，建议仅
提供手动回滚文档。

### 2.8 测试隔离兼容

`tests/setup/isolate-data-dir.ts`（bunfig preload）将 PATHS 重定向到临时目录。
迁移逻辑需在测试隔离下正常工作：
- `assertWritableDataPath` 在测试期间拒绝写入生产路径 → 迁移写入
  `provider-connections.json` 时需走 `assertWritableDataPath` 检查（与现状
  `saveProviderConnections` 一致）。
- 现有 `account-file-store.ts` 的 `.bak` 恢复逻辑在测试期间跳过生产路径写入
  （`isTestDataIsolationEnabled` 分支）→ 迁移的 accounts.json 重命名也需
  遵循此契约。

---

## 3. 分批删除计划

每批一个可验收任务（后续追加到 `refactor-provider-architecture.md` 任务清单）。
**每批必须过 G2 三件套**（typecheck / lint / bun test ≥ 542 pass / 0 fail）。
**G1 行为不变**：HTTP 接口、SSE 输出、日志格式保持不变
（持久化格式在批次 1 允许变更）。

> **文件清单说明**：以下各批次点名的文件仅是**起点**，不是穷尽清单。
> 实施时必须以 `grep -rln "saveAccounts\|state\.accounts\|accountToConnection
> \|target\.account\|requireTargetAccount" src` 的**实时结果**为准，
> 逐文件改造直到 grep 无结果。

### 批次 0：迁移基础设施（无行为变更）

**任务 T5.2.0**：新建迁移函数 + 反向映射器 + 类型化读取器 + round-trip 测试

- 新建 `src/lib/provider-connections/migrate-from-accounts.ts`，实现
  `migrateAccountsToConnections` + `accountToConnectionForPersistence`（见 2.4）。
- 新建 `src/lib/provider-connections/connection-to-account.ts`，实现
  `connectionToAccount`（见 2.5）。
- 新建 `src/lib/provider-connections/connection-metadata.ts`，实现
  `AccountLegacyMetadata` 类型 + 类型化读取器（见 2.6）。
- 不接入启动序列，不改变任何运行时行为。
- 新增测试 `tests/migrate-accounts-to-connections.test.ts`：
  - **round-trip 测试**（核心）：对 5 个 provider 各构造一个 `Account` fixture →
    `accountToConnectionForPersistence` → `connectionToAccount` → 与原 `Account`
    深度相等（忽略 `runtimeState` 等不持久化字段）。此测试同时兜住字段遗漏风险。
  - metadata 完整性断言：`AccountLegacyMetadata` 所有字段均存在且类型正确。
- **验收**：G2 三件套；round-trip 测试通过。

### 批次 1：纯持久化格式换底（Account 保持内存真相）

**任务 T5.2.1**：启动序列接入迁移 + `saveAccounts` 委托 `saveProviderConnections`

**编排理由**：批次 1–2 期间内存真相保持 `Account` 不变。现有代码是就地
mutate `Account` 对象再 `saveAccounts()` 的，refresh 定时器还长期持有旧
`Account` 对象引用（`state.accounts` 在 27 个文件里有 101 处引用，含
`dispatch/failover.ts` 热路径、`mimo/connections.ts`、refresh 定时器）。
若批次 1 就把 `state.accounts` 变成派生视图，这些引用会全部失效或丢失写入
（split-brain）。因此批次 1 只换持久化格式，内存模型不动。

- 修改启动序列（`src/start.ts` 或 `src/lib/account-store.ts:initAccounts`）：
  - 先 `loadProviderConnections()`。
  - 按 2.3 的 4 条规则检测：首次迁移 / connections 优先 / 强制重迁移 / 空状态。
  - 若首次迁移：`migrateAccountsToConnections` + `saveProviderConnections` +
    重命名 accounts.json。
  - 加载 connections 后，用 `connectionToAccount` 反构造 `state.accounts`
    （Account 保持为内存真相，runtime 继续读 `state.accounts`）。
- `saveAccounts()` 内部改为委托 `saveProviderConnections()`：
  - 将 `state.accounts` 通过 `accountToConnectionForPersistence` 正向映射为
    connections，**合并**到 `stateRoot.connections`（按 id 覆盖 account 来源的
    connection，保留非 account 来源的 connection），再 `persistProviderConnections()`。
  - **不再写 accounts.json**（accounts.json 永不复活，见 2.3 核心原则）。
- admin 继续走现有 `applyConnectionPatchToAccount` 路径（不变）。
- `state.activeAccountIndex` 继续维护（不变）。
- **验收**：G2 三件套；新增集成测试：写入 accounts.json → 启动 → 验证
  provider-connections.json 生成 + accounts.json 重命名 + `state.accounts`
  从 connections 反构造正确。验证非 account 来源的 connection 不被覆盖。

### 批次 2：内存模型翻转（admin 直写 connections + state.accounts 删除 + getter/setter 删除）

**任务 T5.2.2**：消除 `state.accounts`，所有读写改为操作 `stateRoot.connections`

此批次合并了原设计的"admin 直写"与"getter/setter 删除"两步，确保任何时刻
只有一个内存真相。**体量最大**，允许拆成子 commit（T5.2.2a/b/c/d...），
每个过 G2。

- `state.accounts` 字段删除。所有 `state.accounts.find` / `state.accounts.map`
  调用点改为 `listProviderConnections()` + connection 查询。
- `state.activeAccountIndex` 删除（account 路径用 priority 排序，connection
  路径用 `selectRouteTarget`，activeAccountIndex 仅 legacy 单账户模式残留）。
- `src/lib/accounts.ts` 的 getter/setter（`getGitHubToken` / `setCopilotToken` /
  `getOAuthAccessToken` / `setOAuthCredentials` / `getMimoWsToken` / ... 共 30+）
  删除，调用点改为通过 `connection-metadata.ts` 的类型化读取器访问
  `connection.metadata` / `credential.context` / `credential.value`。
- `src/lib/account-adapter.ts` 删除（`accountToConnection` /
  `applyConnectionPatchToAccount` / `accountsToConnections`）。
- `src/lib/account-store.ts` 的 `serializeAccount` / `migrateAccount` /
  `refreshCopilotToken` / `refreshQuotaForAccount` 改为操作 connection。
- `src/lib/account-availability.ts` 的 account 可用性函数改为
  `refreshCredentialAvailability`（已存在于 provider-connections/availability.ts）。
- `src/lib/account-selection.ts` 的 `getActiveAccount` / `switchToNextAccount`
  删除（被 `selectRouteTarget` + `switchToNextRouteTarget` 取代）。
- admin account CRUD 路由改为操作 `stateRoot.connections`：
  - `src/routes/admin/api/accounts.ts`：list/get/delete/update/priority/export
    改为从 `listProviderConnections()` 读取，用 `publicAccount`（从 connection
    派生）序列化。
  - `src/routes/admin/api/account-create.ts`：创建改为 `createConnection` +
    `addCredential`。
  - `src/routes/admin/api/account-update.ts`：`applyConnectionPatchToAccount`
    改为 `applyConnectionPatchToConnection`（直接写 connection/credential
    字段）。
  - `src/routes/admin/api/account-import.ts` / `cpa-import.ts`：import 改为
    创建 connection。
  - `src/routes/admin/api/oauth.ts`：`finalizeOAuthAccount` 改为创建 connection。
  - `src/routes/admin/api/quota.ts`：quota refresh 改为操作 connection.metadata。
- **验收**：G2 三件套；`grep -rn "state\.accounts" src` 无结果；
  `grep -rn "accountToConnection" src` 无结果；
  admin API 行为不变（响应 JSON 形状不变）。

### 批次 3：`RouteTarget.account` 特例删除

**任务 T5.2.3**：删除 `RouteTarget.account` 字段 + protocols 层
`requireTargetAccount`

- `src/lib/provider-connections/types.ts`：`RouteTarget.account` 字段删除。
- `src/lib/route-target/build.ts`：删除 account-backed 虚拟 connection 分支
  （所有 `if (account)` 分支），统一走 connection 路径。
- `src/lib/request-admission.ts`：`target.account` 分支删除，
  `resolveConnectionFromTarget` 统一走 `getProviderConnection`。
- `src/services/providers/delegate.ts`：`buildAccountTarget` /
  `buildVirtualConnectionParts` 删除，delegate 函数改为接收 `RouteTarget` +
  从 `stateRoot.connections` 查 connection/credential。
- `src/services/protocols/shared.ts`：`requireTargetAccount` 删除，
  protocol adapter 改为从 `target.connectionId` 查 connection，从
  `target.credentialId` 查 credential（adapter 签名已接收 connection/credential，
  仅需删除 `target.account` 回退路径）。
- 9 个 `*-native.ts` protocol adapter 中的 `requireTargetAccount` 调用改为
  使用 adapter 入参的 `connection` / `credential`（已传入，仅需删除 account
  回退）。
- **验收**：G2 三件套；`grep -rn "target\.account" src` 无结果；
  `grep -rn "requireTargetAccount" src` 无结果。

### 批次 4：清理与文档

**任务 T5.2.4**：删除 `account-store.ts` / `account-file-store.ts` /
`account-adapter.ts` / `account-availability.ts` / `account-selection.ts` /
`account-diagnostics.ts` 等已无引用的文件；更新 `AGENTS.md` 的代码组织章节；
更新 `docs/refactor-provider-architecture.md` 标记 P5 完成。

- **验收**：G2 三件套；`bun run knip` 无新增 unused exports；
  `grep -rn "Account" src/lib/accounts.ts` 文件已删除或仅剩类型别名。

---

## 4. 受影响测试清单与改造策略

`grep -rln "Account" tests` 命中 29 个测试文件。按改造策略分组：

### 4.1 直接构造 Account fixture 的测试（需改为构造 ProviderConnection）

| 测试文件 | Account 用途 | 改造策略 |
| --- | --- | --- |
| `tests/account-adapter.test.ts` (70 matches) | 测试 `accountToConnection` / `applyConnectionPatchToAccount` | **批次 2 后删除**（被测函数已删除）；或改为测试 `connectionToAccount` / `applyConnectionPatchToConnection` 的等价语义 |
| `tests/account-store.test.ts` (43 matches) | 测试 `loadAccounts` / `saveAccounts` / `serializeAccount` / `migrateAccount` | **批次 1/2 改造**：迁移测试改为验证 accounts.json→connections.json 迁移；持久化测试改为 `saveProviderConnections` |
| `tests/account-file-store.test.ts` (20 matches) | 测试 `tryReadAccountsFile` / `writeAccountsFile` / .bak 恢复 | **批次 4 后删除**（文件已删除）；迁移测试中保留 1-2 个验证迁移源文件读取的用例 |
| `tests/account-update.test.ts` (10 matches) | 测试 `parseBodyToPatch` / `updateProviderAccount` | **批次 2 改造**：改为测试 connection 直写的 patch 解析 |
| `tests/provider-defaults.test.ts` (2 matches) | 测试 managed default account 创建 | **批次 2 改造**：改为测试 managed default connection 创建 |

### 4.2 通过 state.accounts 间接使用 Account 的测试

| 测试文件 | 改造策略 |
| --- | --- |
| `tests/unified-routing.test.ts` (17 matches) | **批次 2/3 改造**：`buildRouteTargets` 入参从 accounts 改为 connections |
| `tests/oauth-*.test.ts`（8 个文件，共 ~90 matches） | **批次 2 改造**：OAuth flow 测试的 `finalizeOAuthAccount` 改为创建 connection；`state.accounts.find` 改为 `getProviderConnection` |
| `tests/admin-*.test.ts`（3 个文件，共 ~30 matches） | **批次 2 改造**：admin API 测试改为验证 connection CRUD |
| `tests/cpa-import.test.ts` (10 matches) | **批次 2 改造**：import 改为创建 connection |
| `tests/dispatch.test.ts` (4 matches) | **批次 3 改造**：dispatch 测试的 `target.account` 改为纯 connection target |
| `tests/responses-route.test.ts` / `messages-route.test.ts` / `create-chat-completions.test.ts` / `create-embeddings.test.ts` | **批次 3 改造**：route 测试的 fixture 从 Account 改为 ProviderConnection |
| `tests/data-dir-isolation.test.ts` (9 matches) | **批次 1 改造**：验证迁移在测试隔离下正确工作 |
| `tests/upstream-ws.test.ts` / `responses-ws-route.test.ts` | **批次 3 改造**：ws 测试的 account fixture 改为 connection |
| `tests/quota-cycle-usage.test.ts` (12 matches) | **批次 2 改造**：quota cycle 测试从 account.quotaInfo 改为 connection.metadata.quotaInfo |
| `tests/usage-model-id.test.ts` / `admin-usage-summary.test.ts` / `admin-performance.test.ts` | **批次 2 改造**：usage 测试的 account 引用改为 connection |
| `tests/provider-registry.test.ts` (8 matches) | **批次 2 改造**：provider registry 测试的 account fixture 改为 connection |
| `tests/windsurf-models.test.ts` (2 matches) | **批次 2 改造**：windsurf model 测试 |
| `tests/oauth-ensure-access-token.test.ts` (5 matches) | **批次 2 改造**：`ensureOAuthAccessToken` 改为从 credential.value + context 读取 |
| `tests/oauth-refresh-proxy.test.ts` (7 matches) | **批次 2 改造**：refresh proxy 测试 |

### 4.3 改造策略总结

1. **fixture 替换**：所有 `makeCopilotAccount` / `makeOAuthAccount` 等 fixture
   工厂改为 `makeCopilotConnection` / `makeOAuthConnection`，形状为
   `ProviderConnection` + 单一 `ApiCredential`。
2. **state 断言替换**：`state.accounts.find(...)` 改为
   `getProviderConnection(...)` / `findCredential(...)`。
3. **迁移测试新增**：`tests/migrate-accounts-to-connections.test.ts` 覆盖
   5 provider 的 Account→Connection 转换 + metadata 完整性。
4. **删除的测试**：`account-adapter.test.ts` / `account-file-store.test.ts`
   在对应批次后删除（被测代码已不存在）。
5. **测试期望值不变**（G2）：所有测试的断言逻辑保持不变，仅 fixture 形状
   与 state 访问路径变更。

---

## 5. 风险清单

### 5.1 Copilot token 刷新链

**风险**：`refreshCopilotToken`（`account-store.ts:283`）深度集成
`state.accounts` + `tokenRefreshTimers` + `runtimeState.copilotToken`。
迁移后 `state.accounts` 消失，copilotToken 需存入 `credential.value`，
copilotTokenExpiry 存入 `credential.context`。

**缓解**：
- `refresher-impls.ts` 的 `copilotRefresher` 已实现从 `credential.context`
  反查 account（`findAccountById`）并刷新。批次 2 改造时将 `findAccountById`
  改为 `findCredentialById` / `findConnectionById`，直接写
  `credential.value` + `credential.context.copilotTokenExpiry`。
- `tokenRefreshTimers`（`account-store.ts:47`）改为以 `credentialId` 为 key，
  或迁移到 `provider-connections/` 模块。
- **冷启动**：迁移后 copilot connection 的 `credential.value` 为空
  （copilotToken 不持久化），需在启动时立即触发 `refreshCopilotToken`。
  现状 `loadAccounts` 后也会重新 schedule refresh，行为一致。

### 5.2 mimo 的 ws token

**风险**：`mimoWsToken`（`accounts.ts:369`）存储在
`account.credentials.mimoWsToken`，由 `services/mimo/connections.ts` 读写。
迁移后需存入 `credential.context.mimoWsToken` 或 `credential.value`（注意
`credential.value` 是 serviceToken，不是 wsToken）。

**缓解**：
- `mimoWsToken` 放入 `credential.context.mimoWsToken`（context 已持久化）。
- `getMimoWsTokenForAccount` / `getOrCreateAccountWsToken` /
  `isValidMimoWsTokenForAccount` 改为从 `findCredential(connectionId)`
  读取 `credential.context.mimoWsToken`。
- `setMimoWsToken` 改为写 `credential.context.mimoWsToken` +
  `persistProviderConnections()`（替代 `saveAccounts()`）。
- **测试**：`tests/upstream-ws.test.ts` 需验证 ws token 读写路径。

### 5.3 CPA import 路径

**风险**：`services/oauth/cpa-import.ts` 的 `mapCpaRecordToAccount` +
`importCpaAuthRecords` 直接构造 `OAuthAccount` 并 `addAccount`。
迁移后需改为构造 `ProviderConnection` + `ApiCredential` 并 `createConnection`。

**缓解**：
- 新建 `mapCpaRecordToConnection`，输出 `ProviderConnection` 形状。
- `importCpaAuthRecords` 改为调用 `createConnection` + `addCredential`。
- `removeDuplicateAccount` 改为 `removeDuplicateConnection`（按 label+protocol
  去重）。
- `cpaMetadata` 存入 `connection.metadata.cpaMetadata`（现状已如此）。
- **测试**：`tests/cpa-import.test.ts` 改造为验证 connection 创建。

### 5.4 持久化迁移的数据完整性

**风险**：`accounts.json` 中 OAuth credentials 含 accessToken/refreshToken/
idToken/expiresAt/accountId/projectId/deviceId/apiKey/email 等多字段。
当前 `accountToConnection` 只把 accessToken 放入 `credential.value`，其余
放入 `credential.context`。迁移时需确保**所有字段**都进入 connection 形状
（value/context/metadata），无遗漏。

**缓解**：
- 批次 0 的 `accountToConnectionForPersistence` 需逐字段对照
  `serializeAccount`（`account-store.ts:189`）的输出，确保 credentials/
  settings/cpaMetadata/availableModels/quotaInfo 全部映射。
- 批次 0 的单元测试覆盖 5 provider 的完整字段断言。
- 迁移后 `accounts.json.migrated-*.bak` 保留，可手动核对。

### 5.5 `activeAccountIndex` 删除的影响

**风险**：`state.activeAccountIndex` 被 `account-selection.ts` /
`account-store.ts` / `oauth.ts` / `account-import.ts` / `cpa-import.ts` 等
多处维护。删除后 legacy 单账户模式的"活跃账户"概念消失。

**缓解**：
- 现状 `selectRouteTarget` 已基于 priority + weight 选择，不依赖
  `activeAccountIndex`。`activeAccountIndex` 仅在 `getActiveAccount`
  （legacy 路径）使用。
- 批次 2 删除 `activeAccountIndex` 时，需确认所有调用点已迁移到
  `selectRouteTarget` 路径。`getActiveAccount` / `switchToNextAccount`
  若仍有调用点（如 `src/start.ts:199` 的启动日志），改为从
  `listProviderConnections()` 派生。

### 5.6 admin API 响应形状不变（G1）

**风险**：`publicAccount`（`accounts.ts:104`）的输出形状被 admin UI 依赖。
迁移后需从 connection 派生等价的 `publicAccount` 响应。

**缓解**：
- 新建 `publicConnection`（或 `publicAccountFromConnection`），从
  `ProviderConnection` + `ApiCredential` + `metadata` 派生与现有
  `publicAccount` **字段完全一致**的 JSON。
- 批次 2 的测试需断言 admin API 响应 JSON 深度相等。

### 5.7 测试隔离与生产数据安全

**风险**：迁移在测试隔离下重命名 `accounts.json` 可能触发
`assertWritableDataPath` 拒绝。生产环境迁移若失败可能丢失 accounts.json。

**缓解**：
- 迁移逻辑遵循 `assertWritableDataPath` 契约（与 `writeAccountsFile` 一致）。
- 生产迁移先复制 accounts.json 到 `.migrated-*.bak`，再写入
  provider-connections.json，最后才重命名 accounts.json → 顺序保证可回滚。
- 测试隔离下不触发生产路径写入（`isTestDataIsolationEnabled` 分支）。

### 5.8 `runtimeState` 不持久化的冷启动影响

**风险**：迁移后 `runtimeState`（copilotToken/windsurfJwt/authStatus）仍仅
内存。冷启动时所有 OAuth/Copilot 账户的 authStatus 重置为 ready，
copilotToken/windsurfJwt 为空，需立即刷新。

**缓解**：
- 现状 `loadAccounts` 后 `scheduleOAuthRefreshForAllAccounts` 已处理 OAuth。
- Copilot 需在迁移后立即 `refreshCopilotToken`（现状 `loadAccounts` 后
  也需如此，但当前 `initAccounts` 未自动触发——这是**现有行为**，迁移不改变）。
- 若迁移后发现冷启动 401 增加，可在批次 1 中加入"迁移后立即触发
  refreshCopilotToken for all copilot connections"的启动钩子。

### 5.9 stats-store 的 accountId 关联约束

**风险**：`stats-store.ts` 的 SQLite 统计按 `accountId` 记历史用量。
设计 1.1 说"同一 id 复用"，这保住了历史统计的关联。但若迁移/去重逻辑
在 CPA 去重或冲突合并时随手 `randomUUID()` 生成新 id，历史用量/统计
会断链。

**缓解**：
- 迁移函数 `accountToConnectionForPersistence` 必须原样保留 `account.id`
  作为 `connection.id` + `credential.id`，**绝不生成新 id**。
- CPA import 的 `removeDuplicateAccount`（改为 `removeDuplicateConnection`
  后）去重时，若发现已有同 label+protocol 的 connection，应**复用已有 id**
  而非创建新 id（与现状 `removeDuplicateAccount` 行为一致）。
- 2.3 规则 3 的强制重迁移（`COPILOT_API_FORCE_REMIGRATE=1`）按 id 合并时，
  accounts.json 迁移出的 connection 必须按 id 匹配已有 connection，
  **不生成新 id**。
- 批次 0 的 round-trip 测试需断言 `connection.id === account.id`。

---

## 附录 A：`accountToConnectionForPersistence` 与 `accountToConnection` 的差异

`accountToConnection`（现状）为 routing/admin 视图生成 connection，部分字段
未塞入 metadata（如 `availableModels` 用 `accountModelToMapping` 转换为
`ModelMapping[]`，但原始 `AccountModel` 形状未保留）。

`accountToConnectionForPersistence`（新增）需额外保留：
- `metadata.availableModels`：原始 `Array<AccountModel>`（供 `build.ts`
  的 `matchesAccountModel` 别名匹配，或批次 4 后改为 `ModelMapping` 匹配）。
- `metadata.quotaInfo`：完整 `QuotaSnapshot`。
- `metadata.quotaExhaustedAt` / `exhaustedAt` / `lastRateLimitAt` /
  `lastRateLimitReason`。
- `metadata.credentialExtras`：OAuth 的 email/accountId/projectId/deviceId/
  apiKey/idToken/refreshToken（非 token 的 credentials 字段）；mimo 的
  xiaomichatbotPh/mimoWsToken。
- `metadata.settings`：完整 settings record（已在现状中）。

**决策（已确认）**：`availableModels` 在迁移后直接用 `connection.models`
（`ModelMapping[]`）替代，**删除 `metadata.availableModels`**。理由：否则
metadata 里又养出一个平行模型副本，Step D 就白做了。`build.ts` 的
`matchesAccountModel` 需改为 `matchesPublicModelId`（批次 3 一并处理）。
`accountToConnectionForPersistence` 仍需把 `account.availableModels` 转换为
`connection.models`（与现状 `accountToConnection` 的 `accountModelToMapping`
逻辑一致），但不再在 metadata 里保留原始 `Array<AccountModel>`。

---

## 附录 B：执行顺序与依赖图

```
T5.2.0 (迁移基础设施 + 反向映射器 + 类型化读取器 + round-trip 测试)
  └─> T5.2.1 (纯持久化格式换底：Account 保持内存真相)
        └─> T5.2.2 (内存模型翻转：admin 直写 + state.accounts 删除 + getter/setter 删除) [可拆 a/b/c/d]
              └─> T5.2.3 (RouteTarget.account 删除)
                    └─> T5.2.4 (清理与文档)
```

每个批次依赖前一批次完成。批次 2 体量最大（合并了原设计的"admin 直写"
与"getter/setter 删除"两步），允许拆分为多个子 commit。
**每个 commit 必须过 G2 三件套**。

---

## 附录 C：验收基线

- **基线**（T0.1 记录）：`bun test` 542 pass / 2 skip / 0 fail。
- **每个批次**：`bun test` 不得低于 542 pass / 0 fail（新增测试允许 pass 数
  增加，但不得减少现有 pass 数或新增 fail）。
- **最终**（T5.2.4 后）：`grep -rn "state\.accounts" src` 无结果；
  `grep -rn "accountToConnection" src` 无结果；
  `grep -rn "target\.account" src` 无结果；
  `grep -rn "requireTargetAccount" src` 无结果；
  `accounts.json` 不再被任何代码读写（仅迁移源读取）。
