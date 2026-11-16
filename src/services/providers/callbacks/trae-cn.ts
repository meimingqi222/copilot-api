import type { OAuthCallbackConfig } from "~/services/providers/callbacks/types"
import {
  TRAE_CN_CALLBACK_PATH,
  TRAE_CN_CALLBACK_PORT,
} from "~/services/trae-cn/constants"

// trae.cn 的授权页回到 auth_callback_url 指到的 /authorize，query 带
// userJwt（token 对，编码后的 JSON）与 userInfo（账号）；没有 OAuth
// 标准 code/state，所以跳过 state 校验、把 userInfo 当 state 段交回给
// exchange（combineIntoCode → `<userInfo>\u0000<userJwt>`）。
export const traeCnCallbackConfig: OAuthCallbackConfig = {
  port: TRAE_CN_CALLBACK_PORT,
  hostname: "127.0.0.1",
  callbackPath: TRAE_CN_CALLBACK_PATH,
  providerLabel: "Trae CN",
  queryParams: { code: "userJwt", state: "userInfo" },
  skipStateCheck: true,
  combineIntoCode: true,
  parseQuery(params) {
    const jwt = params.get("userJwt") ?? ""
    if (!jwt && !params.get("refreshToken")) return undefined
    const state = params.get("userInfo") ?? ""
    const extras = Object.fromEntries(
      [
        "host",
        "authHost",
        "auth_host",
        "refreshToken",
        "clientId",
        "userId",
      ].flatMap((key) => {
        const value = params.get(key)
        return value ? [[key, value]] : []
      }),
    )
    return {
      code: `${state}\u0000${jwt}${Object.keys(extras).length ? "\u0000" + JSON.stringify(extras) : ""}`,
      state,
    }
  },
}

// Global 的授权页（www.trae.ai/authorization）回到同一个 loopback /authorize，
// query 形状一致；admin start 按共享端口互斥（包括手动回调），避免两站串号。
export const traeGlobalCallbackConfig: OAuthCallbackConfig = {
  ...traeCnCallbackConfig,
  providerLabel: "Trae Global",
}
