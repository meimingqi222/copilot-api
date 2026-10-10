import type { Context } from "hono"

import { AsyncLocalStorage } from "node:async_hooks"
import { maskUpstream } from "~/lib/redaction/context"

import {
  addPerformanceTiming,
  hasRequestPerformance,
  markUpstreamEvent,
  markUpstreamSent,
  type PerformanceTiming,
} from "~/lib/request-performance"

const scope = new AsyncLocalStorage<Context>()
const responses = new WeakMap<Response, { c: Context; sentAt: number }>()

export function performanceContext(): Context | undefined {
  return scope.getStore()
}

export function runWithPerformanceContext<T>(
  c: Context | undefined,
  run: () => T,
): T {
  return hasRequestPerformance(c) && c ? scope.run(c, run) : run()
}

export function bindPerformanceStream<T>(
  stream: AsyncIterable<T>,
  c: Context | undefined,
): AsyncIterable<T> {
  if (!hasRequestPerformance(c)) return stream
  return {
    [Symbol.asyncIterator]() {
      const iterator = runWithPerformanceContext(c, () =>
        stream[Symbol.asyncIterator](),
      )
      return {
        next: () => runWithPerformanceContext(c, () => iterator.next()),
        return: async () =>
          runWithPerformanceContext(
            c,
            () =>
              iterator.return?.()
              ?? Promise.resolve({ done: true as const, value: undefined }),
          ),
        throw: async (error: unknown) =>
          runWithPerformanceContext(c, () => {
            if (iterator.throw) return iterator.throw(error)
            throw error
          }),
      }
    },
  }
}

export async function measureUpstreamFetch(
  run: () => Promise<Response>,
): Promise<Response> {
  const c = performanceContext()
  if (!hasRequestPerformance(c) || !c) return run()
  const sentAt = performance.now()
  markUpstreamSent(c, sentAt)
  const response = await run()
  addPerformanceTiming(c, "upstreamHeadersMs", performance.now() - sentAt)
  responses.set(response, { c, sentAt })
  return response
}

export function performanceFetch(
  input: string | URL | Request,
  init?: RequestInit,
): Promise<Response> {
  return measureUpstreamFetch(() => globalThis.fetch(input, init))
}

export function observeUpstreamResponse(response: Response): void {
  const state = responses.get(response)
  if (state) markUpstreamEvent(state.c, state.sentAt)
}

export async function readUpstreamJson(response: Response): Promise<unknown> {
  return measureUpstreamRead(response, () => response.json())
}

export async function measureUpstreamRead<T>(
  response: Response,
  read: () => Promise<T>,
): Promise<T> {
  const state = responses.get(response)
  if (!state) return read()
  const started = performance.now()
  try {
    return await read()
  } finally {
    addPerformanceTiming(
      state.c,
      "upstreamBodyReadMs",
      performance.now() - started,
    )
  }
}

export function* measureLocalIterable<T>(input: Iterable<T>): Generator<T> {
  const iterator = input[Symbol.iterator]()
  try {
    while (true) {
      const next = measureLocalWork("streamTranslationActiveMs", () =>
        iterator.next(),
      )
      if (next.done) return
      yield next.value
    }
  } finally {
    iterator.return?.()
  }
}

export function serializeUpstreamBody(value: object): string {
  return measureLocalWork("adapterPreparationMs", () =>
    JSON.stringify(maskUpstream(value)),
  )
}

export function measureLocalWork<T>(field: PerformanceTiming, run: () => T): T {
  const c = performanceContext()
  if (!hasRequestPerformance(c)) return run()
  const started = performance.now()
  try {
    return run()
  } finally {
    addPerformanceTiming(c, field, performance.now() - started)
  }
}
