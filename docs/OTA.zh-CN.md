# GPUIX Mobile 生产级 OTA 热更新指南

GPUIX Mobile 内置了零第三方托管锁定、纯静态文件驱动的生产级 OTA（Over-The-Air）热更新能力，并提供**版本号关联、分块 RFC 6962 Merkle Tree、发布哈希链（Hash Chain）与防篡改包含证明**。业务修改 JS / TSX 后，无需重新打包或重新安装原生应用，即可把新版本 Hermes 字节码（`.hbc`）安全推送到端上，并支持同进程热切换、冷重启生效与 Crash-Loop 自动回滚。

---

## 一、架构总览

```text
开发者机器 / CI
  ├── gpuix ota keygen             生成 ECDSA P-256 签名密钥对
  ├── gpuix ota build              产出 app.hbc + merkle.json + manifest.json + chain.json（ECDSA v2 签名）
  ├── gpuix ota verify             校验清单签名、分块 Merkle Root 与哈希链连续性
  ├── gpuix ota chain [--verify]   校验整条发布哈希链与 Chain Merkle Root
  ├── gpuix ota proof <QUERY>      导出单版本在发布链中的包含证明，或 --chunk N 的分块 Merkle 证明
  ├── gpuix ota locate <QUERY>     通过 releaseId / v1.1.1 / #索引 / SHA-256 前缀定位历史版本与产物路径
  └── 上传到任意静态对象存储 / CDN / GitHub Releases（或本地 gpuix ota serve）
                │
                ▼ HTTPS (Release 强制 HTTPS)
移动端原生层
  ├── GpuiOtaManager.java          流式下载 -> 32 MiB 限制 -> SHA-256 -> SHA256withECDSA（兼容 v1/v2 清单载荷）
  │     └── filesDir/gpuix_ota/state.kv（与 Rust 共用原子状态机）
  ├── android/rust/src/lib.rs & ota.rs
  │     ├── 冷启校验 baseline 三元组（versionCode + runtimeVersion + embeddedBuildId）
  │     ├── Crash-Loop Guard（未确认启动失败 >= 2 次自动回滚 prev / embedded）
  │     └── nativeTriggerHotApply / nativeTriggerHotRollback
  └── native/hermes/runner.cpp
        └── __gpuixHotCleanup() -> 清理定时器/rAF -> 持久化内存运行新 .hbc
```

---

## 二、快速开始

### 1. 生成签名密钥对（可选但强烈建议用于生产环境）

```sh
gpuix ota keygen --out .gpuix-ota-keys
```

产物包含：
- `.gpuix-ota-keys/ota-private.pem`：私钥（仅用于 CI/发版机签名，**严禁提交进 Git**）。
- `.gpuix-ota-keys/ota-public.b64`：SPKI Base64 公钥，写入 `gpuix.config.json`（向下兼容 `gpuix.android.json`）。

### 2. 在 `gpuix.config.json` 中启用 OTA 配置

```json
{
  "entrypoint": "src/main.tsx",
  "appId": "com.example.myapp",
  "appName": "My App",
  "versionName": "1.0.0",
  "versionCode": 1,
  "ota": {
    "manifestUrl": "https://cdn.example.com/myapp/production/manifest.json",
    "channel": "production",
    "runtimeVersion": "1",
    "publicKey": "<来自 ota-public.b64 的单行 Base64 公钥>",
    "checkOnLaunch": "background"
  }
}
```

配置说明：
- `manifestUrl`：远端 `manifest.json` 地址；Release 包强制 `https://`，Debug 包允许 `http://127.0.0.1` 配合 `adb reverse` 联调。
- `channel`：发布通道名（默认 `"production"`，匹配 `^[A-Za-z0-9._-]{1,64}$`）。
- `runtimeVersion`：原生二进制兼容版本号（默认等于 `String(versionCode)`）。当原生 Rust/Java/ABI 或 Bridge API 发生不兼容变更时，务必递增 `runtimeVersion`；旧版包会安全跳过不匹配的 OTA 包。
- `publicKey`：可选 ECDSA P-256 SPKI 公钥（支持 Base64 或 PEM）；配置后，客户端将强制校验 `bundle.signature` 与 `manifestSignature`。
- `checkOnLaunch`：
  - `"manual"`（默认）：正常启动由业务代码调用 `gpuix.ota.check()` 触发；但当底座检测到连续早崩救援（`bootCrashStreak >= 2`）时，即使设为 `"manual"`，Native 底座仍会抢先尝试远端救援拉包；
  - `"background"`：Native 启动阶段及/或应用首帧挂载后静默检查并下载为 `staged`，下次冷启无缝生效（`mandatory: true` 仍会立即热切换）；
  - `"immediate"`：启动检查到新版本后，下载并立即热切换生效。
- 声明式权限裁剪（`gpuix.config.json -> android.permissions` 或顶层 `permissions`）：可选字符串数组（如 `["CAMERA", "VIBRATE"]`）。配置后，`scripts/config.ts` 会在 `android/.build/AndroidManifest.xml` 中自动生成裁剪后的权限清单并始终保留 `INTERNET`；未配置时保留默认全量底座权限。

### 3. 构建 OTA 发布、哈希链与 Merkle 证明

修改完页面代码后，执行：

```sh
gpuix ota build \
  --cwd . \
  --out dist/ota \
  --platform all \
  --version 1.1.1 \
  --seq 2001 \
  --base-url https://cdn.example.com/myapp/production \
  --private-key .gpuix-ota-keys/ota-private.pem \
  --notes "Fix layout and update copy"

gpuix ota verify dist/ota/manifest.json --public-key .gpuix-ota-keys/ota-public.b64
gpuix ota chain --dir dist/ota --verify
gpuix ota locate v1.1.1 --dir dist/ota
gpuix ota proof v1.1.1 --dir dist/ota
gpuix ota proof v1.1.1 --dir dist/ota --chunk 0
```

每次 `gpuix ota build` 均会：
1. 将 `.hbc`/`.js` 按 `--chunk-size`（默认 `65536` 字节）切块并构造 RFC 6962 `SHA-256` Merkle Tree，输出 `bundles/<releaseId>/merkle.json`。
2. 以 `prevReleaseHash` 链接上一版 `releaseHash`（首版为 64 个 `0`），把 `versionName`、`runtimeVersion`、`manifestSeq`、`bundleSha256` 与 `merkleRoot` 共同摘要成当前 `releaseHash`，追加写入 `dist/ota/chain.json` 并刷新全链 `chainMerkleRoot`。
3. 将 `integrity`（含 `merkleRoot`、`prevReleaseHash`、`releaseHash`、`chainIndex`、`chainMerkleRoot`）写入 `manifest.json`，使用 `gpuix-ota-manifest-v2` 规范载荷执行 ECDSA P-256 签名。

如需在紧急故障时从服务端签发“熔断回退至内置包”指令，可执行：

```sh
gpuix ota build \
  --rollback-to-embedded \
  --cwd . \
  --out dist/ota \
  --release-id kill-2003 \
  --seq 2003 \
  --private-key .gpuix-ota-keys/ota-private.pem
```

随后把 `dist/ota/` 目录（`manifest.json`、`chain.json` 与 `bundles/`）上传到任意静态 HTTP 服务即可。

---

## 三、本地真机免重装闭环测试

1. 确保手机已安装一次 APK（例如 `gpuix run <ADB_SERIAL>`）。
2. 修改你的 `.tsx` 页面文案或逻辑，执行 OTA 打包（如未配置正式签名可省略 `--private-key`）：
   ```sh
   gpuix ota build --out dist/ota --notes "local hot test"
   ```
3. 启动本地 OTA 静态服务器并自动打通 `adb reverse tcp:8787 tcp:8787`：
   ```sh
   gpuix ota serve <ADB_SERIAL> --dir dist/ota --port 8787
   ```
4. 在 App 内调用 `gpuix.ota` API（或直接打开 `gpuix-base-ui` 原生实验室第 11 张「OTA 生产热更新」卡片），传入 `http://127.0.0.1:8787/manifest.json`：
   - 点击 **检查更新** -> **下载包** -> **立即热切换**，当前进程即可在约 100ms 内切换为新 `.hbc` 界面，全程无需重装 APK。

---

## 四、JavaScript SDK API

通过 `globalThis.gpuix.ota` 访问：

- `getState()`：获取当前运行源（`"embedded"` | `"ota"`）、版本、`hbcVersion`、确认状态（`confirmed`）、连续启崩计数（`bootCrashStreak`）、救援态（`rescueMode`）、最低防降级序号（`minManifestSeq`）、原生首检去重标志（`nativeLaunchCheckStarted`）、已暂存版本、黑名单（`failedReleaseIds`）与回滚原因（`lastRollbackReason`）。
- `check({ manifestUrl?, channel?, timeoutMs?, headers? })`：拉取并校验远端 `manifest.json`；当遇到低序号、Kill Switch 熔断、黑名单或不兼容包时，返回对应 `reason`（`downgrade_blocked`、`rollback_to_embedded`、`blocklisted`、`hbc_version_mismatch` 等）。
- `download({ manifest?, manifestUrl?, timeoutMs?, headers? })`：流式下载 bundle，校验体积上限、磁盘剩余空间（`StatFs >= 16 MiB`）、SHA-256、HBC 魔数、字节码版本号与 ECDSA 签名，POSIX 原子落盘为 `staged`。
- `apply({ mode?: "hot" | "next_launch" | "restart" })`：
  - `"hot"`（默认）：当前 Hermes 运行时执行 `__gpuixHotCleanup()`、清理旧定时器/rAF 后立即切换至新 `.hbc` 并重新挂载 Watchdog；
  - `"next_launch"`：标记为 `active`，等待下次冷启自动加载；
  - `"restart"`：拉起全新应用进程后退出当前进程，获得干净初始态。
- `confirm()`：将当前 `active` OTA 标记为稳定已确认并清零 `bootInProgress` / `bootCrashStreak`（框架默认在首帧提交成功 2000ms 后自动确认；也可通过 `setManualConfirm(true)` 改为业务主动确认）。
- `rollback({ applyNow?, mode?, reason? })`：立即回退到上一个已确认版本或 APK 内置 bundle，并将当前问题版本加入 `failedReleaseIds`。
- `reset({ applyNow? })`：清除全部 OTA 缓存与状态并切回 APK 内置 bundle。
- `onProgress(cb)`：订阅 `{ releaseId, bytesReceived, totalBytes, progress, phase }` 下载进度事件。

---

## 五、安全、Native-First 救援与自愈机制

1. **Native-First 底座优先启动救援**：`GpuiActivity.onCreate()` 在 `System.loadLibrary` 之后、`super.onCreate()` 拉起 Rust/Hermes 之前即同步调用 `GpuiOtaManager.onNativeBootStart()`。若上轮启动未健康打卡就崩溃退出且连续失败达阈值（`bootCrashStreak >= 2`），即使配置为 `checkOnLaunch: "manual"` 也会立刻通过 Rust `BOOT_GATE` Condvar 挂起 JS 引擎并保持系统 Splash，先在 Native 层同步拉取远端修复包（或降级回健康版本/内置包）后再放行执行 JS，彻底解决“开屏 API 502/异常导致业务 JS 刚启动即闪退无法拉取修复包”的问题。
2. **JS 线程心跳 Watchdog（死循环/卡死自愈）**：`runner.cpp` 提供无锁心跳探针 `gpuix_js_ping_async()` / `gpuix_js_ping_ack()`。冷启与 `nativeTriggerHotApply` 热切换均会启动看门狗线程；若在初始挂起窗口后心跳停滞达 `2500 ms`，Watchdog 会将当前未确认 OTA 记入 `failedReleaseIds` 并通过 JNI 调用 `requestProcessRestartFromNative()` 自动重启至上一稳定版本或内置包。
3. **跨语言文件锁与 POSIX 原子落盘**：`GpuiOtaManager.java` 与 `android/rust/src/ota.rs` 通过 `filesDir/gpuix_ota/state.lock`（5 ms 退避、5 s 过期自动回收）串行化对 `state.kv` 的读写；文件激活替换取消非原子 `delete()`，先写入临时文件再单次 `rename` 覆盖。
4. **ECDSA P-256 双向验签、`manifestSeq` 防降级与远端 Kill Switch**：同时对 `bundle.signature` 与 `manifestSignature` 进行权威签名校验；`minManifestSeq` 单调递增阻止旧序号清单回放；签名校验通过的 `action="rollback_to_embedded"` 会立即触发 `nativeTriggerHotRollback()` 安全熔断回退至内置包。
5. **APK 覆盖/商店升级自动淘汰与字节码 ABI 门禁**：冷启同步校验 `(versionCode, runtimeVersion, embeddedBuildId)` 三元组，并在构建阶段写入 `ota-meta.kv -> hbc_version`，运行期读取 `.hbc` 头部 8..12 字节确保与当前 Hermes 引擎版本严格匹配。
6. **路径穿越与资源边界**：严格限制 `releaseId` 仅含 `[A-Za-z0-9._-]` 且禁止 `..`，强制单包上限 `32 MiB`、下载前要求磁盘可用空间 `>= 16 MiB`，Release 模式强制 `https://`。
