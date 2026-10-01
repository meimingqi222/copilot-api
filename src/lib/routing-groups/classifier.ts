/**
 * Intent-classifier slot.
 *
 * Classifying an intent needs a model call, and this module must not make one:
 * the request path stays here and the caller wires an implementation in. Until
 * something registers a classifier, {@link classifyIntent} resolves
 * `undefined` — "no intent known", which matches nothing but never fails a
 * request.
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
 * Classify `input`, or resolve `undefined` when nothing can answer. Never
 * throws: a classifier is an optimisation, not a dependency of the request.
 */
export async function classifyIntent(
  input: IntentClassifierInput,
  signal?: AbortSignal,
): Promise<string | undefined> {
  const registered = classifier
  if (!registered) return undefined
  if (input.intents.length === 0) return undefined
  if (signal?.aborted) return undefined

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
