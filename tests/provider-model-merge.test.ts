import { afterEach, describe, expect, test } from "bun:test"

import {
  __resetProviderConnectionsForTest,
  createConnection,
  getProviderConnection,
  mergeDiscoveredModels,
  mergeProviderRefreshedModels,
  normalizeModelAliases,
  updateModel,
  type ModelMapping,
} from "~/lib/provider-connections"

function model(
  publicId: string,
  overrides: Partial<ModelMapping> = {},
): ModelMapping {
  return {
    publicId,
    upstreamId: publicId,
    endpoints: ["chat"],
    enabled: true,
    ...overrides,
  }
}

describe("mergeDiscoveredModels", () => {
  test("空列表首次发现:保持上游原值(开箱即用)", () => {
    const discovered = [model("a"), model("b")]
    const { models, added } = mergeDiscoveredModels([], discovered)
    expect(added).toBe(2)
    expect(models.map((m) => m.publicId)).toEqual(["a", "b"])
    expect(models.every((m) => m.enabled)).toBe(true)
  })

  test("非空列表:已存在模型原样保留(含 enabled 与改名)", () => {
    const existing = [
      model("keep", { enabled: true }),
      model("off", { enabled: false }),
      model("renamed", { upstreamId: "upstream-x", enabled: true }),
    ]
    const discovered = [
      model("keep"),
      model("off"),
      model("renamed", { upstreamId: "upstream-x" }),
    ]
    const { models, added } = mergeDiscoveredModels(existing, discovered)
    expect(added).toBe(0)
    expect(models).toHaveLength(3)
    expect(models.find((m) => m.publicId === "off")?.enabled).toBe(false)
    expect(models.find((m) => m.publicId === "renamed")?.upstreamId).toBe(
      "upstream-x",
    )
  })

  test("非空列表:新发现模型默认禁用并对 picker 隐藏", () => {
    const existing = [model("keep")]
    const discovered = [model("keep"), model("new-a"), model("new-b")]
    const { models, added } = mergeDiscoveredModels(existing, discovered)
    expect(added).toBe(2)
    expect(models.map((m) => m.publicId)).toEqual(["keep", "new-a", "new-b"])
    expect(models.find((m) => m.publicId === "keep")?.enabled).toBe(true)
    for (const id of ["new-a", "new-b"]) {
      const m = models.find((x) => x.publicId === id)
      expect(m?.enabled).toBe(false)
      expect(m?.pickerEnabled).toBe(false)
    }
  })

  test("discovered 内重复 id 只追加一次", () => {
    const { models, added } = mergeDiscoveredModels(
      [model("keep")],
      [model("dup"), model("dup")],
    )
    expect(added).toBe(1)
    expect(models.filter((m) => m.publicId === "dup")).toHaveLength(1)
  })

  test("用户改名后上游原名不再当新模型加回来", () => {
    const existing = [
      model("ds-flash", { upstreamId: "deepseek/deepseek-v4-flash" }),
    ]
    const discovered = [
      model("deepseek/deepseek-v4-flash", {
        upstreamId: "deepseek/deepseek-v4-flash",
      }),
      model("other-model", { upstreamId: "other-model" }),
    ]
    const { models, added } = mergeDiscoveredModels(existing, discovered)
    expect(added).toBe(1)
    expect(models.map((m) => m.publicId)).toEqual(["ds-flash", "other-model"])
    expect(models.find((m) => m.publicId === "other-model")?.enabled).toBe(
      false,
    )
  })
})

describe("mergeProviderRefreshedModels", () => {
  test("空列表直接采用上游原值", () => {
    const fresh = [model("a"), model("b")]
    expect(mergeProviderRefreshedModels([], fresh)).toEqual(fresh)
    expect(mergeProviderRefreshedModels(undefined, fresh)).toEqual(fresh)
  })

  test("用户改名按 upstreamId 保留,上游新字段照单全收", () => {
    const existing = [model("my-gpt", { upstreamId: "gpt-4o", enabled: true })]
    const fresh = [
      model("gpt-4o", {
        upstreamId: "gpt-4o",
        name: "GPT-4o (new name)",
        endpoints: ["chat", "responses"] as Array<"chat" | "responses">,
      }),
    ]
    const merged = mergeProviderRefreshedModels(existing, fresh)
    expect(merged).toHaveLength(1)
    expect(merged[0].publicId).toBe("my-gpt")
    expect(merged[0].name).toBe("GPT-4o (new name)")
    expect(merged[0].endpoints).toEqual(["chat", "responses"])
  })

  test("用户禁用粘性保留,上游新增模型原样加入", () => {
    const existing = [model("old-off", { enabled: false })]
    const fresh = [model("old-off"), model("brand-new")]
    const merged = mergeProviderRefreshedModels(existing, fresh)
    expect(merged.find((m) => m.publicId === "old-off")?.enabled).toBe(false)
    expect(merged.find((m) => m.publicId === "brand-new")?.enabled).toBe(true)
  })

  test("用户别名保留,上游移除的模型被丢弃", () => {
    const existing = [
      model("m", { aliases: ["legacy-name"] }),
      model("gone", { enabled: false }),
    ]
    const merged = mergeProviderRefreshedModels(existing, [model("m")])
    expect(merged).toHaveLength(1)
    expect(merged[0].aliases).toEqual(["legacy-name"])
  })

  test("未改名的默认映射跟随上游 publicId", () => {
    const existing = [model("gpt-4o", { upstreamId: "gpt-4o" })]
    const fresh = [model("gpt-4o-v2", { upstreamId: "gpt-4o" })]
    const merged = mergeProviderRefreshedModels(existing, fresh)
    expect(merged[0].publicId).toBe("gpt-4o-v2")
  })

  test("显式改名标记优先于字符串启发式", () => {
    // publicId 与 upstreamId 相同(启发式判定为未改名),但标记位说了算
    const existing = [
      model("X", { upstreamId: "X", metadata: { renamedByUser: true } }),
    ]
    const fresh = [model("Y", { upstreamId: "X" })]
    const merged = mergeProviderRefreshedModels(existing, fresh)
    expect(merged[0].publicId).toBe("X")
  })
})

describe("normalizeModelAliases", () => {
  test("缺失/非法输入返回 undefined(调用方保持原值)", () => {
    expect(normalizeModelAliases(undefined)).toBeUndefined()
    expect(normalizeModelAliases("nope")).toBeUndefined()
  })

  test("去空去重(大小写不敏感)并截断", () => {
    expect(normalizeModelAliases([" a ", "", "A", "b", 42])).toEqual(["a", "b"])
  })

  test("空数组表示清空", () => {
    expect(normalizeModelAliases([])).toEqual([])
  })
})

describe("renamedByUser 标记", () => {
  afterEach(() => {
    __resetProviderConnectionsForTest()
  })

  test("updateModel 改名打标,改回 upstreamId 清除", async () => {
    __resetProviderConnectionsForTest()
    await createConnection({
      id: "flag-conn",
      name: "flag",
      protocol: "openai-compatible",
      baseUrl: "https://example.com/v1",
      models: [
        {
          publicId: "gpt-4o",
          upstreamId: "gpt-4o",
          endpoints: ["chat"],
          enabled: true,
        },
      ],
    })
    await updateModel("flag-conn", "gpt-4o", { publicId: "my-gpt" })
    let stored = getProviderConnection("flag-conn")?.models?.[0]
    expect(stored?.publicId).toBe("my-gpt")
    expect(stored?.metadata?.renamedByUser).toBe(true)

    await updateModel("flag-conn", "my-gpt", { publicId: "gpt-4o" })
    stored = getProviderConnection("flag-conn")?.models?.[0]
    expect(stored?.publicId).toBe("gpt-4o")
    expect(stored?.metadata?.renamedByUser).toBeUndefined()
  })
})
