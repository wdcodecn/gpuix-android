# GPUIX App

[English](README.md)

这个项目由 `gpuix create` 生成：React 负责描述 UI，GPUIX/wgpu 负责原生绘制，
JavaScript 运行在独立 Hermes 中，不包含 WebView 或 React Native View 系统。

## 开发

```sh
bun install
bun run typecheck
bun run dev
```

## 移动端构建与运行（Android & iOS）

```sh
bun run gpuix:doctor
bun run gpuix:build             # Android debug APK
bun run gpuix:run -- <ADB_SERIAL>
bun run gpuix:build:ios         # iOS 模拟器 .app
bun run gpuix:run:ios           # 构建并在 iOS 模拟器安装启动
```

发布构建：

```sh
gpuix build android --release       # 本地 release APK
gpuix build android --aab           # Google Play App Bundle
gpuix build ios                     # iOS 模拟器 .app
```

`gpuix.config.json` 管理跨端应用 ID、显示名称、展示版本号 `versionName`
（例如 `1.0.0`、`1.1.1`）、`versionCode` 以及 `android` / `ios` / `ota` 分区配置。
`versionCode` 每次发布必须递增；当前 Android release 构建使用 debug keystore
仅用于本地验收，商店发布前要配置正式签名。
