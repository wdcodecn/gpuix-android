import { getBridgeState } from './bridge-state'
import type { GpuixNativeBinding, GpuixNativeSdk, OtaProgressEvent, SensorReading, Unsubscribe } from './types'

function getNativeBinding(): GpuixNativeBinding {
  return ((globalThis as { __gpuixNative?: GpuixNativeBinding }).__gpuixNative ?? {}) as GpuixNativeBinding
}

export function emitBridgeChannel(channel: string, payload: unknown): void {
  const set = getBridgeState().eventChannels.get(channel)
  if (!set) return
  set.forEach((fn) => {
    try {
      fn(payload)
    } catch {
      // Ignore listener errors
    }
  })
}

export function invokeNative<T = unknown>(
  module: string,
  method: string,
  args?: Record<string, unknown>,
  timeoutMs?: number,
): Promise<T> {
  const native = getNativeBinding()
  if (typeof native.nativeInvoke !== 'function') {
    return Promise.reject(new Error('nativeInvoke is unavailable'))
  }
  const state = getBridgeState()
  const id = state.nextReqId++
  const ttl = typeof timeoutMs === 'number' ? timeoutMs : 30000
  const nativeInvoke = native.nativeInvoke
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      if (state.pendingBridge.delete(id)) {
        reject(new Error(`Native bridge timeout: ${module}.${method}`))
      }
    }, ttl)
    state.pendingBridge.set(id, {
      resolve: resolve as (v: unknown) => void,
      reject,
      timer,
    })
    let accepted = false
    try {
      accepted = nativeInvoke(id, String(module), String(method), JSON.stringify(args || {}))
    } catch (err) {
      clearTimeout(timer)
      state.pendingBridge.delete(id)
      reject(err instanceof Error ? err : new Error(String(err)))
      return
    }
    if (!accepted) {
      clearTimeout(timer)
      state.pendingBridge.delete(id)
      reject(new Error(`Native bridge rejected call: ${module}.${method}`))
    }
  })
}

export function handleBridgeResultEvent(rawValue: string): void {
  try {
    const br = JSON.parse(rawValue) as { requestId: number; ok: boolean; payloadJson: string }
    const state = getBridgeState()
    const entry = state.pendingBridge.get(br.requestId)
    if (!entry) return
    state.pendingBridge.delete(br.requestId)
    clearTimeout(entry.timer)
    let payload: unknown = br.payloadJson
    try {
      payload = JSON.parse(br.payloadJson)
    } catch {
      // Keep raw string payload
    }
    if (br.ok) {
      entry.resolve(payload)
    } else {
      const obj = payload && typeof payload === 'object' ? (payload as { error?: unknown }) : null
      const errMsg = obj && obj.error ? String(obj.error) : String(payload || 'Native error')
      entry.reject(new Error(errMsg))
    }
  } catch {
    // Ignore malformed event
  }
}

export function handleBridgeChannelEvent(rawValue: string): void {
  try {
    const ev = JSON.parse(rawValue) as { channel?: string; payloadJson: string }
    let evPayload: unknown = ev.payloadJson
    try {
      evPayload = JSON.parse(ev.payloadJson)
    } catch {
      // Keep raw string payload
    }
    emitBridgeChannel(String(ev.channel || ''), evPayload)
  } catch {
    // Ignore malformed event
  }
}

export function handleBackPressedEvent(): void {
  let handled = false
  const snapshot = getBridgeState().backHandlers.slice()
  for (let i = snapshot.length - 1; i >= 0; i--) {
    try {
      if (snapshot[i]() === true) {
        handled = true
        break
      }
    } catch {
      // Ignore handler errors
    }
  }
  const native = getNativeBinding()
  if (!handled && typeof native.moveAppToBack === 'function') {
    native.moveAppToBack()
  }
}

export function handleDeepLinkEvent(url: string): void {
  const state = getBridgeState()
  state.lastDeepLink = url
  state.deepLinkListeners.forEach((fn) => {
    try {
      fn(url)
    } catch {
      // Ignore listener errors
    }
  })
}

export function createGpuixNativeSdk(): GpuixNativeSdk {
  const sdk: GpuixNativeSdk = {
    invoke: (module, method, args, timeoutMs) => invokeNative(module, method, args, timeoutMs),
    onEvent: (channel, fn): Unsubscribe => {
      if (typeof fn !== 'function') return () => {}
      const key = String(channel)
      const channels = getBridgeState().eventChannels
      let set = channels.get(key)
      if (!set) {
        set = new Set()
        channels.set(key, set)
      }
      set.add(fn)
      return () => {
        set!.delete(fn)
      }
    },
    onBackPressed: (handler): Unsubscribe => {
      if (typeof handler !== 'function') return () => {}
      const backHandlers = getBridgeState().backHandlers
      backHandlers.push(handler)
      return () => {
        const idx = backHandlers.lastIndexOf(handler)
        if (idx >= 0) backHandlers.splice(idx, 1)
      }
    },
    onDeepLink: (handler): Unsubscribe => {
      if (typeof handler !== 'function') return () => {}
      const state = getBridgeState()
      state.deepLinkListeners.add(handler)
      if (state.lastDeepLink) {
        try {
          handler(state.lastDeepLink)
        } catch {
          // Ignore listener errors
        }
      }
      return () => {
        state.deepLinkListeners.delete(handler)
      }
    },
    notifications: {
      areEnabled: () => invokeNative('notifications', 'areEnabled', {}),
      show: (opts) => invokeNative('notifications', 'show', opts || {}),
      schedule: (opts) => invokeNative('notifications', 'schedule', opts || {}),
      showProgress: (opts) => invokeNative('notifications', 'showProgress', opts || {}),
      cancel: (id) => invokeNative('notifications', 'cancel', { id }),
      cancelAll: () => invokeNative('notifications', 'cancelAll', {}),
    },
    audio: {
      playTone: (type) => invokeNative('audio', 'playTone', { type: type || 'notification' }),
      getVolume: (stream) => invokeNative('audio', 'getVolume', { stream: stream || 'music' }),
      setVolume: (volume, stream) => invokeNative('audio', 'setVolume', { volume, stream: stream || 'music' }),
      speak: (text, opts) => invokeNative('audio', 'speak', Object.assign({ text: String(text || '') }, opts || {})),
      stopSpeak: () => invokeNative('audio', 'stopSpeak', {}),
    },
    haptics: {
      impact: (style) => invokeNative('haptics', 'impact', { style: style || 'medium' }),
      vibrate: (opts) => invokeNative('haptics', 'vibrate', opts || {}),
    },
    biometrics: {
      canAuthenticate: () => invokeNative('biometrics', 'canAuthenticate', {}),
      authenticate: (opts) => invokeNative('biometrics', 'authenticate', opts || {}, 120000),
    },
    torch: {
      isAvailable: () => invokeNative('torch', 'isAvailable', {}),
      setEnabled: (enabled) => invokeNative('torch', 'setEnabled', { enabled: !!enabled }),
    },
    sensors: {
      sample: (type) => invokeNative('sensors', 'sample', { type: type || 'accelerometer' }),
      start: (type, intervalMs) =>
        invokeNative('sensors', 'start', { type: type || 'accelerometer', intervalMs: intervalMs || 100 }),
      stop: (type) => invokeNative('sensors', 'stop', { type: type || 'accelerometer' }),
      onData: (fn) => sdk.onEvent('sensor', fn as (payload: unknown) => void),
    },
    device: {
      getInfo: () => invokeNative('device', 'getInfo', {}),
      getBattery: () => invokeNative('device', 'getBattery', {}),
    },
    system: {
      toast: (message, isLong) =>
        invokeNative('system', 'toast', { message: String(message || ''), long: !!isLong }),
      alert: (opts) => invokeNative('system', 'alert', opts || {}, 120000),
      setKeepScreenOn: (enabled) => invokeNative('system', 'setKeepScreenOn', { enabled: !!enabled }),
      setBrightness: (value) => invokeNative('system', 'setBrightness', { value }),
      setStatusBar: (opts) => invokeNative('system', 'setStatusBar', opts || {}),
      openAppSettings: () => invokeNative('system', 'openAppSettings', {}),
      moveToBack: () => invokeNative('system', 'moveToBack', {}),
    },
    clipboard: {
      read: () => invokeNative('clipboard', 'read', {}),
      write: (text) => invokeNative('clipboard', 'write', { text: String(text || '') }),
    },
    launcher: {
      openUrl: (url) => invokeNative('launcher', 'openUrl', { url: String(url || '') }),
      canOpenUrl: (url) => invokeNative('launcher', 'canOpenUrl', { url: String(url || '') }),
      getInitialUrl: () => invokeNative('launcher', 'getInitialUrl', {}),
      share: (opts) => invokeNative('launcher', 'share', opts || {}, 120000),
    },
    permissions: {
      check: (permission) => invokeNative('permissions', 'check', { permission: String(permission || '') }),
      request: (permissions) => {
        const list = Array.isArray(permissions) ? permissions : [permissions]
        return invokeNative('permissions', 'request', { permissions: list }, 120000)
      },
    },
    storage: {
      get: (key) => invokeNative('storage', 'get', { key: String(key || '') }),
      set: (key, value) => invokeNative('storage', 'set', { key: String(key || ''), value: String(value || '') }),
      remove: (key) => invokeNative('storage', 'remove', { key: String(key || '') }),
      clear: () => invokeNative('storage', 'clear', {}),
      keys: () => invokeNative('storage', 'keys', {}),
    },
    secureStorage: {
      write: (service, account, value) =>
        invokeNative('secureStorage', 'write', {
          service: service || 'gpuix',
          account: account || 'default',
          value: String(value || ''),
        }),
      read: (service, account) =>
        invokeNative('secureStorage', 'read', {
          service: service || 'gpuix',
          account: account || 'default',
        }),
      delete: (service, account) =>
        invokeNative('secureStorage', 'delete', {
          service: service || 'gpuix',
          account: account || 'default',
        }),
    },
    media: {
      pickImage: () => invokeNative('media', 'pickImage', {}, 120000),
      pickFile: (mimeType) => invokeNative('media', 'pickFile', { mimeType: mimeType || '*/*' }, 120000),
      takePhoto: () => invokeNative('media', 'takePhoto', {}, 120000),
    },
    location: {
      getCurrentPosition: () => invokeNative('location', 'getCurrentPosition', {}, 30000),
    },
    ota: {
      getState: () => invokeNative('ota', 'getState', {}),
      check: (opts) => invokeNative('ota', 'check', opts || {}),
      download: (opts) => invokeNative('ota', 'download', opts || {}, 120000),
      apply: (opts) => invokeNative('ota', 'apply', opts || {}),
      confirm: () => invokeNative('ota', 'confirm', {}),
      rollback: (opts) => invokeNative('ota', 'rollback', opts || {}),
      reset: (opts) => invokeNative('ota', 'reset', opts || {}),
      setManualConfirm: (enabled) => {
        getBridgeState().otaManualConfirm = !!enabled
      },
      onProgress: (fn) => sdk.onEvent('otaProgress', fn as (payload: unknown) => void),
    },
  }
  return sdk
}

export function installGpuixSdk(): void {
  const g = globalThis as { gpuix?: GpuixNativeSdk }
  g.gpuix = createGpuixNativeSdk()
}

export type { SensorReading, OtaProgressEvent }
