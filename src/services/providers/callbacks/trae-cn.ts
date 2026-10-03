import type { OAuthCallbackConfig } from "~/services/providers/callbacks/types"
import {
  TRAE_CN_CALLBACK_PATH,
  TRAE_CN_CALLBACK_PORT,
} from "~/services/oauth/trae-cn"

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
}
