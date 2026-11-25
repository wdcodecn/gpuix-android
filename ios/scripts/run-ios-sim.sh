#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "$0")/../.." && pwd)"
ios_root="$repo_root/ios"
export DEVELOPER_DIR="${DEVELOPER_DIR:-/Applications/Xcode.app/Contents/Developer}"

project_root="${GPUIX_PROJECT_ROOT:-$(cd "$repo_root/../gpuix-base-ui" && pwd)}"
entry_override="${GPUIX_ENTRY:-}"
device_query="${GPUIX_IOS_DEVICE:-}"
build_flags=()

while [[ $# -gt 0 ]]; do
  case "$1" in
    --project|--cwd)
      project_root="$(cd "$2" && pwd)"
      shift 2
      ;;
    --entry)
      entry_override="$2"
      shift 2
      ;;
    --device)
      device_query="$2"
      shift 2
      ;;
    --release|--debug|--js-only|--no-hbc)
      build_flags+=("$1")
      shift
      ;;
    *)
      echo "Usage: bash ios/scripts/run-ios-sim.sh [--project DIR] [--entry FILE] [--device NAME_OR_UDID] [--release] [--js-only]" >&2
      exit 1
      ;;
  esac
done

build_args=(--project "$project_root")
if [[ -n "$entry_override" ]]; then
  build_args+=(--entry "$entry_override")
fi
if (( ${#build_flags[@]} > 0 )); then
  build_args+=("${build_flags[@]}")
fi

bash "$ios_root/scripts/build-ios.sh" "${build_args[@]}"

bundle_id="$(bun "$repo_root/scripts/config.ts" --field iosBundleId --project "$project_root")"
artifact_stem="$(basename "$project_root" | tr -cs 'A-Za-z0-9._-' '-')"
artifact_stem="${artifact_stem#-}"
artifact_stem="${artifact_stem%-}"
artifact_stem="${artifact_stem:-gpuix-mobile}"
out_dir="${GPUIX_OUT_DIR:-$project_root/dist/ios}"
app_bundle="$out_dir/$artifact_stem.app"

udid="$(
  GPUIX_DEVICE_QUERY="$device_query" DEVELOPER_DIR="$DEVELOPER_DIR" bun -e '
    const { execFileSync } = require("node:child_process");
    const query = (process.env.GPUIX_DEVICE_QUERY || "").trim();
    const raw = execFileSync("xcrun", ["simctl", "list", "devices", "available", "--json"], { encoding: "utf8" });
    const data = JSON.parse(raw);
    const devices = [];
    for (const [runtime, list] of Object.entries(data.devices || {})) {
      if (!runtime.includes("iOS")) continue;
      for (const dev of list) {
        if (dev.isAvailable && dev.name.includes("iPhone")) {
          devices.push(dev);
        }
      }
    }
    let chosen = null;
    if (query) {
      chosen = devices.find((d) => d.udid === query || d.name === query) || devices.find((d) => d.name.includes(query));
    }
    if (!chosen) {
      chosen = devices.find((d) => d.state === "Booted") || devices.find((d) => d.name === "iPhone 18 Pro") || devices.find((d) => d.name === "iPhone 17") || devices[0];
    }
    if (!chosen) process.exit(1);
    process.stdout.write(chosen.udid + "\n");
  '
)"

echo "Target simulator UDID: $udid ($bundle_id)"
xcrun simctl boot "$udid" >/dev/null 2>&1 || true
xcrun simctl bootstatus "$udid" -b
open -a "$DEVELOPER_DIR/Applications/Simulator.app" >/dev/null 2>&1 || true

xcrun simctl install "$udid" "$app_bundle"
launch_log="$ios_root/.build/launch.log"
mkdir -p "$(dirname "$launch_log")"
: > "$launch_log"
xcrun simctl terminate "$udid" "$bundle_id" >/dev/null 2>&1 || true
pid_out="$(xcrun simctl launch --stdout="$launch_log" --stderr="$launch_log" "$udid" "$bundle_id")"
echo "Launched: $pid_out"

sleep 4
screenshot_path="$ios_root/.build/ios-sim-screenshot.png"
xcrun simctl io "$udid" screenshot "$screenshot_path"
echo "Screenshot saved: $screenshot_path"
echo "=== LOG TAIL ==="
cat "$launch_log" 2>/dev/null || true
