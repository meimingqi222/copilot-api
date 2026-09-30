/**
 * COSY 请求签名。
 *
 * 每个 /algo 请求都带一套 COSY 头：`Authorization: Bearer COSY.<payload>.<sig>`，
 * 外加 Cosy-Key / Cosy-MachineId / Cosy-User 等。其中的 user blob 用
 * AES-128-CBC 加密（key 与 IV 相同，取自一个 UUID 去横线后的前 16 个 hex 字符），
 * 该 AES key 再用 Qoder 客户端内嵌的 RSA 公钥做 PKCS#1 v1.5 加密。
 * 签名 = md5hex(payload + "\n" + keyB64 + "\n" + 秒级时间戳 + "\n" + wire body + "\n" + path)，
 * 其中 path 去掉前导 "/algo" 且不含 query。
 */

import {
  constants,
  createCipheriv,
  createHash,
  publicEncrypt,
  randomUUID,
} from "node:crypto"

import { QODER_COSY_VERSION } from "./endpoints"

/** Qoder 客户端内嵌的 1024-bit RSA 公钥（来自客户端 cosy 源码）。 */
export const QODER_RSA_PUBLIC_KEY_PEM = `-----BEGIN PUBLIC KEY-----
MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDA8iMH5c02LilrsERw9t6Pv5Nc
4k6Pz1EaDicBMpdpxKduSZu5OANqUq8er4GM95omAGIOPOh+Nx0spthYA2BqGz+l
6HRkPJ7S236FZz73In/KVuLnwI8JJ2CbuJap8kvheCCZpmAWpb/cPx/3Vr/J6I17
XcW+ML9FoCI6AOvOzwIDAQAB
-----END PUBLIC KEY-----`

/** 被签名的账号。 */
export interface QoderUser {
  /** Qoder user id（Cosy-User / x-gw-user-id 的值）。 */
  uid: string
  /** 显示名，可为空。 */
  name: string
  /** 账号邮箱，可为空。 */
  email: string
  /** jt- Bearer token（security_oauth_token）。 */
  token: string
  /** 登录时生成一次、随账号保存的机器码。 */
  machineId: string
}

/** AES-128-CBC + PKCS#7 填充。 */
export function aes128CbcEncrypt(
  key: Uint8Array,
  iv: Uint8Array,
  plaintext: Uint8Array,
): Buffer {
  const cipher = createCipheriv("aes-128-cbc", key, iv)
  return Buffer.concat([cipher.update(plaintext), cipher.final()])
}

/** 用 Qoder 内嵌公钥包裹 AES key（RSA PKCS#1 v1.5）。 */
export function rsaPkcs1Encrypt(key: Uint8Array): Buffer {
  return publicEncrypt(
    { key: QODER_RSA_PUBLIC_KEY_PEM, padding: constants.RSA_PKCS1_PADDING },
    key,
  )
}

/**
 * 构造 COSY payload 携带的 AES 加密 user blob，返回 base64 后的 (info, key)；
 * AES key 同时用作 IV。
 */
export function generateUserBlob(user: QoderUser): {
  infoB64: string
  keyB64: string
} {
  const blob = {
    uid: user.uid,
    aid: "",
    name: user.name,
    email: user.email,
    security_oauth_token: user.token,
  }
  const raw = Buffer.from(JSON.stringify(blob), "utf8")
  const key = Buffer.from(randomUUID().replaceAll("-", "").slice(0, 16), "utf8")
  const iv = key.subarray(0, 16)
  const infoEnc = aes128CbcEncrypt(key, iv, raw)
  const keyEnc = rsaPkcs1Encrypt(key)
  return {
    infoB64: infoEnc.toString("base64"),
    keyB64: keyEnc.toString("base64"),
  }
}

/** 请求 path：去掉 "/algo" 前缀与 query，即签名里用的那个。 */
export function urlPathname(rawUrl: string): string {
  let path: string
  try {
    path = new URL(rawUrl).pathname
  } catch {
    return rawUrl.trim()
  }
  if (path.startsWith("/algo")) {
    path = path.slice("/algo".length)
  }
  return path
}

/** COSY 签名：五段以 "\n" 相连后的 md5 hex。 */
export function cosySignature(
  payload: string,
  key: string,
  timestamp: number,
  body: string,
  path: string,
): string {
  return createHash("md5")
    .update(`${payload}\n${key}\n${timestamp}\n${body}\n${path}`)
    .digest("hex")
}

/** 桌面客户端使用的架构 / 平台名。 */
export function machineOs(): string {
  let arch: string = process.arch
  switch (arch) {
    case "x64":
      arch = "x86_64"
      break
    case "ia32":
      arch = "x86"
      break
    case "arm64":
      arch = "aarch64"
      break
    default:
      break
  }
  let os = process.platform
  if (os === "win32") {
    os = "win32"
  }
  return `${arch}_${os}`
}

/**
 * 为一次 Qoder 调用构造完整的 COSY 头集；body 必须是已编码的 wire 形态。
 * timestamp 为 0（或省略）时取当前秒。
 */
export function buildCosyHeaders(
  rawUrl: string,
  user: QoderUser,
  body: string,
  timestamp = 0,
): Record<string, string> {
  if (!user || !user.machineId) {
    throw new Error("qoder: missing account machine id")
  }
  const { infoB64, keyB64 } = generateUserBlob(user)
  const requestId = randomUUID().replaceAll("-", "")
  const ts = timestamp === 0 ? Math.floor(Date.now() / 1000) : timestamp
  const payloadObj = {
    version: "v1",
    requestId,
    info: infoB64,
    cosyVersion: QODER_COSY_VERSION,
    ideVersion: "",
  }
  const payload = Buffer.from(JSON.stringify(payloadObj), "utf8").toString(
    "base64",
  )

  const path = urlPathname(rawUrl)
  const sig = cosySignature(payload, keyB64, ts, body, path)
  const machineId = user.machineId

  return {
    Accept: "application/json",
    "Accept-Encoding": "identity",
    "Content-Type": "application/json",
    Authorization: `Bearer COSY.${payload}.${sig}`,
    "Cosy-Business-Product": "app",
    "Cosy-Business-Type": "agent",
    "Cosy-ClientIp": machineId,
    "Cosy-ClientType": "10",
    "Cosy-Data-Policy": "disagree",
    "Cosy-Date": `${ts}`,
    "Cosy-Key": keyB64,
    "Cosy-MachineId": machineId,
    "Cosy-MachineToken": machineId,
    "Cosy-MachineType": "5",
    "Cosy-MachineOS": machineOs(),
    "Cosy-Scene": "app",
    "Cosy-User": user.uid,
    "Cosy-Version": QODER_COSY_VERSION,
    "Login-Version": "v2",
  }
}
