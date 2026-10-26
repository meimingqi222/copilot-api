import { expect, test } from "bun:test"

import { RedactionError, RedactionScope } from "~/lib/redaction/context"
import {
  LiteralSearchLimitError,
  scanLiterals,
} from "~/lib/redaction/literal-search"
import { redactionConfigSchema } from "~/lib/redaction/rules"

function actualMatches(text: string, literals: string[]) {
  const matches: string[] = []
  scanLiterals(
    text,
    new Map(literals.map((literal) => [literal, literal])),
    (value, start, end) => {
      expect(text.slice(start, end)).toBe(value)
      matches.push(`${value}:${start}:${end}`)
    },
  )
  return matches.sort()
}

function expectedMatches(text: string, literals: string[]) {
  const matches: string[] = []
  for (const literal of new Set(literals)) {
    if (!literal) continue
    let from = 0
    while (true) {
      const start = text.indexOf(literal, from)
      if (start < 0) break
      from = start + literal.length
      matches.push(`${literal}:${start}:${from}`)
    }
  }
  return matches.sort()
}

test("literal search agrees with independent scans for prefixes, suffixes and UTF-16 offsets", () => {
  const literals = [
    "he",
    "she",
    "hers",
    "his",
    "a",
    "aa",
    "aaa",
    "aaaa",
    "😀",
    "😀x",
    "x😀",
    "",
    "he",
  ]
  const text = "ushers his she aaaaa 😀x😀 hers"
  expect(actualMatches(text, literals)).toEqual(expectedMatches(text, literals))
  expect(actualMatches(text, literals.slice(0, 4))).toEqual(
    expectedMatches(text, literals.slice(0, 4)),
  )
  expect(actualMatches(text, [])).toEqual([])
})

test("literal search agrees with independent scans on deterministic mixed inputs", () => {
  let seed = 12345
  const random = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
    return seed >>> 16
  }
  for (let run = 0; run < 30; run++) {
    const literals = Array.from({ length: 40 }, () =>
      Array.from(
        { length: 1 + (random() % 10) },
        () => "abcd"[random() % 4],
      ).join(""),
    )
    const text = Array.from(
      { length: 100 },
      () => literals[random() % literals.length],
    ).join(" ")
    expect(actualMatches(text, literals)).toEqual(
      expectedMatches(text, literals),
    )
  }
})

test("literal search rejects excessive output and index size", () => {
  for (const literals of [
    ["a"],
    ["a", ...Array.from({ length: 8 }, (_, i) => `needle${i}`)],
  ]) {
    expect(() =>
      scanLiterals(
        "a".repeat(70_000),
        new Map(literals.map((value) => [value, value])),
        () => {},
      ),
    ).toThrow(LiteralSearchLimitError)
  }
  const literals = Array.from(
    { length: 9 },
    (_, i) => `${i}${"x".repeat(40_000)}`,
  )
  expect(() => actualMatches("no matches", literals)).toThrow(
    LiteralSearchLimitError,
  )
  expect(() =>
    actualMatches(
      " ".repeat(8 * 1024 * 1024 + 1),
      Array.from({ length: 9 }, (_, i) => `needle${i}`),
    ),
  ).toThrow(LiteralSearchLimitError)
})

test("known literals preserve JSON spelling, HOME boundaries and placeholder spans", () => {
  const home = "/srv/private-project"
  const scope = new RedactionScope(
    redactionConfigSchema.parse({ enabled: true, homePrefixes: [home] }),
  )
  const secrets = Array.from({ length: 12 }, (_, i) => `protected${i}-Ab987`)
  for (const value of secrets) scope.maskText(value, false, true)
  scope.maskText(`${home}/repo`)
  const input = `${secrets.join(" ")} ${home}/file ${home}-backup`
  const masked = scope.maskText(input)
  for (const value of secrets) expect(masked).not.toContain(value)
  expect(masked).toContain(`${home}-backup`)
  expect(scope.restoreText(masked)).toBe(input)

  const escapedSecrets = Array.from(
    { length: 12 },
    (_, i) => `private\\line\n"${i}-Ab987`,
  )
  for (const value of escapedSecrets) scope.maskText(value, false, true)
  const json = JSON.stringify(escapedSecrets)
  const maskedJson = scope.maskText(json, true)
  expect(maskedJson.match(/\{\{SECRET_/g)).toHaveLength(12)
  expect(scope.restoreText(maskedJson, true)).toBe(json)

  const token = scope.maskText(secrets[0])
  scope.maskText(token.slice(2, -2), false, true)
  expect(scope.maskText(`${token} ${secrets[1]}`)).toBe(
    `${token} ${scope.maskText(secrets[1])}`,
  )
})

test("known literal capacity errors reject the request instead of returning partial masking", () => {
  const scope = new RedactionScope(
    redactionConfigSchema.parse({ enabled: true }),
  )
  scope.maskText("abcd", false, true)
  expect(() => scope.maskText("abcd ".repeat(70_000))).toThrow(RedactionError)
})
