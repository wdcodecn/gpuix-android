#!/usr/bin/env bash
set -euo pipefail
android_root="$(cd "$(dirname "$0")/.." && pwd)"
repo_root="$(cd "$android_root/.." && pwd)"
if [[ -n "${GPUIX_NATIVE_ROOT:-}" ]]; then
  native_root="$GPUIX_NATIVE_ROOT"
elif [[ -d "$android_root/hermes" ]]; then
  native_root="$android_root"
else
  native_root="$repo_root/native"
fi
hermes_source="$native_root/.deps/hermes"
libuv_source="$native_root/.deps/hermes-libuv"
hermes_cmake_dir="$native_root/hermes"
hermes_commit=d864d3f09d10e8aebe429715eeed5a4d7edf114d
libuv_tag=v1.53.0
sdk_root="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-$HOME/Library/Android/sdk}}"
ndk_root="${ANDROID_NDK_ROOT:-$sdk_root/ndk/30.0.16248370}"
shared_cache="${GPUIX_SHARED_CACHE:-1}"
cache_root="${GPUIX_CACHE_DIR:-${XDG_CACHE_HOME:-$HOME/.cache}/gpuix-mobile}"

is_windows=0
case "$(uname -s)" in
  MINGW*|MSYS*|CYGWIN*) is_windows=1 ;;
esac

if (( is_windows )) && command -v cygpath >/dev/null 2>&1; then
  sdk_root="$(cygpath -u "$sdk_root")"
  ndk_root="$(cygpath -u "$ndk_root")"
  cache_root="$(cygpath -u "$cache_root")"
fi
if ! command -v cmake >/dev/null 2>&1; then
  for cmake_dir in "$sdk_root/cmake/3.22.1/bin" "$sdk_root/cmake/3.22.1"; do
    if [[ -x "$cmake_dir/cmake" || -x "$cmake_dir/cmake.exe" ]]; then
      export PATH="$cmake_dir:$PATH"
      break
    fi
  done
fi

cpu_count() {
  sysctl -n hw.ncpu 2>/dev/null || nproc 2>/dev/null || echo 4
}

default_build_jobs() {
  local ncpu jobs
  ncpu="$(cpu_count)"
  if [[ ! "$ncpu" =~ ^[0-9]+$ ]] || (( ncpu < 1 )); then
    ncpu=4
  fi
  if (( ncpu > 2 )); then
    jobs=$(( ncpu - 1 ))
  else
    jobs="$ncpu"
  fi
  echo "$jobs"
}

run_low_prio() {
  if (( ! is_windows )) && command -v nice >/dev/null 2>&1; then
    nice -n 10 "$@"
  else
    "$@"
  fi
}

sha256_stream() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum | awk '{print $1}'
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 | awk '{print $1}'
  else
    openssl dgst -sha256 | awk '{print $NF}'
  fi
}

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

build_jobs="${GPUIX_BUILD_JOBS:-$(default_build_jobs)}"
host_generator="Ninja"
if (( is_windows )); then
  # Hermes' Windows CMake graph contains duplicate test-library outputs that
  # Ninja rejects. NMake consumes the same graph correctly inside VsDevCmd.
  host_generator="NMake Makefiles"
fi

if [[ "$shared_cache" == "1" ]] && (( ! is_windows )); then
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
if ! git -C "$libuv_source" rev-parse --verify "refs/tags/$libuv_tag" >/dev/null 2>&1; then
  git -C "$libuv_source" fetch --depth 1 origin "tag" "$libuv_tag"
fi
if [[ "$(git -C "$libuv_source" rev-parse HEAD)" != "$(git -C "$libuv_source" rev-parse "refs/tags/$libuv_tag^{commit}")" ]]; then
  git -C "$libuv_source" checkout --detach "refs/tags/$libuv_tag"
fi

hermes_abi="${GPUIX_HERMES_ABI:-arm64-v8a}"
hermes_host_dir="$native_root/.build/hermes-host"
hermesc_bin="$hermes_host_dir/bin/hermesc"
if [[ -x "$hermes_host_dir/bin/hermesc.exe" ]]; then
  hermesc_bin="$hermes_host_dir/bin/hermesc.exe"
fi
libgpuix_js="$android_root/.build/hermes-android/libgpuix_js.so"
key_file="$android_root/.build/.hermes-key"

hermes_cache_key="$({
  printf 'v2-api26\nuname=%s %s\nabi=%s\napi=26\nhermes=%s\nlibuv=%s\nndk=%s\n' \
    "$(uname -s)" "$(uname -m)" "$hermes_abi" "$hermes_commit" "$libuv_tag" "$(basename "$ndk_root")"
  for f in "$hermes_cmake_dir/CMakeLists.txt" "$hermes_cmake_dir/gpuix_js.h" "$hermes_cmake_dir/runner.cpp" "$hermes_cmake_dir/libuv_android_compat.h"; do
    printf 'file=%s sha256=%s\n' "$(basename "$f")" "$(sha256_stream < "$f")"
  done
} | sha256_stream)"

shared_hermes_dir="$cache_root/hermes/$hermes_cache_key"
cached_hermesc="$shared_hermes_dir/hermesc"
if (( is_windows )); then
  cached_hermesc="$shared_hermes_dir/hermesc.exe"
fi
cached_lib="$shared_hermes_dir/libgpuix_js.so"

if [[ "${GPUIX_FORCE_HERMES_REBUILD:-0}" != "1" ]] \
  && [[ -x "$hermesc_bin" ]] \
  && [[ -f "$libgpuix_js" ]] \
  && [[ -f "$key_file" ]] \
  && [[ "$(cat "$key_file" 2>/dev/null || true)" == "$hermes_cache_key" ]]; then
  if [[ "$shared_cache" == "1" ]] && [[ ! -x "$cached_hermesc" || ! -f "$cached_lib" ]]; then
    mkdir -p "$shared_hermes_dir"
    cp "$hermesc_bin" "$cached_hermesc.tmp.$$" && chmod +x "$cached_hermesc.tmp.$$" && mv -f "$cached_hermesc.tmp.$$" "$cached_hermesc"
    cp "$libgpuix_js" "$cached_lib.tmp.$$" && mv -f "$cached_lib.tmp.$$" "$cached_lib"
  fi
  echo "Hermes host & Android runtime up to date; skipping rebuild"
  exit 0
fi

if [[ "$shared_cache" == "1" ]] && [[ "${GPUIX_FORCE_HERMES_REBUILD:-0}" != "1" ]] \
  && [[ -x "$cached_hermesc" ]] && [[ -f "$cached_lib" ]]; then
  mkdir -p "$(dirname "$hermesc_bin")" "$(dirname "$libgpuix_js")"
  if [[ ! -x "$hermesc_bin" ]] || ! cmp -s "$cached_hermesc" "$hermesc_bin"; then
    tmp_bin="$hermesc_bin.tmp.$$"
    cp "$cached_hermesc" "$tmp_bin"
    chmod +x "$tmp_bin"
    mv -f "$tmp_bin" "$hermesc_bin"
  fi
  if [[ ! -f "$libgpuix_js" ]] || ! cmp -s "$cached_lib" "$libgpuix_js"; then
    tmp_lib="$libgpuix_js.tmp.$$"
    cp "$cached_lib" "$tmp_lib"
    mv -f "$tmp_lib" "$libgpuix_js"
  fi
  printf '%s\n' "$hermes_cache_key" > "$key_file"
  echo "Hermes cache hit (${hermes_cache_key:0:12}); skipping rebuild"
  exit 0
fi

if [[ "${GPUIX_FORCE_HERMES_REBUILD:-0}" != "1" ]] \
  && [[ ! -f "$key_file" ]] \
  && [[ -x "$hermesc_bin" ]] && [[ -f "$libgpuix_js" ]] \
  && [[ "$libgpuix_js" -nt "$hermes_cmake_dir/runner.cpp" ]] \
  && [[ "$libgpuix_js" -nt "$hermes_cmake_dir/gpuix_js.h" ]] \
  && [[ "$libgpuix_js" -nt "$hermes_cmake_dir/CMakeLists.txt" ]] \
  && [[ "$libgpuix_js" -nt "$hermes_cmake_dir/libuv_android_compat.h" ]] \
  && grep -qF "CMAKE_TOOLCHAIN_FILE:FILEPATH=$ndk_root/build/cmake/android.toolchain.cmake" "$android_root/.build/hermes-android/CMakeCache.txt" 2>/dev/null; then
  if [[ "$shared_cache" == "1" ]]; then
    mkdir -p "$shared_hermes_dir"
    cp "$hermesc_bin" "$cached_hermesc.tmp.$$" && chmod +x "$cached_hermesc.tmp.$$" && mv -f "$cached_hermesc.tmp.$$" "$cached_hermesc"
    cp "$libgpuix_js" "$cached_lib.tmp.$$" && mv -f "$cached_lib.tmp.$$" "$cached_lib"
  fi
  printf '%s\n' "$hermes_cache_key" > "$key_file"
  echo "Hermes host & Android runtime adopted (${hermes_cache_key:0:12}); skipping rebuild"
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
  cmake -S "$hermes_source" -B "$hermes_host_dir" -G "$host_generator" \
    "${host_args[@]}"
  run_low_prio cmake --build "$hermes_host_dir" --target hermesc -j "$build_jobs"
fi
cmake_cache="$android_root/.build/hermes-android/CMakeCache.txt"
if [[ -f "$cmake_cache" ]] && {
  ! grep -qF "ANDROID_PLATFORM:STRING=android-26" "$cmake_cache" 2>/dev/null \
  || ! grep -qF "ANDROID_ABI:STRING=${hermes_abi}" "$cmake_cache" 2>/dev/null
}; then
  rm -rf "$android_root/.build/hermes-android"
fi
cmake -S "$hermes_cmake_dir" -B "$android_root/.build/hermes-android" -G Ninja \
  -DCMAKE_TOOLCHAIN_FILE="$ndk_root/build/cmake/android.toolchain.cmake" \
  -DANDROID_ABI="$hermes_abi" -DANDROID_PLATFORM=android-26 -DANDROID_STL=c++_shared \
  -DCMAKE_BUILD_TYPE=MinSizeRel \
  -DIMPORT_HOST_COMPILERS="$hermes_host_dir/ImportHostCompilers.cmake"
run_low_prio cmake --build "$android_root/.build/hermes-android" --target gpuix_js -j "$build_jobs"

if [[ -x "$hermes_host_dir/bin/hermesc.exe" ]]; then
  hermesc_bin="$hermes_host_dir/bin/hermesc.exe"
fi
if [[ "$shared_cache" == "1" ]] && [[ -x "$hermesc_bin" ]] && [[ -f "$libgpuix_js" ]]; then
  mkdir -p "$shared_hermes_dir"
  cp "$hermesc_bin" "$cached_hermesc.tmp.$$" && chmod +x "$cached_hermesc.tmp.$$" && mv -f "$cached_hermesc.tmp.$$" "$cached_hermesc"
  cp "$libgpuix_js" "$cached_lib.tmp.$$" && mv -f "$cached_lib.tmp.$$" "$cached_lib"
fi
mkdir -p "$(dirname "$key_file")"
printf '%s\n' "$hermes_cache_key" > "$key_file"
