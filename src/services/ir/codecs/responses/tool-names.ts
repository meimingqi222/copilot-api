import { createHash } from "node:crypto"

/**
 * The name a namespaced Responses tool is offered under on a wire without
 * namespaces, kept within Chat's 64-character limit.
 */
export function flatToolName(namespace: string, name: string): string {
  const flat = `${namespace}__${name}`
  if (flat.length <= 64) return flat
  const suffix = createHash("sha256")
    .update(`${namespace}\0${name}`)
    .digest("hex")
    .slice(0, 8)
  return `${flat.slice(0, 55)}_${suffix}`
}
