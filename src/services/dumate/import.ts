import { createDecipheriv } from "node:crypto"
import { asRecord, asString } from "~/lib/json-shape"
import type { ModelMapping } from "~/lib/provider-connections"
import { canonicalNativeModelId } from "~/lib/route-target/model-reference"

export const DUMATE_LOGIN_URL =
  "https://login.bce.baidu.com/?from=oa_dumate&redirect=https%3A%2F%2Fconsole.bce.baidu.com%2F"

export function parseDuMateCookie(raw: string): string {
  const cookie = raw.trim().replace(/^cookie:\s*/i, "")
  if (
    !/^[\x20-\x7E]{1,32768}$/.test(cookie)
    || !/(?:^|;\s*)bce-sessionid=(?![;\s]|""|$)/.test(cookie)
  ) {
    throw new Error(
      "Paste the Baidu console request Cookie with bce-sessionid.",
    )
  }
  return cookie
}

/** An explicit upload/paste, never a read from the proxy host's home directory. */
export function importDuMateDesktopCookie(
  auth: unknown,
  encodedKey: string,
): string {
  const ciphertext = asString(asRecord(auth)?.cookies)
  if (!ciphertext || ciphertext.length > 1_048_576 || encodedKey.length > 48) {
    throw new Error("Invalid DuMate desktop import.")
  }
  const key = Buffer.from(encodedKey, "base64")
  const bytes = Buffer.from(ciphertext, "base64")
  if (key.length !== 32 || bytes.length <= 28)
    throw new Error("Invalid DuMate desktop import.")
  const decipher = createDecipheriv("aes-256-gcm", key, bytes.subarray(0, 12))
  decipher.setAuthTag(bytes.subarray(12, 28))
  const cookies: unknown = JSON.parse(
    Buffer.concat([
      decipher.update(bytes.subarray(28)),
      decipher.final(),
    ]).toString("utf8"),
  )
  if (!Array.isArray(cookies))
    throw new Error("Invalid DuMate desktop cookies.")
  const host = "console.bce.baidu.com"
  const fields = (cookies as Array<unknown>).flatMap((item) => {
    const cookie = asRecord(item)
    const name = asString(cookie?.name)
    const value = asString(cookie?.value)
    const domain = asString(cookie?.domain)?.toLowerCase().replace(/^\./, "")
    return (
        name
          && /^[\w.-]+$/.test(name)
          && value
          && /^[\x21-\x7E]+$/.test(value)
          && !value.includes(";")
          && domain
          && (host === domain || host.endsWith(`.${domain}`))
      ) ?
        [`${name}=${value}`]
      : []
  })
  return parseDuMateCookie(fields.join("; "))
}

interface DuMateModel {
  id: string
  alias: string
  context: number
  output: number
  image: boolean
}

function modelMapping(model: DuMateModel): ModelMapping {
  return {
    publicId: canonicalNativeModelId(model.alias),
    upstreamId: model.id,
    name:
      model.alias === model.id ? model.id : `${model.alias} (API: ${model.id})`,
    vendor: "dumate",
    endpoints: ["chat"],
    enabled: true,
    pickerEnabled: true,
    ...(model.id === "deepseek-v41-flash" ?
      { efforts: ["none", "low", "high", "max"] }
    : {}),
    metadata: {
      contextWindow: model.context,
      outputLimit: model.output,
      multimodal: model.image,
    },
  }
}

export function duMateFallbackModels(): Array<ModelMapping> {
  return ["model-text", "dm-auto-model/text.L0"].map((id) =>
    modelMapping({
      id,
      alias: id,
      context: 192_000,
      output: 128_000,
      image: false,
    }),
  )
}

const validId = /^[a-z\d][a-z\d._/-]{0,159}$/i
const excluded = /(?:embedding|reranker|ocr|^llm-mock$|^dumate-image)/i

function modelNumber(input: unknown): input is number {
  return typeof input === "number" && Number.isSafeInteger(input) && input > 0
}

export function duMateCatalog(config: unknown): Array<ModelMapping> {
  const provider = asRecord(asRecord(config)?.provider)
  const source = asRecord(asRecord(provider?.QianfanPersonalQuota)?.models)
  if (!source) throw new Error("Missing DuMate desktop model catalog.")
  const models = Object.entries(source)
    .slice(0, 1000)
    .flatMap(([alias, entry]) => {
      const model = asRecord(entry)
      const id = asString(model?.id) ?? alias
      const limit = asRecord(model?.limit)
      const context = limit?.context ?? limit?.input
      const output = limit?.output
      const input: unknown = asRecord(model?.modalities)?.input
      const chatId = (s: string) =>
        validId.test(s)
        && !excluded.test(s)
        && (!s.startsWith("model-") || s === "model-text")
      if (
        !chatId(id)
        || !chatId(alias)
        || (alias !== id && Object.hasOwn(source, id))
        || !modelNumber(context)
        || !modelNumber(output)
        || (Array.isArray(input) && !input.includes("text"))
      )
        return []
      return [
        modelMapping({
          id,
          alias,
          context,
          output,
          image: Array.isArray(input) && input.includes("image"),
        }),
      ]
    })
  if (!models.length)
    throw new Error("No chat models in DuMate desktop model catalog.")
  return models
}
