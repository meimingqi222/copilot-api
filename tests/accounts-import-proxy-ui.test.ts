import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { runInNewContext } from "node:vm"

interface ImportView {
  importFiles: Array<{ text(): Promise<string> }>
  importRestoreProxy: boolean
  submitImport(): Promise<void>
  closeImportModal(): void
  load(): Promise<void>
  showToast(): void
}

test.each([false, true])(
  "standard import sends the proxy choice (restore: %s)",
  async (restore) => {
    const requests: Array<Record<string, unknown>> = []
    const view = runInNewContext(
      readFileSync("pages/js/views/accounts.js", "utf8") + "\naccountsView()",
      {
        ViewHelpers: {},
        I18n: { t: (key: string) => key },
        API: {
          accounts: {
            import: async (payload: Record<string, unknown>) => {
              requests.push(payload)
              return { imported: 1, skipped: 0, failed: 0 }
            },
          },
        },
      },
    ) as ImportView
    expect(view.importRestoreProxy).toBe(false)
    view.importRestoreProxy = restore
    view.importFiles = [
      {
        text: async () =>
          JSON.stringify({
            accounts: [
              {
                provider: "codebuddy-cn",
                credentials: { accessToken: "test" },
                settings: { proxyUrl: "http://proxy.example.invalid:8080" },
              },
            ],
          }),
      },
    ]
    view.closeImportModal = () => undefined
    view.load = async () => undefined
    view.showToast = () => undefined
    await view.submitImport()
    expect(requests).toHaveLength(1)
    expect(requests[0].restoreProxy).toBe(restore)
  },
)
