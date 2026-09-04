/**
 * JSON Schema 相关的 xAI 函数参数规范化逻辑。
 * 从 `sanitize-body.ts` 拆分而来，纯代码移动，无行为变更。
 */

/**
 * Detect JSON Schema root unions (anyOf/oneOf/allOf) whose branches are not
 * exclusively objects — xAI rejects those function parameters. A branch with
 * a missing `type` is not object-only (CPA `xaiSchemaTypeIsObjectOnly`).
 */
export function hasNonObjectRootUnion(
  schema: Record<string, unknown>,
): boolean {
  for (const key of ["anyOf", "oneOf", "allOf"] as const) {
    const branches = schema[key]
    if (!Array.isArray(branches) || branches.length === 0) continue
    for (const branch of branches) {
      if (!branch || typeof branch !== "object" || Array.isArray(branch)) {
        return true
      }
      if (!xaiSchemaTypeIsObjectOnly((branch as { type?: unknown }).type)) {
        return true
      }
    }
  }
  return false
}

export function xaiSchemaTypeIsObjectOnly(schemaType: unknown): boolean {
  if (typeof schemaType === "string") {
    return schemaType.trim().toLowerCase() === "object"
  }
  if (Array.isArray(schemaType)) {
    if (schemaType.length === 0) return false
    return schemaType.every(
      (item) =>
        typeof item === "string" && item.trim().toLowerCase() === "object",
    )
  }
  return false
}

/**
 * Inject `type: "object"` into root anyOf/oneOf branches that omit it when
 * the parameters root only permits objects. Mirrors CPA
 * `normalizeXAIObjectRootUnionBranchTypes`.
 */
export function injectObjectRootUnionBranchTypes(
  tool: Record<string, unknown>,
): Record<string, unknown> | null {
  const parameters = tool.parameters
  if (
    !parameters
    || typeof parameters !== "object"
    || Array.isArray(parameters)
  ) {
    return null
  }
  const record = parameters as Record<string, unknown>
  if (record.type !== "object") return null

  const hasUntypedBranch = (["anyOf", "oneOf"] as const).some((unionName) => {
    const branches = record[unionName]
    if (!Array.isArray(branches)) return false
    return branches.some(
      (branch) =>
        Boolean(branch)
        && typeof branch === "object"
        && !Array.isArray(branch)
        && (branch as { type?: unknown }).type === undefined,
    )
  })
  if (!hasUntypedBranch) return null

  const nextParameters = { ...record }
  for (const unionName of ["anyOf", "oneOf"] as const) {
    const branches = nextParameters[unionName]
    if (!Array.isArray(branches)) continue
    nextParameters[unionName] = branches.map((branch): unknown => {
      if (!branch || typeof branch !== "object" || Array.isArray(branch)) {
        return branch
      }
      const branchRecord = branch as Record<string, unknown>
      if (branchRecord.type !== undefined) return branch
      return { ...branchRecord, type: "object" }
    })
  }
  return { ...tool, parameters: nextParameters }
}
