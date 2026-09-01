/**
 * JSON Schema 清理模块，移植自 CPA 的 internal/util/gemini_schema.go。
 *
 * Gemini/Antigravity 后端不支持完整 JSON Schema 规范，需要清理工具参数 schema
 * 中的不兼容字段（$schema、propertyNames、additionalProperties、$ref 等），
 * 同时通过 description hint 保留语义信息。
 */

import {
  cleanJsonSchemaInternal,
  type CleanOptions,
} from "./gemini-schema-internal"

/**
 * 清理工具参数 schema，使其兼容 Antigravity API。
 * requirePlaceholder 为 true 时添加空 schema 占位符（Claude VALIDATED 模式需要）。
 */
export function cleanJsonSchemaForAntigravityTool(
  schema: unknown,
  requirePlaceholder: boolean,
): unknown {
  return cleanJsonSchemaInternal(schema, {
    addPlaceholder: requirePlaceholder,
    addMissingArrayItems: true,
    antigravitySemantics: true,
    removeToolTitle: !requirePlaceholder,
    removeGeminiMetadata: false,
    flattenUnions: true,
    forceEnumStringType: false,
    dropAllEnums: true,
    dropBooleanEnums: false,
    preserveAdditionalPropertiesFalse: false,
  } satisfies CleanOptions)
}

/**
 * 清理响应 schema，保留 enum 等约束（不应用工具专有的重写）。
 */
export function cleanJsonSchemaForAntigravityResponse(
  schema: unknown,
): unknown {
  return cleanJsonSchemaInternal(schema, {
    addPlaceholder: false,
    addMissingArrayItems: false,
    antigravitySemantics: true,
    removeToolTitle: false,
    removeGeminiMetadata: false,
    flattenUnions: true,
    forceEnumStringType: false,
    dropAllEnums: false,
    dropBooleanEnums: true,
    preserveAdditionalPropertiesFalse: true,
  } satisfies CleanOptions)
}

/**
 * 清理 Gemini 工具 schema（非 Antigravity）。
 */
export function cleanJsonSchemaForGemini(schema: unknown): unknown {
  return cleanJsonSchemaInternal(schema, {
    addPlaceholder: false,
    addMissingArrayItems: true,
    antigravitySemantics: false,
    removeToolTitle: false,
    removeGeminiMetadata: true,
    flattenUnions: true,
    forceEnumStringType: true,
    dropAllEnums: false,
    dropBooleanEnums: false,
    preserveAdditionalPropertiesFalse: false,
  } satisfies CleanOptions)
}
