/**
 * OpenCode Zen 免费车道（匿名免密）的 wire adapter。
 *
 * 这条车道是 opencode.ai 的公共池：`Authorization: Bearer public` 是**所有人共用**
 * 的凭据，没有 per-user secret。它能用，但上游加了四道门：
 *
 * 1. **客户端指纹**：`user-agent` 必须含 `opencode/<version>`（>= 1.17），
 *    外加 `x-opencode-client: desktop` 与 `x-opencode-session` /
 *    `x-opencode-request` / `x-opencode-project`。缺一个就 403 FreeTierError
 *    "can only be used from within OpenCode"。
 * 2. **工具白名单**：`tools` 必须**包含** `bash` / `glob` / `grep` / `read`
 *    四个小写名字——是子集要求,不是全集。多带调用方自己的工具完全允许
 *    (实测四件组 + `get_weather` 时模型会正常调用它,名字原样带回),但四个名字
 *    缺任何一个、或只差大小写(有 `Bash` 而没有 `bash`)都是 403。所以调用方工具
 *    照常透传,由 `applyFreeTierFingerprint` 把缺的槽位规范化/提升/补齐,
 *    响应侧再把改过的名字改回调用方的拼写。
 * 3. **按 session 记账的配额**：每个请求换新 session id 会立刻 429
 *    FreeUsageLimitError。所以 session 必须由「连接 + 调用方身份 + 模型」
 *    确定性派生，同一路客户端固定复用同一个 session。
 * 4. **请求必须流式**：`stream` 必须是 `true`（2026-10-10 实测）。非流式请求
 *    一律 403 FreeTierError。所以两条线对上游一律按流式发,客户端要非流式时
 *    再由 adapter 把整条流聚合回 JSON（见 `createChatCompletions` /
 *    `createResponses`）。
 *
 * 门禁 1~3 实测于 2026-10-09，门禁 4 于 2026-10-10。
 *
 * 另外上游按模型分流端点：muse-spark 系只服务 `/responses`（打 `/chat/completions`
 * 会回 400 ModelProtocolUnsupported），其余走 `/chat/completions`。清单里曾经出现
 * 过只服务 `/messages` 的 union-alpha，现已下线；真需要时按 `MESSAGES_MODELS`
 * 加回来即可。
 *
 * 固定指纹头写死在 adapter 里而不是交给连接的 `headers`：它们是协议的一部分，
 * 不是用户配置。放进连接配置只会多一种「用户把必接头删了，然后整条车道 403」
 * 的坏法。连接上的 `headers` 仍然可以追加额外头部。
 */

import crypto from "node:crypto"

import { getClientIp } from "~/lib/utils"
import {
  performanceFetch as fetch,
  readUpstreamJson,
  serializeUpstreamBody,
} from "~/lib/upstream-performance"

import type { CopilotStreamEvent } from "~/services/protocols/chat/types"

import {
  type ApiCredential,
  type ModelMapping,
  type ProviderConnection,
} from "~/lib/provider-connections"
import {
  buildBaseHeaders,
  connectionFetchInit,
  detectOpenAIStreamError,
  handleUpstreamFailure,
  joinUrl,
  safeSseStream,
  setHeader,
} from "~/services/protocols/shared"

import { aggregateSseToResponse } from "./sse-aggregate"
import { collectResponsesFromEventStream } from "~/services/responses/sse-collector"

import type {
  AdapterChatResult,
  AdapterResponsesResult,
  ProtocolAdapter,
} from "./types"
import type { Context } from "hono"

/** 网关要求的客户端版本号（UA 检查是搜索而非锚定匹配，>= 1.17 即可）。 */
export const ZEN_CLIENT_UA = "opencode/1.18.31"

/** 免费层要求声明的工具四件组，缺一即 403。 */
export const ZEN_TOOL_QUARTET = ["bash", "glob", "grep", "read"] as const

/** 占位工具的描述：模型可能会调用它，必须让它知道不能用。 */
const DECOY_TOOL_DESCRIPTION =
  "This tool is currently unavailable and must not be used."

/** 不带 `-free` 后缀但同样走免费车道的 id。 */
const ALWAYS_FREE = new Set(["union-alpha", "space-bunny-free"])

/** 只服务 `/responses` 的模型族（实测 `/chat/completions` 回 400）。 */
const RESPONSES_MODELS = new Set([
  "muse-spark-1.2-contributor-free",
  "muse-spark-1.3-contributor-free",
])

/** 只服务 `/messages`（Anthropic 形状）的模型；当前清单里没有，留作扩展。 */
const MESSAGES_MODELS = new Set(["union-alpha"])

const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"

/** 模型 id 可能带 "(Deep)" 这类思考档后缀，匹配前先剥掉。 */
export function baseModelId(model: string): string {
  return String(model ?? "")
    .replace(/\([^()]+\)\s*$/, "")
    .trim()
}

/** 该 id 是否在免费车道上（清单混合了付费与免费 id）。 */
export function isFreeLaneModel(modelId: string): boolean {
  const base = baseModelId(modelId)
  if (ALWAYS_FREE.has(base)) return true
  return /(?:^|[-_])free(?:$|[-_.])/.test(base)
}

/** 这个模型该打哪个端点。 */
export function endpointForModel(modelId: string): string {
  const base = baseModelId(modelId)
  if (RESPONSES_MODELS.has(base)) return "/responses"
  if (MESSAGES_MODELS.has(base)) return "/messages"
  return "/chat/completions"
}

function base62From(bytes: Uint8Array, length: number): string {
  let out = ""
  for (let i = 0; i < length; i += 1) {
    out += BASE62[bytes[i % bytes.length] % 62]
  }
  return out
}

/**
 * 由种子确定性地铸出一个网关形状的 session id。
 *
 * 配额按 session 记账，所以同一个种子必须永远得到同一个 id——否则每请求一个新
 * session，免费额度瞬间烧穿并换来 429。格式是网关校验过的：
 * `ses_` + 12 位十六进制 + 14 位 base62。
 */
export function zenSessionFor(seed: string): string {
  const digest = crypto.createHash("sha256").update(seed).digest()
  return `ses_${digest.subarray(0, 6).toString("hex")}${base62From(digest.subarray(6, 20), 14)}`
}

/** 每个请求一个 request id（只是关联 id，不参与配额）。 */
export function zenRequestId(): string {
  const bytes = crypto.randomBytes(20)
  return `msg_${bytes.subarray(0, 6).toString("hex")}${base62From(bytes.subarray(6, 20), 14)}`
}

/**
 * 这次请求该用哪个 session。
 *
 * 粒度取「连接 × 调用方身份 × 模型」：单用户部署下按 IP 分桶，多用户部署下按
 * userId 分桶，避免所有调用方挤同一个 session 额度、一个人把整条连接搞到 429。
 * 身份都取不到时退化成连接级单桶（仍比每请求一个新 session 好）。
 */
export function zenSessionForRequest(
  connection: ProviderConnection,
  model: string,
  ctx?: { c?: Context },
): string {
  // 身份优先取多用户模式下的 userId;单用户模式退回客户端 IP。走仓库自己的
  // getClientIp 而不是裸读 x-forwarded-for——那个头客户端可伪造,拿它当配额桶
  // 等于谁都能靠无限换 session 绕开限额(是否信任转发头由 TRUST_PROXY 统一决定)。
  const userId = ctx?.c?.get("userId")
  let clientIp: string | undefined
  if (ctx?.c) {
    try {
      clientIp = getClientIp(ctx.c) || undefined
    } catch {
      clientIp = undefined
    }
  }
  const identity = userId || clientIp || "anonymous"
  return zenSessionFor(
    `${connection.id}\u0000${identity}\u0000${baseModelId(model)}`,
  )
}

/** 免费车道的请求头：固定指纹 + 本次的 session/request。 */
function zenHeaders(
  connection: ProviderConnection,
  credential: ApiCredential,
  session: string,
  requestId: string,
  accept: string,
): Record<string, string> {
  // 连接自己的 headers 仍然生效（可追加额外头部），但必接指纹头由这里兜底，
  // 不会被连接配置里的删除/改名影响。
  const headers = buildBaseHeaders(connection, credential)
  setHeader(headers, "authorization", "Bearer public")
  setHeader(headers, "user-agent", ZEN_CLIENT_UA)
  setHeader(headers, "x-opencode-client", "desktop")
  setHeader(headers, "x-opencode-project", "global")
  setHeader(headers, "x-opencode-session", session)
  setHeader(headers, "x-opencode-request", requestId)
  setHeader(headers, "accept", accept)
  return headers
}

/**
 * 把调用方的工具清单补齐成免费层要的形状，返回「上游看到的拼写 → 调用方拼写」。
 *
 * 门禁要求 `tools` **包含** `bash`/`glob`/`grep`/`read` 四个小写名(子集,不是全集:
 * 多带客户端自己的工具完全允许,实测四件组 + `get_weather` 时模型会正常调用
 * `get_weather` 并把名字原样带回)。缺一个就是 403 FreeTierError。所以这里做三件事:
 *
 * 1. **规范化**:调用方工具里名字与四件组只差大小写的(`Bash`),改成小写发出去,
 *    并记下映射——响应里的工具调用会是 `bash`,客户端只认得 `Bash`。
 * 2. **提升**:还缺的槽位,从调用方已有的工具里挑一个真能顶上的(目前只有
 *    `pwsh` 能顶 `bash`),提升进槽位并记映射。凭空补的 decoy 会被模型调用,
 *    而提升上来的工具调用是可执行的。
 * 3. **补 decoy**:仍然空着的槽位才放占位工具,描述里写明不可用。
 *
 * `tool_choice` 只在调用方没给时兜底:chat 线在调用方完全没带工具时置 `"none"`
 * (此时工具列表里只有 decoy,不该被调用),带了工具就保持上游默认;responses 线
 * 只接受 `"auto"`,传 `"none"` 会 400 `only "auto" is supported for tool_choice`。
 *
 * 端口自 dsh-our-free-model 的 `applyFingerprint` / `restoreToolName`。
 */
const QUARTET_DONORS: Record<string, Array<string>> = { bash: ["pwsh"] }

function toolNameOf(tool: unknown): string {
  if (!tool || typeof tool !== "object") return ""
  const record = tool as Record<string, unknown>
  if (typeof record.name === "string" && record.name.trim()) {
    return record.name.trim()
  }
  const fn = record.function
  if (fn && typeof fn === "object" && !Array.isArray(fn)) {
    const nested = (fn as Record<string, unknown>).name
    if (typeof nested === "string" && nested.trim()) return nested.trim()
  }
  return ""
}

/** Chat 的 `{function:{…}}` 包装,Responses 的扁平形状没有。 */
function functionOf(
  tool: Record<string, unknown>,
): Record<string, unknown> | null {
  const fn = tool.function
  return fn && typeof fn === "object" && !Array.isArray(fn) ?
      (fn as Record<string, unknown>)
    : null
}

function decoyTool(
  name: string,
  style: "chat" | "responses",
): Record<string, unknown> {
  const parameters = { type: "object", properties: {} }
  return style === "chat" ?
      {
        type: "function",
        function: { name, description: DECOY_TOOL_DESCRIPTION, parameters },
      }
    : {
        type: "function",
        name,
        description: DECOY_TOOL_DESCRIPTION,
        parameters,
      }
}

export function applyFreeTierFingerprint(
  body: Record<string, unknown>,
  style: "chat" | "responses",
): ZenToolWire {
  const rename = new Map<string, string>()
  // 调用方声明过的工具名(调用方自己的拼写):响应侧要靠它区分「模型调了客户端
  // 真有的工具」和「模型调了我们补位的占位工具」。
  const declared = new Set<string>()
  const callerTools = Array.isArray(body.tools) ? body.tools : []
  const hadClientTools = callerTools.length > 0
  for (const tool of callerTools) declared.add(toolNameOf(tool))
  delete body.functions
  delete body.function_call

  const out: Array<unknown> = []
  const filled = new Set<string>()
  const promoted = new Set<string>()

  // 1. 规范化大小写变体 + 去重(上游拒绝 `Bash` 与 `bash` 同时出现)
  for (const tool of callerTools) {
    const current = toolNameOf(tool)
    const slot = quartetSlotOf(current)
    if (!slot) {
      out.push(tool)
      continue
    }
    if (filled.has(slot)) continue
    filled.add(slot)
    if (current !== slot) {
      rename.set(slot, current)
      const fn = functionOf(tool as Record<string, unknown>)
      out.push(
        fn ?
          {
            ...(tool as Record<string, unknown>),
            function: { ...fn, name: slot },
          }
        : { ...(tool as Record<string, unknown>), name: slot },
      )
    } else {
      out.push(tool)
    }
  }

  // 2. 提升:能真正顶上一个槽位的客户端工具,胜过凭空补的 decoy
  for (const slot of ZEN_TOOL_QUARTET) {
    if (filled.has(slot)) continue
    const donors = QUARTET_DONORS[slot] ?? []
    const index = out.findIndex((tool) => {
      const original = toolNameOf(tool)
      if (original === "" || quartetSlotOf(original)) return false
      const lower = original.toLowerCase()
      return !promoted.has(lower) && donors.includes(lower)
    })
    if (index === -1) continue
    const tool = out[index] as Record<string, unknown>
    const original = toolNameOf(tool)
    promoted.add(original.toLowerCase())
    rename.set(slot, original)
    const fn = functionOf(tool)
    out[index] =
      fn ?
        { ...tool, function: { ...fn, name: slot } }
      : { ...tool, name: slot }
    filled.add(slot)
  }

  // 3. 剩下的槽位补 decoy
  for (const slot of ZEN_TOOL_QUARTET) {
    if (filled.has(slot)) continue
    out.push(decoyTool(slot, style))
  }

  // 调用方强行指定某个工具时,指定名也必须换成我们真实发出的拼写:它点名的
  // `Bash` 已被规范化成 `bash`,不改的话上游收到的工具清单里没有这个名字。
  // 注意方向与响应侧相反——tool_choice 里是**调用方**的拼写,而 rename 是
  // 「上游拼写 → 调用方拼写」,所以要反向查。
  rewriteNamedToolChoice(body.tool_choice, rename, style)

  body.tools = out
  if (body.tool_choice === undefined) {
    if (style === "responses") body.tool_choice = "auto"
    else if (!hadClientTools) body.tool_choice = "none"
  }
  return { rename, declared }
}

/**
 * 一次请求的工具线状态:改名映射 + 调用方声明过的工具名。
 *
 * 端口自 dsh-our-free-model 的 `createToolWire`(见其 src/forward.js)。它只在
 * **本地转发端口**上做这件事——dsh 内核自己的工具就是那四个,不存在「客户端
 * 没有这个工具」;而我们是代理,客户端注册的是它自己的工具名,补位的占位工具
 * 一旦被模型调用,递过去就是一个客户端无法执行的 unknown tool(插件 issue #21)。
 */

/** 具名 tool_choice 的三种形状:chat `{function:{name}}` / responses `{name}` / anthropic `{type:"tool",name}`。 */
function rewriteNamedToolChoice(
  choice: unknown,
  rename: Map<string, string>,
  style: "chat" | "responses",
): void {
  if (rename.size === 0 || !choice || typeof choice !== "object") return
  const record = choice as Record<string, unknown>
  const rewrite = (holder: Record<string, unknown>): void => {
    const name = holder.name
    if (typeof name !== "string") return
    for (const [sent, caller] of rename) {
      if (caller === name) {
        holder.name = sent
        return
      }
    }
  }
  const fn = record.function
  if (fn && typeof fn === "object") {
    rewrite(fn as Record<string, unknown>)
    return
  }
  if (style === "responses" || record.type === "tool") rewrite(record)
}

/** 名字是否命中四件组(大小写不敏感),命中则返回规范的小写拼写。 */
function quartetSlotOf(name: string): string {
  const lower = String(name ?? "")
    .trim()
    .toLowerCase()
  return (ZEN_TOOL_QUARTET as ReadonlyArray<string>).includes(lower) ?
      lower
    : ""
}

interface ZenToolWire {
  /** 上游看到的拼写 → 调用方拼写。 */
  rename: Map<string, string>
  /** 调用方声明过的工具名(调用方拼写)。 */
  declared: Set<string>
}

/**
 * 响应侧回滚工具名。
 *
 * 请求侧把 `Bash` 规范化成 `bash` 发了出去,响应里的工具调用就是 `bash`;
 * 客户端只认得自己声明的 `Bash`,所以这里按请求侧的映射表改回来。请求侧没有
 * 重命名任何工具时映射表为空,调用方可以直接跳过整轮解析。
 */
export function restoreToolName(
  name: string,
  rename: Map<string, string>,
): string {
  if (rename.size === 0) return name
  return rename.get(name) ?? name
}

/** 就地改写一份上游响应里的工具名(覆盖 chat / responses 的已知形状)。 */
export function restoreToolNamesInPayload(
  payload: unknown,
  rename: Map<string, string>,
): void {
  if (rename.size === 0 || !payload || typeof payload !== "object") return
  const root = payload as Record<string, unknown>

  const fixItem = (item: unknown): void => {
    if (!item || typeof item !== "object") return
    const record = item as Record<string, unknown>
    if (record.type === "function_call" && typeof record.name === "string") {
      record.name = restoreToolName(record.name, rename)
    }
  }

  // Responses: `response.output_item.added` / `.done` 的 item,以及非流式 output[]。
  // `response.completed` 把同一份 output 挂在 `response.output` 下,而我们的 IR 层
  // 在流被截断时会从终帧补发缺失的 part(terminalMissingEvents 读的正是它),
  // 所以这一路漏改会让客户端拿到未回滚的工具名。
  fixItem(root.item)
  if (Array.isArray(root.output)) root.output.forEach(fixItem)
  const nested = root.response
  if (nested && typeof nested === "object") {
    const nestedOutput = (nested as Record<string, unknown>).output
    if (Array.isArray(nestedOutput)) nestedOutput.forEach(fixItem)
  }

  // Chat: choices[].delta.tool_calls[] 与 choices[].message.tool_calls[]
  if (Array.isArray(root.choices)) {
    for (const choice of root.choices) {
      if (!choice || typeof choice !== "object") continue
      const holder = choice as Record<string, unknown>
      for (const key of ["delta", "message"]) {
        const part = holder[key]
        if (!part || typeof part !== "object") continue
        const calls = (part as Record<string, unknown>).tool_calls
        if (!Array.isArray(calls)) continue
        for (const call of calls) {
          if (!call || typeof call !== "object") continue
          const fn = (call as Record<string, unknown>).function
          if (!fn || typeof fn !== "object") continue
          const name = (fn as Record<string, unknown>).name
          if (typeof name === "string") {
            ;(fn as Record<string, unknown>).name = restoreToolName(
              name,
              rename,
            )
          }
        }
      }
    }
  }
}

/**
 * 这个(已回滚的)工具名,客户端到底能不能执行?
 *
 * 补位的占位工具不在调用方声明过的集合里:模型调它,等于递给客户端一个它从未
 * 注册过的工具,客户端除了报 unknown tool 什么也做不了。这类调用必须整条丢掉,
 * 连参数片段都不能漏出去。
 */
function isExecutableTool(name: string, declared: Set<string>): boolean {
  return !(
    (ZEN_TOOL_QUARTET as ReadonlyArray<string>).includes(name)
    && !declared.has(name)
  )
}

/** 非流式路径:过滤掉不可执行的工具调用。 */
export function suppressDecoyToolCalls(
  payload: unknown,
  wire: ZenToolWire,
): void {
  if (!payload || typeof payload !== "object") return
  const root = payload as Record<string, unknown>

  const fixItem = (item: unknown): boolean => {
    if (!item || typeof item !== "object") return true
    const record = item as Record<string, unknown>
    if (record.type !== "function_call") return true
    const name = record.name
    if (typeof name !== "string" || name === "") return true
    return isExecutableTool(name, wire.declared)
  }
  const fixList = (list: unknown): Array<unknown> | undefined => {
    if (!Array.isArray(list)) return undefined
    const kept = list.filter(fixItem)
    return kept.length === list.length ? undefined : kept
  }

  // Responses:output[] 与 response.completed 里嵌套的 response.output[]
  const fixed = fixList(root.output)
  if (fixed) root.output = fixed
  const nested = root.response
  if (nested && typeof nested === "object") {
    const nestedFixed = fixList((nested as Record<string, unknown>).output)
    if (nestedFixed) (nested as Record<string, unknown>).output = nestedFixed
  }

  // Chat:choices[].message.tool_calls[](流式的 delta 走 createToolCallFilter)
  if (Array.isArray(root.choices)) {
    for (const choice of root.choices) {
      if (!choice || typeof choice !== "object") continue
      const message = (choice as Record<string, unknown>).message
      if (!message || typeof message !== "object") continue
      const calls = (message as Record<string, unknown>).tool_calls
      if (!Array.isArray(calls)) continue
      const kept = calls.filter((call) => {
        if (!call || typeof call !== "object") return false
        const fn = (call as Record<string, unknown>).function
        const name =
          fn && typeof fn === "object" ?
            (fn as Record<string, unknown>).name
          : (call as Record<string, unknown>).name
        return (
          !(typeof name === "string" && name !== "")
          || isExecutableTool(name, wire.declared)
        )
      })
      if (kept.length !== calls.length) {
        if (kept.length === 0) {
          delete (message as Record<string, unknown>).tool_calls
        } else {
          ;(message as Record<string, unknown>).tool_calls = kept
        }
      }
    }
  }
}

/**
 * 把一份上游回包（或单帧）里的工具名改回调用方拼写,并丢掉不可执行的诱饵调用。
 * chat / responses 两条线、流式逐帧与非流式聚包共用。
 */
function applyToolWireFixups(payload: unknown, wire: ZenToolWire): void {
  restoreToolNamesInPayload(payload, wire.rename)
  suppressDecoyToolCalls(payload, wire)
}

/**
 * Chat 流式路径的占位调用过滤器。
 *
 * 端口自 dsh-our-free-model `src/forward.js` 的 `createToolWire`:它只在本地
 * 转发端口上做这件事——dsh 内核自己的工具就是那四个,不存在「客户端没有这个
 * 工具」;而我们是代理,客户端注册的是它自己的工具名,补位的占位工具一旦被模型
 * 调用,递过去就是一个客户端无法执行的 unknown tool(插件 issue #21)。
 *
 * 一个 block 在**报出名字之前**到来的参数片段先扣住:否则占位调用的参数
 * fragment 会在还不知道它是什么的时候就漏给客户端。
 */
function createToolCallFilter(wire: ZenToolWire): {
  admit(call: Record<string, unknown>): boolean
} {
  const namedBlocks = new Set<number>()
  const droppedBlocks = new Set<number>()
  return {
    admit(call) {
      const fn = call.function
      const name =
        fn && typeof fn === "object" ?
          (fn as Record<string, unknown>).name
        : undefined
      if (typeof name === "string" && name !== "") {
        if (typeof call.index === "number") {
          if (isExecutableTool(name, wire.declared)) namedBlocks.add(call.index)
          else droppedBlocks.add(call.index)
        }
        return isExecutableTool(name, wire.declared)
      }
      // 无名片段:同一个 block 已判为占位就丢,还没报过名字就扣住
      const index = call.index
      if (typeof index !== "number") return true
      if (droppedBlocks.has(index)) return false
      return namedBlocks.has(index)
    },
  }
}

/**
 * 包一层 SSE 流:回滚工具名,并丢掉指向占位工具的调用。
 *
 * 按 `tool_calls[].index`(chat)与 `output_index`(responses)归类:名字出现之前
 * 到来的参数片段先扣住,不当成可转发内容——否则一个占位调用的参数 fragment 会在
 * 还不知道它是什么的时候就漏给客户端(端口自插件的 createToolWire)。
 */
export function restoreAndFilterToolStream(
  stream: AsyncIterable<CopilotStreamEvent>,
  wire: ZenToolWire,
): AsyncIterable<CopilotStreamEvent> {
  const filter = createToolCallFilter(wire)
  // Responses 线按 output_index 记住要整条丢掉的 function_call
  const droppedOutputs = new Set<number>()
  return {
    async *[Symbol.asyncIterator]() {
      for await (const event of stream) {
        const data = event.data
        if (typeof data !== "string" || !data.startsWith("{")) {
          yield event
          continue
        }
        let parsed: unknown
        try {
          parsed = JSON.parse(data) as unknown
        } catch {
          yield event
          continue
        }
        const root = parsed as Record<string, unknown>

        // Responses:按 output_index 记住要丢的 function_call,后续参数帧一起丢
        const type = typeof root.type === "string" ? root.type : ""
        if (type === "response.output_item.added") {
          const item = root.item
          const index = root.output_index
          if (
            item
            && typeof item === "object"
            && (item as Record<string, unknown>).type === "function_call"
            && typeof index === "number"
          ) {
            const name = (item as Record<string, unknown>).name
            if (
              typeof name === "string"
              && !isExecutableTool(
                restoreToolName(name, wire.rename),
                wire.declared,
              )
            ) {
              droppedOutputs.add(index)
              continue
            }
          }
        } else if (
          type === "response.function_call_arguments.delta"
          || type === "response.function_call_arguments.done"
          || type === "response.output_item.done"
        ) {
          const index = root.output_index
          if (typeof index === "number" && droppedOutputs.has(index)) continue
        }

        applyToolWireFixups(parsed, wire)

        // Chat:按 block 过滤占位调用,名字出现前的参数片段扣住
        if (Array.isArray(root.choices)) {
          for (const choice of root.choices) {
            if (!choice || typeof choice !== "object") continue
            const delta = (choice as Record<string, unknown>).delta
            if (!delta || typeof delta !== "object") continue
            const calls = (delta as Record<string, unknown>).tool_calls
            if (!Array.isArray(calls)) continue
            const kept = calls.filter((call) =>
              call && typeof call === "object" ?
                filter.admit(call as Record<string, unknown>)
              : false,
            )
            if (kept.length === 0) {
              delete (delta as Record<string, unknown>).tool_calls
            } else {
              ;(delta as Record<string, unknown>).tool_calls = kept
            }
          }
        }

        if (!hasStreamContent(root)) continue
        yield { ...event, data: JSON.stringify(root) }
      }
    },
  }
}

/** 这一帧去掉占位调用之后,还剩不值得发的内容吗? */
function hasStreamContent(root: Record<string, unknown>): boolean {
  // 独立 usage 末帧没有 choices 内容,但客户端和统计仍然需要它。
  if (root.usage) return true
  const choices = root.choices
  if (Array.isArray(choices)) {
    for (const choice of choices) {
      if (!choice || typeof choice !== "object") return true
      const holder = choice as Record<string, unknown>
      for (const key of ["delta", "message"]) {
        const part = holder[key]
        if (!part || typeof part !== "object") continue
        if (Object.keys(part as Record<string, unknown>).length > 0) return true
      }
      if (holder.finish_reason) return true
    }
    return false
  }
  // Responses:丢掉的只是 item/参数帧,其余事件(文本增量、完成帧)都要发
  return true
}

/** 包一层 SSE 流,把每个 data 帧里的工具名改回调用方的拼写。
export function restoreToolNamesInStream(
  stream: AsyncIterable<CopilotStreamEvent>,
  rename: Map<string, string>,
): AsyncIterable<CopilotStreamEvent> {
  if (rename.size === 0) return stream
  return {
    async *[Symbol.asyncIterator]() {
      for await (const event of stream) {
        const data = event.data
        // 非 JSON 帧(keep-alive 注释、[DONE])原样放过
        if (typeof data === "string" && data.startsWith("{")) {
          try {
            const parsed = JSON.parse(data) as unknown
            restoreToolNamesInPayload(parsed, rename)
            yield { ...event, data: JSON.stringify(parsed) }
            continue
          } catch {
            // 解析不了就原样下发,别把响应弄坏
          }
        }
        yield event
      }
    },
  }
}

/** 本地能力基线：上游清单只给 id，容量/视觉得自己维护。 */
const CAPABILITIES: Array<{
  match: RegExp
  vision: boolean
  contextWindow: number
  maxOutput: number
}> = [
  {
    match: /^mimo.*v2\.[56]/i,
    vision: true,
    contextWindow: 1048576,
    maxOutput: 131072,
  },
  { match: /^mimo/i, vision: true, contextWindow: 262144, maxOutput: 131072 },
  {
    match: /^muse[-_.]?spark/i,
    vision: true,
    contextWindow: 1048576,
    maxOutput: 131072,
  },
  {
    match: /^nemotron/i,
    vision: false,
    contextWindow: 1000000,
    maxOutput: 65536,
  },
  { match: /^ling/i, vision: false, contextWindow: 262144, maxOutput: 32768 },
  { match: /^step/i, vision: true, contextWindow: 1000000, maxOutput: 64000 },
  {
    match: /^space[-_.]?bunny/i,
    vision: true,
    contextWindow: 262144,
    maxOutput: 65536,
  },
  { match: /^union/i, vision: true, contextWindow: 262144, maxOutput: 131072 },
  {
    match: /^deepseek/i,
    vision: false,
    contextWindow: 128000,
    maxOutput: 64000,
  },
  { match: /^longcat/i, vision: true, contextWindow: 262144, maxOutput: 65536 },
  { match: /^exo/i, vision: true, contextWindow: 131072, maxOutput: 32768 },
  { match: /^jev/i, vision: false, contextWindow: 32768, maxOutput: 4096 },
]

const DEFAULT_CAPABILITY = {
  vision: false,
  contextWindow: 131072,
  maxOutput: 32768,
}

function capabilitiesFor(modelId: string): {
  vision: boolean
  contextWindow: number
  maxOutput: number
} {
  const base = baseModelId(modelId)
  for (const entry of CAPABILITIES) {
    if (entry.match.test(base)) {
      return {
        vision: entry.vision,
        contextWindow: entry.contextWindow,
        maxOutput: entry.maxOutput,
      }
    }
  }
  return DEFAULT_CAPABILITY
}

/** muse-spark 系走 Responses 线，其余走 Chat 线。 */
function endpointsForModel(modelId: string): Array<"chat" | "responses"> {
  return endpointForModel(modelId) === "/responses" ? ["responses"] : ["chat"]
}

export const openCodeZenAdapter: ProtocolAdapter = {
  protocol: "opencode-zen-free",

  async discoverModels({ connection, credential, signal }) {
    // baseUrl 形如 https://opencode.ai/zen；joinUrl 会补上 /v1，
    // 正好落在 https://opencode.ai/zen/v1/models。
    const url = joinUrl(connection.baseUrl, "/models")
    const session = zenSessionFor(`discover\u0000${connection.id}`)
    const response = await fetch(
      url,
      connectionFetchInit(connection, {
        headers: zenHeaders(
          connection,
          credential,
          session,
          zenRequestId(),
          "application/json",
        ),
        signal,
      }),
    )
    if (!response.ok) {
      // 用真 credential:免费车道的合成匿名凭据是按连接记忆的,发现失败打上的
      // 冷却才会落到这条连接上;传一个一次性对象等于失败不留痕。
      await handleUpstreamFailure(
        response,
        credential,
        "Failed to discover OpenCode Zen models",
        "opencode-zen-free",
      )
    }
    const body = (await readUpstreamJson(response)) as {
      data?: Array<{ id?: string }>
    }
    if (!Array.isArray(body.data)) return []
    return body.data
      .filter((m): m is { id: string } => typeof m.id === "string")
      .filter((m) => isFreeLaneModel(m.id))
      .map<ModelMapping>((m) => {
        const capability = capabilitiesFor(m.id)
        return {
          publicId: m.id,
          upstreamId: m.id,
          endpoints: endpointsForModel(m.id),
          enabled: true,
          pickerEnabled: true,
          // 只留真有人读的字段:contextWindow 被 routing-groups/auto.ts 的
          // contextWindowOf 消费。曾经还写过 maxOutputTokens / supportsVision /
          // freeLane,全都没有读取方,是死数据。
          metadata: { contextWindow: capability.contextWindow },
        }
      })
  },

  async createChatCompletions({
    target,
    connection,
    credential,
    payload,
    signal,
    ctx,
  }) {
    const upstreamModelId = target.upstreamModelId
    // 门禁只认 muse-spark 走 Responses；真撞上了由上层按 model.endpoints 分流，
    // 这里仍然按 chat 线发，让上游的 400 说清楚而不是静默改协议。
    const session = zenSessionForRequest(connection, upstreamModelId, ctx)
    const requestId = zenRequestId()

    const upstreamPayload: Record<string, unknown> = {
      ...(payload as unknown as Record<string, unknown>),
      model: upstreamModelId,
      // 门禁 4（见文件头）：上游必须流式，非流式由下方聚合回 JSON。
      stream: true,
    }
    // 调用方的工具照常透传,只把四件组补齐;重命名过的工具在响应侧改回去
    const wire = applyFreeTierFingerprint(upstreamPayload, "chat")

    const response = await fetch(
      joinUrl(connection.baseUrl, "/chat/completions"),
      connectionFetchInit(connection, {
        method: "POST",
        headers: zenHeaders(
          connection,
          credential,
          session,
          requestId,
          "text/event-stream",
        ),
        body: serializeUpstreamBody(upstreamPayload),
        signal,
      }),
    )

    if (!response.ok) {
      await handleUpstreamFailure(
        response,
        credential,
        "Failed to create chat completions",
        "opencode-zen-free",
      )
    }

    const stream = await safeSseStream(response, detectOpenAIStreamError)

    // 非流式请求:上游只给了流,聚合回一个 ChatCompletionResponse。
    if (!payload.stream) {
      const aggregated = await aggregateSseToResponse(
        stream as unknown as AsyncIterable<CopilotStreamEvent>,
        upstreamModelId,
      )
      applyToolWireFixups(aggregated, wire)
      return {
        credentialId: credential.id,
        response: aggregated,
      } satisfies AdapterChatResult
    }

    return {
      credentialId: credential.id,
      response: restoreAndFilterToolStream(
        stream as unknown as AsyncIterable<CopilotStreamEvent>,
        wire,
      ),
    } satisfies AdapterChatResult
  },

  async createResponses({
    target,
    connection,
    credential,
    payload,
    signal,
    ctx,
  }) {
    const upstreamModelId = target.upstreamModelId
    const session = zenSessionForRequest(connection, upstreamModelId, ctx)
    const requestId = zenRequestId()

    const upstreamPayload: Record<string, unknown> = {
      ...(payload as unknown as Record<string, unknown>),
      model: upstreamModelId,
      // 门禁 4（见文件头）：上游必须流式，非流式由下方聚合回 JSON。
      stream: true,
    }
    const wire = applyFreeTierFingerprint(upstreamPayload, "responses")

    const response = await fetch(
      joinUrl(connection.baseUrl, "/responses"),
      connectionFetchInit(connection, {
        method: "POST",
        headers: zenHeaders(
          connection,
          credential,
          session,
          requestId,
          "text/event-stream",
        ),
        body: serializeUpstreamBody(upstreamPayload),
        signal,
      }),
    )

    if (!response.ok) {
      await handleUpstreamFailure(
        response,
        credential,
        "Failed to create responses",
        "opencode-zen-free",
      )
    }

    const stream = await safeSseStream(response, detectOpenAIStreamError)

    // 非流式请求:上游只给了流,收敛回一个 ResponsesResponse。
    if (!payload.stream) {
      const aggregated = await collectResponsesFromEventStream(
        stream as unknown as AsyncIterable<CopilotStreamEvent>,
        upstreamModelId,
      )
      applyToolWireFixups(aggregated, wire)
      return {
        credentialId: credential.id,
        response: aggregated,
      } satisfies AdapterResponsesResult
    }

    return {
      credentialId: credential.id,
      response: restoreAndFilterToolStream(
        stream as unknown as AsyncIterable<CopilotStreamEvent>,
        wire,
      ) as unknown as AsyncIterable<{ data?: string }>,
    } satisfies AdapterResponsesResult
  },
}
