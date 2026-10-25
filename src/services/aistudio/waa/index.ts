import { createHash } from "node:crypto"
import vm from "node:vm"
import { gunzipSync } from "node:zlib"

import assets from "~/services/aistudio/waa/assets.json"
import { createProfile, realmProfile } from "~/services/aistudio/waa/profile"
import { orderKeys } from "~/services/aistudio/waa/order"
import { fetchImage } from "~/services/aistudio/waa/image"

/** Authenticated bootstrap inputs. No bootstrap or interpreter fetch occurs here. */
export interface WAAChallenge {
  globalName: string
  program: string
  clientExperimentsStateBlob?: string
  messageId?: string
  interpreterURL?: string
  interpreterHash?: string
}

export interface WAARuntimeState {
  challenge: WAAChallenge
  interpreter: string
  cookie: string
  proxyUrl?: string
  signal?: AbortSignal
}

interface WAARuntime {
  proof(binding: string): Promise<string>
  close(): void
}

type Callback = (...args: unknown[]) => unknown
type Snapshot = (done: (value: unknown) => void, input: unknown[]) => void
type Fill = (text: string, initial: boolean) => void
type Timer = ReturnType<typeof setTimeout>

const shape: unknown = JSON.parse(
  gunzipSync(Buffer.from(assets.shapeGzip, "base64")).toString(),
)
// Preserve the original DOM source in assets; normalize JSC's Window receiver.
const dom = assets.dom
  .replace(
    "const g = globalThis;",
    `const g = globalThis;
Object.defineProperty(g, '__waaReceiver', {configurable:true, get:function(){return this;}});
const receiver = g.__waaReceiver; delete g.__waaReceiver;`,
  )
  .replace(
    "(self === undefined || self === null) && iface === 'Window'",
    "(self === undefined || self === null || self === receiver) && iface === 'Window'",
  )

/** How long the guard program may settle after it reports ready, before the
 * first proof. Tests shorten it; otherwise every adapter test waits 3 s. */
let settleMs = 3000

export function setWaaSettleMsForTest(ms: number): void {
  settleMs = ms
}

/** Compatibility context only: node:vm is NOT a security boundary.
 * Derived from Mag1cFall's MIT runtime, commit 370a313814099b508881807effa2a9d72f2d7e66.
 * Each generation owns this runtime and must close it in finally.
 */
export function createWaaRuntime(state: WAARuntimeState): WAARuntime {
  const profile = createProfile(state.cookie)
  const native = new WeakMap<object, string>()
  const trusted = new WeakMap<object, string>()
  const brands = new WeakMap<object, unknown>()
  const storage: Record<string, unknown> = Object.create(null)
  const handles = new Set<Timer>()
  const images = new Set<Promise<void>>()
  const waiters = new Set<(error: Error) => void>()
  const abort = new AbortController()
  let closed = false
  let failure: Error | undefined
  let topAPI: unknown
  let snapshot: Snapshot | undefined
  let shutdown: Callback | undefined

  function guard(fn: Callback, args: unknown[] = [], self?: unknown) {
    if (closed) return
    try {
      void Promise.resolve(fn.apply(self, args)).catch(fail)
    } catch {
      fail()
    }
  }
  function fail() {
    failure = new Error("WAA asynchronous callback failed")
    close()
  }
  function close() {
    if (closed) return
    closed = true
    state.signal?.removeEventListener("abort", onAbort)
    abort.abort()
    for (const id of handles) {
      clearTimeout(id)
      clearInterval(id)
    }
    handles.clear()
    for (const reject of waiters)
      reject(failure ?? new Error("WAA runtime closed"))
    waiters.clear()
    if (shutdown) {
      try {
        void Promise.resolve(shutdown()).catch(() => {})
      } catch {
        /* Closed already. */
      }
    }
  }
  function onAbort() {
    failure = new Error("WAA runtime aborted")
    close()
  }
  function bounded<T>(
    start: (resolve: (value: T) => void) => void,
  ): Promise<T> {
    return new Promise((resolve, reject) => {
      if (closed) return reject(failure ?? new Error("WAA runtime closed"))
      let finished = false
      const finish = (error?: Error, value?: T) => {
        if (finished) return
        finished = true
        clearTimeout(timer)
        handles.delete(timer)
        waiters.delete(onError)
        if (error) reject(error)
        else resolve(value as T)
      }
      const onError = (error: Error) => finish(error)
      const timer = setTimeout(
        () => finish(new Error("WAA callback timeout")),
        30_000,
      )
      handles.add(timer)
      waiters.add(onError)
      try {
        start((value) => finish(undefined, value))
      } catch {
        finish(new Error("WAA execution failed"))
      }
    })
  }

  function loadImage(address: string, callback: Callback) {
    if (closed) return
    const job = (async () => {
      let loaded = false
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), 15_000)
      handles.add(timeout)
      try {
        loaded = await fetchImage({
          address,
          state,
          profile,
          signal: AbortSignal.any([abort.signal, controller.signal]),
        })
      } finally {
        clearTimeout(timeout)
        handles.delete(timeout)
      }
      guard(callback, [loaded])
    })()
    images.add(job)
    void job.then(() => images.delete(job), fail)
  }

  function realm(kind: "top" | "frame"): {
    context: vm.Context
    global: unknown
  } {
    const context = vm.createContext(Object.create(null))
    const run = (text: string): unknown =>
      vm.runInContext(text, context, { timeout: 15_000 })
    const global = run("globalThis")
    run(`(() => {
      for (const name of ['DateTimeFormat','NumberFormat','Collator','PluralRules','RelativeTimeFormat','ListFormat','DisplayNames','Segmenter']) {
        const Original = Intl[name]; if (!Original) continue;
        const defaults = args => [args[0] === undefined ? 'en-US' : args[0],
          name === 'DateTimeFormat' ? {timeZone:'UTC', ...args[1]} : args[1]];
        Intl[name] = new Proxy(Original, {
          construct: (target,args) => Reflect.construct(target, defaults(args)),
          apply: (target,self,args) => Reflect.apply(target,self,defaults(args))
        });
      }
    })()`)
    Object.assign(context, {
      atob,
      btoa,
      queueMicrotask: (fn: Callback) => queueMicrotask(() => guard(fn)),
    })
    const startTimer = (
      repeat: boolean,
      fn: Callback,
      delay = 0,
      ...args: unknown[]
    ) => {
      if (closed || typeof fn !== "function") return 0
      const ms = Math.min(
        2 ** 31 - 1,
        Math.max(repeat ? 4 : 0, Number(delay) || 0),
      )
      const fire = () => {
        if (!repeat) handles.delete(id)
        guard(fn, args, global)
      }
      const id = repeat ? setInterval(fire, ms) : setTimeout(fire, ms)
      handles.add(id)
      return id
    }
    const p = realmProfile(profile, kind)
    const began = Date.now() - (kind === "top" ? 2500 : 0)
    const install = run(assets.host) as (input: object) => unknown
    const api = install({
      markNative: (fn: object, text: string) => {
        native.set(fn, text)
        return fn
      },
      nativeSource: (fn: object) => native.get(fn),
      trust: (object: object, text: string) => trusted.set(object, text),
      timers: {
        setTimeout: startTimer.bind(null, false),
        setInterval: startTimer.bind(null, true),
        clear: (id: Timer) => {
          clearTimeout(id)
          clearInterval(id)
          handles.delete(id)
        },
      },
      installDOM: run(dom),
      shape,
      brands,
      storage,
      realm: kind,
      profile: p,
      topRealm: topAPI,
      performanceNow: () => Math.floor(Date.now() - began),
      timeOrigin: began,
      createIframeWindow:
        kind === "top" ? () => realm("frame").global : undefined,
      resolveInterface: () => {},
      orderKeys,
      loadImage,
    })
    // Bun's vm can use the context object for unqualified global getters,
    // while globalThis is a separate wrapper. Both belong to this Window.
    const windowBrand = brands.get(global as object)
    if (windowBrand) brands.set(context, windowBrand)
    if (kind === "top") topAPI = api
    return { context, global }
  }

  state.signal?.addEventListener("abort", onAbort, { once: true })
  if (state.signal?.aborted) onAbort()
  try {
    if (
      closed
      || !state.interpreter
      || !state.challenge.globalName
      || !state.challenge.program
    )
      throw new Error("Invalid WAA state")
    const top = realm("top")
    vm.runInContext(state.interpreter, top.context, { timeout: 15_000 })
    const fill = vm.runInContext(assets.prompt, top.context) as Fill
    const ready = bounded<void>((resolve) => {
      const fields: unknown =
        state.challenge.clientExperimentsStateBlob ?
          JSON.parse(state.challenge.clientExperimentsStateBlob)
        : []
      if (!Array.isArray(fields)) throw new Error("Invalid experiment state")
      const entries: unknown[] = Array.isArray(fields[5]) ? fields[5] : []
      const valid = entries.filter(
        (e): e is [number, number] =>
          Array.isArray(e)
          && typeof e[0] === "number"
          && typeof e[1] === "number",
      )
      const low = valid.filter((e) => e[1] <= 53),
        high = valid.filter((e) => e[1] > 53)
      const object = top.context[state.challenge.globalName] as {
        a: (...args: unknown[]) => void
      }
      object.a(
        state.challenge.program,
        (snap: Snapshot, stop: Callback) => {
          if (typeof snap !== "function") {
            fail()
            return
          }
          snapshot = snap
          shutdown = stop
          resolve()
        },
        true,
        undefined,
        () => {},
        [
          low.concat(high).map((e) => e[0]),
          low.map(() => 1).concat(high.map(() => 2)),
        ],
        fields[4] || undefined,
        false,
        [() => {}, () => {}, () => {}, () => {}],
      )
    }).then(async () => {
      if (closed) throw failure ?? new Error("WAA runtime closed")
      fill("", true)
      // Abort races image fetch too, even if a fetch implementation ignores its signal.
      await bounded<void>((resolve) => {
        void (async () => {
          while (images.size && !closed) await Promise.all(images)
          resolve()
        })().catch(fail)
      })
      await bounded<void>((resolve) => {
        const id = setTimeout(() => {
          handles.delete(id)
          resolve()
        }, settleMs)
        handles.add(id)
      })
    })
    void ready.catch(() => {})
    let queue = Promise.resolve()
    return {
      proof(binding) {
        const operation = queue.then(async () => {
          await ready
          return bounded<string>((resolve) => {
            fill(binding, false)
            snapshot!(
              (value) => resolve(String(value)),
              [
                { content: createHash("sha256").update(binding).digest("hex") },
                undefined,
                undefined,
                undefined,
              ],
            )
          })
        })
        queue = operation.then(
          () => {},
          () => {},
        )
        return operation
      },
      close,
    }
  } catch {
    close()
    throw new Error("WAA initialization failed")
  }
}
