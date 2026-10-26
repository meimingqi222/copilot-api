import { afterEach, expect, spyOn, test } from "bun:test"
import { randomUUID, createHmac } from "node:crypto"
import { Hono } from "hono"

import {
  RedactionScope,
  runRedactedCall,
  maskUpstream,
  withRedactionUpstream,
} from "~/lib/redaction/context"
import { redactionConfigSchema } from "~/lib/redaction/rules"
import {
  getRedactionDiagnostics,
  getRedactionInspection,
  setRedactionInspection,
  clearRedactionInspection,
  getRedactionInspectionState,
  subscribeRedactionDiagnostics,
} from "~/lib/redaction/diagnostics"
import {
  flushRedactionHistory,
  summarizeRedactionHistory,
} from "~/lib/redaction/history"
import { restoreRedactionStream } from "~/lib/redaction/stream"
import { initializeSystemConfig, updateSystemConfig } from "~/lib/system-config"
import {
  serializeUpstreamBody,
  performanceFetch,
} from "~/lib/upstream-performance"

const config = redactionConfigSchema.parse({ enabled: true })
const createScope = () => new RedactionScope(config, randomUUID())
const sign = (text: string) =>
  createHmac("sha256", "test-issuer").update(text).digest("hex")

test("tool results mask Windows homes inside JSON text and restore the exact output", () => {
  const home = ["C:", "Users", "ToolResultFixture"].join("\\")
  const path = `${home}\\.codex\\config.toml`
  for (const output of [path, JSON.stringify({ output: path })]) {
    const scope = createScope()
    const input = {
      input: [
        { type: "function_call_output", call_id: "call_fixture", output },
      ],
    }
    const masked = scope.mask(input)
    expect(masked.input[0].output).not.toContain("ToolResultFixture")
    expect(masked.input[0].output).toContain("{{HOME_")
    expect(scope.diagnostics().byKind.HOME).toBe(1)
    expect(scope.restore(masked, "fixture")).toEqual(input)
    if (output.startsWith("{"))
      expect(() => JSON.parse(masked.input[0].output)).not.toThrow()
  }
})

test("Windows home paths mask forward slashes and case variants before dispatch", () => {
  for (const home of [
    "C:/Users/Synthetic",
    "c:/users/Synthetic",
    "C:\\USERS\\Synthetic",
    "C:\\Users\\Synthetic",
  ]) {
    const scope = createScope()
    const input = {
      messages: [{ role: "user", content: `Read ${home}/project/file.ts` }],
    }
    const masked = scope.mask(input)
    expect(masked.messages[0].content).not.toContain(home)
    expect(masked.messages[0].content).toContain("{{HOME_")
    expect(masked.messages[0].content).toStartWith("Read {{HOME_")
    expect(scope.restore(masked, "fixture")).toEqual(input)
    const jsonScope = createScope()
    const tool = {
      messages: [
        {
          role: "assistant",
          tool_calls: [
            {
              id: "call-fixture",
              type: "function",
              function: {
                name: "read_file",
                arguments: JSON.stringify({ path: `${home}/project/file.ts` }),
              },
            },
          ],
        },
      ],
    }
    const maskedTool = jsonScope.mask(tool)
    expect(maskedTool.messages[0].tool_calls[0].function.arguments).toContain(
      "{{HOME_",
    )
    expect(jsonScope.restore(maskedTool, "fixture")).toEqual(tool)
  }
})

afterEach(() => {
  setRedactionInspection(false)
  delete process.env.UPSTREAM_REDACTION
  initializeSystemConfig({ save: () => {}, onChange: () => {} })
})

test("protects credentials and home prefixes without changing IDs, media or tool argument keys", () => {
  const scope = createScope()
  const key = "sk-redactiontest1234567890"
  const payload = {
    model: "model",
    messages: [
      {
        role: "user",
        content: `alice /home/alice/project /home/alice2/other C:\\Users\\小明\\work ${key} DB_PASSWORD=hello1234`,
      },
    ],
    tools: [{ name: "read_file", description: "/Users/jane/private" }],
    content: [
      {
        type: "tool_use",
        id: "tool_1",
        input: { name: key, signature: key, path: "C:\\Users\\Alice\\project" },
      },
      { type: "image", source: { type: "base64", data: key } },
    ],
  }
  const masked = scope.mask(payload)
  expect(masked.messages[0].content).not.toContain(key)
  expect(masked.messages[0].content).not.toContain("hello1234")
  expect(masked.messages[0].content).toStartWith("alice ")
  expect(masked.tools[0].name).toBe("read_file")
  expect(masked.content[0].id).toBe("tool_1")
  expect(masked.content[1].source?.data).toBe(key)
  expect(scope.restore(masked, "issuer")).toEqual(payload)
})

test("preserves protocol settings and schema literals while masking descriptions and tool data", () => {
  const scope = new RedactionScope(
    redactionConfigSchema.parse({
      enabled: true,
      words: ["private", "cutoff"],
    }),
    randomUUID(),
  )
  const schema = {
    type: "object",
    properties: {
      private: {
        type: "string",
        description: "private input",
        enum: ["private"],
        const: "private",
        default: "private",
        examples: [{ description: "private" }],
      },
      enum: { type: "string", description: "private enum property" },
    },
    $defs: { default: { type: "string", description: "private definition" } },
    required: ["private"],
    additionalProperties: false,
  }
  const payload = {
    tools: [
      {
        type: "function",
        function: {
          name: "private_tool",
          description: "private tool",
          parameters: schema,
        },
      },
      { name: "private_tool", input_schema: schema },
      { functionDeclarations: [{ name: "private_tool", parameters: schema }] },
      {
        type: "custom",
        name: "private_patch",
        format: {
          type: "grammar",
          syntax: "lark",
          definition: 'start: "private"',
        },
      },
    ],
    functions: [{ name: "private_tool", parameters: schema }],
    response_format: {
      type: "json_schema",
      json_schema: { name: "private", schema },
    },
    text: { format: { type: "json_schema", name: "private", schema } },
    output_config: { format: { type: "json_schema", schema } },
    generationConfig: {
      responseSchema: schema,
      responseMimeType: "application/json",
    },
    tool_choice: { type: "function", name: "private_tool" },
    toolConfig: {
      functionCallingConfig: { allowedFunctionNames: ["private_tool"] },
    },
    stream_options: { reasoning_summary_delivery: "sequential_cutoff" },
    input: [
      {
        type: "function_call",
        namespace: "private",
        server_label: "private",
        server_name: "private",
        arguments: JSON.stringify({
          namespace: "private",
          stream_options: { mode: "cutoff" },
          tools: [{ description: "private" }],
        }),
      },
    ],
  }
  const masked = scope.mask(payload)
  const maskedSchema = masked.tools[0].function!.parameters
  expect(maskedSchema.properties.private.description).not.toBe("private input")
  expect({
    ...maskedSchema.properties.private,
    description: "private input",
  }).toEqual(schema.properties.private)
  expect(maskedSchema.properties.enum.description).not.toContain("private")
  expect(maskedSchema.$defs.default.description).not.toContain("private")
  expect(maskedSchema.required).toEqual(["private"])
  expect(masked.tools[0].function!.description).not.toBe("private tool")
  expect(masked.tools[0].function!.name).toBe("private_tool")
  expect(masked.tools[1].input_schema).toEqual(maskedSchema)
  expect(masked.tools[2].functionDeclarations![0].parameters).toEqual(
    maskedSchema,
  )
  expect(masked.tools[3]).toEqual(payload.tools[3])
  expect(masked.functions[0].parameters).toEqual(maskedSchema)
  expect(masked.response_format.json_schema.schema).toEqual(maskedSchema)
  expect(masked.response_format.json_schema.name).toBe("private")
  expect(masked.text.format.schema).toEqual(maskedSchema)
  expect(masked.text.format.name).toBe("private")
  expect(masked.output_config.format.schema).toEqual(maskedSchema)
  expect(masked.generationConfig.responseSchema).toEqual(maskedSchema)
  expect(masked.tool_choice).toEqual(payload.tool_choice)
  expect(masked.toolConfig).toEqual(payload.toolConfig)
  expect(masked.stream_options).toEqual(payload.stream_options)
  expect({ ...masked.input[0], arguments: "" }).toEqual({
    ...payload.input[0],
    arguments: "",
  })
  expect(masked.input[0].arguments).not.toContain("private")
  expect(masked.input[0].arguments).not.toContain("cutoff")
  expect(scope.restore(masked, "issuer")).toEqual(payload)
})

test("masks additional vendor credential formats without consuming partial identifiers", () => {
  const credentials = [
    "AIza" + "Ab9_".repeat(8) + "xyz",
    "ASIA" + "A1".repeat(8),
    "xai-" + "Ab9".repeat(14),
    "hf_" + "Ab9".repeat(10),
    "gsk_" + "Ab9".repeat(14),
    "npm_" + "Ab9".repeat(12),
    "pypi-" + "Ab9_".repeat(13),
    "rk_live_" + "Ab9".repeat(8),
  ]
  const scope = createScope()
  const input = credentials.join("\n")
  const masked = scope.maskText(input)
  for (const credential of credentials) expect(masked).not.toContain(credential)
  expect(scope.restoreText(masked)).toBe(input)
  const clean = [
    "AIzaShort",
    "ASIA123",
    "xai-short",
    "npm_short",
    "prefix" + credentials[0],
    credentials[1] + "Z",
  ]
  expect(createScope().maskText(clean.join("\n"))).toBe(clean.join("\n"))
})

test("does not mistake secret-related code for literal credentials", () => {
  const code = [
    "type Keys = { secretKey: Uint8Array; apiKey: StringV2 | null }",
    "f({ private_key: pair.secretV2, token: config.tokenV2 })",
    "const secretKey = fromBase64Url(input)",
    "privateKey: crypto.randomBytes(32),",
  ].join("\n")
  expect(createScope().maskText(code)).toBe(code)
  for (const input of [
    'secretKey: "Uint8Array9x",',
    "TOKEN=abcd1234efgh",
    "password: abcd1234efgh",
    '{"secretKey": "abcd1234efgh"}',
  ]) {
    const scope = createScope()
    const masked = scope.maskText(input)
    expect(masked).not.toBe(input)
    expect(scope.restoreText(masked)).toBe(input)
  }
})

test("keeps stable placeholders per caller but only restores values used by the current request", () => {
  const caller = randomUUID()
  const first = new RedactionScope(config, caller)
  const token = first.maskText("DB_PASSWORD=hello1234").split("=")[1]
  const second = new RedactionScope(config, caller)
  expect(second.restoreText(token)).toBe(token)
  expect(second.maskText("echo hello1234")).toBe(`echo ${token}`)
  expect(second.restoreText(token)).toBe("hello1234")
  const other = createScope()
  expect(other.maskText("DB_PASSWORD=hello1234")).not.toContain(token)
  expect(other.restoreText(token)).toBe(token)
  expect(other.maskText(token)).toBe(token)
  expect(other.restoreText(token)).toBe(token)
})

test("recent diagnostics count unique values, finish streams once and retain only bounded metadata", async () => {
  process.env.UPSTREAM_REDACTION = '{"enabled":true}'
  initializeSystemConfig({ save: () => {}, onChange: () => {} })
  const startId = getRedactionDiagnostics().entries[0]?.id ?? 0
  const secret = "SyntheticStats" + "Pass123"
  const text = `DB_PASSWORD=${secret} ${secret}`
  const completed = await runRedactedCall(
    { text },
    undefined,
    async (prepared) => ({ response: maskUpstream(prepared) }),
  )
  expect(completed.response.text).toBe(text)
  const first = getRedactionDiagnostics().entries[0]
  expect(first.id).toBe(startId + 1)
  expect(first.total).toBe(1)
  expect(first.byKind).toEqual({ SECRET: 1, HOME: 0, WORD: 0, PERSONAL: 0 })
  expect(first.bySource).toEqual({
    builtin: 1,
    word: 0,
    homePrefix: 0,
    field: 0,
    known: 0,
  })
  expect(first.restored).toBe(2)
  expect(Number.isFinite(first.maskingMs)).toBe(true)
  const streamed = await runRedactedCall(
    { text },
    undefined,
    async (prepared) => ({
      response: (async function* () {
        yield { choices: [{ index: 0, delta: { content: prepared.text } }] }
        yield { choices: [{ index: 0, delta: { content: "tail" } }] }
      })(),
    }),
  )
  expect(getRedactionDiagnostics().entries[0].id).toBe(first.id + 1)
  expect(getRedactionDiagnostics().entries[0].status).toBe("in_progress")
  const iterator = streamed.response[Symbol.asyncIterator]()
  await iterator.next()
  expect(getRedactionDiagnostics().entries[0].id).toBe(first.id + 1)
  await iterator.return?.()
  expect(getRedactionDiagnostics().entries[0].id).toBe(first.id + 1)
  await iterator.return?.()
  expect(getRedactionDiagnostics().entries[0].id).toBe(first.id + 1)
  await expect(
    runRedactedCall({ text }, undefined, async () => {
      throw new Error("synthetic failure")
    }),
  ).rejects.toThrow("synthetic failure")
  expect(getRedactionDiagnostics().entries[0].id).toBe(first.id + 2)
  for (let i = 0; i < 101; i++)
    await runRedactedCall({ text }, undefined, async () => ({
      response: { text: "ok" },
    }))
  const history = getRedactionDiagnostics()
  expect(history.limit).toBe(100)
  expect(history.entries).toHaveLength(100)
  expect(history.entries[0].id - history.entries[99].id).toBe(99)
  expect(Object.keys(history.entries[0]).sort()).toEqual(
    [
      "id",
      "timestamp",
      "total",
      "byKind",
      "byLabel",
      "bySource",
      "warned",
      "blocked",
      "maskingMs",
      "restored",
      "client",
      "upstreams",
      "contentAvailable",
      "contentState",
      "contentVersion",
      "detected",
      "detectedByKind",
      "warnedByKind",
      "blockedByKind",
      "blockedCount",
      "attempts",
      "attemptsTruncated",
      "status",
    ].sort(),
  )
  const serialized = JSON.stringify(history)
  expect(serialized).not.toContain(secret)
  expect(serialized).not.toContain("{{SECRET_")
  history.entries[0].byKind.SECRET = -1
  expect(getRedactionDiagnostics().entries[0].byKind.SECRET).toBe(1)
})

test("live diagnostics publish before upstream resolves and commit history once after completion", async () => {
  process.env.UPSTREAM_REDACTION = '{"enabled":true}'
  initializeSystemConfig({ save: () => {}, onChange: () => {} })
  await flushRedactionHistory()
  const before = (await summarizeRedactionHistory(7)).requests
  const statuses: string[] = []
  const unsubscribe = subscribeRedactionDiagnostics(() => {
    statuses.push(getRedactionDiagnostics().entries[0].status)
  })
  let finish!: () => void
  const gate = new Promise<void>((resolve) => {
    finish = resolve
  })
  const upstream = {
    id: "slow-live",
    name: "Slow fixture",
    protocol: "openai-compatible",
    model: "fixture",
  }
  try {
    const pending = runRedactedCall(
      { text: "DB_PASSWORD=SyntheticLivePass123" },
      undefined,
      (prepared) =>
        withRedactionUpstream(upstream, prepared, async () => {
          await gate
          return { response: prepared }
        }),
    )
    const started = getRedactionDiagnostics().entries[0]
    expect(started.status).toBe("in_progress")
    expect(started.upstreams).toEqual([upstream])
    expect(started.total).toBe(1)
    await flushRedactionHistory()
    expect((await summarizeRedactionHistory(7)).requests).toBe(before)
    finish()
    await pending
    const ended = getRedactionDiagnostics().entries[0]
    expect(ended.id).toBe(started.id)
    expect(ended.timestamp).toBe(started.timestamp)
    expect(ended.status).toBe("completed")
    expect(ended.restored).toBe(1)
    await flushRedactionHistory()
    expect((await summarizeRedactionHistory(7)).requests).toBe(before + 1)
    expect(statuses).toEqual([
      "in_progress",
      "in_progress",
      "in_progress",
      "completed",
    ])
  } finally {
    finish()
    unsubscribe()
  }
})

test("stream failure and cancellation update the original live record only once", async () => {
  process.env.UPSTREAM_REDACTION = '{"enabled":true}'
  initializeSystemConfig({ save: () => {}, onChange: () => {} })
  for (const fail of [false, true]) {
    const result = await runRedactedCall(
      { text: "hello" },
      undefined,
      async () => ({
        response: (async function* () {
          yield { choices: [{ index: 0, delta: { content: "first" } }] }
          if (fail) throw new Error("fixture stream failure")
        })(),
      }),
    )
    const id = getRedactionDiagnostics().entries[0].id
    const iterator = result.response[Symbol.asyncIterator]()
    await iterator.next()
    if (fail)
      await expect(iterator.next()).rejects.toThrow("fixture stream failure")
    else await iterator.return?.()
    await iterator.return?.()
    expect(getRedactionDiagnostics().entries[0]).toMatchObject({
      id,
      status: fail ? "failed" : "cancelled",
    })
  }
})

test("a home path beyond the inspection prefix retains independent match evidence", async () => {
  process.env.UPSTREAM_REDACTION = '{"enabled":true}'
  initializeSystemConfig({ save: () => {}, onChange: () => {} })
  setRedactionInspection(true)
  const home = "c:/users/LongPromptFixture"
  const payload = {
    messages: [
      { role: "system", content: "Long system text. ".repeat(2000) },
      { role: "user", content: `Read ${home}/project` },
    ],
  }
  await runRedactedCall(payload, undefined, (prepared) =>
    withRedactionUpstream(
      {
        id: "codebuddy-fixture",
        name: "CodeBuddy fixture",
        protocol: "codebuddy-native",
        model: "fixture",
      },
      prepared,
      async () => {
        expect(prepared.messages[1].content).not.toContain(home)
        expect(prepared.messages[1].content).toStartWith("Read {{HOME_")
        return { response: { text: "ok" } }
      },
    ),
  )
  const record = getRedactionDiagnostics().entries[0]
  expect(record.total).toBe(1)
  expect(record.byKind.HOME).toBe(1)
  const detail = getRedactionInspection(record.id)!
  expect(detail.truncated).toBe(true)
  expect(detail.mappings).toHaveLength(1)
  expect(detail.attempts[0].body).not.toContain("{{HOME_")
  expect(JSON.stringify(detail.attempts[0].excerpts)).toContain("{{HOME_")
})

test("long Codex requests retain tool-output match evidence from the final HTTP body", async () => {
  process.env.UPSTREAM_REDACTION = '{"enabled":true}'
  initializeSystemConfig({ save: () => {}, onChange: () => {} })
  setRedactionInspection(true)
  const home = ["C:", "Users", "ToolEvidenceFixture"].join("\\")
  const output = JSON.stringify({ output: `${home}\\.codex\\config.toml` })
  let received = ""
  const receiver = Bun.serve({
    port: 0,
    fetch: async (request) => {
      received = await request.text()
      return Response.json({ text: "ok" })
    },
  })
  try {
    await runRedactedCall(
      {
        instructions: "Long agent instructions. ".repeat(4000),
        input: [{ type: "function_call_output", call_id: "fixture", output }],
      },
      undefined,
      (prepared) =>
        withRedactionUpstream(
          {
            id: "fixture",
            name: "Fixture",
            protocol: "codex-native",
            model: "fixture",
          },
          prepared,
          async () => ({
            response: await (
              await performanceFetch(receiver.url, {
                method: "POST",
                body: serializeUpstreamBody(prepared),
              })
            ).json(),
          }),
        ),
    )
    expect(received).not.toContain("ToolEvidenceFixture")
    expect(received).toContain("{{HOME_")
    const entry = getRedactionDiagnostics().entries[0]
    expect(entry.byKind.HOME).toBe(1)
    const detail = getRedactionInspection(entry.id)!
    expect(detail.mappings).toHaveLength(1)
    expect(detail.attempts[0].stage).toBe("http")
    expect(detail.attempts[0].body).not.toContain("{{HOME_")
    expect(JSON.stringify(detail.attempts[0].excerpts)).toContain("{{HOME_")
    expect(JSON.stringify(detail)).not.toContain("ToolEvidenceFixture")
    expect(JSON.stringify(getRedactionInspection(entry.id, true))).toContain(
      "ToolEvidenceFixture",
    )
    expect(getRedactionDiagnostics().inspection.bytes).toBeLessThanOrEqual(
      getRedactionDiagnostics().inspection.maxEntryBytes,
    )
    clearRedactionInspection()
    expect(getRedactionInspection(entry.id, true)).toBeUndefined()
    expect(getRedactionDiagnostics().inspection.bytes).toBe(0)
  } finally {
    receiver.stop(true)
  }
})

test("opt-in inspection distinguishes final HTTP bodies, multiple attempts and explicit original reveal", async () => {
  process.env.UPSTREAM_REDACTION = '{"enabled":true}'
  const original = ["", "home", "inspection-fixture", "project"].join("/")
  const upstream = {
    id: "route-a",
    name: "Provider A",
    protocol: "openai-compatible",
    model: "native-a",
  }
  const receiver = Bun.serve({
    port: 0,
    fetch: async (request) => Response.json(await request.json()),
  })
  try {
    const payload = { model: "native-a", input: original }
    const send = () =>
      runRedactedCall(payload, undefined, (masked) =>
        withRedactionUpstream(upstream, masked, async () => {
          const body = serializeUpstreamBody({
            ...masked,
            injected: "after adapter preparation",
          })
          // This unrelated side request must not appear as a generation body.
          await performanceFetch(receiver.url, {
            method: "POST",
            body: '{"refresh_token":"not-generation"}',
          })
          await performanceFetch(receiver.url, { method: "POST", body })
          return withRedactionUpstream(
            { ...upstream, id: "route-b", name: "Provider B" },
            masked,
            async () => ({
              response: await (
                await performanceFetch(receiver.url, {
                  method: "POST",
                  body: serializeUpstreamBody(masked),
                })
              ).json(),
            }),
          )
        }),
      )
    await send()
    expect(getRedactionDiagnostics().entries[0].contentAvailable).toBe(false)
    expect(
      getRedactionInspection(getRedactionDiagnostics().entries[0].id, true),
    ).toBeUndefined()
    setRedactionInspection(true)
    const result = await send()
    expect(result.response).toEqual(payload)
    const entry = getRedactionDiagnostics().entries[0]
    expect(entry.upstreams.map((item) => item.id)).toEqual([
      "route-a",
      "route-b",
    ])
    expect(entry.contentAvailable).toBe(true)
    expect(JSON.stringify(getRedactionDiagnostics())).not.toContain(original)
    const detail = getRedactionInspection(entry.id)!
    expect(detail.input).toBeNull()
    expect(detail.attempts.map((attempt) => attempt.stage)).toEqual([
      "http",
      "http",
    ])
    expect(detail.attempts[0].body).toContain("after adapter preparation")
    expect(JSON.stringify(detail)).not.toContain(original)
    expect(JSON.stringify(detail)).not.toContain("not-generation")
    expect(detail.mappings).toHaveLength(1)
    const revealed = getRedactionInspection(entry.id, true)!
    expect(revealed.input).toBeNull()
    expect(revealed.mappings[0]).toMatchObject({
      value: original.split("/").slice(0, 3).join("/"),
      source: "builtin",
      kind: "HOME",
    })
  } finally {
    receiver.stop(true)
  }
})

test("clear, disable and expiry revoke in-flight inspection without breaking response restoration", async () => {
  process.env.UPSTREAM_REDACTION = '{"enabled":true}'
  const upstream = {
    id: "route",
    name: "Provider",
    protocol: "claude-native",
    model: "model",
  }
  const original = ["", "home", "pending-fixture", "project"].join("/")
  for (const action of ["clear", "disable", "expire"]) {
    setRedactionInspection(true, "temporary")
    let finish!: () => void
    const pending = new Promise<void>((resolve) => {
      finish = resolve
    })
    const call = runRedactedCall({ input: original }, undefined, (masked) =>
      withRedactionUpstream(upstream, masked, async () => {
        await pending
        return { response: masked }
      }),
    )
    let clock: ReturnType<typeof spyOn> | undefined
    try {
      if (action === "clear") clearRedactionInspection()
      else if (action === "disable") setRedactionInspection(false)
      else {
        const expiresAt = getRedactionInspectionState().expiresAt!
        clock = spyOn(Date, "now").mockReturnValue(expiresAt + 1)
        expect(getRedactionInspectionState().enabled).toBe(false)
      }
      finish()
      expect((await call).response).toEqual({ input: original })
      const entry = getRedactionDiagnostics().entries[0]
      expect(entry.contentAvailable).toBe(false)
      expect(getRedactionInspection(entry.id, true)).toBeUndefined()
      expect(getRedactionInspectionState().bytes).toBe(0)
    } finally {
      clock?.mockRestore()
      finish()
    }
  }
})

test("inspection retains bounded payloads and evicts old records under memory pressure", async () => {
  process.env.UPSTREAM_REDACTION =
    '{"enabled":true,"homePaths":false,"secrets":false}'
  setRedactionInspection(true)
  const upstream = {
    id: "cli",
    name: "CLI",
    protocol: "claude-native",
    model: "model",
  }
  let first = 0
  for (let i = 0; i < 105; i++) {
    await runRedactedCall({ input: "x".repeat(40_000) }, undefined, (masked) =>
      withRedactionUpstream(upstream, masked, () =>
        withRedactionUpstream({ ...upstream, id: "second" }, masked, () =>
          withRedactionUpstream(
            { ...upstream, id: "third" },
            masked,
            async () => ({ response: "ok" }),
          ),
        ),
      ),
    )
    if (i === 0) first = getRedactionDiagnostics().entries[0].id
    if (i === 89) {
      expect(
        getRedactionDiagnostics().entries.some((entry) => entry.id === first),
      ).toBe(true)
      expect(getRedactionInspection(first, true)).toBeUndefined()
    }
  }
  const stats = getRedactionDiagnostics()
  expect(stats.entries).toHaveLength(100)
  expect(stats.inspection.bytes).toBeLessThanOrEqual(stats.inspection.maxBytes)
  expect(
    stats.entries.filter((entry) => entry.contentAvailable).length,
  ).toBeLessThan(100)
  expect(getRedactionInspection(first, true)).toBeUndefined()
  const detail = getRedactionInspection(stats.entries[0].id, true)!
  expect(detail.truncated).toBe(true)
  expect(detail.attempts[0].stage).toBe("adapter")
  expect(detail.attempts[0].body.length * 2).toBeLessThanOrEqual(
    stats.inspection.maxEntryBytes,
  )
})

test("unresolved placeholders stay opaque in tool inputs, ordinary text and tool outputs", async () => {
  const scope = createScope()
  const token = `{{HOME_${"a".repeat(32)}}}`
  const command = `cd ${token}/work/code/project`
  const argumentsJson = JSON.stringify({ command })
  const calls = [
    { type: "tool_use", input: { command } },
    { type: "tool_use", input: { output: command, name: token } },
    { function: { arguments: argumentsJson } },
    { type: "function_call", arguments: argumentsJson },
    { type: "custom_tool_call", input: command },
    { functionCall: { args: { command } }, thoughtSignature: "signed" },
  ]
  for (const call of calls) expect(scope.restore(call, "issuer")).toEqual(call)
  const ordinary = {
    text: command,
    output: [{ type: "function_call_output", output: { text: command } }],
  }
  const ordinaryScope = createScope()
  expect(ordinaryScope.restore(ordinaryScope.mask(ordinary), "issuer")).toEqual(
    ordinary,
  )

  for (const wire of ["chat", "legacy-chat", "messages", "responses", "custom"])
    for (let split = 1; split < token.length; split++) {
      const chunks = [token.slice(0, split), token.slice(split)]
      const packets = chunks.map((chunk) =>
        wire === "chat" ?
          {
            choices: [
              {
                index: 0,
                delta: {
                  tool_calls: [{ index: 0, function: { arguments: chunk } }],
                },
              },
            ],
          }
        : wire === "legacy-chat" ?
          {
            choices: [
              { index: 0, delta: { function_call: { arguments: chunk } } },
            ],
          }
        : wire === "messages" ?
          {
            type: "content_block_delta",
            index: 0,
            delta: { type: "input_json_delta", partial_json: chunk },
          }
        : {
            type:
              wire === "custom" ?
                "response.custom_tool_call_input.delta"
              : "response.function_call_arguments.delta",
            item_id: "tool",
            delta: chunk,
          },
      )
      const output = await collect(packets, scope)
      expect(JSON.stringify(output)).not.toContain("Cannot restore")
    }
})

test("expired ordinary placeholders remain opaque while new sensitive input is still masked", () => {
  const caller = randomUUID()
  const first = new RedactionScope(config, caller)
  const token = first.maskText("/home/expired-user/work")
  const clock = spyOn(Date, "now").mockReturnValue(Date.now() + 61 * 60_000)
  try {
    const next = new RedactionScope(config, caller)
    const masked = next.maskText(`${token} /home/new-user/work`)
    expect(masked).toStartWith(token + " ")
    expect(masked).not.toContain("new-user")
    expect(next.restoreText(masked)).toBe(`${token} /home/new-user/work`)
    expect(next.restoreText(token)).toBe(token)
  } finally {
    clock.mockRestore()
  }
})

test("repeated masking still protects changed content, newly learned secrets and JSON contexts", () => {
  const scope = createScope()
  const echo = "echo valueWithoutAssignment123"
  expect(scope.maskText(echo)).toBe(echo)
  const secret = scope
    .maskText("password=valueWithoutAssignment123")
    .slice("password=".length)
  expect(scope.maskText(echo)).toBe(`echo ${secret}`)
  expect(scope.maskText("plainValue")).toBe("plainValue")
  expect(scope.mask({ password: "plainValue" }).password).toStartWith(
    "{{SECRET_",
  )

  const payload = { messages: [{ role: "user", content: "ordinary text" }] }
  scope.mask(payload)
  payload.messages[0].content = "/home/new-user/work"
  expect(scope.mask(payload).messages[0].content).not.toContain("new-user")
  expect(payload.messages[0].content).toBe("/home/new-user/work")

  const wordScope = new RedactionScope(
    redactionConfigSchema.parse({ enabled: true, words: ['private"word'] }),
  )
  const word = wordScope.maskText('private"word')
  const partial = String.raw`{"text":"private\"word`
  expect(wordScope.maskText(partial, true)).toBe(`{"text":"${word}`)
  expect(wordScope.restoreText(wordScope.maskText(partial, true), true)).toBe(
    partial,
  )
})

test("placeholders past the old 1024-entry point stay restorable and callers stay isolated", () => {
  const caller = randomUUID()
  const active = new RedactionScope(config, caller)
  const release = active.acquire()
  const pinned = active.maskText("/home/live-request")
  let oldest = ""
  let oldestOriginal = ""
  try {
    for (let index = 0; index < 1050; index++) {
      const request = new RedactionScope(config, caller)
      const done = request.acquire()
      try {
        const path = String.fromCharCode(47) + `home/cache-${index}`
        const token = request.maskText(path)
        if (index === 0) {
          oldest = token
          oldestOriginal = path
        }
      } finally {
        done()
      }
    }
    const next = new RedactionScope(config, caller)
    expect(next.maskText(oldest)).toBe(oldest)
    expect(next.restoreText(oldest)).toBe(oldestOriginal)
    expect(next.restoreText(next.maskText(pinned))).toBe("/home/live-request")
    expect(active.restoreText(pinned)).toBe("/home/live-request")
    const other = createScope()
    expect(other.restoreText(other.maskText("/home/another-user"))).toBe(
      "/home/another-user",
    )
  } finally {
    release()
  }
})

test("byte pressure evicts idle history without evicting live requests or starving another caller", () => {
  const caller = randomUUID()
  let oldest = ""
  for (let index = 0; index < 4; index++) {
    const scope = new RedactionScope(config, caller)
    const release = scope.acquire()
    try {
      const masked = scope.mask({ password: `${index}` + "Z".repeat(512000) })
      if (index === 0) oldest = masked.password
    } finally {
      release()
    }
  }
  const next = new RedactionScope(config, caller)
  expect(next.maskText(oldest)).toBe(oldest)
  expect(next.restoreText(oldest)).toBe(oldest)

  const liveId = randomUUID()
  const live = new RedactionScope(config, liveId)
  const release = live.acquire()
  const liveToken = live.mask({ password: "L".repeat(512000) }).password
  const idleId = randomUUID()
  let idleToken = ""
  try {
    for (let index = 0; index < 20; index++) {
      const scope = new RedactionScope(
        config,
        index === 0 ? idleId : randomUUID(),
      )
      const done = scope.acquire()
      try {
        const token = scope.mask({
          password: `${index}` + "Q".repeat(512000),
        }).password
        if (index === 0) idleToken = token
      } finally {
        done()
      }
    }
    const idle = new RedactionScope(config, idleId)
    expect(idle.maskText(idleToken)).toBe(idleToken)
    expect(idle.restoreText(idleToken)).toBe(idleToken)
    expect(new RedactionScope(config, liveId).maskText(liveToken)).toBe(
      liveToken,
    )
    expect(live.restoreText(liveToken).length).toBe(512000)
  } finally {
    release()
  }
})

test("rule groups independently disable new and previously known matches without deleting their lists", () => {
  const rules = redactionConfigSchema.parse({
    enabled: true,
    words: ["private.example"],
    homePrefixes: ["/srv/private-user"],
  })
  const caller = randomUUID()
  const input =
    "DB_PASSWORD=demoValue123 /home/alice/work /srv/private-user/project private.example"
  const initial = new RedactionScope(rules, caller)
  initial.maskText(input)
  for (const disabled of ["secrets", "homePaths", "wordsEnabled"] as const) {
    const scope = new RedactionScope({ ...rules, [disabled]: false }, caller)
    const masked = scope.maskText(input)
    expect(masked.includes("{{SECRET_")).toBe(disabled !== "secrets")
    expect(masked.includes("{{HOME_")).toBe(disabled !== "homePaths")
    expect(masked.includes("{{WORD_")).toBe(disabled !== "wordsEnabled")
    if (disabled === "secrets") expect(masked).toContain("demoValue123")
    if (disabled === "homePaths") {
      expect(masked).toContain("/home/alice/work")
      expect(masked).toContain("/srv/private-user/project")
    }
    if (disabled === "wordsEnabled") expect(masked).toContain("private.example")
    expect(scope.restoreText(masked)).toBe(input)
  }
  const enabledAgain = new RedactionScope(rules, caller)
  expect(enabledAgain.maskText(input)).toBe(initial.maskText(input))
})

test("signed blocks replay exact upstream text, not newly applied rules, including cross-wire aliases", () => {
  const caller = randomUUID()
  const scope = new RedactionScope(config, caller)
  const text = scope.maskText("Inspect /home/alice/project")
  const original = { type: "thinking", thinking: text, signature: sign(text) }
  const visible = scope.restore(original, "issuer")
  expect(visible.thinking).toBe("Inspect /home/alice/project")
  const next = new RedactionScope({ ...config, homePaths: false }, caller)
  const replay = next.mask(visible, "issuer")
  expect(replay).toEqual(original)
  expect(sign(replay.thinking)).toBe(replay.signature)
  const chat = next.mask(
    {
      role: "assistant",
      reasoning_content: visible.thinking,
      signature: visible.signature,
    },
    "issuer",
  )
  expect(chat.reasoning_content).toBe(original.thinking)
  expect(() =>
    next.mask({ ...visible, thinking: visible.thinking + " edited" }, "issuer"),
  ).toThrow("edited")
  expect(() => next.mask(visible, "another-issuer")).toThrow(
    "different upstream",
  )
  expect(() => createScope().mask(visible, "issuer")).toThrow("unavailable")
})

test("signed Gemini function arguments restore for execution and replay unchanged", () => {
  const scope = createScope()
  const args = scope.mask({
    path: "/Users/jane/work",
    password: "sk-sensitivevalue123456",
  })
  const original = {
    functionCall: { name: "read_file", args },
    thoughtSignature: sign(JSON.stringify(args)),
  }
  const visible = scope.restore(original, "issuer")
  expect(visible.functionCall.args.path).toBe("/Users/jane/work")
  const replay = scope.mask(visible, "issuer")
  expect(replay).toEqual(original)
  expect(sign(JSON.stringify(replay.functionCall.args))).toBe(
    replay.thoughtSignature,
  )
})

async function* frames(packets: Array<unknown>) {
  for (const packet of packets) yield { data: JSON.stringify(packet) }
}

async function collect(
  packets: Array<unknown>,
  scope: RedactionScope,
): Promise<Array<Record<string, unknown>>> {
  const result = []
  for await (const event of restoreRedactionStream(
    frames(packets),
    scope,
    "issuer",
  )) {
    result.push(
      JSON.parse((event as { data: string }).data) as Record<string, unknown>,
    )
  }
  return result
}

test("separate signed Chat reasoning details survive streaming and cross-wire replay", async () => {
  const scope = createScope()
  const raw = [
    scope.maskText("first /home/alice/project"),
    scope.maskText("second /Users/jane/work"),
  ]
  const signatures = raw.map(sign)
  const original = {
    role: "assistant",
    reasoning_content: raw.join("\n\n"),
    signature: signatures[0],
    reasoning_details: raw.map((text, index) => ({
      type: "reasoning.text",
      text,
      signature: signatures[index],
    })),
  }
  const visible = scope.restore(original, "issuer")
  expect(visible.reasoning_details.map((detail) => detail.text)).toEqual([
    "first /home/alice/project",
    "second /Users/jane/work",
  ])
  expect(scope.mask(visible, "issuer")).toEqual(original)
  const packets = await collect(
    [
      {
        choices: [
          {
            index: 1,
            delta: {
              reasoning_details: raw.map((text, index) => ({
                index,
                type: "reasoning.text",
                text: text.slice(0, 18),
              })),
            },
          },
        ],
      },
      {
        choices: [
          {
            index: 1,
            delta: {
              reasoning_details: raw.map((text, index) => ({
                index,
                type: "reasoning.text",
                text: text.slice(18),
                signature: signatures[index],
              })),
            },
            finish_reason: "stop",
          },
        ],
      },
    ],
    scope,
  )
  const restored = ["", ""]
  for (const packet of packets) {
    const choices = packet.choices as Array<{
      delta: { reasoning_details: Array<{ index: number; text: string }> }
    }>
    for (const detail of choices[0].delta.reasoning_details)
      restored[detail.index] += detail.text
  }
  expect(restored).toEqual([
    "first /home/alice/project",
    "second /Users/jane/work",
  ])
  const aliases = await collect(
    [
      {
        choices: [
          {
            index: 0,
            delta: {
              reasoning_text: raw[0].slice(0, 16),
              reasoning_content: raw[0].slice(0, 16),
            },
          },
        ],
      },
      {
        choices: [
          {
            index: 0,
            delta: {
              reasoning_text: raw[0].slice(16),
              reasoning_content: raw[0].slice(16),
              signature: signatures[0],
            },
            finish_reason: "stop",
          },
        ],
      },
    ],
    scope,
  )
  for (const key of ["reasoning_text", "reasoning_content"]) {
    const text = aliases
      .map(
        (packet) =>
          (packet.choices as Array<{ delta: Record<string, string> }>)[0].delta[
            key
          ] ?? "",
      )
      .join("")
    expect(text).toBe("first /home/alice/project")
  }
  for (const [index, thinking] of restored.entries()) {
    const replay = scope.mask(
      { type: "thinking", thinking, signature: signatures[index] },
      "issuer",
    )
    expect(replay.thinking).toBe(raw[index])
    expect(sign(replay.thinking)).toBe(replay.signature)
  }
})

test("restores every placeholder split position in chat and JSON argument streams", async () => {
  const scope = createScope()
  const value = 'C:\\Users\\Alice\\a"quoted'
  const token = scope.maskText("C:\\Users\\Alice")
  for (let split = 1; split < token.length; split++) {
    const packets = await collect(
      [
        {
          choices: [
            {
              index: 0,
              delta: {
                content: "left " + token.slice(0, split),
                tool_calls: [
                  {
                    index: 3,
                    function: {
                      arguments: '{"path":"' + token.slice(0, split),
                    },
                  },
                ],
              },
            },
          ],
        },
        {
          choices: [
            {
              index: 0,
              delta: {
                content: token.slice(split) + " right",
                tool_calls: [
                  {
                    index: 3,
                    function: {
                      arguments: token.slice(split) + '\\\\a\\"quoted"}',
                    },
                  },
                ],
              },
            },
          ],
        },
        { choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
      ],
      scope,
    )
    const choices = packets.flatMap(
      (packet) =>
        packet.choices as Array<{
          delta: {
            content?: string
            tool_calls?: Array<{ function: { arguments: string } }>
          }
        }>,
    )
    expect(choices.map((choice) => choice.delta.content ?? "").join("")).toBe(
      "left C:\\Users\\Alice right",
    )
    const json = choices
      .flatMap((choice) => choice.delta.tool_calls ?? [])
      .map((call) => call.function.arguments)
      .join("")
    expect(JSON.parse(json)).toEqual({ path: value })
    for (const wire of ["legacy-chat", "messages", "responses"]) {
      const chunks = [
        '{"path":"' + token.slice(0, split),
        token.slice(split) + '\\\\a\\"quoted"}',
      ]
      const frames = chunks.map((argumentsChunk) =>
        wire === "legacy-chat" ?
          {
            choices: [
              {
                index: 0,
                delta: { function_call: { arguments: argumentsChunk } },
              },
            ],
          }
        : wire === "messages" ?
          {
            type: "content_block_delta",
            index: 0,
            delta: { type: "input_json_delta", partial_json: argumentsChunk },
          }
        : {
            type: "response.function_call_arguments.delta",
            item_id: "tool",
            delta: argumentsChunk,
          },
      )
      const restored = await collect(frames, scope)
      const json = restored
        .map((packet) =>
          wire === "legacy-chat" ?
            (
              packet.choices as Array<{
                delta: { function_call: { arguments: string } }
              }>
            )[0].delta.function_call.arguments
          : wire === "messages" ?
            (packet.delta as { partial_json: string }).partial_json
          : (packet.delta as string),
        )
        .join("")
      expect(JSON.parse(json)).toEqual({ path: value })
    }
  }
})

test("Anthropic streaming thinking is readable and can round-trip with fragmented signatures", async () => {
  const scope = createScope()
  const raw = scope.maskText("check /home/alice/project")
  const signature = sign(raw)
  const packets = await collect(
    [
      {
        type: "content_block_start",
        index: 2,
        content_block: { type: "thinking", thinking: "" },
      },
      {
        type: "content_block_delta",
        index: 2,
        delta: { type: "thinking_delta", thinking: raw.slice(0, 15) },
      },
      {
        type: "content_block_delta",
        index: 2,
        delta: { type: "thinking_delta", thinking: raw.slice(15) },
      },
      {
        type: "content_block_delta",
        index: 2,
        delta: { type: "signature_delta", signature: signature.slice(0, 25) },
      },
      {
        type: "content_block_delta",
        index: 2,
        delta: { type: "signature_delta", signature: signature.slice(25) },
      },
      { type: "content_block_stop", index: 2 },
    ],
    scope,
  )
  const thinking = packets
    .map((packet) => (packet.delta as { thinking?: string })?.thinking ?? "")
    .join("")
  expect(thinking).toBe("check /home/alice/project")
  const replay = scope.mask({ type: "thinking", thinking, signature }, "issuer")
  expect(replay.thinking).toBe(raw)
  expect(sign(replay.thinking)).toBe(signature)
})

test("Responses deltas, final snapshots and Gemini signed thinking agree", async () => {
  const scope = createScope()
  const token = scope.maskText("/home/alice")
  const packets = await collect(
    [
      {
        type: "response.output_text.delta",
        item_id: "item",
        delta: token.slice(0, 12),
      },
      {
        type: "response.output_text.delta",
        item_id: "item",
        delta: token.slice(12),
      },
      { type: "response.output_text.done", item_id: "item", text: token },
    ],
    scope,
  )
  expect(
    packets
      .slice(0, 2)
      .map((packet) => packet.delta)
      .join(""),
  ).toBe("/home/alice")
  expect(packets[2].text).toBe("/home/alice")
  const signature = sign(token)
  const gemini = await collect(
    [
      {
        candidates: [
          {
            index: 0,
            content: { parts: [{ thought: true, text: token.slice(0, 9) }] },
          },
        ],
      },
      {
        candidates: [
          {
            index: 0,
            content: {
              parts: [
                {
                  thought: true,
                  text: token.slice(9),
                  thoughtSignature: signature,
                },
              ],
            },
            finishReason: "STOP",
          },
        ],
      },
    ],
    scope,
  )
  const text = gemini
    .map(
      (packet) =>
        (
          packet.candidates as Array<{
            content: { parts: Array<{ text: string }> }
          }>
        )[0].content.parts[0].text,
    )
    .join("")
  expect(text).toBe("/home/alice")
  expect(
    scope.mask({ thought: true, text, thoughtSignature: signature }, "issuer")
      .text,
  ).toBe(token)
})

test("disabled calls are untouched; enabled async egress uses one isolated context and restores the response", async () => {
  const payload = { input: "/home/alice/work", model: "model" }
  const unchanged = await runRedactedCall(
    payload,
    undefined,
    async (value) => ({ accountId: "issuer", response: value }),
  )
  expect(unchanged.response).toBe(payload)
  process.env.UPSTREAM_REDACTION = '{"enabled":true}'
  let sent = ""
  const app = new Hono()
  app.post("/", async (c) => {
    c.set("userId", "integration-user")
    const result = await runRedactedCall(payload, c, async (value) => {
      await Promise.resolve()
      sent = serializeUpstreamBody({
        ...value,
        injected: "/Users/server-owner/code",
      })
      return {
        accountId: "issuer",
        response: JSON.parse(sent) as typeof payload,
      }
    })
    return c.json(result.response)
  })
  const response = await app.request("/", { method: "POST" })
  expect(response.status).toBe(200)
  expect(sent).not.toContain("alice")
  expect(sent).not.toContain("server-owner")
  expect(await response.json()).toEqual({
    ...payload,
    injected: "/Users/server-owner/code",
  })
  expect(maskUpstream(payload)).toBe(payload)
})

test("chained Responses inherit only their caller's previous response mappings, including streamed completion", async () => {
  process.env.UPSTREAM_REDACTION = '{"enabled":true}'
  const original = ["", "home", "chain-fixture", "project"].join("/")
  for (const streaming of [false, true]) {
    const caller = randomUUID()
    const responseId = randomUUID()
    let upstreamPath = ""
    const app = new Hono()
    app.onError((error, c) => c.json({ error: error.message }, 422))
    app.post("/:caller", async (c) => {
      c.set("userId", c.req.param("caller"))
      const payload = await c.req.json<{
        input: string
        previous_response_id?: string
      }>()
      const result = await runRedactedCall(payload, c, async (masked) => {
        if (!masked.previous_response_id) upstreamPath = masked.input
        const response = {
          id: masked.previous_response_id ? randomUUID() : responseId,
          object: "response",
          output: [
            {
              type: "function_call",
              arguments: JSON.stringify({ command: `cd ${upstreamPath}` }),
            },
          ],
        }
        return {
          accountId: "issuer",
          response:
            streaming ?
              frames([{ type: "response.completed", response }])
            : response,
        }
      })
      if (streaming) {
        const output = []
        for await (const frame of result.response as AsyncIterable<{
          data: string
        }>)
          output.push(JSON.parse(frame.data))
        return c.json(output)
      }
      return c.json(result.response)
    })
    const send = (user: string, input: string, previous_response_id?: string) =>
      app.request(`/${user}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ input, previous_response_id }),
      })
    const first = await send(caller, original)
    expect(first.status).toBe(200)
    expect(await first.text()).not.toContain("{{HOME_")
    expect(upstreamPath).toContain("{{HOME_")
    const next = await send(
      caller,
      "Continue using the previous directory",
      responseId,
    )
    expect(next.status).toBe(200)
    type ResponseBody = {
      id: string
      output: Array<{ arguments: string }>
    }
    const visible: unknown = await next.json()
    const response =
      streaming ?
        (visible as Array<{ response: ResponseBody }>)[0].response
      : (visible as ResponseBody)
    expect(JSON.parse(response.output[0].arguments)).toEqual({
      command: `cd ${original}`,
    })
    const third = await send(caller, "Continue again", response.id)
    expect(third.status).toBe(200)
    expect(await third.text()).not.toContain("{{HOME_")
    const other = await send(randomUUID(), "Continue", responseId)
    expect(other.status).toBe(200)
    const otherBody = await other.text()
    expect(otherBody).toContain(upstreamPath)
    expect(otherBody).not.toContain(original)
  }
})

test("redaction settings persist and survive unrelated admin updates", () => {
  let saved = ""
  initializeSystemConfig({
    save: (value) => {
      saved = value
    },
    onChange: () => {},
  })
  const settings = {
    logLevel: "info",
    requestDump: false,
    memoryVerbose: false,
    performanceDetails: true,
    debugMinutes: 15,
  }
  updateSystemConfig({
    ...settings,
    redaction: { enabled: true, words: ["InternalProject"] },
  })
  updateSystemConfig(settings)
  initializeSystemConfig({ value: saved, save: () => {}, onChange: () => {} })
  expect(
    (JSON.parse(saved) as { settings: { redaction: { enabled: boolean } } })
      .settings.redaction.enabled,
  ).toBe(true)
})

test("media references remain opaque while text and media-shaped tool arguments are redacted", () => {
  const scope = new RedactionScope(
    redactionConfigSchema.parse({ enabled: true, words: ["image", "private"] }),
    randomUUID(),
  )
  const url = "data:image/png;base64,cHJpdmF0ZQ=="
  const remote = "https://example.test/private/image.png"
  const media = [
    { type: "image_url", image_url: { url } },
    { type: "input_image", image_url: url },
    { type: "image", source: { type: "url", url: remote } },
    {
      type: "image",
      source: { type: "base64", media_type: "image/png", data: "private" },
    },
    { inlineData: { mimeType: "image/png", data: "private" } },
    { fileData: { mimeType: "image/png", fileUri: remote } },
    { file_data: { mime_type: "image/png", file_uri: remote } },
    { type: "input_file", file_url: remote },
    { type: "file", file: { file_data: url, filename: "private.png" } },
    { type: "video_url", video_url: { url: remote } },
    { type: "input_audio", input_audio: { data: "private", format: "wav" } },
  ]
  expect(scope.mask(media)).toEqual(media)
  const tool = {
    type: "tool_use",
    input: { type: "image_url", image_url: { url: remote } },
  }
  expect(JSON.stringify(scope.mask(tool))).not.toContain("private")
  expect(scope.restore(scope.mask(tool), "issuer")).toEqual(tool)
  expect(scope.mask({ type: "text", text: remote }).text).not.toContain(
    "private",
  )
})

test("tool data named arguments is a plain value, not another protocol JSON layer", () => {
  const scope = createScope()
  const path = ["C:", "Users", "audit-user", 'a"quoted'].join("\\")
  const input = {
    arguments: path,
    partial_json: path,
    name: path,
    signature: path,
  }
  const calls = [
    { type: "tool_use", input },
    { type: "function_call", arguments: JSON.stringify(input) },
    { functionCall: { name: "read", args: input } },
  ]
  for (const call of calls) {
    const masked = scope.mask(call)
    expect(JSON.stringify(masked)).not.toContain("audit-user")
    expect(scope.restore(masked, "issuer")).toEqual(call)
  }
  const unknown = `{{HOME_${"a".repeat(32)}}}`
  const result = {
    functionResponse: {
      name: "read",
      response: { arguments: unknown, name: path },
    },
  }
  const masked = scope.mask(result)
  expect(masked.functionResponse.name).toBe("read")
  expect(masked.functionResponse.response.name).not.toContain("audit-user")
  expect(scope.restore(masked, "issuer")).toEqual(result)
})

test("signed detail aliases do not seal the aggregate with a single block signature", () => {
  for (const field of [
    "signature",
    "reasoning_opaque",
    "thinking_signature",
    "reasoning_signature",
  ]) {
    const scope = createScope()
    const paths = ["first-detail-user", "second-detail-user"].map((user) =>
      ["", "home", user].join("/"),
    )
    const tokens = paths.map((path) => scope.maskText(path))
    const original = {
      role: "assistant",
      reasoning_content: tokens.join("\n\n"),
      signature: sign(tokens[0]),
      reasoning_details: tokens.map((text) => ({
        type: "reasoning.text",
        text,
        [field]: sign(text),
      })),
    }
    const visible = scope.restore(original, "issuer")
    expect(visible.reasoning_content).toBe(paths.join("\n\n"))
    expect(scope.mask(visible, "issuer")).toEqual(original)
    for (const [index, detail] of visible.reasoning_details.entries())
      expect(scope.mask(detail, "issuer")).toEqual(
        original.reasoning_details[index],
      )
  }
})

test("signed reasoning aliases replay exact bytes even with empty alternate aliases", () => {
  const path = ["", "home", "alias-user"].join("/")
  for (const field of [
    "reasoning_text",
    "reasoning_content",
    "reasoning",
    "thinking",
  ])
    for (const signatureField of [
      "signature",
      "reasoning_opaque",
      "thinking_signature",
      "reasoning_signature",
    ]) {
      const scope = createScope()
      const raw = scope.maskText(path)
      const signature = sign(raw)
      const original: Record<string, string> = {
        role: "assistant",
        [field]: raw,
        [signatureField]: signature,
      }
      const visible = scope.restore(original, "issuer")
      expect(visible[field]).toBe(path)
      expect(visible[signatureField]).toBe(signature)
      expect(
        scope.mask<Record<string, string>>(
          {
            ...visible,
            signature: signatureField === "signature" ? signature : "",
          },
          "issuer",
        )[field],
      ).toBe(raw)
      expect(() => scope.mask(visible, "other-issuer")).toThrow(
        "different upstream",
      )
    }
})

test("a placeholder inside a credential does not exempt surrounding secret text", () => {
  const scope = createScope()
  const home = ["", "home", "credential-user"].join("/")
  const token = scope.maskText(home)
  const payload = { password: `prefix123${token}suffix456` }
  const masked = scope.mask(payload)
  expect(masked.password).not.toContain("prefix123")
  expect(masked.password).not.toContain("suffix456")
  expect(masked.password).toContain(token)
  expect(scope.mask(masked)).toEqual(masked)
  expect(scope.restore(masked, "issuer").password).toBe(
    `prefix123${home}suffix456`,
  )
})

test("a stream stopped right after its closing frame is completed, not cancelled", async () => {
  process.env.UPSTREAM_REDACTION = '{"enabled":true}'
  initializeSystemConfig({ save: () => {}, onChange: () => {} })
  // OpenAI clients break on [DONE]; Anthropic ones stop after message_stop.
  for (const closing of ["[DONE]", JSON.stringify({ type: "message_stop" })]) {
    const result = await runRedactedCall(
      { text: "hello" },
      undefined,
      async () => ({
        response: (async function* () {
          yield { choices: [{ index: 0, delta: { content: "first" } }] }
          yield { data: closing }
        })(),
      }),
    )
    const iterator = result.response[Symbol.asyncIterator]()
    await iterator.next()
    const last = await iterator.next()
    expect(last.value).toEqual({ data: closing })
    await iterator.return?.()
    expect(getRedactionDiagnostics().entries[0].status).toBe("completed")
  }
})
