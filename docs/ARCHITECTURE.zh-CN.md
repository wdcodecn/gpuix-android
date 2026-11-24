# GPUIX 项目架构

[English](ARCHITECTURE.md)

## 目标

GPUIX 项目把 React 的声明式 UI 与 GPUI/wgpu 的原生绘制接在同一个小接口上：

```text
业务 App (TSX)
      │ React props/state
      ▼
gpuix-base-ui (Base UI 组件源码 + theme tokens)
      │ @gpuix/react retained tree
      ▼
standalone Hermes (JavaScript runtime)
      │ N-API mutation/event protocol
      ▼
gpuix-native + gpui-mobile (Rust)
      │ GPUI layout/paint + wgpu surface
      ▼
Android SurfaceFlinger / Vulkan
```

Android 不包含 WebView，也不使用 React Native View 层。JS 仍然会产生状态提交、
布局和绘制工作，因此它不是“JS 零成本”；但屏幕上的 UI 元素由 GPUI/wgpu 原生绘制，
滚动输入、帧节奏和系统 inset 由 native host 负责。

## 仓库分层

| 目录 | 责任 | 新项目是否修改 |
| --- | --- | --- |
| `gpuix-base-ui` 依赖 | Base UI 组件、浮层、表单、主题与公共合约 | 在业务 App 中按需导入 |
| `android/runtime` | 类型化 Android JS 运行时（`utf8`/`url`/`viewport`/`gpx1`/`web-apis`/`native-bridge`/`websocket`）与 `GpuixNativeSdk` | 由框架维护 |
| `android/app/.../bridge` | 零三方依赖轻量插件（通知、音频/触感、生物识别/闪光灯/传感器、设备系统与网络监听、KV/Keystore 存储、媒体选取/相册保存/图片压缩、沙箱文件 `fs` 与流式传输 `transfer`、应用启动检测/跳商店） | 由框架维护 |
| `android/vendor/gpuix-native` | GPUIX retained tree、N-API renderer、原生绘制与主动会话交接 | 由框架维护 |
| `android/vendor/gpui-mobile` | Android window、输入、insets、滚动、帧策略与每会话平台生命周期 | 由框架维护 |
| `android/rust`、`android/hermes` | Android 入口、独立 Hermes 运行时、JS 无锁心跳探针、Rust `BOOT_GATE` 与 Watchdog 自愈 | 受管托管 / `--eject` 后可自定义 |
| `android/scripts` | JS 打包、Hermes（输出 `hbc_version`）、声明式权限裁剪（`.build/AndroidManifest.xml`）、Rust、16KB 对齐校验、Gradle、APK/AAB 产物 | CLI 调用 |
| `gpuix.android.json` | App 身份、入口、版本、可选 `features`/`abis`/`permissions` 与 `ota` 配置（受管模式唯一必需配置） | 每个 App 必须维护 |
| `templates/react-gpui/src/main.tsx` | App 根组件模板 | 新项目的业务入口 |

## 外部接口与宿主模式（Managed vs Ejected）

新项目默认采用**受管（Managed）零拷贝模式**：仅需维护一个 TSX 入口和 `gpuix.android.json`：

```json
{
  "entrypoint": "src/main.tsx",
  "appId": "com.example.myapp",
  "appName": "My App",
  "versionName": "0.1.0",
  "versionCode": 1
}
```

构建、安装和性能基准命令会通过 `GPUIX_PROJECT_ROOT` / `GPUIX_OUT_DIR` 直接复用 `gpuix-android` 包内托管的 `android/` 原生宿主；只有业务需要定制 Gradle/Java/Rust 时才通过 `gpuix eject`（或 `gpuix init --eject`）将宿主源码拷贝到项目本地 `android/`。

## 交互、生命周期与构建门禁契约

- JS Bundle 在构建阶段预编译为零压缩 Hermes 字节码（`.hbc`），首帧启动同步加载核心字体并由后台 `SHARED_TEXT_SYSTEM` 线程分批懒加载 CJK/Emoji 字体。
- **同进程 Activity 重建线程隔离与主动交接**：`ANDROID_APP` 与 `PLATFORM` 通过 `parking_lot::RwLock<Option<...>>` 管理每会话实例，`SHARED_TEXT_SYSTEM` 跨会话复用字体缓存；`renderer_android.rs` 维护 `ACTIVE_ANDROID_SESSION` 与 `ANDROID_SESSION_LOCK`，当同进程启动新 `android_main`（如 `FLAG_ACTIVITY_CLEAR_TASK` 先创建新 Activity 后销毁旧实例）时，新会话会先主动向旧会话发送 `stop_js()` + `platform.quit()` + `waker().wake()` 令其数毫秒内退出并执行 `shutdown_platform`（按 `Arc::ptr_eq` 校验防误清），`GpuiActivity` 在 `onPause`/`onResume`/`onDestroy` 通过 `if (sInstance == this)` 隔离旧实例回调，彻底消除 `must construct App on main thread` 断言与生命周期死锁 ANR。
- JS UI 突变优先经 `GPX1` 零拷贝二进制突变协议 + 驻留 `StyleTable` 进入锁外预处理与 retained tree 合并，静态页面不主动重绘。
- 窗口尺寸与安全区 insets 通过 `SharedWindowMetrics` 无锁快照与主动 `windowResize`/`windowInsets` Push 事件同步，避免 JS 轮询。
- 渲染帧调度直接绑定 Android `AChoreographer` 硬件 VSync（`PresentMode::Fifo`）并采集 `pointer.history()` 历史触控样本；手势越过阈值或原生 Motion Spring 动画运行期间自动联动交互高刷，静止后恢复省电刷新策略。
- **JS 运行时、轻能力插件与 Native-First 自愈**：[`android/runtime`](../android/runtime) 拆分出独立类型化运行时模块（含 `__gpuixBridgeState` 单例热切换清理、`appState`/`networkChange`/`transferProgress` 事件与 `gpuix.ota` SDK）；[`dev.gpui.mobile.bridge`](../android/app/src/main/java/dev/gpui/mobile/bridge) 提供纯 Android SDK 原生插件（覆盖 [`FileTransferPlugin.java`](../android/app/src/main/java/dev/gpui/mobile/bridge/FileTransferPlugin.java) 沙箱 FS 与流式传输、相册/图片压缩、网络与启动器扩展，支持通过 `gpuix.android.json -> permissions` 按需裁剪清单权限）；`GpuiActivity` 在 `super.onCreate()` 前即触发 `GpuiOtaManager.onNativeBootStart()` 与 Rust `BOOT_GATE` / 心跳 Watchdog，实现连续早崩先拉包救活、卡死重启自愈、签名 Kill Switch 熔断与 `manifestSeq` 防降级，详见 [OTA 方案说明](OTA.zh-CN.md)。
- **64 位 16KB ELF 页对齐构建门禁**：`build-android.sh` 在打包前自动使用 NDK `llvm-readelf` 检验 `arm64-v8a` / `x86_64` 全部 `.so` 的 `LOAD` 段对齐均满足 `>= 0x4000`。
- 用户选择的刷新率是交互上限。系统低电量或 OEM 策略可以把 90/120 等请求压到
  实际允许值，App 不要求用户手动改设置。
- Android 的状态栏、导航栏和 display cutout 通过 native insets 传入 UI；业务页面
  不应把屏幕尺寸硬编码成某一台手机。
- `gpuix-native` 的“GPU 绘制 FPS”是应用重绘频率，不等同于物理面板刷新率；硬件
  最终状态以 SurfaceFlinger/HWC 和系统策略为准。

完整优化方案与实测体积、耗时及冷启基准见 [PERFORMANCE.zh-CN.md](PERFORMANCE.zh-CN.md)。
