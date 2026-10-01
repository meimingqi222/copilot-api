/**
 * Intent-classifier slot.
 *
 * Classifying an intent needs a model call, and this module must not make one:
 * the request path stays here and the caller wires an implementation in. The
 * default implementation lives in `./classifier-default` and pulls in the
 * dispatch stack, so it is imported lazily — the first time a group's rules ask
 * for an intent, and never before. A deployment that does not use `intent`
 * rules pays nothing for it, and no boot wiring is needed.
 *
 * Until a classifier answers, {@link classifyIntent} resolves `undefined` —
 * "no intent known", which matches nothing but never fails a request.
 *
 * A classifier that throws or answers with an empty string is treated the same
 * way: routing falls back to the rules' other conditions rather than failing.
 */

import type { RoutingGroup } from "./types"

export interface IntentClassifierInput {
  /** Text to classify, already assembled by the caller. */
  text: string
  /** Intents the classifier may answer with. */
  intents: Array<string>
  /** Provider the caller wants the classification run on. */
  provider: string
  /** Model the caller wants the classification run on. */
  model: string
}

export interface IntentClassifier {
  classify(
    input: IntentClassifierInput,
    signal?: AbortSignal,
  ): Promise<string | undefined>
}

let classifier: IntentClassifier | undefined

/** Install the classifier used by {@link classifyIntent}. */
export function registerIntentClassifier(next: IntentClassifier): void {
  classifier = next
}

/** Drop the registered classifier, restoring the no-op default. */
export function resetIntentClassifierForTest(): void {
  classifier = undefined
}

export function hasIntentClassifier(): boolean {
  return classifier !== undefined
}

/**
 * Install the default classifier, importing it on first use.
 *
 * The import is dynamic on purpose: `./classifier-default` reaches into the
 * route-target and protocol adapter layers, and this module sits on the request
 * path of every admission. A failure to load means there is simply no
 * classifier, which is the state this slot starts in.
 */
async function ensureDefaultClassifier(): Promise<void> {
  if (classifier) return
  try {
    const { ensureDefaultIntentClassifier } = await import(
      "./classifier-default"
    )
    ensureDefaultIntentClassifier()
  } catch {
    // No default available: the caller treats this as "no intent known".
  }
}

/**
 * Classify `input`, or resolve `undefined` when nothing can answer. Never
 * throws: a classifier is an optimisation, not a dependency of the request.
 */
export async function classifyIntent(
  input: IntentClassifierInput,
  signal?: AbortSignal,
): Promise<string | undefined> {
  // An empty intent list is unanswerable however a classifier is wired, so
  // check it before paying for the default implementation's import.
  if (input.intents.length === 0) return undefined
  if (signal?.aborted) return undefined

  if (!classifier) await ensureDefaultClassifier()

  const registered = classifier
  if (!registered) return undefined

  try {
    const answer = await registered.classify(input, signal)
    if (typeof answer !== "string") return undefined
    const intent = answer.trim()
    return intent === "" ? undefined : intent
  } catch {
    return undefined
  }
}

/** The provider/model a group asks to classify with, if it asks at all. */
export function classifierTargetOf(
  group: RoutingGroup,
): { provider: string; model: string } | undefined {
  const target = group.classifier
  if (!target) return undefined
  const provider =
    typeof target.provider === "string" ? target.provider.trim() : ""
  const model = typeof target.model === "string" ? target.model.trim() : ""
  if (provider === "" || model === "") return undefined
  return { provider, model }
}
