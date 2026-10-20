import { afterEach, expect, test } from "bun:test"

import {
  __resetTraeCnFunctionStateForTest,
  traeCnFunctionOrder,
  traeCnListModels,
} from "~/services/trae-cn/client"

afterEach(__resetTraeCnFunctionStateForTest)

function model(id: string, name: string, output = 16000) {
  return {
    config_name: id,
    usage: "chat_completion",
    config_switch: true,
    display_config: { display_name: name },
    model_detail_list: [{ model_name: `${id}__dev`, max_tokens: output }],
  }
}

test("TRAE agent metadata wins when the same model has dev entries in multiple modes", async () => {
  const id = "deepseek-v4.1-flash"
  const models = await traeCnListModels(
    async () => ({
      status: 200,
      text: "",
      v: {
        function_configs: [
          {
            function: "chat_v3",
            config_info_list: [model(id, "DeepSeek-V4-Flash 正式版")],
          },
          {
            function: "solo_agent",
            config_info_list: [
              {
                ...model(id, "DeepSeek-V4.1-Flash", 64000),
                context_window_tokens: { dev: 200000 },
              },
            ],
          },
          {
            function: "solo_agent_lite",
            config_info_list: [model(id, "DeepSeek-V4-Flash 正式版")],
          },
        ],
      },
    }),
    "https://models.example",
    "account",
  )

  expect(models).toEqual([
    { id, name: "DeepSeek-V4.1-Flash", context: 200000, output: 64000 },
  ])
  expect(traeCnFunctionOrder("account", id)[0]).toEqual({
    fn: "solo_agent",
    modelName: `${id}__dev`,
  })
})

test("different upstream IDs remain separate even when their display names match", async () => {
  const models = await traeCnListModels(
    async () => ({
      status: 200,
      text: "",
      v: {
        function_configs: [
          {
            function: "chat_v3",
            config_info_list: [
              model("deepseek-v4.1-flash", "DeepSeek-V4-Flash 正式版"),
              model("DeepSeek-V4-Flash-Official", "DeepSeek-V4-Flash 正式版"),
              model("DeepSeek-V4-Flash", "DeepSeek-V4-Flash"),
            ],
          },
        ],
      },
    }),
    "https://models.example",
    "account",
  )
  expect(models.map((entry) => entry.id)).toEqual([
    "deepseek-v4.1-flash",
    "DeepSeek-V4-Flash-Official",
    "DeepSeek-V4-Flash",
  ])
})

test("a usable dev configuration still wins over TRAE agent entries without dev", async () => {
  const id = "deepseek-v4.1-flash"
  const models = await traeCnListModels(
    async () => ({
      status: 200,
      text: "",
      v: {
        function_configs: [
          {
            function: "chat_v3",
            config_info_list: [model(id, "Usable model")],
          },
          {
            function: "solo_agent",
            config_info_list: [
              {
                config_name: id,
                display_config: { display_name: "Other name" },
              },
            ],
          },
        ],
      },
    }),
    "https://models.example",
    "account",
  )
  expect(models[0]?.name).toBe("Usable model")
  expect(traeCnFunctionOrder("account", id)[0]?.fn).toBe("chat_v3")
})

test("model discovery on another account cannot overwrite this account's wire configuration", async () => {
  for (const [account, fn, wire] of [
    ["first", "solo_agent", "first-model__dev"],
    ["second", "chat_v3", "second-model__dev"],
  ] as const) {
    await traeCnListModels(
      async () => ({
        status: 200,
        text: "",
        v: {
          function_configs: [
            {
              function: fn,
              config_info_list: [
                {
                  ...model("shared", account),
                  model_detail_list: [{ model_name: wire }],
                },
              ],
            },
          ],
        },
      }),
      "https://models.example",
      account,
    )
  }
  expect(traeCnFunctionOrder("first", "shared")[0]).toEqual({
    fn: "solo_agent",
    modelName: "first-model__dev",
  })
  expect(traeCnFunctionOrder("second", "shared")[0]).toEqual({
    fn: "chat_v3",
    modelName: "second-model__dev",
  })
  expect(traeCnFunctionOrder("undiscovered", "shared")[0]).toEqual({
    fn: "chat_v3",
    modelName: undefined,
  })
})
