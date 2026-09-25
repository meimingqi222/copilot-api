/**
 * 单消费者异步事件队列。
 *
 * CLI 进程的 stdout 必须**持续被读走**（管道写满会阻塞子进程），但事件要交给
 * "当前挂着的那个 HTTP 请求"消费。两者生命周期不同，所以中间需要一个队列：
 * 读循环永远在推，消费者按段来取。
 *
 * ⚠️ 只支持**一个消费者**。同一时刻挂起的 run 只会有一个在途请求，
 * 所以这是成立的；并发消费会互相偷事件。
 */
export class EventQueue<T> implements AsyncIterable<T> {
  private readonly items: Array<T> = []
  private readonly waiters: Array<(result: IteratorResult<T>) => void> = []
  private closed = false

  push(item: T): void {
    if (this.closed) return
    const waiter = this.waiters.shift()
    if (waiter) {
      waiter({ value: item, done: false })
      return
    }
    this.items.push(item)
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    for (const waiter of this.waiters.splice(0)) {
      waiter({ value: undefined, done: true })
    }
  }

  get isClosed(): boolean {
    return this.closed
  }

  async *[Symbol.asyncIterator](): AsyncIterator<T> {
    for (;;) {
      const buffered = this.items.shift()
      if (buffered !== undefined) {
        yield buffered
        continue
      }
      if (this.closed) return
      const next = await new Promise<IteratorResult<T>>((resolve) => {
        this.waiters.push(resolve)
      })
      if (next.done) return
      yield next.value
    }
  }
}

/**
 * 从队列里取一个"段"：读到 `message_stop` 就结束。
 *
 * 一段 = 一次 API 回合的流式输出。CLI 在一个进程里可以跑多段
 * （工具调用往返），所以段之间共享同一个队列。
 */
export async function* takeSegment<T extends { type: string }>(
  queue: AsyncIterable<T>,
): AsyncIterable<T> {
  for await (const event of queue) {
    yield event
    if (event.type === "message_stop") return
  }
}
