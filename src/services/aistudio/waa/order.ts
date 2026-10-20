/** Physically reorder configurable string properties; do not override reflection.
 * Integer indices, symbols and non-configurable prefixes retain native semantics.
 */
export function orderKeys(target: object, names: readonly string[]): void {
  const index = (key: string) =>
    String(Number(key) >>> 0) === key && key !== "4294967295"
  const current = Reflect.ownKeys(target).filter(
    (k): k is string => typeof k === "string" && !index(k),
  )
  const present = new Set(current)
  const wanted = [...new Set([...names, ...current])].filter(
    (k) => present.has(k) && !index(k),
  )
  const fixed = current.filter(
    (k) => !Object.getOwnPropertyDescriptor(target, k)!.configurable,
  )
  const last = Math.max(-1, ...fixed.map((k) => wanted.indexOf(k)))
  const prefix = wanted.slice(0, last + 1)
  const retained = new Set(prefix)
  if (
    !Object.isExtensible(target)
    || !current.filter((k) => retained.has(k)).every((k, i) => k === prefix[i])
  )
    return
  const saved = wanted
    .slice(last + 1)
    .map((k) => [k, Object.getOwnPropertyDescriptor(target, k)!] as const)
  for (const [key] of saved) {
    if (!Reflect.deleteProperty(target, key))
      throw new TypeError("WAA key ordering failed")
  }
  for (const [key, descriptor] of saved)
    Object.defineProperty(target, key, descriptor)
}
