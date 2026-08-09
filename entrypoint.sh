#!/bin/sh
# Memory policy for small hosts (1GB VPS and similar).
#
# Bun/JSC sizes its heap budget from total system RAM and grows monotonically:
# without a ceiling, RSS ratchets up across requests until the kernel OOM
# killer fires, which presents as the whole box hanging rather than a clean
# crash. `--smol` selects the low-memory heap policy (smaller eden, more
# aggressive return of freed pages); BUN_JSC_forceRAMSize pins the budget JSC
# believes it has, in bytes, instead of letting it infer one.
#
# Set BUN_MEMORY_LIMIT_MB to match the host; set it to 0 to opt out entirely.
: "${BUN_MEMORY_LIMIT_MB:=512}"

BUN_FLAGS=""
if [ -n "$BUN_MEMORY_LIMIT_MB" ] && [ "$BUN_MEMORY_LIMIT_MB" -gt 0 ] 2>/dev/null; then
  BUN_FLAGS="--smol"
  BUN_JSC_forceRAMSize=$((BUN_MEMORY_LIMIT_MB * 1024 * 1024))
  export BUN_JSC_forceRAMSize
fi

if [ "$1" = "--auth" ]; then
  # Run auth command
  exec bun $BUN_FLAGS run dist/main.js auth
else
  # Default command
  exec bun $BUN_FLAGS run dist/main.js start -g "$GH_TOKEN" "$@"
fi
