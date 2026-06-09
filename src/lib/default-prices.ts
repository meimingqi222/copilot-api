/**
 * Default model prices from OpenRouter (per 1M tokens in USD)
 * Users can override these via the admin panel
 * Source: https://openrouter.ai/models
 *
 * Note: Models not found on OpenRouter (like claude-xxx-fast variants)
 * are calculated as 6x the base model price when matched.
 *
 * Prices stored in database are per 1K tokens, but this file uses per 1M
 * for better readability. Conversion happens in the API layer.
 */
const DEFAULT_MODEL_PRICES: Record<
  string,
  {
    promptPricePer1m: number
    completionPricePer1m: number
    cacheReadPricePer1m?: number
    cacheWritePricePer1m?: number
  }
> = {
  // ==================== Anthropic Claude Models ====================
  // Claude 3.x / 4.x Haiku series
  "claude-3-haiku": {
    promptPricePer1m: 0.25,
    completionPricePer1m: 1.25,
    cacheReadPricePer1m: 0.025,
    cacheWritePricePer1m: 0.25,
  },
  "claude-3.5-haiku": {
    promptPricePer1m: 0.8,
    completionPricePer1m: 4.0,
    cacheReadPricePer1m: 0.08,
    cacheWritePricePer1m: 0.8,
  },
  "claude-haiku-3.5": {
    promptPricePer1m: 0.8,
    completionPricePer1m: 4.0,
    cacheReadPricePer1m: 0.08,
    cacheWritePricePer1m: 0.8,
  },
  "claude-haiku-4.5": {
    promptPricePer1m: 1.0,
    completionPricePer1m: 5.0,
    cacheReadPricePer1m: 0.1,
    cacheWritePricePer1m: 1.0,
  },
  "claude-haiku-4": {
    promptPricePer1m: 1.0,
    completionPricePer1m: 5.0,
    cacheReadPricePer1m: 0.1,
    cacheWritePricePer1m: 1.0,
  },

  // Claude Sonnet series
  "claude-sonnet-4": {
    promptPricePer1m: 3.0,
    completionPricePer1m: 15.0,
    cacheReadPricePer1m: 0.3,
    cacheWritePricePer1m: 3.75, // Anthropic 5min cache: prompt * 1.25
  },
  "claude-sonnet-4.5": {
    promptPricePer1m: 3.0,
    completionPricePer1m: 15.0,
    cacheReadPricePer1m: 0.3,
    cacheWritePricePer1m: 3.75,
  },
  "claude-sonnet-4.6": {
    promptPricePer1m: 3.0,
    completionPricePer1m: 15.0,
    cacheReadPricePer1m: 0.3,
    cacheWritePricePer1m: 3.75,
  },
  "claude-sonnet-4-fast": {
    promptPricePer1m: 18.0, // 3.0 * 6
    completionPricePer1m: 90.0, // 15.0 * 6
    cacheReadPricePer1m: 1.8,
    cacheWritePricePer1m: 22.5, // 3.75 * 6
  },
  "claude-sonnet-4.5-fast": {
    promptPricePer1m: 18.0,
    completionPricePer1m: 90.0,
    cacheReadPricePer1m: 1.8,
    cacheWritePricePer1m: 22.5,
  },
  "claude-sonnet-4.6-fast": {
    promptPricePer1m: 18.0,
    completionPricePer1m: 90.0,
    cacheReadPricePer1m: 1.8,
    cacheWritePricePer1m: 22.5,
  },
  "claude-3-sonnet": {
    promptPricePer1m: 3.0,
    completionPricePer1m: 15.0,
    cacheReadPricePer1m: 0.3,
    cacheWritePricePer1m: 3.75,
  },
  "claude-3.5-sonnet": {
    promptPricePer1m: 3.0,
    completionPricePer1m: 15.0,
    cacheReadPricePer1m: 0.3,
    cacheWritePricePer1m: 3.75,
  },

  // Claude Opus series
  "claude-opus-4": {
    promptPricePer1m: 5.0,
    completionPricePer1m: 25.0,
    cacheReadPricePer1m: 0.5,
    cacheWritePricePer1m: 6.25, // Anthropic 5min cache: prompt * 1.25
  },
  "claude-opus-4.1": {
    promptPricePer1m: 5.0,
    completionPricePer1m: 25.0,
    cacheReadPricePer1m: 0.5,
    cacheWritePricePer1m: 6.25,
  },
  "claude-opus-4.5": {
    promptPricePer1m: 5.0,
    completionPricePer1m: 25.0,
    cacheReadPricePer1m: 0.5,
    cacheWritePricePer1m: 6.25,
  },
  "claude-opus-4.6": {
    promptPricePer1m: 5.0,
    completionPricePer1m: 25.0,
    cacheReadPricePer1m: 0.5,
    cacheWritePricePer1m: 6.25,
  },
  "claude-opus-4.7": {
    promptPricePer1m: 5.0,
    completionPricePer1m: 25.0,
    cacheReadPricePer1m: 0.5,
    cacheWritePricePer1m: 6.25,
  },
  "claude-opus-4.1-fast": {
    promptPricePer1m: 30.0, // 5.0 * 6
    completionPricePer1m: 150.0, // 25.0 * 6
    cacheReadPricePer1m: 3.0,
    cacheWritePricePer1m: 37.5, // 6.25 * 6
  },
  "claude-opus-4.6-fast": {
    promptPricePer1m: 30.0,
    completionPricePer1m: 150.0,
    cacheReadPricePer1m: 3.0,
    cacheWritePricePer1m: 37.5,
  },
  "claude-3-opus": {
    promptPricePer1m: 15.0,
    completionPricePer1m: 75.0,
    cacheReadPricePer1m: 1.5,
    cacheWritePricePer1m: 18.75, // 15.0 * 1.25
  },

  // ==================== OpenAI GPT Models ====================
  // GPT-5 series
  "gpt-5": {
    promptPricePer1m: 1.25,
    completionPricePer1m: 10.0,
    cacheReadPricePer1m: 0.125,
    cacheWritePricePer1m: 1.25,
  },
  "gpt-5-chat": {
    promptPricePer1m: 1.25,
    completionPricePer1m: 10.0,
    cacheReadPricePer1m: 0.125,
    cacheWritePricePer1m: 1.25,
  },
  "gpt-5.1": {
    promptPricePer1m: 1.25,
    completionPricePer1m: 10.0,
    cacheReadPricePer1m: 0.125,
    cacheWritePricePer1m: 1.25,
  },
  "gpt-5.1-chat": {
    promptPricePer1m: 1.25,
    completionPricePer1m: 10.0,
    cacheReadPricePer1m: 0.125,
    cacheWritePricePer1m: 1.25,
  },
  "gpt-5.2": {
    promptPricePer1m: 1.75,
    completionPricePer1m: 14.0,
    cacheReadPricePer1m: 0.175,
    cacheWritePricePer1m: 1.75,
  },
  "gpt-5.2-chat": {
    promptPricePer1m: 1.75,
    completionPricePer1m: 14.0,
    cacheReadPricePer1m: 0.175,
    cacheWritePricePer1m: 1.75,
  },
  "gpt-5.3": {
    promptPricePer1m: 1.75,
    completionPricePer1m: 14.0,
    cacheReadPricePer1m: 0.175,
    cacheWritePricePer1m: 1.75,
  },
  "gpt-5.4": {
    // Calibrated against GitHub billing aic_gross_amount on 2026-05-15
    promptPricePer1m: 1.75,
    completionPricePer1m: 14.0,
    cacheReadPricePer1m: 0.175,
    cacheWritePricePer1m: 1.75,
  },
  "gpt-5.5": {
    // Calibrated against GitHub billing aic_gross_amount on 2026-05-06/07/11/12
    promptPricePer1m: 5.0,
    completionPricePer1m: 30.0,
    cacheReadPricePer1m: 0.5,
    cacheWritePricePer1m: 5.0,
  },
  "gpt-5-nano": {
    promptPricePer1m: 0.05,
    completionPricePer1m: 0.4,
    cacheReadPricePer1m: 0.005,
    cacheWritePricePer1m: 0.05,
  },
  "gpt-5-mini": {
    promptPricePer1m: 0.25,
    completionPricePer1m: 2.0,
    cacheReadPricePer1m: 0.025,
    cacheWritePricePer1m: 0.25,
  },

  // GPT-5 Codex series
  "gpt-5-codex": {
    promptPricePer1m: 1.25,
    completionPricePer1m: 10.0,
    cacheReadPricePer1m: 0.125,
    cacheWritePricePer1m: 1.25,
  },
  "gpt-5.1-codex": {
    promptPricePer1m: 1.25,
    completionPricePer1m: 10.0,
    cacheReadPricePer1m: 0.125,
    cacheWritePricePer1m: 1.25,
  },
  "gpt-5.1-codex-max": {
    promptPricePer1m: 1.25,
    completionPricePer1m: 10.0,
    cacheReadPricePer1m: 0.125,
    cacheWritePricePer1m: 1.25,
  },
  "gpt-5.1-codex-mini": {
    promptPricePer1m: 0.25,
    completionPricePer1m: 2.0,
    cacheReadPricePer1m: 0.025,
    cacheWritePricePer1m: 0.25,
  },
  "gpt-5.2-codex": {
    promptPricePer1m: 1.75,
    completionPricePer1m: 14.0,
    cacheReadPricePer1m: 0.175,
    cacheWritePricePer1m: 1.75,
  },
  "gpt-5.3-codex": {
    promptPricePer1m: 1.75,
    completionPricePer1m: 14.0,
    cacheReadPricePer1m: 0.175,
    cacheWritePricePer1m: 1.75,
  },

  // GPT-4.1 series
  "gpt-4.1": {
    promptPricePer1m: 0.5,
    completionPricePer1m: 1.5,
    cacheReadPricePer1m: 0.05,
    cacheWritePricePer1m: 0.5,
  },
  "gpt-4.1-2025-04-14": {
    promptPricePer1m: 0.5,
    completionPricePer1m: 1.5,
    cacheReadPricePer1m: 0.05,
    cacheWritePricePer1m: 0.5,
  },
  "gpt-4.1-mini": {
    promptPricePer1m: 0.3,
    completionPricePer1m: 0.9,
    cacheReadPricePer1m: 0.03,
    cacheWritePricePer1m: 0.3,
  },
  "gpt-4.1-nano": {
    promptPricePer1m: 0.15,
    completionPricePer1m: 1.2,
    cacheReadPricePer1m: 0.015,
    cacheWritePricePer1m: 0.15,
  },

  // GPT-4o series
  "gpt-4o": {
    promptPricePer1m: 0.5,
    completionPricePer1m: 1.5,
    cacheReadPricePer1m: 0.05,
    cacheWritePricePer1m: 0.5,
  },
  "gpt-4o-2024-05-13": {
    promptPricePer1m: 0.5,
    completionPricePer1m: 1.5,
    cacheReadPricePer1m: 0.05,
    cacheWritePricePer1m: 0.5,
  },
  "gpt-4o-2024-08-06": {
    promptPricePer1m: 2.5,
    completionPricePer1m: 10.0,
    cacheReadPricePer1m: 0.25,
    cacheWritePricePer1m: 2.5,
  },
  "gpt-4o-2024-11-20": {
    promptPricePer1m: 2.5,
    completionPricePer1m: 10.0,
    cacheReadPricePer1m: 0.25,
    cacheWritePricePer1m: 2.5,
  },
  "gpt-4o-mini": {
    promptPricePer1m: 0.15,
    completionPricePer1m: 0.6,
    cacheReadPricePer1m: 0.015,
    cacheWritePricePer1m: 0.15,
  },
  "gpt-4o-mini-2024-07-18": {
    promptPricePer1m: 0.15,
    completionPricePer1m: 0.6,
    cacheReadPricePer1m: 0.015,
    cacheWritePricePer1m: 0.15,
  },

  // GPT-4 series
  "gpt-4": {
    promptPricePer1m: 30.0,
    completionPricePer1m: 60.0,
    cacheReadPricePer1m: 3.0,
    cacheWritePricePer1m: 30.0,
  },
  "gpt-4-0125-preview": {
    promptPricePer1m: 10.0,
    completionPricePer1m: 30.0,
    cacheReadPricePer1m: 1.0,
    cacheWritePricePer1m: 10.0,
  },
  "gpt-4-0613": {
    promptPricePer1m: 30.0,
    completionPricePer1m: 60.0,
    cacheReadPricePer1m: 3.0,
    cacheWritePricePer1m: 30.0,
  },
  "gpt-4-turbo": {
    promptPricePer1m: 10.0,
    completionPricePer1m: 30.0,
    cacheReadPricePer1m: 1.0,
    cacheWritePricePer1m: 10.0,
  },
  "gpt-4-o-preview": {
    promptPricePer1m: 2.5,
    completionPricePer1m: 10.0,
    cacheReadPricePer1m: 0.25,
    cacheWritePricePer1m: 2.5,
  },
  "gpt-41": {
    promptPricePer1m: 0.5,
    completionPricePer1m: 1.5,
    cacheReadPricePer1m: 0.05,
    cacheWritePricePer1m: 0.5,
  },
  "gpt-41-copilot": {
    promptPricePer1m: 0.5,
    completionPricePer1m: 1.5,
    cacheReadPricePer1m: 0.05,
    cacheWritePricePer1m: 0.5,
  },

  // GPT-3.5 series
  "gpt-3.5-turbo": {
    promptPricePer1m: 0.5,
    completionPricePer1m: 1.5,
    cacheReadPricePer1m: 0.05,
    cacheWritePricePer1m: 0.5,
  },
  "gpt-3.5-turbo-0613": {
    promptPricePer1m: 1.5,
    completionPricePer1m: 2.0,
    cacheReadPricePer1m: 0.15,
    cacheWritePricePer1m: 1.5,
  },

  // OpenAI O series (reasoning models)
  o1: {
    promptPricePer1m: 15.0,
    completionPricePer1m: 60.0,
    cacheReadPricePer1m: 1.5,
    cacheWritePricePer1m: 15.0,
  },
  "o1-mini": {
    promptPricePer1m: 1.1,
    completionPricePer1m: 4.4,
    cacheReadPricePer1m: 0.11,
    cacheWritePricePer1m: 1.1,
  },
  "o1-preview": {
    promptPricePer1m: 15.0,
    completionPricePer1m: 60.0,
    cacheReadPricePer1m: 1.5,
    cacheWritePricePer1m: 15.0,
  },
  o3: {
    promptPricePer1m: 10.0,
    completionPricePer1m: 40.0,
    cacheReadPricePer1m: 1.0,
    cacheWritePricePer1m: 10.0,
  },
  "o3-mini": {
    promptPricePer1m: 1.1,
    completionPricePer1m: 4.4,
    cacheReadPricePer1m: 0.11,
    cacheWritePricePer1m: 1.1,
  },
  "o3-mini-high": {
    promptPricePer1m: 1.1,
    completionPricePer1m: 4.4,
    cacheReadPricePer1m: 0.11,
    cacheWritePricePer1m: 1.1,
  },
  "o4-mini": {
    promptPricePer1m: 1.1,
    completionPricePer1m: 4.4,
    cacheReadPricePer1m: 0.11,
    cacheWritePricePer1m: 1.1,
  },
  "o4-mini-high": {
    promptPricePer1m: 1.1,
    completionPricePer1m: 4.4,
    cacheReadPricePer1m: 0.11,
    cacheWritePricePer1m: 1.1,
  },

  // ==================== Google Gemini Models ====================
  // Gemini 2.x series
  "gemini-2.0-flash": {
    promptPricePer1m: 0.1,
    completionPricePer1m: 0.4,
    cacheReadPricePer1m: 0.01,
    cacheWritePricePer1m: 0.1,
  },
  "gemini-2.0-flash-lite": {
    promptPricePer1m: 0.075,
    completionPricePer1m: 0.3,
    cacheReadPricePer1m: 0.0075,
    cacheWritePricePer1m: 0.075,
  },
  "gemini-2.5-flash": {
    promptPricePer1m: 0.1,
    completionPricePer1m: 0.4,
    cacheReadPricePer1m: 0.01,
    cacheWritePricePer1m: 0.1,
  },
  "gemini-2.5-flash-lite": {
    promptPricePer1m: 0.075,
    completionPricePer1m: 0.3,
    cacheReadPricePer1m: 0.0075,
    cacheWritePricePer1m: 0.075,
  },
  "gemini-2.5-pro": {
    promptPricePer1m: 1.25,
    completionPricePer1m: 10.0,
    cacheReadPricePer1m: 0.125,
    cacheWritePricePer1m: 1.25,
  },
  "gemini-2.5-pro-preview": {
    promptPricePer1m: 1.25,
    completionPricePer1m: 10.0,
    cacheReadPricePer1m: 0.125,
    cacheWritePricePer1m: 1.25,
  },
  "gemini-2.5-pro-preview-05-06": {
    promptPricePer1m: 1.25,
    completionPricePer1m: 10.0,
    cacheReadPricePer1m: 0.125,
    cacheWritePricePer1m: 1.25,
  },
  "gemini-2.5-pro-preview-06-05": {
    promptPricePer1m: 1.25,
    completionPricePer1m: 10.0,
    cacheReadPricePer1m: 0.125,
    cacheWritePricePer1m: 1.25,
  },

  // Gemini 3.x series
  "gemini-3-pro-preview": {
    promptPricePer1m: 2.0,
    completionPricePer1m: 6.0,
    cacheReadPricePer1m: 0.2,
    cacheWritePricePer1m: 2.0,
  },
  "gemini-3-flash-preview": {
    promptPricePer1m: 0.3,
    completionPricePer1m: 1.2,
    cacheReadPricePer1m: 0.03,
    cacheWritePricePer1m: 0.3,
  },
  "gemini-3.1-pro-preview": {
    promptPricePer1m: 2.0,
    completionPricePer1m: 6.0,
    cacheReadPricePer1m: 0.2,
    cacheWritePricePer1m: 2.0,
  },
  "gemini-3.1-flash-lite-preview": {
    promptPricePer1m: 0.25,
    completionPricePer1m: 1.5,
    cacheReadPricePer1m: 0.025,
    cacheWritePricePer1m: 0.25,
  },

  // ==================== xAI Grok Models ====================
  "grok-2": {
    promptPricePer1m: 2.0,
    completionPricePer1m: 10.0,
    cacheReadPricePer1m: 0.2,
    cacheWritePricePer1m: 2.0,
  },
  "grok-3-mini": {
    promptPricePer1m: 0.1,
    completionPricePer1m: 0.4,
    cacheReadPricePer1m: 0.01,
    cacheWritePricePer1m: 0.1,
  },
  "grok-3-mini-beta": {
    promptPricePer1m: 0.1,
    completionPricePer1m: 0.4,
    cacheReadPricePer1m: 0.01,
    cacheWritePricePer1m: 0.1,
  },
  "grok-4-fast": {
    promptPricePer1m: 0.2,
    completionPricePer1m: 0.5,
    cacheReadPricePer1m: 0.02,
    cacheWritePricePer1m: 0.2,
  },
  "grok-4.1-fast": {
    promptPricePer1m: 0.2,
    completionPricePer1m: 0.5,
    cacheReadPricePer1m: 0.02,
    cacheWritePricePer1m: 0.2,
  },
  "grok-code-fast-1": {
    promptPricePer1m: 0.2,
    completionPricePer1m: 1.5,
    cacheReadPricePer1m: 0.02,
    cacheWritePricePer1m: 0.2,
  },

  // ==================== Embedding Models ====================
  "text-embedding-ada-002": {
    promptPricePer1m: 0.1,
    completionPricePer1m: 0,
  },
  "text-embedding-3-small": {
    promptPricePer1m: 0.02,
    completionPricePer1m: 0,
  },
  "text-embedding-3-small-inference": {
    promptPricePer1m: 0.02,
    completionPricePer1m: 0,
  },
  "text-embedding-3-large": {
    promptPricePer1m: 0.13,
    completionPricePer1m: 0,
  },

  // ==================== OSWE Models ====================
  "oswe-vscode-prime": {
    promptPricePer1m: 0,
    completionPricePer1m: 0,
  },
  "oswe-vscode-secondary": {
    promptPricePer1m: 0,
    completionPricePer1m: 0,
  },
}

/**
 * Get default price for a model (returns per 1K prices for internal use)
 * Only returns prices for models explicitly defined in DEFAULT_MODEL_PRICES
 * @param modelId - The model ID
 * @returns Default pricing per 1K tokens or null if not found
 */
export function getDefaultModelPrice(modelId: string): {
  promptPricePer1k: number
  completionPricePer1k: number
  cacheReadPricePer1k: number
  cacheWritePricePer1k: number
} | null {
  const toPer1kPrice = (price: (typeof DEFAULT_MODEL_PRICES)[string]) => ({
    promptPricePer1k: price.promptPricePer1m / 1000,
    completionPricePer1k: price.completionPricePer1m / 1000,
    cacheReadPricePer1k: (price.cacheReadPricePer1m ?? 0) / 1000,
    cacheWritePricePer1k: (price.cacheWritePricePer1m ?? 0) / 1000,
  })

  // Try exact match first
  if (Object.hasOwn(DEFAULT_MODEL_PRICES, modelId)) {
    return toPer1kPrice(DEFAULT_MODEL_PRICES[modelId])
  }

  // Try case-insensitive match
  const lowerModelId = modelId.toLowerCase()
  for (const [key, price] of Object.entries(DEFAULT_MODEL_PRICES)) {
    if (key.toLowerCase() === lowerModelId) {
      return toPer1kPrice(price)
    }
  }

  // Try partial match, preferring the most specific model id first.
  const matchedEntry = Object.entries(DEFAULT_MODEL_PRICES)
    .sort(([leftKey], [rightKey]) => rightKey.length - leftKey.length)
    .find(([key]) => lowerModelId.includes(key.toLowerCase()))

  if (matchedEntry !== undefined) {
    return toPer1kPrice(matchedEntry[1])
  }

  return null
}
