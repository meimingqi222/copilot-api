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
import type { ChatCompletionsPayload } from "~/services/protocols/chat/types"

import {
  findCredential,
  getProviderConnection,
} from "~/lib/provider-connections"
import { buildRouteTargets, selectRouteTarget } from "~/lib/route-target"
import { initializeProtocolAdapters } from "~/services/protocols"
import { getProtocolAdapter } from "~/services/protocols/registry"

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
export type ClassifierCompleter = (
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
export function classificationPrompt(intents: Array<string>): string {
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
 * One non-streaming chat completion through the app's own dispatch layer.
 *
 * Mirrors what the admin model-import helper does: build the candidate targets
 * for `provider/model`, pick one, resolve its connection and credential, and
 * hand the payload to that protocol's adapter. No target — no connection, a
 * disabled credential, an unregistered adapter — is an empty reply, not an
 * error: the caller only ever needs "which intent", and "unknown" is a fine
 * answer.
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
  const found = findCredential(target.connectionId, target.credentialId)
  if (!found) return ""

  const adapter = getProtocolAdapter(connection.protocol)
  const createChat = adapter?.createChatCompletions?.bind(adapter)
  if (!createChat) return ""

  const payload: ChatCompletionsPayload = {
    model: target.upstreamModelId,
    messages: [
      { role: "system", content: classificationPrompt(input.intents) },
      { role: "user", content: input.text },
    ],
    max_tokens: COMPLETION_MAX_TOKENS,
    temperature: 0,
    stream: false,
  }

  const timeout = AbortSignal.timeout(COMPLETION_TIMEOUT_MS)
  const result = await createChat({
    target,
    connection,
    credential: found.credential,
    payload,
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
  })
  if (!("response" in result)) return ""

  const response = result.response as {
    choices?: Array<{ message?: { content?: string | null } | null }>
  }
  return response.choices?.[0]?.message?.content ?? ""
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
