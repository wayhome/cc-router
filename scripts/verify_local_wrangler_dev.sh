#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

if [[ ! -f .env ]]; then
  echo "ERROR: .env not found at $ROOT_DIR/.env" >&2
  exit 1
fi

set -a
source .env
set +a

if [[ -z "${CCR_API_KEY:-}" ]]; then
  if [[ -n "${ANTHROPIC_AUTH_TOKEN:-}" ]]; then
    export CCR_API_KEY="$ANTHROPIC_AUTH_TOKEN"
  elif [[ -n "${OPENAI_API_KEY:-}" ]]; then
    export CCR_API_KEY="$OPENAI_API_KEY"
  fi
fi

: "${CCR_API_KEY:?Please set CCR_API_KEY in .env (or ANTHROPIC_AUTH_TOKEN/OPENAI_API_KEY)}"

PORT="${CCR_LOCAL_PORT:-8787}"
LOCAL_BASE_URL="http://127.0.0.1:${PORT}"
WRANGLER_HOME_DIR="${WRANGLER_HOME_DIR:-/tmp/wrangler-home-${USER:-codex}}"
LOG_FILE="$(mktemp /tmp/wrangler-dev-log.XXXXXX)"
PID_FILE="$(mktemp /tmp/wrangler-dev-pid.XXXXXX)"

cleanup() {
  if [[ -f "$PID_FILE" ]]; then
    pid="$(cat "$PID_FILE" 2>/dev/null || true)"
    if [[ -n "${pid:-}" ]] && ps -p "$pid" >/dev/null 2>&1; then
      kill "$pid" >/dev/null 2>&1 || true
      wait "$pid" 2>/dev/null || true
    fi
  fi
  rm -f "$PID_FILE"
}
trap cleanup EXIT

mkdir -p "$WRANGLER_HOME_DIR"

echo "Starting wrangler dev on ${LOCAL_BASE_URL} ..."
HOME="$WRANGLER_HOME_DIR" wrangler dev \
  --local \
  --ip 127.0.0.1 \
  --port "$PORT" \
  --log-level error \
  --show-interactive-dev-session=false \
  >"$LOG_FILE" 2>&1 &
echo $! >"$PID_FILE"

echo "Waiting for local worker to be ready ..."
ready=0
for _ in $(seq 1 60); do
  if curl -sS --max-time 2 \
    -H "Authorization: Bearer $CCR_API_KEY" \
    "${LOCAL_BASE_URL}/codex/v1/models" >/dev/null 2>&1; then
    ready=1
    break
  fi
  sleep 1
done

if [[ "$ready" != "1" ]]; then
  echo "ERROR: wrangler dev did not become ready in time." >&2
  echo "----- wrangler dev log tail -----" >&2
  tail -n 120 "$LOG_FILE" >&2 || true
  exit 1
fi

echo "Running local verification suite ..."
CCR_BASE_URL="$LOCAL_BASE_URL" \
CCR_API_KEY="$CCR_API_KEY" \
bash scripts/verify_codex_chat_completions.sh

echo "Local wrangler dev verification passed."
