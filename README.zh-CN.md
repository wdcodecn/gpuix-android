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

## 产物与开发热重载

```sh
gpuix dev                 # 启动调试开发服务器并支持真机热重载与 RedBox
gpuix build               # dist/android/<project>-debug.apk（使用 android-dev 增量配置）
gpuix build --js-only     # 仅重打 JS/HBC 与 APK（跳过 Rust/Hermes，复用已有 .so）
gpuix build --release     # dist/android/<project>-release.apk（fat LTO 极限瘦身）
gpuix build --release --fast # 本地快速发布验收（thin LTO）
gpuix build --aab         # dist/android/<project>-release.aab
gpuix cache status        # 查看跨项目共享缓存与本地冗余 target 占用
gpuix cache clean         # 清理分裂 target 与过期缓存（加 --all 清空全部共享缓存）
```

在项目配置（`android/scripts/config.ts`）中可通过 `features` 字段按需裁剪 `gpuix-native` 可选特性（例如 `rich-content`、`http-client`），进一步压缩 Release 二进制体积。

构建并发与共享缓存环境变量（均可选）：
- `GPUIX_BUILD_JOBS`：覆写编译并发数（默认 `max(2, ncpu - 1)`，Unix 下自动以 `nice -n 10` 低调度优先级运行，兼顾编译速度与前台响应）。
- `GPUIX_CACHE_DIR`：覆写跨项目共享缓存目录（默认 `${XDG_CACHE_HOME:-$HOME/.cache}/gpuix-android`）。
- `GPUIX_SHARED_CACHE=0`：关闭跨项目共享缓存，回退至当前项目目录独立构建。

当前 Android host 支持 arm64-v8a。Windows 桌面端使用已发布的
`@gpuix/native-win32-x64-msvc` binding；Android 在 Git Bash 中调用 Windows NDK
工具链。release APK/AAB 默认使用 debug keystore 方便本地
验收；上传应用商店前必须配置正式 upload key、递增 `versionCode`，并独立完成商店验收。

架构和性能契约见 [docs/ARCHITECTURE.zh-CN.md](docs/ARCHITECTURE.zh-CN.md)，性能优化详单与实测基准见 [docs/PERFORMANCE.zh-CN.md](docs/PERFORMANCE.zh-CN.md)，交付边界与
Tauri/Flutter 对照见 [docs/DELIVERY.zh-CN.md](docs/DELIVERY.zh-CN.md)。示例应用位于
[`wdcodecn/gpuix-app-starter`](https://github.com/wdcodecn/gpuix-app-starter)，组件库位于
[`wdcodecn/gpuix-base-ui`](https://github.com/wdcodecn/gpuix-base-ui)。
