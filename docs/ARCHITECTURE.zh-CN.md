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
| `android/vendor/gpuix-native` | GPUIX retained tree、N-API renderer、原生绘制 | 由框架维护 |
| `android/vendor/gpui-mobile` | Android window、输入、insets、滚动和帧策略 | 由框架维护 |
| `android/rust`、`android/hermes` | 每个 App 的 Android 入口和 Hermes 装载 | 框架模板 |
| `android/scripts` | JS 打包、Hermes、Rust、Gradle、APK/AAB 产物 | CLI 调用 |
| `gpuix.android.json` | App 身份、入口和版本 | 每个 App 必须维护 |
| `templates/react-gpui/src/main.tsx` | App 根组件模板 | 新项目的业务入口 |

## 外部接口（刻意保持小）

新项目只需要提供一个 TSX entrypoint，并维护一个配置文件：

```json
{
  "entrypoint": "src/main.tsx",
  "appId": "com.example.myapp",
  "appName": "My App",
  "versionName": "0.1.0",
  "versionCode": 1
}
```

其余复杂度藏在 Android host 和构建脚本中。这样新的业务项目不会复制一套 native
渲染逻辑，也不会在每个项目里重新解决 Hermes、surface、insets、滚动和 APK 产物路径。

## 交互和性能契约

- JS Bundle 在构建阶段预编译为零压缩 Hermes 字节码（`.hbc`），首帧启动同步加载核心字体并由后台线程分批懒加载 CJK/Emoji 字体。
- JS UI 突变优先经 `GPX1` 零拷贝二进制突变协议 + 驻留 `StyleTable` 进入锁外预处理与 retained tree 合并，静态页面不主动重绘。
- 窗口尺寸与安全区 insets 通过 `SharedWindowMetrics` 无锁快照与主动 `windowResize`/`windowInsets` Push 事件同步，避免 JS 轮询。
- 渲染帧调度直接绑定 Android `AChoreographer` 硬件 VSync（`PresentMode::Fifo`）并采集 `pointer.history()` 历史触控样本；手势越过阈值或原生 Motion Spring 动画运行期间自动联动交互高刷，静止后恢复省电刷新策略。
- 用户选择的刷新率是交互上限。系统低电量或 OEM 策略可以把 90/120 等请求压到
  实际允许值，App 不要求用户手动改设置。
- Android 的状态栏、导航栏和 display cutout 通过 native insets 传入 UI；业务页面
  不应把屏幕尺寸硬编码成某一台手机。
- `gpuix-native` 的“GPU 绘制 FPS”是应用重绘频率，不等同于物理面板刷新率；硬件
  最终状态以 SurfaceFlinger/HWC 和系统策略为准。

完整优化方案与实测体积、耗时及冷启基准见 [PERFORMANCE.zh-CN.md](PERFORMANCE.zh-CN.md)。
