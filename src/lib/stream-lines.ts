/**
 * 行缓冲工具：把字节/字符串流切成行。
 *
 * 五个上游（Trae CN / Zed / Gemini Code Assist / Claude CLI / Antigravity）
 * 各写过一份 `indexOf("\n") + slice` 循环，并且已经漂移：只有 Trae 那份在
 * 消费方提前退出时取消了上游 reader，其余几份只 `releaseLock()`，会把 fetch
 * 连接挂到 GC 才回收。这里统一成一份实现。
 */

/** 去掉 CRLF 的 `\r`，让 CRLF 流与 LF 流解析结果一致。 */
function stripCarriageReturn(line: string): string {
  return line.endsWith("\r") ? line.slice(0, -1) : line
}

interface IterateLinesOptions {
  /**
   * 单行缓冲上限（UTF-8 字节）。上游一直不发换行时用它兜住内存，
   * 超过即抛错而不是无限增长。
   */
  maxBufferedBytes?: number
}

/**
 * 把分块输入切成行。
 *
 * 每次 yield 一行，不含行尾终止符；结尾 `\r` 会被去掉。源在没有换行的
 * 情况下结束（半行收尾）时，最后一段仍会 yield，不会丢事件。
 *
 * `source` 可以是 `ReadableStream`：用 `for await` 消费它时，消费方提前
 * 退出（错误件轮换 / 客户端断开 / 读到 `[DONE]`）会触发 `cancel()`，
 * 而只调 `reader.releaseLock()` 不会 —— 那会让上游连接挂着等 GC。
 * 因此新代码应优先用这个，而不是自己写 reader 循环。
 */
export async function* iterateLines(
  source: AsyncIterable<string | Uint8Array>,
  options: IterateLinesOptions = {},
): AsyncGenerator<string> {
  const { maxBufferedBytes } = options
  const decoder = new TextDecoder()
  let buffer = ""
  let bufferedBytes = 0

  const append = (text: string): void => {
    if (maxBufferedBytes === undefined) {
      buffer += text
      return
    }
    bufferedBytes += Buffer.byteLength(text)
    if (bufferedBytes > maxBufferedBytes) {
      throw new Error(
        `Stream line exceeds the ${maxBufferedBytes}-byte buffer limit`,
      )
    }
    buffer += text
  }

  for await (const chunk of source) {
    append(
      typeof chunk === "string" ? chunk : (
        decoder.decode(chunk, { stream: true })
      ),
    )
    let index = buffer.indexOf("\n")
    while (index >= 0) {
      const line = buffer.slice(0, index)
      // 逐行扣减，避免每行都对整个缓冲区求一次字节长度。
      if (maxBufferedBytes !== undefined)
        bufferedBytes -= Buffer.byteLength(line) + 1
      buffer = buffer.slice(index + 1)
      yield stripCarriageReturn(line)
      index = buffer.indexOf("\n")
    }
  }
  append(decoder.decode())
  if (buffer.length > 0) yield stripCarriageReturn(buffer)
}
