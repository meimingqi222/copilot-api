import { describe, expect, test } from "bun:test"

import {
  parseLinuxMemoryPressure,
  parseLinuxProcessMemory,
  parseLinuxSwapCounters,
  parseLinuxSystemMemory,
} from "~/lib/memory-diagnostics"

describe("memory diagnostics procfs parsers", () => {
  test("parses process resident, high-water, and swap memory", () => {
    const result = parseLinuxProcessMemory(`Name:\tbun
VmSize:\t75321000 kB
VmHWM:\t  932000 kB
VmRSS:\t  276480 kB
VmSwap:\t 983492 kB
`)

    expect(result).toEqual({
      vmRssBytes: 276_480 * 1024,
      vmHwmBytes: 932_000 * 1024,
      vmSwapBytes: 983_492 * 1024,
    })
  })

  test("parses system available memory and swap usage inputs", () => {
    const result = parseLinuxSystemMemory(`MemTotal:         979284 kB
MemFree:           40240 kB
MemAvailable:     318464 kB
SwapTotal:       2097148 kB
SwapFree:         812000 kB
`)

    expect(result).toEqual({
      memTotalBytes: 979_284 * 1024,
      memAvailableBytes: 318_464 * 1024,
      swapTotalBytes: 2_097_148 * 1024,
      swapFreeBytes: 812_000 * 1024,
    })
  })

  test("parses cumulative swap page counters", () => {
    expect(
      parseLinuxSwapCounters(`pgpgin 1
pswpin 14804
pswpout 9448
pgpgout 2
`),
    ).toEqual({ pageIn: 14_804, pageOut: 9448 })
  })

  test("parses memory PSI some and full avg10 values", () => {
    expect(
      parseLinuxMemoryPressure(`some avg10=12.34 avg60=4.56 avg300=1.23 total=99
full avg10=8.75 avg60=3.21 avg300=0.98 total=42
`),
    ).toEqual({ someAvg10: 12.34, fullAvg10: 8.75 })
  })

  test("uses zero for missing procfs fields", () => {
    expect(parseLinuxProcessMemory("Name:\tbun\n")).toEqual({
      vmRssBytes: 0,
      vmHwmBytes: 0,
      vmSwapBytes: 0,
    })
    expect(parseLinuxMemoryPressure("")).toEqual({
      someAvg10: 0,
      fullAvg10: 0,
    })
  })
})
