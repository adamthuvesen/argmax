#!/bin/sh
prompt="${FAKE_PROVIDER_PROMPT:-hello}"
prompt_oneline="$(printf '%s' "$prompt" | tr '\n' ' ')"
printf '{"type":"content_block_delta","delta":{"text":"fake cli: %s"}}\n' "$prompt_oneline"
