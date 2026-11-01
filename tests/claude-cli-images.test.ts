import { afterEach, beforeEach, expect, spyOn, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import * as dns from "node:dns/promises"
import type { LookupAddress } from "node:dns"
import { Agent, MockAgent } from "undici/index.js"
import {
  ClaudeTuiImages,
  claudeImageExtension,
  isPublicImageAddress,
  publicImageAddresses,
} from "~/services/claude/cli/tui-images"

const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=",
  "base64",
)

test("mixed DNS answers pin only public destinations", async () => {
  let answers: Array<LookupAddress> = [
    { address: "8.8.8.8", family: 4 },
    { address: "::1", family: 6 },
  ]
  const resolver: {
    lookup(host: string, options: { all: true }): Promise<Array<LookupAddress>>
  } = dns
  const mocked = spyOn(resolver, "lookup").mockImplementation(
    async () => answers,
  )
  try {
    expect(await publicImageAddresses("images.example")).toEqual([
      { address: "8.8.8.8", family: 4 },
    ])
    answers = [{ address: "127.0.0.1", family: 4 }]
    await expect(publicImageAddresses("images.example")).rejects.toThrow(
      "public addresses",
    )
  } finally {
    mocked.mockRestore()
  }
})
let dir: string
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "claude-image-test-"))
})
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true })
})

test("only public unicast image addresses are permitted", () => {
  for (const ip of [
    "127.0.0.1",
    "10.0.0.1",
    "172.16.0.1",
    "192.168.1.1",
    "169.254.169.254",
    "100.100.100.200",
    "0.0.0.0",
    "240.1.2.3",
    "::1",
    "fe80::1",
    "fc00::1",
    "::ffff:127.0.0.1",
    "64:ff9b::7f00:1",
    "2002:7f00:1::",
    "2001:db8::1",
  ])
    expect(isPublicImageAddress(ip)).toBe(false)
  for (const ip of ["8.8.8.8", "1.1.1.1", "2606:4700:4700::1111"])
    expect(isPublicImageAddress(ip)).toBe(true)
})

test("validates image bytes and removes private files", async () => {
  const images = new ClaudeTuiImages(dir)
  const file = await images.write(
    { type: "base64", media_type: "image/png", data: png.toString("base64") },
    new AbortController().signal,
  )
  expect(await Bun.file(file).bytes()).toEqual(new Uint8Array(png))
  await images.clearFiles()
  expect(await Bun.file(file).exists()).toBe(false)
  expect(() =>
    claudeImageExtension(Buffer.from("<html>not an image</html>")),
  ).toThrow("Image content")
  expect(() => claudeImageExtension(Buffer.alloc(6 * 1024 * 1024))).toThrow(
    "5 MB",
  )
  await expect(
    images.write(
      { type: "base64", media_type: "image/png", data: "file:///secret" },
      new AbortController().signal,
    ),
  ).rejects.toThrow("base64")
})

test("rejects local URLs and credentials before making any request", async () => {
  const images = new ClaudeTuiImages(dir)
  for (const url of [
    "http://127.0.0.1/private",
    "http://2130706433/private",
    "http://[::ffff:127.0.0.1]/private",
    "file:///private",
    "https://user:pass@example.com/private",
  ])
    await expect(
      images.write({ type: "url", url }, AbortSignal.timeout(2000)),
    ).rejects.toThrow()
})

test("limits message image count and bytes, then resets after acceptance", async () => {
  const images = new ClaudeTuiImages(dir)
  const source = {
    type: "base64" as const,
    media_type: "image/png" as const,
    data: png.toString("base64"),
  }
  for (let i = 0; i < 20; i++)
    await images.write(source, AbortSignal.timeout(2000))
  await expect(images.write(source, AbortSignal.timeout(2000))).rejects.toThrow(
    "20 files or 20 MB",
  )
  await images.clearFiles()
  const padded = Buffer.alloc(5 * 1024 * 1024)
  png.copy(padded)
  const large = { ...source, data: padded.toString("base64") }
  for (let i = 0; i < 4; i++)
    await images.write(large, AbortSignal.timeout(2000))
  await expect(images.write(source, AbortSignal.timeout(2000))).rejects.toThrow(
    "20 files or 20 MB",
  )
  await images.clearFiles()
  expect(
    await Bun.file(
      await images.write(source, AbortSignal.timeout(2000)),
    ).exists(),
  ).toBe(true)
})

test("URL cache evicts the oldest image at 32 entries or 20 MB", async () => {
  const padded = Buffer.alloc(5 * 1024 * 1024)
  png.copy(padded)
  const network = new MockAgent()
  network.disableNetConnect()
  network
    .get("https://images.example")
    .intercept({ path: /\/small\/\d+/ })
    .reply(200, png)
    .times(34)
  network
    .get("https://images.example")
    .intercept({ path: /\/large\/\d+/ })
    .reply(200, padded)
    .times(6)
  const mocked = spyOn(Agent.prototype, "dispatch").mockImplementation(
    (options, handler) =>
      network.get(String(options.origin)).dispatch(options, handler),
  )
  try {
    for (const [kind, count] of [
      ["small", 33],
      ["large", 5],
    ] as const) {
      const images = new ClaudeTuiImages(dir)
      const start = mocked.mock.calls.length
      for (let i = 0; i < count; i++) {
        await images.write(
          { type: "url", url: `https://images.example/${kind}/${i}` },
          AbortSignal.timeout(2000),
        )
        await images.clearFiles()
      }
      expect(mocked.mock.calls.length - start).toBe(count)
      await images.write(
        { type: "url", url: `https://images.example/${kind}/0` },
        AbortSignal.timeout(2000),
      )
      await images.clearFiles()
      expect(mocked.mock.calls.length - start).toBe(count + 1)
      await images.write(
        { type: "url", url: `https://images.example/${kind}/${count - 1}` },
        AbortSignal.timeout(2000),
      )
      await images.clearFiles()
      expect(mocked.mock.calls.length - start).toBe(count + 1)
    }
  } finally {
    mocked.mockRestore()
    await network.close()
  }
})

test("rejects oversized downloads even without Content-Length", async () => {
  const network = new MockAgent()
  network.disableNetConnect()
  network
    .get("https://images.example")
    .intercept({ path: "/oversized" })
    .reply(200, Buffer.alloc(6 * 1024 * 1024))
  const mocked = spyOn(Agent.prototype, "dispatch").mockImplementation(
    (options, handler) =>
      network.get(String(options.origin)).dispatch(options, handler),
  )
  try {
    await expect(
      new ClaudeTuiImages(dir).write(
        { type: "url", url: "https://images.example/oversized" },
        AbortSignal.timeout(2000),
      ),
    ).rejects.toThrow("5 MB")
    expect(await fs.readdir(dir)).toEqual([])
  } finally {
    mocked.mockRestore()
    await network.close()
  }
})

test("URL images are bounded, cached per run and fetched without account credentials", async () => {
  const network = new MockAgent()
  network.disableNetConnect()
  network
    .get("https://images.example")
    .intercept({
      path: "/a?signature=fictional-test-value",
      headers: { accept: "image/png,image/jpeg,image/gif,image/webp" },
    })
    .reply(200, png, { headers: { "content-type": "text/plain" } })
    .times(2)
  const mocked = spyOn(Agent.prototype, "dispatch").mockImplementation(
    (options, handler) =>
      network.get(String(options.origin)).dispatch(options, handler),
  )
  try {
    const images = new ClaudeTuiImages(dir)
    const source = {
      type: "url" as const,
      url: "https://images.example/a?signature=fictional-test-value",
    }
    for (let i = 0; i < 2; i++)
      await images.write(source, AbortSignal.timeout(2000))
    expect(mocked).toHaveBeenCalledTimes(1)
    expect(mocked.mock.calls[0][0].headers).toEqual({
      accept: "image/png,image/jpeg,image/gif,image/webp",
    })
    await new ClaudeTuiImages(dir).write(source, AbortSignal.timeout(2000))
    expect(mocked).toHaveBeenCalledTimes(2)
  } finally {
    mocked.mockRestore()
    await network.close()
  }
})

test("revalidates redirect targets and does not follow a redirect into loopback", async () => {
  const network = new MockAgent()
  network.disableNetConnect()
  network
    .get("https://images.example")
    .intercept({ path: "/public" })
    .reply(302, "", { headers: { location: "http://127.0.0.1/private" } })
  const mocked = spyOn(Agent.prototype, "dispatch").mockImplementation(
    (options, handler) =>
      network.get(String(options.origin)).dispatch(options, handler),
  )
  try {
    await expect(
      new ClaudeTuiImages(dir).write(
        { type: "url", url: "https://images.example/public" },
        AbortSignal.timeout(2000),
      ),
    ).rejects.toThrow("public addresses")
    expect(mocked).toHaveBeenCalledTimes(1)
  } finally {
    mocked.mockRestore()
    await network.close()
  }
})

test("DNS names resolving to local addresses fail at the socket lookup", async () => {
  await expect(
    new ClaudeTuiImages(dir).write(
      { type: "url", url: "http://localhost:1/private" },
      AbortSignal.timeout(2000),
    ),
  ).rejects.toThrow("public addresses")
})

test("cancelled image input creates no files", async () => {
  await expect(
    new ClaudeTuiImages(dir).write(
      { type: "base64", media_type: "image/png", data: png.toString("base64") },
      AbortSignal.abort(new Error("cancel image")),
    ),
  ).rejects.toThrow("cancel image")
  expect(await fs.readdir(dir)).toEqual([])
})
