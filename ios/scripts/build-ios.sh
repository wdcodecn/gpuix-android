#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "$0")/../.." && pwd)"
native_root="${GPUIX_NATIVE_ROOT:-$repo_root/native}"
ios_root="$repo_root/ios"
export DEVELOPER_DIR="${DEVELOPER_DIR:-/Applications/Xcode.app/Contents/Developer}"

project_root="${GPUIX_PROJECT_ROOT:-$(cd "$repo_root/../gpuix-base-ui" && pwd)}"
entry_override="${GPUIX_ENTRY:-}"
variant="debug"
fast_release=0
js_only=0
skip_hbc=0

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
    --release)
      variant="release"
      shift
      ;;
    --fast)
      fast_release=1
      shift
      ;;
    --debug)
      variant="debug"
      shift
      ;;
    --js-only)
      js_only=1
      shift
      ;;
    --no-hbc)
      skip_hbc=1
      shift
      ;;
    *)
      echo "Usage: bash ios/scripts/build-ios.sh [--project DIR] [--entry FILE] [--debug|--release] [--fast] [--js-only] [--no-hbc]" >&2
      exit 1
      ;;
  esac
done

cfg_json="$(
  GPUIX_CONFIG_ROOT="$repo_root/scripts/config.ts" GPUIX_PROJECT="$project_root" bun -e '
    import { loadGpuixConfig, resolveIosBundleId, resolveIosBuildNumber, resolveIosDeploymentTarget, resolveIosStatusBarStyle } from "./scripts/config.ts";
    const project = process.env.GPUIX_PROJECT;
    const cfg = await loadGpuixConfig(project);
    const out = {
      appName: cfg.appName,
      bundleId: resolveIosBundleId(cfg),
      versionName: cfg.versionName,
      buildNumber: resolveIosBuildNumber(cfg),
      deploymentTarget: resolveIosDeploymentTarget(cfg),
      statusBarStyle: resolveIosStatusBarStyle(cfg),
      features: cfg.features ?? null,
    };
    process.stdout.write(JSON.stringify(out));
  ' --cwd "$repo_root" 2>/dev/null || GPUIX_PROJECT="$project_root" bun -e '
    const path = require("node:path");
    const cfgMod = require(process.argv[1]);
    cfgMod.loadGpuixConfig(process.env.GPUIX_PROJECT).then((cfg) => {
      const slug = path.basename(process.env.GPUIX_PROJECT).toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "gpuix-app";
      process.stdout.write(JSON.stringify({
        appName: cfg.appName,
        bundleId: cfgMod.resolveIosBundleId(cfg),
        versionName: cfg.versionName,
        buildNumber: cfgMod.resolveIosBuildNumber(cfg),
        deploymentTarget: cfgMod.resolveIosDeploymentTarget(cfg),
        statusBarStyle: cfgMod.resolveIosStatusBarStyle(cfg),
        features: cfg.features ?? null,
        slug,
      }));
    });
  ' "$repo_root/scripts/config.ts"
)"

read_cfg_field() {
  local key="$1"
  CFG_JSON="$cfg_json" bun -e "const d = JSON.parse(process.env.CFG_JSON); const v = d['$key']; process.stdout.write(v === null || v === undefined ? '' : String(v));"
}

app_name="$(read_cfg_field appName)"
bundle_id="$(read_cfg_field bundleId)"
version_name="$(read_cfg_field versionName)"
build_number="$(read_cfg_field buildNumber)"
deploy_target="$(read_cfg_field deploymentTarget)"
status_bar_style="$(read_cfg_field statusBarStyle)"
artifact_stem="$(basename "$project_root" | tr -cs 'A-Za-z0-9._-' '-')"
artifact_stem="${artifact_stem#-}"
artifact_stem="${artifact_stem%-}"
artifact_stem="${artifact_stem:-gpuix-mobile}"

exec_name="$(CFG_NAME="$app_name" bun -e 'const s = (process.env.CFG_NAME || "").replace(/[^A-Za-z0-9]+/g, ""); process.stdout.write(s || "GPUIXApp");')"
ui_status_bar_style="UIStatusBarStyleLightContent"
if [[ "$status_bar_style" == "dark" ]]; then
  ui_status_bar_style="UIStatusBarStyleDarkContent"
fi

export GPUIX_IOS_DEPLOYMENT_TARGET="$deploy_target"
hermesc_bin="$native_root/.build/hermes-host/bin/hermesc"
hermes_dylib="$ios_root/.build/hermes-ios-sim/libgpuix_js.dylib"
if [[ ! -x "$hermesc_bin" || ! -f "$hermes_dylib" ]]; then
  bash "$ios_root/scripts/build-hermes-ios.sh"
fi

js_args=(--project "$project_root")
if [[ -n "$entry_override" ]]; then
  js_args+=(--entry "$entry_override")
fi
if [[ "$variant" == "release" ]]; then
  js_args+=(--release)
fi
if (( skip_hbc )); then
  js_args+=(--no-hbc)
fi
bun "$ios_root/scripts/build-js-ios.ts" "${js_args[@]}"

sim_sdk="$(xcrun --sdk iphonesimulator --show-sdk-path)"
export SDKROOT="$sim_sdk"
cache_root="${GPUIX_CACHE_DIR:-${XDG_CACHE_HOME:-$HOME/.cache}/gpuix-mobile}"
export CARGO_TARGET_DIR="${GPUIX_CARGO_TARGET_DIR:-$cache_root/cargo-target}"

zed_source="$native_root/.deps/zed"
if [[ ! -d "$zed_source/.git" && -d "$cache_root/deps/zed/.git" ]]; then
  mkdir -p "$(dirname "$zed_source")"
  rm -rf "$zed_source"
  ln -s "$cache_root/deps/zed" "$zed_source"
fi

rust_profile="ios-dev"
cargo_profile_flag=(--profile ios-dev)
if [[ "$variant" == "release" ]]; then
  if (( fast_release )); then
    rust_profile="release-fast"
    cargo_profile_flag=(--profile release-fast)
  else
    rust_profile="release"
    cargo_profile_flag=(--release)
  fi
fi
rust_lib="$CARGO_TARGET_DIR/aarch64-apple-ios-sim/$rust_profile/libgpuix_ios.a"

if (( ! js_only )) || [[ ! -f "$rust_lib" ]]; then
  cargo_features_arg=()
  if bun_features="$(bun "$repo_root/scripts/config.ts" --field features --project "$project_root" 2>/dev/null)"; then
    cfg_file=""
    if [[ -f "$project_root/gpuix.config.json" ]]; then
      cfg_file="$project_root/gpuix.config.json"
    elif [[ -f "$project_root/gpuix.android.json" ]]; then
      cfg_file="$project_root/gpuix.android.json"
    fi
    if [[ -n "$cfg_file" ]] && grep -q '"features"' "$cfg_file" 2>/dev/null; then
      if [[ -n "$bun_features" ]]; then
        cargo_features_arg=(--no-default-features --features "$bun_features")
      else
        cargo_features_arg=(--no-default-features)
      fi
    fi
  fi

  echo "Building libgpuix_ios.a for aarch64-apple-ios-sim ($rust_profile)..."
  (
    cd "$ios_root/rust"
    if [[ "${GPUIX_KEEP_RUSTC_WRAPPER:-0}" != "1" ]]; then
      case "$(basename "${RUSTC_WRAPPER:-}")" in
        sccache*) unset RUSTC_WRAPPER ;;
      esac
    fi
    nice -n 10 cargo +1.100.0 build --target aarch64-apple-ios-sim "${cargo_profile_flag[@]}" "${cargo_features_arg[@]}"
  )
fi

app_bundle="$ios_root/.build/$exec_name.app"
rm -rf "$app_bundle"
mkdir -p "$app_bundle/Frameworks" "$app_bundle/gpuix"

echo "Linking $exec_name.app ($bundle_id v$version_name ($build_number))..."
xcrun --sdk iphonesimulator clang \
  -target "arm64-apple-ios${deploy_target}-simulator" \
  -isysroot "$sim_sdk" \
  -fobjc-arc \
  -ObjC \
  -Wl,-dead_strip \
  "$ios_root/app/main.m" \
  "$rust_lib" \
  -L"$(dirname "$hermes_dylib")" \
  -lgpuix_js \
  -Wl,-rpath,@executable_path/Frameworks \
  -framework UIKit \
  -framework Foundation \
  -framework Metal \
  -framework QuartzCore \
  -framework CoreGraphics \
  -framework CoreText \
  -framework CoreFoundation \
  -framework Security \
  -framework SystemConfiguration \
  -lc++ \
  -liconv \
  -lz \
  -lresolv \
  -o "$app_bundle/$exec_name"

if [[ "$variant" == "release" ]]; then
  strip -x "$app_bundle/$exec_name" 2>/dev/null || true
fi

GPUIX_PLIST_TEMPLATE="$ios_root/app/Info.plist.template" \
GPUIX_PLIST_OUT="$app_bundle/Info.plist" \
GPUIX_APP_NAME="$app_name" \
GPUIX_BUNDLE_ID="$bundle_id" \
GPUIX_EXECUTABLE="$exec_name" \
GPUIX_VERSION_NAME="$version_name" \
GPUIX_BUILD_NUMBER="$build_number" \
GPUIX_DEPLOYMENT_TARGET="$deploy_target" \
GPUIX_STATUS_BAR_STYLE="$status_bar_style" \
GPUIX_UISTATUS_BAR_STYLE="$ui_status_bar_style" \
bun -e '
  const fs = require("node:fs");
  const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  let tpl = fs.readFileSync(process.env.GPUIX_PLIST_TEMPLATE, "utf8");
  const vars = {
    __GPUIX_APP_NAME__: esc(process.env.GPUIX_APP_NAME),
    __GPUIX_BUNDLE_ID__: esc(process.env.GPUIX_BUNDLE_ID),
    __GPUIX_EXECUTABLE__: esc(process.env.GPUIX_EXECUTABLE),
    __GPUIX_VERSION_NAME__: esc(process.env.GPUIX_VERSION_NAME),
    __GPUIX_BUILD_NUMBER__: esc(process.env.GPUIX_BUILD_NUMBER),
    __GPUIX_DEPLOYMENT_TARGET__: esc(process.env.GPUIX_DEPLOYMENT_TARGET),
    __GPUIX_STATUS_BAR_STYLE__: esc(process.env.GPUIX_STATUS_BAR_STYLE),
    __GPUIX_UISTATUS_BAR_STYLE__: esc(process.env.GPUIX_UISTATUS_BAR_STYLE),
  };
  for (const [k, v] of Object.entries(vars)) tpl = tpl.replaceAll(k, v);
  fs.writeFileSync(process.env.GPUIX_PLIST_OUT, tpl);
'

cp "$hermes_dylib" "$app_bundle/Frameworks/libgpuix_js.dylib"
if [[ -f "$ios_root/.build/assets/gpuix/app.hbc" ]]; then
  cp "$ios_root/.build/assets/gpuix/app.hbc" "$app_bundle/gpuix/app.hbc"
else
  cp "$ios_root/.build/assets/gpuix/app.js" "$app_bundle/gpuix/app.js"
fi
if [[ -f "$ios_root/.build/assets/gpuix/ota-meta.kv" ]]; then
  cp "$ios_root/.build/assets/gpuix/ota-meta.kv" "$app_bundle/gpuix/ota-meta.kv"
fi

codesign --force --sign - "$app_bundle/Frameworks/libgpuix_js.dylib"
codesign --force --sign - "$app_bundle"

out_dir="${GPUIX_OUT_DIR:-$project_root/dist/ios}"
mkdir -p "$out_dir"
final_app="$out_dir/$artifact_stem.app"
rm -rf "$final_app"
cp -R "$app_bundle" "$final_app"
codesign --force --sign - "$final_app/Frameworks/libgpuix_js.dylib" >/dev/null 2>&1
codesign --force --sign - "$final_app" >/dev/null 2>&1

echo "iOS App: $final_app (bundleId=$bundle_id, version=v$version_name ($build_number), deploy=$deploy_target, statusBar=$status_bar_style)"
