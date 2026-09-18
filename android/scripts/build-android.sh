#!/usr/bin/env bash
set -euo pipefail

android_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
project_root="$(dirname "$android_root")"
sdk_root="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-$HOME/Library/Android/sdk}}"
ndk_root="${ANDROID_NDK_ROOT:-$sdk_root/ndk/28.2.13676358}"
if command -v cygpath >/dev/null 2>&1; then
  sdk_root="$(cygpath -u "$sdk_root")"
  ndk_root="$(cygpath -u "$ndk_root")"
fi
case "$(uname -s)" in
  Darwin*) ndk_host="darwin-x86_64" ;;
  MINGW*|MSYS*|CYGWIN*) ndk_host="windows-x86_64" ;;
  *) ndk_host="linux-x86_64" ;;
esac
zed_revision=81c99f816b4a5f69d3c014774068034c24d1d7af

variant="debug"
bundle=0
for arg in "$@"; do
  case "$arg" in
    --debug) variant="debug" ;;
    --release) variant="release" ;;
    --aab) variant="release"; bundle=1 ;;
    *)
      echo "Usage: bash android/scripts/build-android.sh [--debug|--release] [--aab]" >&2
      exit 1
      ;;
  esac
done

if [[ ! -d "$android_root/.deps/zed/.git" ]]; then
  mkdir -p "$android_root/.deps/zed"
  git -C "$android_root/.deps/zed" init -q
  git -C "$android_root/.deps/zed" remote add origin https://github.com/remorses/zed.git
  git -C "$android_root/.deps/zed" fetch --depth 1 origin "$zed_revision"
  git -C "$android_root/.deps/zed" checkout --detach FETCH_HEAD
fi
[[ "$(git -C "$android_root/.deps/zed" rev-parse HEAD)" == "$zed_revision" ]] || {
  echo "Android GPUI dependency is not at the pinned revision" >&2; exit 1;
}

export ANDROID_HOME="$sdk_root"
export ANDROID_NDK_ROOT="$ndk_root"
export ANDROID_NDK_HOME="$ndk_root"
export CARGO_TARGET_DIR="$android_root/target"
export CARGO_PROFILE_DEV_DEBUG=0
export CARGO_INCREMENTAL=0
export CARGO_BUILD_JOBS="${GPUIX_BUILD_JOBS:-2}"

cargo_jni_dir="$android_root/.build/cargo-jniLibs"
package_jni_dir="$android_root/app/src/main/jniLibs/arm64-v8a"

bun "$android_root/scripts/build-js.ts"
bash "$android_root/scripts/build-hermes.sh"
rm -rf "$cargo_jni_dir"
mkdir -p "$cargo_jni_dir"
(
  cd "$android_root/rust"
  cargo ndk -t arm64-v8a -P 31 -o "$cargo_jni_dir" build --release --lib
)

rm -rf "$package_jni_dir"
mkdir -p "$package_jni_dir"
cp "$cargo_jni_dir/arm64-v8a/libgpuix_android.so" "$package_jni_dir/"
cp "$android_root/.build/hermes-android/libgpuix_js.so" \
  "$package_jni_dir/"
cp "$ndk_root/toolchains/llvm/prebuilt/$ndk_host/sysroot/usr/lib/aarch64-linux-android/libc++_shared.so" \
  "$package_jni_dir/"
llvm_strip="$ndk_root/toolchains/llvm/prebuilt/$ndk_host/bin/llvm-strip"
"$llvm_strip" --strip-debug "$package_jni_dir/libgpuix_js.so"
"$llvm_strip" --strip-debug "$package_jni_dir/libgpuix_android.so"
if (( bundle )); then
  gradle_task=":app:bundleRelease"
elif [[ "$variant" == "release" ]]; then
  gradle_task=":app:assembleRelease"
else
  gradle_task=":app:assembleDebug"
fi
"$android_root/gradlew" -p "$android_root" "$gradle_task" --console=plain

mkdir -p "$project_root/dist/android"
artifact_stem="$(basename "$project_root" | tr -cs 'A-Za-z0-9._-' '-')"
artifact_stem="${artifact_stem#-}"
artifact_stem="${artifact_stem%-}"
artifact_stem="${artifact_stem:-gpuix-android}"
if (( bundle )); then
  artifact_path="$project_root/dist/android/$artifact_stem-release.aab"
  cp "$android_root/app/build/outputs/bundle/release/app-release.aab" "$artifact_path"
  echo "AAB: $artifact_path"
else
  artifact_path="$project_root/dist/android/$artifact_stem-$variant.apk"
  cp "$android_root/app/build/outputs/apk/$variant/app-$variant.apk" "$artifact_path"
  echo "APK: $artifact_path"
fi
