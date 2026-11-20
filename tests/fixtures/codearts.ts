export const fixtureProfile = {
  principal_urn: "iam::fixture-domain:user:fixture-account",
  principal_id: "fixture-user",
}

export const fixtureRefresh = `fixture.${Buffer.from(JSON.stringify({ user_profile: JSON.stringify(fixtureProfile) })).toString("base64url")}.fixture`

export function fixtureSts(accessKey = "fixture-AK", refresh = fixtureRefresh) {
  return {
    credentials: {
      access_key_id: accessKey,
      secret_access_key: "fixture-SK",
      security_token: "fixture-ST",
      expiration: "2099-01-01T00:00:00Z",
    },
    refresh_token: refresh,
  }
}

export const fixtureBuiltin = {
  builtinModels: [
    {
      model_id: "deepseek-v4.1-flash-1017",
      model_name: "DeepSeek-V4.1-Flash-1017",
      context_window: 100_000,
    },
    { model_id: "deepseek-v4.1-flash", model_name: "DeepSeek-V4.1-Flash" },
    { model_id: "kimi-k2.6-vl" },
  ],
}

export const fixtureAgent = {
  gpts: {
    models: [
      {
        display_name: "Incorrectly collapsed name",
        model_parameters: {
          model_id: "deepseek-v4.1-flash-1017",
          context_window: 1_000_000,
          max_tokens: 128_000,
          thinking_type: "enabled",
        },
        credit: [{ ratio_display: "0.30" }],
      },
      {
        display_name: "Custom",
        model_parameters: { model_id: "custom" },
        model_type: "third",
      },
    ],
  },
}

export const fixtureQuota = {
  code: 0,
  data: {
    package: { package_name_cn: "测试套餐" },
    end_date: "2099-02-01",
    metrics: [
      {
        name: "usageTotalPackageCredit",
        package_credit_amount: 1_000,
        package_credit_remain: 100.01,
      },
      {
        name: "usageBasicPackageCredit",
        package_credit_amount: 500,
        package_credit_remain: 0,
      },
      {
        name: "usageBonusPackageCredit",
        package_credit_amount: 500,
        package_credit_remain: 100.01,
      },
      { name: "usageOnDemandPackageCredit", package_credit_amount: 10 },
    ],
  },
}

export function fixtureSse(...frames: Array<unknown>) {
  return new Response(
    frames
      .map(
        (frame) =>
          `data: ${typeof frame === "string" ? frame : JSON.stringify(frame)}\n\n`,
      )
      .join(""),
    {
      headers: { "Content-Type": "text/event-stream" },
    },
  )
}
