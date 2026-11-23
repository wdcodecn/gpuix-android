# GPUIX Android 性能与架构优化详解

本文档记录 `gpuix-android` 在启动速度、包体积、渲染帧率、通信协议、原生动画及开发体验上的全栈优化架构与实测基准数据。

## 一、核心优化架构

### P0.1 Hermes `.hbc` 字节码零拷贝与 GC

- **预编译与零压缩打包**：构建阶段通过 `android/scripts/build-hermes.sh`、`build-js.ts` 与 `build-android.sh` 将 JS Bundle 编译为 Hermes 字节码 `assets/gpuix/app.hbc`；在 `android/app/build.gradle.kts` 中配置 `noCompress += listOf("hbc")`，确保 APK 中 `.hbc` 以 `Stored`（0% 压缩）方式存储，支持运行时直接从 APK/Asset 零解压加载与执行。
- **Native Runner 集成**：在 `android/hermes/{gpuix_js.h, runner.cpp, CMakeLists.txt}` 与 `android/rust/src/lib.rs` 中接入 Hermes 运行时与 GC 控制。
- **产物清理**：Release 构建阶段从包中剔除明文 `app.js` 与调试文件 `dev.json`，兼顾启动速度与代码体积。

### P0.2 字体两阶段后台懒加载

- **首帧优先策略**（`android/vendor/gpui-mobile/src/android/platform.rs`）：
  - **Phase 1（同步）**：应用启动时仅同步载入 Roboto 核心西文字体，立刻放行首屏窗口与文本排版渲染。
  - **Phase 2（异步分批）**：在独立的 `gpuix-fonts` 后台线程分两批（`batch1` / `batch2`）异步加载 CJK、多语言及 Emoji 字体，每批就绪后主动调用 `schedule_frame` 刷新文本布局。

### P0.3 窗口指标无锁快照 & 事件主动 Push

- **无锁只读快照**：在 `android/vendor/gpui-native/src/{renderer.rs, renderer_android.rs}` 中引入基于 `parking_lot::RwLock` 的 `SharedWindowMetrics`，避免 JS 查询窗口尺寸与安全区 insets 时阻塞主渲染互斥锁。
- **主动推流替代轮询**：Native 侧在窗口尺寸或安全区发生变化时主动推送 `windowResize` 与 `windowInsets` 事件；`android/scripts/build-js.ts` 注入 `__gpuixViewport` 构造拦截，与前端 Push 订阅联动，彻底消除 JS 侧定时器轮询。

### P0.4 Release 包极致瘦身

- **Java/Kotlin 端**：启用 Gradle R8 混淆裁剪与资源收缩，并配置 `android/app/proguard-rules.pro` 保留 JNI/Native 入口类。
- **Rust 端**：开启极小体积编译配置（`opt-level = "z"`、`lto = "fat"`、`codegen-units = 1`、`panic = "abort"`、`strip = "symbols"`），构建后执行 `llvm-strip --strip-unneeded`。
- **可选 Feature 裁剪**：在 `gpuix-native`（`Cargo.toml`、`lib.rs`、`syntax/mod.rs`、`custom_elements/mod.rs`、`custom_elements/img.rs`）中提供可选 Feature `rich-content` 与 `http-client`，并通过 `android/scripts/config.ts` 的 `features` 字段按需开关，允许轻量应用剔除重型富文本/语法高亮或 HTTP 客户端依赖。

### P1.1 真硬件 VSync + `Fifo` + 触控历史采样

- **硬件 VSync 驱动**（`android/vendor/gpui-mobile/src/android/vsync.rs`）：通过 `dlsym` 动态解析 `AChoreographer_getInstance` 与 `AChoreographer_postFrameCallback64`，严格在 `android_main` Looper 线程武装回调并与 JS `requestAnimationFrame` 对齐，取代固定间隔或软件模拟定时。
- **低延迟与惯性滚动**：`window.rs` 将 Vulkan Swapchain 设置为 `PresentMode::Fifo`，并结合 `record_touch_history`、`momentum.rs`（`record_at`）与 `jni.rs` 中的 `pointer.history()` 历史触控采样喂入高刷管线，减少跟手延迟并提升惯性速度估算精度；同时在 `jni.rs` 中重构 VSync 事件循环并接入 `LowMemory` 系统回调。

### P1.2 锁外解码 + `GPX1` 零拷贝二进制突变协议

- **锁外预处理与驻留样式表**：`renderer.rs` 中将 `apply_batch` 的反序列化与预处理移至渲染锁外部完成；`retained_tree.rs` 引入 `StyleTable::intern_client_style` 与 `get_client_style` 实现客户端样式驻留复用，避免每帧重复解析冗余样式 JSON。
- **`GPX1` 二进制协议**：
  - Native 侧在 `renderer.rs` 提供 `apply_binary_batch`（支持共 12 个二进制 Opcode，涵盖样式驻留/引用与节点树增量增删改操作，并内置等价性校验与回滚测试）。
  - JS 侧在 `build-js.ts` 中通过 `Bun.build` 拦截 `mutations.js`，使用手写纯 JS UTF-8 编码器、`GPX1` 二进制编码器及 `WeakMap`/`Map` 两级 `styleId` 缓存，替代高频 JSON 序列化。

### P1.3 原生 Motion Spring 物理引擎 + 高刷联动

- **闭式求解弹簧动画**：新增 `gpuix-native/src/motion.rs`，实现欠阻尼、临界阻尼与过阻尼三种情况下的弹簧解析闭式解，并在动画中途被打断时自动继承当前瞬时速度，保证连续手势平滑过渡。
- **高刷联动**：`renderer.rs` 通过 `motion_was_active` 状态驱动 `android_win.set_interactive`，确保原生动画运行期间自动维持高刷新率，结束后恢复省电刷新策略。

### P2.2 真机剪贴板 JNI + `gpuix dev` 热重载 + RedBox

- **剪贴板桥接**：在 `GpuiActivity.java` 实现线程安全的 `getClipboardText` / `setClipboardText`，通过 `jni.rs` 与 `platform.rs` 暴露给 GPUI 运行时（同时保留 headless 环境回退分支）。
- **热重载与错误浮层**：新增 `scripts/dev-server.ts` 与 `android/app/src/debug/AndroidManifest.xml`，并在 `scripts/gpuix.ts` 新增 `gpuix dev` 命令；Debug 运行时在 `android/rust/src/lib.rs` 通过轮询 `gpuix/dev.json` 触发新 Bundle 热执行，配合 `build-js.ts` 中的 `wrapDebugBundle` 与 RedBox 错误弹窗实现真机快速开发迭代。

---

## 二、实测性能与体积基准

### 1. 单元测试与批量突变 Benchmark

- **核心单测**：`gpui-mobile`（26/26 passed）、`gpuix-native` 核心模块（`color`、`style`、`motion` 含 3 个 Spring 测试、`retained_tree`、`GPX1` 等价与回滚测试共 49/49 passed）全部通过。
- **500 节点 × 20 次批量挂载 Benchmark（`--release`）**：

| 协议 | 数据传输体积 | 执行耗时 | 相对提升 |
| :--- | :--- | :--- | :--- |
| JSON（`apply_batch_to_tree`） | `74,709 B` | `6.155 ms` | 基线 |
| `GPX1`（`apply_binary_batch_to_tree`） | `22,113 B` | `1.507 ms` | 体积 **-70.4%** / 速度 **4.08×** |

### 2. Release APK 体积对比（`gpuix-base-ui-release.apk`）

| 产物分项 | 优化前基线 | 优化后实测 | 变化幅度 |
| :--- | :--- | :--- | :--- |
| **APK 总体积** | `26.2 MB` | **`16,571,169 B`（15.80 MiB）** | **-36.8%** |
| `lib/arm64-v8a/libgpuix_android.so` | `19.1 MB` | **`10,627,040 B`（10.13 MiB）** | **-44.4%** |
| `classes.dex` | `3.1 MB` | **`51,560 B`（50.4 KiB）** | **-98.4%** |
| `lib/arm64-v8a/libgpuix_js.so` | — | `3,083,928 B`（2.94 MiB） | Hermes Native Runtime |
| `lib/arm64-v8a/libc++_shared.so` | — | `1,423,696 B`（1.36 MiB） | C++ 标准库 |
| `assets/gpuix/app.hbc` | — | `1,252,018 B`（1.19 MiB） | `Stored`（0% 压缩）；无 `app.js`/`dev.json` |

> 注：`gpuix-app-starter` 示例工程 Release APK 实测体积为 `16,501,985 B`。

### 3. 真机冷启动与功耗实测

- **测试设备**：OPPO PKC110（`Mali-G925-Immortalis MC12` Vulkan，120Hz）
- **冷启动耗时**（`dev.gpuix.baseui`）：首次冷启 `LaunchState: COLD` `TotalTime: 665 ms`，二次冷启 `TotalTime: 425 ms`。
- **静默功耗表现**：5 秒无操作静默期内仅触发 5 次心跳（1Hz 最低功耗待机），logcat 确认正常命中 `Executing Hermes bundle gpuix/app.hbc (1252018 bytes)`、`loaded core font`、`loaded bg font batch1/batch2` 与 `NATIVE_INITIALIZED = true`。
