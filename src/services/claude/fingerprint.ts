/**
 * Claude Code stealth-fingerprint constants.
 *
 * These values reproduce the official Claude Code CLI's wire fingerprint so
 * OAuth (Pro/Max) traffic through copilot-api is indistinguishable from the
 * real `claude` desktop client. Anthropic's backend can detect non-CC clients
 * via missing/mismatched attestations (the `cch` billing-header hash) and
 * identity fields, so keeping these in sync with the shipped CC version is the
 * core anti-ban measure for the Claude integration.
 *
 * Kept in a leaf module with no other imports so fingerprint consumers (cch,
 * user-id, headers) don't pull in the heavy provider module.
 *
 * Ported from oh-my-pi packages/ai/src/providers/claude-code-fingerprint.ts.
 * NOTE: these must be updated when Claude Code ships a new version, otherwise
 * the fingerprint (especially the `cc_version` suffix used by `cch`) drifts.
 */

/** Claude runtime version bundled by the current Cowork desktop release. */
export const claudeCodeVersion = "2.1.220"

/** User-Agent emitted by Cowork's claude-desktop inference entrypoint. */
export const claudeCoworkUserAgent = `claude-cli/${claudeCodeVersion} (external, claude-desktop)`

/** @deprecated Retained for callers that still import the legacy constants. */
export const claudeAgentSdkVersion = "0.3.220"
/** @deprecated Cowork no longer emits this client header. */
export const claudeClientVersion = "1.11187.4"

export const claudeCodeSystemInstruction =
  "You are a Claude agent, built on Anthropic's Claude Agent SDK."

// Claude Code caps requested output at 64k tokens even when the model ceiling
// is higher (e.g. Opus 4.8 supports 128k); OAuth requests clamp to match the
// wire fingerprint. API-key requests keep the full model ceiling.
export const CLAUDE_CODE_MAX_OUTPUT_TOKENS = 64000
