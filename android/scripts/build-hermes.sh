#!/usr/bin/env bash
set -euo pipefail
android_root="$(cd "$(dirname "$0")/.." && pwd)"
hermes_source="$android_root/.deps/hermes"
libuv_source="$android_root/.deps/hermes-libuv"
hermes_commit=d864d3f09d10e8aebe429715eeed5a4d7edf114d
libuv_tag=v1.53.0
sdk_root="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-$HOME/Library/Android/sdk}}"
ndk_root="${ANDROID_NDK_ROOT:-$sdk_root/ndk/30.0.16248370}"
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
build_jobs="${GPUIX_BUILD_JOBS:-$(sysctl -n hw.ncpu 2>/dev/null || nproc 2>/dev/null || echo 4)}"
host_generator="Ninja"
if [[ "$(uname -s)" == MINGW* || "$(uname -s)" == MSYS* || "$(uname -s)" == CYGWIN* ]]; then
  # Hermes' Windows CMake graph contains duplicate test-library outputs that
  # Ninja rejects. NMake consumes the same graph correctly inside VsDevCmd.
  host_generator="NMake Makefiles"
fi
if [[ ! -d "$hermes_source/.git" ]]; then
  git init -q "$hermes_source"
  git -C "$hermes_source" remote add origin https://github.com/meta/hermes.git
fi
if [[ "$(git -C "$hermes_source" rev-parse --verify HEAD 2>/dev/null)" != "$hermes_commit" ]]; then
  git -C "$hermes_source" fetch --depth 1 origin "$hermes_commit"
  git -C "$hermes_source" checkout --detach FETCH_HEAD
fi
[[ "$(git -C "$hermes_source" rev-parse HEAD)" == "$hermes_commit" ]]
if [[ ! -d "$libuv_source/.git" ]]; then
  git clone --depth 1 --branch "$libuv_tag" https://github.com/libuv/libuv.git "$libuv_source"
fi
if ! git -C "$libuv_source" rev-parse --verify "refs/tags/$libuv_tag" >/dev/null 2>&1; then
  git -C "$libuv_source" fetch --depth 1 origin "tag" "$libuv_tag"
fi
if [[ "$(git -C "$libuv_source" rev-parse HEAD)" != "$(git -C "$libuv_source" rev-parse "refs/tags/$libuv_tag^{commit}")" ]]; then
  git -C "$libuv_source" checkout --detach "refs/tags/$libuv_tag"
fi

hermesc_bin="$android_root/.build/hermes-host/bin/hermesc"
if [[ -x "$android_root/.build/hermes-host/bin/hermesc.exe" ]]; then
  hermesc_bin="$android_root/.build/hermes-host/bin/hermesc.exe"
fi
libgpuix_js="$android_root/.build/hermes-android/libgpuix_js.so"
if [[ "${GPUIX_FORCE_HERMES_REBUILD:-0}" != "1" ]] \
  && [[ -x "$hermesc_bin" ]] \
  && [[ -f "$libgpuix_js" ]] \
  && [[ "$libgpuix_js" -nt "$android_root/hermes/runner.cpp" ]] \
  && [[ "$libgpuix_js" -nt "$android_root/hermes/gpuix_js.h" ]] \
  && [[ "$libgpuix_js" -nt "$android_root/hermes/CMakeLists.txt" ]]; then
  echo "Hermes host & Android runtime up to date; skipping rebuild"
  exit 0
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
if [[ ! -x "$hermesc_bin" ]] || [[ "${GPUIX_FORCE_HERMES_REBUILD:-0}" == "1" ]]; then
  cmake -S "$hermes_source" -B "$android_root/.build/hermes-host" -G "$host_generator" \
    "${host_args[@]}"
  cmake --build "$android_root/.build/hermes-host" --target hermesc -j "$build_jobs"
fi
cmake -S "$android_root/hermes" -B "$android_root/.build/hermes-android" -G Ninja \
  -DCMAKE_TOOLCHAIN_FILE="$ndk_root/build/cmake/android.toolchain.cmake" \
  -DANDROID_ABI=arm64-v8a -DANDROID_PLATFORM=android-28 -DANDROID_STL=c++_shared \
  -DCMAKE_BUILD_TYPE=MinSizeRel \
  -DIMPORT_HOST_COMPILERS="$android_root/.build/hermes-host/ImportHostCompilers.cmake"
cmake --build "$android_root/.build/hermes-android" --target gpuix_js -j "$build_jobs"
