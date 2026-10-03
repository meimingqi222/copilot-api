import type { ProviderId } from "~/lib/provider-config"
import type {
  ManagedConnectionInput,
  ProviderConnection,
} from "~/lib/provider-connections"

export interface CreateAccountBody {
  label?: string
  provider?: ProviderId
  authToken?: string
  apiKey?: string
  serviceToken?: string
  xiaomichatbotPh?: string
  credentials?: Record<string, unknown>
  settings?: Record<string, unknown>
}

export interface AccountDeviceFlow {
  device_code: string
  user_code: string
  verification_uri: string
  expires_in: number
  interval: number
}

export interface AccountCreationContext {
  body: CreateAccountBody
  label: string
  registerDeviceFlow(flow: AccountDeviceFlow, label: string): void
}

export type AccountCreationResult =
  | ManagedConnectionInput
  | { error: string; status?: 400 | 502 }
  | { response: Record<string, unknown> }

/** Providers prepare credentials; the host owns persistence and account views. */
export interface ProviderAccountCreation {
  prepare(
    context: AccountCreationContext,
  ): AccountCreationResult | Promise<AccountCreationResult>
  afterCreate?(connection: ProviderConnection): void | Promise<void>
}
