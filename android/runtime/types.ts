export type Unsubscribe = () => void

export type ViewportSize = {
  width: number
  height: number
}

export type ViewportInsets = {
  top: number
  right: number
  bottom: number
  left: number
  imeTop?: number
  imeRight?: number
  imeBottom?: number
  imeLeft?: number
}

export type ViewportMetrics = {
  subscribeSize: (fn: (size: ViewportSize) => void) => Unsubscribe
  subscribeInsets: (fn: (insets: ViewportInsets) => void) => Unsubscribe
  __emitSize: (next: ViewportSize) => void
  __emitInsets: (next: ViewportInsets) => void
  __resetListeners?: () => void
}

export type DeviceInfo = {
  model: string
  manufacturer: string
  brand: string
  device: string
  sdkInt: number
  release: string
  abis: string[]
  packageName: string
  versionName: string
  versionCode: number
  locale: string
  isPhysicalDevice: boolean
  screenWidthPx: number
  screenHeightPx: number
  density: number
  networkType: string
  isMetered: boolean
}

export type BatteryInfo = {
  level: number
  charging: boolean
  temperatureC: number
  voltageMv: number
}

export type SensorReading = {
  type: string
  values: number[]
  accuracy?: number
  timestamp: number
}

export type MediaPickResult = {
  cancelled: boolean
  uri?: string
  path?: string
  name?: string
  mimeType?: string
  width?: number
  height?: number
  size?: number
}

export type LocationResult = {
  latitude: number
  longitude: number
  accuracy: number
  altitude: number
  provider: string
  timestamp: number
}

export type OtaState = {
  source: 'embedded' | 'ota'
  appId: string
  versionName: string
  versionCode: number
  runtimeVersion: string
  channel: string
  manifestUrl: string | null
  hasPublicKey: boolean
  checkOnLaunch: 'manual' | 'background' | 'immediate'
  embeddedFormat: 'hbc' | 'js'
  embeddedBuildId: string
  currentReleaseId: string | null
  currentFormat: 'hbc' | 'js'
  stagedReleaseId: string | null
  previousReleaseId: string | null
  confirmed: boolean
  launchAttempts: number
  failedReleaseIds: string[]
  lastRollbackReason: string | null
  lastCheckedAt: number
}

export type OtaManifest = {
  schemaVersion: number
  appId: string
  channel?: string
  runtimeVersion: string
  releaseId: string
  minVersionCode?: number
  mandatory?: boolean
  notes?: string
  publishedAt?: string
  bundle: {
    format: 'hbc' | 'js'
    url: string
    sha256: string
    size: number
    signature?: string
  }
}

export type OtaProgressEvent = {
  releaseId: string
  bytesReceived: number
  totalBytes: number
  progress: number
  phase: 'downloading' | 'verifying' | 'ready'
}

export type GpuixNativeSdk = {
  invoke: <T = unknown>(
    module: string,
    method: string,
    args?: Record<string, unknown>,
    timeoutMs?: number,
  ) => Promise<T>
  onEvent: (channel: string, fn: (payload: unknown) => void) => Unsubscribe
  onBackPressed: (handler: () => boolean | void) => Unsubscribe
  onDeepLink: (handler: (url: string) => void) => Unsubscribe
  notifications: {
    areEnabled: () => Promise<{ enabled: boolean; permissionGranted: boolean }>
    show: (opts: {
      id?: number
      title: string
      body: string
      deepLink?: string
      ongoing?: boolean
      sound?: boolean
    }) => Promise<{ id: number; shown: boolean }>
    schedule: (opts: {
      id?: number
      delayMs?: number
      title: string
      body: string
      deepLink?: string
    }) => Promise<{ id: number; delayMs: number }>
    showProgress: (opts: {
      id?: number
      title: string
      body: string
      progress: number
      max?: number
      indeterminate?: boolean
    }) => Promise<{ id: number; progress: number }>
    cancel: (id: number) => Promise<{ cancelled: boolean }>
    cancelAll: () => Promise<{ cancelledAll: boolean }>
  }
  audio: {
    playTone: (type?: string) => Promise<{ played: string }>
    getVolume: (stream?: string) => Promise<{ volume: number; current: number; max: number }>
    setVolume: (
      volume: number,
      stream?: string,
    ) => Promise<{ volume: number; current: number; max: number }>
    speak: (
      text: string,
      opts?: { rate?: number; pitch?: number },
    ) => Promise<{ speaking: boolean; text: string }>
    stopSpeak: () => Promise<{ stopped: boolean }>
  }
  haptics: {
    impact: (style?: string) => Promise<{ style: string }>
    vibrate: (opts?: { durationMs?: number; pattern?: number[] }) => Promise<{ vibrated: boolean }>
  }
  biometrics: {
    canAuthenticate: () => Promise<{ available: boolean; status: string }>
    authenticate: (opts?: {
      title?: string
      subtitle?: string
      description?: string
      cancelText?: string
    }) => Promise<{ authenticated: boolean; reason?: string; errorCode?: number }>
  }
  torch: {
    isAvailable: () => Promise<{ available: boolean; enabled: boolean }>
    setEnabled: (enabled: boolean) => Promise<{ enabled: boolean }>
  }
  sensors: {
    sample: (type?: string) => Promise<SensorReading>
    start: (type?: string, intervalMs?: number) => Promise<{ started: string }>
    stop: (type?: string) => Promise<{ stopped: string }>
    onData: (fn: (reading: SensorReading) => void) => Unsubscribe
  }
  device: {
    getInfo: () => Promise<DeviceInfo>
    getBattery: () => Promise<BatteryInfo>
  }
  system: {
    toast: (message: string, isLong?: boolean) => Promise<{ shown: boolean }>
    alert: (opts: {
      title?: string
      message: string
      confirmText?: string
      cancelText?: string
    }) => Promise<{ confirmed: boolean }>
    setKeepScreenOn: (enabled: boolean) => Promise<{ keepScreenOn: boolean }>
    setBrightness: (value: number) => Promise<{ brightness: number }>
    setStatusBar: (opts: {
      style?: string
      color?: string
      hidden?: boolean
    }) => Promise<{ ok: boolean }>
    openAppSettings: () => Promise<{ opened: boolean }>
    moveToBack: () => Promise<{ ok: boolean }>
  }
  clipboard: {
    read: () => Promise<{ text: string | null }>
    write: (text: string) => Promise<{ written: boolean }>
  }
  launcher: {
    openUrl: (url: string) => Promise<{ opened: boolean }>
    canOpenUrl: (url: string) => Promise<{ canOpen: boolean }>
    getInitialUrl: () => Promise<{ url: string | null }>
    share: (opts: { title?: string; text: string; url?: string }) => Promise<{ shared: boolean }>
  }
  permissions: {
    check: (permission: string) => Promise<{ granted: boolean }>
    request: (
      permissions: string | string[],
    ) => Promise<{ granted: boolean; results: Record<string, string> }>
  }
  storage: {
    get: (key: string) => Promise<{ value: string | null }>
    set: (key: string, value: string) => Promise<{ ok: boolean }>
    remove: (key: string) => Promise<{ ok: boolean }>
    clear: () => Promise<{ ok: boolean }>
    keys: () => Promise<{ keys: string[] }>
  }
  secureStorage: {
    write: (service: string, account: string, value: string) => Promise<{ ok: boolean }>
    read: (service: string, account: string) => Promise<{ value: string | null }>
    delete: (service: string, account: string) => Promise<{ ok: boolean }>
  }
  media: {
    pickImage: () => Promise<MediaPickResult>
    pickFile: (mimeType?: string) => Promise<MediaPickResult>
    takePhoto: () => Promise<MediaPickResult>
  }
  location: {
    getCurrentPosition: () => Promise<LocationResult>
  }
  ota: {
    getState: () => Promise<OtaState>
    check: (opts?: {
      manifestUrl?: string
      channel?: string
      timeoutMs?: number
      headers?: Record<string, string>
    }) => Promise<{
      available: boolean
      reason: string | null
      currentReleaseId: string | null
      stagedReleaseId: string | null
      embeddedBuildId: string
      manifest: OtaManifest
    }>
    download: (opts?: {
      manifest?: OtaManifest
      manifestUrl?: string
      timeoutMs?: number
      headers?: Record<string, string>
    }) => Promise<OtaState & { downloaded: boolean; reused: boolean; releaseId: string; bytes?: number }>
    apply: (opts?: {
      mode?: 'hot' | 'next_launch' | 'restart'
    }) => Promise<OtaState & { applied: boolean; mode: string; releaseId: string }>
    confirm: () => Promise<OtaState & { confirmedNow: boolean }>
    rollback: (opts?: {
      applyNow?: boolean
      mode?: 'hot' | 'restart'
      reason?: string
    }) => Promise<OtaState & { rolledBackFrom: string | null }>
    reset: (opts?: { applyNow?: boolean }) => Promise<OtaState & { reset: boolean }>
    setManualConfirm: (enabled: boolean) => void
    onProgress: (fn: (ev: OtaProgressEvent) => void) => Unsubscribe
  }
}

export type GpuixNativeBinding = {
  GpuixRenderer: new (callback?: GpuixRendererEventCallback) => GpuixRendererInstance
  nativeFetch?: (requestJson: string) => Promise<string> | string
  nativeInvoke?: (requestId: number, module: string, method: string, argsJson: string) => boolean
  moveAppToBack?: () => void
  kvGet?: (key: string) => string | null | undefined
  kvSet?: (key: string, value: string) => boolean | void
  kvRemove?: (key: string) => boolean | void
  kvClear?: () => boolean | void
  kvKeys?: () => string[]
  wsConnect?: (socketId: number, url: string, headersJson: string) => boolean
  wsSend?: (socketId: number, text: string | null, binaryBase64: string | null) => boolean
  wsClose?: (socketId: number, code: number, reason: string) => void
}

export type GpuixRendererEvent = {
  elementId?: number
  eventType?: string
  width?: number
  height?: number
  value?: string
  [key: string]: unknown
}

export type GpuixRendererEventCallback = (error: unknown, event: GpuixRendererEvent) => void

export type GpuixBatchMutation = [string, ...unknown[]]

export type GpuixRendererInstance = {
  applyBatch: (batchJson: string) => unknown
  applyBinaryBatch?: (binary: Uint8Array) => unknown
  __applyBatchQueue?: (queue: GpuixBatchMutation[]) => unknown
  [key: string]: unknown
}
