/**
 * Qoder 的 id 生成器。
 *
 * machine_id / nonce 用带横线的 8-4-4-4-12 UUID；business.id 与 tool-call id
 * 用无横线的 32 位 hex。
 */

import { randomUUID } from "node:crypto"

/** 稳定的账号身份，登录时生成一次后随凭证保存。 */
export function newQoderMachineId(): string {
  return randomUUID()
}

/** Qoder 请求 id / tool-call id 的形状：无横线 UUID。 */
export function newQoderId(): string {
  return randomUUID().replaceAll("-", "")
}
