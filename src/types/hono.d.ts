import "hono"

import type { PrincipalBehavior } from "../lib/protected-route-guard"
import type { User } from "../lib/users"

declare module "hono" {
  interface ContextVariableMap {
    accountId: string | undefined
    model: string | undefined
    userId: string | undefined
    username: string | undefined
    user: User | undefined
    guardInitiator: string | undefined
    protectedRouteGuardCapturePreview: boolean | undefined
    protectedRouteGuardPrincipal: string | undefined
    protectedRouteGuardBehavior: PrincipalBehavior | undefined
    protectedRouteGuardRisk: string | undefined
  }
}
