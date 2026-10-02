import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { runInNewContext } from "node:vm"

interface Row {
  remainingPercent?: number
  displayPercent?: number
  percentText?: string
  valueText: string
  amountText?: string
}

interface Display {
  displayPercent: (percent: unknown, mode?: string) => number | undefined
  applyDisplayMode: (
    rows: Array<Row>,
    mode: string,
    translate: (key: string) => string,
  ) => Array<Row>
  getBarColor: (percent?: number) => string
}

interface TraceView {
  quotaDisplayMode: string
  t: (key: string, params: { n: number }) => string
  candQuotaPercent: (candidate: { quotaUsedPct?: number }) => number | undefined
  candEvidence: (candidate: { quotaUsedPct?: number }) => string
}

const source = readFileSync("pages/js/quota-display.js", "utf8")
const display = runInNewContext(`${source}\nQuotaDisplay`) as Display
const trace = runInNewContext(
  `${source}\n${readFileSync("pages/js/views/traces.js", "utf8")}\ntracesView()`,
  { ViewHelpers: {}, Date, performance, globalThis },
) as TraceView
const translate = (key: string) => (key.endsWith(".used") ? "已用" : "剩余")

test("quota and trace use the same percentage and bar direction in both modes", () => {
  for (const mode of ["remaining", "used"]) {
    trace.quotaDisplayMode = mode
    trace.t = (key, params) => `${key} ${params.n}%`
    const [row] = display.applyDisplayMode(
      [{ remainingPercent: 19, valueText: "19%" }],
      mode,
      translate,
    )
    expect(row?.displayPercent).toBe(
      trace.candQuotaPercent({ quotaUsedPct: 81 }),
    )
    expect(row?.valueText).toBe(mode === "used" ? "已用 81%" : "剩余 19%")
    expect(trace.candEvidence({ quotaUsedPct: 81 })).toBe(
      mode === "used" ?
        "trace.ev.quotaUsed 81%"
      : "trace.ev.quotaRemaining 19%",
    )
    expect(row?.remainingPercent).toBe(19)
    expect(display.getBarColor(row?.remainingPercent)).toContain("red")
  }
})

test("unknown quota stays unknown, percentages are clamped and inputs stay untouched", () => {
  expect(display.displayPercent(undefined)).toBeUndefined()
  expect(display.displayPercent(null)).toBeUndefined()
  expect(display.displayPercent(NaN)).toBeUndefined()
  expect(display.displayPercent(Infinity)).toBeUndefined()
  expect(display.displayPercent(0, "used")).toBe(100)
  expect(display.displayPercent(100, "used")).toBe(0)
  expect(display.displayPercent(-2)).toBe(0)
  expect(display.displayPercent(110)).toBe(100)
  expect(trace.candQuotaPercent({})).toBeUndefined()
  const rows = [{ remainingPercent: 70, valueText: "70%" }]
  display.applyDisplayMode(rows, "used", translate)
  expect(rows[0]?.valueText).toBe("70%")
})

test("amounts, counts and metadata are preserved while percentage amount text follows mode", () => {
  const rows = display.applyDisplayMode(
    [
      { valueText: "$4.74", amountText: "60%", remainingPercent: 60 },
      { valueText: "70 / 100", remainingPercent: 70 },
      { valueText: "2026/10/03 16:43" },
    ],
    "used",
    translate,
  )
  expect(rows[0]?.valueText).toBe("$4.74")
  expect(rows[0]?.amountText).toBe("已用 40%")
  expect(rows[1]?.valueText).toBe("70 / 100")
  expect(rows[1]?.displayPercent).toBe(30)
  expect(rows[2]?.displayPercent).toBeUndefined()
})
