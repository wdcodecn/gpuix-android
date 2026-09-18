# gpuix-android native host

Native Android host for a GPUIX React entry point. Rendering uses GPUI and wgpu;
JavaScript runs in standalone Hermes. No WebView or React Native view system is
included.

## Reuse in another project

From the target GPUIX React project, use the package CLI:

```sh
bunx gpuix-android init --entry src/main.tsx --app-id com.example.myapp --name "My App"
gpuix doctor
gpuix build
gpuix install ADB_SERIAL
```

`init` copies this directory without `.deps`, `.build`, Gradle/Rust caches, APKs or
generated native libraries. It refuses to replace an existing `android/` directory.
It also writes the target-root `gpuix.android.json`:

```json
{
  "entrypoint": "src/main.tsx",
  "appId": "com.example.myapp",
  "appName": "My App",
  "versionName": "0.1.0",
  "versionCode": 1
}
```

`build-js.ts` reads that file (falling back to `playground.tsx` for this demo), then
writes a generated Gradle projection so the APK package identifier and visible app
name match. `build` and `install` execute only the copied local host scripts, so a
consumer can inspect or version them together with its app.

```sh
bash android/scripts/build-android.sh --debug
bash android/scripts/install-android.sh DEVICE_SERIAL

# Store-oriented bundle (requires a real signing setup before upload)
bash android/scripts/build-android.sh --aab
```

Requires Bun, Rust Android target, cargo-ndk, Android SDK 35, NDK 28.2, JDK 17+,
and CMake/Ninja. macOS additionally needs Xcode command line tools. Windows uses
Git for Windows' Bash plus the MSVC C++ workload from Visual Studio Build Tools;
the scripts select the Windows NDK toolchain automatically. First build compiles
the native dependencies; subsequent builds reuse local caches.

## Reused upstream implementations

- `vendor/gpuix-native`: GPUIX 0.9.0 source, revision
  `7ac9880abd8e91e5bf0e4feb0fa850729cf95a68`, Apache-2.0. Adds Android initialization
  to the existing threaded renderer and keeps its mutation/event protocol.
- `vendor/gpui-mobile`: `itsbalamurali/gpui-mobile`, revision
  `1d3ec2a1d14a63b74d1f4269340441d4eeada27a`, used under Apache-2.0. Supplies the
  NativeActivity platform, Vulkan surface, text, touch and IME support. Adapted to
  the same GPUI revision used by GPUIX; optional demo/plugin features are disabled.
- `.deps/zed`: `remorses/zed`, pinned to
  `81c99f816b4a5f69d3c014774068034c24d1d7af` (GPUIX's existing GPUI fork).
- Standalone Hermes host follows the official `tools/napi-runner` integration;
  its event loop uses libuv. Source revisions and build commands live in
  `scripts/build-hermes.sh` and `hermes/`.
- Android Activity, resources and Gradle wrapper are adapted from gpui-mobile's
  Android example. Their Apache-2.0 license is in `vendor/gpui-mobile/LICENSE-APACHE`.

The desktop dependency installation is unchanged. Android runtime adaptations
live in this directory. Build output, SDK caches and native libraries are ignored.
This is a component demonstration; the proxy/network values remain demo data.
