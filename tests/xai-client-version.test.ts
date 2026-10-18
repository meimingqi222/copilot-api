import { expect, spyOn, test } from "bun:test"

import { XAI_REQUEST_HEADERS } from "~/lib/quota/constants"
import {
  refreshXaiClientVersion,
  XAI_CLI_CLIENT_VERSION,
} from "~/lib/xai-client-version"
import { buildXaiHeaders } from "~/services/xai/headers"

test("Grok version refresh updates all identities and preserves them on lookup failure", async () => {
  const originalVersion = XAI_CLI_CLIENT_VERSION
  const fetchMock = spyOn(globalThis, "fetch")
  try {
    for (const version of ["1.0.13", "1.10.2", "2.0.0"]) {
      fetchMock.mockResolvedValueOnce(Response.json({ version }))
      await refreshXaiClientVersion()
      const chat = buildXaiHeaders("token", true, undefined, true)
      const quota = { ...XAI_REQUEST_HEADERS }
      expect(chat["x-grok-client-version"]).toBe(version)
      expect(chat["User-Agent"]).toBe(`xai-grok-workspace/${version}`)
      expect(quota["x-grok-client-version"]).toBe(version)
      expect(quota["User-Agent"]).toBe(
        `grok-pager/${version} grok-shell/${version} (macos; aarch64)`,
      )
      expect(buildXaiHeaders("token")["x-grok-client-version"]).toBeUndefined()
    }

    for (const payload of [
      { version: "1.0.12" },
      { version: "0.99.999" },
      { version: "1.0.99-alpha" },
      { version: "invalid" },
      { version: 123 },
      {},
      null,
    ]) {
      fetchMock.mockResolvedValueOnce(Response.json(payload))
      await refreshXaiClientVersion()
      expect(
        buildXaiHeaders("token", false, undefined, true)[
          "x-grok-client-version"
        ],
      ).toBe("2.0.0")
      expect({ ...XAI_REQUEST_HEADERS }["x-grok-client-version"]).toBe("2.0.0")
    }
    fetchMock.mockResolvedValueOnce(
      new Response("unavailable", { status: 503 }),
    )
    await refreshXaiClientVersion()
    expect(XAI_CLI_CLIENT_VERSION).toBe("2.0.0")
    fetchMock.mockRejectedValueOnce(new Error("Network request timed out"))
    await refreshXaiClientVersion()
    expect(XAI_CLI_CLIENT_VERSION).toBe("2.0.0")
  } finally {
    fetchMock.mockResolvedValueOnce(Response.json({ version: originalVersion }))
    await refreshXaiClientVersion()
    fetchMock.mockRestore()
  }
})
