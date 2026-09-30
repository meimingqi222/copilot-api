# Agent Note: 没有 MCP 调用在等时，工具结果必须存下来而不是丢掉

Status: implemented

## Problem

`ClaudeCliRun` 把"结果回来"和"有人在等"当成同一件事：

```ts
deliver(toolUseId, result) {
  const waiter = this.waiters.get(toolUseId)
  if (!waiter) return false        // 没人在等 → 丢弃
  …
}
```

而 `resume()` 拿到 `false` 就**整条 run 一起 abort**：

```ts
if (!delivered) { this.abort(); throw … `the agent is not waiting for tool result ${id}` }
```

问题出在 Claude Code 的 MCP 调用是**串行**的：一次回复里有两个工具调用时，第二个
只有等第一个拿到结果之后才会发出。而调用方是按"我这条回复里的调用都执行完了"来
回话的 —— 两个结果一次性送到。于是第二个结果到达时，它的 MCP 调用还没发出，网关
眼里就是"没人在等"，结果是：

1. 那个结果被丢弃（永远不会再有人取它）；
2. 更糟的是整条 run 被 abort —— 进程被杀，第一个调用的结果也一起没了。

顺带还有一条同源路径：某次调用已经回过"还在跑"（patience 到点）之后，结果才回来，
同样"没人在等"，同样丢弃。

## Decision

`ClaudeCliRun` 增加一个待取结果表 `pendingResults: Map<tool_use id, McpToolResult>`，
`deliver()` 的语义变成"有人在等就交付，没人等就先存起来"，只在 run 已经结束时才
返回 false。`resume()` 相应地不再 abort：它把结果全交给 `deliver`。

`streamClaudeCliMessages()` 也去掉了那句过滤 —— 原先只把"已经挂起的 id"的结果交给
`resume`，其余的直接被丢掉；现在全部交过去，由 run 自己决定交付还是暂存。

取用处有两个，共用同一套等待（`waitForResult`）：

- `awaitToolCall()`：调用发出时才取，命中就立刻返回（这就是"串行 MCP"那条路径）；
- `awaitWaitRequest()`：`wait_for_tool` 的入口（见另一条笔记）。

另加一个 `awaitingResult: Set<string>` 记录"登记过、结果还没到"的 id，用来区分
"还在跑"和"这个 id 我根本不认识"——后者立刻回一条错误，而不是白等一个 patience。

## Alternatives considered

**保持 abort，只把"没人等"降级成警告。** 那样结果仍然被丢：第二个工具的调用发出时
网关手上已经没有它的答案了，模型只能一直等到 patience 到点再被告诉"还在跑"，而这
条调用在调用方那边其实早就完成了。

**让调用方按顺序送结果（先只送第一个）。** 这是把网关的内部约束泄漏给每一个调用方，
而调用方（Claude Code / Pi / OpenCode / …）本来就不知道 MCP 是串行的。

## Consequences

一次回复里的多个工具调用现在都能落地，进程也不会被误杀。代价是"没人等"不再是一个
响亮的错误：一个凭空捏造的 `tool_use_id` 会被安静地存起来，run 继续等它的调用。
这是有意的取舍 —— 它和 magpie 的 `early` 表行为一致（那边同样把这些结果先收着），
而且比"因为一个多余的结果杀掉整条 run"划算得多。

## Verification

- `tests/claude-cli-wait-tool.test.ts`

Proved: 把 `deliver()` 临时改回旧行为（`if (!waiter) return false`，不存）→ 8 项里
2 项失败（`keeps a result that arrives before its call is made` 与
`a late result is collected by wait_for_tool, not by blocking`）→ 恢复后 8/8 通过。

真机（真 `claude` 2.1.285 + `claude-sonnet-5-5`，隔离实例）另跑了一次迟到结果的
端到端：把 `tool_result` 压到 patience 之后才送，结果仍被收下并送达模型，全程同一个
PID。
