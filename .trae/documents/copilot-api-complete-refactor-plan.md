# copilot-api 完整重构方案 — Account 消除 + 结构清理

## Context(背景)

架构评估发现:核心架构(Provider Connection 中心化、协议翻译层、dispatch 调度)设计良好,但存在四类问题:

1. **Account→Connection 迁移未完成**:Step D 批次 0-3 已完成(`state.accounts` 已删、`saveAccounts()` 已委托、`RouteTarget.account` 已删),但服务/适配层仍说 Account 语言、refresher 反查 account、`build.ts` 仍从 accounts 派生虚拟连接、admin API 仍是 Account 视图。每次请求存在 **3 次 Account 派生的绕路热路径**:`connection → account`(request-admission)→ `accountToConnection`(delegate)→ `connectionToAccount`(adapter)。
2. **7 个超长文件**(821-1166 行)。
3. **admin/api 目录膨胀**:20 文件,provider-presets 分散在 5 个文件(共 1875 行)且放在 routes 层。
4. **AGENTS.md 与实际脱节**:缺少 10+ 个 services/routes/lib 目录。

用户确认:全部四项均执行;Account **彻底消除**;**分阶段可合并**(每阶段测试全绿可独立提交)。

**测试基线:`bun test` → 1061 pass / 2 skip / 0 fail(115 文件)。每阶段不得低于此。**

权威规格文档:[docs/refactor-step-d-account-elimination.md](../../../work/code/copilot-refs/copilot-api/docs/refactor-step-d-account-elimination.md)(本方案 Phase 1-6 实现其剩余批次 + T5.2.5)。

---

## Phase 1 — 路由与 dispatch 层去 Account 化(风险:高)

**目标**:`buildRouteTargets`、request admission、dispatch/failover 链纯操作 `ProviderConnection`/`ApiCredential`。

1. **新建** `src/lib/provider-connections/protocol-provider.ts`:导出 `PROTOCOL_TO_PROVIDER` map + `providerFromProtocol()`(从 connection-to-account.ts L42-45 提取)+ `listAccountManagedConnections()`(`listAccounts()` 的 connection 级替代)。
2. **重写** `src/lib/route-target/build.ts`:删除 `accountToConnection` 导入、`listAccounts()` 调用、`BuildRouteTargetsOptions.accounts`、虚拟连接循环(L83-125)。所有 connection 走单一 `listProviderConnections()` 路径。**通配符语义**(D.2/D.3):target 是通配符当且仅当 `isAccountManagedConnection(conn) && conn.models === undefined`;`[]` → 跳过;非空 → 专用 target;**普通 connection `models === undefined` 仍不产生 target(保持现行为)**。模型别名:新 `buildConnectionModelAliases(conn, publicId)` 放入 model-aliases.ts(镜像 `buildAccountModelAliases` L216-226)。
3. **改** `route-target/model-reference.ts`:`parseModelReference(modelId, connection?)`;`resolveModelRouting` 默认走 connections。
4. **改** `request-admission.ts`:加 `provider: ProviderId`(经 `providerFromProtocol`);`account` 字段暂留(Phase 2e 删)。
5. **重写** `services/dispatch/failover.ts`:删 `resolveStateAccount`(L245)、Account 变更(L252-330)→ 用 `markCredentialCooldown`/`markCredentialQuotaExhausted`/`markCredentialAuthError` + `setConnectionQuotaState` + `persistProviderConnections()`。保留 Windsurf `retryAfterMs` 特例与 session 失效调用。
6. **改** `dispatch/shared.ts` L73-76、`concurrency.ts`:`ownerId: connection.id`。
7. **零散**:rate-limit.ts L241、usage.ts L20/112、stats-store.ts L284、token.ts + get-models.ts(`getActiveAccount()` → 首个启用 account-managed connection)、chat-completions/handler.ts L166-167、responses/ws-handler.ts L365-366。

**先改测试再改代码**:把 `tests/unified-routing.test.ts`、`tests/session-affinity.test.ts` 的 fixture 从 Account 换成 ProviderConnection(models 三态:undefined/[]/非空)——这是通配符语义的安全网。

**验证**:三命令绿 + `rg "accountToConnection|listAccounts" src/lib/route-target/ src/services/dispatch/` → 0;手动启动服务测通配符模型路由。

---

## Phase 2 — 热路径服务层翻转为 (connection, credential)(风险:高,拆 5 个子 PR)

**目标**:9 个 native protocol adapter 与 `create*Once` 服务函数收 `(connection, credential)`;`connectionToAccount` 从 services/ 消失;delegate 间接层删除。

- **2a Copilot**:`protocols/copilot-native.ts`(删 `connectionToAccount` ×4;`ensureCopilotToken` 改 credential 式,保留 503-非冷却保护——pitfalls D.4)、`services/copilot/create-*-once.ts`、settings.ts、responses-api.ts。
- **2b Windsurf + Codebuff**:windsurf-native.ts、codebuff-native.ts 及对应 services。
- **2c Mimo**:mimo-native.ts、services/mimo/\*。**ws token 移入 `credential.context.mimoWsToken`**(绝不动 `credential.value`,那是 serviceToken——doc §5.2)。
- **2d OAuth 热路径**:claude/kimi/codex/xai/antigravity-native.ts + 各 services。token 读取:access=`credential.value`,refreshToken/projectId/deviceId/apiKey=`credential.context`,配置经 `getConnectionSettings`/`getConnectionProxyUrl`。
- **2e Delegate 拆除**:先提取共享 payload 类型到 `src/services/copilot/payload-types.ts`(临时 re-export 保持 ~30 个导入方不破)→ 删 `services/providers/delegate.ts` + 4 个 wrapper 改直调 adapter → 删 `admission.account`,更新 routes/messages/handler.ts L92-94、embeddings/route.ts L22、responses/ws-handler.ts L711。

**Token 位置速查**:copilot token=`credential.value`、githubToken=`context.githubToken`;windsurf apiKey=`value`、jwt=`context.windsurfJwt`;OAuth access=`value`、refresh/id=`context`;mimo serviceToken=`value`、wsToken=`context.mimoWsToken`。

**测试 helper**:新建 `tests/helpers/set-connections.ts`(仿 set-accounts.ts 模式),各测试 fixture 机械替换。

**验证**:三命令绿 + `rg "connectionToAccount" src/services/` → 0 + `rg "admission\.account" src` → 0;每端点(/v1/chat/completions、/v1/messages、/v1/responses、/v1/embeddings)流式+非流式各一轮手动验证。

---

## Phase 3 — 控制路径:runtimes、refreshers、调度器、默认值(风险:高)

**目标**:token/quota/模型刷新与启动账户创建全部 connection 原生;refresher 不再反查。

1. `services/providers/runtime.ts`:`ProviderRuntime` 方法全翻转为收 connection;`AccountModel` 返回类型 → `ModelMapping`(消除 `accountModelToMapping` 往返)。
2. **新建** `services/copilot/token-refresh.ts`:`refreshCopilotTokenForConnection(connection)`——githubToken 从 `credential.context` 读,写 `credential.value` + `context.copilotTokenExpiry`;timers 以 connectionId 为键。
3. **重写** `provider-connections/refresher-impls.ts`:删 `findAccountById` 反查;copilot/oauth refresher 直调 connection 原生刷新。
4. `services/oauth/`:refresh-scheduler、ensure-access-token、apply-bundle、provider-strategies(exchange 返回 bundle,不构造 Account)、cpa-import(直接输出 ProviderConnection)、account-label 等。
5. `lib/quota/` fetchers:`(account)` → `(connection)`。
6. **重写** `provider-defaults.ts` → `ensureDirectProviderConnections()`:直接构造 ProviderConnection(label="codebuff-default" 等,按 label+protocol 查找保持 id 稳定)。
7. `lib/utils.ts`:`refreshModelsForConnection` 直接写 `conn.models`;`account-store.ts` 瘦身(刷新函数移出,保留迁移编排 + saveAccounts + shutdown flush);`start.ts` 启动循环(L208-221)改遍历 account-managed connections。

**注意**:OAuth disabled 账户必须继续刷新 token(accounts.ts L171-176 注释);`runtimeState` 保持仅内存——不要"修复"冷启动 401(pitfalls 陷阱 9)。

---

## Phase 4 — Admin API:account 端点变 connection 视图(风险:中高)

**目标**:`/admin/api/accounts*` 读写 connections;**响应 JSON 逐字节不变**(G1 冻结)。

1. **新建** `src/routes/admin/api/account-views.ts`:`publicAccountFromConnection(conn)` 产出与现 `publicAccount`(accounts.ts L94-124)完全一致的 JSON——provider 经 `providerFromProtocol`,`availableModels` 用 `connectionModelsToAccountModels`(从 connection-to-account.ts **移**过来,保留 AccountModel 形状的 DTO `AdminAccountModelView`,admin UI 依赖此形状),可用性从 `credential.status`/`cooldownUntil` 算。
2. 改 accounts.ts、account-update.ts(`applyConnectionPatchToAccount` → `applyConnectionPatchToConnection`:label→name、priority clamp 0-100、credentialValue 按协议写目标位置——copilot→`context.githubToken`,OAuth→`credential.value`+`context.accessToken`)、account-create/import.ts、oauth.ts(`finalizeOAuthAccount`→`finalizeOAuthConnection`)、quota/dashboard/usage/device-flow.ts。
3. 删 `src/lib/account-adapter.ts`(至此无导入方)。

**翻转前先写锁形测试**:`tests/admin-account-view-parity.test.ts`——固定 connection fixture → 输出与改造前捕获的 publicAccount fixture `toEqual`;加导出/导入往返测试。

**验证**:admin 面板手动走查:账户列表、配额显示、启用/禁用、优先级、模型刷新、OAuth 流程、导出文件 diff。

---

## Phase 5 — 删除 Account 运行时模型(风险:中)

**目标**:`Account` 仅作为 accounts.json 迁移边界的私有文件格式类型存在。

1. **新建** `src/lib/provider-connections/legacy-accounts/`(移动而非重写):`file-store.ts`(只读+备份改名)、`record-migrator.ts`、`to-connection.ts`、`boot-migration.ts`(account-store.ts L66-128 四规则编排)、`legacy-types.ts`(**唯一存活的 Account 形状,改名 `LegacyAccountRecord`,模块私有**)。`account-store.ts` 变 ~30 行 facade。
2. **删除**:`lib/accounts.ts`(canonicalModelId 等重导出永久落位 model-reference.ts;`QuotaSnapshot` 移入 `lib/quota/types.ts`)、`account-adapter.ts`、`account-availability.ts`、`account-selection.ts`、`account-diagnostics.ts`、`connection-to-account.ts`。
3. 测试大修:删 account-adapter.test.ts;account-store.test.ts 改写为 boot-migration 测试(首次迁移/强制重迁移/connections 优先/.bak 改名);~30 个测试文件的 `~/lib/accounts` 导入改 connection fixture。
4. **Grep 门**:`rg "state\.accounts|accountToConnection|connectionToAccount|listAccounts|getAccount\(" src` → legacy-accounts/ 之外为 0。

**真实数据演练**:拷贝生产 accounts.json 到隔离数据目录 → 启动 → 确认迁移日志、`.migrated-*.bak` 改名、admin UI 一致 → 再启动(规则 1)+ `COPILOT_API_FORCE_REMIGRATE=1`(规则 3,id 合并)。

---

## Phase 6 — Schema 定版 T5.2.5(doc 批次 5 原文执行)(风险:中,含数据迁移)

**目标**:消除 `AccountLegacyMetadata` 字段堆;provider-connections.json FILE_VERSION 1→2。

按 doc §3 批次 5:(1) types.ts 增 `credential.quota/exhaustedAt/lastRateLimitReason`、`connection.proxyUrl/modelPrefix`、`baseUrl` 填充;(2) store.ts 版本分派 + 纯函数 `upgradeConnectionV1ToV2()` + fixture 单测(v1→v2 字段移**且** metadata 键消失;幂等);(3) connection-metadata.ts readers 换内部实现(两步:保导出名→内联删纯转发);(4) writers 翻转;(5) `publicAccountFromConnection` 按晋升表派生——Phase 4 parity 测试必须仍过。

**回滚**:恢复 provider-connections.json 的 `.bak`;旧二进制把 v2 当空态安全处理。

---

## Phase 7 — 机械文件拆分(独立 PR,可与 1-6 并行)

每项均为**纯代码移动**:公开导出与行为不变,现有测试零修改通过。

| #   | 文件(行数)                              | 拆分方案                                                                                                                                               |
| --- | --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 7.1 | gemini-schema-internal.ts (1166)        | → `src/lib/gemini-schema/`:shared/repair/refs/enum-hints/constraints/unions/keywords + index.ts 桶;gemini-schema.ts 公开 API 不动                      |
| 7.2 | stats-store.ts (1125)                   | → `src/lib/stats/`:types/schema/store-core/queries/interval/pricing/config;保留 stats-store.ts 作桶(~15 导入方不变)。**顺序:Phase 1 之后**(P1 动 L284) |
| 7.3 | chat-to-responses.ts (999)              | 抽 `chat-to-responses-stream.ts`(L249-540)。**先读 pitfalls §2.1——纯移动零逻辑编辑**                                                                   |
| 7.4 | admin/api/provider-connections.ts (928) | 仿现有 `provider-connections-fetch-models.ts` 模式抽 crud/models/credentials/test                                                                      |
| 7.5 | guard.ts (849)                          | **不与 protected-route-guard.ts 合并**(职责不同:IP/UA 黑名单+滥用评分 vs 按主体限流)。内部拆 `src/lib/client-guard/` + guard.ts 桶                     |
| 7.6 | chat-completions/handler.ts (821)       | 镜像 messages/ 布局:抽 streaming/non-streaming/usage。**顺序:Phase 2e 之后**                                                                           |
| 7.7 | xai/sanitize-body.ts (881)              | → `src/services/xai/sanitize/`:reasoning/tools/schema/namespace-tools + index.ts                                                                       |

**验证**:三命令绿 + `git diff --stat` 显示移动 + 零测试文件变更。

---

## Phase 8 — admin/api 整合、注册表结论、AGENTS.md 同步(风险:低)

1. **Presets 注册表化**:6 个 provider-presets\*.ts(1875 行)从 routes 层移入 `src/lib/provider-presets/`(types/domestic-primary/domestic-secondary/others/index 含用户覆盖合并);routes 里的 provider-presets.ts 变 ~40 行薄路由。HTTP 响应形状不变。锁:admin-provider-presets.test.ts。
2. **注册表双层结论(已验证为设计而非漂移)**:`services/providers/registry.ts` 注册 **runtimes**(按账户类型的生命周期:refreshAuth/Quota/Models);`services/protocols/registry.ts` 注册 **wire adapters**(12 个:3 个 `*-compatible` + 9 个 `*-native`)。**行动:只加注释说明,不合并**。
3. **AGENTS.md 重写**:目录树补全全部缺失目录;Multi-account 章节改写为 connection API;Step D 标记完成(含 T5.2.5);"Add a new route/CLI option" 更新;gotcha 4(Token Refresh)改写;去掉"mid-refactor"警示。

---

## 依赖图

```
Phase 1 ─► Phase 2a ─► 2b ─► 2c ─► 2d ─► 2e   [热路径,线性]
    │                        │
    └──────► Phase 3(控制路径,依赖 2 的 connection 原生服务)
                │
                ▼
            Phase 4(admin API,依赖 3 的 ProviderRuntime)
                ▼
            Phase 5(Account 删除,需 1-4 全部完成)
                ▼
            Phase 6(T5.2.5 schema,严格在 5 后)

Phase 7:独立轨道,除 7.2(需 P1 后)、7.6(需 2e 后)
Phase 8:最后(AGENTS.md 记录终态)
```

## Account 消除——承重墙拆除顺序(安全网)

1. 先锁路由语义(unified-routing/session-affinity fixture 转 connection,models 三态)
2. 拆 build.ts 虚拟连接墙(account-managed connections 本就在 stateRoot.connections,虚拟路径是冗余往返)
3. 拆 failover 的 account 变更(换成已存在的 `markCredential*`/`setConnection*` API)
4. 拆 9 个 adapter 的 `connectionToAccount`(按 2a-2d)
5. 拆 delegate 间接层(先提 payload 类型)
6. 拆 refresher 反查 + account-store 刷新函数
7. 拆 Account 构造点(provider-defaults/create/import/oauth finalize)
8. 拆 admin Account 视图(parity 测试先行)
9. 才能删类型(accounts.ts 等 → legacy-accounts/ 私有 LegacyAccountRecord)
10. 最后 metadata 晋升(Phase 6)

## 禁忌清单(What NOT to do)

1. **不动协议翻译逻辑**:`services/protocols/`、`chat-to-responses`/`responses-to-chat`——pitfalls doc §2 的损失不是 bug,§3 的修复已锁;7.3 拆分必须纯移动;永远不加 messages↔responses 直连路径(hub 规则 R1)。
2. **accounts.json 永不复活**:迁移后无代码路径可写它;警惕双重写入→重迁移→覆盖循环。
3. **迁移/去重/重迁移中绝不生成新 id**:stats-store 历史以 id 为键。
4. **models 三态不可坍缩**:`undefined`(通配)/`[]`(跳过)/非空(专用)。`[]`→`undefined` 会让空 connection 吞掉所有请求。
5. **不通配/翻译标志编码进 priority**(死的 `WILDCARD_PRIORITY_BASE = 1e15` 教训)。
6. **token 存储位置不乱动**:仅 Phase 6 晋升表是 sanctioned 移动;secrets 绝不进 metadata。
7. `isAccountManagedConnection` 按协议(`*-native`)判定,绝不按 `metadata.provider`。
8. **admin JSON 形状冻结**:publicAccount 字段、导出格式 `{accounts: [...]}`。
9. **runtimeState 保持仅内存**:冷启动 401 由 lazy-refresh + 启动刷新覆盖,别"修"它。
10. **OAuth disabled 账户继续刷 token**。
11. **不删** account-file-store.ts / account-legacy-migrator.ts / migrate-from-accounts.ts——它们是首次启动透明迁移的边界。
12. **不合并 guard.ts 与 protected-route-guard.ts**。
13. 每阶段:`bun run lint:all` + `bun run typecheck` + `bun test` 全绿;无 any;`~/` 导入;params ≤3。

## 验证总结(每阶段通用)

```bash
bun test          # ≥1061 pass / 0 fail
bun run typecheck
bun run lint:all
```

阶段特定 grep 门 + 手动验证(见各 Phase);Phase 5/6 需真实数据迁移演练;Phase 4 需 admin 面板走查;Phase 2 需四端点流式/非流式手动往返。
