#!/usr/bin/env bash
set -euo pipefail
if [[ $# -lt 1 || $# -gt 2 ]]; then
  echo "Usage: bun run android:install ADB_SERIAL [--release]" >&2
  exit 1
fi
device_serial="$1"
variant="debug"
if [[ "${2:-}" == "--release" ]]; then
  variant="release"
elif [[ -n "${2:-}" ]]; then
  echo "Unknown install option: $2" >&2
  exit 1
fi
project_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
android_root="$project_root/android"
artifact_stem="$(basename "$project_root" | tr -cs 'A-Za-z0-9._-' '-')"
artifact_stem="${artifact_stem#-}"
artifact_stem="${artifact_stem%-}"
artifact_stem="${artifact_stem:-gpuix-android}"
apk_path="$project_root/dist/android/$artifact_stem-$variant.apk"
[[ -f "$apk_path" ]] || { echo "Build the Android APK first." >&2; exit 1; }
app_id="$(bun "$android_root/scripts/config.ts" --field appId --project "$project_root")"
activity_name="${GPUIX_ANDROID_ACTIVITY:-dev.gpui.mobile.GpuiActivity}"
adb -s "$device_serial" get-state
adb -s "$device_serial" shell am force-stop "$app_id"
apk_size="$(stat -f '%z' "$apk_path")"
remote_apk="/data/local/tmp/$artifact_stem-$variant.apk"
adb -s "$device_serial" push "$apk_path" "$remote_apk"
session_output="$(adb -s "$device_serial" shell pm install-create -r -S "$apk_size")"
session_id="$(printf '%s\n' "$session_output" | sed -n 's/.*\[\([0-9][0-9]*\)\].*/\1/p')"
[[ -n "$session_id" ]] || { echo "$session_output" >&2; exit 1; }
cleanup_session() {
  adb -s "$device_serial" shell pm install-abandon "$session_id" >/dev/null 2>&1 || true
}
trap cleanup_session EXIT
adb -s "$device_serial" shell pm install-write -S "$apk_size" "$session_id" base "$remote_apk"
adb -s "$device_serial" shell pm install-commit "$session_id"
trap - EXIT
adb -s "$device_serial" shell am force-stop "$app_id"
adb -s "$device_serial" shell am start -W -n "$app_id/$activity_name"
