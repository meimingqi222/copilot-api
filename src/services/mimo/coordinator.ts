import consola from "consola"

/**
 * Cross-account coordination: ensures only one claw container is being
 * destroyed or created at any time, with a minimum gap between operations.
 * Prevents all accounts from being simultaneously unavailable during
 * their independent lifecycle cycles.
 */
const GAP_MS = 5 * 60_000

export const destroyCreateCoordinator = (() => {
  let chain: Promise<void> = Promise.resolve()

  return {
    async acquire(label: string): Promise<() => void> {
      const prev = chain
      let release!: () => void
      chain = new Promise<void>((resolve) => {
        release = resolve
      })

      try {
        await prev
      } catch {
        // previous slot errored, proceed
      }
      consola.info(`[MimoLock] "${label}" acquired destroy/create slot`)

      let released = false
      return () => {
        if (released) return
        released = true
        consola.info(
          `[MimoLock] "${label}" releasing slot (next in ${GAP_MS / 1000}s)`,
        )
        setTimeout(release, GAP_MS)
      }
    },
  }
})()
