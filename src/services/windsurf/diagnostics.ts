import { logger } from "~/lib/logger"

type Phase =
  | "auth"
  | "session"
  | "encode"
  | "headers"
  | "error_body"
  | "retry_delay"
  | "first_output"
  | "streaming"

/** Bounded, content-free diagnostics shared by auth, transport and decoding. */
export class WindsurfAttemptDiagnostics {
  private readonly context: {
    requestId: string
    accountId: string
    model: string
    streaming: boolean
    attempt: number
  }
  private readonly startedAt = performance.now()
  private phase: Phase = "auth"
  private phaseStartedAt = this.startedAt
  private readonly phaseDurationsMs: Partial<Record<Phase, number>> = {}
  private firstReadBytes = 0
  private readBytes = 0
  private readChunks = 0
  private lastReadAt: number | undefined
  private frames = 0
  private frameBytes = 0
  private readonly events = { content: 0, reasoning: 0, tool: 0 }
  private lastOutputAt: number | undefined
  private sawEos = false

  constructor(context: WindsurfAttemptDiagnostics["context"]) {
    this.context = context
    this.log("info", "request phase")
  }

  enter(
    phase: Phase,
    details: Record<string, string | number | undefined> = {},
  ): void {
    const now = performance.now()
    this.phaseDurationsMs[this.phase] =
      (this.phaseDurationsMs[this.phase] ?? 0) + now - this.phaseStartedAt
    this.phase = phase
    this.phaseStartedAt = now
    this.log("info", "request phase", details)
  }

  read(bytes: number): void {
    this.readBytes += bytes
    this.readChunks++
    this.lastReadAt = performance.now()
    if (this.readChunks === 1) {
      this.firstReadBytes = bytes
      this.log("info", "first upstream bytes")
    }
  }

  frame(bytes: number): void {
    this.frames++
    this.frameBytes += bytes
    if (this.frames === 1) this.log("info", "first connect frame")
  }

  output(kind: keyof WindsurfAttemptDiagnostics["events"]): void {
    this.events[kind]++
    this.lastOutputAt = performance.now()
    if (this.phase !== "streaming") this.enter("streaming")
  }

  endStream(): void {
    this.sawEos = true
    this.log("info", "end stream received")
  }

  log(
    level: "info" | "warn",
    event: string,
    details: Record<string, string | number | undefined> = {},
  ): void {
    const now = performance.now()
    logger[level](`[windsurf] ${event}`, {
      ...this.context,
      phase: this.phase,
      elapsedMs: Math.round(now - this.startedAt),
      phaseDurationsMs: Object.fromEntries(
        Object.entries({
          ...this.phaseDurationsMs,
          [this.phase]:
            (this.phaseDurationsMs[this.phase] ?? 0)
            + now
            - this.phaseStartedAt,
        }).map(([phase, ms]) => [phase, Math.round(ms)]),
      ),
      firstReadBytes: this.firstReadBytes,
      readBytes: this.readBytes,
      readChunks: this.readChunks,
      lastReadAgeMs:
        this.lastReadAt === undefined ?
          undefined
        : Math.round(now - this.lastReadAt),
      frames: this.frames,
      frameBytes: this.frameBytes,
      contentEvents: this.events.content,
      reasoningEvents: this.events.reasoning,
      toolEvents: this.events.tool,
      lastOutputAgeMs:
        this.lastOutputAt === undefined ?
          undefined
        : Math.round(now - this.lastOutputAt),
      sawEos: this.sawEos,
      ...details,
    })
  }
}
