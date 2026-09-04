/**
 * gemini-schema 内部实现。移植自 CPA 的 internal/util/gemini_schema.go。
 *
 * 本文件为目录 barrel，将各子模块按关注点拆分后重新聚合。
 */

import {
  moveConstraintsToDescription,
  moveNotToDescription,
} from "~/lib/gemini-schema/constraints"
import {
  convertConstToEnum,
  convertEnumValuesToStrings,
  addEnumHints,
  dropIgnoredEnumsToHints,
  addAdditionalPropertiesHints,
} from "~/lib/gemini-schema/enum-hints"
import {
  removeUnsupportedKeywords,
  removeKeywords,
  removePlaceholderFields,
  cleanupRequiredFields,
  addEmptySchemaPlaceholder,
} from "~/lib/gemini-schema/keywords"
import { inlineLocalRefs, convertRefsToHints } from "~/lib/gemini-schema/refs"
import { normalizeMalformedSchemaObjects } from "~/lib/gemini-schema/repair"
import { type CleanOptions } from "~/lib/gemini-schema/shared"
import {
  mergeConditionals,
  mergeAllOf,
  flattenAnyOfOneOf,
  flattenTypeArrays,
} from "~/lib/gemini-schema/unions"

export type { CleanOptions } from "~/lib/gemini-schema/shared"

// ============================================================
// 公开入口
// ============================================================

export function cleanJsonSchemaInternal(
  input: unknown,
  options: CleanOptions,
): unknown {
  let root = input

  root = normalizeMalformedSchemaObjects(root, options.addMissingArrayItems)

  if (options.antigravitySemantics) {
    root = inlineLocalRefs(root)
  }
  root = convertRefsToHints(root, options.antigravitySemantics)
  root = convertConstToEnum(root)
  root = convertEnumValuesToStrings(root, options.forceEnumStringType)
  root = addEnumHints(root)
  root = dropIgnoredEnumsToHints(root, options)
  if (!options.preserveAdditionalPropertiesFalse) {
    root = addAdditionalPropertiesHints(root)
  }
  root = moveConstraintsToDescription(root, options)
  if (options.antigravitySemantics) {
    root = moveNotToDescription(root)
  }

  root = mergeConditionals(root)
  root = mergeAllOf(root)
  if (options.flattenUnions) {
    root = flattenAnyOfOneOf(root)
  }
  root = flattenTypeArrays(root, options.antigravitySemantics)

  root = removeUnsupportedKeywords(root, options)
  if (options.removeGeminiMetadata) {
    root = removeKeywords(root, ["nullable", "title"])
    root = removePlaceholderFields(root)
  } else if (options.removeToolTitle) {
    root = removeKeywords(root, ["title"])
  }
  root = cleanupRequiredFields(root)

  if (options.addPlaceholder) {
    root = addEmptySchemaPlaceholder(root)
  }

  return root
}
