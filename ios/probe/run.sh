#!/usr/bin/env bash
# Builds the probe and runs it on a booted simulator, streaming its samples.
# Usage: ios/probe/run.sh [device-name]
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
device="${1:-iPhone 17 Pro}"
remote_json="$HOME/Library/Application Support/com.argmax.rs/remote.json"

[ -f "$remote_json" ] || { echo "no remote.json — enable Settings > Integrations > Remote access" >&2; exit 1; }
port=$(python3 -c "import json,sys;print(json.load(open(sys.argv[1]))['port'])" "$remote_json")
token=$(python3 -c "import json,sys;print(json.load(open(sys.argv[1]))['token'])" "$remote_json")

curl -sf -o /dev/null "http://127.0.0.1:$port/mobile.html" \
  || { echo "bridge not answering on $port" >&2; exit 1; }

sdk=$(xcrun --sdk iphonesimulator --show-sdk-path)
app="$here/build/Probe.app"
rm -rf "$app" && mkdir -p "$app"
swiftc -sdk "$sdk" -target arm64-apple-ios17.0-simulator -parse-as-library \
  -o "$app/Probe" "$here/Probe.swift"
cp "$here/Info.plist" "$app/Info.plist"

xcrun simctl boot "$device" 2>/dev/null || true
xcrun simctl bootstatus "$device" -b
open -a Simulator
xcrun simctl install "$device" "$app"
# The simulator reaches the host's loopback directly, so no tailnet is needed
# to answer the viewport and keyboard questions.
# simctl passes environment through the SIMCTL_CHILD_ prefix, not a flag.
SIMCTL_CHILD_PROBE_URL="http://127.0.0.1:$port/mobile.html#token=$token" \
  xcrun simctl launch --console-pty --terminate-running-process \
  "$device" com.argmax.probe
