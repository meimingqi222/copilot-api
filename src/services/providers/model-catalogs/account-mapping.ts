import { endpointsFromSupported } from "~/lib/provider-connections"
import type { AccountModel, ModelMapping } from "~/lib/provider-connections"

export function accountModelsToMappings(
  models: Array<AccountModel>,
): Array<ModelMapping> {
  return models.map((m) => ({
    publicId: m.id,
    upstreamId: m.upstreamId || m.id,
    name: m.name,
    vendor: m.vendor,
    enabled: true,
    pickerEnabled: m.pickerEnabled,
    pickerCategory: m.pickerCategory,
    endpoints: endpointsFromSupported(m.supportedEndpoints),
    ...(m.efforts && m.efforts.length > 0 ? { efforts: [...m.efforts] } : {}),
  }))
}
