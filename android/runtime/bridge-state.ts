import type { GpuixNativeBinding } from './types'

export type PendingBridgeRequest = {
  resolve: (value: unknown) => void
  reject: (err: Error) => void
  timer: ReturnType<typeof setTimeout>
}

export type ManagedWebSocketLike = {
  _id: number
  readyState: number
  _closeTimer: ReturnType<typeof setTimeout> | null
}

export type GpuixBridgeState = {
  nextReqId: number
  pendingBridge: Map<number, PendingBridgeRequest>
  eventChannels: Map<string, Set<(payload: unknown) => void>>
  backHandlers: Array<() => boolean | void>
  deepLinkListeners: Set<(url: string) => void>
  lastDeepLink: string | null
  nextWsId: number
  wsRegistry: Map<number, ManagedWebSocketLike>
  hotCleanups: Array<() => void>
  otaAutoConfirmed: boolean
  otaManualConfirm: boolean
  otaLaunchChecked: boolean
  otaAutoConfirmTimer: ReturnType<typeof setTimeout> | null
}

type BridgeGlobals = {
  __gpuixBridgeState?: GpuixBridgeState
  __gpuixNative?: GpuixNativeBinding
  __gpuixRenderHost?: { root?: { unmount?: () => void } | null }
  __gpuixViewport?: { __resetListeners?: () => void }
  __gpuixHotCleanups?: Array<() => void>
  __gpuixRegisterHotCleanup?: (fn: () => void) => void
  __gpuixRunHotCleanup?: () => void
  __gpuixHotCleanup?: () => void
}

export function getBridgeState(): GpuixBridgeState {
  const g = globalThis as unknown as BridgeGlobals
  if (!g.__gpuixBridgeState) {
    g.__gpuixBridgeState = {
      nextReqId: 1,
      pendingBridge: new Map(),
      eventChannels: new Map(),
      backHandlers: [],
      deepLinkListeners: new Set(),
      lastDeepLink: null,
      nextWsId: 1,
      wsRegistry: new Map(),
      hotCleanups: [],
      otaAutoConfirmed: false,
      otaManualConfirm: false,
      otaLaunchChecked: false,
      otaAutoConfirmTimer: null,
    }
  }
  g.__gpuixHotCleanups = g.__gpuixBridgeState.hotCleanups
  return g.__gpuixBridgeState
}

export function runHotCleanups(): void {
  const state = getBridgeState()
  const list = state.hotCleanups.splice(0, state.hotCleanups.length)
  for (let i = list.length - 1; i >= 0; i -= 1) {
    try {
      list[i]()
    } catch (error) {
      console.error('[gpuix-dev] cleanup error:', error)
    }
  }
}

export function performHotCleanup(): void {
  const state = getBridgeState()
  runHotCleanups()

  const g = globalThis as unknown as BridgeGlobals
  if (g.__gpuixRenderHost?.root && typeof g.__gpuixRenderHost.root.unmount === 'function') {
    try {
      g.__gpuixRenderHost.root.unmount()
    } catch {
      // Ignore unmount errors during hot bundle replacement
    }
    g.__gpuixRenderHost.root = null
  }

  const native = g.__gpuixNative
  state.wsRegistry.forEach((ws) => {
    try {
      if (ws._closeTimer) {
        clearTimeout(ws._closeTimer)
        ws._closeTimer = null
      }
      ws.readyState = 3
      if (typeof native?.wsClose === 'function') {
        native.wsClose(ws._id, 1000, 'hot_cleanup')
      }
    } catch {
      // Ignore socket shutdown failures
    }
  })
  state.wsRegistry.clear()
  state.backHandlers.length = 0
  state.eventChannels.clear()
  state.deepLinkListeners.clear()

  if (state.otaAutoConfirmTimer) {
    clearTimeout(state.otaAutoConfirmTimer)
    state.otaAutoConfirmTimer = null
  }
  state.otaAutoConfirmed = false

  if (typeof g.__gpuixViewport?.__resetListeners === 'function') {
    g.__gpuixViewport.__resetListeners()
  }
}

export function installHotLifecycleHooks(): void {
  const state = getBridgeState()
  const g = globalThis as unknown as BridgeGlobals
  g.__gpuixRegisterHotCleanup = (fn: () => void) => {
    if (typeof fn === 'function') state.hotCleanups.push(fn)
  }
  g.__gpuixRunHotCleanup = runHotCleanups
  g.__gpuixHotCleanup = performHotCleanup
}
