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

echo "[0/3] Models request..."
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

echo "[0.5/3] Model detail request..."
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

echo "[1/3] Non-stream request..."
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

echo "[2/4] Stream request..."
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

echo "[3/4] Tools request..."
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

echo "OK: /codex/v1/models + /codex/v1/chat/completions (non-stream + stream + tools) passed"
