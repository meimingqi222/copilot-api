import { expect, test } from "bun:test"
import { randomUUID } from "node:crypto"

import { RedactionScope } from "~/lib/redaction/context"
import {
  idCardChecksum,
  luhn,
  redactionConfigSchema,
} from "~/lib/redaction/rules"
import { restoreRedactionStream } from "~/lib/redaction/stream"
import { pendingTokenSuffix, tokenPattern } from "~/lib/redaction/token"

const scopeFor = (input: Record<string, unknown> = {}) =>
  new RedactionScope(
    redactionConfigSchema.parse({ enabled: true, ...input }),
    randomUUID(),
  )

// Synthetic values: a checksum-valid ID number and a Luhn-valid card number.
const ID_CARD = "11010519491231002X"
const CARD = "6222 0212 3456 7894"
const KEY = "sk-kindtest1234567890abcd"

test("placeholders are short and named for what they hide", () => {
  const scope = scopeFor()
  const masked = scope.maskText(
    `key ${KEY} DB_PASSWORD=hello1234 /home/alice/work`,
  )
  expect(masked).toMatch(/\{\{API_KEY_[a-z2-7]{8}\}\} /)
  expect(masked).toMatch(/DB_PASSWORD=\{\{SECRET_[a-z2-7]{8}\}\}/)
  expect(masked).toMatch(/\{\{HOME_[a-z2-7]{8}\}\}\/work/)
  expect(scope.restoreText(masked)).toBe(
    `key ${KEY} DB_PASSWORD=hello1234 /home/alice/work`,
  )
  // The same value keeps its placeholder, so prompt caches stay valid.
  expect(scope.maskText(`again ${KEY}`)).toBe(
    `again ${masked.match(/\{\{API_KEY_[a-z2-7]{8}\}\}/)![0]}`,
  )
})

test("placeholders from earlier versions stay opaque and are never re-masked", () => {
  const scope = scopeFor({ words: ["aaaa"] })
  const legacy = `{{SECRET_${"a".repeat(32)}}}`
  expect([...legacy.matchAll(tokenPattern())]).toHaveLength(1)
  expect(scope.maskText(`old ${legacy}`)).toBe(`old ${legacy}`)
  expect(scope.restoreText(`old ${legacy}`)).toBe(`old ${legacy}`)
})

test("a placeholder the model rewrote with spaces or another case is still restored", () => {
  const scope = scopeFor()
  const token = scope.maskText(KEY)
  const [, label, suffix] = /^\{\{([A-Z_]+)_([a-z2-7]+)\}\}$/.exec(token)!
  for (const echoed of [
    `{{ ${label}_${suffix} }}`,
    `{{${label.toLowerCase()}_${suffix}}}`,
    `{{${label}_${suffix.toUpperCase()}}}`,
  ])
    expect(scope.restoreText(`set ${echoed}`)).toBe(`set ${KEY}`)
  // A rewrite of a placeholder this request never sent is left alone.
  expect(scope.restoreText("{{ API_KEY_zzzzzzzz }}")).toBe(
    "{{ API_KEY_zzzzzzzz }}",
  )
})

test("streams hold a split loose placeholder until it is complete", async () => {
  const scope = scopeFor()
  const token = scope.maskText(KEY)
  const loose = `{{ ${token.slice(2, -2)} }}`
  expect(pendingTokenSuffix(`a ${loose.slice(0, 5)}`)).toBe(loose.slice(0, 5))
  expect(pendingTokenSuffix("a {{not a token")).toBe("")
  async function* upstream() {
    const sse = (packet: unknown) => ({ data: JSON.stringify(packet) })
    for (const part of [`x ${loose.slice(0, 9)}`, `${loose.slice(9)} y`])
      yield sse({ choices: [{ index: 0, delta: { content: part } }] })
    yield sse({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })
  }
  let text = ""
  for await (const frame of restoreRedactionStream(
    upstream(),
    scope,
    "issuer",
  )) {
    const packet = JSON.parse((frame as { data: string }).data) as {
      choices: Array<{ delta: { content?: string } }>
    }
    text += packet.choices[0].delta.content ?? ""
  }
  expect(text).toBe(`x ${KEY} y`)
})

test("personal data is masked only when switched on, per kind", () => {
  const text = `mail li.wei@example.cn call 13800138000 id ${ID_CARD} card ${CARD} ip 8.8.8.8 local 192.168.1.2`
  expect(scopeFor().maskText(text)).toBe(text)
  const scope = scopeFor({ personal: true })
  const masked = scope.maskText(text)
  for (const label of ["EMAIL", "PHONE", "ID_CARD", "BANK_CARD"])
    expect(masked).toContain(`{{${label}_`)
  // Public IPs start off; private ones are never personal data.
  expect(masked).toContain("8.8.8.8")
  expect(masked).toContain("192.168.1.2")
  expect(scope.diagnostics().byKind.PERSONAL).toBe(4)
  expect(scope.restoreText(masked)).toBe(text)
  const withIp = scopeFor({ personal: true, personalKinds: { IP: true } })
  expect(withIp.maskText(text)).toContain("{{IP_")
  expect(withIp.maskText(text)).toContain("192.168.1.2")
  const noEmail = scopeFor({ personal: true, personalKinds: { EMAIL: false } })
  expect(noEmail.maskText(text)).toContain("li.wei@example.cn")
})

test("checksums keep ids, timestamps and counters out of personal data", () => {
  expect(idCardChecksum(ID_CARD)).toBe(true)
  expect(idCardChecksum("110105194912310021")).toBe(false)
  expect(luhn(CARD)).toBe(true)
  expect(luhn("6222021234567890")).toBe(false)
  const scope = scopeFor({ personal: true })
  const text =
    "ts 1729850000000 ns 1729850000000000000 id 110105194912310021 n 6222021234567890"
  expect(scope.maskText(text)).toBe(text)
})

test("words can match in any case and allowlisted values are sent as written", () => {
  const anyCase = scopeFor({ words: ["Nightjar"], wordsAnyCase: true })
  const masked = anyCase.maskText("Nightjar NIGHTJAR nightjar")
  expect(masked).not.toMatch(/nightjar/i)
  expect(anyCase.restoreText(masked)).toBe("Nightjar NIGHTJAR nightjar")
  expect(scopeFor({ words: ["Nightjar"] }).maskText("NIGHTJAR")).toBe(
    "NIGHTJAR",
  )
  const allowed = scopeFor({ allow: [KEY] })
  expect(allowed.maskText(`use ${KEY}`)).toBe(`use ${KEY}`)
  expect(allowed.mask({ password: "fieldValue123" }).password).toStartWith(
    "{{SECRET_",
  )
})

test("warn sends values as written and counts them", () => {
  const scope = scopeFor({ actions: { SECRET: "warn" } })
  const text = `${KEY} ${KEY} /home/alice/work`
  const masked = scope.maskText(text)
  expect(masked).toContain(`${KEY} ${KEY}`)
  expect(masked).toContain("{{HOME_")
  const diagnostics = scope.diagnostics()
  expect(diagnostics.warned).toBe(1)
  expect(diagnostics.total).toBe(1)
})

test("block refuses the request without echoing the value; preview only reports it", () => {
  const scope = scopeFor({ actions: { SECRET: "block" } })
  let message = ""
  try {
    scope.mask({ messages: [{ role: "user", content: `deploy ${KEY}` }] })
  } catch (error) {
    message = (error as Error).message
    expect((error as { response: Response }).response.status).toBe(400)
  }
  expect(message).toContain("API_KEY")
  expect(message).toContain("sk-…")
  expect(message).not.toContain(KEY)
  expect(scope.diagnostics().blocked).toEqual([
    { label: "API_KEY", hint: `sk-…, ${KEY.length} characters` },
  ])
  const preview = new RedactionScope(
    redactionConfigSchema.parse({
      enabled: true,
      actions: { SECRET: "block" },
    }),
    undefined,
    { preview: true },
  )
  expect(preview.maskText(`deploy ${KEY}`)).toBe(`deploy ${KEY}`)
  expect(preview.diagnostics().blocked).toHaveLength(1)
})
