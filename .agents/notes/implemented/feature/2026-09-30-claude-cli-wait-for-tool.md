# Agent Note: `wait_for_tool` —— 让模型自己回来取迟到的工具结果

Status: implemented

## Problem

一次工具调用的结果可能晚于 `patience` 才回到网关（本地跑一次完整测试、构建、
`bun install`，或者用户在权限确认框上停了一会儿）。到点后网关只能把 MCP 调用答复
成"还在跑"，然后就没有下文了：那条调用的结果回来时没有人在等（见
`2026-09-30-claude-cli-dropped-tool-results.md`），调用方只能重新发一整轮对话，
网关也就只能**重开一个新进程**、把整段 transcript 重放一遍，prompt cache 全废。

而这个"等"又不能靠继续阻塞来做：CLI 的 MCP 客户端对单次调用有约 **一分钟**上限
（`its MCP client gives up on a call at a minute`），
而 `patience` 默认是 5 分钟 —— 阻塞得比客户端的上限还久，客户端先放弃。

## Decision

补上 `wait_for_tool`：

- `bridgeTools()` 在调用方本来就有工具时，额外暴露一个合成工具
  `wait_for_tool`（`{call: <tool_use id>}`）。调用方工具为空时不暴露 —— 没有工具
  就没有"等调用方执行"这回事，而多一个工具定义会改变 prompt 前缀（§6.1 的 cache
  约束）。
- "还在跑"那条答复改成明确指示模型回来取：
  `Call mcp__copilotapi__wait_for_tool with {"call": "<id>"} to wait for its result.
Do not call it again.` 工具名按 CLI 眼里的形态写全，模型看到的工具表就是这个。
- helper 的 `tools/call` 按名字分流：`wait_for_tool` 的目标 id 取
  `arguments.call`（**不是**回调自己的 `tool_call_id`，那是 wait 这次调用自身的 id），
  交给 `run.awaitWaitRequest()`；它复用 `awaitToolCall` 的同一套等待，区别是不再
  `park`（那条调用早已登记，也不该再被 `findParked` 当成新回合的唤醒目标）。
- **合成调用不能泄漏给调用方**。`translateClaudeStreamJson` 里新增
  `OwnWaitBlocks`：认出自己那块就整块不下发（含 `input_json_delta` 与
  `content_block_stop`），并且当一轮答复**只**带自己的调用时，`message_delta` 不报
  `tool_use`、`message_stop` 也不下发 —— 否则调用方会收到一个没有任何内容的完整回复，
  而真正的答案还在后面。
- 等待到哪里为止：`patience` 到点时 waiter 会把自己摘掉，所以之后送来的结果落进
  `pendingResults`，等下一次 `wait_for_tool` 来取。**不**把 waiter 留着，否则结果会
  兑现给一个已经答复完的请求，等于丢掉。

## Alternatives considered

**把 `patience` 调大到覆盖长任务。** 治不了根：MCP 客户端一分钟就放弃了，阻塞再久
也没人听。

**不设 patience，无限等。** 一个卡住的工具
会把 MCP 调用和 CLI 进程一直举着。

**让调用方在长任务期间轮询 `/v1/messages`。** 那是把网关的内部状态机推给每一个调用
方；由模型自己调一次工具来取，是所有调用方都能配合的最小约定。

## Consequences

长任务不再丢进程复用：结果到了，模型再调一次 `wait_for_tool` 就接回原来那个进程，
prompt cache 与对话状态都保住。代价是多一个只对 CLI 可见的工具定义，以及"模型得配合
回来取"这一层依赖 —— 模型如果不理会那条指示，行为会退回到"下一轮重开一个进程"，
而不是出错。

阻塞时长始终压在 `patience`（默认 5 分钟）以内，且每次 `wait_for_tool` 重新计时；
若要让它严格短于客户端的一分钟上限，把 `COPILOT_API_CLAUDE_MCP_PATIENCE_MS` 调小即可。

## Verification

- `tests/claude-cli-wait-tool.test.ts`

覆盖：结果先到 → 调用发出时立刻取到；patience 到点 → 答复里出现 `wait_for_tool` 与
目标 id → 迟到结果被 `wait_for_tool` 取到；不认识的 id 立刻回错（不等一个 patience）；
`bridgeTools` 在有/无调用方工具时的两种形态；translate 侧"自己的调用不下发""只带自己
调用的那轮不结束答复""调用方的调用照常下发"。

真机（真 `claude` 2.1.285 + `claude-sonnet-5-5`，隔离实例，patience=20s、结果压 35s）：

```
turn 1 : … tool_use(get_secret) → stop(tool_use) → message_stop
turn 2 : message_start → stop(-) → message_start → text… → stop(end_turn) → message_stop
         text = "The value of the secret `alpha` is `42-DELTA`."
         PID 全程 61341
```

即：CLI 确实在"还在跑"之后自己调了 `wait_for_tool`（`stop(-)` 那段就是它，工具调用
没有泄漏给调用方），迟到结果送达模型，且**全程同一个进程**。
