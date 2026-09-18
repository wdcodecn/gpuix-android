# gpuix-android

[English](README.md)

`gpuix-android` 是 React + GPUIX 的原生 Android 框架与交付工具。它把 React
组件树交给独立 Hermes 执行，通过 GPUI + wgpu 直接绘制到 Android surface；主 UI
不使用 WebView，也不使用 React Native View 系统。

## 从公开模板开始

```sh
gh repo create my-app --public \
  --template wdcodecn/gpuix-app-starter \
  --clone
cd my-app
bun install
```

## 使用 CLI 新建项目

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

`bunx` 命令适用于 npm 包发布之后；当前仅发布 GitHub 源码时，可以直接使用 GitHub
模板，或在已有项目中把本仓库作为 Git 依赖安装。

## 接入已有 GPUIX 项目

```sh
bunx gpuix-android init \
  --entry src/main.tsx \
  --app-id com.example.myapp \
  --name "My App"

gpuix doctor
gpuix build
gpuix install <ADB_SERIAL>
```

## 产物

```sh
gpuix build             # dist/android/<project>-debug.apk
gpuix build --release   # dist/android/<project>-release.apk
gpuix build --aab       # dist/android/<project>-release.aab
```

当前 Android host 支持 arm64-v8a。release APK/AAB 默认使用 debug keystore 方便本地
验收；上传应用商店前必须配置正式 upload key、递增 `versionCode`，并独立完成商店验收。

架构和性能契约见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)，交付边界与
Tauri/Flutter 对照见 [docs/DELIVERY.md](docs/DELIVERY.md)。示例应用位于
[`wdcodecn/gpuix-app-starter`](https://github.com/wdcodecn/gpuix-app-starter)，组件库位于
[`wdcodecn/gpuix-base-ui`](https://github.com/wdcodecn/gpuix-base-ui)。
