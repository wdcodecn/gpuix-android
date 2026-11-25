import { getBridgeState } from './bridge-state'
import type { GpuixNativeBinding } from './types'
import { base64ToBytes, bytesToBase64, toUint8Array } from './utf8'

type WsEventType = 'open' | 'message' | 'error' | 'close'
type WsListener = (ev: Record<string, unknown>) => void

function getNativeBinding(): GpuixNativeBinding {
  return ((globalThis as { __gpuixNative?: GpuixNativeBinding }).__gpuixNative ?? {}) as GpuixNativeBinding
}

function emitWs(ws: GpxWebSocket, type: WsEventType, ev: Record<string, unknown>): void {
  const handler = ws[(`on${type}`) as 'onopen' | 'onmessage' | 'onerror' | 'onclose']
  if (typeof handler === 'function') {
    try {
      handler.call(ws, ev)
    } catch {
      // Ignore handler errors
    }
  }
  const set = ws._listeners[type]
  if (set) {
    set.forEach((fn) => {
      try {
        fn.call(ws, ev)
      } catch {
        // Ignore listener errors
      }
    })
  }
}

export class GpxWebSocket {
  static readonly CONNECTING = 0
  static readonly OPEN = 1
  static readonly CLOSING = 2
  static readonly CLOSED = 3

  readonly CONNECTING = 0
  readonly OPEN = 1
  readonly CLOSING = 2
  readonly CLOSED = 3

  readonly url: string
  readonly protocol: string
  readonly extensions = ''
  binaryType = 'arraybuffer'
  bufferedAmount = 0
  readyState = 0

  onopen: WsListener | null = null
  onmessage: WsListener | null = null
  onerror: WsListener | null = null
  onclose: WsListener | null = null

  _listeners: Record<WsEventType, Set<WsListener>> = {
    open: new Set(),
    message: new Set(),
    error: new Set(),
    close: new Set(),
  }
  _id: number
  _closeTimer: ReturnType<typeof setTimeout> | null = null

  constructor(url: string, protocols?: string | string[]) {
    this.url = String(url)
    this.protocol = Array.isArray(protocols)
      ? String(protocols[0] || '')
      : protocols
        ? String(protocols)
        : ''
    const state = getBridgeState()
    this._id = state.nextWsId++
    state.wsRegistry.set(this._id, this)
    const native = getNativeBinding()
    const ok = typeof native.wsConnect === 'function' ? native.wsConnect(this._id, this.url, '{}') : false
    if (!ok) {
      setTimeout(() => {
        if (this.readyState === 3) return
        this.readyState = 3
        getBridgeState().wsRegistry.delete(this._id)
        emitWs(this, 'error', { type: 'error', message: 'WebSocket connect failed', target: this })
        emitWs(this, 'close', {
          type: 'close',
          code: 1006,
          reason: 'Connect failed',
          wasClean: false,
          target: this,
        })
      }, 0)
    }
  }

  addEventListener(type: WsEventType, fn: WsListener): void {
    if (this._listeners[type] && typeof fn === 'function') this._listeners[type].add(fn)
  }

  removeEventListener(type: WsEventType, fn: WsListener): void {
    if (this._listeners[type]) this._listeners[type].delete(fn)
  }

  send(data: unknown): void {
    if (this.readyState !== 1) {
      throw new Error(`WebSocket is not open (readyState=${this.readyState})`)
    }
    const native = getNativeBinding()
    if (typeof native.wsSend !== 'function') return
    if (typeof data === 'string') {
      native.wsSend(this._id, data, null)
    } else if (data instanceof ArrayBuffer || ArrayBuffer.isView(data)) {
      native.wsSend(this._id, null, bytesToBase64(toUint8Array(data)))
    } else {
      native.wsSend(this._id, String(data), null)
    }
  }

  close(code?: number, reason?: string): void {
    if (this.readyState === 2 || this.readyState === 3) return
    this.readyState = 2
    const closeCode = typeof code === 'number' ? code : 1000
    const closeReason = reason !== undefined ? String(reason) : ''
    const native = getNativeBinding()
    if (typeof native.wsClose === 'function') {
      native.wsClose(this._id, closeCode, closeReason)
    }
    this._closeTimer = setTimeout(() => {
      if (this.readyState === 3) return
      this.readyState = 3
      getBridgeState().wsRegistry.delete(this._id)
      emitWs(this, 'close', {
        type: 'close',
        code: closeCode,
        reason: closeReason,
        wasClean: closeCode === 1000,
        target: this,
      })
    }, 80)
  }
}

export function handleWsEvent(rawValue: string): void {
  try {
    const wsMsg = JSON.parse(rawValue) as {
      socketId: number
      type: string
      text?: string | null
      binaryBase64?: string | null
      code?: number
      reason?: string | null
    }
    const state = getBridgeState()
    const ws = state.wsRegistry.get(wsMsg.socketId) as GpxWebSocket | undefined
    if (!ws) return
    if (wsMsg.type === 'open') {
      ws.readyState = 1
      emitWs(ws, 'open', { type: 'open', target: ws })
    } else if (wsMsg.type === 'message') {
      const msgData =
        typeof wsMsg.text === 'string'
          ? wsMsg.text
          : wsMsg.binaryBase64
            ? base64ToBytes(wsMsg.binaryBase64).buffer
            : ''
      emitWs(ws, 'message', { type: 'message', data: msgData, target: ws })
    } else if (wsMsg.type === 'error') {
      emitWs(ws, 'error', { type: 'error', message: wsMsg.reason || 'WebSocket error', target: ws })
    } else if (wsMsg.type === 'close') {
      if (ws._closeTimer) {
        clearTimeout(ws._closeTimer)
        ws._closeTimer = null
      }
      if (ws.readyState !== 3) {
        ws.readyState = 3
        state.wsRegistry.delete(wsMsg.socketId)
        const code = typeof wsMsg.code === 'number' ? wsMsg.code : 1000
        emitWs(ws, 'close', {
          type: 'close',
          code,
          reason: wsMsg.reason || '',
          wasClean: code === 1000,
          target: ws,
        })
      }
    }
  } catch {
    // Ignore malformed event
  }
}

export function installWebSocket(): void {
  const g = globalThis as Record<string, unknown>
  if (typeof g.WebSocket !== 'function') {
    g.WebSocket = GpxWebSocket
  }
}
