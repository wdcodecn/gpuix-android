# gpuix-android

[简体中文](README.zh-CN.md)

The native Android framework and delivery toolchain for React on GPUIX.
React runs in standalone Hermes, while GPUI and wgpu render directly to an
Android surface. The main UI does not use WebView or React Native's view system.

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
bunx gpuix-android create my-app \
  --app-id com.example.myapp \
  --name "My App" \
  --version 0.1.0 \
  --version-code 1

cd my-app
bun install
bun run gpuix:doctor
bun run gpuix:run -- <ADB_SERIAL>
```

The `bunx` form applies after installing the package from npm. Until an npm
release is published, use the GitHub template or install this repository as a
Git dependency in an existing project.

## Add Android to an existing GPUIX app

```sh
bunx gpuix-android init \
  --entry src/main.tsx \
  --app-id com.example.myapp \
  --name "My App"

gpuix doctor
gpuix build
gpuix install <ADB_SERIAL>
```

## CLI

| Command | Result |
| --- | --- |
| `gpuix create DIR` | New React + GPUIX app and Android host |
| `gpuix init` | Android host for an existing project |
| `gpuix doctor` | Bun, Rust, cargo-ndk, SDK, NDK, Java, ADB and config checks |
| `gpuix info` | App identity, runtime and artifact paths |
| `gpuix build` | Debug APK |
| `gpuix build --release` | Local release APK |
| `gpuix build --aab` | Google Play Android App Bundle |
| `gpuix run SERIAL` | Build, install and launch on one explicit device |

Artifacts are copied to `dist/android/` with stable names.

## Runtime architecture

```text
React application
      │ retained UI mutations
      ▼
standalone Hermes
      │ N-API
      ▼
gpuix-native
      │ GPUI layout and paint
      ▼
gpui-mobile + wgpu
      │ Android native surface
      ▼
SurfaceFlinger / Vulkan
```

The native host owns touch input, momentum scrolling, system-bar and display
cutout insets, IME geometry, refresh-rate requests and demand-driven idle
behavior. The selected refresh rate is an active-interaction ceiling; Android
remains authoritative when Battery Saver or OEM policy lowers the real rate.

See [Architecture](docs/ARCHITECTURE.md) and
[Delivery](docs/DELIVERY.md) for the full contracts.

## Platform and release status

- Android API 31+ and arm64-v8a are the currently validated target.
- Windows desktop uses the published `@gpuix/native-win32-x64-msvc` binding;
  Android builds run through Git Bash and the installed Windows NDK toolchain.
- Debug APK, local release APK and AAB generation are implemented.
- Release artifacts use the debug keystore by default for local verification.
  Configure a real upload key before store distribution.
- iOS and macOS hosts are not claimed as completed targets.

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
see the license files inside `android/vendor/`.
