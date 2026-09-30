/**
 * `image_url` 引用内联（以及降级为文本）的单元测试。
 *
 * 触发它的实测证据（CodeBuddy，2026-09-29：`file://` / 裸绝对路径 / 裸文件名回
 * `400 11133`，`https://` 回 `400 11135`，只有 `data:` 回 200）记录在
 * `src/services/protocols/openai-compat-payload.ts` 中
 * `inlineCompatImageReferences` 的注释里。
 *
 * 远程取回用注入的 `fetch` 与 `lookup`，测试不触网。
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import type { Message } from "~/services/protocols/chat/types"

import {
  inlineCompatImageReferences,
  type InlineCompatImageResult,
} from "~/services/protocols/openai-compat-payload"

/** 真实的最小 PNG：1×1、RGBA、一个 IDAT。 */
const PNG_1X1 = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49,
  0x48, 0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06,
  0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4, 0x89, 0x00, 0x00, 0x00, 0x0a, 0x49, 0x44,
  0x41, 0x54, 0x78, 0x9c, 0x63, 0x00, 0x01, 0x00, 0x00, 0x05, 0x00, 0x01, 0x0d,
  0x0a, 0x2d, 0xb4, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42,
  0x60, 0x82,
])

const PNG_DATA_URL = `data:image/png;base64,${Buffer.from(PNG_1X1).toString("base64")}`

/** 一个公开地址，用于"主机名解析正常"的用例。 */
const PUBLIC_ADDRESS = "93.184.216.34"

interface ImagePartShape {
  type: string
  image_url?: string | { url: string; detail?: string }
  text?: string
}

const msg = (content: unknown) =>
  ({ role: "user", content }) as unknown as Message

const imagePart = (url: string, detail?: string): ImagePartShape => ({
  type: "image_url",
  image_url: detail === undefined ? { url } : { url, detail },
})

const partAt = (message: Message, index = 0): ImagePartShape =>
  (message.content as Array<ImagePartShape>)[index]!

/** 第 `index` 个 part 的 `image_url`，用于断言。 */
const imageUrlAt = (message: Message, index = 0): string | undefined => {
  const holder = partAt(message, index).image_url
  return typeof holder === "string" ? holder : holder?.url
}

const expectInlined = (
  result: InlineCompatImageResult,
  count: number,
): void => {
  expect(result).toEqual({ inlined: count, degraded: 0 })
}

const expectDegraded = (
  result: InlineCompatImageResult,
  count: number,
): void => {
  expect(result).toEqual({ inlined: 0, degraded: count })
}

const imageResponse = (bytes = PNG_1X1, type = "image/png") =>
  new Response(bytes, { status: 200, headers: { "content-type": type } })

/** 注入的 `fetch`：记录 URL，按 URL 决定响应。 */
function stubFetch(handler: (url: string) => Response | Promise<Response>): {
  fetch: typeof globalThis.fetch
  urls: Array<string>
} {
  const urls: Array<string> = []
  const impl = (async (input: Parameters<typeof globalThis.fetch>[0]) => {
    const url = String(input)
    urls.push(url)
    return await handler(url)
  }) as unknown as typeof globalThis.fetch
  return { fetch: impl, urls }
}

const publicLookup = async (): Promise<Array<string>> => [PUBLIC_ADDRESS]

let workspace: string
let pngPath: string

beforeAll(async () => {
  workspace = await mkdtemp(join(tmpdir(), "compat-image-"))
  pngPath = join(workspace, "shot.png")
  await writeFile(pngPath, PNG_1X1)
  await writeFile(join(workspace, "not-an-image.png"), "not an image\n")
})

afterAll(async () => {
  await rm(workspace, { recursive: true, force: true })
})

describe("local references", () => {
  test("inlines an absolute local path to the same bytes", async () => {
    const messages = [msg([imagePart(pngPath)])]
    expectInlined(await inlineCompatImageReferences(messages), 1)
    expect(imageUrlAt(messages[0]!)).toBe(PNG_DATA_URL)
  })

  test("inlines file-URL references, with and without an authority", async () => {
    await writeFile(join(workspace, "spaced name.png"), PNG_1X1)
    const messages = [
      msg([imagePart(`file://${pngPath}`)]),
      msg([imagePart(`file://localhost${pngPath}`)]),
      // `%20` in a path with a space, the form browsers and terminals emit.
      msg([imagePart(`file://${workspace}/spaced%20name.png`)]),
    ]
    expectInlined(await inlineCompatImageReferences(messages), 3)
    expect(messages.map((message) => imageUrlAt(message))).toEqual([
      PNG_DATA_URL,
      PNG_DATA_URL,
      PNG_DATA_URL,
    ])
  })

  test("expands ~ against the injected home directory", async () => {
    const messages = [msg([imagePart("~/shot.png")])]
    expectInlined(
      await inlineCompatImageReferences(messages, { home: workspace }),
      1,
    )
    expect(imageUrlAt(messages[0]!)).toBe(PNG_DATA_URL)
  })

  test("keeps the rest of the image field", async () => {
    const messages = [msg([imagePart(pngPath, "high")])]
    await inlineCompatImageReferences(messages)
    expect(partAt(messages[0]!).image_url).toEqual({
      url: PNG_DATA_URL,
      detail: "high",
    })
  })

  test("inlines the string-shaped image_url a raw client sends", async () => {
    const messages = [msg([imagePart(pngPath)])]
    // 绕过 normalizeCompatImageUrls，模拟直接调用本函数的情形。
    ;(
      messages[0]!.content as unknown as Array<Record<string, unknown>>
    )[0]!.image_url = pngPath
    expectInlined(await inlineCompatImageReferences(messages), 1)
    expect(imageUrlAt(messages[0]!)).toBe(PNG_DATA_URL)
  })

  test("degrades a missing path, a non-image file and an oversized file", async () => {
    const missing = [msg([imagePart(join(workspace, "gone.png"))])]
    const notAnImage = [msg([imagePart(join(workspace, "not-an-image.png"))])]
    const oversized = [msg([imagePart(pngPath)])]

    expectDegraded(await inlineCompatImageReferences(missing), 1)
    expectDegraded(await inlineCompatImageReferences(notAnImage), 1)
    // 上限刚好卡在这张 PNG 之下。
    expectDegraded(
      await inlineCompatImageReferences(oversized, { maxBytes: 8 }),
      1,
    )

    // 降级后请求里不再有引用形态，且原因留痕。
    for (const messages of [missing, notAnImage, oversized]) {
      expect(imageUrlAt(messages[0]!)).toBeUndefined()
      expect(partAt(messages[0]!).type).toBe("text")
      expect(partAt(messages[0]!).text).toContain("[image not inlined: ")
    }
  })
})

describe("remote references", () => {
  test("fetches a public host and inlines the sniffed bytes", async () => {
    const messages = [msg([imagePart("https://example.com/cat.png")])]
    const stub = stubFetch(() => imageResponse())
    expectInlined(
      await inlineCompatImageReferences(messages, {
        fetch: stub.fetch,
        lookup: publicLookup,
      }),
      1,
    )
    expect(stub.urls).toEqual(["https://example.com/cat.png"])
    expect(imageUrlAt(messages[0]!)).toBe(PNG_DATA_URL)
  })

  test("follows a redirect to another public host, re-validating the hop", async () => {
    const messages = [msg([imagePart("https://example.com/cat")])]
    const stub = stubFetch((url) =>
      url === "https://example.com/cat" ?
        new Response(null, {
          status: 302,
          headers: { location: "https://cdn.example.com/cat.png" },
        })
      : imageResponse(),
    )
    expectInlined(
      await inlineCompatImageReferences(messages, {
        fetch: stub.fetch,
        lookup: publicLookup,
      }),
      1,
    )
    expect(stub.urls).toEqual([
      "https://example.com/cat",
      "https://cdn.example.com/cat.png",
    ])
  })

  test("refuses a response whose Content-Type is not an image", async () => {
    const messages = [msg([imagePart("https://example.com/cat")])]
    const stub = stubFetch(() =>
      imageResponse(PNG_1X1, "application/octet-stream"),
    )
    // 声明不是图片就直接拒绝：签名是闸门，不能把非图片响应变成图片。
    expectDegraded(
      await inlineCompatImageReferences(messages, {
        fetch: stub.fetch,
        lookup: publicLookup,
      }),
      1,
    )
  })

  test("labels the bytes with the sniffed type, not the declared one", async () => {
    const messages = [msg([imagePart("https://example.com/cat")])]
    // 声明是 JPEG、内容其实是 PNG：签名说了算。
    const stub = stubFetch(() => imageResponse(PNG_1X1, "image/jpeg"))
    expectInlined(
      await inlineCompatImageReferences(messages, {
        fetch: stub.fetch,
        lookup: publicLookup,
      }),
      1,
    )
    expect(imageUrlAt(messages[0]!)).toBe(PNG_DATA_URL)
  })

  test("degrades instead of fetching private, loopback or metadata addresses", async () => {
    const urls = [
      "http://127.0.0.1/a.png",
      "http://[::1]/a.png",
      "http://10.0.0.5/a.png",
      "http://172.16.3.4/a.png",
      "http://192.168.1.10/a.png",
      "http://169.254.169.254/latest/meta-data/a.png",
      "https://user:pass@example.com/a.png",
    ]
    const messages = urls.map((url) => msg([imagePart(url)]))
    const stub = stubFetch(() => imageResponse())
    expectDegraded(
      await inlineCompatImageReferences(messages, {
        fetch: stub.fetch,
        lookup: publicLookup,
      }),
      urls.length,
    )
    // 闸门在取回之前：一个私有地址都不该发出去。
    expect(stub.urls).toEqual([])
  })

  test("degrades a public hostname that resolves to a private address", async () => {
    const messages = [msg([imagePart("http://internal.example.com/a.png")])]
    const stub = stubFetch(() => imageResponse())
    expectDegraded(
      await inlineCompatImageReferences(messages, {
        fetch: stub.fetch,
        lookup: async () => ["10.1.2.3"],
      }),
      1,
    )
    expect(stub.urls).toEqual([])
  })

  test("degrades when the hostname does not resolve", async () => {
    const messages = [msg([imagePart("https://nope.example.com/a.png")])]
    const stub = stubFetch(() => imageResponse())
    expectDegraded(
      await inlineCompatImageReferences(messages, {
        fetch: stub.fetch,
        lookup: async () => {
          throw new Error("ENOTFOUND")
        },
      }),
      1,
    )
    expect(stub.urls).toEqual([])
  })

  test("degrades a redirect that points at a private address", async () => {
    const messages = [msg([imagePart("https://example.com/a.png")])]
    const stub = stubFetch(
      () =>
        new Response(null, {
          status: 302,
          headers: { location: "http://169.254.169.254/a.png" },
        }),
    )
    expectDegraded(
      await inlineCompatImageReferences(messages, {
        fetch: stub.fetch,
        lookup: publicLookup,
      }),
      1,
    )
    expect([...new Set(stub.urls)]).toEqual(["https://example.com/a.png"])
  })

  test("degrades a 404, an oversized body and a failed fetch", async () => {
    const messages = [
      msg([imagePart("https://example.com/404.png")]),
      msg([imagePart("https://example.com/big.png")]),
      msg([imagePart("https://example.com/boom.png")]),
    ]
    const stub = stubFetch((url) => {
      if (url.endsWith("404.png")) return new Response("no", { status: 404 })
      if (url.endsWith("big.png")) {
        return new Response(PNG_1X1, {
          status: 200,
          headers: {
            "content-type": "image/png",
            "content-length": String(64 * 1024 * 1024),
          },
        })
      }
      throw new Error("ECONNREFUSED")
    })
    expectDegraded(
      await inlineCompatImageReferences(messages, {
        fetch: stub.fetch,
        lookup: publicLookup,
        maxBytes: 1024,
      }),
      3,
    )
    for (const message of messages) {
      expect(partAt(message).type).toBe("text")
    }
  })

  test("degrades everything when remote inlining is switched off", async () => {
    const messages = [msg([imagePart("https://example.com/cat.png")])]
    const stub = stubFetch(() => imageResponse())
    expectDegraded(
      await inlineCompatImageReferences(messages, {
        fetch: stub.fetch,
        lookup: publicLookup,
        remote: false,
      }),
      1,
    )
    expect(stub.urls).toEqual([])
    expect(partAt(messages[0]!).text).toContain("remote inlining is disabled")
  })

  test("allowPrivateHosts is the escape hatch for an internal image server", async () => {
    const messages = [msg([imagePart("http://192.168.1.10/a.png")])]
    const stub = stubFetch(() => imageResponse())
    expectInlined(
      await inlineCompatImageReferences(messages, {
        fetch: stub.fetch,
        lookup: publicLookup,
        allowPrivateHosts: true,
      }),
      1,
    )
    expect(stub.urls).toEqual(["http://192.168.1.10/a.png"])
  })
})

describe("payload invariants", () => {
  test("leaves already-inline data URLs untouched", async () => {
    const messages = [msg([imagePart(PNG_DATA_URL)])]
    expect(await inlineCompatImageReferences(messages)).toEqual({
      inlined: 0,
      degraded: 0,
    })
    expect(imageUrlAt(messages[0]!)).toBe(PNG_DATA_URL)
  })

  test("no reference-shaped image_url survives, whatever the outcome", async () => {
    const messages = [
      msg([{ type: "text", text: "look" }, imagePart(pngPath)]),
      msg([{ type: "text", text: "and these" }, imagePart(PNG_DATA_URL)]),
      msg([imagePart("https://example.com/cat.png")]),
      msg([imagePart("https://127.0.0.1/cat.png")]),
      msg([imagePart("shot.png")]),
      msg([imagePart("")]),
      msg("plain string content"),
    ]
    const stub = stubFetch(() => imageResponse())
    const result = await inlineCompatImageReferences(messages, {
      fetch: stub.fetch,
      lookup: publicLookup,
    })
    // 两个内联（本地文件、可取回的远程），三个降级（私有地址、裸文件名、空引用），
    // 一个 `data:` 原样保留。
    expect(result).toEqual({ inlined: 2, degraded: 3 })

    for (const message of messages) {
      if (!Array.isArray(message.content)) continue
      for (const part of message.content as Array<ImagePartShape>) {
        if (part.type !== "image_url") continue
        const holder = part.image_url
        const url = typeof holder === "string" ? holder : holder?.url
        expect(url?.startsWith("data:")).toBe(true)
      }
    }
  })
})
