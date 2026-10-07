import type { Model } from "~/lib/model-catalog"

import { groupModelReference } from "~/lib/routing-groups/resolve"
import { listRoutingGroups } from "~/lib/routing-groups/store"

/** Only explicitly advertised custom groups add entries to the model picker. */
export async function publicRoutingGroupModels(): Promise<Array<Model>> {
  const groups = await listRoutingGroups()
  return groups
    .filter((group) => group.expose === true)
    .map((group) => ({
      id: groupModelReference(group.id),
      name: group.name,
      object: "model",
      version: "1",
      vendor: "routing-group",
      preview: false,
      model_picker_enabled: true,
      // Client endpoints accepted by group routing, not a member's native wire.
      supported_endpoints: [
        "/chat/completions",
        "/v1/responses",
        "/v1/messages",
        "/generateContent",
      ],
      // A mixed-model pool cannot advertise one member's context or vision limits.
      capabilities: {
        family: "routing-group",
        object: "capabilities",
        tokenizer: "unknown",
        type: "chat",
        supports: { streaming: true },
      },
    }))
}
