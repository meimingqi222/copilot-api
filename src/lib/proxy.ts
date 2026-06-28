import { getProxyForUrl } from "proxy-from-env"
import { Agent, ProxyAgent, setGlobalDispatcher, Dispatcher } from "undici"

import { logger } from "~/lib/logger"

class EnvProxyAgent extends Dispatcher {
  private direct = new Agent()
  private proxies = new Map<string, ProxyAgent>()

  override dispatch(
    options: Dispatcher.DispatchOptions,
    handler: Dispatcher.DispatchHandler,
  ): boolean {
    try {
      const origin =
        typeof options.origin === "string" ?
          new URL(options.origin)
        : (options.origin as URL)

      const getProxy = getProxyForUrl as (u: string) => string | undefined
      const raw = getProxy(origin.toString())
      const proxyUrl = raw && raw.length > 0 ? raw : undefined

      if (!proxyUrl) {
        logger.debug(`HTTP proxy bypass: ${origin.hostname}`)
        return this.direct.dispatch(options, handler)
      }

      let agent = this.proxies.get(proxyUrl)
      if (!agent) {
        agent = new ProxyAgent(proxyUrl)
        this.proxies.set(proxyUrl, agent)
      }

      let label = proxyUrl
      try {
        const u = new URL(proxyUrl)
        label = `${u.protocol}//${u.host}`
      } catch {
        /* noop */
      }

      logger.debug(`HTTP proxy route: ${origin.hostname} via ${label}`)
      return agent.dispatch(options, handler)
    } catch {
      return this.direct.dispatch(options, handler)
    }
  }

  override async close(): Promise<void> {
    await Promise.all([
      this.direct.close(),
      ...Array.from(this.proxies.values()).map((p) => p.close()),
    ])
    this.proxies.clear()
  }

  override async destroy(): Promise<void> {
    await Promise.all([
      this.direct.destroy(),
      ...Array.from(this.proxies.values()).map((p) => p.destroy()),
    ])
    this.proxies.clear()
  }
}

export function initProxyFromEnv(): void {
  if (typeof Bun !== "undefined") return

  try {
    setGlobalDispatcher(new EnvProxyAgent())
    logger.debug("HTTP proxy configured from environment (per-URL)")
  } catch (err) {
    logger.debug("Proxy setup skipped:", err)
  }
}
