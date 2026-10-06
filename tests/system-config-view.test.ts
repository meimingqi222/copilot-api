import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { runInNewContext } from "node:vm"

test("system settings display MiB and save the selected storage budget", async () => {
  const settings = { logRetentionDays: 7, logMaxTotalBytes: 1024 ** 3 }
  let submitted:
    | { logRetentionDays: number; logMaxTotalBytes: number }
    | undefined
  const source = readFileSync("pages/js/views/system-config.js", "utf8")
  const view = runInNewContext(source + "\nsystemConfigView()", {
    CustomEvent: class {},
    dispatchEvent: () => {},
    API: {
      request: (_path: string, options: { body: typeof settings }) => {
        submitted = options.body
        return Promise.resolve({
          settings: options.body,
          source: "webui",
          expiresAt: null,
        })
      },
    },
  }) as {
    settings: typeof settings
    maxLogMiB: number
    saved: boolean
    accept: (value: unknown) => void
    save: () => Promise<void>
    useRecommended: () => void
  }
  view.accept({ settings, source: "environment", expiresAt: null })
  expect(view.maxLogMiB).toBe(1024)
  view.settings.logRetentionDays = 3
  view.maxLogMiB = 128
  await view.save()
  expect(submitted?.logMaxTotalBytes).toBe(128 * 1024 * 1024)
  expect(submitted?.logRetentionDays).toBe(3)
  expect(view.saved).toBe(true)
  view.useRecommended()
  expect(view.maxLogMiB).toBe(1024)
  expect(view.settings.logRetentionDays).toBe(7)
})
