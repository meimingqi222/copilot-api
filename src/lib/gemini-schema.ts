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
