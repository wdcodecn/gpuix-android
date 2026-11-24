import type {
  GpuixBatchMutation,
  GpuixNativeBinding,
  GpuixNativeSdk,
  GpuixRendererEventCallback,
  GpuixRendererInstance,
  ViewportInsets,
} from './types'
import { getBridgeState, installHotLifecycleHooks } from './bridge-state'
import { installTextPolyfills } from './utf8'
import { installUrlPolyfills } from './url'
import { installWebApis } from './web-apis'
import {
  emitBridgeChannel,
  handleBackPressedEvent,
  handleBridgeChannelEvent,
  handleBridgeResultEvent,
  handleDeepLinkEvent,
  installGpuixSdk,
} from './native-bridge'
import { handleWsEvent, installWebSocket } from './websocket'
import { ensureViewportMetrics } from './viewport'
import { createStyleCache, encodeBatch } from './gpx1'

export function installAndroidRuntime(): void {
  const g = globalThis as Record<string, unknown>
  g.__gpuixAndroid = true
  installHotLifecycleHooks()
  installTextPolyfills()
  installUrlPolyfills()
  installWebApis()
  installWebSocket()
  installGpuixSdk()
  ensureViewportMetrics()
}

installAndroidRuntime()

function scheduleOtaAutoConfirm(): void {
  const state = getBridgeState()
  if (state.otaManualConfirm || state.otaAutoConfirmed) return
  state.otaAutoConfirmed = true
  state.otaAutoConfirmTimer = setTimeout(() => {
    state.otaAutoConfirmTimer = null
    if (state.otaManualConfirm) return
    const sdk = (globalThis as { gpuix?: GpuixNativeSdk }).gpuix
    if (sdk?.ota && typeof sdk.ota.confirm === 'function') {
      sdk.ota.confirm().catch(() => {})
    }
  }, 2000)
}

function scheduleLaunchOtaCheck(): void {
  const state = getBridgeState()
  if (state.otaLaunchChecked) return
  state.otaLaunchChecked = true
  setTimeout(() => {
    const sdk = (globalThis as { gpuix?: GpuixNativeSdk }).gpuix
    if (!sdk?.ota) return
    sdk.ota
      .getState()
      .then((otaState) => {
        if (!otaState || !otaState.manifestUrl || otaState.nativeLaunchCheckStarted) return
        if (otaState.checkOnLaunch !== 'background' && otaState.checkOnLaunch !== 'immediate') return
        return sdk.ota.check({}).then((checkRes) => {
          if (!checkRes || !checkRes.available || !checkRes.manifest) return
          return sdk.ota.download({ manifest: checkRes.manifest }).then((dlRes) => {
            emitBridgeChannel('otaEvent', {
              type: 'downloaded',
              releaseId: dlRes?.releaseId,
              state: dlRes,
            })
            const mandatory = Boolean(checkRes.manifest?.mandatory)
            if (otaState.checkOnLaunch === 'immediate' || mandatory) {
              return sdk.ota.apply({ mode: 'hot' })
            }
          })
        })
      })
      .catch((err) => {
        emitBridgeChannel('otaEvent', {
          type: 'error',
          message: err instanceof Error ? err.message : String(err),
        })
      })
  }, 2500)
}

export function GpuixRenderer(callback?: GpuixRendererEventCallback): GpuixRendererInstance {
  const g = globalThis as {
    __gpuixNative?: GpuixNativeBinding
    __gpuixLastRenderer?: GpuixRendererInstance
  }
  const viewport = ensureViewportMetrics()
  const NativeGpuixRenderer = g.__gpuixNative?.GpuixRenderer
  if (typeof NativeGpuixRenderer !== 'function') {
    throw new Error('__gpuixNative.GpuixRenderer is unavailable')
  }

  const wrappedCallback: GpuixRendererEventCallback | undefined =
    typeof callback === 'function'
      ? (error, event) => {
          if (!error && event && event.elementId === 0) {
            if (
              event.eventType === 'windowResize' &&
              typeof event.width === 'number' &&
              typeof event.height === 'number'
            ) {
              viewport.__emitSize({ width: event.width, height: event.height })
              return
            }
            if (event.eventType === 'windowInsets' && typeof event.value === 'string') {
              try {
                viewport.__emitInsets(JSON.parse(event.value) as ViewportInsets)
              } catch {
                // Ignore malformed event
              }
              return
            }
            if (event.eventType === 'nativeBridgeResult' && typeof event.value === 'string') {
              handleBridgeResultEvent(event.value)
              return
            }
            if (event.eventType === 'nativeBridgeEvent' && typeof event.value === 'string') {
              handleBridgeChannelEvent(event.value)
              return
            }
            if (event.eventType === 'wsEvent' && typeof event.value === 'string') {
              handleWsEvent(event.value)
              return
            }
            if (event.eventType === 'backPressed') {
              handleBackPressedEvent()
              return
            }
            if (event.eventType === 'deepLink' && typeof event.value === 'string') {
              handleDeepLinkEvent(event.value)
              return
            }
            if (event.eventType === 'a11yAction' && typeof event.value === 'string') {
              try {
                emitBridgeChannel('a11yAction', JSON.parse(event.value))
              } catch {
                // Ignore malformed event
              }
              return
            }
          }
          callback(error, event)
        }
      : undefined

  const instance = new NativeGpuixRenderer(wrappedCallback)
  g.__gpuixLastRenderer = instance

  if (typeof instance.applyBatch === 'function') {
    const origApplyBatch = instance.applyBatch.bind(instance)
    instance.applyBatch = (batchJson: string) => {
      const res = origApplyBatch(batchJson)
      scheduleOtaAutoConfirm()
      return res
    }
  }
  if (typeof instance.applyBinaryBatch === 'function') {
    const styleCache = createStyleCache()
    instance.__applyBatchQueue = (queue: GpuixBatchMutation[]) => {
      const bin = encodeBatch(queue, styleCache)
      const res =
        bin !== null
          ? instance.applyBinaryBatch!(bin)
          : instance.applyBatch(JSON.stringify(queue))
      scheduleOtaAutoConfirm()
      return res
    }
  }

  scheduleLaunchOtaCheck()
  return instance
}

export const isTerminal = (): boolean => false

export type {
  AppStateEvent,
  BatteryInfo,
  CompressedImageResult,
  DeviceInfo,
  FsEntry,
  FsScope,
  FsStorageInfo,
  GpuixBatchMutation,
  GpuixNativeBinding,
  GpuixNativeSdk,
  GpuixRendererEvent,
  GpuixRendererEventCallback,
  GpuixRendererInstance,
  LocationResult,
  MediaPickResult,
  NetworkChangeEvent,
  OtaManifest,
  OtaProgressEvent,
  OtaState,
  SensorReading,
  TransferProgressEvent,
  Unsubscribe,
  ViewportInsets,
  ViewportMetrics,
  ViewportSize,
} from './types'
