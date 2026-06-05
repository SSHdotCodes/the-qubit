#!/usr/bin/env bash
set -euo pipefail

PROJECT_NAME="the-qubit"
DEFAULT_MODEL="omni-moderation-latest"

if ! command -v rasppost >/dev/null 2>&1; then
  echo "rasppost was not found on PATH."
  echo "Open a new terminal or run: source ~/.zshrc"
  exit 1
fi

echo "Set OpenAI moderation env vars for ${PROJECT_NAME} on the Raspberry Pi."
echo

read -r -s -p "OPENAI_API_KEY: " OPENAI_API_KEY_VALUE
echo
read -r -p "OPENAI_MODERATION_MODEL [${DEFAULT_MODEL}]: " OPENAI_MODERATION_MODEL_VALUE
echo

if [[ -z "${OPENAI_API_KEY_VALUE}" ]]; then
  echo "No key entered; nothing changed."
  exit 1
fi

OPENAI_MODERATION_MODEL_VALUE="${OPENAI_MODERATION_MODEL_VALUE:-${DEFAULT_MODEL}}"

{
  printf 'OPENAI_API_KEY=%s\n' "${OPENAI_API_KEY_VALUE}"
  printf 'OPENAI_MODERATION_MODEL=%s\n' "${OPENAI_MODERATION_MODEL_VALUE}"
} | rasppost env import "${PROJECT_NAME}"

rasppost restart "${PROJECT_NAME}"

echo
echo "Updated ${PROJECT_NAME} OpenAI moderation env and restarted it."
rasppost status "${PROJECT_NAME}"
