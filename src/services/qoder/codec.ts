/**
 * Qoder 请求体编解码。
 *
 * 客户端先用一张乱序字母表做 base64（MSB-first），再把结果的首尾各 1/3 互换。
 * 分组是标准 base64：4 字符 = 24 bit = 3 个明文字节。'!' 是第 64 个字符
 * （6-bit 值 63），'$' 是占位符——它占一个位置但不携带数据。
 */

import { QODER_BODY_ALPHABET } from "./endpoints"

const alphabetIndex = (() => {
  const m = new Int8Array(256).fill(-1)
  for (let i = 0; i < QODER_BODY_ALPHABET.length; i++) {
    m[QODER_BODY_ALPHABET.charCodeAt(i)] = i
  }
  return m
})()

/**
 * 解一组 4 字符：返回 N = floor(6*k/8) 个字节，k 是非 pad 字符数。
 * '$' 跳过，'!' 映射为 63。
 */
function groupBytes(grp: string): Uint8Array | null {
  const vals: Array<number> = []
  for (const ch of grp) {
    if (ch === "$") continue
    const code = ch.charCodeAt(0)
    vals.push(code < 256 ? alphabetIndex[code] : -1)
  }
  const nv = vals.length
  if (nv === 0) return null
  let x = 0
  for (const v of vals) {
    x = (x << 6) | v
  }
  const nb = Math.floor((6 * nv) / 8)
  const out = new Uint8Array(nb)
  for (let k = 0; k < nb; k++) {
    const sh = 6 * nv - 8 * (k + 1)
    out[k] = (x >> sh) & 255
  }
  return out
}

/**
 * 把一个字节流按字母表编成一条连续的 base64 位流（MSB first）：每字节省 8 bit，
 * 每满 6 bit 输出一个字符；最后一组不足时零填充成一个字符；字符数补 '$' 到 4 的倍数。
 * 6-bit 值 63 输出为 '!'。
 */
export function segmentEncode(data: Uint8Array): string {
  let out = ""
  let acc = 0
  let nb = 0
  for (const b of data) {
    acc = ((acc << 8) | b) & 0xffffff
    nb += 8
    while (nb >= 6) {
      nb -= 6
      out += QODER_BODY_ALPHABET[(acc >> nb) & 0x3f]
    }
  }
  if (nb > 0) {
    out += QODER_BODY_ALPHABET[(acc << (6 - nb)) & 0x3f]
  }
  while (out.length % 4 !== 0) {
    out += "$"
  }
  return out
}

/** 自定义 base64 编码（不含首尾 1/3 互换）。 */
export function bodyEncode(data: Uint8Array): string {
  return segmentEncode(data)
}

/** 自定义 base64 解码（不含首尾 1/3 互换）。 */
export function bodyDecode(s: string): Uint8Array {
  const chunks: Array<Uint8Array> = []
  let total = 0
  for (let gi = 0; gi + 4 <= s.length; gi += 4) {
    const b = groupBytes(s.slice(gi, gi + 4))
    if (b) {
      chunks.push(b)
      total += b.length
    }
  }
  const out = new Uint8Array(total)
  let off = 0
  for (const c of chunks) {
    out.set(c, off)
    off += c.length
  }
  return out
}

/** 交换编码串的首尾各 1/3；中间 1/3 不动。 */
export function swapBodyOuterThirds(encoded: string): string {
  const third = Math.floor(encoded.length / 3)
  if (third === 0) return encoded
  return (
    encoded.slice(encoded.length - third)
    + encoded.slice(third, encoded.length - third)
    + encoded.slice(0, third)
  )
}

/** agent_chat_generation 的 wire body：自定义 base64 再做首尾 1/3 互换。 */
export function encodeRequestBody(plaintext: Uint8Array): string {
  return swapBodyOuterThirds(bodyEncode(plaintext))
}

/** 先反互换再解码。 */
export function decodeRequestBody(wire: string): Uint8Array {
  return bodyDecode(swapBodyOuterThirds(wire))
}
