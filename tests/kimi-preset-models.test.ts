/**
 * Kimi 系列预设的模型清单与档位标签回归测试。
 *
 * 预设的 `defaultModels` 是新建连接时直接落库的模型映射：列的是上游已经不认的
 * ID，新连接一开就是 “model not found”，而报错看起来像 key 或地址配错了。
 * Kimi 下线得很快（platform.kimi.ai/docs/models 的下线清单）：
 *
 * - `kimi-k2` 系列（含 `kimi-k2-thinking(-turbo)`、`kimi-k2-0905-preview`、
 *   `kimi-k2-0711-preview`、`kimi-k2-turbo-preview`）于 2026-05-25 下线；
 * - `kimi-latest` 于 2026-01-28 下线；`kimi-k2.5`、`moonshot-v1-*`、
 *   `kimi-thinking-preview` 同样已下线。
 *
 * 这里只约束 Moonshot 自家的预设（`api.moonshot.cn` / `api.kimi.com`）：
 * 聚合商的预设列的是别家的模型 ID（如 OpenRouter 的 `moonshotai/kimi-k2-0905`），
 * 那由聚合商自己决定，不在这条规则里。
 */
import { describe, expect, test } from "bun:test"

import {
  BUILTIN_PROVIDER_PRESETS,
  type ProviderPreset,
} from "~/lib/provider-presets"

/** Kimi 官方下线清单里的 ID（见文件头注释）。 */
const RETIRED_KIMI_IDS = [
  "kimi-latest",
  "kimi-k2-thinking",
  "kimi-k2-thinking-turbo",
  "kimi-k2-0905-preview",
  "kimi-k2-0711-preview",
  "kimi-k2-turbo-preview",
  "kimi-k2",
  "kimi-k2.5",
  "kimi-thinking-preview",
  "moonshot-v1-8k",
  "moonshot-v1-32k",
  "moonshot-v1-128k",
  "moonshot-v1-auto",
]

/** 基地址所在的主机，地址不是一个绝对 URL 时为空（如 Azure 的预设）。 */
function hostOf(baseUrl: string): string {
  try {
    return new URL(baseUrl).hostname
  } catch {
    return ""
  }
}

/** Moonshot 自家的预设：基地址在它自己的域名上。 */
function firstPartyKimiPresets(): Array<ProviderPreset> {
  return BUILTIN_PROVIDER_PRESETS.filter((p) => {
    const host = hostOf(p.baseUrl)
    return (
      host === "api.moonshot.cn"
      || host === "api.moonshot.ai"
      || host === "api.kimi.com"
      || host === "api.kimi.ai"
    )
  })
}

function preset(id: string): ProviderPreset {
  const found = BUILTIN_PROVIDER_PRESETS.find((p) => p.id === id)
  if (!found) throw new Error(`Missing preset ${id}`)
  return found
}

describe("Kimi presets list current model ids", () => {
  test("no first-party Kimi preset lists a retired model id", () => {
    const listed = firstPartyKimiPresets().flatMap((p) =>
      (p.defaultModels || []).map((m) => [p.id, m.publicId] as const),
    )
    expect(listed.length).toBeGreaterThan(0)
    const retired = listed.filter(([, id]) => RETIRED_KIMI_IDS.includes(id))
    expect(retired).toEqual([])
  })

  test("every first-party Kimi preset is reachable by its own model list", () => {
    // 每个预设都要有模型可选，否则新建连接后必须先去「在线获取模型」
    for (const p of firstPartyKimiPresets()) {
      expect(p.defaultModels?.length ?? 0).toBeGreaterThan(0)
      for (const m of p.defaultModels || []) {
        expect(m.upstreamId).toBe(m.publicId)
        expect(m.endpoints?.length ?? 0).toBeGreaterThan(0)
      }
    }
  })

  test("Kimi Coding lists the ids its /coding endpoint serves, and nothing else", () => {
    const ids = (preset("moonshot-coding").defaultModels || []).map(
      (m) => m.publicId,
    )
    for (const id of [
      "kimi-for-coding",
      "kimi-for-coding-highspeed",
      "k3",
      "k3-256k",
    ]) {
      expect(ids).toContain(id)
    }
    // /coding 只认 Kimi Code 的模型 ID：列别的一律被上游拒掉
    for (const id of ids) {
      expect(id).toMatch(/^(kimi-for-coding(-highspeed)?|k3(-256k)?)$/)
    }
    // 模型都在 Anthropic 协议的 /messages 上
    for (const m of preset("moonshot-coding").defaultModels || []) {
      expect(m.endpoints).toEqual(["messages"])
    }
  })

  test("the open-platform presets list the platform's current ids", () => {
    for (const id of ["moonshot", "moonshot-anthropic"]) {
      const ids = (preset(id).defaultModels || []).map((m) => m.publicId)
      expect(ids).toContain("kimi-k3")
      expect(ids).toContain("kimi-k2.7-code")
    }
  })

  test("the overseas presets mirror the home ones", () => {
    // 开放平台海外站：同一套模型 ID，且不带任何客户端身份头（那个 API
    // 不挑客户端）
    for (const [home, away] of [
      ["moonshot", "moonshot-ai"],
      ["moonshot-anthropic", "moonshot-ai-anthropic"],
    ] as const) {
      expect(preset(away).baseUrl).toContain("api.moonshot.ai")
      expect(preset(away).protocol).toBe(preset(home).protocol)
      expect((preset(away).defaultModels || []).map((m) => m.publicId)).toEqual(
        (preset(home).defaultModels || []).map((m) => m.publicId),
      )
      expect(preset(away).headers).toBeUndefined()
    }
    // Kimi Code 海外站：同一个订阅服务，同一个客户端白名单，模型与头一致
    expect(preset("moonshot-coding-global").baseUrl).toBe(
      "https://api.kimi.ai/coding",
    )
    expect(preset("moonshot-coding-global").headers).toEqual(
      preset("moonshot-coding").headers,
    )
    expect(preset("moonshot-coding-global").defaultModels).toEqual(
      preset("moonshot-coding").defaultModels,
    )
  })

  test("Kimi Code models carry the membership tier that unlocks them", () => {
    const tiers = Object.fromEntries(
      (preset("moonshot-coding").defaultModels || []).map((m) => [
        m.publicId,
        m.tier,
      ]),
    )
    // kimi-for-coding 全档可用：没有标签（而不是写个 “All” 占位）
    expect(tiers).toEqual({
      "kimi-for-coding": undefined,
      "kimi-for-coding-highspeed": "Pro+",
      k3: "Plus+",
      "k3-256k": "Plus+",
    })
    // 档位只是提示，不能变成过滤器：模型仍然一个不少地列出来
    expect(Object.keys(tiers)).toHaveLength(4)
  })
})
