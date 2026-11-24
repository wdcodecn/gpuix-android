import type { GpuixNativeBinding } from './types'
import { base64ToBytes, bytesToBase64, toUint8Array, utf8Decode } from './utf8'
import { GpxURLSearchParams } from './url'

function getNativeBinding(): GpuixNativeBinding {
  return ((globalThis as { __gpuixNative?: GpuixNativeBinding }).__gpuixNative ?? {}) as GpuixNativeBinding
}

export class GpxAbortSignal {
  aborted = false
  reason: unknown = undefined
  onabort: ((ev: { type: string; target: GpxAbortSignal }) => void) | null = null
  _listeners = new Set<(ev: { type: string; target: GpxAbortSignal }) => void>()

  addEventListener(type: string, fn: (ev: { type: string; target: GpxAbortSignal }) => void): void {
    if (type === 'abort' && typeof fn === 'function') this._listeners.add(fn)
  }

  removeEventListener(type: string, fn: (ev: { type: string; target: GpxAbortSignal }) => void): void {
    if (type === 'abort') this._listeners.delete(fn)
  }

  throwIfAborted(): void {
    if (this.aborted) {
      const err = new Error(this.reason ? String(this.reason) : 'The operation was aborted')
      err.name = 'AbortError'
      throw err
    }
  }

  static abort(reason?: unknown): GpxAbortSignal {
    const sig = new GpxAbortSignal()
    sig.aborted = true
    sig.reason = reason
    return sig
  }
}

export class GpxAbortController {
  readonly signal = new GpxAbortSignal()

  abort(reason?: unknown): void {
    if (this.signal.aborted) return
    this.signal.aborted = true
    this.signal.reason = reason
    const ev = { type: 'abort', target: this.signal }
    if (typeof this.signal.onabort === 'function') {
      try {
        this.signal.onabort(ev)
      } catch {
        // Ignore abort handler errors
      }
    }
    this.signal._listeners.forEach((fn) => {
      try {
        fn(ev)
      } catch {
        // Ignore abort listener errors
      }
    })
  }
}

export type GpxHeadersInit =
  | GpxHeaders
  | Array<[string, string]>
  | Record<string, string>
  | undefined

export class GpxHeaders {
  private _map = new Map<string, [string, string]>()

  constructor(init?: GpxHeadersInit) {
    if (!init) return
    if (init instanceof GpxHeaders) {
      init._map.forEach((entry) => {
        this._map.set(entry[0].toLowerCase(), [entry[0], entry[1]])
      })
    } else if (Array.isArray(init)) {
      for (let i = 0; i < init.length; i++) {
        this.append(init[i][0], init[i][1])
      }
    } else if (typeof init === 'object') {
      const keys = Object.keys(init)
      for (let j = 0; j < keys.length; j++) {
        this.set(keys[j], init[keys[j]])
      }
    }
  }

  append(name: string, value: string): void {
    const k = String(name).toLowerCase()
    const existing = this._map.get(k)
    if (existing) {
      existing[1] = `${existing[1]}, ${String(value)}`
    } else {
      this._map.set(k, [String(name), String(value)])
    }
  }

  delete(name: string): void {
    this._map.delete(String(name).toLowerCase())
  }

  get(name: string): string | null {
    const entry = this._map.get(String(name).toLowerCase())
    return entry ? entry[1] : null
  }

  has(name: string): boolean {
    return this._map.has(String(name).toLowerCase())
  }

  set(name: string, value: string): void {
    this._map.set(String(name).toLowerCase(), [String(name), String(value)])
  }

  entries(): IterableIterator<[string, string]> {
    const arr: Array<[string, string]> = []
    this._map.forEach((e) => {
      arr.push([e[0].toLowerCase(), e[1]])
    })
    return arr[Symbol.iterator]()
  }

  keys(): IterableIterator<string> {
    const arr: string[] = []
    this._map.forEach((e) => {
      arr.push(e[0].toLowerCase())
    })
    return arr[Symbol.iterator]()
  }

  values(): IterableIterator<string> {
    const arr: string[] = []
    this._map.forEach((e) => {
      arr.push(e[1])
    })
    return arr[Symbol.iterator]()
  }

  [Symbol.iterator](): IterableIterator<[string, string]> {
    return this.entries()
  }

  forEach(cb: (value: string, key: string, parent: this) => void, thisArg?: unknown): void {
    this._map.forEach((e) => {
      cb.call(thisArg, e[1], e[0].toLowerCase(), this)
    })
  }
}

export type GpxResponseInit = {
  status?: number
  statusText?: string
  url?: string
  headers?: GpxHeadersInit
  redirected?: boolean
  ok?: boolean
}

export class GpxResponse {
  private _bytes: Uint8Array
  readonly status: number
  readonly statusText: string
  readonly ok: boolean
  readonly url: string
  readonly headers: GpxHeaders
  readonly redirected: boolean
  readonly type = 'basic'
  bodyUsed = false

  constructor(bodyBytes: unknown, init?: GpxResponseInit) {
    const opts = init ?? {}
    this._bytes = bodyBytes instanceof Uint8Array ? bodyBytes : toUint8Array(bodyBytes ?? '')
    this.status = typeof opts.status === 'number' ? opts.status : 200
    this.statusText = typeof opts.statusText === 'string' ? opts.statusText : ''
    this.ok = this.status >= 200 && this.status < 300
    this.url = opts.url ? String(opts.url) : ''
    this.headers = opts.headers instanceof GpxHeaders ? opts.headers : new GpxHeaders(opts.headers)
    this.redirected = !!opts.redirected
  }

  arrayBuffer(): Promise<ArrayBuffer> {
    this.bodyUsed = true
    const copy = new Uint8Array(this._bytes.length)
    copy.set(this._bytes)
    return Promise.resolve(copy.buffer)
  }

  bytes(): Promise<Uint8Array> {
    this.bodyUsed = true
    return Promise.resolve(new Uint8Array(this._bytes))
  }

  text(): Promise<string> {
    this.bodyUsed = true
    return Promise.resolve(utf8Decode(this._bytes))
  }

  json<T = unknown>(): Promise<T> {
    return this.text().then((txt) => JSON.parse(txt) as T)
  }

  clone(): GpxResponse {
    return new GpxResponse(new Uint8Array(this._bytes), {
      status: this.status,
      statusText: this.statusText,
      url: this.url,
      headers: new GpxHeaders(this.headers),
      redirected: this.redirected,
    })
  }
}

export type GpxFetchInit = {
  method?: string
  headers?: GpxHeadersInit
  body?: unknown
  signal?: GpxAbortSignal
  timeoutMs?: number
  redirect?: 'follow' | 'manual'
}

export function gpxFetch(input: string | { url?: string; method?: string; headers?: GpxHeadersInit; body?: unknown }, init?: GpxFetchInit): Promise<GpxResponse> {
  const native = getNativeBinding()
  if (typeof native.nativeFetch !== 'function') {
    return Promise.reject(new Error('nativeFetch is unavailable on this GPUIX build'))
  }
  const opts = init ?? {}
  const inputObj = typeof input === 'string' ? null : input
  const url = typeof input === 'string' ? input : inputObj?.url ? String(inputObj.url) : String(input)
  const method = (opts.method || inputObj?.method || 'GET').toUpperCase()
  const headers = new GpxHeaders(inputObj?.headers)
  if (opts.headers) {
    const extra = new GpxHeaders(opts.headers)
    extra.forEach((v, k) => {
      headers.set(k, v)
    })
  }
  const signal = opts.signal
  if (signal && signal.aborted) {
    const abortErr = new Error('Aborted')
    abortErr.name = 'AbortError'
    return Promise.reject(abortErr)
  }
  const headerPairs: Array<[string, string]> = []
  headers.forEach((v, k) => {
    headerPairs.push([k, v])
  })
  const req: Record<string, unknown> = {
    url,
    method,
    headers: headerPairs,
    timeoutMs: typeof opts.timeoutMs === 'number' ? opts.timeoutMs : 30000,
    redirect: opts.redirect === 'manual' ? 'manual' : 'follow',
  }
  const body = opts.body !== undefined ? opts.body : inputObj?.body
  if (body !== undefined && body !== null) {
    const GlobalSearchParams = (globalThis as Record<string, unknown>).URLSearchParams as
      | (new () => unknown)
      | undefined
    if (typeof body === 'string') {
      req.bodyText = body
    } else if (
      body instanceof GpxURLSearchParams ||
      (typeof GlobalSearchParams === 'function' && body instanceof GlobalSearchParams)
    ) {
      req.bodyText = (body as { toString: () => string }).toString()
      if (!headers.has('content-type')) {
        (req.headers as Array<[string, string]>).push([
          'content-type',
          'application/x-www-form-urlencoded;charset=UTF-8',
        ])
      }
    } else if (body instanceof ArrayBuffer || ArrayBuffer.isView(body)) {
      req.bodyBase64 = bytesToBase64(toUint8Array(body))
    } else {
      req.bodyText = String(body)
    }
  }

  const nativeFetch = native.nativeFetch
  return new Promise<GpxResponse>((resolve, reject) => {
    let settled = false
    const onAbort = () => {
      if (settled) return
      settled = true
      const err = new Error('The operation was aborted')
      err.name = 'AbortError'
      reject(err)
    }
    if (signal && typeof signal.addEventListener === 'function') {
      signal.addEventListener('abort', onAbort)
    }
    Promise.resolve(nativeFetch(JSON.stringify(req))).then(
      (rawJson) => {
        if (signal && typeof signal.removeEventListener === 'function') {
          signal.removeEventListener('abort', onAbort)
        }
        if (settled) return
        settled = true
        try {
          const parsed = JSON.parse(rawJson) as {
            bodyBase64?: string
            status?: number
            ok?: boolean
            headers?: GpxHeadersInit
            url?: string
          }
          const bytes = parsed.bodyBase64 ? base64ToBytes(parsed.bodyBase64) : new Uint8Array(0)
          resolve(
            new GpxResponse(bytes, {
              status: parsed.status,
              ok: parsed.ok,
              headers: parsed.headers,
              url: parsed.url || url,
            }),
          )
        } catch (e) {
          reject(e)
        }
      },
      (err) => {
        if (signal && typeof signal.removeEventListener === 'function') {
          signal.removeEventListener('abort', onAbort)
        }
        if (settled) return
        settled = true
        reject(err instanceof Error ? err : new Error(String(err)))
      },
    )
  })
}

export function installWebApis(): void {
  const g = globalThis as Record<string, unknown>
  if (typeof g.AbortSignal !== 'function') g.AbortSignal = GpxAbortSignal
  if (typeof g.AbortController !== 'function') g.AbortController = GpxAbortController
  if (typeof g.Headers !== 'function') g.Headers = GpxHeaders
  if (typeof g.Response !== 'function') g.Response = GpxResponse
  if (typeof g.fetch !== 'function') g.fetch = gpxFetch

  if (typeof g.localStorage !== 'object' || !g.localStorage) {
    const fallbackStorage = new Map<string, string>()
    g.localStorage = {
      getItem(key: string): string | null {
        const k = String(key)
        const native = getNativeBinding()
        if (typeof native.kvGet === 'function') {
          const val = native.kvGet(k)
          return val === undefined || val === null ? null : String(val)
        }
        return fallbackStorage.has(k) ? fallbackStorage.get(k)! : null
      },
      setItem(key: string, value: string): void {
        const k = String(key)
        const v = String(value)
        const native = getNativeBinding()
        if (typeof native.kvSet === 'function') {
          native.kvSet(k, v)
        } else {
          fallbackStorage.set(k, v)
        }
      },
      removeItem(key: string): void {
        const k = String(key)
        const native = getNativeBinding()
        if (typeof native.kvRemove === 'function') {
          native.kvRemove(k)
        } else {
          fallbackStorage.delete(k)
        }
      },
      clear(): void {
        const native = getNativeBinding()
        if (typeof native.kvClear === 'function') {
          native.kvClear()
        } else {
          fallbackStorage.clear()
        }
      },
      key(index: number): string | null {
        const native = getNativeBinding()
        const keys =
          typeof native.kvKeys === 'function' ? native.kvKeys() : Array.from(fallbackStorage.keys())
        return index >= 0 && index < keys.length ? keys[index] : null
      },
      get length(): number {
        const native = getNativeBinding()
        if (typeof native.kvKeys === 'function') {
          return native.kvKeys().length
        }
        return fallbackStorage.size
      },
    }
  }
}
