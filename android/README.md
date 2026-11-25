# gpuix-mobile Android host

Native Android host for a GPUIX React entry point. Rendering uses GPUI and wgpu;
JavaScript runs in standalone Hermes. Shared native crates and the JS runtime live in
`../native/` and `../runtime/`. No WebView or React Native view system is included.

## Reuse in another project

From the target GPUIX React project, use the package CLI:

```sh
bunx gpuix-mobile init --entry src/main.tsx --app-id com.example.myapp --name "My App" --version 1.0.0
gpuix doctor
gpuix build android
gpuix install ADB_SERIAL
```

In managed mode, no files are copied into your project root beyond `gpuix.config.json`.
`gpuix eject` copies `android/`, `native/`, and `runtime/` without `.deps`, `.build`,
Gradle/Rust caches, APKs or generated native libraries, and refuses to overwrite an existing
`android/` directory. `gpuix.config.json` format (compatible with `gpuix.android.json`):

```json
{
  "entrypoint": "src/main.tsx",
  "appId": "com.example.myapp",
  "appName": "My App",
  "versionName": "1.0.0",
  "versionCode": 1
}
```

`build-js.ts` reads that file and generates the Android runtime bundle and Gradle
properties. Gradle packages the bundle as `assets/gpuix/app.js`, which Hermes
loads at startup. TSX edits keep the native libraries reusable. `build` and
`install` execute only the copied local host scripts, so a
consumer can inspect or version them together with its app.

```sh
bash android/scripts/build-android.sh --debug
bash android/scripts/install-android.sh DEVICE_SERIAL

# Store-oriented bundle (requires a real signing setup before upload)
bash android/scripts/build-android.sh --aab
```

Requires Bun 1.4.5, Rust 1.100.0 with the Android target, cargo-ndk, Android SDK Platform 37.2,
Build-Tools 37.0.0, NDK r30 (`30.0.16248370`), JDK 17 or later, and CMake/Ninja.
The Android host targets API 37 and supports devices on API 31 and later.
macOS additionally needs Xcode command line tools. Windows uses
Git for Windows' Bash plus the MSVC C++ workload from Visual Studio Build Tools;
the scripts select the Windows NDK toolchain automatically. First build compiles
the native dependencies; subsequent builds reuse local caches.

## Reused upstream implementations

- `vendor/gpuix-native`: GPUIX 0.11.0 source, revision
  `2e31b47ff6432ceebe70e7fc7b0f51a76d7d30cf`, Apache-2.0. Adds Android initialization
  to the existing threaded renderer and keeps its mutation/event protocol.
- `vendor/gpui-mobile`: `itsbalamurali/gpui-mobile`, revision
  `1d3ec2a1d14a63b74d1f4269340441d4eeada27a`, used under Apache-2.0. Supplies the
  NativeActivity platform, Vulkan surface, text, touch and IME support. Adapted to
  the same GPUI revision used by GPUIX; optional demo/plugin features are disabled.
- `.deps/zed`: `remorses/zed`, pinned to
  `f77e5cfe9dad04288566f00c66ecf3c58d6f84b3`, the GPUIX 0.11.0 release's GPUI fork.
- Standalone Hermes host follows the official `tools/napi-runner` integration;
  its event loop uses libuv. Source revisions and build commands live in
  `scripts/build-hermes.sh` and `hermes/`.
- Android Activity, resources and Gradle wrapper are adapted from gpui-mobile's
  Android example. Their Apache-2.0 license is in `vendor/gpui-mobile/LICENSE-APACHE`.

The desktop dependency installation is unchanged. Android runtime adaptations
live in this directory. Build output, SDK caches and native libraries are ignored.
This is a component demonstration; the proxy/network values remain demo data.
