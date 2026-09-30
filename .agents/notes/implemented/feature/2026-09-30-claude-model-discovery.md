# Agent Note: Claude 的模型表改为从上游 `/v1/models` 实时发现

Status: implemented

## Problem

claude 的 connection 模型表只来自 `model-catalog.ts` 里的静态
`CLAUDE_CATALOG`。`discoverOAuthModelsForConnection()` 只为 codex/antigravity
走上游端点,claude 落到 `default` 分支直接返回静态表 —— 所以上游一发新模型,
列表就停在硬编码的那几项(这份表曾停在 `claude-sonnet-4-6` / `claude-opus-4-6`
/ `claude-haiku-4-5-20251001`,而上游当时已有 13 个模型,含 `claude-sonnet-5-5`)。

这个缺口不是"列表显示旧了"这么轻:模型不可路由(`No available route for model
"claude-sonnet-5-5"`),而且**没有办法从 UI 修好** —— `mergeProviderRefreshedModels`
按 publicId/upstreamId 匹配后只保留用户层改动(改名/禁用/别名),**永远不会新增
条目**,admin 的 `PUT /api/accounts/:id/models/:publicId` 也只能改已有条目。所以
新模型在界面里无论如何都变不出来,只能改代码。

## Decision

新增 `src/services/claude/get-models.ts`,并在
`discoverOAuthModelsForConnection()` 里为 `claude` 接上 `case`:

- `GET https://api.anthropic.com/v1/models?limit=100`(需要时按
  `has_more`/`last_id` 翻页,上限 5 页)。
- 走 `executeUpstreamProxyCall`,与 codex/antigravity 同一条链路:同一个
  connection、同一份 proxy 设置,`$TOKEN$` 由它替换为 `ensureOAuthConnectionAccessToken`
  拿到的有效 access token(必要时先刷新)。
- 身份标记用配额端点那一套(Bearer + `anthropic-version` +
  `anthropic-beta: oauth-2025-04-20`),**不**套 Messages 热路径的 Cowork 指纹头:
  真机实测该端点普通 Bearer 即 200,而且 CLI 自己根本不调这个端点,伪造指纹
  在这里没有意义。
- 发现失败时由 `discoverOAuthModelsForConnection()` 既有的 `catch` 回落到静态
  catalog,不会因为一次网络抖动把模型表清空。
- 静态 `CLAUDE_CATALOG` 相应补齐到与上游一致的 13 个模型,并在注释里标明它
  现在只是**离线兜底**而不是真相来源。

## Alternatives considered

**只把静态表更新一次。** 那正是这次要做掉的东西:上游发版后必须有人记得改代码,
而中间这段时间新模型完全不可用(本次就是这样卡住的)。

**让 `mergeProviderRefreshedModels` 支持"上游新增即追加"。** 它现在的语义是
"provider 全量覆盖 + 保留用户层配置",改成并集会让一份过期的静态表永不收缩,
还会把上游已下架的模型永久留在表里。发现路径才是正确的修复位置。

**沿用 Messages 热路径的 `buildClaudeOAuthHeaders`。** 那套指纹(`cch`、
Stainless、Cowork UA)是为请求**内容**分类服务的;模型目录是元数据端点,套上去
只会多一处随上游发版漂移的地方,且真机证明不必要。

## Consequences

claude 的模型表现在以上游为准:上游加/删模型,下一次 `refreshModels` 就同步,
不再需要改代码。用户层配置(改名、别名、禁用)仍由 `mergeProviderRefreshedModels`
保留。

代价是每次刷新多一次网络往返,以及"离线时只能拿到兜底表"——两者都与 codex/
antigravity 的既有行为一致。

真机验证(本机 `claude` 2.1.285 的 Pro access token,仅用于隔离数据目录):

- 静态兜底表:`13` 个模型
- 上游发现:`13` 个模型(`claude-sonnet-5-5` … `claude-sonnet-4-5-20250929`)
- `refreshModelsForConnection()` 后落盘:`13` 个,`endpoints: ["messages"]`

## Verification

- `tests/claude-get-models.test.ts`

Proved: 8/8 通过 —— 覆盖上游 payload → `AccountModel` 映射(id 规范化、
display_name 回落、去重、翻页字段、非 JSON 抛错),以及「不是 claude」/「没有
access token」时返回空数组(即回落静态 catalog 的前提)。真机侧用
`refreshModelsForConnection()` 跑通,落盘 13 个模型(见上)。
