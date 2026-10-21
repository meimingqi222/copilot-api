import type { ModelMapping } from "~/lib/provider-connections"

export function isAIStudioModelAllowed(
  accessModes: unknown[],
  benefitTier: number,
): boolean {
  return (
    accessModes.length === 0
    || accessModes.some(
      (mode) =>
        (mode === 3 && [1, 2].includes(benefitTier))
        || (mode === 4 && benefitTier === 2),
    )
  )
}

/** Keep the catalog separate from the routes and entitlements we can serve. */
export function decodeAIStudioModels(
  value: unknown,
  benefitTier: number,
): Array<ModelMapping> {
  if (!Array.isArray(value) || !Array.isArray(value[0]))
    throw new Error("Invalid AI Studio model catalog")
  const models: ModelMapping[] = []
  for (const row of value[0] as unknown[]) {
    if (!Array.isArray(row) || typeof row[0] !== "string")
      throw new Error("Invalid AI Studio model row")
    for (const field of [7, 64, 74, 82]) {
      const items: unknown = row[field]
      if (
        items != null
        && (!Array.isArray(items)
          || !items.every((item: unknown) =>
            field === 7 ? typeof item === "string" : Number.isInteger(item),
          ))
      )
        throw new Error(`Invalid AI Studio model field ${field}`)
    }
    const methods: unknown[] = Array.isArray(row[7]) ? row[7] : []
    const capabilities: unknown[] = Array.isArray(row[64]) ? row[64] : []
    const accessModes: unknown[] = Array.isArray(row[82]) ? row[82] : []
    const supported =
      methods.includes("generateContent")
      && capabilities.includes(1)
      && ![20, 21, 26, 37, 53, 59].some((route) => capabilities.includes(route))
      && row[78] == null
    const allowed = isAIStudioModelAllowed(accessModes, benefitTier)
    const id = row[0].replace(/^models\//, "")
    if (!id || models.some((model) => model.upstreamId === id))
      throw new Error("Empty or duplicate AI Studio model ID")
    const aliasRows: unknown[] = Array.isArray(row[56]) ? row[56] : []
    const aliases =
      typeof aliasRows[0] === "string" ?
        [aliasRows[0]]
      : aliasRows.flatMap((alias) =>
          Array.isArray(alias) && typeof alias[0] === "string" ?
            [alias[0] as string]
          : [],
        )
    models.push({
      publicId: id,
      upstreamId: id,
      aliases: [
        ...new Set(aliases.map((alias) => alias.replace(/^models\//, ""))),
      ].filter((alias) => alias && alias !== id),
      name: typeof row[3] === "string" ? row[3] : id,
      vendor: "Google",
      endpoints: supported && allowed ? ["gemini"] : [],
      enabled: supported && allowed,
      pickerEnabled: supported && allowed,
      metadata: {
        description: row[4],
        methods,
        capabilityCodes: capabilities,
        secondaryCapabilityCodes: row[74] ?? [],
        paid: row[77] === 2,
        accessModes,
        interactionConfig: row[78],
        benefitTier,
        supported,
        accountAllowed: allowed,
        inputTokenLimit: row[5],
        outputTokenLimit: row[6],
        thinkingConfig: row[71],
        isFree: row[77] !== 2,
      },
    })
  }
  return models
}
