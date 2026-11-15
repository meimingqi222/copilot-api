import { asRecord } from "~/lib/json-shape"

/** Strip internal extensions only at egress, after translation and accounting. */
export function publicUsageResponse<T>(value: T): T {
  const body = asRecord(value)
  if (!body) return value
  const result = { ...body }
  const usage = asRecord(body.usage)
  if (usage) result.usage = publicUsage(usage)

  // Messages message_start and Responses lifecycle events wrap the response.
  // Do not recurse through content or tool arguments that happen to use these names.
  for (const key of ["message", "response"]) {
    const nested = asRecord(body[key])
    const nestedUsage = asRecord(nested?.usage)
    if (nestedUsage) {
      result[key] = { ...nested, usage: publicUsage(nestedUsage) }
    }
  }
  return result as T
}

function publicUsage(usage: Record<string, unknown>): Record<string, unknown> {
  const result = { ...usage }
  delete result.context_window
  delete result.usage_status

  // Cache writes are standard Messages fields, but not OpenAI detail fields.
  // Keep inclusive OpenAI input totals unchanged when dropping their internal breakdown.
  for (const key of ["prompt_tokens_details", "input_tokens_details"]) {
    const details = asRecord(usage[key])
    if (
      !details
      || !(
        "cache_creation_input_tokens" in details || "cache_creation" in details
      )
    )
      continue
    const standard = { ...details }
    delete standard.cache_creation_input_tokens
    delete standard.cache_creation
    if (Object.keys(standard).length > 0) result[key] = standard
    else delete result[key]
  }
  return result
}

export function publicUsageData(data: string): string {
  if (
    !data.includes("context_window")
    && !data.includes("usage_status")
    && !data.includes("cache_creation")
  )
    return data
  try {
    return JSON.stringify(publicUsageResponse(JSON.parse(data)))
  } catch {
    // Malformed/non-JSON upstream frames retain the existing forwarding behavior.
    return data
  }
}
