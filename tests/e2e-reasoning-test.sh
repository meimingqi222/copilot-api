#!/bin/bash
# E2E test: Verify thinking/reasoning is visible via Anthropic protocol
# for Responses API-only models like gpt-5.1-codex-mini
#
# Usage: COPILOT_API_URL=http://localhost:4141 bash tests/e2e-reasoning-test.sh
#
# Requires a running copilot-api instance with valid GitHub token.

set -euo pipefail

BASE_URL="${COPILOT_API_URL:-http://localhost:4141}"
API_KEY="${COPILOT_API_KEY:-}"
MODEL="${TEST_MODEL:-gpt-5.1-codex-mini}"

AUTH_HEADER=""
if [ -n "$API_KEY" ]; then
  AUTH_HEADER="Authorization: Bearer $API_KEY"
fi

echo "=== E2E Reasoning Test ==="
echo "Base URL: $BASE_URL"
echo "Model:    $MODEL"
echo ""

# ---------- Test 1: Non-streaming ----------
echo "--- Test 1: Non-streaming Anthropic request with thinking ---"

NON_STREAM_RESPONSE=$(curl -s -X POST "$BASE_URL/v1/messages" \
  -H "Content-Type: application/json" \
  -H "anthropic-version: 2023-06-01" \
  ${AUTH_HEADER:+-H "$AUTH_HEADER"} \
  -d "{
    \"model\": \"$MODEL\",
    \"max_tokens\": 1024,
    \"thinking\": {\"type\": \"enabled\", \"budget_tokens\": 10000},
    \"messages\": [{\"role\": \"user\", \"content\": \"What is 15 * 27? Think step by step.\"}]
  }")

echo "Response:"
echo "$NON_STREAM_RESPONSE" | python3 -m json.tool 2>/dev/null || echo "$NON_STREAM_RESPONSE"

# Check for thinking blocks
THINKING_COUNT=$(echo "$NON_STREAM_RESPONSE" | python3 -c "
import json, sys
try:
    resp = json.load(sys.stdin)
    content = resp.get('content', [])
    thinking = [b for b in content if b.get('type') == 'thinking']
    text = [b for b in content if b.get('type') == 'text']
    print(f'thinking_blocks={len(thinking)} text_blocks={len(text)}')
    if thinking:
        print('✅ PASS: Thinking blocks found in non-streaming response')
        for t in thinking:
            preview = t.get('thinking', '')[:200]
            print(f'   thinking: {preview}...')
    else:
        print('❌ FAIL: No thinking blocks in non-streaming response')
    if text:
        for t in text:
            print(f'   text: {t.get(\"text\", \"\")[:200]}')
except Exception as e:
    print(f'Error parsing response: {e}')
" 2>&1)

echo "$THINKING_COUNT"
echo ""

# ---------- Test 2: Streaming ----------
echo "--- Test 2: Streaming Anthropic request with thinking ---"

STREAM_RESPONSE=$(curl -s -N -X POST "$BASE_URL/v1/messages" \
  -H "Content-Type: application/json" \
  -H "anthropic-version: 2023-06-01" \
  ${AUTH_HEADER:+-H "$AUTH_HEADER"} \
  -d "{
    \"model\": \"$MODEL\",
    \"max_tokens\": 1024,
    \"stream\": true,
    \"thinking\": {\"type\": \"enabled\", \"budget_tokens\": 10000},
    \"messages\": [{\"role\": \"user\", \"content\": \"What is 15 * 27? Think step by step.\"}]
  }" 2>&1)

echo "Raw SSE events (first 3000 chars):"
echo "${STREAM_RESPONSE:0:3000}"
echo ""

# Parse SSE stream for thinking events
echo "$STREAM_RESPONSE" | python3 -c "
import sys

lines = sys.stdin.read().strip().split('\n')
thinking_starts = 0
thinking_deltas = 0
text_starts = 0
text_deltas = 0
thinking_text = ''
output_text = ''

for line in lines:
    if line.startswith('data: '):
        import json
        try:
            data = json.loads(line[6:])
            event_type = data.get('type', '')

            if event_type == 'content_block_start':
                block = data.get('content_block', {})
                if block.get('type') == 'thinking':
                    thinking_starts += 1
                elif block.get('type') == 'text':
                    text_starts += 1

            elif event_type == 'content_block_delta':
                delta = data.get('delta', {})
                if delta.get('type') == 'thinking_delta':
                    thinking_deltas += 1
                    thinking_text += delta.get('thinking', '')
                elif delta.get('type') == 'text_delta':
                    text_deltas += 1
                    output_text += delta.get('text', '')
        except json.JSONDecodeError:
            pass

print(f'thinking_block_starts={thinking_starts}')
print(f'thinking_deltas={thinking_deltas}')
print(f'text_block_starts={text_starts}')
print(f'text_deltas={text_deltas}')
print()
if thinking_starts > 0:
    print('✅ PASS: Thinking blocks found in streaming response')
    print(f'   thinking preview: {thinking_text[:300]}...')
else:
    print('❌ FAIL: No thinking blocks in streaming response')
if text_starts > 0:
    print(f'   output preview: {output_text[:300]}')
" 2>&1

# ---------- Test 3: adaptive thinking + reasoning_effort null ----------
echo "--- Test 3: Anthropic adaptive thinking + reasoning_effort null ---"

NON_STREAM_ADAPTIVE=$(curl -s -X POST "$BASE_URL/v1/messages" \
  -H "Content-Type: application/json" \
  -H "anthropic-version: 2023-06-01" \
  ${AUTH_HEADER:+-H "$AUTH_HEADER"} \
  -d "{
    \"model\": \"$MODEL\",
    \"max_tokens\": 1024,
    \"thinking\": {\"type\": \"adaptive\"},
    \"reasoning_effort\": null,
    \"messages\": [{\"role\": \"user\", \"content\": \"What is 15 * 27? Think step by step.\"}]
  }")

echo "Response:"
echo "$NON_STREAM_ADAPTIVE" | python3 -m json.tool 2>/dev/null || echo "$NON_STREAM_ADAPTIVE"

echo "$NON_STREAM_ADAPTIVE" | python3 -c "
import json, sys
try:
    resp = json.load(sys.stdin)
    content = resp.get('content', [])
    thinking = [b for b in content if b.get('type') == 'thinking']
    text = [b for b in content if b.get('type') == 'text']
    print(f'thinking_blocks={len(thinking)} text_blocks={len(text)}')
    if thinking:
        print('✅ PASS: Thinking blocks found (adaptive + reasoning_effort=null → high)')
        for t in thinking:
            preview = t.get('thinking', '')[:200]
            print(f'   thinking: {preview}...')
    else:
        print('❌ FAIL: No thinking blocks (adaptive thinking not mapped to high)')
    if text:
        for t in text:
            print(f'   text: {t.get(\"text\", \"\")[:200]}')
except Exception as e:
    print(f'Error parsing response: {e}')
" 2>&1

echo ""

# ---------- Test 4: Streaming adaptive thinking + reasoning_effort null ----------
echo "--- Test 4: Streaming adaptive thinking + reasoning_effort null ---"

STREAM_ADAPTIVE=$(curl -s -N -X POST "$BASE_URL/v1/messages" \
  -H "Content-Type: application/json" \
  -H "anthropic-version: 2023-06-01" \
  ${AUTH_HEADER:+-H "$AUTH_HEADER"} \
  -d "{
    \"model\": \"$MODEL\",
    \"max_tokens\": 1024,
    \"stream\": true,
    \"thinking\": {\"type\": \"adaptive\"},
    \"reasoning_effort\": null,
    \"messages\": [{\"role\": \"user\", \"content\": \"What is 15 * 27? Think step by step.\"}]
  }" 2>&1)

echo "$STREAM_ADAPTIVE" | python3 -c "
import sys, json

lines = sys.stdin.read().strip().split('\n')
thinking_starts = 0
thinking_deltas = 0
text_starts = 0
text_deltas = 0
thinking_text = ''
output_text = ''

for line in lines:
    if line.startswith('data: '):
        try:
            data = json.loads(line[6:])
            event_type = data.get('type', '')
            if event_type == 'content_block_start':
                block = data.get('content_block', {})
                if block.get('type') == 'thinking':
                    thinking_starts += 1
                elif block.get('type') == 'text':
                    text_starts += 1
            elif event_type == 'content_block_delta':
                delta = data.get('delta', {})
                if delta.get('type') == 'thinking_delta':
                    thinking_deltas += 1
                    thinking_text += delta.get('thinking', '')
                elif delta.get('type') == 'text_delta':
                    text_deltas += 1
                    output_text += delta.get('text', '')
        except json.JSONDecodeError:
            pass

print(f'thinking_block_starts={thinking_starts} thinking_deltas={thinking_deltas}')
print(f'text_block_starts={text_starts} text_deltas={text_deltas}')
if thinking_starts > 0:
    print('✅ PASS: Streaming thinking blocks found (adaptive → high)')
    print(f'   thinking preview: {thinking_text[:300]}...')
else:
    print('❌ FAIL: No streaming thinking blocks (adaptive → high)')
if text_starts > 0:
    print(f'   output preview: {output_text[:300]}')
" 2>&1

echo ""
echo "=== E2E Test Complete ==="
