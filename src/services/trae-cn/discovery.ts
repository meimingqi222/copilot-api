/**
 * Trae 账号模型列表的按需读取与缓存（ported from magpie 的 readList/runRead）。
 *
 * 一次读取按连接缓存 5 分钟（REREAD_MS），无论它是否给出某模型的条目——
 * 列表失败或不含该模型时，只付一次读取而不是每请求一次。读取在途时并发
 * 请求共享同一次（标题请求与首轮、子代理一起到达），都看到它读出的结果。
 * 登出（expired）记在记录上而非抛出：请求路径吞掉它（chat 仍能应答），
 * 目录刷新（strict）则重新读取并上报，避免把缓存的登出当成新结论。
 */

import { getConnectionProxyUrl } from "~/lib/provider-connections"
import type { ProviderConnection } from "~/lib/provider-connections"
import { HTTPError } from "~/lib/error"
import { ensureOAuthConnectionAccessToken } from "~/services/oauth/ensure-access-token"
import { oauthFetch } from "~/services/oauth/fetch"
import { traeCnAccount, traeCnLapsed } from "~/services/oauth/trae-cn"
import {
  traeCnIdeHeaders,
  traeCnListModels,
  traeRateOf,
  type TraeCnListedModel,
  type TraeCnPostResult,
} from "~/services/trae-cn/client"
import type { TraeSite } from "~/services/trae-cn/sites"

const REREAD_MS = 5 * 60 * 1000

/** IDE 指纹头的 JSON POST（模型列表用；chat 走 adapter）。 */
async function traeCnPostJson(
  connection: ProviderConnection,
  url: string,
  body: Record<string, unknown>,
): Promise<TraeCnPostResult> {
  const credential = connection.credentials[0]!
  const token = await ensureOAuthConnectionAccessToken(connection, credential)
  const account = traeCnAccount(connection, token)
  const proxyUrl = getConnectionProxyUrl(connection)
  const response = await oauthFetch(
    url,
    {
      method: "POST",
      headers: traeCnIdeHeaders(account, { Accept: "application/json" }),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(20_000),
    },
    proxyUrl ? { proxyUrl } : undefined,
  )
  const text = await response.text()
  let v: Record<string, unknown> = {}
  try {
    v = JSON.parse(text) as Record<string, unknown>
  } catch {
    v = {}
  }
  return { status: response.status, text, v }
}

function isLapsed(error: unknown, site: TraeSite): boolean {
  if (error instanceof HTTPError && error.response.status === 401) return true
  const e = error as { traeCode?: unknown; message?: string }
  return traeCnLapsed(e?.traeCode, String(e?.message ?? ""), site)
}

interface ReadRec {
  at: number
  p: Promise<ReadRec> | null
  done: Array<TraeCnListedModel> | undefined
  expired: unknown
}

const readAt = new Map<string, ReadRec>()

function runRead(
  connection: ProviderConnection,
  who: string,
  site: TraeSite,
): Promise<ReadRec> {
  const rec: ReadRec = {
    at: Date.now(),
    p: null,
    done: undefined,
    expired: null,
  }
  // 记录先于读取落表：在途到达的调用方找到 rec.p 并加入，而不是另起一次。
  readAt.set(who, rec)
  const account = traeCnAccount(connection)
  const body = (async () => {
    try {
      return await traeCnListModels(
        (url, b) => traeCnPostJson(connection, url, b),
        account.apiHost,
        connection.id,
        site,
      )
    } catch (e) {
      if (isLapsed(e, site)) rec.expired = e
      return null
    }
  })()
  body.catch(() => {})
  rec.p = body.then((models) => {
    // 只有这次读取结算自己的记录：更晚的读取可能已替换它。
    if (readAt.get(who) === rec) {
      rec.at = Date.now()
      rec.done = models ?? []
      rec.p = null
    }
    return rec
  })
  rec.p.catch(() => {})
  return rec.p
}

/** 读账号列表（共享在途、5 分钟缓存）；返回模型与是否登出。 */
export async function readTraeCnModels(
  connection: ProviderConnection,
  options: { strict?: boolean } = {},
): Promise<{
  models: Array<TraeCnListedModel> | undefined
  expired: unknown
}> {
  const who = connection.id
  const site = traeCnAccount(connection).site
  const was = readAt.get(who)
  let rec: ReadRec
  if (was === undefined) rec = await runRead(connection, who, site)
  else if (was.p) rec = await was.p
  else if (was.done === undefined || Date.now() - was.at >= REREAD_MS) {
    rec = await runRead(connection, who, site)
  } else if (options.strict && was.expired) {
    rec = await runRead(connection, who, site)
  } else rec = was
  return {
    // Re-evaluate off-peak windows even when the catalog itself is cached.
    models: rec.done?.map(({ rate: _rate, rateWas: _was, ...model }) => ({
      ...model,
      ...traeRateOf({ display_contact_config: model.rateConfig }),
    })),
    expired: rec.expired,
  }
}

/** 企业 console 拒收 chat（4245）后作废旧读取，下次从消费网关重读。 */
export function invalidateTraeCnRead(connectionId: string): void {
  readAt.delete(connectionId)
}

/** 测试用：清空读取缓存。 */
export function __resetTraeCnReadCacheForTest(): void {
  readAt.clear()
}
