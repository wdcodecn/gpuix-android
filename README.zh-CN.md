# gpuix-mobile

[English](README.md)

`gpuix-mobile` 是 React + GPUIX 的移动端原生框架与交付工具（统一支持 Android 与 iOS 模拟器）。它把 React
组件树交给独立 Hermes 执行，通过 GPUI + wgpu 直接绘制到原生视图；主 UI
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
bunx gpuix-mobile create my-app \
  --app-id com.example.myapp \
  --name "My App" \
  --version 1.0.0 \
  --version-code 1

cd my-app
bun install
bun run gpuix:doctor
bun run gpuix:run -- <ADB_SERIAL>   # Android 真机/模拟器
bun run gpuix -- run ios            # iOS 模拟器
```

`bunx` 命令适用于 npm 包发布之后；当前仅发布 GitHub 源码时，可以直接使用 GitHub
模板，或在已有项目中把本仓库作为 Git 依赖安装。

## 接入已有 GPUIX 项目

```sh
bunx gpuix-mobile init \
  --entry src/main.tsx \
  --app-id com.example.myapp \
  --name "My App" \
  --version 1.0.0

# 默认采用受管（Managed）零拷贝宿主：仅生成 gpuix.config.json，构建时自动复用包内 android/ / ios/ / native/ / runtime/
# 若需直接在本地修改原生代码，可随时弹出完整原生目录：
gpuix eject   # 或 init/create 时附带 --eject

gpuix doctor
gpuix build android
gpuix build ios
gpuix install <ADB_SERIAL>
gpuix run ios
```

## 产物、版本与 OTA 工具链

```sh
gpuix dev [--port 8081] [--logcat]        # 调试热重载、SourceMap 堆栈反解 (/symbolicate)、__gpuixHotState 与日志转发
gpuix build [android] [--release|--aab]   # Android APK / AAB（默认 arm64-v8a，16KB 对齐校验）
gpuix build --js-only                     # 仅重打 JS/HBC 与 APK（跳过 Rust/Hermes，复用已有 .so）
gpuix build ios [--debug|--release]       # dist/ios/<project>.app（iOS 模拟器 Metal 原生渲染包）
gpuix run ios [SIMULATOR_UDID]            # 构建并安装启动 iOS 模拟器 App
gpuix bench [ADB_SERIAL] [--release]      # APK 分项体积、64 位 16KB 对齐校验、设备 SHA-256 校验与帧延迟 P50/P99
gpuix cache status                        # 查看跨项目共享缓存与本地冗余 target 占用
gpuix cache clean                         # 清理分裂 target 与过期缓存（加 --all 清空全部共享缓存）
gpuix ota keygen                          # 生成 OTA ECDSA P-256 签名密钥对
gpuix ota build [--platform android|ios|all] [--version 1.1.1]
                                          # 打包 OTA 热更新包，产出 app.hbc + manifest.json + merkle.json + chain.json
gpuix ota verify <MANIFEST_PATH>          # 校验清单签名、分块 Merkle Root 与哈希链
gpuix ota chain [--dir dist/ota] [--verify]
                                          # 检查 OTA 发布哈希链与 Chain Merkle Root
gpuix ota proof <QUERY> [--chunk N]       # 生成并校验单条发布/单分块的 RFC 6962 Merkle 包含证明
gpuix ota locate <QUERY>                  # 通过 releaseId、v1.1.1 版本号、#索引或 SHA-256 前缀反查发布记录
gpuix ota serve [ADB_SERIAL]              # 启动本地 OTA 静态服务并自动配置 adb reverse
```

仓库目录采用移动端共享架构：
- `runtime/`：共享跨端 JS 运行时与 `GpuixNativeSdk`（自动注入 `__gpuixMobile`、`__gpuixPlatform` 与 `__gpuixAppInfo`）
- `native/hermes/`、`native/vendor/{gpuix-native,gpui-mobile}`：Android 与 iOS 共享的 Hermes 宿主及 Rust 原生渲染内核
- `android/`、`ios/`：各平台独立宿主与构建适配器
- 项目配置文件统一为 `gpuix.config.json`（完全向下兼容旧项目中的 `gpuix.android.json`），可配置 `versionName`（如 `1.1.1`、`2.7.0`）、`android.{applicationId,abis,permissions}`、`ios.{bundleId,buildNumber,deploymentTarget,statusBarStyle}` 与 `ota`。TypeScript 工程可导入 `gpuix-mobile/native-sdk` 与 `gpuix-mobile/runtime`。

仓库级自动化校验可执行：

```sh
bun run typecheck
bun test
```

构建并发与共享缓存环境变量（均可选）：
- `GPUIX_BUILD_JOBS`：覆写编译并发数（默认 `max(2, ncpu - 1)`，Unix 下自动以 `nice -n 10` 低调度优先级运行，兼顾编译速度与前台响应）。
- `GPUIX_CACHE_DIR`：覆写跨项目共享缓存目录（默认 `${XDG_CACHE_HOME:-$HOME/.cache}/gpuix-mobile`；自动回退读取历史 `~/.cache/gpuix-android`）。
- `GPUIX_SHARED_CACHE=0`：关闭跨项目共享缓存，回退至当前项目目录独立构建。

当前 64 位 Android 构建（`arm64-v8a`）强制执行 API 26+ 与 16KB ELF `LOAD` 页对齐校验；Windows 桌面端使用已发布的
`@gpuix/native-win32-x64-msvc` binding；Android 在 Git Bash 中调用 Windows NDK
工具链。release APK/AAB 默认使用 debug keystore 方便本地
验收；上传应用商店前必须配置正式 upload key、递增 `versionCode`，并独立完成商店验收。

架构和性能契约见 [docs/ARCHITECTURE.zh-CN.md](docs/ARCHITECTURE.zh-CN.md)，性能优化详单与实测基准见 [docs/PERFORMANCE.zh-CN.md](docs/PERFORMANCE.zh-CN.md)，OTA 热更新指南见 [docs/OTA.zh-CN.md](docs/OTA.zh-CN.md)，交付边界与
Tauri/Flutter 对照见 [docs/DELIVERY.zh-CN.md](docs/DELIVERY.zh-CN.md)。示例应用位于
[`wdcodecn/gpuix-app-starter`](https://github.com/wdcodecn/gpuix-app-starter)，组件库位于
[`wdcodecn/gpuix-base-ui`](https://github.com/wdcodecn/gpuix-base-ui)。
