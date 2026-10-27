/**
 * `create*Once` 的整包校验：非流式回复必须是完整的 ChatCompletion。
 *
 * 各 provider 的流式收尾并不一样（有的直接透传 SSE，有的要重包事件），
 * 所以这里只收「读 JSON + 形状校验」这段真正重复的部分。
 */
import { isChatCompletionResponse } from "~/lib/utils"
import type { ChatCompletionResponse } from "~/services/protocols/chat/types"

export async function readChatCompletion(
  response: Response,
  invalidMessage: string,
): Promise<ChatCompletionResponse> {
  const body = (await response.json()) as object
  if (!isChatCompletionResponse(body)) {
    throw new Error(invalidMessage)
  }
  return body
}
