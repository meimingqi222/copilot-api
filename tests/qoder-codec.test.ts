import { describe, expect, test } from "bun:test"

import {
  bodyDecode,
  bodyEncode,
  decodeRequestBody,
  encodeRequestBody,
} from "~/services/qoder/codec"

/**
 * 已知向量：固定向量用 RFC 4648 base64 换字母表、再做首尾 1/3 互换。
 */
const VECTORS: Array<{ hex: string; encoded: string; wire: string }> = [
  { hex: "", encoded: "", wire: "" },
  { hex: "66", encoded: "D&$$", wire: "$&$D" },
  { hex: "666f", encoded: "DOq$", wire: "$OqD" },
  { hex: "666f6f", encoded: "DOWb", wire: "bOWD" },
  { hex: "666f6f626172", encoded: "DOWb#OgY", wire: "gYWb#ODO" },
  { hex: "00ff3f7f", encoded: "_vq!ef$$", wire: "$$q!ef_v" },
  { hex: "e4b8ade69687", encoded: "QG*tQ)PZ", wire: "PZ*tQ)QG" },
  {
    hex: "7b226d65737361676573223a5b5d7d",
    encoded: "mYKtDxj^#SJLNYByS..W",
    wire: "ByS..Wj^#SJLNYmYKtDx",
  },
]

function fromHex(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2)
  for (let i = 0; i < out.length; i++) {
    out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  }
  return out
}

function toHex(bytes: Uint8Array): string {
  let out = ""
  for (const b of bytes) out += b.toString(16).padStart(2, "0")
  return out
}

describe("qoder body codec", () => {
  test("known answers encode/decode/wire", () => {
    for (const v of VECTORS) {
      const plain = fromHex(v.hex)
      expect(bodyEncode(plain)).toBe(v.encoded)
      expect(toHex(bodyDecode(v.encoded))).toBe(v.hex)
      expect(encodeRequestBody(plain)).toBe(v.wire)
      expect(toHex(decodeRequestBody(v.wire))).toBe(v.hex)
    }
  })

  test("round trip over every length 0..199", () => {
    for (let n = 0; n < 200; n++) {
      const plain = new Uint8Array(n)
      for (let i = 0; i < n; i++) plain[i] = Math.floor(Math.random() * 256)
      const wire = encodeRequestBody(plain)
      expect(toHex(decodeRequestBody(wire))).toBe(toHex(plain))
      expect(wire.length % 4).toBe(0)
    }
  })

  test("round trip over a JSON envelope", () => {
    const plain = new TextEncoder().encode(
      JSON.stringify({ messages: [{ role: "user", content: "你好，Qoder!" }] }),
    )
    expect(toHex(decodeRequestBody(encodeRequestBody(plain)))).toBe(
      toHex(plain),
    )
  })
})
