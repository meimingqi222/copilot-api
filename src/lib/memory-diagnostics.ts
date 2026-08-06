import fs from "node:fs/promises"

import { logger } from "~/lib/logger"
import { globalTimers } from "~/lib/timer-registry"

const MIB = 1024 * 1024
const RECENT_CHECKPOINT_LIMIT = 32
const ACTIVE_TRACE_LIMIT = 128

interface MemoryTrace {
  traceId: string
  kind: string
  stage: string
  startedAt: number
  updatedAt: number
  peakRssBytes: number
  details: MemoryTraceDetails
}

export type MemoryTraceDetails = Record<
  string,
  boolean | number | string | undefined
>

export interface LinuxProcessMemory {
  vmRssBytes: number
  vmHwmBytes: number
  vmSwapBytes: number
}

export interface LinuxSystemMemory {
  memTotalBytes: number
  memAvailableBytes: number
  swapTotalBytes: number
  swapFreeBytes: number
}

export interface LinuxSwapCounters {
  pageIn: number
  pageOut: number
}

export interface LinuxMemoryPressure {
  someAvg10: number
  fullAvg10: number
}

interface WatchdogSample {
  process: LinuxProcessMemory
  system: LinuxSystemMemory
  swap: LinuxSwapCounters
  pressure: LinuxMemoryPressure
}

const activeTraces = new Map<string, MemoryTrace>()
const recentCheckpoints: Array<MemoryTrace> = []
let diagnosticsStarted = false
let sampleInFlight = false
let previousSwap: { counters: LinuxSwapCounters; at: number } | undefined
let nextExpectedTick = 0
let lastWarningAt = 0

function readPositiveNumber(name: string, fallback: number): number {
  const value = Number(process.env[name])
  return Number.isFinite(value) && value > 0 ? value : fallback
}

const WATCHDOG_INTERVAL_MS = readPositiveNumber(
  "MEMORY_DIAGNOSTICS_INTERVAL_MS",
  15_000,
)
const PROCESS_WARN_BYTES =
  readPositiveNumber("MEMORY_DIAGNOSTICS_PROCESS_MB", 512) * MIB
const SWAP_WARN_BYTES =
  readPositiveNumber("MEMORY_DIAGNOSTICS_SWAP_MB", 64) * MIB
const AVAILABLE_WARN_BYTES =
  readPositiveNumber("MEMORY_DIAGNOSTICS_AVAILABLE_MB", 128) * MIB
const EVENT_LOOP_WARN_MS = readPositiveNumber(
  "MEMORY_DIAGNOSTICS_EVENT_LOOP_LAG_MS",
  1000,
)
const SWAP_IO_WARN_PAGES_PER_SECOND = readPositiveNumber(
  "MEMORY_DIAGNOSTICS_SWAP_PAGES_PER_SECOND",
  256,
)
const PRESSURE_WARN_AVG10 = readPositiveNumber(
  "MEMORY_DIAGNOSTICS_PSI_AVG10",
  5,
)
const WARNING_COOLDOWN_MS = 30_000

export function beginMemoryTrace(options: {
  traceId: string
  kind: string
  stage: string
  details?: MemoryTraceDetails
}): void {
  if (activeTraces.size >= ACTIVE_TRACE_LIMIT) {
    const oldest = activeTraces.keys().next().value
    if (oldest) activeTraces.delete(oldest)
  }
  const now = Date.now()
  const rss = process.memoryUsage().rss
  activeTraces.set(options.traceId, {
    traceId: options.traceId,
    kind: options.kind,
    stage: options.stage,
    startedAt: now,
    updatedAt: now,
    peakRssBytes: rss,
    details: options.details ?? {},
  })
  recordCheckpoint(options.traceId)
  if (process.env.MEMORY_DIAGNOSTICS_VERBOSE === "true") {
    const trace = activeTraces.get(options.traceId)
    if (trace) {
      logger.info("[memory-diagnostics] request checkpoint", {
        ...serializeTrace(trace),
        process: serializeRuntimeMemory(process.memoryUsage()),
      })
    }
  }
}

export function updateMemoryTrace(
  traceId: string | undefined,
  stage: string,
  details: MemoryTraceDetails = {},
): void {
  if (!traceId) return
  const trace = activeTraces.get(traceId)
  if (!trace) return
  const usage = process.memoryUsage()
  trace.stage = stage
  trace.updatedAt = Date.now()
  trace.peakRssBytes = Math.max(trace.peakRssBytes, usage.rss)
  trace.details = { ...trace.details, ...details }
  recordCheckpoint(traceId)
  if (usage.rss >= PROCESS_WARN_BYTES) {
    warnForTrace(trace, usage, "rss_threshold")
  } else if (process.env.MEMORY_DIAGNOSTICS_VERBOSE === "true") {
    logger.info("[memory-diagnostics] request checkpoint", {
      ...serializeTrace(trace),
      process: serializeRuntimeMemory(usage),
    })
  }
}

export function endMemoryTrace(
  traceId: string | undefined,
  stage = "completed",
): void {
  if (!traceId) return
  updateMemoryTrace(traceId, stage)
  activeTraces.delete(traceId)
}

export function startMemoryDiagnostics(): void {
  if (diagnosticsStarted || process.env.MEMORY_DIAGNOSTICS === "false") {
    return
  }
  diagnosticsStarted = true
  nextExpectedTick = Date.now() + WATCHDOG_INTERVAL_MS
  logger.info("[memory-diagnostics] watchdog enabled", {
    intervalMs: WATCHDOG_INTERVAL_MS,
    processWarnMiB: toMiB(PROCESS_WARN_BYTES),
    swapWarnMiB: toMiB(SWAP_WARN_BYTES),
    availableWarnMiB: toMiB(AVAILABLE_WARN_BYTES),
    verbose: process.env.MEMORY_DIAGNOSTICS_VERBOSE === "true",
  })
  globalTimers.interval(() => {
    const now = Date.now()
    const eventLoopLagMs = Math.max(0, now - nextExpectedTick)
    nextExpectedTick = now + WATCHDOG_INTERVAL_MS
    if (sampleInFlight) return
    sampleInFlight = true
    void sampleMemoryWatchdog(eventLoopLagMs).finally(() => {
      sampleInFlight = false
    })
  }, WATCHDOG_INTERVAL_MS)
}

async function sampleMemoryWatchdog(eventLoopLagMs: number): Promise<void> {
  const runtime = process.memoryUsage()
  const linux = await readLinuxMemorySample()
  const swapRate = calculateSwapRate(linux?.swap)
  const reasons = pressureReasons(runtime, linux, swapRate, eventLoopLagMs)
  if (
    reasons.length === 0
    || Date.now() - lastWarningAt < WARNING_COOLDOWN_MS
  ) {
    return
  }
  lastWarningAt = Date.now()
  logger.warn("[memory-diagnostics] memory pressure detected", {
    reasons,
    eventLoopLagMs,
    process: {
      ...serializeRuntimeMemory(runtime),
      ...(linux ? serializeLinuxProcess(linux.process) : {}),
    },
    system: linux ? serializeLinuxSystem(linux.system) : undefined,
    swapIoPagesPerSecond: swapRate,
    memoryPressure: linux?.pressure,
    activeResponses: [...activeTraces.values()]
      .map((trace) => serializeTrace(trace))
      .slice(0, 16),
    recentCheckpoints: recentCheckpoints
      .map((trace) => serializeTrace(trace))
      .slice(-16),
  })
}

function pressureReasons(
  runtime: NodeJS.MemoryUsage,
  linux: WatchdogSample | undefined,
  swapRate: LinuxSwapCounters,
  eventLoopLagMs: number,
): Array<string> {
  const reasons: Array<string> = []
  const processBytes =
    linux ? linux.process.vmRssBytes + linux.process.vmSwapBytes : runtime.rss
  if (processBytes >= PROCESS_WARN_BYTES) reasons.push("process_working_set")
  if (linux && linux.process.vmSwapBytes >= SWAP_WARN_BYTES) {
    reasons.push("process_swap")
  }
  if (linux && linux.system.memAvailableBytes <= AVAILABLE_WARN_BYTES) {
    reasons.push("low_system_memory")
  }
  if (
    swapRate.pageIn >= SWAP_IO_WARN_PAGES_PER_SECOND
    || swapRate.pageOut >= SWAP_IO_WARN_PAGES_PER_SECOND
  ) {
    reasons.push("swap_io")
  }
  if (
    linux
    && (linux.pressure.someAvg10 >= PRESSURE_WARN_AVG10
      || linux.pressure.fullAvg10 >= PRESSURE_WARN_AVG10)
  ) {
    reasons.push("memory_psi")
  }
  if (eventLoopLagMs >= EVENT_LOOP_WARN_MS) reasons.push("event_loop_lag")
  return reasons
}

async function readLinuxMemorySample(): Promise<WatchdogSample | undefined> {
  if (process.platform !== "linux") return undefined
  try {
    const [status, meminfo, vmstat, pressure] = await Promise.all([
      fs.readFile("/proc/self/status", "utf8"),
      fs.readFile("/proc/meminfo", "utf8"),
      fs.readFile("/proc/vmstat", "utf8"),
      fs.readFile("/proc/pressure/memory", "utf8"),
    ])
    return {
      process: parseLinuxProcessMemory(status),
      system: parseLinuxSystemMemory(meminfo),
      swap: parseLinuxSwapCounters(vmstat),
      pressure: parseLinuxMemoryPressure(pressure),
    }
  } catch {
    return undefined
  }
}

function calculateSwapRate(
  current: LinuxSwapCounters | undefined,
): LinuxSwapCounters {
  if (!current) return { pageIn: 0, pageOut: 0 }
  const now = Date.now()
  const previous = previousSwap
  previousSwap = { counters: current, at: now }
  if (!previous) return { pageIn: 0, pageOut: 0 }
  const seconds = Math.max(0.001, (now - previous.at) / 1000)
  return {
    pageIn: Math.max(0, current.pageIn - previous.counters.pageIn) / seconds,
    pageOut: Math.max(0, current.pageOut - previous.counters.pageOut) / seconds,
  }
}

function recordCheckpoint(traceId: string): void {
  const trace = activeTraces.get(traceId)
  if (!trace) return
  recentCheckpoints.push({ ...trace, details: { ...trace.details } })
  if (recentCheckpoints.length > RECENT_CHECKPOINT_LIMIT) {
    recentCheckpoints.shift()
  }
}

function warnForTrace(
  trace: MemoryTrace,
  usage: NodeJS.MemoryUsage,
  reason: string,
): void {
  if (Date.now() - lastWarningAt < WARNING_COOLDOWN_MS) return
  lastWarningAt = Date.now()
  logger.warn("[memory-diagnostics] request crossed memory threshold", {
    reason,
    ...serializeTrace(trace),
    process: serializeRuntimeMemory(usage),
  })
}

function serializeTrace(trace: MemoryTrace): Record<string, unknown> {
  return {
    traceId: trace.traceId,
    kind: trace.kind,
    stage: trace.stage,
    ageMs: Date.now() - trace.startedAt,
    stageAgeMs: Date.now() - trace.updatedAt,
    peakRssMiB: toMiB(trace.peakRssBytes),
    ...trace.details,
  }
}

function serializeRuntimeMemory(usage: NodeJS.MemoryUsage) {
  return {
    rssMiB: toMiB(usage.rss),
    heapUsedMiB: toMiB(usage.heapUsed),
    heapTotalMiB: toMiB(usage.heapTotal),
    externalMiB: toMiB(usage.external),
    arrayBuffersMiB: toMiB(usage.arrayBuffers),
  }
}

function serializeLinuxProcess(memory: LinuxProcessMemory) {
  return {
    vmRssMiB: toMiB(memory.vmRssBytes),
    vmHwmMiB: toMiB(memory.vmHwmBytes),
    vmSwapMiB: toMiB(memory.vmSwapBytes),
  }
}

function serializeLinuxSystem(memory: LinuxSystemMemory) {
  return {
    memTotalMiB: toMiB(memory.memTotalBytes),
    memAvailableMiB: toMiB(memory.memAvailableBytes),
    swapTotalMiB: toMiB(memory.swapTotalBytes),
    swapUsedMiB: toMiB(memory.swapTotalBytes - memory.swapFreeBytes),
  }
}

function toMiB(bytes: number): number {
  return Math.round((bytes / MIB) * 10) / 10
}

function readKbField(input: string, name: string): number {
  const match = input.match(new RegExp(`^${name}:\\s+(\\d+)\\s+kB$`, "m"))
  return match ? Number(match[1]) * 1024 : 0
}

export function parseLinuxProcessMemory(input: string): LinuxProcessMemory {
  return {
    vmRssBytes: readKbField(input, "VmRSS"),
    vmHwmBytes: readKbField(input, "VmHWM"),
    vmSwapBytes: readKbField(input, "VmSwap"),
  }
}

export function parseLinuxSystemMemory(input: string): LinuxSystemMemory {
  return {
    memTotalBytes: readKbField(input, "MemTotal"),
    memAvailableBytes: readKbField(input, "MemAvailable"),
    swapTotalBytes: readKbField(input, "SwapTotal"),
    swapFreeBytes: readKbField(input, "SwapFree"),
  }
}

export function parseLinuxSwapCounters(input: string): LinuxSwapCounters {
  const read = (name: string) => {
    const match = input.match(new RegExp(`^${name}\\s+(\\d+)$`, "m"))
    return match ? Number(match[1]) : 0
  }
  return { pageIn: read("pswpin"), pageOut: read("pswpout") }
}

export function parseLinuxMemoryPressure(input: string): LinuxMemoryPressure {
  const read = (kind: "full" | "some") => {
    const line = input.match(new RegExp(`^${kind}\\s+(.+)$`, "m"))?.[1] ?? ""
    return Number(line.match(/(?:^|\s)avg10=(\d+(?:\.\d+)?)/)?.[1] ?? 0)
  }
  return { someAvg10: read("some"), fullAvg10: read("full") }
}

/** Test hook. */
export function resetMemoryDiagnosticsForTest(): void {
  activeTraces.clear()
  recentCheckpoints.length = 0
  previousSwap = undefined
  diagnosticsStarted = false
  sampleInFlight = false
  nextExpectedTick = 0
  lastWarningAt = 0
}
