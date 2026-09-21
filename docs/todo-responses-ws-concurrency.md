# TODO: Responses WebSocket 并发门禁

状态：**已完成**（见 `.agents/notes/implemented/bug-fix/2026-09-21-responses-ws-credential-gate.md`）

发现于：上游模型审计改动期间的代码审阅

## 背景

`copilot-api` 有两条互不相交的请求收尾路径：

- **HTTP 路径**：`src/services/dispatch/shared.ts` → `executeWithFailover`
- **Responses WebSocket 路径**：`src/routes/responses/ws-handler.ts`（Codex 的主路径）

WS 路径不走 `executeWithFailover`，因此**绕过了 dispatch 层的全部并发控制**。实测确认：

```
=== WS path: pacing / rate-limit calls? ===
NONE -> WS bypasses the pacing gate too

=== HTTP path for comparison ===
checkRateLimit / reportUpstreamSuccess        ← burst + 间隔限速
tryAcquireCredentialLease                     ← 在途上限
```

WS 两个机制都没有。

## 问题

### 1. 缺"在途 turn"上限（主问题）

N 个不同的 WS 客户端（各自一个 `executionSessionId`）可以**同时选中同一个凭证**。

- 单个 WS 连接内部已经串行（`ws-handler.ts:153` 的 `if (inFlight)` 拒绝并发 `response.create`），所以**单个客户端无法制造并发**。
- 上游 socket 复用 key = `provider::accountId::executionSessionId`，全局上限 `MAX_UPSTREAM_WS_SESSIONS = 1024`（`services/responses/upstream-ws.ts`）。
- 缺的是**跨 session** 的那道界。

**为什么 WS 比 HTTP 更容易触发聚集**：session affinity 的键是
`affinityAuthKey = connectionId::credentialId`（`src/lib/routing/session-affinity.ts:29`），
其设计目的就是**把同一会话粘到同一凭证**（为了 prompt cache 命中率）。所以多个 Codex 会话被粘到同一账号是**预期行为**。HTTP 每次请求独立选路，天然分散；WS 是粘性选路，**主动聚集**。同一个缺失的界，在 WS 上更易触发。

### 2. `CredentialConcurrencyLimitError` 在 WS 侧会被误分类（阻塞项）

`CredentialConcurrencyLimitError extends Error`（**不是** `HTTPError`），
而 `classifyWsFailure` 对非 `HTTPError` 的兜底是（`src/services/responses/ws-failure.ts` 末尾）：

```ts
// Non-HTTPError: handshake failure, socket drop/close, idle timeout, etc.
return { scope: "connection", kind: "transport" }
```

`ws-handler.ts` 随后：

```ts
if (failure.scope === "connection" && !httpRecoveryTried) {
  return { type: "retry-http" }
}
```

后果：**本地并发拒绝会被当成连接问题，触发同一账号的 HTTP 重试**。而那条 HTTP recovery 路径走
`createResponses(..., forceUpstreamHttp: true)`，**不经过 `executeWithFailover`，也没有 lease**。

即：在 WS 上被限流拒绝 → 绕过限流用 HTTP 再打一次同一账号。
**这比不接更糟** —— 等于把限流器变成一个绕过自身的开关。

> 已确认不会误冷却账号：`recordUpstreamFailure` 对 account-managed 连接的 `switch` 中，
> `kind: "transport"` 落到 `default: return`，不写冷却状态。
> 危害集中在"错误地同账号重试"，不是"误冷却"。

## 决策：粒度 = credential（计"在途 turn"）

**不用 session 粒度** —— 每个 session 已被 `inFlight` 限成 1 个在途 turn，再按 session 加界等于空操作。

**用 credential 粒度**，理由：

- 要拦的正是"跨 session 聚集"，而那正是 affinity 造成的
- 键与现有概念对齐：lease 的 `targetKey` 与 affinity 的 `authKey` 都是 `connectionId::credentialId`
- 计"在途 turn"而非"打开的 socket"：一个空闲 Codex 会话（上游 socket 开着但无 turn）
  **不该**占用配额，否则 10 个闲置会话就能占满全账号额度

生命周期与 HTTP 一致：**turn 开始 acquire / turn 结束 release**。

## 实施清单

### 1. 接入 lease

- [x] turn 开始：`tryAcquireCredentialLease(current.target)`（`src/services/dispatch/concurrency.ts`）
- [x] turn 结束释放，**两条路径都要覆盖**，否则断连会泄漏：
  - [x] `finishTurn`（正常完成）—— 由轮转循环的 `finally` 覆盖（WS turn 在 `runResponsesAttempt` 内整体 pump 完毕）
  - [x] `cancelActiveTurn`（`onClose` / `onError` 断连）—— 额外挂 `signal` 的 `abort` 监听，客户端一断就归还额度，不等上游忽略 abort 后迟迟不 settle
- [x] 轮转（`rotate`）时先释放旧 lease 再 acquire 新的

### 2. 补分类（**必须**，不是优化）

- [x] 给 `ClassifiedWsFailure` 增加本地饱和 scope `local_saturation`
- [x] `CredentialConcurrencyLimitError` 映射到该 scope，**不得**落入 `transport`
- [x] 确认该 scope 不触发 `retry-http`（ws-handler、codex/xai `create-responses-once` 三处同账号 HTTP 回退都排除它）

### 3. 补轮转语义

- [x] 拒绝时**不冷却**账号（saturation 分支跳过 `recordUpstreamFailure`）
- [x] 直接 rotate 到下一个账号
- [x] 无可用账号时返回 **429（retryable）**，对齐 HTTP 侧 `RateLimitQueueFullError` 的处理，而非 500

### 4. 测试（当前 WS 并发路径零覆盖，需先建基线）

- [x] 打满 cap 后第 N+1 个 WS turn 被拒，且**不触发**同账号 HTTP 重试
- [x] 拒绝时账号**未被冷却**
- [x] 客户端断连（`onClose`）后 lease 正确释放，不泄漏
- [x] 空闲会话（socket 开着、无在途 turn）**不**占用配额
- [x] 无可用账号时返回 429 而非 500

测试文件：

- `tests/responses-ws-concurrency.test.ts`（端到端 WS，含饱和→轮转到下一个账号）
- `tests/dispatch-credential-lease.test.ts`（HTTP 侧 lease 打满：轮转 / 无目标 429 / 不冷却）
- `tests/trace-error-classification.test.ts`（trace 口径：本地饱和不是上游失败）
- `tests/ws-failure.test.ts`（分类单测）

## 补充说明：观测口径

本地饱和是 `HTTPError(429)`（为了两端的 retryable 契约），但**不是上游失败**。
若只按 status 分类，trace 会把它记成 `origin: upstream / kind: rate_limited`，
HTTP attempts 会记成 `errorCode: rate_limited` —— 与语义相矛盾。

现引入 `LocalConcurrencyLimitError` 标记（`src/lib/error.ts`），
`CredentialConcurrencyLimitError` 与 `WindsurfConcurrencyLimitError` 继承它，
`classifyTraceError` / `executeWithFailover` 在 status 分支**之前**按
`instanceof` 归类，记 `kind/errorType: concurrency_limit`、`origin: proxy`。

客户可见文案改为通用文案（`Credential concurrency limit reached; retry shortly`），
内部 routing key 移到 `credentialKey` 字段仅供日志。

`RateLimitQueueFullError` 不在本次范围：它是普通 `Error` 而非 `HTTPError`，
要并入标记需先转换类型，建议作为独立小改动。

## 不在本次范围

- **pacing 门禁（`checkRateLimit`）是否也接入 WS**：它约束的是"发送速率"而非"在途数"，
  而 WS 是长连接多轮，语义不同。建议等 lease 上线运行一段时间、观察实际效果后再评估，先不接。

## 相关参考

- `src/services/dispatch/concurrency.ts` — lease 实现与 `MAX_INFLIGHT`（默认 10，
  `COPILOT_API_CREDENTIAL_MAX_CONCURRENCY` 可配）
- `src/services/dispatch/failover.ts` — HTTP 侧参考实现，含
  `RateLimitQueueFullError` 的"不冷却、直接轮转"处理
- `src/services/windsurf/concurrency.ts` — 已有的 per-account 并发上限先例
  （`WINDSURF_MAX_CONCURRENT_REQUESTS`），可参照其错误类型与日志形态
- `src/routes/responses/ws-handler.ts` — WS turn 生命周期（`inFlight` /
  `activeController` / `activeTurn` / `finishTurn` / `cancelActiveTurn`）
