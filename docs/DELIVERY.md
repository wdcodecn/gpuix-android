# Delivery

[简体中文](DELIVERY.zh-CN.md)

## Quick start

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

For an existing GPUIX app:

```sh
bunx gpuix-mobile init \
  --entry src/main.tsx \
  --app-id com.example.myapp \
  --name "My App" \
  --version 1.0.0
```

## Artifact commands

| Command | Artifact |
| --- | --- |
| `gpuix build [android]` | `dist/android/<project>-debug.apk` |
| `gpuix build android --release` | `dist/android/<project>-release.apk` |
| `gpuix build android --aab` | `dist/android/<project>-release.aab` |
| `gpuix build ios` | `dist/ios/<project>.app` |
| `gpuix install SERIAL` | Install and launch an existing debug APK |
| `gpuix run [android] SERIAL` | Build, install and launch in one command |
| `gpuix run ios [UDID]` | Build, install and launch on iOS Simulator |
| `gpuix ota chain\|proof\|locate` | Inspect release hash chains and RFC 6962 Merkle proofs |

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

`gpuix-mobile` adopts those delivery boundaries while retaining its own
GPUI/wgpu renderer and standalone Hermes runtime.

## Current support

- Android API 31+ (`arm64-v8a`), debug APK, local release APK, AAB and ADB install/run
- iOS Simulator (`arm64-apple-ios-sim`), templated `Info.plist`, Metal surface & `simctl` install/run
- Android/iOS safe-area insets and unified `gpuix.config.json` (backward-compatible with `gpuix.android.json`)
- Adaptive interaction/idle frame-rate requests on Android
- OTA ECDSA P-256 signing, release hash chains, and chunk/chain RFC 6962 Merkle proofs

macOS desktop packaging, Apple App Store / Play Store production signing, store upload and automated rollout remain separate external steps.
