# gpuix-mobile

[简体中文](README.zh-CN.md)

The native mobile framework and delivery toolchain for React on GPUIX (Android
& iOS Simulator). React runs in standalone Hermes, while GPUI and wgpu render
directly to Vulkan (Android) or Metal (iOS). The main UI does not use WebView
or React Native's view system.

## Start from the public template

```sh
gh repo create my-app --public \
  --template wdcodecn/gpuix-app-starter \
  --clone
cd my-app
bun install
```

## Create an app with the CLI

```sh
bunx gpuix-mobile create my-app \
  --app-id com.example.myapp \
  --name "My App" \
  --version 1.0.0 \
  --version-code 1

cd my-app
bun install
bun run gpuix:doctor
bun run gpuix:run -- <ADB_SERIAL>
bun run gpuix -- run ios
```

The `bunx` form applies after installing the package from npm. Until an npm
release is published, use the GitHub template or install this repository as a
Git dependency in an existing project.

## Add mobile hosts to an existing GPUIX app

```sh
bunx gpuix-mobile init \
  --entry src/main.tsx \
  --app-id com.example.myapp \
  --name "My App" \
  --version 1.0.0

gpuix doctor
gpuix build android
gpuix build ios
gpuix install <ADB_SERIAL>
gpuix run ios
```

## CLI

| Command | Result |
| --- | --- |
| `gpuix create DIR` | New React + GPUIX app (`gpuix.config.json`) |
| `gpuix init` | Managed config for an existing project (optional `--eject`) |
| `gpuix doctor` | Bun, Rust, cargo-ndk, SDK, NDK, Java, ADB, Xcode Simulator & config checks |
| `gpuix info` | App identity, `versionName`, iOS/Android config, runtime and artifact paths |
| `gpuix build [android]` | Debug APK |
| `gpuix build android --release` | Local release APK |
| `gpuix build android --aab` | Google Play Android App Bundle |
| `gpuix build ios` | iOS Simulator `.app` (`dist/ios/<project>.app`) |
| `gpuix run [android] SERIAL` | Build, install and launch on one explicit Android device |
| `gpuix run ios [SIMULATOR_UDID]` | Build, install and launch on iOS Simulator |
| `gpuix ota <keygen\|build\|verify\|chain\|proof\|locate\|serve>` | Production OTA release signing, hash-chain & Merkle proof verification |

Artifacts are copied to `dist/android/` and `dist/ios/` with stable names.
Shared runtime and native layers live in `runtime/`, `native/hermes/`, and
`native/vendor/`, reused by both `android/` and `ios/`. Legacy
`gpuix.android.json` files remain fully supported.

## Runtime architecture

```text
React application
      │ retained UI mutations
      ▼
standalone Hermes (runtime/)
      │ N-API
      ▼
native/vendor/gpuix-native
      │ GPUI layout and paint
      ▼
native/vendor/gpui-mobile + wgpu
      │ Vulkan (Android) / Metal (iOS)
      ▼
SurfaceFlinger / UIKit MetalView
```

The native host owns touch input, momentum scrolling, system-bar and display
cutout insets, IME geometry, refresh-rate requests and demand-driven idle
behavior. The selected refresh rate is an active-interaction ceiling; Android
remains authoritative when Battery Saver or OEM policy lowers the real rate.

See [Architecture](docs/ARCHITECTURE.md) and
[Delivery](docs/DELIVERY.md) for the full contracts.

## Platform and release status

- Android API 31+ (`arm64-v8a`), debug APK, local release APK, AAB and ADB install/run are validated.
- iOS Simulator (`arm64-apple-ios-sim`), templated `Info.plist`, Metal surface and `simctl` install/run are validated.
- Unified `gpuix.config.json` (and backward-compatible `gpuix.android.json`) manages `versionName`, `versionCode`, Android/iOS platform overrides, and OTA configuration.
- Windows desktop uses the published `@gpuix/native-win32-x64-msvc` binding; Android builds run through Git Bash and the installed Windows NDK toolchain.
- Android release artifacts use the debug keystore by default for local verification. Configure a real upload key before Play Store distribution, and configure Apple signing/provisioning before physical iOS App Store distribution.

This separation follows the delivery discipline used by projects such as
[Tauri](https://github.com/tauri-apps/tauri),
[Flutter](https://github.com/flutter/flutter), and
[Dioxus](https://github.com/DioxusLabs/dioxus): framework/runtime code,
examples, architecture documentation, security policy and release artifacts
have distinct ownership.

## Related repositories

- [`gpuix-base-ui`](https://github.com/wdcodecn/gpuix-base-ui): component library
- [`gpuix-app-starter`](https://github.com/wdcodecn/gpuix-app-starter): runnable demo

## License

MIT for this repository. Vendored upstream code keeps its original licenses;
see the license files inside `native/vendor/`.
