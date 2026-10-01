/**
 * Balance subsystem tests.
 *
 * Each vendor's reader is exercised with a realistic sample body, plus the
 * dotted-path reader, currency detection, the new-api quota→USD conversion,
 * custom-URL precedence and `takesBalanceToken`.
 */
import { afterEach, describe, expect, test } from "bun:test"

import {
  currencySign,
  customBalanceSource,
  fetchBalance,
  knownBalanceSource,
  money,
  normalizeHost,
  numberFrom,
  readDottedPath,
  resolveBalanceSource,
  setBalanceFetcher,
  takesBalanceToken,
} from "~/lib/balance"

afterEach(() => {
  setBalanceFetcher(undefined)
})

const DEEPSEEK = {
  is_available: true,
  balance_infos: [
    {
      currency: "CNY",
      total_balance: "110.25",
      granted_balance: "10.00",
      topped_up_balance: "100.25",
    },
  ],
}

const MOONSHOT = {
  code: 0,
  data: {
    available_balance: 49.58894,
    voucher_balance: 0,
    cash_balance: 49.58894,
  },
  scode: "0x0",
  status: true,
}

const OPENROUTER = {
  data: { total_credits: 10, total_usage: 3.5 },
}

const SILICONFLOW = {
  code: 20000,
  message: "OK",
  status: true,
  data: {
    id: "user-1",
    name: "tester",
    balance: "12.34",
    chargeBalance: "0.00",
    totalBalance: "12.34",
  },
}

const STEPFUN = { object: "account", balance: 20.5 }

const COMMANDCODE = {
  credits: {
    planId: "pro",
    monthlyCredits: 100,
    purchasedCredits: 12.5,
    freeCredits: 2.5,
  },
  windowLimits: { limited: false },
}

const NEW_API_USER_SELF = {
  success: true,
  message: "",
  data: { id: 1, username: "tester", quota: 250000, used_quota: 0 },
}

const NEW_API_TOKEN_USAGE = {
  code: true,
  message: "ok",
  data: {
    object: "token_usage",
    name: "key-1",
    total_granted: 500000,
    total_used: 100000,
    total_available: 400000,
  },
}

describe("numberFrom", () => {
  test("accepts numbers and numeric strings, rejects the rest", () => {
    expect(numberFrom(3.5)).toBe(3.5)
    expect(numberFrom("3.5")).toBe(3.5)
    expect(numberFrom("  12  ")).toBe(12)
    expect(numberFrom("")).toBeUndefined()
    expect(numberFrom("abc")).toBeUndefined()
    expect(numberFrom(null)).toBeUndefined()
    expect(numberFrom(Number.NaN)).toBeUndefined()
  })
})

describe("currencySign / money", () => {
  test("maps the known currencies and falls back to the code", () => {
    expect(currencySign("CNY")).toBe("¥")
    expect(currencySign("RMB")).toBe("¥")
    expect(currencySign("usd")).toBe("$")
    expect(currencySign("")).toBe("")
    expect(currencySign("EUR")).toBe("EUR ")
  })

  test("formats sign plus two decimals", () => {
    expect(money("¥", 12.3)).toBe("¥12.30")
    expect(money("$", 3)).toBe("$3.00")
    expect(money("", 0.5)).toBe("0.50")
  })
})

describe("readDottedPath", () => {
  const root = { data: { quota: 7, items: [{ amount: 1 }, { amount: 2 }] } }

  test("reads plain, data-prefixed and $-rooted paths", () => {
    expect(readDottedPath(root, "data.quota")).toBe(7)
    expect(readDottedPath(root, "$data.quota")).toBe(7)
    expect(readDottedPath(root, "$.data.quota")).toBe(7)
  })

  test("indexes into arrays", () => {
    expect(readDottedPath(root, "data.items.1.amount")).toBe(2)
    expect(readDottedPath(root, "$data.items.0.amount")).toBe(1)
  })

  test("returns undefined on any miss", () => {
    expect(readDottedPath(root, "data.missing")).toBeUndefined()
    expect(readDottedPath(root, "data.items.9")).toBeUndefined()
    expect(readDottedPath(root, "data.items.x")).toBeUndefined()
    expect(readDottedPath(root, "data.quota.deeper")).toBeUndefined()
    expect(readDottedPath(root, "")).toBeUndefined()
    expect(readDottedPath(undefined, "a.b")).toBeUndefined()
  })
})

describe("normalizeHost", () => {
  test("reduces URLs, host:port and blanks", () => {
    expect(normalizeHost("https://api.deepseek.com/v1")).toBe(
      "api.deepseek.com",
    )
    expect(normalizeHost("api.Moonshot.CN:443")).toBe("api.moonshot.cn")
    expect(normalizeHost("")).toBeUndefined()
    expect(normalizeHost(undefined)).toBeUndefined()
  })
})

describe("knownBalanceSource", () => {
  test("DeepSeek reads balance_infos in CNY", () => {
    const source = knownBalanceSource({ chat: "https://api.deepseek.com/v1" })
    expect(source?.url).toBe("https://api.deepseek.com/user/balance")
    const parsed = source!.read(JSON.stringify(DEEPSEEK))
    expect(parsed?.amount).toBe(110.25)
    expect(parsed?.currency).toBe("CNY")
    expect(parsed?.display).toBe("¥110.25")
  })

  test("Moonshot cn vs ai differ only by currency", () => {
    const cn = knownBalanceSource({ chat: "api.moonshot.cn" })!
    const ai = knownBalanceSource({ chat: "api.moonshot.ai" })!
    expect(cn.url).toBe("https://api.moonshot.cn/v1/users/me/balance")
    expect(ai.url).toBe("https://api.moonshot.ai/v1/users/me/balance")
    expect(cn.read(JSON.stringify(MOONSHOT))?.display).toBe("¥49.59")
    expect(ai.read(JSON.stringify(MOONSHOT))?.display).toBe("$49.59")
  })

  test("OpenRouter credits minus usage", () => {
    const source = knownBalanceSource({ chat: "https://openrouter.ai/api/v1" })!
    expect(source.url).toBe("https://openrouter.ai/api/v1/credits")
    expect(source.read(JSON.stringify(OPENROUTER))).toMatchObject({
      amount: 6.5,
      currency: "USD",
      display: "$6.50",
    })
  })

  test("OpenRouter clamps a negative balance to zero", () => {
    const source = knownBalanceSource({ chat: "openrouter.ai" })!
    const parsed = source.read(
      JSON.stringify({ data: { total_credits: 1, total_usage: 2 } }),
    )
    expect(parsed?.amount).toBe(0)
  })

  test("SiliconFlow cn vs com still read totalBalance", () => {
    const cn = knownBalanceSource({ chat: "api.siliconflow.cn" })!
    const com = knownBalanceSource({ chat: "api.siliconflow.com" })!
    expect(cn.url).toBe("https://api.siliconflow.cn/v1/user/info")
    expect(com.url).toBe("https://api.siliconflow.com/v1/user/info")
    expect(cn.read(JSON.stringify(SILICONFLOW))?.display).toBe("¥12.34")
    expect(com.read(JSON.stringify(SILICONFLOW))?.display).toBe("$12.34")
  })

  test("StepFun reads the account balance and defaults its currency by host", () => {
    const cn = knownBalanceSource({ anthropic: "api.stepfun.com" })!
    const ai = knownBalanceSource({ anthropic: "api.stepfun.ai" })!
    expect(cn.url).toBe("https://api.stepfun.com/v1/accounts")
    expect(ai.url).toBe("https://api.stepfun.ai/v1/accounts")
    expect(cn.read(JSON.stringify(STEPFUN))?.display).toBe("¥20.50")
    expect(ai.read(JSON.stringify(STEPFUN))?.display).toBe("$20.50")
  })

  test("Command Code sums purchased and free credits", () => {
    const source = knownBalanceSource({ chat: "api.commandcode.ai" })!
    expect(source.url).toBe("https://api.commandcode.ai/alpha/billing/credits")
    expect(source.read(JSON.stringify(COMMANDCODE))).toMatchObject({
      amount: 15,
      display: "$15.00",
    })
  })

  test("aihubmix without a token reads the public remain summary", () => {
    const source = knownBalanceSource({ chat: "https://aihubmix.com/v1" })!
    expect(source.url).toBe("https://aihubmix.com/dashboard/billing/remain")
    expect(source.token).toBeUndefined()
    expect(
      source.read(JSON.stringify({ data: { remain: 5.25 } }))?.display,
    ).toBe("$5.25")
  })

  test("aihubmix with a token reads its account quota", () => {
    const source = knownBalanceSource({ chat: "aihubmix.com" }, "bt-1")!
    expect(source.url).toBe("https://aihubmix.com/api/user/self")
    expect(source.token).toBe("bt-1")
    // 250000 quota units / 500000 = $0.50.
    expect(source.read(JSON.stringify(NEW_API_USER_SELF))?.display).toBe(
      "$0.50",
    )
  })

  test("returns undefined for an unknown host", () => {
    expect(
      knownBalanceSource({ chat: "https://example.com/v1" }),
    ).toBeUndefined()
    expect(knownBalanceSource({})).toBeUndefined()
  })

  test("a garbage body never yields a result", () => {
    const source = knownBalanceSource({ chat: "api.deepseek.com" })!
    expect(source.read("<html>nope</html>")).toBeUndefined()
    expect(source.read(JSON.stringify({}))).toBeUndefined()
  })
})

describe("new-api style relays", () => {
  test("/api/user/self converts data.quota to USD by 500000", () => {
    const source = customBalanceSource({
      url: "https://relay.example.com/api/user/self",
    })
    const parsed = source.read(JSON.stringify(NEW_API_USER_SELF))
    expect(parsed?.amount).toBe(0.5)
    expect(parsed?.currency).toBe("USD")
    expect(parsed?.display).toBe("$0.50")
  })

  test("/api/usage/token reads the key's own remaining quota", () => {
    const source = customBalanceSource({
      url: "https://relay.example.com/api/usage/token",
    })
    const parsed = source.read(JSON.stringify(NEW_API_TOKEN_USAGE))
    expect(parsed?.amount).toBe(0.8)
    expect(parsed?.display).toBe("$0.80")
  })

  test("a custom path on a relay URL stays in quota units", () => {
    const source = customBalanceSource({
      url: "https://relay.example.com/api/user/self",
      path: "$data.used_quota",
    })
    expect(
      source.read(JSON.stringify({ data: { used_quota: 500000 } }))?.amount,
    ).toBe(1)
  })

  test("a custom path on a plain URL is a raw amount", () => {
    const source = customBalanceSource({
      url: "https://relay.example.com/wallet",
      path: "$data.wallet.balance",
    })
    const parsed = source.read(
      JSON.stringify({ data: { wallet: { balance: 7.5 } } }),
    )
    expect(parsed?.amount).toBe(7.5)
    expect(parsed?.display).toBe("$7.50")
  })
})

describe("resolveBalanceSource", () => {
  test("a custom URL wins over the known host", () => {
    const source = resolveBalanceSource({
      hosts: { chat: "api.deepseek.com" },
      balanceUrl: "https://relay.example.com/api/user/self",
      balanceToken: "bt-1",
    })!
    expect(source.url).toBe("https://relay.example.com/api/user/self")
    expect(source.token).toBe("bt-1")
  })

  test("without a custom URL the known host is used", () => {
    const source = resolveBalanceSource({ hosts: { chat: "api.moonshot.ai" } })!
    expect(source.url).toBe("https://api.moonshot.ai/v1/users/me/balance")
  })

  test("returns undefined when nothing matches", () => {
    expect(
      resolveBalanceSource({ hosts: { chat: "example.com" } }),
    ).toBeUndefined()
    expect(resolveBalanceSource({})).toBeUndefined()
  })
})

describe("takesBalanceToken", () => {
  test("true for a custom relay URL and for aihubmix", () => {
    expect(takesBalanceToken({ hosts: { chat: "aihubmix.com" } })).toBe(true)
    expect(
      takesBalanceToken({
        hosts: { chat: "api.deepseek.com" },
        balanceUrl: "https://relay.example.com/api/user/self",
      }),
    ).toBe(true)
    expect(
      takesBalanceToken(
        { chat: "api.deepseek.com" },
        "https://relay.example.com",
      ),
    ).toBe(true)
  })

  test("false for vendors that reuse the connection key", () => {
    expect(takesBalanceToken({ chat: "api.deepseek.com" })).toBe(false)
    expect(takesBalanceToken({})).toBe(false)
  })
})

describe("fetchBalance", () => {
  const jsonResponse = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    })

  test("sends the passed key as Bearer and reads the body", async () => {
    const seen: Array<{ url: string; auth?: string }> = []
    setBalanceFetcher((url, init) => {
      seen.push({
        url,
        auth: (init?.headers as Record<string, string> | undefined)
          ?.authorization,
      })
      return Promise.resolve(jsonResponse(DEEPSEEK))
    })

    const source = knownBalanceSource({ chat: "api.deepseek.com" })!
    const parsed = await fetchBalance(source, undefined, "sk-1")

    expect(seen[0]?.url).toBe("https://api.deepseek.com/user/balance")
    expect(seen[0]?.auth).toBe("Bearer sk-1")
    expect(parsed?.display).toBe("¥110.25")
  })

  test("sends a source token as the whole Authorization header", async () => {
    let auth: string | undefined
    setBalanceFetcher((_url, init) => {
      auth = (init?.headers as Record<string, string> | undefined)
        ?.authorization
      return Promise.resolve(jsonResponse(NEW_API_USER_SELF))
    })

    const source = resolveBalanceSource({
      balanceUrl: "https://relay.example.com/api/user/self",
      balanceToken: "raw-token",
    })!
    const parsed = await fetchBalance(source)

    expect(auth).toBe("raw-token")
    expect(parsed?.display).toBe("$0.50")
  })

  test("returns undefined on a non-2xx status", async () => {
    setBalanceFetcher(() => Promise.resolve(jsonResponse({}, 401)))
    const source = knownBalanceSource({ chat: "api.deepseek.com" })!
    expect(await fetchBalance(source, undefined, "sk-1")).toBeUndefined()
  })

  test("returns undefined when the request throws", async () => {
    setBalanceFetcher(() => Promise.reject(new Error("network down")))
    const source = knownBalanceSource({ chat: "api.deepseek.com" })!
    expect(await fetchBalance(source, undefined, "sk-1")).toBeUndefined()
  })

  test("returns undefined when the body is unreadable", async () => {
    setBalanceFetcher(() => Promise.resolve(jsonResponse({ nope: true })))
    const source = knownBalanceSource({ chat: "api.deepseek.com" })!
    expect(await fetchBalance(source, undefined, "sk-1")).toBeUndefined()
  })
})
