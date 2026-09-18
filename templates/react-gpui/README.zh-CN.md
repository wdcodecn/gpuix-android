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

## Android

```sh
bun run gpuix:doctor
bun run gpuix:build
bun run gpuix:run -- <ADB_SERIAL>
```

发布构建：

```sh
gpuix build --release       # 本地 release APK
gpuix build --aab           # Google Play App Bundle
```

`gpuix.android.json` 是 Android 交付配置。`versionCode` 每次发布必须递增；当前
starter 的 release 构建使用 debug keystore 仅用于本地验收，商店发布前要配置正式签名。
