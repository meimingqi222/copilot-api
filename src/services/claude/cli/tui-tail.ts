import fs from "node:fs/promises"

/** Read only newly appended bytes; never reread an entire long conversation. */
export class JsonlTail {
  private offset = 0
  private pending = ""
  private readonly decoder = new TextDecoder()
  async read(file: string): Promise<Array<unknown>> {
    let handle
    try {
      handle = await fs.open(file, "r")
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return []
      throw error
    }
    const result: Array<unknown> = []
    try {
      const buffer = Buffer.alloc(64 * 1024)
      for (;;) {
        const { bytesRead } = await handle.read(
          buffer,
          0,
          buffer.length,
          this.offset,
        )
        if (!bytesRead) break
        this.offset += bytesRead
        this.pending += this.decoder.decode(buffer.subarray(0, bytesRead), {
          stream: true,
        })
        let newline: number
        while ((newline = this.pending.indexOf("\n")) >= 0) {
          const line = this.pending.slice(0, newline)
          this.pending = this.pending.slice(newline + 1)
          if (line.trim()) result.push(JSON.parse(line))
        }
      }
    } finally {
      await handle.close()
    }
    return result
  }
}
