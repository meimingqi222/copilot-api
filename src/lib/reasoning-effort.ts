/**
 * 思考力度元信息的唯一查询点与钳制点。
 *
 * 档位来自两处，按可信度排序：
 *
 * 1. 连接自己声明的档位（`ModelMapping.efforts`）——各 provider 刷新模型时
 *    把上游声明的档位写进去（Copilot `capabilities.supports.reasoning_effort`、
 *    Codex catalog `supported_reasoning_levels`、Qoder `thinking_config`、
 *    Windsurf 折叠变体），`cacheModels` 投影成
 *    `state.models[].capabilities.supports.reasoning_effort`（同一 id 多连接
 *    时取交集）。这是上游亲口说的，最可信。
 * 2. models.dev 目录——连接没声明时（纯 endpoint 连接、preset 之外的模型）
 *    按 `reasoning_options` / `capabilities.reasoning.effort` 的多数 provider
 *    共识兜底。
 *
 * 都没有就原样转发，与不认识档位的旧路径一致。档位词汇与取最近档算法在
 * `~/lib/effort-levels`，本模块只负责“某个模型有哪些档位”。
 */
import { nearestEffort } from "~/lib/effort-levels"
import { resolveModelsDevEfforts } from "~/lib/models-dev/resolve"
import { state } from "~/lib/state"

/**
 * 模型对外公布的思考档位（`/v1/models` 的
 * `capabilities.supports.reasoning_effort`），未公布时回落到 models.dev 目录，
 * 都没有则为 `undefined`。
 *
 * 同一 publicId 被多个连接服务时这里已经是交集（见 `cacheModels`），所以任何
 * 一个可能被选中的 target 都接受这些档位。
 */
export function effortsForModel(modelId: string): Array<string> | undefined {
  const data = state.models?.data
  if (data) {
    const levelsOf = (id: string) => {
      const levels = data.find((model) => model.id === id)?.capabilities
        .supports.reasoning_effort
      return levels && levels.length > 0 ? levels : undefined
    }
    const direct = levelsOf(modelId)
    if (direct) return direct
    // `connection/model`、`provider/model` 这类引用不是 /v1/models 里的 id：
    // 退到斜杠后的裸模型名，前缀路由与 auto-LB 共用同一份档位。
    const slash = modelId.indexOf("/")
    const bare = slash > 0 ? levelsOf(modelId.slice(slash + 1)) : undefined
    if (bare) return bare
  }
  return resolveModelsDevEfforts(modelId)
}

/**
 * 把客户端要求的档位钳制到模型自己的档位表；档位未知时原样返回。
 *
 * 需要钳制的场景：客户端按旧目录（或自带的默认值，如 Codex 对不认识的模型
 * 发 `medium`）请求了模型没有的档位，或同一 publicId 背后的模型档位更窄。
 */
export function clampEffortForModel(
  modelId: string,
  want: string | null | undefined,
): string | undefined {
  if (want === null || want === undefined) return want ?? undefined
  // `none`/`auto` 是开关语义而不是档位：`none` 表示关闭思考，不能被钳到
  // 模型的最弱一档，`auto` 交给上游自己决定。
  if (want === "none" || want === "auto") return want
  // `ultra` 只存在于 Codex 客户端的选择器里，不是任何上游 API 的档位：
  // 一律以 `max` 出站（magpie 的 gateway 同样先折叠再钳制）。
  const asked = want === "ultra" ? "max" : want
  const levels = effortsForModel(modelId)
  return levels ? nearestEffort(asked, levels) : asked
}
