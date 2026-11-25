# Architecture

[简体中文](ARCHITECTURE.zh-CN.md)

## Goal

`gpuix-mobile` places a narrow project contract in front of the native mobile runtime:
an application supplies one React entry point and one configuration file. The
framework hides Hermes startup, retained-tree transport, GPUI layout and paint,
wgpu surface management, mobile input and artifact assembly across Android and iOS.

```text
Application TSX
      │ React props and state
      ▼
gpuix-base-ui / application components
      │ @gpuix/react retained tree
      ▼
standalone Hermes (runtime/)
      │ N-API mutation and event protocol
      ▼
gpuix-native + gpui-mobile (native/vendor/)
      │ GPUI layout/paint + wgpu
      ▼
Android SurfaceFlinger (Vulkan) / iOS UIKit (Metal)
```

The native hosts contain no WebView and do not use React Native's view
system. JavaScript state commits still have a cost; native rendering is not a
claim that JavaScript work is free.

## Repository ownership

| Path | Responsibility | Application ownership |
| --- | --- | --- |
| `scripts/gpuix.ts` | Unified mobile project CLI | Call only |
| `scripts/config.ts`, `bundler.ts`, `ota*.ts` | Config schema, JS/HBC bundler, OTA hash chain & Merkle toolchain | Call only |
| `runtime/` | Shared mobile JS runtime & `GpuixNativeSdk` | Framework maintained |
| `native/hermes`, `native/vendor/` | Shared Hermes host, `gpuix-native`, `gpui-mobile` | Framework maintained |
| `templates/react-gpui` | Generated app skeleton | Customize after generation |
| `android/` | Android host entry, Gradle/Java plugins and build adapter | Managed or `--eject` |
| `ios/` | iOS host entry (`Info.plist.template`, `main.m`, Rust bridge) and Simulator runner | Managed |
| `gpuix.config.json` | App identity, entry point, `versionName`/`versionCode` and platform/OTA config | Application maintained |

## Project contract

```json
{
  "entrypoint": "src/main.tsx",
  "appId": "com.example.myapp",
  "appName": "My App",
  "versionName": "0.1.0",
  "versionCode": 1
}
```

`appId` is the installed Android identity. `versionCode` must increase for
every store release. Generated Gradle properties are build output and must not
be edited directly.

## Rendering and power contract

- React mutations are batched into the retained tree before GPUI layout/paint.
- Static pages are demand-driven and do not continuously repaint.
- Drag or momentum scrolling promotes to the selected interaction ceiling.
- Settled content returns to a 30 Hz application request.
- After 60 seconds without input, the app releases its frame-rate preference.
- Android may clamp any request because of Battery Saver, thermal policy,
  display mode availability or OEM rules.
- The diagnostic GPU FPS is application redraw rate, not proof of the physical
  panel refresh rate. SurfaceFlinger/HWC and system policy remain authoritative.

## Platform seams

Android is the first concrete adapter. A future iOS or macOS host should keep
the same external project contract and provide separate build/signing adapters;
it should not add platform switches throughout application code.
