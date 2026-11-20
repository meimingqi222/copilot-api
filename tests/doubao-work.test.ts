import { describe, expect, test } from "bun:test"
import { runInNewContext } from "node:vm"

import { LocalUnavailableError } from "~/lib/error"
import {
  managedConnectionFromInput,
  serializeConnectionForExport,
} from "~/lib/provider-connections"
import { hasEnabledCredential } from "~/lib/provider-connections/anonymous-credential"
import { buildRouteTargets } from "~/lib/route-target/build"
import { DoubaoWorkBridge } from "~/services/doubao-work/bridge"
import {
  effortLabel,
  modelsFromBriefList,
  quotaSnapshot,
  workModelMappings,
} from "~/services/doubao-work/catalog"
import {
  chatResult,
  streamChat,
  workOutput,
  workPrompt,
} from "~/services/doubao-work/chat"
import type {
  DesktopBinding,
  DesktopHost,
} from "~/services/doubao-work/desktop"
import {
  briefList,
  fillPrompt,
  newTask,
  pageState,
  readQuota,
  readReply,
  selectCloud,
  selectModel,
  sendPrompt,
} from "~/services/doubao-work/page"
import type { ChatCompletionsPayload } from "~/services/protocols/chat/types"
import { getBuiltinProviderModule } from "~/services/providers/builtins"
import { getDoubaoWorkModule } from "~/services/providers/modules/doubao-work"

const modelList = {
  mode_list: {
    item_list: [
      { mode_id: "1", model_list: { item_list: [{ name: "专家" }] } },
      {
        mode_id: "3",
        model_list: {
          item_list: [
            { name: "自动", model_item_key: "9" },
            { name: "Kimi K3.1 Pro", model_item_key: "slow" },
            {
              name: "Kimi K3.1 Pro 高速",
              model_item_key: "native-fast",
              reasoning_effort_config: {
                option_list: [
                  { level: 1, name: "低" },
                  { level: 5, name: "高" },
                ],
                default_level: 1,
              },
            },
            { name: "Model 实验" },
            { name: "Model 另一种" },
          ],
        },
      },
    ],
  },
}

function desktopFixture() {
  const id = "293aa077-059b-4b95-832b-ab2465f70998"
  const calls: Array<string> = []
  const openings: Array<{ id: string; launch: boolean }> = []
  const closed: Array<string> = []
  const binding = new Map<string, DesktopBinding>()
  const control = { account: "", cloud: true, open: false, send: true }
  const host: DesktopHost = {
    async newProfile() {
      return id
    },
    async closePendingProfile(id) {
      closed.push(id)
      control.open = false
    },
    async open(id, launch) {
      openings.push({ id, launch })
      if (launch) control.open = true
      if (!control.open) return undefined
      return {
        async eval(expression, signal) {
          signal?.throwIfAborted()
          calls.push(expression)
          if (expression === pageState) return { name: control.account }
          if (expression === briefList) return modelList
          if (expression === newTask) return true
          if (expression === selectCloud) return control.cloud
          if (expression === readQuota)
            return {
              data: {
                window_limit_section: {
                  window_limit_groups: [
                    { window_limits: [{ used_percent: 30 }] },
                  ],
                },
              },
            }
          if (expression === selectModel("自动")) return "selected"
          if (expression.includes("const paragraphs")) return true
          if (expression.includes("button.click();")) return control.send
          if (expression.includes("const expected"))
            return {
              sends: 1,
              id: "reply-1",
              text: "hello",
              reasoning: "thought",
              finished: true,
            }
          throw new Error("Unexpected desktop operation")
        },
        async reload() {
          throw new Error("Unexpected reload")
        },
        close() {},
      }
    },
    async loadBinding(id) {
      return binding.get(id)
    },
    async saveBinding(id, value) {
      binding.set(id, value)
    },
  }
  return {
    id,
    host,
    binding,
    control,
    calls,
    openings,
    closed,
    bridge: new DoubaoWorkBridge(host, 1),
  }
}

test("the paused Doubao Work module preserves saved models but cannot sign in or route", async () => {
  const module = getBuiltinProviderModule("doubao-work")!
  const connection = managedConnectionFromInput({
    id: "saved-doubao-work",
    name: "Saved Doubao Work",
    provider: "doubao-work",
    credentials: { desktopBinding: "saved-fixture" },
  })
  expect(connection.enabled).toBe(true)
  expect(
    await module.accountCreation!.prepare({
      body: {
        provider: "doubao-work",
        credentials: { desktopAction: "start" },
      },
      label: "Paused",
      registerDeviceFlow() {},
    }),
  ).toEqual({ error: "Doubao Work is temporarily disabled." })
  expect(module.adapter.createChatCompletions).toBeUndefined()
  expect(module.createRuntime().refreshQuota).toBeUndefined()

  for (const models of [
    undefined,
    workModelMappings([{ id: "auto", label: "Auto" }]),
  ]) {
    connection.models = models
    expect(hasEnabledCredential(connection)).toBe(false)
    expect(
      buildRouteTargets({
        connections: [connection],
        publicModelId: "auto",
        onlyAvailable: false,
      }),
    ).toEqual([])
    expect(await module.createRuntime().refreshModels(connection)).toEqual(
      models ?? [],
    )
  }
})

describe("Doubao Work local provider", () => {
  test("requires start, manual sign-in and explicit confirmation; cancellation is nonce-bound", async () => {
    const fixture = desktopFixture()
    const module = getDoubaoWorkModule(fixture.bridge)
    const prepare = (credentials: Record<string, unknown>) =>
      module.accountCreation!.prepare({
        body: { provider: "doubao-work", credentials },
        label: "Work",
        registerDeviceFlow() {},
      })
    expect(await prepare({ desktopBinding: "replace-this" })).toHaveProperty(
      "error",
    )
    expect(fixture.openings).toHaveLength(0)
    const start = await prepare({ desktopAction: "start" })
    if (!("response" in start)) throw new Error("Expected pending sign-in")
    expect(start.response.status).toBe("awaiting_desktop_sign_in")
    const nonce = start.response.nonce
    expect(
      await prepare({ desktopAction: "confirm", desktopNonce: nonce }),
    ).toHaveProperty("error")
    expect(fixture.binding.size).toBe(0)
    expect(
      await prepare({ desktopAction: "cancel", desktopNonce: "stale" }),
    ).toEqual({ response: { status: "cancelled" } })
    expect(fixture.closed).toEqual([])
    expect(
      await prepare({ desktopAction: "cancel", desktopNonce: nonce }),
    ).toEqual({ response: { status: "cancelled" } })
    expect(fixture.closed).toEqual([fixture.id])
    fixture.control.account = "Fixture user"
    expect(
      await prepare({ desktopAction: "confirm", desktopNonce: nonce }),
    ).toHaveProperty("error")
    const restart = await prepare({ desktopAction: "start" })
    if (!("response" in restart)) throw new Error("Expected new sign-in")
    const input = await prepare({
      desktopAction: "confirm",
      desktopNonce: restart.response.nonce,
    })
    if (!("id" in input)) throw new Error("Expected connection input")
    const connection = managedConnectionFromInput(input)
    expect(connection.protocol).toBe("doubao-work-native")
    const binding = connection.credentials[0]?.value
    const persisted = fixture.binding.get(fixture.id)?.secret
    if (!binding || !persisted)
      throw new Error("Expected a local desktop binding")
    expect(binding).toBe(persisted)
    expect(
      JSON.stringify(serializeConnectionForExport(connection)),
    ).not.toContain(binding)
    await prepare({
      desktopAction: "cancel",
      desktopNonce: restart.response.nonce,
    })
    expect(fixture.closed).toEqual([fixture.id])
    expect(module.createRuntime().adapter).toBe(module.adapter)
    expect(getDoubaoWorkModule().createRuntime().adapter).toBe(
      getDoubaoWorkModule().adapter,
    )
  })

  test("unbound requests cannot launch; read-only operations never launch; cloud failure never fills", async () => {
    const fixture = desktopFixture()
    const request = {
      id: fixture.id,
      secret: "invalid",
      model: "auto",
      prompt: "hello",
      effort: undefined,
    }
    await expect(fixture.bridge.ask(request)).rejects.toThrow(
      "Explicitly connect",
    )
    expect(fixture.openings).toEqual([])
    fixture.binding.set(fixture.id, {
      secret: "valid",
      account: "Fixture user",
    })
    request.secret = "valid"
    expect(await fixture.bridge.quota(request)).toBeUndefined()
    expect(await fixture.bridge.refreshModels(request)).toBeUndefined()
    expect(fixture.openings.map((value) => value.launch)).toEqual([
      false,
      false,
    ])
    fixture.control.account = "Unrelated user"
    await expect(fixture.bridge.ask(request)).rejects.toThrow("not signed in")
    expect(fixture.calls).toEqual([pageState])
    fixture.control.account = "Fixture user"
    fixture.control.cloud = false
    await expect(fixture.bridge.ask(request)).rejects.toThrow("cloud mode")
    expect(fixture.calls.slice(-3)).toEqual([pageState, newTask, selectCloud])
    expect(
      fixture.calls.some(
        (value) =>
          value.includes("const paragraphs")
          || value.includes("button.click();"),
      ),
    ).toBe(false)
    fixture.control.cloud = true
    fixture.control.send = false
    await expect(fixture.bridge.ask(request)).rejects.toBeInstanceOf(
      LocalUnavailableError,
    )
    expect(
      fixture.calls.some((value) => value.includes("const expected")),
    ).toBe(false)
    fixture.control.send = true
    expect(await fixture.bridge.ask(request)).toMatchObject({
      text: "hello",
      reasoning: "thought",
    })
    expect(
      (await fixture.bridge.quota(request))?.allowance.windows,
    ).toMatchObject([{ used: 0.3 }])
  })

  test("uses Work catalog, exposes keys and effort levels, and does not invent quota", () => {
    const models = modelsFromBriefList(modelList)
    expect(models.map((model) => model.id)).toEqual([
      "auto",
      "kimi-k3.1-pro",
      "kimi-k3.1-pro-fast",
      "model",
      "model-2",
    ])
    const fast = models[2]
    expect(workModelMappings([fast])[0]).toMatchObject({
      aliases: ["Kimi K3.1 Pro 高速", "native-fast"],
      efforts: ["low", "high"],
      endpoints: ["chat"],
    })
    expect(effortLabel(fast, "medium")).toBe("高")
    expect(effortLabel(fast, undefined)).toBe("低")
    expect(quotaSnapshot({ data: {} })?.allowance).toEqual({
      state: "unknown",
      windows: [],
    })
    const quota = quotaSnapshot({
      data: {
        window_limit_section: {
          window_limit_groups: [
            {
              window_limits: [
                {
                  start_time: 1800000000000,
                  end_time: 1800018000000,
                  used_percent: "12.5",
                },
                { used_percent: null },
              ],
            },
          ],
        },
      },
    })
    expect(quota?.allowance).toEqual({
      state: "known",
      windows: [
        expect.objectContaining({
          used: 0.125,
          spanMs: 18_000_000,
          resetsAtMs: 1800018000000,
        }),
      ],
    })
  })
})

describe("Doubao Work page guards", () => {
  test("rechecks actual page, bound account, selected mode, model and draft in the send expression", async () => {
    let clicks = 0
    let dismisses = 0
    const mode = { innerText: "本地电脑" }
    const model = { innerText: "自动\n中" }
    const account = { innerText: "Fixture user", querySelectorAll: () => [] }
    const send = { click: () => clicks++, getAttribute: () => null }
    const editor = { getText: () => "one\n\ntwo" }
    const document = {
      querySelector: (selector: string) =>
        ({
          "[data-testid=chat_input_action_mode]": mode,
          "[data-testid=chat_input_action_model]": model,
          "[data-testid=sidebar_bottom]": account,
          "[data-testid=chat_input_send_button]": send,
          ".ProseMirror": { editor },
        })[selector as never],
      querySelectorAll: () => [],
      body: { dispatchEvent: () => dismisses++ },
    }
    const location = {
      href: "chrome://doubaowork-chat/chat",
      pathname: "/chat",
    }
    const run = (expression: string) =>
      runInNewContext(expression, { document, location }) as Promise<unknown>
    const sendExpression = sendPrompt(
      "one\n\ntwo",
      "Fixture user",
      "自动",
      "中",
    )
    expect(await run(fillPrompt("outside cloud", "Fixture user"))).toBe(false)
    expect(dismisses).toBe(0)
    expect(await run(sendExpression)).toBe(false)
    mode.innerText = "云电脑"
    expect(await run(sendExpression)).toBe(true)
    mode.innerText = "云电脑 / 本地电脑"
    expect(await run(sendExpression)).toBe(false)
    mode.innerText = "云电脑"
    account.innerText = "Other user"
    expect(await run(sendExpression)).toBe(false)
    account.innerText = "Fixture user"
    model.innerText = "自动\n高"
    expect(await run(sendExpression)).toBe(false)
    location.href = "https://www.doubao.com/chat"
    await expect(run(sendExpression)).rejects.toThrow(
      "Not a Doubao desktop chat page",
    )
    expect(clicks).toBe(1)
  })

  test("reads raw text and thinking only when the visible task echoes this prompt", async () => {
    const sent = { innerText: "one\n\ntwo" }
    const reply = {
      __reactFiberFixture: {
        memoizedProps: {
          message: {
            message_id: "123",
            content_blocks_v2: [
              { block_type: 10040, block_id: "think" },
              {
                block_type: 10000,
                parent_id: "think",
                content: { text_block: { text: "why" } },
              },
              {
                block_type: 10000,
                content: { text_block: { text: "**hi**" } },
              },
            ],
            ext: { is_finish: "1", context_window_usage: '{"messages":4}' },
          },
        },
      },
    }
    const run = (prompt: string) =>
      runInNewContext(readReply(prompt, "Fixture user"), {
        document: {
          querySelector: () => ({
            innerText: "Fixture user",
            querySelectorAll: () => [],
          }),
          querySelectorAll: (selector: string) =>
            selector.includes("send") ? [sent] : [reply],
        },
        location: {
          href: "chrome://doubaowork-chat/chat/123",
          pathname: "/chat/123",
        },
      }) as Promise<unknown>
    expect(await run("one\n\ntwo")).toEqual({
      sends: 1,
      id: "123",
      text: "**hi**",
      reasoning: "why",
      finished: true,
      failed: false,
      usage: '{"messages":4}',
    })
    expect(await run("different task")).toEqual({ sends: 1, mismatched: true })
  })
})

describe("Doubao Work Chat wire", () => {
  const payload: ChatCompletionsPayload = {
    model: "auto",
    messages: [
      { role: "system", content: "Instructions" },
      {
        role: "user",
        content: [
          { type: "text", text: "Read this" },
          {
            type: "image_url",
            image_url: { url: "https://example.test/private" },
          },
        ],
      },
    ],
    tools: [{ type: "function", function: { name: "lookup", parameters: {} } }],
  }

  test("ordinary and incremental completions lift declared calls without emitting marker fragments", async () => {
    const prompt = workPrompt(payload)
    expect(prompt.text).toContain("[image omitted: text only]")
    expect(prompt.text).not.toContain("example.test")
    const tagged =
      'Before\n<tool_call>{"name":"lookup","arguments":{"n":1}}</tool_call>'
    const final = {
      text: tagged,
      reasoning: "Think",
      usage: { messages: 7, system_prompt: 3 },
    }
    const result = chatResult("auto", prompt, final)
    expect(result.choices[0]).toMatchObject({
      finish_reason: "tool_calls",
      message: {
        content: "Before\n",
        reasoning_content: "Think",
        tool_calls: [{ function: { name: "lookup", arguments: '{"n":1}' } }],
      },
    })
    expect(result.usage?.prompt_tokens).toBe(10)
    const streamed = await streamChat("auto", prompt, async (update) => {
      update({ ...final, text: "Before\n<tool_", reasoning: "Th" })
      update(final)
      return final
    })
    const events = await Array.fromAsync(streamed)
    expect(events.at(-1)?.data).toBe("[DONE]")
    expect(JSON.stringify(events)).not.toContain("<tool_")
    expect(events.map((event) => event.data).join()).toContain(
      '"finish_reason":"tool_calls"',
    )
    expect(
      workOutput(
        '{"tool_calls":[{"function":{"name":"lookup","arguments":"{\\"n\\":1}"}}]}',
        prompt.toolNames,
      ).calls,
    ).toHaveLength(1)
    expect(
      workOutput(tagged.replace("lookup", "unknown"), prompt.toolNames).calls,
    ).toEqual([])
    expect(
      workOutput(
        tagged,
        workPrompt({ ...payload, tool_choice: "none" }).toolNames,
      ).text,
    ).toBe(tagged)
  })

  test("rejects before opening the stream if cloud verification or launch fails", async () => {
    await expect(
      streamChat("auto", workPrompt(payload), async () => {
        throw new Error("fixture cloud verification failure")
      }),
    ).rejects.toThrow("fixture cloud verification failure")
  })
})
