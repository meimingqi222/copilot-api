import type { ModelMapping } from "~/lib/provider-connections"

/** Only Playground chat models: no paid, Live, video or Interactions-only IDs. */
export function decodeAIStudioModels(value: unknown): Array<ModelMapping> {
  if (!Array.isArray(value) || !Array.isArray(value[0]))
    throw new Error("Invalid AI Studio model catalog")
  const models: ModelMapping[] = []
  for (const row of value[0] as unknown[]) {
    if (!Array.isArray(row) || typeof row[0] !== "string") continue
    const methods: unknown[] = Array.isArray(row[7]) ? row[7] : []
    const capabilities: unknown[] = Array.isArray(row[64]) ? row[64] : []
    if (
      !methods.includes("generateContent")
      || !capabilities.includes(1)
      || [20, 21, 26, 37, 53].some((route) => capabilities.includes(route))
      || row[77] === 2
      || row[78] != null
    )
      continue
    const id = row[0].replace(/^models\//, "")
    if (!id) continue
    models.push({
      publicId: id,
      upstreamId: id,
      name: typeof row[3] === "string" ? row[3] : id,
      vendor: "Google",
      endpoints: ["gemini"],
      enabled: true,
      pickerEnabled: true,
      metadata: {
        inputTokenLimit: row[5],
        outputTokenLimit: row[6],
        thinkingConfig: row[71],
        isFree: true,
      },
    })
  }
  return models
}
