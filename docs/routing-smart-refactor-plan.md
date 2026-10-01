# 路由重构方案：额度感知选优、失败语义退避与缓存感知亲和

状态：**Phase 1–5 已实施（6 待定）**
日期：2026-09-30
目标：把「按额度与失败语义做路由决策」的能力引入现有 RouteTarget 架构，同时保持现有配额探测、连接/凭据模型与管理面不变。

## 0. 背景与决策摘要

对照本仓库 `lib/route-target/*`、`lib/request-admission.ts`、`services/dispatch/failover.ts`、`lib/rate-limit.ts`、`lib/routing/session-affinity.ts` 的逐项审计，三个真实差距：

1. **选优不看额度**。`selectRouteTarget` 只按「专用>通配 → 原生>翻译 → connectionPriority → fill-first/round-robin」排序；`quota_exhausted` 只是准入期的可用性过滤，不参与排序。结果是单连接「打到耗尽才换」。理想的选优应按 allowance 使用率分档（fine / low≥90% / spent）、按重置时间最早优先，把即将作废的额度先用掉。
2. **退避不分档、不读真实重置时间**。429 统一走 `rate-limit.ts` 的指数退避（base 1s / 上限 60s，Windsurf 特例 4h）；`classifyUpstreamError` 已分 `quota_exhausted / rate_limited / auth_error / server_error / client_error / network_error` 并写到 `credential.cooldownUntil`，但时长不区分语义：欠费 30 分钟与瞬时限流 1 分钟用了同一档。应改为按失败语义分档（credit 30m、quota 读 `resets_at` 上限 8d、rate 读 `Retry-After`、verify 30m、refused/canceled 立即换下一个），并把每个候选的休息时长写进 trace。
3. **亲和是盲绑定**。`session-affinity.ts` 只做 `sessionId → connection::credential` 的 TTL 绑定，理想行为是根据上一次应答的 `cacheRead` 是否值得（≥1024 tokens）且缓存未冷（≤5min）来决定跨 turn 是否粘住——为命中上游 prompt cache 省钱。

**已修正的两个误判**（避免方案建立在错误前提上）：完整 IR 翻译层与「上游拒绝某字段/端点就记住不再发」的适配学习（`markUnfit`、`forwardTranslated`）本来就有，并非 passthrough；我们也有上游感知的 session 提取（`routing/provider-cache.ts` 的 claude/codex/windsurf 等策略），只是没有「按 cacheRead 决定粘多久」。

**决策**：不改连接/凭据模型与现有的五层候选池语义，把这三个机制作为**可选策略**接入既有点位：

- `state.routing.strategy` 新增 `"quota"`（smart）与 `"least-used"`；
- 冷却写入路径新增按失败语义的时长表 + 真实重置时间解析；
- 亲和新增「缓存命中驱动」的可选模式；
- trace 的 `candidates` 从「结果摘要」升级为「排序证据」，让请求追踪页能说明「为什么是这条，而不是那条」。

## 1. 原则

1. **决策快路径零 I/O**：`selectRouteTarget` 在 admission 阶段、上游请求之前调用（guard 依赖它的 provider 判断），排序只能读内存中已就绪的数据（quota 快照、recent-serve 计数）。所有外部数据一律由 `lib/quota` 调度器异步预取。
2. **证据与决策同生**：路由依据（配额档位、重置时间、近期 served tokens、为何被跳过）在 `buildRouteTargets`/`selectRouteTarget` 产出目标时一并生成，直接进 `entry.candidates`，而不是事后二次计算。trace 就是决策时顺手记的。
3. **默认行为不变**：fill-first 保持默认（订阅类账号的 prompt cache 友好），smart/least-used/新退避表均为显式开关或候选 `opt-in`；改动粒度到「策略函数 + 分类函数」，不重写 failover 循环。
4. **失败分级而非失败即弃**：同语义同档休息；rest 理由与时长写入 trace，而不是只记 `failoverCount` 数字。

## 2. 现状基线

- **候选构建**：`buildRouteTargets()`（`lib/route-target/build.ts`）展平 `connection × credential × model`，可选 `onlyAvailable`；`selectRouteTarget()`（`select.ts`）分层过滤（dedicated > wildcard → native > translated → connectionPriority）后按 `state.routing.strategy` 取 fill-first 或 weighted round-robin，叠加 `session-affinity` 绑定；failover 用 `exclude: Set<targetKey>` + `switchToNextRouteTarget` 取下一候选。
- **配额**：`lib/quota/` 每 provider 有 fetcher（copilot/claude/codex/commandcode/qoder/windsurf/xai 等 15 个），写 `credential.quota: QuotaSnapshot`（`fetchedAt`、`premiumInteractions*`、`chat*`、`completions*`、`unlimited`、`details`）；`refreshQuotaForConnection` 周期刷新。**当前未被 select 消费**。
- **退避**：`rate-limit.ts` 的 token-bucket pacing + `consecutive429Count` 指数退避，`reportUpstreamRateLimit(Ms)` 写 `cooldownUntilMs`（上限 60s；Windsurf 上限 4h）；`classifyUpstreamError`（`availability.ts`）已从 status/headers/body 分类出 `quota_exhausted` 等并提取 `retryAfterMs`/`usageLimitRetryMs`，写入 `credential.cooldownUntil`。
- **亲和**：`session-affinity.ts` 的 `affinityCacheKey(sessionId, modelId, protocol)` → `authKey(connectionId::credentialId)` TTL 绑定；`provider-cache.ts` 定义各上游的 session 提取策略。无按缓存命中决定粘性的机制。
- **观测**：`entry.candidates`（本仓库刚加的 `RouteCandidate[]`）目前只记录「最终状态」（chosen / available / translated / wildcard / cooldown / quota / auth / disabled），没有排序依据；`trace-bus.ts` 已支持 start/update/final 三态。

## 3. 设计

### 3.1 统一的「路由证据」模型

新增 `lib/route-target/evidence.ts`，给每个 `RouteTarget` 产出一份排序证据（在 build 时生成、select 时补充）：

```ts
interface RouteEvidence {
  quota?: {
    usedFraction: number // 0..1，来自 credential.quota；未知为 undefined
    renewsAtMs: Array<number> // 各配额窗口的重置时间，取自大窗口
    staleMs: number // 快照年龄；过老只降级，不假淘汰
  }
  servedTokens: number // 该 (connectionId, credentialId) 近期 served（半衰期衰减）
  rest?: { reason: RestReason; untilMs: number } // 正在休息的语义与时长
  unfitFields?: Array<string> // 上游已拒绝过的字段/端点
}
```

- `servedTokens`：新增 `lib/route-target/recent-serve.ts`，每次 `recordUpstreamAttempt` 成功时在 `(connectionId, credentialId)` 上累计 `completionTokens`，按 `usageHalfLife = 1h` 指数衰减。只在进程内存，不写盘。
- `rest`：由失败语义分类器（§3.3）统一产出，同时供冷却与 trace。
- `entry.candidates[].status` 扩展为 `{ status, why, quotaUsedPct, renewsAtMs, servedTokens }`，`RouteCandidate` 类型同步扩展。请求追踪页据此渲染「该账号额度 X%、重置 Y 时点、最近服务 Z tokens」。

### 3.2 额度感知排序（策略 `"quota"`）

在 `select.ts` 的现有分层（dedicated > wildcard → native > translated → connectionPriority）之后，**同优先级层内**按策略排：

- `fill-first`（默认，现状）：稳定 id 排序取第一个。
- `round-robin`（现状）：按 `connectionWeight`/`credentialWeight` 加权轮转。
- **`quota`（新增）**：
  1. 把该层候选分三档：`spent`（usedFraction ≥ `SPENT_SHARE`）、`low`（≥ `LOW_SHARE` = 0.9）、`fine`（< 0.9 或未知但会回报）。
  2. `fine` 内按「最早重置的大窗口在前」排序（重置时间取整到小时比较，避免几分钟噪声颠倒顺序），相等保持原有顺序（缓存友好）；学习型候选（account-managed 且尚无 quota 数据但会随应答回报）在 `fine` 中优先一次，否则永远轮不到它、也永远不知道它的额度。
  3. `low`/`spent` 内按 usedFraction 升序；`spent` 仅当其余都不可用时兜底。
  4. `quota` 只对 account-managed/有快照的凭据生效；普通 `*-compatible` 连接没有 quota 数据，全部落在 `fine` 且 `stale` 标记，排序退化为现有 weight/priority。
- **`least-used`（新增）**：`fine` 之外先按 `usedFraction`、再按 `servedTokens` 升序。
- 与 affinity 的顺序：粘性绑定**先于**策略排序——已绑定的 session 不走 quota 排序；bind 失效（rest/cooldown）时解除绑定后按新策略重选。

实现边界：不动 `buildRouteTargets` 的产出结构；`selectRouteTarget` 新增 `policy: RoutingPolicy` 参数（默认沿用 `state.routing.strategy`），quota 快照与 served 计数通过 `RouteEvidence` 读，不新增 I/O。`state.routing.strategy` 的取值在 `start.ts` 的 env/CLI 解析与 `RoutingConfig` 中扩展（`quota`/`least-used`）。**注**：当前项目路由策略只在 `--routing-strategy`/`ROUTING_STRATEGY` 配置，admin 面板无对应设置项，故未加 UI（如后续新增「路由」设置项，再同步这两个取值）。

### 3.3 失败语义分档退避

新增 `lib/route-target/rest-reason.ts`，把 `classifyUpstreamError` 的输出再按语义分档：

```ts
type RestReason =
  | "credit" // 402/欠费词表：30min，直到充值
  | "quota" // quota_exhausted：读 resets_at/resets_in_seconds/Retry-After/known window，封顶 8d
  | "rate" // 429/限流词表：读 Retry-After，否则 backoff
  | "verify" // 401/403 且是验证要求：30min，期间短期复用同一错误应答（verifyHold 1min）
  | "refused" // 安全过滤拒绝：不休息，直接换下一个候选
  | "canceled" // 客户端中断：不休息
  | "network" // 网络/5xx：指数退避（现状 1s→60s）
  | "unknown" // 默认 backoff
```

- 数据源：`error.responseBody`（既有 `UpstreamTransportError`/`HTTPError` 携带）+ `retryAfterMs`；`quota` 额外解析 `resets_at`/`resets_in_seconds` 与 Claude Code 的 `usage limit reached|<unix>`。
- 写入位置：`services/dispatch/failover.ts` 的 `recordUpstreamAttempt` catch 路径统一经 `restReasonFor(error)` → `restDurationFor(reason, context)` → 写 `credential.cooldownUntil`/`restingUntil`；`rate-limit.ts` 的 pacing 退避保留（它管 in-flight 节流，不管选路淘汰），但**额度类错误不再经过它**——quota 用真实窗口而不是 60s 指数退避。
- 类型扩展：`UpstreamAttempt` 增加 `restReason`、`restUntilMs`；`RouteCandidate` 的 `status` 由 `quota/cooldown/disabled` 细分到 `quota`（带 `renewAtMs`）/`rate`（带 `retryAfterMs`）/`credit`/`verify` 等，admin 候选列表可直接显示「还需 X 分钟恢复」。

### 3.4 缓存感知亲和（可选 `auto`）

`session-affinity.ts` 新增 `AffinityMode: "session" | "turn" | "auto" | "off"`（现状等价于固定 `session`）：

- `auto`：粘性条目额外记录 `lastCacheRead`、`lastAt`、`turn`。跨 turn 复用时，仅当 `lastCacheRead ≥ 1024` 且距上次 ≤ 5min（`cacheCold`）才保持绑定，否则解除并按策略重选。`lastCacheRead` 从 `usage.cacheReadTokens` 在 `recordUsage`/`persistRequestLog` 时回填。
- `turn`：只在同一对话 turn 内粘（`X-Claude-Code-Session-Id`/Codex `prompt_cache_key` 等 session 提取已能识别 turn 边界），跨 turn 释放。
- 默认仍是现状的 session 绑定；`auto`/`turn` 通过 `state.routing.affinity` 显式开启。

### 3.5 trace 可观测性补齐

- 在途的「首字到达」单独推一帧（`update` 携带 `firstTokenAtMs`），让 trace 页在上游应答前就能看到「已开始吐字」，而不是等到 final。
- `RouteCandidate` 的 `why` 与 quota/rest 字段进 trace 帧；请求追踪页的候选列表渲染「额度 X% · 重置 T」与「冷却中，还需 Ns」。
- 保留现有 `TRACE_KEEP = 60` 环形缓冲与内存级实现；trace 持久化不在本方案范围（`request-log-persist` 已另行落盘）。

## 4. 实施分期

| Phase             | 内容                                                                                                      | 关键文件                                                                                       | 完成信号                                                                                 |
| ----------------- | --------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| 1                 | ✅ `RouteEvidence` + `recent-serve` 计数 + `restReason` 分类器骨架；`RouteCandidate.why/quota*/rest` 字段 | `route-target/evidence.ts`、`recent-serve.ts`、`rest-reason.ts`、`log-store.ts`                | 新字段在 trace 帧中出现，排序行为不变                                                    |
| 2                 | ✅ `quota`/`least-used` 策略接入 `selectRouteTarget`，env/CLI 扩展                                        | `route-target/select.ts`、`evidence.ts`、`routing/session-affinity.ts`、`start.ts`、`state.ts` | 相同候选池在两个账号不同额度下选中顺序可复现（`tests/routing-quota.test.ts`）            |
| 3                 | ✅ 分档退避接入 failover 与 availability；`resets_at`/`verify`/`refused`/`canceled` 语义                  | `rest-reason.ts`、`availability.ts`、`dispatch/failover.ts`、`rate-limit.ts`                   | 额度耗尽账号不再被 60s 退避反复重试，rest 时长上 trace（`tests/rest-reason.test.ts`）    |
| 4                 | ✅ `auto`/`turn` 亲和；`cacheRead` 回填                                                                   | `routing/session-affinity.ts`、`usage.ts`、`start.ts`、`state.ts`                              | 高频缓存命中的会话跨 turn 命中同一凭据，低缓存会话释放（`tests/affinity-modes.test.ts`） |
| 5                 | ✅ trace 页渲染 `why`/quota/rest，候选列标注「额度/重置/冷却」                                            | `pages/js/views/traces.js`、`index.html`、`i18n.js`                                            | 候选列表显示「可用备用 · 额度 42% · 重置 4d 后」这类依据                                 |
| 6（可选，未实施） | 路由组 / member effort / Jev 分类器                                                                       | 新 `lib/route-group/`                                                                          | 仅在别名+priority 表达力确实不够时启动；另行立项                                         |

## 5. 测试与回归保护

- `tests/routing-quota.test.ts`：构造两个 account-managed 连接、不同 `quota` 快照，断言 `quota` 策略按「最早重置 → fine→low→spent」排序；额度未知的学习型凭据在 `fine` 中先放行一次；`staleMs` 过大的快照不淘汰候选。
- `tests/rest-reason.test.ts`：402/欠费 body → 30m；`resets_at` → 真实窗口（封顶 8d）；429+`Retry-After` → 按 header；verify → 30m 且 hold 期复用错误；refused/canceled → 不休息；network/5xx → 现状指数退避。
- `tests/session-affinity.test.ts`（扩展）：`auto` 模式下 `cacheRead ≥1024` 且未冷 → 保持；<1024 或 >5min → 释放重选；`turn` 模式仅同 turn 粘。
- 既有 `select.ts` 行为锁定：`fill-first`/`round-robin`/affinity/`exclude` 的现有测试必须原样通过（默认策略未变）。
- trace：`admin-trace.test.ts` 扩展断言 `candidates[].why/quotaUsedPct` 在帧中出现。

## 6. 非目标与边界

- **不引入路由组 / Jev 分类器 / member effort**：对现有模型别名 + connectionPriority 已能表达的需求，不新增组抽象（Phase 6 单独立项）。
- **不持久化 served 计数与 rest**：进程内即可，重启后重新学习。
- **不改凭据租约与 pacing**：`tryAcquireCredentialLease` 与 `checkRateLimit` 管并发与节流，与选路淘汰是两层，本方案只动后者。
- **候选上限仍截断**（现有 `describeCandidates` 的 limit 12）：trace 只展示头部候选，完整池在日志诊断里。
- **额度数据永远是 best-effort**：上游不暴露 quota 的连接不退化为「不可用」，一律落 `fine` + `stale`；`quota` 策略只提升排序质量，不做准入否决（否决仍归 `onlyAvailable`/`credential.status`）。
