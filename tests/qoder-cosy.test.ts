import { createDecipheriv, createHash } from "node:crypto"

import { describe, expect, test } from "bun:test"

import {
  aes128CbcEncrypt,
  buildCosyHeaders,
  cosySignature,
  machineOs,
  rsaPkcs1Encrypt,
  urlPathname,
  type QoderUser,
} from "~/services/qoder/cosy"
import { QODER_API_HOST, qoderChatUrl } from "~/services/qoder/endpoints"

const CHAT_SIGNED_PATH = "/api/v2/service/pro/sse/agent_chat_generation"

function b64ToBytes(b64: string): Uint8Array {
  return new Uint8Array(Buffer.from(b64, "base64"))
}

describe("qoder cosy", () => {
  test("signature known answer", () => {
    // 独立算出的五段 "\n" 分隔字段的 MD5。
    expect(
      cosySignature(
        "cGF5bG9hZA==",
        "c2VjcmV0",
        1700000000,
        "ByS..Wj^#SJLNYmYKtDx",
        CHAT_SIGNED_PATH,
      ),
    ).toBe("da9dbed272847ea4664dd7ae8bf82575")
    expect(urlPathname(qoderChatUrl())).toBe(CHAT_SIGNED_PATH)
  })

  test("machine identity headers and profile", () => {
    const user: QoderUser = {
      uid: "uid",
      name: "",
      email: "",
      token: "jt",
      machineId: "fixed-machine",
    }
    for (let i = 0; i < 2; i++) {
      const h = buildCosyHeaders(qoderChatUrl(), user, "", 1)
      for (const key of [
        "Cosy-MachineId",
        "Cosy-MachineToken",
        "Cosy-ClientIp",
      ]) {
        expect(h[key]).toBe("fixed-machine")
      }
      expect(h["Cosy-MachineOS"]).toBe(machineOs())
      expect(h["Cosy-User"]).toBe("uid")
      expect(h["Cosy-Date"]).toBe("1")
    }
  })

  test("authorization structure and no token leak", () => {
    const user: QoderUser = {
      uid: "uid-1",
      name: "N",
      email: "e@x",
      token: "jt-abc",
      machineId: "machine-test",
    }
    const ts = 1700000000
    const h = buildCosyHeaders(qoderChatUrl(), user, `{"messages":[]}`, ts)
    const auth = h.Authorization
    expect(auth.startsWith("Bearer COSY.")).toBe(true)
    const parts = auth.slice("Bearer COSY.".length).split(".")
    expect(parts.length).toBe(2)
    expect(parts[1].length).toBe(32)

    const decoded = Buffer.from(parts[0], "base64").toString("utf8")
    const payload = JSON.parse(decoded) as Record<string, unknown>
    expect(payload.version).toBe("v1")
    expect(payload.cosyVersion).toBe("1.1.49")
    expect(payload.ideVersion).toBe("")
    expect(typeof payload.requestId).toBe("string")
    expect((payload.requestId as string).includes("-")).toBe(false)
    expect(decoded.includes("jt-abc")).toBe(false)

    // 签名可由 payload / key / ts / body / path 复算。
    const expectSig = createHash("md5")
      .update(
        `${parts[0]}\n${h["Cosy-Key"]}\n${ts}\n${'{"messages":[]}'}\n${CHAT_SIGNED_PATH}`,
      )
      .digest("hex")
    expect(parts[1]).toBe(expectSig)
  })

  test("cosy-key is a 128-byte RSA ciphertext wrapping the AES key", () => {
    const info = buildCosyHeaders(
      qoderChatUrl(),
      { uid: "u", name: "", email: "", token: "t", machineId: "m" },
      "",
      1,
    )
    expect(b64ToBytes(info["Cosy-Key"]).length).toBe(128)
  })

  test("AES-128-CBC uses the key as IV and PKCS#7 padding", () => {
    const key = Buffer.from("0123456789abcdef")
    const plain = Buffer.from("hello qoder")
    const enc = aes128CbcEncrypt(key, key, plain)
    expect(enc.length % 16).toBe(0)
    const dec = createDecipheriv("aes-128-cbc", key, key)
    expect(Buffer.concat([dec.update(enc), dec.final()]).toString()).toBe(
      "hello qoder",
    )
  })

  test("RSA PKCS#1 v1.5 ciphertext size matches the 1024-bit key", () => {
    // PKCS#1 v1.5 填充是随机的，只能断言密文长度（1024-bit = 128 字节）；
    // 私钥在 Qoder 服务端，客户端无法自行解密核对。
    const enc = rsaPkcs1Encrypt(Buffer.from("0123456789abcdef"))
    expect(enc.length).toBe(128)
  })

  test("missing machine id is rejected", () => {
    expect(() =>
      buildCosyHeaders(
        qoderChatUrl(),
        { uid: "u", name: "", email: "", token: "t", machineId: "" },
        "",
      ),
    ).toThrow()
  })

  test("path stripping keeps the algo prefix out of the signature", () => {
    expect(urlPathname(`${QODER_API_HOST}${CHAT_SIGNED_PATH}`)).toBe(
      CHAT_SIGNED_PATH,
    )
    expect(urlPathname(`${QODER_API_HOST}/algo/x/y?z=1`)).toBe("/x/y")
  })
})
