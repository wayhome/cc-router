#!/usr/bin/env bash
set -euo pipefail

: "${CCR_BASE_URL:?Please set CCR_BASE_URL, e.g. https://your-worker.workers.dev}"
: "${CCR_API_KEY:?Please set CCR_API_KEY}"

BASE_URL="${CCR_BASE_URL%/}"
MODEL="${CCR_MODEL:-gpt-5.3-codex}"
PROMPT="${CCR_PROMPT:-Reply with exactly: pong}"

tmp_dir="$(mktemp -d)"
trap 'rm -rf "$tmp_dir"' EXIT

nonstream_headers="$tmp_dir/nonstream.headers"
nonstream_body="$tmp_dir/nonstream.body"
stream_headers="$tmp_dir/stream.headers"
stream_body="$tmp_dir/stream.body"
models_headers="$tmp_dir/models.headers"
models_body="$tmp_dir/models.body"
model_detail_headers="$tmp_dir/model-detail.headers"
model_detail_body="$tmp_dir/model-detail.body"
tools_headers="$tmp_dir/tools.headers"
tools_body="$tmp_dir/tools.body"
force_tools_headers="$tmp_dir/force-tools.headers"
force_tools_body="$tmp_dir/force-tools.body"
force_fail_headers="$tmp_dir/force-fail.headers"
force_fail_body="$tmp_dir/force-fail.body"

echo "[1/5] Models request..."
curl -sS \
  -D "$models_headers" \
  -o "$models_body" \
  -H "Authorization: Bearer $CCR_API_KEY" \
  "$BASE_URL/codex/v1/models"

models_status="$(head -n 1 "$models_headers" | awk '{print $2}')"
if [[ "$models_status" != "200" ]]; then
  echo "Models failed with status: $models_status"
  cat "$models_body"
  exit 1
fi

grep -qi '^x-route-type:[[:space:]]*codex' "$models_headers"
grep -q '"object"[[:space:]]*:[[:space:]]*"list"' "$models_body"
grep -q '"gpt-5.4"' "$models_body"
grep -q '"gpt-5.3-codex"' "$models_body"
grep -q '"context_length"[[:space:]]*:[[:space:]]*400000' "$models_body"

echo "[2/5] Model detail request..."
curl -sS \
  -D "$model_detail_headers" \
  -o "$model_detail_body" \
  -H "Authorization: Bearer $CCR_API_KEY" \
  "$BASE_URL/codex/v1/models/$MODEL"

model_detail_status="$(head -n 1 "$model_detail_headers" | awk '{print $2}')"
if [[ "$model_detail_status" != "200" ]]; then
  echo "Model detail failed with status: $model_detail_status"
  cat "$model_detail_body"
  exit 1
fi

grep -qi '^x-route-type:[[:space:]]*codex' "$model_detail_headers"
grep -q "\"id\"[[:space:]]*:[[:space:]]*\"$MODEL\"" "$model_detail_body"
grep -q '"context_length"[[:space:]]*:[[:space:]]*400000' "$model_detail_body"
grep -q '"max_output_tokens"[[:space:]]*:[[:space:]]*128000' "$model_detail_body"

echo "[3/5] Non-stream request..."
curl -sS \
  -D "$nonstream_headers" \
  -o "$nonstream_body" \
  -H "Authorization: Bearer $CCR_API_KEY" \
  -H "Content-Type: application/json" \
  "$BASE_URL/codex/v1/chat/completions" \
  -d "{
    \"model\": \"$MODEL\",
    \"stream\": false,
    \"messages\": [{\"role\": \"user\", \"content\": \"$PROMPT\"}]
  }"

nonstream_status="$(head -n 1 "$nonstream_headers" | awk '{print $2}')"
if [[ "$nonstream_status" != "200" ]]; then
  echo "Non-stream failed with status: $nonstream_status"
  cat "$nonstream_body"
  exit 1
fi

grep -qi '^x-route-type:[[:space:]]*codex' "$nonstream_headers"
grep -qi '^x-format-conversion:[[:space:]]*openai-chat<->codex-responses' "$nonstream_headers"
grep -q '"object"[[:space:]]*:[[:space:]]*"chat.completion"' "$nonstream_body"
grep -q '"choices"' "$nonstream_body"

echo "[4/5] Stream request..."
curl -sS -N \
  -D "$stream_headers" \
  -o "$stream_body" \
  -H "Authorization: Bearer $CCR_API_KEY" \
  -H "Content-Type: application/json" \
  "$BASE_URL/codex/v1/chat/completions" \
  -d "{
    \"model\": \"$MODEL\",
    \"stream\": true,
    \"messages\": [{\"role\": \"user\", \"content\": \"$PROMPT\"}]
  }"

stream_status="$(head -n 1 "$stream_headers" | awk '{print $2}')"
if [[ "$stream_status" != "200" ]]; then
  echo "Stream failed with status: $stream_status"
  cat "$stream_body"
  exit 1
fi

grep -qi '^x-route-type:[[:space:]]*codex' "$stream_headers"
grep -qi '^x-format-conversion:[[:space:]]*openai-chat<->codex-responses' "$stream_headers"
grep -q 'chat.completion.chunk' "$stream_body"
grep -q 'data: \[DONE\]' "$stream_body"

echo "[5/5] Tools request..."
curl -sS \
  -D "$tools_headers" \
  -o "$tools_body" \
  -H "Authorization: Bearer $CCR_API_KEY" \
  -H "Content-Type: application/json" \
  "$BASE_URL/codex/v1/chat/completions" \
  -d "{
    \"model\": \"$MODEL\",
    \"stream\": false,
    \"tool_choice\": \"required\",
    \"messages\": [{\"role\": \"user\", \"content\": \"Call the function only.\"}],
    \"tools\": [{
      \"type\": \"function\",
      \"function\": {
        \"name\": \"get_time\",
        \"description\": \"Return current time\",
        \"parameters\": {
          \"type\": \"object\",
          \"properties\": {},
          \"additionalProperties\": false
        }
      }
    }]
  }"

tools_status="$(head -n 1 "$tools_headers" | awk '{print $2}')"
if [[ "$tools_status" != "200" ]]; then
  echo "Tools request failed with status: $tools_status"
  cat "$tools_body"
  exit 1
fi

grep -qi '^x-route-type:[[:space:]]*codex' "$tools_headers"
grep -q '"tool_calls"' "$tools_body"
grep -q '"finish_reason"[[:space:]]*:[[:space:]]*"tool_calls"' "$tools_body"

echo "[Extra] Claude /v1/messages stream + x-force-codex + tools..."
curl -sS \
  -D "$force_tools_headers" \
  -o "$force_tools_body" \
  -H "Authorization: Bearer $CCR_API_KEY" \
  -H "x-api-key: $CCR_API_KEY" \
  -H "anthropic-version: 2023-06-01" \
  -H "x-force-codex: true" \
  -H "Content-Type: application/json" \
  "$BASE_URL/v1/messages" \
  -d "{
    \"model\": \"claude-sonnet-4-6\",
    \"stream\": true,
    \"max_tokens\": 512,
    \"messages\": [{\"role\": \"user\", \"content\": \"Call get_time tool only.\"}],
    \"tools\": [{
      \"name\": \"get_time\",
      \"description\": \"Return current time\",
      \"input_schema\": {
        \"type\": \"object\",
        \"properties\": {},
        \"additionalProperties\": false
      }
    }],
    \"tool_choice\": {\"type\": \"any\"}
  }"

force_tools_status="$(head -n 1 "$force_tools_headers" | awk '{print $2}')"
if [[ "$force_tools_status" != "200" ]]; then
  echo "Force-codex tools request failed with status: $force_tools_status"
  cat "$force_tools_body"
  exit 1
fi

grep -qi '^x-route-type:[[:space:]]*codex-fallback' "$force_tools_headers"
grep -qi '^content-type:[[:space:]]*text/event-stream' "$force_tools_headers"
grep -q 'event: content_block_start' "$force_tools_body"
grep -q '"type":"tool_use"' "$force_tools_body"
grep -q '"stop_reason":"tool_use"' "$force_tools_body"

echo "[Extra] Forced codex failure should NOT fallback to Claude..."
curl -sS \
  -D "$force_fail_headers" \
  -o "$force_fail_body" \
  -H "Authorization: Bearer invalid-force-codex-key" \
  -H "x-api-key: invalid-force-codex-key" \
  -H "anthropic-version: 2023-06-01" \
  -H "x-force-codex: true" \
  -H "Content-Type: application/json" \
  "$BASE_URL/v1/messages" \
  -d "{
    \"model\": \"claude-sonnet-4-6\",
    \"stream\": false,
    \"max_tokens\": 64,
    \"messages\": [{\"role\": \"user\", \"content\": \"ping\"}]
  }"

force_fail_status="$(head -n 1 "$force_fail_headers" | awk '{print $2}')"
if [[ "$force_fail_status" == "200" ]]; then
  echo "Forced-codex failure probe unexpectedly succeeded"
  cat "$force_fail_body"
  exit 1
fi

grep -qi '^x-route-type:[[:space:]]*codex-fallback' "$force_fail_headers"
grep -qi '^x-fallback-reason:[[:space:]]*forced-by-header' "$force_fail_headers"
if grep -qi '^x-route-type:[[:space:]]*claude' "$force_fail_headers"; then
  echo "Forced-codex failure probe incorrectly fell back to Claude route"
  cat "$force_fail_headers"
  cat "$force_fail_body"
  exit 1
fi

echo "OK: models + chat.completions(non-stream/stream/tools) + forced codex tools + forced failure semantics passed"
