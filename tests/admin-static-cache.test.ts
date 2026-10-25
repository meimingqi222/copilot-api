import { expect, test } from "bun:test"

import { server } from "~/server"

/**
 * The admin shell used to send `no-cache` with no validator at all: every load
 * re-downloaded every asset, and `?v=` bumps bought nothing. ETag now makes an
 * unchanged file a 304. Code deliberately stays revalidating rather than
 * immutable so a forgotten bump cannot pin a stale UI.
 */
test("unchanged assets revalidate to 304 through the ETag", async () => {
  const url = "http://localhost/admin/static/js/i18n.js?v=0.7.31"
  const first = await server.fetch(new Request(url))
  expect(first.status).toBe(200)
  const etag = first.headers.get("etag")
  expect(etag).toBeTruthy()
  const cacheControl = first.headers.get("cache-control") ?? ""
  expect(cacheControl).toContain("no-cache")
  expect(cacheControl).not.toContain("immutable")

  const second = await server.fetch(
    new Request(url, { headers: { "if-none-match": etag ?? "" } }),
  )
  expect(second.status).toBe(304)
  expect(await second.text()).toBe("")
})

test("unversioned code revalidates the same way", async () => {
  const response = await server.fetch(
    new Request("http://localhost/admin/static/js/i18n.js"),
  )
  expect(response.status).toBe(200)
  expect(response.headers.get("cache-control")).toContain("no-cache")
  expect(response.headers.get("etag")).toBeTruthy()
})

test("the in-memory cache reuses the ETag until the file changes", async () => {
  const url = "http://localhost/admin/static/js/i18n.js?v=test-mtime"
  const first = await server.fetch(new Request(url))
  const etag = first.headers.get("etag")
  expect(etag).toBeTruthy()
  const again = await server.fetch(new Request(url))
  expect(again.headers.get("etag")).toBe(etag)
})
