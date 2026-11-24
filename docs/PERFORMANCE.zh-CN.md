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

---

## 三、构建提速、并发调度与跨项目共享缓存

为解决此前每次构建强制全量走 `--release` + `fat LTO` + `CARGO_INCREMENTAL=0`、多目录 `target/` 分裂膨胀近 20 GB、以及纯改 TSX 仍重复执行 Hermes/Strip/Cargo 的耗时与磁盘问题，构建链路实施了以下分层改造：

### 1. Cargo Profile 分层与目录收口

- **新增 `[profile.android-dev]`**（`android/rust/Cargo.toml`）：`--debug` 构建不再强行复用发布级 `fat LTO + codegen-units=1`；改为第三方依赖 `opt-level = 2`（保持真机 120Hz 渲染流畅）、本地核心 crate（`gpuix-android` / `gpuix-native` / `gpui-mobile`）`opt-level = 1` + `lto = false` + `codegen-units = 16` + `incremental = true` + `debug = 0`。同时在 `android-dev` 编译期自动跳过与增量编译冲突的 `sccache`。
- **新增 `[profile.release-fast]`**：通过 `--release --fast`（或 `--aab --fast`）启用 `thin LTO` + `codegen-units = 4` 用于本地快速发布验收。
- **保留 `[profile.release]`**：`opt-level = "z"`、`lto = "fat"`、`codegen-units = 1`、`strip = "symbols"` 保持不变，100% 守住商店级极限包体积。
- **统一收口配置文件**（`android/.cargo/config.toml`）：设置 `[build] target-dir = "target"` 并限制 dev 符号等级（`debug = "line-tables-only"`，第三方依赖 `debug = 0`），防止脱离脚本手跑 `cargo test`/`cargo check` 或 IDE 分析在 `rust/`、`vendor/*` 下各自分裂出 GB 级 `target/`。

### 2. 跨项目全局共享缓存（`GPUIX_CACHE_DIR`）与指纹跳过

默认启用 `GPUIX_SHARED_CACHE=1`，缓存目录位于 `${GPUIX_CACHE_DIR:-${XDG_CACHE_HOME:-$HOME/.cache}/gpuix-android}`（可设 `GPUIX_SHARED_CACHE=0` 切换为本地隔离模式）：

- **`deps/`（源码依赖共享）**：Unix 下通过符号链接将 `.deps/{zed,hermes,hermes-libuv}` 指向共享目录，避免每个项目重复克隆上百 MB 源码。
- **`hermes/<key>/`（Hermes 产物指纹缓存）**：按操作系统架构、`hermes_commit`、`libuv_tag`、NDK 版本及 `android/hermes/*` 内容 SHA-256 缓存 `hermesc` 与 `libgpuix_js.so`，仅在内容变更时更新本地文件，避免破坏 mtime 触发 `build.rs` 重链接。
- **`cargo-target/`（共享编译缓存）**：通过 `CARGO_TARGET_DIR` 指向共享位置，并复用 `.deps/zed` 统一路径。
- **`native/<key>/`（`.so` 内容指纹缓存，LRU 上限 8 份）**：综合 profile、features、NDK、`rustc -vV`、`.deps/zed` 提交与脏状态、`.cargo/config.toml`、`rust/`、`vendor/{gpuix-native,gpui-mobile}` 及 `libgpuix_js.so` 计算 SHA-256。命中后**完全跳过 `cargo ndk` 与 `llvm-strip`**，且对 `jniLibs` 仅在字节变化时替换文件以保住 Gradle `UP-TO-DATE` 增量状态。
- **`--js-only` 与 `.hbc` 增量跳过**：`build-js.ts` 基于 Bundle 内容与 `hermesc` 状态做 SHA-256（记录于 `.build/.hbc-input.sha256`）避免重复调用 `hermesc`；使用 `--js-only` 可直接复用既有 `.so` 完成毫秒级打包。

### 3. 并发调度与前台防卡顿

- 默认编译并发放开至 `max(2, ncpu - 1)`（8 核机器默认 `GPUIX_BUILD_JOBS=7`，支持环境变量覆写），并通过 `nice -n 10` 低调度优先级执行 `cmake --build`、`cargo ndk` 与 `gradlew`——既充分利用空闲多核缩短等待，又确保前台编辑、调试交互不被抢占卡顿。

### 4. 构建耗时与磁盘占用实测（基于 `gpuix-base-ui` / 8 核 Apple Silicon）

| 场景 / 指标 | 优化前基线 | 优化后实测 | 变化与说明 |
| :--- | :--- | :--- | :--- |
| **Debug 二次打包（全缓存命中）** | 每次重新触发 Cargo/Strip | **`1.59 s`** | `Native cache hit` 跳过 `cargo ndk`，Gradle 620ms |
| **Debug 纯改 JS 打包（`--js-only`）** | 走完整构建脚本 | **`0.69 s`** | 直接跳过 `.deps`/Hermes/Cargo/Strip，Gradle 479ms |
| **Release 二次打包（全缓存命中）** | 每次重新触发 Cargo/Strip | **`1.44 s`** | Release APK 保持 **`16,571,169 B`**（与优化前 100% 一致） |
| **Release 首次建缓存（复用 target）** | — | **`4.74 s`** | 写入 `native` 指纹缓存，Gradle 1s |
| **`gpuix-android` 仓库目录占用** | `16 GB`（含 4 份分裂 `target/`） | **`713 MB`** | 彻底消除分裂 `target/`，回收冗余缓存 ~12.4 GB |
| **`gpuix-app-starter` 目录占用** | `526 MB`（含重复 `.deps`） | **`109 MB`** | 通过软链接共享 `deps/` |
| **全局共享缓存（`~/.cache/gpuix-android`）** | — | **`5.20 GiB`** | 含 `deps 308 MiB`、`hermes 69.5 MiB`、`cargo-target 4.81 GiB`、`native 26.8 MiB` |

> 注：`debug-1`（从已编入约半数依赖的 `cargo-target` 续编 `android-dev` 剩余 ~150 个 crate 含 `gpui`/`wgpu` 并首次打 debug APK）耗时 `77.83 s`；`gpuix-base-ui-debug.apk` 体积为 `27,637,125 B`。可使用 `gpuix cache status` 与 `gpuix cache clean [--all]` 随时巡检与回收空间。

---

## 四、2026-11-24 全栈架构重构、重建压测与 `gpuix bench` 实测

围绕同进程 Activity 重建稳定性、`android/runtime` 与 Java 插件解耦、SourceMap 堆栈反解、受管宿主模式以及 16KB ELF 页对齐构建门禁，完成以下更新与真机复测：

### 1. 静态检查、自动化测试与空间清理

- **`gpuix-android` 单测与类型检查**：`bun test`（覆盖 `android/runtime` 全量 11 个 `GPX1` 二进制 Opcode/UTF-8/URL/Web APIs/Bridge/WebSocket/Viewport、`config.ts`、`scripts/sourcemap.ts` 及受管宿主 `init`/`eject`、Android 16/17 `SurfaceFlinger` 图层解析）18 pass / 0 fail（150 expect() calls），`tsc` 0 错误。
- **Rust 核心单测与目录收敛**：`gpui-mobile` 宿主机 `cargo test --lib` 26 passed / 0 failed（统一至全局 `CARGO_TARGET_DIR`），确认无任何 `android/vendor/*/target` 目录生成；通过 `bun scripts/gpuix.ts cache clean` 清理历史残留 `android/vendor/gpuix-native/target`（`2.96 GiB`）与过期 debug target（`122 MiB`），共回收 `3.08 GiB`。

### 2. 构建耗时、16KB 对齐门禁与 `gpuix bench` 产物分解

在 `gpuix-base-ui`（`playground.tsx`）受管构建模式下实测：

- **Debug 构建耗时**：`21.40 s`（`21,402 ms`），`app.hbc` `1,545,379 B`，`Verified 16KB ELF LOAD alignment (arm64-v8a)` 通过。
- **Release 首次构建耗时**（含主动会话让位重构编译）：`96.19 s`（`96,190 ms`）。
- **Release 二次热缓存构建耗时**：`1.38 s`（`1,375 ms`，命中 `Native cache hit` 跳过 Cargo，Gradle 耗时 `468 ms`）。
- **`gpuix bench` Release APK 分项与对齐输出**（`sha256=f86bbd1fb120`）：
  - **总大小**：`16.8 MiB`（`17,635,557 B`）
  - **Native `.so`（16KB `LOAD >= 0x4000` 验证通过）**：`15.4 MiB`（`libgpuix_android.so=11.0 MiB`、`libgpuix_js.so=2.99 MiB`、`libc++_shared.so=1.36 MiB`）
  - **JS/HBC**：`1.28 MiB`（`assets/gpuix/app.hbc` `1,344,284 B`）
  - **DEX / Resources**：`58.9 KiB` / `103 KiB`

### 3. 真机冷启、同进程连续重建压测与帧延迟基准

- **测试设备**：OPPO PKC110（`SWS8GUDUGIHECIMN`，120Hz Vulkan）
- **冷启动**：`LaunchState: COLD`，`TotalTime: 659 ms`（`WaitTime: 664 ms`），进程 PID `23461`，已装 APK 与本地 SHA-256 校验一致（`f86bbd1fb120`）。
- **同进程连续 3 轮 `FLAG_ACTIVITY_CLEAR_TASK` 销毁重建压测**（最严苛的“先创建新 Activity、旧会话尚存”并发重建场景）：
  - 第 1/2/3 轮 `LaunchState: WARM` 耗时分别为 **`262 ms`**、**`273 ms`**、**`329 ms`**（`WaitTime` `269 / 277 / 336 ms`）；
  - 同 PID（`23461`）内完整记录 3 次 `superseding previous active Android session` → `shutdown_platform: cleared active AndroidPlatform session`（约 `3–4 ms` 完成退场）→ `init_platform: AndroidPlatform created` → `Executing Hermes bundle gpuix/app.hbc`；
  - 全程 **`must construct App on main thread` = 0 次**、`PANIC` = 0 次、`FATAL EXCEPTION` = 0 次、`SIGSEGV`/`SIGABRT` = 0 次。
- **交互滑动后 `gpuix bench` 帧延迟实测**（图层 `VRI-dev.gpuix.baseui/dev.gpui.mobile.GpuiActivity#267876`）：
  - 有效帧间隔样本 `N=62`，**`P50 = 8.33 ms`、`P99 = 8.53 ms`，估算帧率 `120.1 fps`（120 Hz 面板）**。

### 4. OTA 热更新合并最终版验收（2026-11-24）

- **自动化测试与工具链校验**：
  - `gpuix-android`：`bun test` 26 pass / 0 fail（195 expect() calls，覆盖 `cli-config.test.ts`、`runtime.test.ts`（含 `gpuix.ota` 与 `__gpuixHotCleanup`）、`ota.test.ts` 与 Java `SHA256withECDSA` 跨语言验签）；`tsc --noEmit` 0 错误；`npm pack --dry-run`（303 files）通过；
  - Rust OTA 核心状态机：`rustc --edition 2021 --test android/rust/src/ota.rs` 6 passed / 0 failed；
  - OTA 签名工具链端到端校验：`gpuix ota keygen` → `gpuix ota build`（为 `gpuix-base-ui` 生成 `app.hbc` `1,349,477 B`，ECDSA P-256 签名）→ `gpuix ota verify` 验签通过。
- **最终版 Release APK 构建与产物分项**（`gpuix-base-ui-release.apk`，`sha256=3c2a222eb57b237677cfacbcbf1b0f2e6c395d5e57dd1880c20d8c369d3da2c0`）：
  - 首次全缓存刷新构建（含 `runner.cpp` Hermes 编译与 `libgpuix_android.so` 重编）：`246.25 s`；
  - 二次热缓存构建（命中 `Native cache hit (arm64-v8a 91b7176fd8c4, profile=release)` 与 `Android HBC up to date`，Gradle `524 ms`）：**`1.59 s`**；
  - 通过 `Verified 16KB ELF LOAD alignment (arm64-v8a)`；
  - APK 总大小：**`17,710,039 B`（`16.89 MiB`）**，关键分项为 `lib/arm64-v8a/libgpuix_android.so` `11,586,680 B`、`lib/arm64-v8a/libgpuix_js.so` `3,139,248 B`、`lib/arm64-v8a/libc++_shared.so` `1,423,696 B`、`assets/gpuix/app.hbc` `1,349,443 B`、`classes.dex` `161,060 B`、`assets/gpuix/ota-meta.kv` `256 B`（`embedded_format=hbc`、`embedded_build_id=9d48989111f590cead806f6d843a0115bee7c2e02d4c3ee5e50d85cdd5373b94`）。
- **真机全套回归实测（OPPO PKC110 / `SWS8GUDUGIHECIMN`）**：
  - **装机冷启与同进程 `CLEAR_TASK` 压测**：首次冷启 `LaunchState: COLD`、`TotalTime: 773 ms`（`WaitTime: 783 ms`，`PID: 7022`；后续冷启 `TotalTime: 374 ms`）；同进程连续 3 轮 `FLAG_ACTIVITY_CLEAR_TASK` 销毁重建 `3/3 Status: ok`（`LaunchState: WARM`，`TotalTime: 287 ms / 292 ms / 304 ms`），压测前后均保持同 `PID 7022`，logcat 确认 3 次完整执行主动退场→重建，且 `must construct App on main thread` / `PANIC` / `FATAL EXCEPTION` / `SIGSEGV` / `SIGABRT` 为 **0 次**；
  - **路由与 120Hz `gpuix bench` 实测**：`gpuix://native-demo` Deep Link 触发 `onNewIntent` / `nativeOnDeepLink` 且 0 错误；首页往返滑动后在图层 `VRI-dev.gpuix.baseui/dev.gpui.mobile.GpuiActivity#268830` 采样 `N=57` 帧间隔，核验设备与本地 SHA-256（`3c2a222eb57b`）及 16KB 对齐一致，实测 **`P50 = 8.33 ms`、`P99 = 8.54 ms`，估算 `120.1 fps`**。
- **真机免重装 OTA 全链路闭环实测**（临时测试包 `dev.gpuix.otatest`，开启 ECDSA P-256 `publicKey` + `checkOnLaunch: "immediate"`）：
  - **V1 → V2（`r2-hot-ok`，`1,055,428 B`）同进程热切换**：配合 `gpuix ota serve` 与 `adb reverse tcp:8787`，冷启后 2.5s 自动拉取验签，同进程 `PID 10179` 内 ~`9 ms` 完成 `CLEANUP_FROM_V1` → `Hot-evaluating Hermes HBC ota:r2-hot-ok` → `mount complete`，1.5s 自动 confirm 后 `getState()` 返回 `"source":"ota"`、`"currentReleaseId":"r2-hot-ok"`、`"confirmed":true`；
  - **脱机冷启持久化**：停服并移除 `adb reverse` 后冷启（`PID 10496`，`TotalTime: 421 ms`），直接运行 `Booting OTA bundle r2-hot-ok (1055428 bytes, confirmed=true)`，未再回退内置 V1；
  - **V3 坏包（`r3-bad-crash`，`556 B` 顶层抛错）自动回滚**：热切换触发 `INTENTIONAL_V3_CRASH` 后约 `8 ms` 自动触发 `Auto-rolling back failed OTA r3-bad-crash -> r2-hot-ok`，状态记录 `failedReleaseIds: ["r3-bad-crash"]`，同进程 `PID 10669` 存活、Native 崩溃 **0 次**。

### 5. Native-First 底座优先 OTA 自愈、权限裁剪与零依赖高频轻能力最终验收（2026-11-24）

- **Native-First 自愈四场景真机硬核验收**（OPPO PKC110 / `SWS8GUDUGIHECIMN`，独立验证包 `dev.gpuix.otarescue`，配置 `checkOnLaunch: "manual"`、`permissions: ["CAMERA", "VIBRATE"]`）：
  - **声明式权限裁剪**：`aapt2 dump permissions` 核验输出严格为 `INTERNET`、`CAMERA`、`VIBRATE` 3 项声明权限，未申报权限已彻底剔除；
  - **场景 1 · `checkOnLaunch: "manual"` 下开屏秒崩抢救**：在 V1 内置包模拟开屏 API 挂掉连崩两次积累 `boot_crash_streak=1` 后，第 3 次冷启 `onNativeBootStart` 在业务 JS 执行前触发 `Entering Native-First OTA rescue mode (bootCrashStreak=2)`，于 **90 ms** 内完成 ECDSA 验签下载并原子激活 `r2-splash-fix`（`1,060,842 B`），`518 ms` 完成首帧挂载、`V1_SPLASH_API_502_CRASH = 0` 次，2s 自动确认后持久化 `active_confirmed=1`、`min_manifest_seq=2001`、`boot_crash_streak=0`；
  - **场景 2a · 单调序号防降级**：下发 `seq 1999` 旧序号包 `r2-downgrade`，V2 `check()` 当场拦截返回 `available=false, reason="downgrade_blocked"`；
  - **场景 2b · 死循环 Watchdog 心跳超时重启自愈**：V2 热切入含 `while (true) {}` 的 `r3-hang`（`seq 2002`，`481 B`）后，Watchdog 于心跳超时精确触发 `JS thread heartbeat timeout (2500ms); triggering OTA watchdog recovery`，拉黑 `r3-hang` 并于 **397 ms** 内自动重启新进程 `PID 14166` 恢复 `r2-splash-fix`；后续 `check()` 命中黑名单返回 `reason="blocklisted"`；
  - **场景 3 · 远端签名 Kill Switch 熔断**：下发 `ota build --rollback-to-embedded --seq 2003`（`kill-2003`，带 ECDSA P-256 `manifestSignature`），验签后即时触发 `applyKillSwitchLocked` + `nativeTriggerHotRollback()`，状态切回 `source="embedded"`、`minManifestSeq=2003`、`lastRollbackReason="Remote kill-switch rollback"` 并热切回内置包执行。
- **最终版 Release APK 构建、增量开销与真机全量回归**（`gpuix-base-ui-release.apk`，`sha256=679cca89b5081a1562c6aba5c4beb703c9ba5308dcf6d46f45db144564107a04`）：
  - 首次 Rust `release` 刷新编译总耗时 `117.92 s`（Gradle `8 s`）；二次热缓存命中 `Native cache hit (arm64-v8a 29a3c7449d22, profile=release)` 与 `Android HBC up to date (e3571fc90552)`（Gradle `534 ms`），总耗时 **`2.19 s`**；通过 `Verified 16KB ELF LOAD alignment (arm64-v8a)` 与默认全量 9 项权限完整校验；
  - APK 总大小 **`17,732,767 B`（`16.91 MiB`）**：对比上线全部零外部依赖高频轻能力（`FileTransferPlugin` 沙箱 `fs` + 流式 `transfer`、`saveToGallery`/`compressImage`、`networkChange`/`appState`/`launcher`）及 Native-First 自愈代码前（`17,710,039 B`），整包增量仅 **`+22.2 KiB`**（关键分项：`libgpuix_android.so` `11,599,256 B`、`libgpuix_js.so` `3,139,680 B`、`libc++_shared.so` `1,423,696 B`、`assets/gpuix/app.hbc` `1,355,353 B`、`classes.dex` `188,620 B`、`assets/gpuix/ota-meta.kv` `272 B` 含 `hbc_version=100`）；
  - 真机装机与压力回归（PKC110 / `SWS8GUDUGIHECIMN`）：设备与本地 APK SHA-256 一致；首次冷启 `TotalTime: 787 ms`（后续冷启 `335 ms`，`PID=18479`）；同进程 3 轮 `FLAG_ACTIVITY_CLEAR_TASK` 销毁重建 `LaunchState: WARM` 耗时 **`228 ms` / `243 ms` / `264 ms`**（始终保持同 `PID 18479`，3 次 `superseding`/`shutdown_platform`，`must construct App on main thread`、`PANIC`、`FATAL EXCEPTION`、`SIGSEGV`/`SIGABRT`、JS 错误均为 **0 次**）；`gpuix://native-demo` 路由 0 异常；首页往返滑动后采样图层 `VRI-dev.gpuix.baseui/dev.gpui.mobile.GpuiActivity#270369`（`N=61`），实测 **`P50 = 8.33 ms`、`P99 = 8.42 ms`、`120.0 fps`（panel 120 Hz）**。
