/* eslint-disable @typescript-eslint/no-non-null-assertion, unicorn/text-encoding-identifier-case, max-depth */
import { Database } from "bun:sqlite"
import { join } from "node:path"

import { extractWindsurfModelsFromPayload } from "~/services/windsurf/get-models"
import {
  ProtobufEncoder,
  decodeConnectFrames,
  encodeConnectFrame,
  extractStrings,
  parseMessage,
} from "~/services/windsurf/protobuf"

// ── 1. Read API key ──
const dbPath = join(
  process.env.APPDATA ?? "",
  "Windsurf - Next",
  "User",
  "globalStorage",
  "state.vscdb",
)
const db = new Database(dbPath, { readonly: true })
const row = db
  .prepare("SELECT value FROM ItemTable WHERE key = ?")
  .get("windsurfAuthStatus") as { value: string } | null
if (!row) throw new Error("No windsurfAuthStatus found")
const apiKey = (JSON.parse(row.value) as { apiKey: string }).apiKey
console.log("✅ API key:", apiKey.slice(0, 30) + "...")

// ── 2. Settings ──
const BASE_URL = "https://server.self-serve.windsurf.com"
const APP_VERSION = "1.48.2"
const LS_VERSION = "2.0.1050"
const CLIENT_NAME = "windsurf-next"

function buildMetadata(jwt?: string): ProtobufEncoder {
  const metadata = new ProtobufEncoder()
  metadata.writeString(1, CLIENT_NAME)
  metadata.writeString(2, APP_VERSION)
  metadata.writeString(3, apiKey)
  metadata.writeString(4, "en")
  metadata.writeString(
    5,
    JSON.stringify({
      Os: "windows",
      Arch: "amd64",
      Version: "6.3",
      ProductName: "Windows 10 Home China",
      MajorVersionNumber: 10,
      MinorVersionNumber: 0,
      Build: "26200",
    }),
  )
  metadata.writeString(7, LS_VERSION)
  metadata.writeString(
    8,
    JSON.stringify({
      NumSockets: 1,
      NumCores: 8,
      NumThreads: 16,
      VendorID: "AuthenticAMD",
      Family: "107",
      Model: "",
      ModelName: "AMD Ryzen 7 7745HX with Radeon Graphics",
      Memory: 42078334976,
    }),
  )
  metadata.writeString(12, CLIENT_NAME)
  if (jwt) metadata.writeString(21, jwt)
  metadata.writeBytes(30, Uint8Array.from([0, 1]))
  return metadata
}

// ── 3. Get JWT ──
console.log("\n=== Step 1: Fetching JWT ===")
const authReq = new ProtobufEncoder()
authReq.writeMessage(1, buildMetadata())

const authResp = await fetch(`${BASE_URL}/exa.auth_pb.AuthService/GetUserJwt`, {
  method: "POST",
  headers: {
    "Content-Type": "application/proto",
    "Connect-Protocol-Version": "1",
    "User-Agent": "connect-go/1.18.1 (go1.26.1)",
    "Accept-Encoding": "gzip",
  },
  body: authReq.toUint8Array(),
})
if (!authResp.ok) {
  console.error("❌ Auth failed:", authResp.status, await authResp.text())
  process.exit(1)
}
const authBytes = new Uint8Array(await authResp.arrayBuffer())
const authStrings = extractStrings(authBytes)
const jwt = authStrings.find((s) => s.startsWith("eyJ") && s.includes("."))
if (!jwt) throw new Error("No JWT found")
console.log("✅ JWT:", jwt.slice(0, 40) + "...")

// ── 4. Get models ──
console.log("\n=== Step 2: Fetching models ===")
const statusReq = new ProtobufEncoder()
statusReq.writeMessage(1, buildMetadata(jwt))

const statusResp = await fetch(
  `${BASE_URL}/exa.seat_management_pb.SeatManagementService/GetUserStatus`,
  {
    method: "POST",
    headers: {
      "Content-Type": "application/proto",
      "Connect-Protocol-Version": "1",
      "User-Agent": "connect-go/1.18.1 (go1.26.1)",
      "Accept-Encoding": "gzip",
      "Connect-Timeout-Ms": "5000",
    },
    body: statusReq.toUint8Array(),
  },
)
if (!statusResp.ok) {
  console.error("❌ GetUserStatus failed:", statusResp.status)
  process.exit(1)
}
const statusBytes = new Uint8Array(await statusResp.arrayBuffer())
const models = extractWindsurfModelsFromPayload(statusBytes)
console.log(`✅ Found ${models.length} models`)
const windsurfModels = models.filter((m) => m.vendor === "Windsurf")
console.log(
  "Windsurf models:",
  windsurfModels.map((m) => `${m.id} → ${m.upstreamId}`).join(", "),
)

// Pick the best model for testing
const testModelEntry =
  windsurfModels.find((m) => m.id.includes("swe-1-6-fast"))
  ?? windsurfModels.find((m) => m.id.includes("swe-1-6"))
  ?? windsurfModels[0]
if (!testModelEntry) {
  console.error("❌ No Windsurf models available")
  process.exit(1)
}
const testModelUpstreamId = testModelEntry.upstreamId ?? testModelEntry.id
const testModelId = testModelEntry.id
console.log(`\nUsing model: ${testModelId} (upstream: ${testModelUpstreamId})`)

// ── 5. Build and send chat request ──
console.log("\n=== Step 3: Sending chat request ===")

const isSlugModel = !/^MODEL(?:_PRIVATE)?_/i.test(testModelUpstreamId)
// For native Windsurf slug models (swe-*), field 7=5; for enum IDs (Gemini/GPT etc), field 7=15
const modeField7 = isSlugModel ? 5 : 15
console.log(
  `Model type: ${isSlugModel ? "slug" : "enum"}, field 7 = ${modeField7}`,
)

function buildSamplingBlock(stream: boolean): ProtobufEncoder {
  const sampling = new ProtobufEncoder()
  sampling.writeVarint(1, stream ? 1 : 0)
  sampling.writeVarint(2, 64000) // max_context
  sampling.writeVarint(3, 1024) // max_tokens
  sampling.writeDouble(5, 0.4) // temperature
  sampling.writeDouble(6, 0.4) // top_p (matches capture)
  sampling.writeVarint(7, 50) // top_k
  sampling.writeDouble(8, 1.0) // repetition_penalty
  // special tokens for SWE autoregressive models
  if (isSlugModel) {
    for (const tok of [
      "<|user|>",
      "<|bot|>",
      "<|context_request|>",
      "<|endoftext|>",
      "<|end_of_turn|>",
    ]) {
      sampling.writeString(9, tok)
    }
    sampling.writeDouble(11, 1.0)
  }
  return sampling
}

function buildChatRequest(
  modelUpstreamId: string,
  stream: boolean,
): Uint8Array {
  const request = new ProtobufEncoder()
  request.writeMessage(1, buildMetadata(jwt))
  request.writeString(2, "You are a helpful assistant.")

  // field 3: user message (role=1=user, content)
  const userMsg = new ProtobufEncoder()
  userMsg.writeVarint(2, 1) // role: user
  userMsg.writeString(3, "Say hello in one short sentence.")
  request.writeMessage(3, userMsg)

  request.writeVarint(7, modeField7)
  request.writeMessage(8, buildSamplingBlock(stream))

  // do_not_call tool
  const tool = new ProtobufEncoder()
  tool.writeString(1, "do_not_call")
  tool.writeString(2, "Do not call this tool.")
  tool.writeString(
    3,
    JSON.stringify({
      $schema: "https://json-schema.org/draft/2020-12/schema",
      properties: {},
      additionalProperties: false,
      type: "object",
    }),
  )
  request.writeMessage(10, tool)

  // trace
  const trace = new ProtobufEncoder()
  trace.writeString(1, crypto.randomUUID())
  trace.writeVarint(2, 5)
  trace.writeVarint(3, 4)
  trace.writeVarint(4, 23)
  request.writeMessage(15, trace)

  request.writeString(16, crypto.randomUUID())
  request.writeString(21, modelUpstreamId)
  request.writeString(22, crypto.randomUUID())
  return encodeConnectFrame(request.toUint8Array(), true)
}

const requestBody = buildChatRequest(testModelUpstreamId, true)
console.log(
  "Request size:",
  requestBody.length,
  "bytes, upstream ID:",
  testModelUpstreamId,
)

const chatResp = await fetch(
  `${BASE_URL}/exa.api_server_pb.ApiServerService/GetChatMessage`,
  {
    method: "POST",
    headers: {
      "Content-Type": "application/connect+proto",
      "Connect-Protocol-Version": "1",
      "Connect-Accept-Encoding": "gzip",
      "Connect-Content-Encoding": "gzip",
      "Connect-Timeout-Ms": "30000",
      "User-Agent": "connect-go/1.18.1 (go1.26.1)",
      "Accept-Encoding": "identity",
    },
    body: requestBody,
  },
)
console.log("Response status:", chatResp.status)

if (!chatResp.ok) {
  console.error("❌ HTTP error:", await chatResp.text())
  process.exit(1)
}

// ── 6. Parse stream ──
console.log("\n=== Step 4: Parsing stream ===")
let frameIndex = 0
let fullContent = ""
let fullReasoning = ""
let hasDone = false

for await (const frame of decodeConnectFrames(chatResp.body!)) {
  frameIndex++
  if (frameIndex > 200) {
    console.log("(stopping at 200 frames)")
    break
  }

  // Check for JSON error
  const txt = Buffer.from(frame).toString("utf8").trim()
  if (txt.startsWith("{")) {
    try {
      const parsed = JSON.parse(txt) as {
        error?: { code?: string; message?: string }
      }
      if (parsed.error) {
        console.error(
          `❌ Frame ${frameIndex} error (code=${parsed.error.code}):`,
          parsed.error.message,
        )
        continue
      }
    } catch {
      // not JSON
    }
  }

  const nodes = parseMessage(frame, 0, 2)
  for (const node of nodes) {
    if (node.field === 3 && node.wire === 2 && node.raw) {
      try {
        const t = new TextDecoder("utf-8", { fatal: true }).decode(node.raw)
        if (t) {
          fullContent += t
          process.stdout.write(t)
        }
      } catch {
        /* binary */
      }
    }
    if (node.field === 9 && node.wire === 2 && node.raw) {
      try {
        const t = new TextDecoder("utf-8", { fatal: true }).decode(node.raw)
        if (t) fullReasoning += t
      } catch {
        /* binary */
      }
    }
    if (node.field === 5 && node.wire === 0 && node.varint === 2) {
      hasDone = true
    }
  }
}

console.log("\n\n=== Results ===")
console.log("Frames:", frameIndex, "| Done signal:", hasDone)
console.log("Content length:", fullContent.length)
console.log("Reasoning length:", fullReasoning.length)
if (fullContent) console.log("Content:", fullContent.slice(0, 300))
if (fullReasoning) console.log("Reasoning:", fullReasoning.slice(0, 300))
