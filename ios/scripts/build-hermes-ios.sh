#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "$0")/../.." && pwd)"
native_root="${GPUIX_NATIVE_ROOT:-$repo_root/native}"
android_root="$repo_root/android"
ios_root="$repo_root/ios"
hermes_source="$native_root/.deps/hermes"
libuv_source="$native_root/.deps/hermes-libuv"
hermes_cmake_dir="$native_root/hermes"
hermes_commit=d864d3f09d10e8aebe429715eeed5a4d7edf114d
libuv_tag=v1.53.0
ios_deployment_target="${GPUIX_IOS_DEPLOYMENT_TARGET:-17.0}"
shared_cache="${GPUIX_SHARED_CACHE:-1}"
cache_root="${GPUIX_CACHE_DIR:-${XDG_CACHE_HOME:-$HOME/.cache}/gpuix-mobile}"
export DEVELOPER_DIR="${DEVELOPER_DIR:-/Applications/Xcode.app/Contents/Developer}"

link_shared_dep() {
  local local_path="$1"
  local shared_path="$2"
  mkdir -p "$(dirname "$local_path")" "$(dirname "$shared_path")"
  if [[ -L "$local_path" ]]; then
    if [[ "$(readlink "$local_path" || true)" == "$shared_path" ]]; then
      mkdir -p "$shared_path"
      return 0
    fi
    rm -f "$local_path"
  elif [[ -d "$local_path" ]]; then
    if [[ ! -d "$shared_path/.git" ]]; then
      rm -rf "$shared_path"
      mv "$local_path" "$shared_path" 2>/dev/null || {
        cp -a "$local_path" "$shared_path"
        rm -rf "$local_path"
      }
    else
      rm -rf "$local_path"
    fi
  fi
  mkdir -p "$shared_path"
  ln -s "$shared_path" "$local_path"
}

if [[ "$shared_cache" == "1" ]]; then
  link_shared_dep "$hermes_source" "$cache_root/deps/hermes"
  link_shared_dep "$libuv_source" "$cache_root/deps/hermes-libuv"
fi

if [[ ! -d "$hermes_source/.git" ]]; then
  git init -q "$hermes_source"
  git -C "$hermes_source" remote add origin https://github.com/meta/hermes.git
fi
if [[ "$(git -C "$hermes_source" rev-parse --verify HEAD 2>/dev/null || true)" != "$hermes_commit" ]]; then
  git -C "$hermes_source" fetch --depth 1 origin "$hermes_commit"
  git -C "$hermes_source" checkout --detach FETCH_HEAD
fi
[[ "$(git -C "$hermes_source" rev-parse HEAD)" == "$hermes_commit" ]]

if [[ ! -d "$libuv_source/.git" ]]; then
  git clone --depth 1 --branch "$libuv_tag" https://github.com/libuv/libuv.git "$libuv_source"
fi
if [[ "$(git -C "$libuv_source" rev-parse HEAD 2>/dev/null || true)" != "$(git -C "$libuv_source" rev-parse "refs/tags/$libuv_tag^{commit}" 2>/dev/null || echo '')" ]]; then
  git -C "$libuv_source" fetch --depth 1 origin "tag" "$libuv_tag"
  git -C "$libuv_source" checkout --detach "refs/tags/$libuv_tag"
fi

cpu_count() {
  sysctl -n hw.ncpu 2>/dev/null || echo 4
}

ncpu="$(cpu_count)"
if [[ ! "$ncpu" =~ ^[0-9]+$ ]] || (( ncpu < 1 )); then
  ncpu=4
fi
build_jobs="${GPUIX_BUILD_JOBS:-$(( ncpu > 2 ? ncpu - 1 : ncpu ))}"

hermes_host_dir="$native_root/.build/hermes-host"
if [[ ! -d "$hermes_host_dir" && -d "$android_root/.build/hermes-host" ]]; then
  mkdir -p "$(dirname "$hermes_host_dir")"
  mv "$android_root/.build/hermes-host" "$hermes_host_dir" 2>/dev/null || true
fi
hermesc_bin="$hermes_host_dir/bin/hermesc"

if [[ ! -x "$hermesc_bin" ]] || [[ "${GPUIX_FORCE_HERMES_REBUILD:-0}" == "1" ]]; then
  macos_sdk="$(xcrun --sdk macosx --show-sdk-path)"
  cmake -S "$hermes_source" -B "$hermes_host_dir" -G Ninja \
    -DCMAKE_BUILD_TYPE=MinSizeRel \
    -DHERMES_ENABLE_TEST_SUITE=OFF -DHERMES_ENABLE_DEBUGGER=OFF \
    -DHERMES_ENABLE_INTL=OFF -DHERMESVM_ALLOW_JIT=0 \
    -DHERMESVM_INTERNAL_JAVASCRIPT_NATIVE=OFF -DHERMES_ENABLE_CORE_EXTENSIONS=OFF \
    -DHERMES_UNICODE_LITE=ON \
    -DHERMES_APPLE_TARGET_PLATFORM="$macos_sdk"
  nice -n 10 cmake --build "$hermes_host_dir" --target hermesc -j "$build_jobs"
fi

sim_sdk="$(xcrun --sdk iphonesimulator --show-sdk-path)"
build_dir="$ios_root/.build/hermes-ios-sim"
out_dylib="$build_dir/libgpuix_js.dylib"

cmake_cache="$build_dir/CMakeCache.txt"
if [[ -f "$cmake_cache" ]] && {
  ! grep -qF "CMAKE_OSX_SYSROOT:PATH=$sim_sdk" "$cmake_cache" 2>/dev/null \
  || ! grep -qF "CMAKE_SYSTEM_PROCESSOR:UNINITIALIZED=arm64" "$cmake_cache" 2>/dev/null \
  || ! grep -qF "CMAKE_OSX_DEPLOYMENT_TARGET:STRING=${ios_deployment_target}" "$cmake_cache" 2>/dev/null
}; then
  rm -rf "$build_dir"
fi

cmake -S "$hermes_cmake_dir" -B "$build_dir" -G Ninja \
  -DCMAKE_SYSTEM_NAME=iOS \
  -DCMAKE_SYSTEM_PROCESSOR=arm64 \
  -DCMAKE_MACOSX_BUNDLE=OFF \
  -DCMAKE_OSX_SYSROOT="$sim_sdk" \
  -DHERMES_APPLE_TARGET_PLATFORM="$sim_sdk" \
  -DCMAKE_OSX_ARCHITECTURES=arm64 \
  -DCMAKE_OSX_DEPLOYMENT_TARGET="$ios_deployment_target" \
  -DCMAKE_BUILD_TYPE=MinSizeRel \
  -DCMAKE_C_FLAGS="-target arm64-apple-ios${ios_deployment_target}-simulator -isysroot $sim_sdk" \
  -DCMAKE_CXX_FLAGS="-target arm64-apple-ios${ios_deployment_target}-simulator -isysroot $sim_sdk" \
  -DIMPORT_HOST_COMPILERS="$hermes_host_dir/ImportHostCompilers.cmake"

nice -n 10 cmake --build "$build_dir" --target gpuix_js -j "$build_jobs"
install_name_tool -id "@rpath/libgpuix_js.dylib" "$out_dylib"
echo "Hermes iOS Simulator library ready: $out_dylib"
