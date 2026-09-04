/**
 * gemini-schema 内部实现。移植自 CPA 的 internal/util/gemini_schema.go。
 *
 * 实现已拆分至 `./gemini-schema/` 目录下的子模块，本文件仅作为 barrel
 * 重新导出，保持现有 `import { ... } from "./gemini-schema-internal"` 不变。
 */

export {
  cleanJsonSchemaInternal,
  type CleanOptions,
} from "~/lib/gemini-schema/index"
