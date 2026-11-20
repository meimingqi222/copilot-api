import { randomUUID } from "node:crypto"
import { setTimeout as delay } from "node:timers/promises"

import {
  LocalUnavailableError,
  UpstreamModelUnavailableError,
} from "~/lib/error"
import { asNumber, asRecord, asStringFieldOrEmpty } from "~/lib/json-shape"
import type { ProviderQuotaSnapshot } from "~/lib/quota/types"
import {
  effortLabel,
  fallbackModels,
  modelsFromBriefList,
  modelsFromMenu,
  quotaSnapshot,
  type WorkModel,
} from "~/services/doubao-work/catalog"
import type { DesktopHost, DesktopPage } from "~/services/doubao-work/desktop"
import {
  briefList,
  fillPrompt,
  newTask,
  pageState,
  readQuota,
  readReply,
  selectCloud,
  selectEffort,
  selectModel,
  sendPrompt,
  workMenu,
} from "~/services/doubao-work/page"

class DesktopUnavailable extends LocalUnavailableError {
  constructor(message: string, status = 503) {
    super(message, new Response(null, { status }), message)
  }
}

// Once a task has been sent, failover must not submit a duplicate task.
function failure(message: string, status = 502): DesktopUnavailable {
  return new DesktopUnavailable(message, status)
}

export interface WorkConnection {
  id: string
  secret: string
}

interface WorkRequest extends WorkConnection {
  model: string
  effort: unknown
  prompt: string
  signal?: AbortSignal
  onUpdate?(reply: WorkReply): void
}

export interface WorkReply {
  text: string
  reasoning: string
  usage: unknown
}

interface WorkCatalog {
  models: Array<WorkModel>
  readAt: number
}

const catalogAge = 6 * 60 * 60_000
const discoveryInterval = 60_000

async function signedInAs(
  page: DesktopPage,
  signal?: AbortSignal,
): Promise<string> {
  return asStringFieldOrEmpty(
    asRecord(await page.eval(pageState, signal)),
    "name",
  )
}

async function cloudTask(
  page: DesktopPage,
  signal?: AbortSignal,
): Promise<void> {
  if ((await page.eval(newTask, signal)) !== true)
    throw new DesktopUnavailable("Could not open a fresh Doubao Work task.")
  if ((await page.eval(selectCloud, signal)) !== true)
    throw new DesktopUnavailable(
      "Doubao Work cloud mode (云电脑) could not be verified.",
    )
}

async function pollReply(
  page: DesktopPage,
  request: WorkRequest,
  account: string,
  poll: number,
): Promise<WorkReply> {
  const start = Date.now()
  const expression = readReply(request.prompt, account)
  let changed = start
  let previous: WorkReply | undefined
  let replyId: string | undefined
  for (;;) {
    if (Date.now() - start > 15 * 60_000)
      throw failure("Doubao Work exceeded the 15-minute reply limit.", 504)
    await delay(poll, undefined, { signal: request.signal })
    const result = asRecord(await page.eval(expression, request.signal))
    if (result?.mismatched === true)
      throw failure(
        "The Doubao Work task did not match the submitted prompt and account.",
      )
    const sends = asNumber(result?.sends)
    if (sends !== 1) {
      if (replyId || (sends ?? 0) > 1)
        throw failure("The Doubao Work task changed while reading its reply.")
      if (Date.now() - start > 15_000)
        throw failure("Doubao Work did not send the prompt.")
      continue
    }
    const id = asStringFieldOrEmpty(result, "id")
    if (!id) {
      if (replyId)
        throw failure("The Doubao Work task changed while reading its reply.")
      if (Date.now() - start > 120_000)
        throw failure("Doubao Work did not reply within two minutes.", 504)
      continue
    }
    if (replyId && replyId !== id)
      throw failure("The Doubao Work reply changed unexpectedly.")
    replyId = id
    const reply = {
      text: asStringFieldOrEmpty(result, "text"),
      reasoning: asStringFieldOrEmpty(result, "reasoning"),
      usage: result?.usage,
    }
    if (
      result?.finished === true
      && result.failed === true
      && !reply.text
      && !reply.reasoning
    ) {
      throw failure("Doubao Work did not complete its reply.")
    }
    if (
      !previous
      || reply.text !== previous.text
      || reply.reasoning !== previous.reasoning
    ) {
      changed = Date.now()
      if (reply.text || reply.reasoning) request.onUpdate?.(reply)
    }
    previous = reply
    if (result?.finished === true) return reply
    if (Date.now() - changed > 180_000)
      throw failure(
        "Doubao Work stopped updating its reply for three minutes.",
        504,
      )
  }
}

export class DoubaoWorkBridge {
  #host: DesktopHost
  #poll: number
  #tail = Promise.resolve()
  #jobs = 0
  #pending?: { id: string; nonce: string; expiresAt: number }
  #catalogs = new Map<string, WorkCatalog>()
  #lastDiscovery = new Map<string, number>()

  constructor(host: DesktopHost, poll = 150) {
    this.#host = host
    this.#poll = poll
  }

  #serialize<T>(run: () => Promise<T>): Promise<T> {
    this.#jobs++
    const result = this.#tail.then(run)
    this.#tail = result.then(
      () => {
        this.#jobs--
      },
      () => {
        this.#jobs--
      },
    )
    return result
  }

  startSignIn(): Promise<{ nonce: string; expiresAt: number }> {
    return this.#serialize(async () => {
      const id = this.#pending?.id ?? (await this.#host.newProfile())
      this.#pending = {
        id,
        nonce: randomUUID(),
        expiresAt: Date.now() + 300_000,
      }
      const page = await this.#host.open(id, true)
      if (!page)
        throw new DesktopUnavailable(
          "Doubao Work did not open its dedicated desktop window.",
        )
      page.close()
      return { nonce: this.#pending.nonce, expiresAt: this.#pending.expiresAt }
    })
  }

  cancelSignIn(nonce: string): Promise<void> {
    return this.#serialize(async () => {
      const pending = this.#pending
      // Idempotent for a stale nonce; never close a confirmed or newer profile.
      if (!pending || pending.nonce !== nonce) return
      await this.#host.closePendingProfile(pending.id)
      this.#pending = undefined
    })
  }

  finishSignIn(
    nonce: string,
  ): Promise<WorkConnection & { models: ReadonlyArray<WorkModel> }> {
    return this.#serialize(async () => {
      const pending = this.#pending
      if (
        !pending
        || pending.nonce !== nonce
        || pending.expiresAt <= Date.now()
      ) {
        throw new Error("Start a new Doubao Work desktop sign-in first.")
      }
      const page = await this.#host.open(pending.id, false)
      if (!page)
        throw new Error("Open the dedicated Doubao Work sign-in window first.")
      try {
        const account = await signedInAs(page)
        if (!account)
          throw new Error(
            "Sign in manually inside the dedicated Doubao Work window, then confirm again.",
          )
        const models = await this.#discover(pending.id, page, false)
        const secret = randomUUID()
        await this.#host.saveBinding(pending.id, { secret, account })
        this.#pending = undefined
        return { id: pending.id, secret, models }
      } finally {
        page.close()
      }
    })
  }

  async #account(connection: WorkConnection): Promise<string> {
    const binding = await this.#host.loadBinding(connection.id)
    if (
      !binding
      || !connection.secret
      || binding.secret !== connection.secret
    ) {
      throw new DesktopUnavailable(
        "Explicitly connect a dedicated Doubao Work desktop profile on this server first.",
      )
    }
    return binding.account
  }

  async #withPage<T>(
    connection: WorkConnection,
    launch: boolean,
    signal: AbortSignal | undefined,
    run: (page: DesktopPage, account: string) => Promise<T>,
  ): Promise<T | undefined> {
    signal?.throwIfAborted()
    const account = await this.#account(connection)
    let page: DesktopPage | undefined
    try {
      page = await this.#host.open(connection.id, launch, signal)
    } catch (error) {
      signal?.throwIfAborted()
      throw new DesktopUnavailable(
        error instanceof Error ?
          error.message
        : "Doubao Work could not open its dedicated profile.",
      )
    }
    if (!page) return undefined
    try {
      if ((await signedInAs(page, signal)) !== account)
        throw new DesktopUnavailable(
          "The connected Doubao Work account is not signed in. Check the dedicated desktop window.",
        )
      return await run(page, account)
    } finally {
      page.close()
    }
  }

  async #discover(
    id: string,
    page: DesktopPage,
    inTask: boolean,
    signal?: AbortSignal,
  ): Promise<ReadonlyArray<WorkModel>> {
    this.#lastDiscovery.set(id, Date.now())
    try {
      const models = modelsFromBriefList(await page.eval(briefList, signal))
      if (models.length) {
        this.#catalogs.set(id, { models, readAt: Date.now() })
        return models
      }
    } catch (error) {
      signal?.throwIfAborted()
      // An unavailable brief_list is expected on some app versions; use the Work menu.
      if (!(error instanceof Error)) throw error
    }
    try {
      if (!inTask) await cloudTask(page, signal)
      const models = modelsFromMenu(await page.eval(workMenu, signal))
      if (models.length) this.#catalogs.set(id, { models, readAt: Date.now() })
    } catch (error) {
      signal?.throwIfAborted()
      if (!(error instanceof Error)) throw error
    }
    return this.#catalogs.get(id)?.models ?? fallbackModels
  }

  refreshModels(
    connection: WorkConnection,
    signal?: AbortSignal,
  ): Promise<ReadonlyArray<WorkModel> | undefined> {
    if (
      this.#jobs
      || Date.now() - (this.#lastDiscovery.get(connection.id) ?? 0)
        < discoveryInterval
    ) {
      return Promise.resolve(this.#catalogs.get(connection.id)?.models)
    }
    return this.#serialize(() =>
      this.#withPage(connection, false, signal, (page) =>
        this.#discover(connection.id, page, false, signal),
      ),
    )
  }

  quota(
    connection: WorkConnection,
    signal?: AbortSignal,
  ): Promise<ProviderQuotaSnapshot | undefined> {
    if (this.#jobs) return Promise.resolve(undefined)
    return this.#serialize(() =>
      this.#withPage(connection, false, signal, async (page) =>
        quotaSnapshot(await page.eval(readQuota, signal)),
      ),
    )
  }

  ask(
    request: WorkRequest,
    saved: ReadonlyArray<WorkModel> = [],
  ): Promise<WorkReply> {
    return this.#serialize(async () => {
      const result = await this.#withPage(
        request,
        true,
        request.signal,
        async (page, account) => {
          const signal = request.signal
          await cloudTask(page, signal)
          const find = (models: ReadonlyArray<WorkModel>) =>
            models.find((model) =>
              [model.id, model.label, model.key].includes(request.model),
            )
          const cached = this.#catalogs.get(request.id)
          let model = find(cached?.models ?? saved) ?? find(fallbackModels)
          if (
            (!model || Date.now() - (cached?.readAt ?? 0) > catalogAge)
            && Date.now() - (this.#lastDiscovery.get(request.id) ?? 0)
              >= discoveryInterval
          ) {
            const refreshed = await this.#discover(
              request.id,
              page,
              true,
              signal,
            )
            model = find(refreshed) ?? model
          }
          if (!model)
            throw new UpstreamModelUnavailableError(
              "Unknown Doubao Work model.",
              new Response(null, { status: 404 }),
            )
          let selected = await page.eval(selectModel(model.label), signal)
          if (selected === "missing") {
            await page.reload(signal)
            let ready = false
            for (let i = 0; i < 30; i++) {
              await delay(500, undefined, { signal })
              if (
                (await signedInAs(page, signal).catch(() => "")) === account
              ) {
                ready = true
                break
              }
            }
            if (!ready)
              throw new DesktopUnavailable(
                "Could not reverify the dedicated Doubao Work account after reload.",
              )
            await cloudTask(page, signal)
            selected = await page.eval(selectModel(model.label), signal)
          }
          if (selected === "upgrade")
            throw new UpstreamModelUnavailableError(
              "The Doubao Work model requires a subscription upgrade.",
              new Response(null, { status: 403 }),
            )
          if (selected !== "selected")
            throw new DesktopUnavailable(
              "Doubao Work did not select the requested cloud model.",
            )
          const effort = effortLabel(model, request.effort)
          if (
            effort
            && (await page.eval(selectEffort(effort), signal)) !== true
          )
            throw new DesktopUnavailable(
              "Doubao Work did not select the requested reasoning level.",
            )
          if (
            (await page.eval(fillPrompt(request.prompt, account), signal))
            !== true
          )
            throw new DesktopUnavailable(
              "Doubao Work refused to fill the verified cloud task.",
            )
          signal?.throwIfAborted()
          try {
            if (
              (await page.eval(
                sendPrompt(request.prompt, account, model.label, effort),
                signal,
              )) !== true
            ) {
              throw new DesktopUnavailable(
                "Doubao Work could not verify the cloud task and its send button. No retry was sent.",
              )
            }
            return await pollReply(page, request, account, this.#poll)
          } catch (error) {
            signal?.throwIfAborted()
            if (error instanceof DesktopUnavailable) throw error
            throw failure(
              "The Doubao Work task could not be tracked after send. No retry was sent.",
            )
          }
        },
      )
      if (!result)
        throw new DesktopUnavailable(
          "Doubao Work did not open its dedicated desktop window.",
        )
      return result
    })
  }
}
