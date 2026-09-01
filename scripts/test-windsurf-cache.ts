/**
 * test-windsurf-cache.ts
 *
 * Tests whether Windsurf server-side KV cache actually works when the
 * session UUID (field-22) is stable vs random across multi-turn requests.
 *
 * The test:
 *   - Sends a 4-message multi-turn conversation TWICE:
 *       Turn A: random session UUID (old behaviour)  → expect cached_tokens = 0
 *       Turn B: stable  session UUID (new behaviour) → expect cached_tokens > 0
 *
 * Windsurf response field-7 varints: [prompt_tokens, completion_tokens, cached_tokens]
 * A non-zero third varint on the second request confirms KV cache is being reused.
 *
 * Run: bun scripts/test-windsurf-cache.ts
 */

import { Database } from "bun:sqlite"
/* eslint-disable @typescript-eslint/no-non-null-assertion, unicorn/text-encoding-identifier-case */
import { createHash } from "node:crypto"
import { join } from "node:path"

import { extractWindsurfModelsFromPayload } from "~/services/windsurf/get-models"
import {
  ProtobufEncoder,
  decodeConnectFrames,
  encodeConnectFrame,
  extractStrings,
  parseMessage,
} from "~/services/windsurf/protobuf"

// ── 1. Credentials ─────────────────────────────────────────────────────────────

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
if (!row) throw new Error("No windsurfAuthStatus found in state.vscdb")
const apiKey = (JSON.parse(row.value) as { apiKey: string }).apiKey
console.log("✅ API key:", apiKey.slice(0, 30) + "...")

// ── 2. Constants ───────────────────────────────────────────────────────────────

const BASE_URL = "https://server.self-serve.windsurf.com"
const APP_VERSION = "1.48.2"
const LS_VERSION = "2.0.1050"
const CLIENT_NAME = "windsurf-next"

// ── 3. Auth – get JWT ──────────────────────────────────────────────────────────

function buildMetadata(jwt?: string): ProtobufEncoder {
  const m = new ProtobufEncoder()
  m.writeString(1, CLIENT_NAME)
  m.writeString(2, APP_VERSION)
  m.writeString(3, apiKey)
  m.writeString(4, "en")
  m.writeString(
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
  m.writeString(7, LS_VERSION)
  m.writeString(12, CLIENT_NAME)
  if (jwt) m.writeString(21, jwt)
  m.writeBytes(30, Uint8Array.from([0, 1]))
  return m
}

console.log(
  "\n── Fetching JWT ────────────────────────────────────────────────",
)
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
const jwt = extractStrings(authBytes).find(
  (s) => s.startsWith("eyJ") && s.includes("."),
)
if (!jwt) throw new Error("No JWT found in auth response")
console.log("✅ JWT:", jwt.slice(0, 40) + "...")

// ── 4. Model selection ─────────────────────────────────────────────────────────

console.log(
  "\n── Fetching models ──────────────────────────────────────────────",
)
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
const windsurfModels = models.filter((m) => m.vendor === "Windsurf")

// Prefer swe-1-6 (swe-1.6) for the test as it has the best KV cache support
const testModel =
  windsurfModels.find((m) => m.id.includes("swe-1-6") && !m.id.includes("fast"))
  ?? windsurfModels.find((m) => m.id.includes("swe-1-6"))
  ?? windsurfModels[0]
if (!testModel) {
  console.error("❌ No Windsurf models available")
  process.exit(1)
}

const upstreamId = testModel.upstreamId ?? testModel.id
const isSlugModel = !/^MODEL(?:_PRIVATE)?_/i.test(upstreamId)
console.log(
  `✅ Using model: ${testModel.id}  (upstream: ${upstreamId}, slug=${isSlugModel})`,
)

// ── 5. Request builder ─────────────────────────────────────────────────────────

function buildSampling(): ProtobufEncoder {
  const s = new ProtobufEncoder()
  s.writeVarint(1, 1) // stream = 1 (always)
  s.writeVarint(2, 64000) // max_context
  s.writeVarint(3, 512) // max_tokens (keep short for test speed)
  s.writeDouble(5, 0.4) // temperature
  s.writeDouble(6, 0.4) // top_p
  s.writeVarint(7, 50) // top_k
  s.writeDouble(8, 1.0) // repetition_penalty
  if (isSlugModel) {
    for (const tok of [
      "<|user|>",
      "<|bot|>",
      "<|context_request|>",
      "<|endoftext|>",
      "<|end_of_turn|>",
    ]) {
      s.writeString(9, tok)
    }
    s.writeDouble(11, 1.0) // presence_penalty
  }
  return s
}

function buildDoNotCall(): ProtobufEncoder {
  const t = new ProtobufEncoder()
  t.writeString(1, "do_not_call")
  t.writeString(2, "Do not call this tool.")
  t.writeString(
    3,
    JSON.stringify({
      $schema: "https://json-schema.org/draft/2020-12/schema",
      properties: {},
      additionalProperties: false,
      type: "object",
    }),
  )
  return t
}

/** Derives a stable session UUID from the invariant conversation prefix. */
function deriveSessionId(systemPrompt: string, firstUserMsg: string): string {
  const seed = `${upstreamId}\x00${systemPrompt}\x00${firstUserMsg}`
  const hex = createHash("sha256").update(seed).digest("hex")
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    `5${hex.slice(13, 16)}`,
    ((Number.parseInt(hex[16], 16) & 0x3) | 0x8).toString(16)
      + hex.slice(17, 20),
    hex.slice(20, 32),
  ].join("-")
}

type Message = { role: "user" | "assistant"; content: string }

/**
 * Builds a GetChatMessage Connect-Protocol request frame.
 * @param messages   Full conversation history to send.
 * @param sessionId  field-22 value – pass randomUUID() or a stable hash.
 */
function buildChatRequest(
  messages: Array<Message>,
  sessionId: string,
): Uint8Array {
  const systemPrompt = "You are a helpful assistant. Be concise."
  const req = new ProtobufEncoder()
  req.writeMessage(1, buildMetadata(jwt))
  req.writeString(2, systemPrompt)

  for (const msg of messages) {
    const m = new ProtobufEncoder()
    m.writeVarint(2, msg.role === "user" ? 1 : 2)
    m.writeString(3, msg.content)
    req.writeMessage(3, m)
  }

  req.writeVarint(7, isSlugModel ? 5 : 15)
  req.writeMessage(8, buildSampling())
  req.writeMessage(10, buildDoNotCall())

  const trace = new ProtobufEncoder()
  trace.writeString(1, crypto.randomUUID()) // trace-id always fresh
  trace.writeVarint(2, 5)
  trace.writeVarint(3, 4)
  trace.writeVarint(4, 23)
  req.writeMessage(15, trace)

  req.writeString(16, crypto.randomUUID()) // request-id always fresh
  req.writeString(21, upstreamId)
  req.writeString(22, sessionId) // ← THE KEY FIELD UNDER TEST

  return encodeConnectFrame(req.toUint8Array(), true)
}

// ── 6. Stream helper ───────────────────────────────────────────────────────────

interface TurnResult {
  content: string
  promptTokens: number
  completionTokens: number
  cachedTokens: number
  frameCount: number
}

async function runTurn(
  label: string,
  messages: Array<Message>,
  sessionId: string,
): Promise<TurnResult> {
  console.log(`\n  ▶ ${label}`)
  console.log(`    session_id : ${sessionId}`)
  console.log(`    messages   : ${messages.length}`)

  const body = buildChatRequest(messages, sessionId)
  const resp = await fetch(
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
      body,
    },
  )

  if (!resp.ok) {
    const err = await resp.text()
    throw new Error(`HTTP ${resp.status}: ${err}`)
  }

  let content = ""
  let promptTokens = 0
  let completionTokens = 0
  let cachedTokens = 0
  let frameCount = 0

  for await (const frame of decodeConnectFrames(resp.body!)) {
    frameCount++

    // Check for Connect error envelope
    const txt = Buffer.from(frame).toString("utf-8").trim()
    if (txt.startsWith("{")) {
      try {
        const parsed = JSON.parse(txt) as {
          error?: { code?: string; message?: string }
        }
        if (parsed.error) {
          console.error(`    ❌ error frame: ${parsed.error.message}`)
          continue
        }
      } catch {
        /* not JSON */
      }
    }

    const nodes = parseMessage(frame, 0, 2)
    for (const node of nodes) {
      // field-3: text token
      if (node.field === 3 && node.wire === 2 && node.raw) {
        try {
          const t = new TextDecoder("utf-8", { fatal: true }).decode(node.raw)
          content += t
        } catch {
          /* binary node */
        }
      }

      // field-7: usage metadata varint array
      // layout: [prompt_tokens, completion_tokens, cached_tokens]
      if (node.field === 7 && node.wire === 2 && node.sub) {
        const varints = node.sub
          .filter((n) => n.wire === 0 && n.varint !== undefined)
          .map((n) => n.varint ?? 0)
        if (varints.length > 0) promptTokens = Number(varints[0])
        if (varints.length >= 2) completionTokens = Number(varints[1])
        if (varints.length >= 3) cachedTokens = Number(varints[2])
      }
    }
  }

  const result: TurnResult = {
    content,
    promptTokens,
    completionTokens,
    cachedTokens,
    frameCount,
  }

  const cacheHit = cachedTokens > 0
  console.log(
    `    tokens     : prompt=${promptTokens}  completion=${completionTokens}  `
      + `cached=${cachedTokens}  ${cacheHit ? "✅ CACHE HIT" : "❌ cache miss"}`,
  )
  console.log(`    frames     : ${frameCount}`)
  console.log(`    reply      : ${content.slice(0, 80).replaceAll("\n", "↵")}…`)

  return result
}

// ── 7. Build a multi-turn conversation ────────────────────────────────────────
//
// We use a moderately long system prompt so the prompt token count is
// meaningful and KV cache savings are detectable.

const SYSTEM_LONG = "You are a helpful assistant. Be concise."

const TURN1_USER = "What is the capital of France?"
const TURN1_ASS = "Paris."
const TURN2_USER = "And what is the population of that city?"
const TURN2_ASS =
  "About 2.1 million in the city proper, 12 million in the metropolitan area."
const TURN3_USER = "Name one famous landmark there."

const historyTurn1: Array<Message> = [{ role: "user", content: TURN1_USER }]
const historyTurn3: Array<Message> = [
  { role: "user", content: TURN1_USER },
  { role: "assistant", content: TURN1_ASS },
  { role: "user", content: TURN2_USER },
  { role: "assistant", content: TURN2_ASS },
  { role: "user", content: TURN3_USER },
]

const stableSessionId = deriveSessionId(SYSTEM_LONG, TURN1_USER)
const randomSessionIdA = crypto.randomUUID()
const randomSessionIdB = crypto.randomUUID() // different random each turn

console.log(`\nStable session UUID  : ${stableSessionId}`)
console.log(`Random session UUID A: ${randomSessionIdA}`)
console.log(`Random session UUID B: ${randomSessionIdB}`)

// ── 8. Experiment A – random UUID per turn (old behaviour) ────────────────────

console.log(`
╔════════════════════════════════════════════════════════════════════╗
║  EXPERIMENT A — Random session UUID every request (old behaviour)  ║
║  Hypothesis: cached_tokens == 0 on every turn                      ║
╚════════════════════════════════════════════════════════════════════╝`)

const rA1 = await runTurn(
  "Turn 1/3 (random UUID, 1-msg history)",
  historyTurn1,
  randomSessionIdA,
)

// Brief pause so server settles
await new Promise((r) => setTimeout(r, 1500))

const rA3 = await runTurn(
  "Turn 3/3 (different random UUID, 5-msg history)",
  historyTurn3,
  randomSessionIdB, // ← new UUID even though same conversation
)

// ── 9. Experiment B – stable UUID (new behaviour) ─────────────────────────────

console.log(`
╔════════════════════════════════════════════════════════════════════╗
║  EXPERIMENT B — Stable (hash-derived) session UUID (new behaviour) ║
║  Hypothesis: cached_tokens > 0 on turn 3 (shared prefix reused)    ║
╚════════════════════════════════════════════════════════════════════╝`)

const rB1 = await runTurn(
  "Turn 1/3 (stable UUID, 1-msg history)",
  historyTurn1,
  stableSessionId,
)

await new Promise((r) => setTimeout(r, 1500))

const rB3 = await runTurn(
  "Turn 3/3 (SAME stable UUID, 5-msg history)",
  historyTurn3,
  stableSessionId, // ← same UUID, server can reuse KV cache for turns 1-2
)

// ── 10. Summary ────────────────────────────────────────────────────────────────

console.log(`
╔═══════════════════════════════════════════════════════════════════╗
║                           SUMMARY                                 ║
╠══════════════════════════╦══════════════════════╦═════════════════╣
║  Scenario                ║  cached_tokens       ║  Result         ║
╠══════════════════════════╬══════════════════════╬═════════════════╣
║  A: random UUID turn 1   ║  ${String(rA1.cachedTokens).padEnd(20)}║  ${rA1.cachedTokens > 0 ? "✅ cache hit" : "❌ miss     "}  ║
║  A: random UUID turn 3   ║  ${String(rA3.cachedTokens).padEnd(20)}║  ${rA3.cachedTokens > 0 ? "✅ cache hit" : "❌ miss     "}  ║
║  B: stable UUID  turn 1  ║  ${String(rB1.cachedTokens).padEnd(20)}║  ${rB1.cachedTokens > 0 ? "✅ cache hit" : "❌ miss     "}  ║
║  B: stable UUID  turn 3  ║  ${String(rB3.cachedTokens).padEnd(20)}║  ${rB3.cachedTokens > 0 ? "✅ cache hit" : "❌ miss     "}  ║
╚══════════════════════════╩══════════════════════╩═════════════════╝`)

const cacheFixed = rB3.cachedTokens > 0 && rA3.cachedTokens === 0
const cachePartial = rB3.cachedTokens > 0 && rA3.cachedTokens > 0

if (cacheFixed) {
  console.log(`
✅ CONFIRMED: KV cache ONLY works with stable session UUID.
   Stable turn-3 cached ${rB3.cachedTokens} tokens (~${((rB3.cachedTokens / (rB3.promptTokens || 1)) * 100).toFixed(1)}% of prompt).
   The deriveSessionId() fix in create-chat-completions.ts is correct.`)
} else if (cachePartial) {
  console.log(`
⚠️  PARTIAL: Cache hit on both experiments.
   Windsurf may cache by content hash regardless of session UUID.
   Still, stable UUID is safer and aligns with the actual Windsurf client.`)
} else if (rB3.cachedTokens === 0 && rA3.cachedTokens === 0) {
  console.log(`
⚠️  INCONCLUSIVE: No caching observed in either experiment.
   Possible causes:
     - Model ${testModel.id} does not expose cached_tokens in field-7/[2]
     - The field-7 varint layout differs for this model
     - KV cache requires more turns or longer prefix to activate
   Check raw field-7 varint values above.`)
} else {
  console.log(`
ℹ️  Mixed result – inspect cached_tokens values above for details.`)
}
