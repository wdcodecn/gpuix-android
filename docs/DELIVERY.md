# Delivery

[简体中文](DELIVERY.zh-CN.md)

## Quick start

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

For an existing GPUIX app:

```sh
bunx gpuix-android init \
  --entry src/main.tsx \
  --app-id com.example.myapp \
  --name "My App"
```

## Artifact commands

| Command | Artifact |
| --- | --- |
| `gpuix build` | `dist/android/<project>-debug.apk` |
| `gpuix build --release` | `dist/android/<project>-release.apk` |
| `gpuix build --aab` | `dist/android/<project>-release.aab` |
| `gpuix install SERIAL` | Install and launch an existing debug APK |
| `gpuix run SERIAL` | Build, install and launch in one command |

The device serial is always explicit. The CLI never clears application data,
changes device refresh settings, creates signing keys or uploads a release.

## Signing boundary

Local release artifacts currently use the debug keystore for side-loading and
verification. Store delivery requires a separately managed upload key and Play
App Signing configuration. Secrets and `key.properties` must remain outside
source control.

## Reference model

The command and artifact model intentionally follows established delivery
patterns:

- [Tauri distribution](https://v2.tauri.app/distribute/) separates build,
  platform builds, bundles and signing.
- [Tauri Google Play](https://v2.tauri.app/es/distribute/google-play/) uses AAB
  for store distribution and APK for testing or direct distribution.
- [Flutter Android deployment](https://docs.flutter.dev/deployment/android)
  treats app bundles as the Play Store default and APKs as a separate output.
- [Flutter iOS deployment](https://docs.flutter.dev/deployment/ios) keeps Xcode
  archives, IPA export, build numbers and App Store upload as distinct stages.

`gpuix-android` adopts those delivery boundaries while retaining its own
GPUI/wgpu renderer and standalone Hermes runtime.

## Current support

- Android API 31+
- arm64-v8a
- Debug APK, local release APK, AAB and ADB install/run
- Android safe-area, navigation-bar, display-cutout and IME insets
- Adaptive interaction/idle frame-rate requests

iOS, macOS, production signing, store upload and automated rollout are not
claimed as completed features.
