import { saveAccounts } from "~/lib/account-store"
import {
  getAccount,
  getMimoPh,
  getMimoProxy,
  getMimoServiceToken,
  getMimoUserId,
  listAccounts,
} from "~/lib/accounts"
import { logger } from "~/lib/logger"
import {
  getMutableProviderConnection,
  syncAccountToConnection,
} from "~/lib/provider-connections"
import { sleep } from "~/lib/utils"
import { MimoAccountManager } from "~/services/mimo/account-lifecycle"

export function markAccountFailed(accountId: string, errorMsg: string) {
  const acc = getAccount(accountId)
  if (acc) {
    acc.runtimeState = {
      ...acc.runtimeState,
      authStatus: "error",
      lastError: errorMsg,
    }
    const conn = getMutableProviderConnection(acc.id)
    if (conn) syncAccountToConnection(conn, acc)
    saveAccounts().catch((err: unknown) => {
      logger.error("Failed to save accounts after marking failed:", err)
    })
  }
}

export function markAccountReady(accountId: string) {
  const acc = getAccount(accountId)
  if (acc && acc.runtimeState?.authStatus !== "ready") {
    acc.runtimeState = {
      ...acc.runtimeState,
      authStatus: "ready",
      lastError: undefined,
    }
    const conn = getMutableProviderConnection(acc.id)
    if (conn) syncAccountToConnection(conn, acc)
    saveAccounts().catch((err: unknown) => {
      logger.error("Failed to save accounts after marking ready:", err)
    })
  }
}

export function markAccountResting(accountId: string) {
  const acc = getAccount(accountId)
  if (acc) {
    acc.runtimeState = {
      ...acc.runtimeState,
      authStatus: "pending",
      lastError: undefined,
    }
    const conn = getMutableProviderConnection(acc.id)
    if (conn) syncAccountToConnection(conn, acc)
    saveAccounts().catch((err: unknown) => {
      logger.error("Failed to save accounts after marking resting:", err)
    })
  }
}

/**
 * Round-robin scheduler for Mimo accounts.
 * Runs accounts one at a time to conserve daily container creation quotas.
 *
 * Each account runs for ~50 minutes (RUN_DURATION_MS), then its container is
 * destroyed and the next account takes over. With N accounts, each account
 * creates at most ~24*60/(50*N) containers per day.
 */
const RUN_DURATION_MS = 50 * 60_000 // 50 minutes per account
const COOLDOWN_ON_FAILURE_MS = 10 * 60_000 // 10 min cooldown after failure
const REST_GAP_MS = 30_000 // 30s gap between accounts
const ACCOUNT_CHECK_INTERVAL_MS = 300_000 // 5 min between account list refreshes

interface RotatorSlot {
  accountId: string
  label: string
  serviceToken: string
  ph: string
  userId: string
  proxy?: string
  consecutiveFailures: number
}

class MimoRotator {
  private running = false
  private slots: Array<RotatorSlot> = []
  private currentIdx = 0
  private lastAccountRefresh = 0
  private activeManager: MimoAccountManager | null = null
  private lastEmptyLogged = false

  start() {
    if (this.running) return
    this.running = true
    this.run().catch((e: unknown) => {
      logger.error("[MimoRotator] Fatal rotator error:", e)
    })
  }

  stop() {
    this.running = false
    if (this.activeManager) {
      this.activeManager.stop()
      this.activeManager = null
    }
  }

  private refreshSlots() {
    const now = Date.now()
    if (
      now - this.lastAccountRefresh < ACCOUNT_CHECK_INTERVAL_MS
      && this.slots.length > 0
    ) {
      return
    }
    this.lastAccountRefresh = now

    const newSlots: Array<RotatorSlot> = []
    for (const account of listAccounts()) {
      if (account.provider !== "mimo-aistudio" || !account.enabled) continue

      const serviceToken = getMimoServiceToken(account)
      const ph = getMimoPh(account)
      const userId = getMimoUserId(account)
      if (!serviceToken || !ph || !userId) {
        logger.warn(
          `[MimoRotator] Account "${account.label}" missing credentials, skipping`,
        )
        continue
      }

      // Preserve consecutiveFailure count if slot already exists
      const existing = this.slots.find((s) => s.accountId === account.id)
      newSlots.push({
        accountId: account.id,
        label: account.label,
        serviceToken,
        ph,
        userId,
        proxy: getMimoProxy(account),
        consecutiveFailures: existing?.consecutiveFailures ?? 0,
      })
    }

    this.slots = newSlots
    // Clamp currentIdx if slots changed
    if (this.slots.length > 0 && this.currentIdx >= this.slots.length) {
      this.currentIdx = 0
    }
    // Reset empty log flag when slots become available
    if (this.slots.length > 0) {
      this.lastEmptyLogged = false
    }
  }

  private async run() {
    logger.info("[MimoRotator] Round-robin rotation engine started")

    while (this.running) {
      this.refreshSlots()

      if (this.slots.length === 0) {
        if (!this.lastEmptyLogged) {
          logger.info("[MimoRotator] No enabled Mimo accounts, waiting...")
          this.lastEmptyLogged = true
        }
        await sleep(30_000)
        continue
      }

      this.lastEmptyLogged = false

      // Single account: just run it continuously (no rotation needed)
      if (this.slots.length === 1) {
        const slot = this.slots[0]
        logger.info(
          `[MimoRotator] Single account "${slot.label}" — running continuously`,
        )
        const mgr = new MimoAccountManager({
          accountId: slot.accountId,
          label: slot.label,
          userId: slot.userId,
          serviceToken: slot.serviceToken,
          ph: slot.ph,
          proxy: slot.proxy,
        })
        // Use runLifecycle for single account (continuous loop mode)
        this.activeManager = mgr
        await mgr.runLifecycle()
        this.activeManager = null
        await sleep(30_000)
        continue
      }

      // Multi-account: round-robin
      const idx = this.currentIdx
      const slot = this.slots[idx]
      this.currentIdx = (idx + 1) % this.slots.length

      logger.info(
        `[MimoRotator] Round-robin: "${slot.label}" (${idx + 1}/${this.slots.length})`,
      )

      if (slot.consecutiveFailures >= 3) {
        logger.warn(
          `[MimoRotator] "${slot.label}" has ${slot.consecutiveFailures} consecutive failures, cooling down ${COOLDOWN_ON_FAILURE_MS / 60000}min`,
        )
        markAccountFailed(
          slot.accountId,
          "Too many consecutive failures, cooling down",
        )
        await sleep(COOLDOWN_ON_FAILURE_MS)
        slot.consecutiveFailures = 0
        markAccountResting(slot.accountId)
        continue
      }

      const mgr = new MimoAccountManager({
        accountId: slot.accountId,
        label: slot.label,
        userId: slot.userId,
        serviceToken: slot.serviceToken,
        ph: slot.ph,
        proxy: slot.proxy,
      })
      this.activeManager = mgr

      const result = await mgr.runSingleCycle(RUN_DURATION_MS)
      this.activeManager = null

      if (result.ok) {
        logger.info(
          `[MimoRotator] "${slot.label}" cycle completed successfully`,
        )
        markAccountResting(slot.accountId)
        slot.consecutiveFailures = 0
      } else if (result.reason === "stopped") {
        logger.info(`[MimoRotator] "${slot.label}" stopped, exiting rotation`)
        markAccountResting(slot.accountId)
        break
      } else {
        logger.warn(
          `[MimoRotator] "${slot.label}" cycle failed: ${result.reason}`,
        )
        slot.consecutiveFailures++

        if (result.reason.includes("create failed")) {
          logger.warn(
            `[MimoRotator] "${slot.label}" create failed (possible rate limit), rotating to next`,
          )
          markAccountFailed(
            slot.accountId,
            "Create failed (possible rate limit)",
          )
        }
      }

      // Gap between accounts
      await sleep(REST_GAP_MS)
    }
  }
}

const rotator = new MimoRotator()

export function startMimoManager() {
  logger.info("🚀 Mimo AI Studio control engine (Manager) initialized.")

  // Reset stale error states from previous runs
  let changed = false
  for (const account of listAccounts()) {
    if (
      account.provider === "mimo-aistudio"
      && account.enabled
      && account.runtimeState?.authStatus === "error"
    ) {
      account.runtimeState = {
        ...account.runtimeState,
        authStatus: "pending",
      }
      const conn = getMutableProviderConnection(account.id)
      if (conn) syncAccountToConnection(conn, account)
      changed = true
    }
  }
  if (changed) {
    saveAccounts().catch((err: unknown) => {
      logger.error("Failed to save accounts after resetting stale errors:", err)
    })
  }

  rotator.start()
}

// Called on shutdown
export function stopMimoManager() {
  rotator.stop()
}
