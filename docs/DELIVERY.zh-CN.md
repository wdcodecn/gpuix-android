# GPUIX 交付与发布

[English](DELIVERY.md)

## 快速开始

在一个新的 React + GPUIX 项目中：

```sh
bunx gpuix-mobile create my-app --app-id com.example.myapp --name "My App" --version 1.0.0 --version-code 1
cd my-app
bun install
bun run gpuix:doctor
bun run gpuix:run -- <ADB_SERIAL>
bun run gpuix -- run ios
```

也可以把已有项目接入宿主：

```sh
bunx gpuix-mobile init --entry src/main.tsx --app-id com.example.myapp --name "My App" --version 1.0.0
gpuix info
gpuix build android
gpuix build ios
gpuix install <ADB_SERIAL>
gpuix run ios
```

## CLI 合约

| 命令 | 作用 | 产物/结果 |
| --- | --- | --- |
| `gpuix create DIR` | 生成 TSX starter 与统一 `gpuix.config.json` | 可直接 `bun install` |
| `gpuix init` | 生成受管 `gpuix.config.json`（可选 `--eject`） | 不覆盖已有 `android/` |
| `gpuix doctor` | 检查 Bun、Rust、cargo-ndk、ADB、Java、Xcode Simulator 与配置 | 缺少必需工具时失败 |
| `gpuix info` | 打印入口、Android/iOS 包名、显示版本、渲染器和产物路径 | JSON 输出 |
| `gpuix build [android]` | 构建本地调试 APK | `dist/android/*-debug.apk` |
| `gpuix build android --release` | 构建本地 release APK | `dist/android/*-release.apk` |
| `gpuix build android --aab` | 构建 Google Play App Bundle | `dist/android/*-release.aab` |
| `gpuix build ios` | 构建 iOS 模拟器 `.app` | `dist/ios/*.app` |
| `gpuix run [android] SERIAL` | Android debug 构建、安装并启动 | 适合真机迭代 |
| `gpuix run ios [UDID]` | iOS 模拟器构建、安装并启动 | 适合 Mac 模拟器验证 |
| `gpuix ota <subcommand>` | ECDSA 签名发布、哈希链校验、Merkle 证明与检索 | `dist/ota/*` |

`--release` 当前使用 debug keystore 只为本地验收和侧载；上传商店前必须替换为正式
upload/app-signing key，并让 `versionCode` 递增。不要把密钥提交到仓库。

## 交付边界

- 当前模板已完成 Android arm64-v8a 产物和 ADB 安装，以及基于 shared `native/` + `runtime/` 的 iOS 模拟器 `.app` 构建与 `simctl` 启动；APK/AAB/.app 产物路径由脚本统一归档。
- `gpuix doctor` 只负责环境与项目契约检查；它不会安装 SDK、修改手机设置或生成
  签名密钥。
- Android 的 Play Console 正式签名/上传以及 iOS 真机 Provisioning Profile / Archive / IPA / TestFlight 仍是独立阶段；本地构建或模拟器通过不等于商店审核通过。

## 参考的成熟交付模式

- [Tauri 分发文档](https://v2.tauri.app/distribute/) 将 `build`、`android build`、
  `ios build` 作为 CLI 产物入口，并明确区分 bundle、签名和各平台发布。
- [Tauri Android/Google Play](https://v2.tauri.app/es/distribute/google-play/) 把
  AAB 作为商店首选，同时保留 APK 供测试和站外分发；Android 项目仍由 Android Studio
  工具链承载。
- [Flutter Android 发布](https://docs.flutter.dev/deployment/android) 将 app bundle
  作为 Play Store 首选，把 split APK 作为设备/站外分发选项，并把签名、版本号、R8
  和 manifest 检查列为发布步骤。
- [Flutter iOS 发布](https://docs.flutter.dev/deployment/ios) 以 Xcode archive/IPA、
  build number 和 App Store Connect 为独立交付阶段。

GPUIX 复用的是这些项目的交付纪律（统一 CLI、配置、版本、产物和签名边界），但保留
自己的 native GPUI/wgpu 渲染路线，不引入 WebView 或 React Native UI 层。
