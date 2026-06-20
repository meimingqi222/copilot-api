#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BACKUP="${BACKUP:-/tmp/copilot-oauth-backup/tree}"
cd "$ROOT"

copy_paths() {
  for path in "$@"; do
    if [[ ! -e "$BACKUP/$path" ]]; then
      continue
    fi
    rm -rf "$path"
    mkdir -p "$(dirname "$path")"
    cp -R "$BACKUP/$path" "$path"
  done
}

commit_pr() {
  local msg="$1"
  git add -A
  if git diff --cached --quiet; then
    echo "skip empty commit: $msg"
    return 0
  fi
  git commit --no-verify -m "$msg"
}

base_branch="${1:-origin/master}"

echo "==> PR1 foundation"
git checkout -B feat/oauth/pr1-foundation "$base_branch"
copy_paths \
  src/services/oauth \
  src/lib/quota \
  src/lib/account-store.ts \
  src/lib/accounts.ts \
  src/lib/paths.ts \
  src/lib/provider-config.ts \
  src/services/providers/oauth.ts \
  src/services/providers/index.ts \
  src/services/codex/get-models.ts \
  src/services/antigravity/get-models.ts \
  src/routes/admin/api/account-import.ts \
  src/routes/admin/api/account-update.ts \
  src/routes/admin/api/accounts.ts \
  pages/js/api.js \
  tests/cpa-import.test.ts \
  tests/oauth-fetch.test.ts \
  tests/oauth-refresh-proxy.test.ts \
  tests/account-store.test.ts
commit_pr "feat(oauth): PR1 OAuth foundation and CPA import"

echo "==> PR2 claude + kimi"
git checkout -B feat/oauth/pr2-claude-kimi
copy_paths \
  src/services/claude \
  src/services/kimi \
  src/services/protocols/claude-native.ts \
  src/services/protocols/kimi-native.ts \
  src/services/protocols/index.ts \
  src/services/providers/delegate.ts \
  src/lib/request-admission.ts \
  src/lib/route-target \
  src/lib/provider-connections/types.ts \
  src/lib/utils.ts \
  src/routes/admin/api/oauth.ts \
  src/routes/admin/route.ts \
  pages/js/views/accounts.js \
  pages/js/i18n.js \
  pages/index.html \
  tests/oauth-claude-kimi.test.ts \
  tests/oauth-ensure-access-token.test.ts
commit_pr "feat(oauth): PR2 Claude and Kimi OAuth login and native adapters"

echo "==> PR3 codex + xai"
git checkout -B feat/oauth/pr3-codex-xai
copy_paths \
  src/services/codex \
  src/services/xai \
  src/services/protocols/codex-native.ts \
  src/services/protocols/xai-native.ts \
  src/routes/admin/api/quota.ts \
  tests/oauth-codex-xai.test.ts
commit_pr "feat(oauth): PR3 Codex and xAI Responses API providers"

echo "==> PR4 antigravity"
git checkout -B feat/oauth/pr4-antigravity
copy_paths \
  src/services/antigravity \
  src/services/protocols/antigravity-native.ts \
  src/services/responses \
  src/services/copilot/responses-api-types.ts \
  tests/oauth-antigravity.test.ts
commit_pr "feat(oauth): PR4 Antigravity Gemini native provider"

echo "==> PR5 quota admin UI"
git checkout -B feat/oauth/pr5-quota-ui
copy_paths \
  pages/css/apple-theme.css \
  pages/js/views/quota.js \
  pages/js/quota-display.js \
  pages/js/i18n.js \
  pages/index.html
commit_pr "feat(oauth): PR5 OAuth quota admin UI"

echo "==> PR6 routing and tests"
git checkout -B feat/oauth/pr6-routing-tests
copy_paths \
  src/routes/chat-completions/handler.ts \
  src/routes/messages/copilot-handler.ts \
  src/lib/sse.ts \
  src/lib/log-middleware.ts \
  src/lib/tokenizer.ts \
  tests/oauth-providers.test.ts \
  tests/oauth-smoke.test.ts \
  tests/forwarding-performance.test.ts
commit_pr "feat(oauth): PR6 model routing, streaming fixes, and smoke tests"

echo "==> verify final branch"
bun run typecheck
bun test tests/oauth-smoke.test.ts tests/oauth-*.test.ts tests/cpa-import.test.ts

echo "==> done"
git log --oneline origin/master..HEAD
