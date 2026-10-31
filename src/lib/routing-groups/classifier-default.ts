/**
 * Default intent classifier: asks a model which of a group's intents a request
 * belongs to.
 *
 * The slot in `classifier.ts` deliberately holds no implementation, and until
 * something fills it a group's `intent` rules can never match. The obvious
 * filler is this module: route `provider/model` through the route-target and
 * protocol-adapter stack the request path already uses, send one non-streaming
 * chat request, and read the label out of the reply.
 *
 * Nothing here may fail a request. The reply is mapped leniently (an exact
 * label first, then the first label the reply mentions, otherwise nothing), a
 * refusal or an unparseable reply is "no intent", and every error resolves
 * `undefined` so routing falls back to the rule's other conditions.
 *
 * The model call itself is behind {@link ClassifierCompleter}, with a test seam
 * ({@link setIntentClassifierCompleterForTest}) so tests never reach the
 * network.
 */

import type { ProviderId } from "~/lib/provider-config"
import type { RequestAdmission } from "~/lib/request-admission"
import type { ChatCompletionsPayload } from "~/services/protocols/chat/types"

import { LocalPayloadUnsupportedError } from "~/lib/error"
import { getProviderConnection } from "~/lib/provider-connections"
import { findEffectiveCredential } from "~/lib/provider-connections/anonymous-credential"
import { runRedactedCall, withRedactionUpstream } from "~/lib/redaction/context"
import { buildRouteTargets, selectRouteTarget } from "~/lib/route-target"
import { identityFromAdmission, recordAccountUsage } from "~/lib/usage"
import { toPricingRound } from "~/lib/usage-pricing-rounds"
import { executeWithFailover } from "~/services/dispatch/failover"
import { resolveDispatchModel } from "~/services/dispatch/shared"
import { initializeProtocolAdapters } from "~/services/protocols"

import {
  hasIntentClassifier,
  registerIntentClassifier,
  type IntentClassifier,
  type IntentClassifierInput,
} from "./classifier"

/** How long the classifier waits for the model before giving up. */
const COMPLETION_TIMEOUT_MS = 10_000

/** Reply budget: one label, plus room for a model that adds a word around it. */
const COMPLETION_MAX_TOKENS = 32

/**
 * Asks a model one question. Returns the raw reply text; mapping it to an
 * intent is {@link intentFromReply}'s job, so a stub can answer with anything a
 * real model might.
 */
type ClassifierCompleter = (
  input: IntentClassifierInput,
  signal?: AbortSignal,
) => Promise<string>

let completerForTest: ClassifierCompleter | undefined

/** Replace the model call. Tests only — production keeps the real completer. */
export function setIntentClassifierCompleterForTest(
  next: ClassifierCompleter | undefined,
): void {
  completerForTest = next
}

/** Drop the test completer, restoring the real model call. */
export function resetIntentClassifierCompleterForTest(): void {
  completerForTest = undefined
}

/** The instruction that turns `intents` into a one-word question. */
function classificationPrompt(intents: Array<string>): string {
  return [
    "You label an incoming request with exactly one intent.",
    `Valid labels: ${intents.join(", ")}.`,
    "Answer with one label and nothing else.",
    "If none of them fits, answer with an empty string.",
  ].join("\n")
}

/**
 * The intent a reply names, or undefined when it names none.
 *
 * An exact label wins outright — that is what the prompt asks for, and it is
 * the only spelling that cannot be a coincidence. Otherwise the first label the
 * reply mentions counts, which reads the common replies that wrap the label in
 * punctuation or a word (`"code"`, `The intent is code.`, `{"intent":"code"}`).
 * Order comes from `intents`, so the caller's list decides ties.
 */
export function intentFromReply(
  reply: string,
  intents: Array<string>,
): string | undefined {
  if (typeof reply !== "string") return undefined
  const trimmed = reply.trim()
  if (trimmed === "") return undefined

  const exact = intents.find((intent) => intent === trimmed)
  if (exact !== undefined) return exact

  const lowered = trimmed.toLowerCase()
  return intents.find(
    (intent) => intent !== "" && lowered.includes(intent.toLowerCase()),
  )
}

/**
 * One non-streaming chat completion through the app's dispatch layer.
 *
 * The classifier asks a model one question, but it must not become a side
 * channel around dispatch: the call takes the standard path, so its concurrency
 * lease, pacing, cooldown/failover and usage accounting apply exactly as they
 * do to a client turn. No target — no connection, a disabled credential, an
 * unregistered adapter — is an empty reply, not an error: the caller only ever
 * needs "which intent", and "unknown" is a fine answer.
 */
async function completeWithModel(
  input: IntentClassifierInput,
  signal?: AbortSignal,
): Promise<string> {
  initializeProtocolAdapters()

  const candidates = buildRouteTargets({
    legacyProvider: input.provider as ProviderId,
    publicModelId: input.model,
    endpoint: "chat",
  })
  const target = selectRouteTarget(candidates, {})
  if (!target) return ""

  const connection = getProviderConnection(target.connectionId)
  if (!connection) return ""
  // 读路径：免密连接用合成匿名凭据兜底。
  const credential = findEffectiveCredential(connection, target.credentialId)
  if (!credential) return ""

  const payload: ChatCompletionsPayload = {
    // Routing identity, not the wire model: failover uses `payload.model` to
    // find the next candidate. Each attempt rewrites it to the target's
    // dispatch model below, exactly like the normal dispatch path.
    model: target.publicModelId || input.model,
    messages: [
      { role: "system", content: classificationPrompt(input.intents) },
      { role: "user", content: input.text },
    ],
    max_tokens: COMPLETION_MAX_TOKENS,
    temperature: 0,
    stream: false,
  }

  const timeout = AbortSignal.timeout(COMPLETION_TIMEOUT_MS)
  const effectiveSignal = signal ? AbortSignal.any([signal, timeout]) : timeout
  let used: RequestAdmission = { target, connection, credential }
  // The classifier reads the caller's message text. When upstream redaction is
  // on, that text must be masked before it leaves for a different model — this
  // call happens during admission, before the request's own redaction scope
  // exists, so it opens its own. Without this the plaintext went out unrecorded
  // and absent from the redaction diagnostics.
  const result = await runRedactedCall(payload, undefined, async (prepared) =>
    withRedactionUpstream(
      {
        id: connection.id,
        name: connection.name,
        protocol: connection.protocol,
        model: target.publicModelId,
      },
      prepared,
      () =>
        executeWithFailover({
          payload: prepared,
          admission: used,
          routeKind: "chat",
          logPrefix: "[intent-classifier]",
          signal: effectiveSignal,
          execute: (adapter, currentTarget, current) => {
            used = current
            const createChat = adapter?.createChatCompletions?.bind(adapter)
            if (!createChat) {
              return Promise.reject(
                new LocalPayloadUnsupportedError(
                  `Protocol "${currentTarget.protocol}" cannot serve chat completions`,
                ),
              )
            }
            return createChat({
              target: currentTarget,
              connection: current.connection,
              credential: current.credential,
              // The public alias is what the client asked for; the upstream only
              // understands the target's model id (renamed models keep a distinct
              // upstreamId). Failover may land on a different target, so resolve
              // per attempt.
              payload: {
                ...prepared,
                model: resolveDispatchModel(currentTarget, adapter),
              },
              signal: effectiveSignal,
            })
          },
        }),
    ),
  )
  if (!("response" in result)) return ""

  const response = result.response as {
    choices?: Array<{ message?: { content?: string | null } | null }>
    usage?: { prompt_tokens?: number; completion_tokens?: number }
  }
  recordClassifierUsage(used, response.usage)
  return response.choices?.[0]?.message?.content ?? ""
}

/** Account consumption for the extra upstream call, not another client request. */
function recordClassifierUsage(
  admission: RequestAdmission,
  usage: { prompt_tokens?: number; completion_tokens?: number } | undefined,
): void {
  const promptTokens = usage?.prompt_tokens ?? 0
  const completionTokens = usage?.completion_tokens ?? 0
  if (promptTokens <= 0 && completionTokens <= 0) return
  recordAccountUsage({
    identity: identityFromAdmission(admission),
    model: admission.target.publicModelId || admission.target.upstreamModelId,
    rounds: [
      toPricingRound({
        source: "reported",
        inputTokens: promptTokens,
        outputTokens: completionTokens,
      }),
    ],
  })
}

/** The completer in force: the test stub when one is installed. */
function activeCompleter(): ClassifierCompleter {
  return completerForTest ?? completeWithModel
}

/**
 * The classifier the slot gets by default.
 *
 * The completer is resolved per call, so installing a stub after this
 * classifier exists still takes effect. Everything is caught: a classifier
 * miss must read as "no intent", never as a failed request.
 */
export function createDefaultIntentClassifier(): IntentClassifier {
  return {
    async classify(input, signal) {
      try {
        const reply = await activeCompleter()(input, signal)
        return intentFromReply(reply, input.intents)
      } catch {
        return undefined
      }
    },
  }
}

/**
 * Install the default classifier when the slot is empty.
 *
 * Idempotent, and cheap: `classifier.ts` imports this module lazily, only once
 * a group's rules actually ask for an intent, so a deployment that never uses
 * `intent` never loads the dispatch stack through here.
 */
export function ensureDefaultIntentClassifier(): void {
  if (hasIntentClassifier()) return
  registerIntentClassifier(createDefaultIntentClassifier())
}
