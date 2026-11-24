import { afterEach, describe, expect, test } from 'bun:test'
import {
  base64ToBytes,
  bytesToBase64,
  gpxAtob,
  gpxBtoa,
  GpxTextDecoder,
  GpxTextEncoder,
  utf8Decode,
  utf8Encode,
} from '../android/runtime/utf8'
import { GpxURL, GpxURLSearchParams } from '../android/runtime/url'
import {
  GpxAbortController,
  GpxAbortSignal,
  gpxFetch,
  GpxHeaders,
  GpxResponse,
  installWebApis,
} from '../android/runtime/web-apis'
import { createStyleCache, encodeBatch, GPX1_OPCODES } from '../android/runtime/gpx1'
import {
  createGpuixNativeSdk,
  handleBackPressedEvent,
  handleBridgeChannelEvent,
  handleBridgeResultEvent,
  handleDeepLinkEvent,
} from '../android/runtime/native-bridge'
import { GpxWebSocket, handleWsEvent } from '../android/runtime/websocket'
import { ensureViewportMetrics } from '../android/runtime/viewport'
import { getBridgeState, installHotLifecycleHooks } from '../android/runtime/bridge-state'
import { GpuixRenderer } from '../android/runtime/index'
import type { GpuixBatchMutation, ViewportInsets, ViewportSize } from '../android/runtime/types'

const g = globalThis as Record<string, unknown>
const originalNative = g.__gpuixNative
const originalLocalStorage = g.localStorage

afterEach(() => {
  const state = g.__gpuixBridgeState as { otaAutoConfirmTimer?: ReturnType<typeof setTimeout> | null } | undefined
  if (state?.otaAutoConfirmTimer) {
    clearTimeout(state.otaAutoConfirmTimer)
  }
  g.__gpuixNative = originalNative
  g.localStorage = originalLocalStorage
  delete g.__gpuixBridgeState
  delete g.__gpuixRenderHost
  delete g.__gpuixViewport
  delete g.__gpuixHotCleanup
  delete g.__gpuixHotCleanups
  delete g.__gpuixRegisterHotCleanup
  delete g.__gpuixRunHotCleanup
  delete g.gpuix
})

describe('android/runtime utf8 & base64', () => {
  test('encodes and decodes ASCII, CJK, emoji surrogate pairs, and invalid surrogates', () => {
    const sample = 'GPUIX 安卓 🚀 café'
    const encoded = utf8Encode(sample)
    expect(utf8Decode(encoded)).toBe(sample)

    const enc = new GpxTextEncoder()
    const dec = new GpxTextDecoder('UTF-8')
    const dest = new Uint8Array(64)
    const into = enc.encodeInto('你好𝄞', dest)
    expect(into.written).toBe(10)
    expect(dec.decode(dest.subarray(0, into.written))).toBe('你好𝄞')

    // Lone high surrogate falls back to U+FFFD (EF BF BD)
    const loneHigh = utf8Encode('\uD800A')
    expect(Array.from(loneHigh)).toEqual([0xef, 0xbf, 0xbd, 0x41])
    expect(utf8Decode(loneHigh)).toBe('\ufffdA')
  })

  test('roundtrips base64 and btoa/atob', () => {
    const bytes = new Uint8Array([0, 1, 2, 127, 128, 255])
    const b64 = bytesToBase64(bytes)
    expect(b64).toBe('AAECf4D/')
    expect(Array.from(base64ToBytes(b64))).toEqual(Array.from(bytes))

    expect(gpxBtoa('Hello\xff')).toBe('SGVsbG//')
    expect(gpxAtob('SGVsbG//')).toBe('Hello\xff')
    expect(() => gpxBtoa('中文')).toThrow()
    expect(() => base64ToBytes('@@@!')).toThrow()
  })
})

describe('android/runtime URL & URLSearchParams', () => {
  test('parses and mutates query parameters', () => {
    const params = new GpxURLSearchParams('?a=1&b=hello+world&a=2')
    expect(params.get('a')).toBe('1')
    expect(params.getAll('a')).toEqual(['1', '2'])
    expect(params.get('b')).toBe('hello world')
    expect(params.has('a')).toBe(true)

    params.set('a', '99')
    expect(params.getAll('a')).toEqual(['99'])
    params.append('c', 'x y')
    params.delete('b')
    expect(params.toString()).toBe('a=99&c=x+y')
  })

  test('parses full and relative URLs and validates bad input', () => {
    const base = new GpxURL('https://user:pass@example.com:8443/v1/items?page=1#top')
    expect(base.protocol).toBe('https:')
    expect(base.username).toBe('user')
    expect(base.password).toBe('pass')
    expect(base.host).toBe('example.com:8443')
    expect(base.hostname).toBe('example.com')
    expect(base.port).toBe('8443')
    expect(base.pathname).toBe('/v1/items')
    expect(base.searchParams.get('page')).toBe('1')
    expect(base.hash).toBe('#top')
    expect(base.origin).toBe('https://example.com:8443')

    const rel = new GpxURL('detail?id=7', base)
    expect(rel.href).toBe('https://example.com:8443/v1/detail?id=7')
    expect(() => new GpxURL('not a url')).toThrow(TypeError)
  })
})

describe('android/runtime GPX1 binary protocol encoder', () => {
  test('encodes all 11 opcodes with exact little-endian layout and style interning cache', () => {
    const cache = createStyleCache()
    const styleA = { width: 100, color: '#fff' }
    const styleB = { width: 100, color: '#fff' } // equal JSON, different object reference
    const queue: GpuixBatchMutation[] = [
      ['createElement', 1, 'div'],
      ['setStyle', 1, styleA],
      ['setStyle', 1, styleA], // WeakMap cache hit: no new internStyle
      ['setStyle', 1, styleB], // JSON Map cache hit: no new internStyle
      ['setText', 1, '你好'],
      ['appendChild', 2, 1],
      ['insertBefore', 2, 3, 1],
      ['setEventListener', 1, 'click', true],
      ['setRoot', 2],
      ['setKeyboardFocusDim', true],
      ['setCustomProp', 1, 'checked', true],
      ['destroyElement', 3],
    ]

    const bytes = encodeBatch(queue, cache)
    expect(bytes).not.toBeNull()
    const buf = bytes!
    const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)

    // Header: magic 'GPX1' + emitted op count
    // Queue had 12 mutations, first setStyle adds 1 internStyle -> 13 encoded records
    expect(String.fromCharCode(buf[0], buf[1], buf[2], buf[3])).toBe('GPX1')
    expect(view.getUint32(4, true)).toBe(13)

    let pos = 8
    const readU8 = () => buf[pos++]
    const readU16 = () => {
      const v = view.getUint16(pos, true)
      pos += 2
      return v
    }
    const readU32 = () => {
      const v = view.getUint32(pos, true)
      pos += 4
      return v
    }
    const readU64 = () => {
      const lo = readU32()
      const hi = readU32()
      return hi * 0x100000000 + lo
    }
    const readStrU16 = () => {
      const n = readU16()
      const s = utf8Decode(buf.subarray(pos, pos + n))
      pos += n
      return s
    }
    const readStrU32 = () => {
      const n = readU32()
      const s = utf8Decode(buf.subarray(pos, pos + n))
      pos += n
      return s
    }

    // 1. createElement
    expect(readU8()).toBe(GPX1_OPCODES.createElement)
    expect(readU64()).toBe(1)
    expect(readStrU16()).toBe('div')

    // 2. internStyle (first setStyle)
    expect(readU8()).toBe(GPX1_OPCODES.internStyle)
    const sid = readU32()
    expect(sid).toBe(1)
    expect(readStrU32()).toBe(JSON.stringify(styleA))

    // 3. setStyleById (first setStyle)
    expect(readU8()).toBe(GPX1_OPCODES.setStyleById)
    expect(readU64()).toBe(1)
    expect(readU32()).toBe(1)

    // 4. setStyleById (WeakMap hit)
    expect(readU8()).toBe(GPX1_OPCODES.setStyleById)
    expect(readU64()).toBe(1)
    expect(readU32()).toBe(1)

    // 5. setStyleById (JSON Map hit)
    expect(readU8()).toBe(GPX1_OPCODES.setStyleById)
    expect(readU64()).toBe(1)
    expect(readU32()).toBe(1)

    // 6. setText ('你好' = 6 UTF-8 bytes)
    expect(readU8()).toBe(GPX1_OPCODES.setText)
    expect(readU64()).toBe(1)
    expect(view.getUint32(pos, true)).toBe(6)
    expect(readStrU32()).toBe('你好')

    // 7. appendChild
    expect(readU8()).toBe(GPX1_OPCODES.appendChild)
    expect(readU64()).toBe(2)
    expect(readU64()).toBe(1)

    // 8. insertBefore
    expect(readU8()).toBe(GPX1_OPCODES.insertBefore)
    expect(readU64()).toBe(2)
    expect(readU64()).toBe(3)
    expect(readU64()).toBe(1)

    // 9. setEventListener
    expect(readU8()).toBe(GPX1_OPCODES.setEventListener)
    expect(readU64()).toBe(1)
    expect(readStrU16()).toBe('click')
    expect(readU8()).toBe(1)

    // 10. setRoot
    expect(readU8()).toBe(GPX1_OPCODES.setRoot)
    expect(readU64()).toBe(2)

    // 11. setKeyboardFocusDim
    expect(readU8()).toBe(GPX1_OPCODES.setKeyboardFocusDim)
    expect(readU8()).toBe(1)

    // 12. setCustomProp
    expect(readU8()).toBe(GPX1_OPCODES.setCustomProp)
    expect(readU64()).toBe(1)
    expect(readStrU16()).toBe('checked')
    expect(readStrU32()).toBe('true')

    // 13. destroyElement
    expect(readU8()).toBe(GPX1_OPCODES.destroyElement)
    expect(readU64()).toBe(3)

    expect(pos).toBe(buf.length)
  })

  test('returns null for unsupported opcodes', () => {
    const cache = createStyleCache()
    expect(encodeBatch([['unknownOp', 1]], cache)).toBeNull()
  })
})

describe('android/runtime web-apis & fetch & storage', () => {
  test('AbortController, Headers, and Response behave consistently', async () => {
    const ctrl = new GpxAbortController()
    let reasonSeen: unknown = null
    ctrl.signal.addEventListener('abort', (ev) => {
      reasonSeen = ev.target.reason
    })
    ctrl.abort('cancelled')
    expect(ctrl.signal.aborted).toBe(true)
    expect(reasonSeen).toBe('cancelled')
    expect(() => ctrl.signal.throwIfAborted()).toThrow('cancelled')
    expect(GpxAbortSignal.abort('preset').aborted).toBe(true)

    const headers = new GpxHeaders({ 'X-Test': 'one' })
    headers.append('x-test', 'two')
    expect(headers.get('X-TEST')).toBe('one, two')

    const res = new GpxResponse(utf8Encode(JSON.stringify({ ok: true })), {
      status: 201,
      headers,
      url: 'https://api.example/v1',
    })
    expect(res.ok).toBe(true)
    const cloned = res.clone()
    expect(await res.json<{ ok: boolean }>()).toEqual({ ok: true })
    expect(await cloned.text()).toBe('{"ok":true}')
  })

  test('gpxFetch delegates to nativeFetch and decodes base64 body', async () => {
    const receivedReqs: string[] = []
    g.__gpuixNative = {
      nativeFetch(reqJson: string) {
        receivedReqs.push(reqJson)
        return Promise.resolve(
          JSON.stringify({
            status: 200,
            ok: true,
            url: 'https://gpuix.dev/ping',
            bodyBase64: bytesToBase64(utf8Encode('pong')),
          }),
        )
      },
    }

    const res = await gpxFetch('https://gpuix.dev/ping', {
      method: 'POST',
      body: JSON.stringify({ hello: 'world' }),
    })
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('pong')
    expect(receivedReqs.length).toBe(1)

    const aborted = GpxAbortSignal.abort('stop')
    await expect(gpxFetch('https://gpuix.dev/ping', { signal: aborted })).rejects.toThrow('Aborted')
  })

  test('installWebApis provides localStorage native KV proxy', () => {
    const store = new Map<string, string>()
    g.__gpuixNative = {
      kvGet: (k: string) => (store.has(k) ? store.get(k)! : null),
      kvSet: (k: string, v: string) => {
        store.set(k, v)
        return true
      },
      kvRemove: (k: string) => store.delete(k),
      kvClear: () => {
        store.clear()
        return true
      },
      kvKeys: () => Array.from(store.keys()),
    }
    delete g.localStorage
    installWebApis()

    const ls = g.localStorage as Storage
    ls.setItem('theme', 'dark')
    expect(ls.getItem('theme')).toBe('dark')
    expect(ls.length).toBe(1)
    expect(ls.key(0)).toBe('theme')
    ls.removeItem('theme')
    expect(ls.getItem('theme')).toBeNull()
  })
})

describe('android/runtime native-bridge, websocket, viewport & renderer', () => {
  test('native SDK resolves/rejects requests and manages events, back handlers, and deep links', async () => {
    const calls: Array<{ id: number; module: string; method: string; args: string }> = []
    let backMoved = 0
    g.__gpuixNative = {
      nativeInvoke(id: number, module: string, method: string, argsJson: string) {
        calls.push({ id, module, method, args: argsJson })
        queueMicrotask(() => {
          if (method === 'failMe') {
            handleBridgeResultEvent(
              JSON.stringify({ requestId: id, ok: false, payloadJson: JSON.stringify({ error: 'boom' }) }),
            )
          } else {
            handleBridgeResultEvent(
              JSON.stringify({ requestId: id, ok: true, payloadJson: JSON.stringify({ echo: method }) }),
            )
          }
        })
        return true
      },
      moveAppToBack() {
        backMoved += 1
      },
    }

    const sdk = createGpuixNativeSdk()
    const okRes = await sdk.device.getInfo()
    expect((okRes as unknown as { echo: string }).echo).toBe('getInfo')
    await expect(sdk.invoke('device', 'failMe')).rejects.toThrow('boom')

    const seenEvents: unknown[] = []
    const unsubEvent = sdk.onEvent('sensor', (p) => seenEvents.push(p))
    handleBridgeChannelEvent(JSON.stringify({ channel: 'sensor', payloadJson: JSON.stringify({ x: 1 }) }))
    unsubEvent()
    handleBridgeChannelEvent(JSON.stringify({ channel: 'sensor', payloadJson: JSON.stringify({ x: 2 }) }))
    expect(seenEvents).toEqual([{ x: 1 }])

    const unsubIntercept = sdk.onBackPressed(() => true)
    handleBackPressedEvent()
    expect(backMoved).toBe(0)
    unsubIntercept()
    handleBackPressedEvent()
    expect(backMoved).toBe(1)

    handleDeepLinkEvent('gpuix://open/tab2')
    const links: string[] = []
    const unsubLink = sdk.onDeepLink((u) => links.push(u))
    expect(links).toEqual(['gpuix://open/tab2'])
    unsubLink()
  })

  test('GpxWebSocket handles open, text/binary messages, send, and close', () => {
    const sent: Array<{ text: string | null; b64: string | null }> = []
    let lastId = 0
    g.__gpuixNative = {
      wsConnect(id: number) {
        lastId = id
        return true
      },
      wsSend(_id: number, text: string | null, b64: string | null) {
        sent.push({ text, b64 })
      },
      wsClose() {},
    }

    const ws = new GpxWebSocket('wss://echo.gpuix.dev')
    const messages: unknown[] = []
    let closedCode = 0
    ws.onmessage = (ev) => messages.push(ev.data)
    ws.onclose = (ev) => {
      closedCode = Number(ev.code)
    }

    handleWsEvent(JSON.stringify({ socketId: lastId, type: 'open' }))
    expect(ws.readyState).toBe(GpxWebSocket.OPEN)

    ws.send('ping')
    ws.send(new Uint8Array([1, 2, 3]))
    expect(sent).toEqual([
      { text: 'ping', b64: null },
      { text: null, b64: 'AQID' },
    ])

    handleWsEvent(JSON.stringify({ socketId: lastId, type: 'message', text: 'pong' }))
    handleWsEvent(JSON.stringify({ socketId: lastId, type: 'message', binaryBase64: 'AQID' }))
    expect(messages[0]).toBe('pong')
    expect(Array.from(new Uint8Array(messages[1] as ArrayBuffer))).toEqual([1, 2, 3])

    handleWsEvent(JSON.stringify({ socketId: lastId, type: 'close', code: 1000, reason: 'bye' }))
    expect(ws.readyState).toBe(GpxWebSocket.CLOSED)
    expect(closedCode).toBe(1000)
  })

  test('GpuixRenderer routes windowResize/insets and encodes batches to applyBinaryBatch', () => {
    const binaryBatches: Uint8Array[] = []
    let savedCb: ((err: Error | null, ev?: Record<string, unknown>) => void) | undefined

    class MockNativeRenderer {
      constructor(cb?: (err: Error | null, ev?: Record<string, unknown>) => void) {
        savedCb = cb
      }
      applyBatch() {}
      applyBinaryBatch(bin: Uint8Array) {
        binaryBatches.push(bin)
      }
    }

    g.__gpuixNative = { GpuixRenderer: MockNativeRenderer }
    const userEvents: unknown[] = []
    const renderer = GpuixRenderer((_err, ev) => userEvents.push(ev))

    const viewport = ensureViewportMetrics()
    const sizes: ViewportSize[] = []
    const insets: ViewportInsets[] = []
    const unsubSize = viewport.subscribeSize((s) => sizes.push(s))
    const unsubInsets = viewport.subscribeInsets((i) => insets.push(i))

    savedCb?.(null, { elementId: 0, eventType: 'windowResize', width: 412, height: 915 })
    savedCb?.(null, { elementId: 0, eventType: 'windowInsets', value: JSON.stringify({ top: 36, right: 0, bottom: 24, left: 0 }) })
    savedCb?.(null, { elementId: 42, eventType: 'click' })

    expect(sizes[sizes.length - 1]).toEqual({ width: 412, height: 915 })
    expect(insets[insets.length - 1]).toEqual({ top: 36, right: 0, bottom: 24, left: 0 })
    expect(userEvents).toEqual([{ elementId: 42, eventType: 'click' }])

    unsubSize()
    unsubInsets()

    renderer.__applyBatchQueue?.([['createElement', 1, 'div'], ['setRoot', 1]])
    expect(binaryBatches.length).toBe(1)
    expect(binaryBatches[0].length).toBeGreaterThan(8)
    const decoded = binaryBatches[0]
    expect(String.fromCharCode(decoded[0], decoded[1], decoded[2], decoded[3])).toBe('GPX1')
  })

  test('ota bridge forwards all OTA commands, tracks manual confirm, and subscribes to progress events', async () => {
    const calls: Array<{ id: number; module: string; method: string; args: string }> = []
    g.__gpuixNative = {
      nativeInvoke(id: number, module: string, method: string, argsJson: string) {
        calls.push({ id, module, method, args: argsJson })
        queueMicrotask(() => {
          handleBridgeResultEvent(
            JSON.stringify({
              requestId: id,
              ok: true,
              payloadJson: JSON.stringify({ ok: true, module, method }),
            }),
          )
        })
        return true
      },
    }

    const sdk = createGpuixNativeSdk()
    await sdk.ota.getState()
    await sdk.ota.check({ manifestUrl: 'https://ota.example/manifest.json', channel: 'prod' })
    await sdk.ota.download({ manifestUrl: 'https://ota.example/manifest.json', timeoutMs: 45000 })
    await sdk.ota.apply({ mode: 'hot' })
    await sdk.ota.confirm()
    await sdk.ota.rollback({ applyNow: true, mode: 'hot', reason: 'smoke_check' })
    await sdk.ota.reset({ applyNow: false })

    expect(calls.map((c) => [c.module, c.method, JSON.parse(c.args)])).toEqual([
      ['ota', 'getState', {}],
      ['ota', 'check', { manifestUrl: 'https://ota.example/manifest.json', channel: 'prod' }],
      ['ota', 'download', { manifestUrl: 'https://ota.example/manifest.json', timeoutMs: 45000 }],
      ['ota', 'apply', { mode: 'hot' }],
      ['ota', 'confirm', {}],
      ['ota', 'rollback', { applyNow: true, mode: 'hot', reason: 'smoke_check' }],
      ['ota', 'reset', { applyNow: false }],
    ])

    expect(getBridgeState().otaManualConfirm).toBe(false)
    sdk.ota.setManualConfirm(true)
    expect(getBridgeState().otaManualConfirm).toBe(true)
    sdk.ota.setManualConfirm(false)
    expect(getBridgeState().otaManualConfirm).toBe(false)

    const progressEvents: unknown[] = []
    const unsubProgress = sdk.ota.onProgress((ev) => progressEvents.push(ev))
    handleBridgeChannelEvent(
      JSON.stringify({
        channel: 'otaProgress',
        payloadJson: JSON.stringify({ phase: 'downloading', receivedBytes: 512, totalBytes: 1024 }),
      }),
    )
    unsubProgress()
    handleBridgeChannelEvent(
      JSON.stringify({
        channel: 'otaProgress',
        payloadJson: JSON.stringify({ phase: 'done', receivedBytes: 1024, totalBytes: 1024 }),
      }),
    )
    expect(progressEvents).toEqual([{ phase: 'downloading', receivedBytes: 512, totalBytes: 1024 }])
  })

  test('__gpuixHotCleanup unmounts host, runs LIFO cleanups, closes websockets, and resets listeners while keeping viewport snapshot', () => {
    const closedSockets: Array<[number, number, string]> = []
    g.__gpuixNative = {
      wsConnect: () => true,
      wsClose: (socketId: number, code: number, reason: string) => {
        closedSockets.push([socketId, code, reason])
        return true
      },
    }

    installHotLifecycleHooks()
    const sdk = createGpuixNativeSdk()
    const viewport = ensureViewportMetrics()

    let unmounted = 0
    g.__gpuixRenderHost = {
      root: {
        unmount() {
          unmounted += 1
        },
      },
    }

    const order: string[] = []
    const registerCleanup = g.__gpuixRegisterHotCleanup as (fn: () => void) => void
    registerCleanup(() => order.push('first'))
    registerCleanup(() => {
      order.push('throws')
      throw new Error('cleanup failure should be isolated')
    })
    registerCleanup(() => order.push('second'))

    sdk.onBackPressed(() => true)
    sdk.onEvent('custom', () => {})
    sdk.onDeepLink(() => {})
    const ws = new GpxWebSocket('wss://ota.example/hmr')

    const sizeEvents: ViewportSize[] = []
    const insetsEvents: ViewportInsets[] = []
    viewport.__emitSize({ width: 412, height: 915 })
    viewport.__emitInsets({ top: 24, right: 0, bottom: 16, left: 0 })
    viewport.subscribeSize((s) => sizeEvents.push(s))
    viewport.subscribeInsets((i) => insetsEvents.push(i))
    expect(sizeEvents.length).toBe(1)
    expect(insetsEvents.length).toBe(1)

    const origError = console.error
    console.error = () => {}
    try {
      const hotCleanup = g.__gpuixHotCleanup as () => void
      hotCleanup()
    } finally {
      console.error = origError
    }

    const state = getBridgeState()
    expect(unmounted).toBe(1)
    expect((g.__gpuixRenderHost as { root: unknown }).root).toBeNull()
    expect(order).toEqual(['second', 'throws', 'first'])
    expect(closedSockets).toEqual([[ws._id, 1000, 'hot_cleanup']])
    expect(ws.readyState).toBe(3)
    expect(state.wsRegistry.size).toBe(0)
    expect(state.backHandlers.length).toBe(0)
    expect(state.eventChannels.size).toBe(0)
    expect(state.deepLinkListeners.size).toBe(0)

    viewport.__emitSize({ width: 400, height: 800 })
    viewport.__emitInsets({ top: 0, right: 0, bottom: 0, left: 0 })
    expect(sizeEvents.length).toBe(1)
    expect(insetsEvents.length).toBe(1)

    const nextSeen: ViewportSize[] = []
    viewport.subscribeSize((s) => nextSeen.push(s))
    expect(nextSeen).toEqual([{ width: 400, height: 800 }])
  })
})
