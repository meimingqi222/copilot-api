import type { ModelMapping } from "~/lib/provider-connections"

export function parseWorkbuddyImageModels(data: unknown): Array<ModelMapping> {
  if (!data || typeof data !== "object" || !("models" in data)) return []
  if (!Array.isArray(data.models)) return []

  const entries = new Map<string, { name?: string; tags: Set<string> }>()
  for (const row of data.models as Array<unknown>) {
    if (!row || typeof row !== "object" || !("id" in row)) continue
    if (typeof row.id !== "string" || !row.id || !("tags" in row)) continue
    if (!Array.isArray(row.tags)) continue
    entries.set(row.id, {
      name:
        "name" in row && typeof row.name === "string" ? row.name : undefined,
      tags: new Set(
        (row.tags as Array<unknown>).flatMap((tag) =>
          typeof tag === "string" ? [tag.trim().toLowerCase()] : [],
        ),
      ),
    })
  }
  return [...entries].flatMap(([id, entry]) => {
    if (!entry.tags.has("text-to-image")) return []
    const editor =
      entry.tags.has("image-to-image") ? id
      : entries.get(`${id}-edit`)?.tags.has("image-to-image") ? `${id}-edit`
      : undefined
    return [
      {
        publicId: id,
        upstreamId: id,
        name: entry.name ?? id,
        endpoints: ["images"],
        enabled: true,
        pickerEnabled: true,
        metadata: editor ? { workbuddyImageEditor: editor } : undefined,
      },
    ]
  })
}
