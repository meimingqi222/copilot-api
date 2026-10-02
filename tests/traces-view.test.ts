import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { runInNewContext } from "node:vm"

function view(api = {}) {
  const source = readFileSync("pages/js/views/traces.js", "utf8")
  const context = {
    ViewHelpers: {},
    console,
    performance,
    Date,
    globalThis,
    API: api,
  }
  const result = runInNewContext(source + "\ntracesView()", context)
  result.refreshStage = () => {}
  result.t = (key: string) => key
  return result
}

describe("request trace view", () => {
  test("Fast badge distinguishes requested, sent, confirmed and changed tiers", () => {
    const trace = view()
    expect(trace.serviceTierBadge({ serviceTierRequested: "priority" })).toBe(
      "",
    )
    expect(trace.serviceTierBadge({ serviceTierUpstream: "priority" })).toBe(
      "Fast · trace.tierUnconfirmed",
    )
    expect(
      trace.serviceTierBadge({
        serviceTierUpstream: "priority",
        serviceTierResponse: "priority",
      }),
    ).toBe("Fast")
    expect(
      trace.serviceTierBadge({
        serviceTierUpstream: "priority",
        serviceTierResponse: "default",
      }),
    ).toBe("Fast · trace.tierChanged")
    expect(trace.serviceTierBadge({})).toBe("")
    expect(
      trace.serviceTierSummary({
        serviceTierRequested: "default",
        serviceTierRouted: "priority",
        serviceTierUpstream: "priority",
      }),
    ).toContain("trace.tierRouted: priority")
  })
  test("selected replay plays only the selected request without loading history", async () => {
    const v = view()
    v.mode = "history"
    v.history = [{ requestId: "first" }, { requestId: "selected" }]
    v.selectedId = "selected"
    let played: Array<{ requestId: string }> = []
    v.playFrames = (frames: typeof played) => {
      played = frames
    }
    v.showHistory = () => {
      throw new Error("Unexpected history load")
    }
    await v.replayOne()
    expect(played.map((frame) => frame.requestId)).toEqual(["selected"])
    expect(played[0]).not.toBe(v.history[1])
  })

  test("batch count and playback use only the current list's completed requests", async () => {
    const v = view()
    v.traces = [
      { requestId: "live-complete" },
      { requestId: "inflight", inFlight: true },
    ]
    v.history = [{ requestId: "filtered-history" }]
    let played: Array<{ requestId: string }> = []
    v.playFrames = (frames: typeof played) => {
      played = frames
    }
    v.showHistory = () => {
      throw new Error("Unexpected history load")
    }
    expect(v.replayableFrames.length).toBe(1)
    await v.replayAll()
    expect(played.map((frame) => frame.requestId)).toEqual(["live-complete"])
    v.mode = "history"
    expect(v.replayableFrames.length).toBe(1)
    await v.replayAll()
    expect(played.map((frame) => frame.requestId)).toEqual(["filtered-history"])
  })

  test("unavailable selections and busy state cannot start replay", async () => {
    const v = view()
    let calls = 0
    v.playFrames = () => {
      calls++
    }
    await v.replayOne()
    await v.replayOne({ requestId: "inflight", inFlight: true })
    v.replaying = true
    await v.replayOne({ requestId: "complete" })
    await v.replayAll()
    v.replaying = false
    v.historyLoading = true
    await v.replayOne({ requestId: "complete" })
    await v.replayAll()
    expect(calls).toBe(0)
  })

  test("live replay retains the selection after playback completes", async () => {
    const v = view()
    v.traces = [{ requestId: "selected", latencyMs: 1 }]
    v.selectedId = "selected"
    await v.replayOne()
    expect(v.mode).toBe("history")
    expect(v.selected?.requestId).toBe("selected")
    expect(v.history[0]).not.toBe(v.traces[0])
  })

  test("model-less trace rows identify the request instead of a dash", () => {
    const traceView = view()
    expect(
      traceView.rowModelDisplay({ method: "GET", path: "/v1/models" }),
    ).toBe("GET /v1/models")
    expect(
      traceView.rowModelDisplay({
        method: "POST",
        path: "/v1/messages/count_tokens",
      }),
    ).toBe("POST /v1/messages/count_tokens")
    expect(traceView.rowModelDisplay({ path: "/v1/models" })).toBe("/v1/models")
    expect(
      traceView.rowModelDisplay({
        modelRequested: "gpt-test",
        method: "POST",
        path: "/v1/responses",
      }),
    ).toBe("gpt-test")
    expect(
      traceView.rowModelDisplay({
        model: "public-model",
        modelRequested: "requested-model",
        modelUpstream: "native-model",
      }),
    ).toBe("public-model")
    expect(traceView.rowModelDisplay({ modelUpstream: "native-model" })).toBe(
      "native-model",
    )
    expect(traceView.rowModelDisplay(null)).toBe("-")
  })

  test("history replay waits for the returning packet before advancing", async () => {
    const v = view()
    const arrivals: Array<() => void> = []
    const registered = new Set<string>()
    const settled = [0, 1].map(
      () => new Promise<void>((resolve) => arrivals.push(resolve)),
    )
    v.refreshStage = () => {
      const frame = v.replayFrame
      if (frame && !frame.inFlight && !registered.has(frame.requestId)) {
        registered.add(frame.requestId)
        v._flightFrames.set(frame.requestId, frame)
        arrivals[v.replayIndex - 1]?.()
      }
    }
    const playing = v.playFrames([
      { requestId: "first", latencyMs: 1 },
      { requestId: "second", latencyMs: 1 },
    ])
    await settled[0]
    await new Promise((resolve) => setTimeout(resolve, 80))
    expect(v.replayIndex).toBe(1)
    expect(v.replaying).toBe(true)
    v._flightFrames.delete("first")
    await settled[1]
    expect(v.replayIndex).toBe(2)
    v._flightFrames.delete("second")
    await playing
    expect(v.replaying).toBe(false)
  })

  test("candidate placeholder is absent when routes exist", () => {
    const v = view()
    v.push({ requestId: "a", connectionId: "provider", inFlight: false })
    expect(v.showCandidatePlaceholder).toBe(false)
    const html = readFileSync("pages/index.html", "utf8")
    expect(html).toContain('x-if="showCandidatePlaceholder"')
  })

  test("a fast completion finishes the outbound and return flights before removal", () => {
    const v = view()
    const frame = { requestId: "a", connectionId: "provider", inFlight: false }
    const flight = {
      phase: "out",
      started: 0,
      routeKey: "provider::::",
      targetKey: "provider::::",
    }
    v.advanceFlight(flight, frame, 100)
    expect(flight.phase).toBe("out")
    v.advanceFlight(flight, frame, 900)
    expect(flight.phase).toBe("back")
    v.advanceFlight(flight, frame, 1000)
    expect(flight.phase).toBe("back")
    expect(v.advanceFlight(flight, frame, 2500)).toBe(true)
  })

  test("new live requests retain earlier animation records and their candidates", () => {
    const v = view()
    v.push({ requestId: "a", connectionId: "first", inFlight: true })
    v.push({ requestId: "a", inFlight: false, outcome: "success" })
    v.push({ requestId: "b", connectionId: "second", inFlight: true })
    expect(v._flightFrames.get("a").inFlight).toBe(false)
    expect(v._flightFrames.get("b").inFlight).toBe(true)
    expect(
      v.candidates.map((c: { connectionId: string }) => c.connectionId),
    ).toEqual(["second", "first"])
  })

  test("returning to live cancels replay without a stale timer changing selection", async () => {
    const v = view()
    v.push({
      requestId: "history",
      timestamp: 1,
      latencyMs: 3000,
      inFlight: false,
    })
    v.select(v.selected)
    const playing = v.replayOne()
    v.push({ requestId: "new-live", timestamp: 2, inFlight: true })
    v.backToLive()
    await playing
    expect(v.mode).toBe("live")
    expect(v.selectedId).toBe("new-live")
    expect(v.replaying).toBe(false)
    expect(v.replayFrame).toBeNull()
  })

  test("late history responses cannot replace the most recently selected date", async () => {
    const pending: Array<(value: object) => void> = []
    const v = view({
      trace: { history: () => new Promise((resolve) => pending.push(resolve)) },
    })
    const first = v.showHistory()
    const second = v.showHistory()
    pending[1]!({ traces: [{ requestId: "latest-date", timestamp: 2 }] })
    await second
    pending[0]!({ traces: [{ requestId: "old-date", timestamp: 1 }] })
    await first
    expect(v.selectedId).toBe("latest-date")
    expect(v.historyLoading).toBe(false)
  })
  test("live follows arrivals, ignores stale snapshots and older concurrent completions", () => {
    const v = view()
    v.push({ requestId: "a", timestamp: 1, seq: 1, inFlight: true })
    v.push({ requestId: "b", timestamp: 2, seq: 2, inFlight: true })
    v.push({ requestId: "a", timestamp: 1, seq: 3, inFlight: false })
    expect(v.selectedId).toBe("b")
    v.push({ requestId: "b", timestamp: 2, seq: 4, inFlight: false })
    v.push({ requestId: "b", timestamp: 2, seq: 2, inFlight: true })
    expect(v.selected.inFlight).toBe(false)
    expect(v.traces).toHaveLength(2)
  })

  test("history selection is frozen while live requests continue arriving", () => {
    const v = view()
    v.push({ requestId: "a", timestamp: 1, latencyMs: 2000, inFlight: false })
    v.select(v.selected)
    v.push({ requestId: "b", timestamp: 2, inFlight: true })
    expect(v.mode).toBe("history")
    expect(v.selectedId).toBe("a")
    expect(v.visibleTraces).toHaveLength(1)
    v.backToLive()
    expect(v.selectedId).toBe("b")
  })

  test("candidate states distinguish failed attempts from the provider actually responding", () => {
    const v = view()
    v.push({
      requestId: "a",
      connectionId: "winner",
      credentialId: "w",
      inFlight: true,
      candidates: [
        { connectionId: "first", credentialId: "f", status: "chosen" },
        { connectionId: "winner", credentialId: "w", status: "available" },
        { connectionId: "other", status: "available" },
      ],
      attempts: [
        {
          connectionId: "first",
          credentialId: "f",
          result: "failed",
          latencyMs: 80,
        },
      ],
    })
    expect(v.candidates.map((c: object) => v.candidateState(c))).toEqual([
      "failed",
      "waiting",
      "standby",
    ])
    v.push({ requestId: "a", ttftMs: 100, inFlight: true })
    expect(v.candidateState(v.candidates[1])).toBe("streaming")
    v.push({ requestId: "a", outcome: "success", inFlight: false })
    expect(v.candidateState(v.candidates[1])).toBe("answered")
  })

  test("replay uses recorded first-output and failed-attempt timings", () => {
    const v = view()
    const frame = {
      requestId: "a",
      connectionId: "second",
      latencyMs: 1000,
      ttftMs: 400,
      outcome: "success",
      attempts: [
        {
          connectionId: "first",
          credentialId: "f",
          result: "failed",
          latencyMs: 150,
        },
      ],
    }
    expect(v.replayAt(frame, 50)).toMatchObject({
      inFlight: true,
      connectionId: "first",
      ttftMs: undefined,
      attempts: [],
    })
    expect(v.replayAt(frame, 200)).toMatchObject({
      inFlight: true,
      connectionId: "second",
      ttftMs: undefined,
    })
    expect(v.replayAt(frame, 500)).toMatchObject({
      inFlight: true,
      ttftMs: 400,
    })
    expect(v.replayAt(frame, 1000)).toMatchObject({
      inFlight: false,
      outcome: "success",
    })
    expect(frame.outcome).toBe("success")
  })

  test("history clones reactive frames without retaining live nested objects", () => {
    const v = view()
    const raw = { requestId: "a", candidates: [{ status: "chosen" }] }
    const clone = v.cloneFrame(new Proxy(raw, {}))
    raw.candidates[0]!.status = "available"
    expect(clone.candidates[0].status).toBe("chosen")
  })
})
