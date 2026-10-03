import { describe, expect, test } from "bun:test"

import { isPlanBasedProvider } from "~/lib/provider-config"
import { PROVIDER_IDS } from "~/lib/provider-definitions"
import { getProviderDescriptor } from "~/lib/provider-descriptors"
import { OAUTH_CALLBACK_CONFIGS } from "~/services/oauth/flows"
import {
  getBuiltinProviderModule,
  listBuiltinProviderModules,
} from "~/services/providers/builtins"
import { validateProviderModules } from "~/services/providers/module"
import type { CreateAccountBody } from "~/services/providers/account-creation/types"

function context(body: CreateAccountBody) {
  return {
    body,
    label: "prepared-account",
    registerDeviceFlow() {
      throw new Error("Direct credentials must not start a device flow")
    },
  }
}

describe("provider contributions", () => {
  test("runtime, module and early capability readers share the same descriptor", () => {
    for (const id of PROVIDER_IDS) {
      const module = getBuiltinProviderModule(id)!
      expect(module.descriptor).toBe(getProviderDescriptor(id))
      expect(module.createRuntime().descriptor).toBe(module.descriptor)
    }
    expect(isPlanBasedProvider("commandcode-plan")).toBe(true)
    expect(isPlanBasedProvider("codex")).toBe(false)
    expect(isPlanBasedProvider("__proto__")).toBe(false)
  })

  test("callback compatibility view enumerates only owners and preserves provider-specific options", () => {
    const ids = [
      "claude",
      "codex",
      "xai",
      "antigravity",
      "windsurf",
      "lobsterai",
      "commandcode-plan",
      "zed",
      "dimagent",
      "gemini",
      "trae-cn",
    ]
    expect(Object.keys(OAUTH_CALLBACK_CONFIGS).sort()).toEqual(ids.sort())
    expect("copilot" in OAUTH_CALLBACK_CONFIGS).toBe(false)
    expect("codex" in OAUTH_CALLBACK_CONFIGS).toBe(true)
    expect(
      Object.getOwnPropertyDescriptor(OAUTH_CALLBACK_CONFIGS, "kimi"),
    ).toBeUndefined()
    expect(OAUTH_CALLBACK_CONFIGS["commandcode-plan"]).toMatchObject({
      mode: "post",
      corsOrigins: ["https://commandcode.ai", "https://staging.commandcode.ai"],
    })
    expect(OAUTH_CALLBACK_CONFIGS.zed).toMatchObject({
      anyPath: true,
      skipStateCheck: true,
      combineIntoCode: true,
      queryParams: { code: "access_token", state: "user_id" },
    })
    const copied = { ...OAUTH_CALLBACK_CONFIGS }
    expect(copied.codex).toBe(getBuiltinProviderModule("codex")!.callback)
    expect(Object.hasOwn(copied, "copilot")).toBe(false)
  })

  test("missing loopback configuration is rejected before registering a callback provider", () => {
    const codex = getBuiltinProviderModule("codex")!
    expect(() =>
      validateProviderModules([{ ...codex, callback: undefined }]),
    ).toThrow("Callback provider module is incomplete")
    expect(() =>
      validateProviderModules(listBuiltinProviderModules()),
    ).not.toThrow()
  })

  test("nested credentials keep precedence and explicit empty values fail validation", async () => {
    for (const [id, key, legacy, error] of [
      [
        "codebuff",
        "authToken",
        "authToken",
        "Codebuff auth token is required.",
      ],
      ["windsurf", "apiKey", "apiKey", "Windsurf API key is required."],
      [
        "codebuddy",
        "accessToken",
        "authToken",
        "CodeBuddy accessToken is required.",
      ],
      [
        "codebuddy-cn",
        "accessToken",
        "authToken",
        "CodeBuddy accessToken is required.",
      ],
    ] as const) {
      const creation = getBuiltinProviderModule(id)!.accountCreation!
      const result = await creation.prepare(
        context({
          [legacy]: "legacy",
          credentials: { [key]: "  active  " },
          settings: { proxyUrl: "http://proxy.test" },
        }),
      )
      expect(result).toMatchObject({
        name: "prepared-account",
        provider: id,
        credentials: { [key]: "active" },
        settings: { proxyUrl: "http://proxy.test" },
      })
      expect(
        await creation.prepare(
          context({ [legacy]: "legacy", credentials: { [key]: "  " } }),
        ),
      ).toEqual({ error })
    }
  })

  test("Mimo cookie credentials preserve settings fallback and typed settings", async () => {
    const creation = getBuiltinProviderModule("mimo-aistudio")!.accountCreation!
    const settings = {
      serviceToken: " token ",
      xiaomichatbotPh: " ph ",
      userId: 123,
      proxy: 456,
      defaultModel: "custom-model",
    }
    const result = await creation.prepare(context({ settings }))
    expect(result).toMatchObject({
      provider: "mimo-aistudio",
      credentials: { serviceToken: "token", xiaomichatbotPh: "ph" },
      settings: { ...settings, userId: undefined, proxy: undefined },
    })
    expect(
      await creation.prepare(
        context({ settings, credentials: { serviceToken: "" } }),
      ),
    ).toEqual({ error: "Service Token and PH cookie are required." })
  })

  test("CodeBuddy expiry and Lobster refresh-only credentials remain provider-owned", async () => {
    const token = `header.${Buffer.from(JSON.stringify({ exp: 1234567890 })).toString("base64url")}.signature`
    const codebuddy = getBuiltinProviderModule("codebuddy-cn")!.accountCreation!
    expect(
      await codebuddy.prepare(
        context({
          credentials: { accessToken: token, refreshToken: " refresh " },
        }),
      ),
    ).toMatchObject({
      provider: "codebuddy-cn",
      credentials: {
        accessToken: token,
        refreshToken: "refresh",
        expiresAt: 1234567890000,
      },
    })
    const lobster = getBuiltinProviderModule("lobsterai")!.accountCreation!
    expect(
      await lobster.prepare(
        context({
          credentials: {
            refreshToken: " refresh ",
            uuid: " device ",
            latestKeyfrom: "  ",
          },
        }),
      ),
    ).toMatchObject({
      provider: "lobsterai",
      credentials: { accessToken: "", refreshToken: "refresh", uuid: "device" },
    })
    expect(await lobster.prepare(context({ credentials: {} }))).toEqual({
      error: "LobsterAI accessToken or refreshToken is required.",
    })
  })
})
