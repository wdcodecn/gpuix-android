# GPUIX Android 生产级 OTA 热更新指南

GPUIX Android 内置了零第三方托管锁定、纯静态文件驱动的生产级 OTA（Over-The-Air）热更新能力。业务修改 JS / TSX 后，无需重新打包或重新安装 APK，即可通过 GitHub Releases / Cloudflare R2 / S3 / OSS / Nginx 或本地调试服务把新版本 Hermes 字节码（`.hbc`）安全推送到真机，并支持同进程热切换、冷重启生效与 Crash-Loop 自动回滚。

---

## 一、架构总览

```text
开发者机器 / CI
  ├── gpuix ota keygen             生成 ECDSA P-256 签名密钥对
  ├── gpuix ota build              产出 app.hbc + manifest.json（含 SHA-256 与 ECDSA 签名）
  ├── gpuix ota verify             校验产物哈希、HBC 魔数与签名
  └── 上传到任意静态对象存储 / CDN / GitHub Releases（或本地 gpuix ota serve）
                │
                ▼ HTTPS (Release 强制 HTTPS)
Android 原生端
  ├── GpuiOtaManager.java          流式下载 -> 32 MiB 限制 -> SHA-256 -> SHA256withECDSA 验签
  │     └── filesDir/gpuix_ota/state.kv（与 Rust 共用原子状态机）
  ├── android/rust/src/lib.rs & ota.rs
  │     ├── 冷启校验 baseline 三元组（versionCode + runtimeVersion + embeddedBuildId）
  │     ├── Crash-Loop Guard（未确认启动失败 >= 2 次自动回滚 prev / embedded）
  │     └── nativeTriggerHotApply / nativeTriggerHotRollback
  └── android/hermes/runner.cpp
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
- `.gpuix-ota-keys/ota-public.b64`：SPKI Base64 公钥，写入 `gpuix.android.json`。

### 2. 在 `gpuix.android.json` 中启用 OTA 配置

```json
{
  "entrypoint": "src/main.tsx",
  "appId": "com.example.myapp",
  "appName": "My App",
  "versionName": "0.1.0",
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
- `runtimeVersion`：原生二进制兼容版本号（默认等于 `String(versionCode)`）。当原生 Rust/Java/ABI 或 Bridge API 发生不兼容变更时，务必递增 `runtimeVersion`；旧版 APK 会安全跳过不匹配的 OTA 包。
- `publicKey`：可选 ECDSA P-256 SPKI 公钥（支持 Base64 或 PEM）；配置后，客户端将强制校验 `bundle.signature`。
- `checkOnLaunch`：
  - `"manual"`（默认）：仅由业务代码调用 `gpuix.ota.check()` 触发；
  - `"background"`：应用首帧挂载 2.5s 后在后台静默检查并下载为 `staged`，下次冷启无缝生效（`mandatory: true` 的发布仍会立即热切换）；
  - `"immediate"`：启动检查到新版本后，下载并立即热切换生效。

### 3. 构建并发布 OTA 包（免重装 APK）

修改完页面代码后，执行：

```sh
gpuix ota build \
  --cwd . \
  --out dist/ota \
  --base-url https://cdn.example.com/myapp/production \
  --private-key .gpuix-ota-keys/ota-private.pem \
  --notes "Fix layout and update copy"

gpuix ota verify dist/ota/manifest.json --public-key .gpuix-ota-keys/ota-public.b64
```

随后把 `dist/ota/` 目录（`manifest.json` + `bundles/<releaseId>/app.hbc`）上传到任意静态 HTTP 服务即可。

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

- `getState()`：获取当前运行源（`"embedded"` | `"ota"`）、版本、确认状态、已暂存版本、黑名单与回滚原因。
- `check({ manifestUrl?, channel?, timeoutMs?, headers? })`：拉取并校验远端 `manifest.json` 是否存在兼容更新。
- `download({ manifest?, manifestUrl?, timeoutMs?, headers? })`：流式下载 bundle，校验体积上限、SHA-256、HBC 魔数与 ECDSA 签名，原子落盘为 `staged`。
- `apply({ mode?: "hot" | "next_launch" | "restart" })`：
  - `"hot"`（默认）：当前 Hermes 运行时执行 `__gpuixHotCleanup()`、清理旧定时器/rAF 后立即切换至新 `.hbc`；
  - `"next_launch"`：标记为 `active`，等待下次冷启自动加载；
  - `"restart"`：拉起全新应用进程后退出当前进程，获得干净初始态。
- `confirm()`：将当前 `active` OTA 标记为稳定已确认（框架默认在首帧提交成功 1500ms 后自动确认；也可通过 `setManualConfirm(true)` 改为业务主动确认）。
- `rollback({ applyNow?, mode?, reason? })`：立即回退到上一个已确认版本或 APK 内置 bundle，并将当前问题版本加入 `failedReleaseIds`。
- `reset({ applyNow? })`：清除全部 OTA 缓存与状态并切回 APK 内置 bundle。
- `onProgress(cb)`：订阅 `{ releaseId, bytesReceived, totalBytes, progress, phase }` 下载进度事件。

---

## 五、安全与自愈机制

1. **APK 覆盖/商店升级自动淘汰**：冷启时校验 `(versionCode, runtimeVersion, embeddedBuildId)` 三元组；一旦用户通过应用商店或 `adb install` 升级了底座 APK，旧版 OTA 状态与缓存自动清理，避免新 APK 反被旧 JS 覆盖。
2. **Crash-Loop Guard（崩溃自愈）**：每次未确认的 OTA 启动计数 `+1`；若连续 2 次未确认即崩溃或退出（或热切换执行同步抛出异常），Rust 启动器与错误钩子自动把该 `releaseId` 拉黑并回滚到上一个已确认健康版本（`prev`）或 APK 内置包（`embedded`）。
3. **路径穿越与体积边界**：严格限制 `releaseId` 仅含 `[A-Za-z0-9._-]` 且禁止 `..`，强制单包上限 `32 MiB`，Release 模式强制 `https://`。
