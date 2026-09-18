#!/usr/bin/env bash
set -euo pipefail
android_root="$(cd "$(dirname "$0")/.." && pwd)"
hermes_source="$android_root/.deps/hermes"
libuv_source="$android_root/.deps/hermes-libuv"
hermes_commit=4947871513667919bf2fe225134af3e3a1a3772c
sdk_root="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-$HOME/Library/Android/sdk}}"
ndk_root="${ANDROID_NDK_ROOT:-$sdk_root/ndk/28.2.13676358}"
if command -v cygpath >/dev/null 2>&1; then
  sdk_root="$(cygpath -u "$sdk_root")"
  ndk_root="$(cygpath -u "$ndk_root")"
fi
if ! command -v cmake >/dev/null 2>&1; then
  for cmake_dir in "$sdk_root/cmake/3.22.1/bin" "$sdk_root/cmake/3.22.1"; do
    if [[ -x "$cmake_dir/cmake" || -x "$cmake_dir/cmake.exe" ]]; then
      export PATH="$cmake_dir:$PATH"
      break
    fi
  done
fi
build_jobs="${GPUIX_BUILD_JOBS:-2}"
if [[ ! -d "$hermes_source/.git" ]]; then
  git clone --depth 1 --branch static_h https://github.com/facebook/hermes.git "$hermes_source"
fi
if [[ "$(git -C "$hermes_source" rev-parse HEAD)" != "$hermes_commit" ]]; then
  git -C "$hermes_source" fetch --depth 1 origin "$hermes_commit"
  git -C "$hermes_source" checkout --detach "$hermes_commit"
fi
if [[ ! -d "$libuv_source/.git" ]]; then
  git clone --depth 1 --branch v1.51.0 https://github.com/libuv/libuv.git "$libuv_source"
fi
host_args=(
  -DCMAKE_BUILD_TYPE=MinSizeRel
  -DHERMES_ENABLE_TEST_SUITE=OFF -DHERMES_ENABLE_DEBUGGER=OFF
  -DHERMES_ENABLE_INTL=OFF -DHERMESVM_ALLOW_JIT=0
  -DHERMESVM_INTERNAL_JAVASCRIPT_NATIVE=OFF -DHERMES_ENABLE_CORE_EXTENSIONS=OFF
  -DHERMES_UNICODE_LITE=ON
)
if [[ "$(uname -s)" == Darwin* ]]; then
  host_args+=("-DHERMES_APPLE_TARGET_PLATFORM=$(xcrun --sdk macosx --show-sdk-path)")
fi
cmake -S "$hermes_source" -B "$android_root/.build/hermes-host" -G Ninja \
  "${host_args[@]}"
cmake --build "$android_root/.build/hermes-host" --target hermesc -j "$build_jobs"
cmake -S "$android_root/hermes" -B "$android_root/.build/hermes-android" -G Ninja \
  -DCMAKE_TOOLCHAIN_FILE="$ndk_root/build/cmake/android.toolchain.cmake" \
  -DANDROID_ABI=arm64-v8a -DANDROID_PLATFORM=android-28 -DANDROID_STL=c++_shared \
  -DCMAKE_BUILD_TYPE=MinSizeRel \
  -DIMPORT_HOST_COMPILERS="$android_root/.build/hermes-host/ImportHostCompilers.cmake"
cmake --build "$android_root/.build/hermes-android" --target gpuix_js -j "$build_jobs"
