#!/bin/sh
prompt="${FAKE_PROVIDER_PROMPT:-hello}"
printf '{"type":"content_block_delta","delta":{"text":"fake cli: %s"}}\n' "$prompt"
