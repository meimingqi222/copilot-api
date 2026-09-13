#!/usr/bin/env node

import { defineCommand } from "citty"

import { initLogger, logger } from "~/lib/logger"
import { ensurePaths } from "~/lib/paths"
import { state } from "~/lib/state"
import {
  deleteUser,
  isUserExpired,
  loadUsers,
  resetApiKey,
  toPublicUser,
  updateUser,
} from "~/lib/users"

function findUser(ref: string) {
  const lowered = ref.toLowerCase()
  return (
    state.users.find((u) => u.id === ref)
    ?? state.users.find((u) => u.username.toLowerCase() === lowered)
  )
}

function describeUser(ref: string) {
  const user = findUser(ref)
  if (!user) {
    logger.error(`User not found: ${ref}`)
    process.exitCode = 1
    return undefined
  }
  return user
}

const list = defineCommand({
  meta: {
    name: "list",
    description: "List API users (keys are never printed)",
  },
  run() {
    return (async () => {
      await ensurePaths()
      initLogger()
      await loadUsers()
      if (state.users.length === 0) {
        logger.info("No users configured.")
        return
      }
      for (const user of state.users) {
        const pub = toPublicUser(user)
        let status = "active"
        if (!user.enabled) {
          status = "disabled"
        } else if (isUserExpired(user)) {
          status = "expired"
        }
        logger.info(
          `- ${pub.username} [${pub.id}] role=${pub.role} status=${status} quota=${pub.quotaLimit} used=${pub.usedTokens}`
            + (pub.expiresAt ?
              ` expires=${new Date(pub.expiresAt).toISOString()}`
            : ""),
        )
      }
    })()
  },
})

const rotate = defineCommand({
  meta: {
    name: "rotate",
    description:
      "Rotate a user's API key (old key stops working immediately; new key is printed once)",
  },
  args: {
    user: {
      type: "positional",
      required: true,
      description: "User id or username",
    },
  },
  run({ args }) {
    return (async () => {
      await ensurePaths()
      initLogger()
      await loadUsers()
      const user = describeUser(args.user)
      if (!user) return
      const rawKey = await resetApiKey(user.id)
      if (!rawKey) {
        logger.error(`Failed to rotate key for: ${args.user}`)
        process.exitCode = 1
        return
      }
      logger.success(`Rotated API key for "${user.username}".`)
      logger.warn("Copy it now — it will not be shown again.")
      console.log(rawKey)
    })()
  },
})

const revoke = defineCommand({
  meta: {
    name: "revoke",
    description: "Revoke a user's API key immediately (disables the user)",
  },
  args: {
    user: {
      type: "positional",
      required: true,
      description: "User id or username",
    },
  },
  run({ args }) {
    return (async () => {
      await ensurePaths()
      initLogger()
      await loadUsers()
      const user = describeUser(args.user)
      if (!user) return
      const updated = await updateUser(user.id, { enabled: false })
      if (!updated) {
        logger.error(`Failed to revoke key for: ${args.user}`)
        process.exitCode = 1
        return
      }
      logger.success(`Revoked API key for "${user.username}".`)
    })()
  },
})

const remove = defineCommand({
  meta: {
    name: "remove",
    description: "Delete a user and invalidate their API key permanently",
  },
  args: {
    user: {
      type: "positional",
      required: true,
      description: "User id or username",
    },
  },
  run({ args }) {
    return (async () => {
      await ensurePaths()
      initLogger()
      await loadUsers()
      const user = describeUser(args.user)
      if (!user) return
      const ok = await deleteUser(user.id)
      if (!ok) {
        logger.error(`Failed to delete user: ${args.user}`)
        process.exitCode = 1
        return
      }
      logger.success(`Deleted user "${user.username}".`)
    })()
  },
})

export const key = defineCommand({
  meta: {
    name: "key",
    description: "Manage API keys (list, rotate, revoke, remove)",
  },
  subCommands: { list, rotate, revoke, remove },
})
