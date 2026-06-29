import { describe, expect, test } from "bun:test"
import fs from "node:fs"

import type { ChatCompletionsPayload } from "~/services/copilot/create-chat-completions"

import { parseMessage } from "~/services/windsurf/protobuf"
import { buildRequest } from "~/services/windsurf/request-builders"
import {
  diffProtoFieldSets,
  fingerprintWindsurfRequest,
} from "~/services/windsurf/request-fingerprint"

const CAPTURE_PATH = "D:/code/copilot-refs/data/GetChatMessage-req"

function decodeFramedPayload(framed: Uint8Array): Uint8Array {
  if (framed.length < 5) return framed
  const flags = framed[0]
  const payload = framed.subarray(5)
  if (flags === 1 || flags === 3) {
    return new Uint8Array(Bun.gunzipSync(Buffer.from(payload)))
  }
  return payload
}

function loadCapturePayload(): Uint8Array | undefined {
  if (!fs.existsSync(CAPTURE_PATH)) return undefined
  return decodeFramedPayload(new Uint8Array(fs.readFileSync(CAPTURE_PATH)))
}

function topLevelFields(payload: Uint8Array): Array<number> {
  return parseMessage(payload, 0, 6)
    .map((n) => n.field)
    .sort((a, b) => a - b)
}

function metadataFields(payload: Uint8Array): Array<number> {
  const meta = parseMessage(payload, 0, 6).find((n) => n.field === 1 && n.sub)
  return (meta?.sub ?? []).map((n) => n.field).sort((a, b) => a - b)
}

describe("Windsurf proto — capture vs buildRequest", () => {
  test("real capture has expected top-level layout", () => {
    const payload = loadCapturePayload()
    if (!payload) return

    const fields = topLevelFields(payload)
    expect(fields).toContain(1)
    expect(fields).toContain(2)
    expect(fields).toContain(3)
    expect(fields).toContain(7)
    expect(fields).toContain(8)
    expect(fields).toContain(10)
    expect(fields).toContain(15)
    expect(fields).toContain(16)
    expect(fields).toContain(20)
    expect(fields).toContain(21)

    const capture = fingerprintWindsurfRequest(
      new Uint8Array(fs.readFileSync(CAPTURE_PATH)),
    )
    expect(capture.mode).toBe(5)
    expect(capture.requestType).toBe(1)
    expect(capture.model).toBe("MODEL_PRIVATE_11")
    expect(capture.metadata.f1).toBe("windsurf-next")
    expect(capture.metadata.f12).toBe("chisel")
    expect(capture.metadata.f28).toBe("chisel")
    expect(capture.metadata.f2).toBe("2026.8.1009")
    expect(capture.samplingFields).toEqual([1, 2, 3, 5, 7, 8])
  })

  test("buildRequest matches Devin CLI capture exactly", () => {
    const capturePayload = loadCapturePayload()
    if (!capturePayload) return

    const payload: ChatCompletionsPayload = {
      model: "swe-1-6",
      messages: [{ role: "user", content: "hello" }],
      tools: [
        {
          type: "function",
          function: {
            name: "read_file",
            description: "Read a file",
            parameters: { type: "object", properties: {} },
          },
        },
      ],
      stream: true,
    }

    const built = buildRequest({
      payload,
      settings: {
        apiKey: "test-key",
        clientName: "windsurf-next",
        appVersion: "2026.8.1009",
        lsVersion: "2026.8.1009",
        extensionName: "chisel",
        ideType: "chisel",
      },
      apiKey: "test-key",
      requestModel: "MODEL_PRIVATE_11",
      cascadeId: "cc232f62-2495-407a-bd78-502af5ece433",
      workspaceFingerprint: "abc123",
    })

    const builtPayload = decodeFramedPayload(built)
    const topDiff = diffProtoFieldSets(
      topLevelFields(capturePayload),
      topLevelFields(builtPayload),
    )
    const metaDiff = diffProtoFieldSets(
      metadataFields(capturePayload),
      metadataFields(builtPayload),
    )

    // Top-level fields match exactly: no extra fields in built.
    for (const field of [1, 2, 3, 7, 8, 10, 15, 16, 20, 21]) {
      expect(topDiff.shared).toContain(field)
    }
    expect(topDiff.onlyInBuilt).toEqual([])
    expect(topDiff.onlyInCapture).toEqual([])

    // Metadata fields match exactly: Devin CLI sends only
    // f1, f2, f3, f4, f5, f7, f12, f28, f31.
    for (const field of [1, 2, 3, 4, 5, 7, 12, 28, 31]) {
      expect(metaDiff.shared).toContain(field)
    }
    expect(metaDiff.onlyInBuilt).toEqual([])
    expect(metaDiff.onlyInCapture).toEqual([])

    const fingerprint = fingerprintWindsurfRequest(built)
    expect(fingerprint.mode).toBe(5)
    expect(fingerprint.requestType).toBe(1)
    expect(fingerprint.model).toBe("MODEL_PRIVATE_11")
    expect(fingerprint.metadata.f12).toBe("chisel")
    expect(fingerprint.metadata.f28).toBe("chisel")
    expect(fingerprint.metadata.f31).toBe("abc123")
    expect(fingerprint.metadata.f10).toBeUndefined()
    expect(fingerprint.metadata.f9).toBeUndefined()
    expect(fingerprint.metadata.f21).toBeUndefined()
    expect(fingerprint.metadata.f25).toBeUndefined()
  })
})
