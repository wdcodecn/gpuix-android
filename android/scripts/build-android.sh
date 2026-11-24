#!/usr/bin/env bash
set -euo pipefail

android_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
project_root="${GPUIX_PROJECT_ROOT:-$(dirname "$android_root")}"
out_dir="${GPUIX_OUT_DIR:-$project_root/dist/android}"
sdk_root="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-$HOME/Library/Android/sdk}}"
ndk_root="${ANDROID_NDK_ROOT:-$sdk_root/ndk/30.0.16248370}"
shared_cache="${GPUIX_SHARED_CACHE:-1}"
cache_root="${GPUIX_CACHE_DIR:-${XDG_CACHE_HOME:-$HOME/.cache}/gpuix-android}"

is_windows=0
case "$(uname -s)" in
  MINGW*|MSYS*|CYGWIN*) is_windows=1 ;;
esac

if (( is_windows )) && command -v cygpath >/dev/null 2>&1; then
  sdk_root="$(cygpath -u "$sdk_root")"
  ndk_root="$(cygpath -u "$ndk_root")"
  cache_root="$(cygpath -u "$cache_root")"
fi
case "$(uname -s)" in
  Darwin*) ndk_host="darwin-x86_64" ;;
  MINGW*|MSYS*|CYGWIN*) ndk_host="windows-x86_64" ;;
  *) ndk_host="linux-x86_64" ;;
esac
if ! command -v cmake >/dev/null 2>&1; then
  for cmake_dir in "$sdk_root/cmake/3.22.1/bin" "$sdk_root/cmake/3.22.1"; do
    if [[ -x "$cmake_dir/cmake" || -x "$cmake_dir/cmake.exe" ]]; then
      export PATH="$cmake_dir:$PATH"
      break
    fi
  done
fi
zed_revision=f77e5cfe9dad04288566f00c66ecf3c58d6f84b3

variant="debug"
bundle=0
fast_mode=0
js_only=0
for arg in "$@"; do
  case "$arg" in
    --debug) variant="debug" ;;
    --release) variant="release" ;;
    --aab) variant="release"; bundle=1 ;;
    --fast) fast_mode=1 ;;
    --js-only) js_only=1 ;;
    *)
      echo "Usage: bash android/scripts/build-android.sh [--debug|--release|--aab] [--fast] [--js-only]" >&2
      exit 1
      ;;
  esac
done

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

export GPUIX_BUILD_JOBS="${GPUIX_BUILD_JOBS:-$(default_build_jobs)}"
export CARGO_BUILD_JOBS="$GPUIX_BUILD_JOBS"
export ANDROID_HOME="$sdk_root"
export ANDROID_NDK_ROOT="$ndk_root"
export ANDROID_NDK_HOME="$ndk_root"

if [[ "$variant" == "debug" ]]; then
  rust_profile="android-dev"
  export CARGO_PROFILE_DEV_DEBUG=0
  export CARGO_INCREMENTAL=1
  if (( fast_mode )); then
    echo "Note: --fast only affects --release/--aab (--debug already uses android-dev)"
  fi
elif (( fast_mode )); then
  rust_profile="release-fast"
  export CARGO_INCREMENTAL=0
else
  rust_profile="release"
  export CARGO_INCREMENTAL=0
fi

if [[ "$shared_cache" == "1" ]]; then
  export CARGO_TARGET_DIR="${GPUIX_CARGO_TARGET_DIR:-$cache_root/cargo-target}"
  if [[ -z "${GPUIX_CARGO_TARGET_DIR:-}" ]] && [[ -d "$android_root/target" ]] && [[ ! -L "$android_root/target" ]] && [[ ! -e "$CARGO_TARGET_DIR" ]]; then
    mkdir -p "$(dirname "$CARGO_TARGET_DIR")"
    mv "$android_root/target" "$CARGO_TARGET_DIR" 2>/dev/null || true
  fi
else
  export CARGO_TARGET_DIR="${GPUIX_CARGO_TARGET_DIR:-$android_root/target}"
fi

# Git Bash puts /usr/bin/link.exe (the Unix compatibility wrapper) ahead of
# the MSVC toolchain. Cargo's host build scripts then try to link Windows
# proc-macros with that wrapper and fail before the Android target is built.
# VsDevCmd exposes VCToolsInstallDir, so pin Cargo to the real MSVC linker
# whenever this script is running under MINGW/MSYS/CYGWIN.
if (( is_windows )); then
  if [[ -n "${VCToolsInstallDir:-}" ]] && command -v cygpath >/dev/null 2>&1; then
    vc_tools_dir="$(cygpath -u "$VCToolsInstallDir")"
    msvc_linker="$vc_tools_dir/bin/HostX64/x64/link.exe"
    if [[ -x "$msvc_linker" ]]; then
      export PATH="$vc_tools_dir/bin/HostX64/x64:$PATH"
      export CARGO_TARGET_X86_64_PC_WINDOWS_MSVC_LINKER="$msvc_linker"
    fi
  fi
fi

package_jni_dir="$android_root/app/src/main/jniLibs/arm64-v8a"

sync_file_if_changed() {
  local src="$1"
  local dst="$2"
  mkdir -p "$(dirname "$dst")"
  if [[ -f "$dst" ]] && cmp -s "$src" "$dst"; then
    return 0
  fi
  local tmp="${dst}.tmp.$$"
  cp "$src" "$tmp"
  chmod +x "$tmp" 2>/dev/null || true
  mv -f "$tmp" "$dst"
}

compute_native_fingerprint() {
  local abi="$1"
  local features_key="$2"
  local rustc_ver="$3"
  local zed_dirty="$4"
  GPUIX_HASH_ROOT="$android_root" \
  GPUIX_HASH_ABI="$abi" \
  GPUIX_HASH_PROFILE="$rust_profile" \
  GPUIX_HASH_FEATURES="$features_key" \
  GPUIX_HASH_NDK="$(basename "$ndk_root")" \
  GPUIX_HASH_ZED_REV="$zed_revision" \
  GPUIX_HASH_ZED_DIRTY="$zed_dirty" \
  GPUIX_HASH_RUSTC="$rustc_ver" \
  bun -e '
    const { createHash } = require("node:crypto");
    const fs = require("node:fs");
    const path = require("node:path");
    const root = process.env.GPUIX_HASH_ROOT;
    const h = createHash("sha256");
    h.update("native-cache-v2-api26\n");
    for (const k of [
      "GPUIX_HASH_ABI",
      "GPUIX_HASH_PROFILE",
      "GPUIX_HASH_FEATURES",
      "GPUIX_HASH_NDK",
      "GPUIX_HASH_ZED_REV",
      "GPUIX_HASH_ZED_DIRTY",
      "GPUIX_HASH_RUSTC",
    ]) {
      h.update(k + "=" + (process.env[k] || "") + "\n");
    }
    const ignoreDirs = new Set(["target", ".git"]);
    function walk(rel) {
      const abs = path.join(root, rel);
      if (!fs.existsSync(abs)) return [];
      const st = fs.lstatSync(abs);
      if (st.isFile()) return [rel];
      if (!st.isDirectory()) return [];
      const out = [];
      for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
        if (entry.name === ".DS_Store" || ignoreDirs.has(entry.name)) continue;
        const child = rel ? rel + "/" + entry.name : entry.name;
        if (entry.isDirectory()) out.push(...walk(child));
        else if (entry.isFile()) out.push(child);
      }
      return out;
    }
    const files = [
      ...walk(".cargo/config.toml"),
      ...walk("rust"),
      ...walk("vendor/gpuix-native"),
      ...walk("vendor/gpui-mobile"),
      ...walk(".build/hermes-android/libgpuix_js.so"),
    ].sort();
    for (const f of files) {
      h.update("F:" + f + "\0");
      h.update(fs.readFileSync(path.join(root, f)));
      h.update("\0");
    }
    process.stdout.write(h.digest("hex"));
  '
}

prune_native_cache() {
  local dir="$1"
  local keep="${GPUIX_NATIVE_CACHE_KEEP:-8}"
  GPUIX_NATIVE_CACHE_ROOT="$dir" GPUIX_NATIVE_CACHE_KEEP="$keep" bun -e '
    const fs = require("node:fs");
    const path = require("node:path");
    const dir = process.env.GPUIX_NATIVE_CACHE_ROOT;
    const keep = Number(process.env.GPUIX_NATIVE_CACHE_KEEP || "8");
    if (!fs.existsSync(dir)) process.exit(0);
    const entries = fs.readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => {
        const p = path.join(dir, e.name);
        const so = path.join(p, "libgpuix_android.so");
        const st = fs.statSync(fs.existsSync(so) ? so : p);
        return { p, mtime: st.mtimeMs };
      })
      .sort((a, b) => b.mtime - a.mtime);
    for (const old of entries.slice(keep)) {
      fs.rmSync(old.p, { recursive: true, force: true });
    }
  '
}

jni_variant_stamp="$android_root/.build/.jni-variant"

if (( js_only )); then
  for req_lib in libgpuix_android.so libgpuix_js.so libc++_shared.so; do
    if [[ ! -f "$package_jni_dir/$req_lib" ]]; then
      echo "Missing $package_jni_dir/$req_lib; run a full build first (without --js-only)" >&2
      exit 1
    fi
  done
  if [[ "${GPUIX_ALLOW_VARIANT_MISMATCH:-0}" != "1" ]]; then
    if [[ -f "$jni_variant_stamp" ]]; then
      recorded_variant="$(sed -n 's/^variant=\([^ ]*\).*/\1/p' "$jni_variant_stamp" | head -n 1)"
      if [[ -n "$recorded_variant" && "$recorded_variant" != "$variant" ]]; then
        echo "Variant mismatch for --js-only: jniLibs were built for '$recorded_variant', cannot package into '$variant'. Run a full build without --js-only (or set GPUIX_ALLOW_VARIANT_MISMATCH=1 to override)." >&2
        exit 1
      fi
    elif [[ "$variant" == "release" ]]; then
      echo "Missing $jni_variant_stamp; refusing --release --js-only without knowing native binary profile (run a full --release build first, or set GPUIX_ALLOW_VARIANT_MISMATCH=1)." >&2
      exit 1
    fi
  fi
  if [[ ! -x "$android_root/.build/hermes-host/bin/hermesc" && ! -x "$android_root/.build/hermes-host/bin/hermesc.exe" ]]; then
    bash "$android_root/scripts/build-hermes.sh"
  fi
  if [[ "$variant" == "release" ]]; then
    bun "$android_root/scripts/build-js.ts" --release
  else
    bun "$android_root/scripts/build-js.ts" --debug
  fi
else
  if [[ "$shared_cache" == "1" ]] && (( ! is_windows )); then
    link_shared_dep "$android_root/.deps/zed" "$cache_root/deps/zed"
  fi

  if [[ ! -d "$android_root/.deps/zed/.git" ]]; then
    mkdir -p "$android_root/.deps/zed"
    git -C "$android_root/.deps/zed" init -q
    git -C "$android_root/.deps/zed" remote add origin https://github.com/remorses/zed.git
  fi
  if [[ "$(git -C "$android_root/.deps/zed" rev-parse --verify HEAD 2>/dev/null || true)" != "$zed_revision" ]]; then
    git -C "$android_root/.deps/zed" fetch --depth 1 origin "$zed_revision"
    git -C "$android_root/.deps/zed" checkout --detach FETCH_HEAD
  fi
  [[ "$(git -C "$android_root/.deps/zed" rev-parse HEAD)" == "$zed_revision" ]] || {
    echo "Android GPUI dependency is not at the pinned revision" >&2; exit 1;
  }

  abis_csv="${GPUIX_ABIS:-$(bun "$android_root/scripts/config.ts" --field abis --project "$project_root" 2>/dev/null || echo "arm64-v8a")}"
  abis_csv="${abis_csv// /}"
  [[ -n "$abis_csv" ]] || abis_csv="arm64-v8a"
  IFS=',' read -r -a target_abis <<< "$abis_csv"

  for existing_abi_dir in "$android_root/app/src/main/jniLibs"/*; do
    [[ -d "$existing_abi_dir" ]] || continue
    existing_abi="$(basename "$existing_abi_dir")"
    if [[ ",$abis_csv," != *",$existing_abi,"* ]]; then
      rm -rf "$existing_abi_dir"
    fi
  done

  GPUIX_HERMES_ABI="${target_abis[0]}" bash "$android_root/scripts/build-hermes.sh"
  if [[ "$variant" == "release" ]]; then
    bun "$android_root/scripts/build-js.ts" --release
  else
    bun "$android_root/scripts/build-js.ts" --debug
  fi

  cargo_features_arg=()
  features_key="<default>"
  if bun_features="$(bun "$android_root/scripts/config.ts" --field features --project "$project_root" 2>/dev/null)"; then
    if grep -q '"features"' "$project_root/gpuix.android.json" 2>/dev/null; then
      if [[ -n "$bun_features" ]]; then
        cargo_features_arg=(--no-default-features --features "$bun_features")
        features_key="--no-default-features --features $bun_features"
      else
        cargo_features_arg=(--no-default-features)
        features_key="--no-default-features"
      fi
    fi
  fi

  ndk_toolchain="$ndk_root/toolchains/llvm/prebuilt/$ndk_host"
  llvm_strip="$ndk_toolchain/bin/llvm-strip"
  rustc_ver="$(cd "$android_root/rust" && rustc -vV | tr '\n' ' ')"
  zed_dirty="$({ git -C "$android_root/.deps/zed" status --porcelain; git -C "$android_root/.deps/zed" diff; } | sha256_stream)"

  for abi in "${target_abis[@]}"; do
    case "$abi" in
      arm64-v8a)
        rust_triple="aarch64-linux-android"
        cxx_triple="aarch64-linux-android"
        ;;
      armeabi-v7a)
        rust_triple="armv7-linux-androideabi"
        cxx_triple="arm-linux-androideabi"
        ;;
      x86_64)
        rust_triple="x86_64-linux-android"
        cxx_triple="x86_64-linux-android"
        ;;
      *)
        echo "Unsupported Android ABI: $abi (expected arm64-v8a, armeabi-v7a, x86_64)" >&2
        exit 1
        ;;
    esac

    GPUIX_HERMES_ABI="$abi" bash "$android_root/scripts/build-hermes.sh"

    abi_jni_dir="$android_root/app/src/main/jniLibs/$abi"
    mkdir -p "$abi_jni_dir"

    native_key="$(compute_native_fingerprint "$abi" "$features_key" "$rustc_ver" "$zed_dirty")"
    native_cache_dir="$cache_root/native/${native_key}_${abi}"
    cached_so="$native_cache_dir/libgpuix_android.so"

    if [[ "$shared_cache" == "1" ]] && [[ "${GPUIX_FORCE_NATIVE_REBUILD:-0}" != "1" ]] && [[ -f "$cached_so" ]]; then
      echo "Native cache hit ($abi ${native_key:0:12}, profile=$rust_profile); skipping cargo ndk"
      touch "$cached_so"
      sync_file_if_changed "$cached_so" "$abi_jni_dir/libgpuix_android.so"
    else
      echo "Building native Android library ($abi, API 26+, profile=$rust_profile, jobs=$CARGO_BUILD_JOBS)..."
      (
        cd "$android_root/rust"
        if [[ "${GPUIX_KEEP_RUSTC_WRAPPER:-0}" != "1" ]]; then
          case "$(basename "${RUSTC_WRAPPER:-}")" in
            sccache*) unset RUSTC_WRAPPER ;;
          esac
        fi
        if [[ "$rust_profile" == "release" ]]; then
          profile_flag=(--release)
        else
          profile_flag=(--profile "$rust_profile")
        fi
        run_low_prio cargo ndk -t "$abi" -P 26 build "${profile_flag[@]}" --locked --lib "${cargo_features_arg[@]}"
      )

      built_so="$CARGO_TARGET_DIR/${rust_triple}/${rust_profile}/libgpuix_android.so"
      staging_so="$android_root/.build/libgpuix_android.${abi}.stripped.tmp.$$"
      trap 'rm -f "$staging_so"' EXIT
      "$llvm_strip" --strip-unneeded -o "$staging_so" "$built_so"
      if [[ "$shared_cache" == "1" ]]; then
        mkdir -p "$native_cache_dir"
        cp "$staging_so" "$cached_so.tmp.$$"
        chmod +x "$cached_so.tmp.$$" 2>/dev/null || true
        mv -f "$cached_so.tmp.$$" "$cached_so"
        prune_native_cache "$cache_root/native"
      fi
      sync_file_if_changed "$staging_so" "$abi_jni_dir/libgpuix_android.so"
      rm -f "$staging_so"
      trap - EXIT
    fi

    src_js_so="$android_root/.build/hermes-android/libgpuix_js.so"
    js_so_hash="$(sha256_stream < "$src_js_so")"
    js_strip_stamp="$android_root/.build/.stripped-js.${abi}.sha256"
    if [[ ! -f "$abi_jni_dir/libgpuix_js.so" ]] || [[ ! -f "$js_strip_stamp" ]] || [[ "$(cat "$js_strip_stamp" 2>/dev/null || true)" != "$js_so_hash" ]]; then
      staging_js="$android_root/.build/libgpuix_js.${abi}.stripped.tmp.$$"
      "$llvm_strip" --strip-unneeded -o "$staging_js" "$src_js_so"
      sync_file_if_changed "$staging_js" "$abi_jni_dir/libgpuix_js.so"
      rm -f "$staging_js"
      printf '%s\n' "$js_so_hash" > "$js_strip_stamp"
    fi

    src_libcxx="$ndk_toolchain/sysroot/usr/lib/${cxx_triple}/libc++_shared.so"
    sync_file_if_changed "$src_libcxx" "$abi_jni_dir/libc++_shared.so"

    case "$abi" in
      arm64-v8a|x86_64)
        readelf_bin="$ndk_toolchain/bin/llvm-readelf"
        if [[ -x "$readelf_bin" || -x "${readelf_bin}.exe" ]]; then
          for so_file in "$abi_jni_dir"/*.so; do
            [[ -f "$so_file" ]] || continue
            GPUIX_CHECK_SO="$so_file" GPUIX_READELF="$readelf_bin" bun -e '
              const { execFileSync } = require("node:child_process");
              const so = process.env.GPUIX_CHECK_SO;
              const readelf = process.env.GPUIX_READELF;
              const out = execFileSync(readelf, ["-l", "--wide", so], { encoding: "utf8" });
              const loadLines = out.split(/\r?\n/).filter((l) => /^\s*LOAD\s+/.test(l));
              if (loadLines.length === 0) {
                console.error(`16KB alignment check failed: no LOAD segments in ${so}`);
                process.exit(1);
              }
              for (const line of loadLines) {
                const cols = line.trim().split(/\s+/);
                const alignRaw = cols[cols.length - 1] || "";
                const align = Number(alignRaw);
                if (!Number.isFinite(align) || align < 0x4000) {
                  console.error(`16KB alignment check failed for ${so}: LOAD segment alignment ${alignRaw} (< 0x4000)`);
                  process.exit(1);
                }
              }
            '
          done
          echo "Verified 16KB ELF LOAD alignment ($abi)"
        fi
        ;;
    esac
  done
  mkdir -p "$(dirname "$jni_variant_stamp")"
  printf 'variant=%s profile=%s\n' "$variant" "$rust_profile" > "$jni_variant_stamp"
fi

if (( bundle )); then
  gradle_task=":app:bundleRelease"
elif [[ "$variant" == "release" ]]; then
  gradle_task=":app:assembleRelease"
else
  gradle_task=":app:assembleDebug"
fi
run_low_prio "$android_root/gradlew" -p "$android_root" "$gradle_task" --console=plain

mkdir -p "$out_dir"
artifact_stem="$(basename "$project_root" | tr -cs 'A-Za-z0-9._-' '-')"
artifact_stem="${artifact_stem#-}"
artifact_stem="${artifact_stem%-}"
artifact_stem="${artifact_stem:-gpuix-android}"
if (( bundle )); then
  artifact_path="$out_dir/$artifact_stem-release.aab"
  cp "$android_root/app/build/outputs/bundle/release/app-release.aab" "$artifact_path"
  echo "AAB: $artifact_path"
else
  artifact_path="$out_dir/$artifact_stem-$variant.apk"
  cp "$android_root/app/build/outputs/apk/$variant/app-$variant.apk" "$artifact_path"
  echo "APK: $artifact_path"
fi
