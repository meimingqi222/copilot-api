# Agent Note: Provider sign-in does not claim rewards

Status: implemented

## Problem

Magpie's plugins combine account setup and quota reads with daily check-in and reward claims. WorkBuddy CN also already wrote a daily check-in during device login. The requested integrations must not perform automatic check-in.

## Decision

Do not port reward-claim or daily check-in writes. `src/services/oauth/codebuddy.ts` completes device login after reading the account identity, without a third kind of request. Keep read-only balance and benefit history distinct from claiming a benefit.

## Alternatives considered

Keep the WorkBuddy CN login-time write on the basis that it is not a periodic job. It still claims rewards without a separate action by the account owner and would make behavior differ by provider.

## Consequences

The project does not claim these rewards. An account can still show balances and grant history the vendor has already recorded.

## Verification

- `tests/oauth-codebuddy.test.ts::pending then success returns full bundle` asserts exactly two token polls and one account lookup.
