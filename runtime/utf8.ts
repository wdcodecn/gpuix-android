const B64_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

const B64_LOOKUP = (() => {
  const table = new Uint8Array(256)
  table.fill(255)
  for (let i = 0; i < B64_CHARS.length; i++) {
    table[B64_CHARS.charCodeAt(i)] = i
  }
  return table
})()

export function utf8Encode(str: unknown): Uint8Array {
  const s = String(str == null ? '' : str)
  const out = new Uint8Array(s.length * 3)
  let pos = 0
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    if (c < 0x80) {
      out[pos++] = c
    } else if (c < 0x800) {
      out[pos++] = 0xc0 | (c >> 6)
      out[pos++] = 0x80 | (c & 0x3f)
    } else if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
      const c2 = s.charCodeAt(i + 1)
      if (c2 >= 0xdc00 && c2 <= 0xdfff) {
        const cp = 0x10000 + ((c - 0xd800) << 10) + (c2 - 0xdc00)
        out[pos++] = 0xf0 | (cp >> 18)
        out[pos++] = 0x80 | ((cp >> 12) & 0x3f)
        out[pos++] = 0x80 | ((cp >> 6) & 0x3f)
        out[pos++] = 0x80 | (cp & 0x3f)
        i++
        continue
      }
      out[pos++] = 0xef
      out[pos++] = 0xbf
      out[pos++] = 0xbd
    } else if (c >= 0xd800 && c <= 0xdfff) {
      out[pos++] = 0xef
      out[pos++] = 0xbf
      out[pos++] = 0xbd
    } else {
      out[pos++] = 0xe0 | (c >> 12)
      out[pos++] = 0x80 | ((c >> 6) & 0x3f)
      out[pos++] = 0x80 | (c & 0x3f)
    }
  }
  return out.subarray(0, pos)
}

export function utf8Decode(input: unknown): string {
  if (input == null) return ''
  let bytes: Uint8Array
  if (input instanceof Uint8Array) {
    bytes = input
  } else if (input instanceof ArrayBuffer) {
    bytes = new Uint8Array(input)
  } else if (ArrayBuffer.isView(input)) {
    bytes = new Uint8Array(input.buffer, input.byteOffset, input.byteLength)
  } else {
    return String(input)
  }

  let out = ''
  let i = 0
  const len = bytes.length
  while (i < len) {
    const b0 = bytes[i++]
    if (b0 < 0x80) {
      out += String.fromCharCode(b0)
    } else if ((b0 & 0xe0) === 0xc0 && i < len) {
      const b1 = bytes[i++] & 0x3f
      out += String.fromCharCode(((b0 & 0x1f) << 6) | b1)
    } else if ((b0 & 0xf0) === 0xe0 && i + 1 < len) {
      const b1e = bytes[i++] & 0x3f
      const b2e = bytes[i++] & 0x3f
      out += String.fromCharCode(((b0 & 0x0f) << 12) | (b1e << 6) | b2e)
    } else if ((b0 & 0xf8) === 0xf0 && i + 2 < len) {
      const b1f = bytes[i++] & 0x3f
      const b2f = bytes[i++] & 0x3f
      const b3f = bytes[i++] & 0x3f
      let cp = ((b0 & 0x07) << 18) | (b1f << 12) | (b2f << 6) | b3f
      if (cp > 0xffff) {
        cp -= 0x10000
        out += String.fromCharCode(0xd800 + (cp >> 10), 0xdc00 + (cp & 0x3ff))
      } else {
        out += String.fromCharCode(cp)
      }
    } else {
      out += '\ufffd'
    }
  }
  return out
}

export function bytesToBase64(bytes: Uint8Array): string {
  const len = bytes.length
  let out = ''
  for (let i = 0; i < len; i += 3) {
    const a = bytes[i]
    const b = i + 1 < len ? bytes[i + 1] : 0
    const c = i + 2 < len ? bytes[i + 2] : 0
    const triple = (a << 16) | (b << 8) | c
    out += B64_CHARS.charAt((triple >> 18) & 0x3f)
    out += B64_CHARS.charAt((triple >> 12) & 0x3f)
    out += i + 1 < len ? B64_CHARS.charAt((triple >> 6) & 0x3f) : '='
    out += i + 2 < len ? B64_CHARS.charAt(triple & 0x3f) : '='
  }
  return out
}

export function base64ToBytes(b64: string): Uint8Array {
  const clean = String(b64 || '').replace(/\s+/g, '')
  if (!clean) return new Uint8Array(0)
  const len = clean.length
  let pad = 0
  if (len >= 2 && clean.charCodeAt(len - 1) === 61) pad++
  if (len >= 2 && clean.charCodeAt(len - 2) === 61) pad++
  const byteLen = Math.max(0, ((len / 4) | 0) * 3 - pad)
  const out = new Uint8Array(byteLen)
  let p = 0
  for (let i = 0; i < len; i += 4) {
    const c0 = B64_LOOKUP[clean.charCodeAt(i) & 0xff]
    const c1 = B64_LOOKUP[clean.charCodeAt(i + 1) & 0xff]
    const c2 = clean.charCodeAt(i + 2) === 61 ? 0 : B64_LOOKUP[clean.charCodeAt(i + 2) & 0xff]
    const c3 = clean.charCodeAt(i + 3) === 61 ? 0 : B64_LOOKUP[clean.charCodeAt(i + 3) & 0xff]
    if (c0 === 255 || c1 === 255 || c2 === 255 || c3 === 255) {
      throw new Error('Invalid base64 string')
    }
    const triple = (c0 << 18) | (c1 << 12) | (c2 << 6) | c3
    if (p < byteLen) out[p++] = (triple >> 16) & 0xff
    if (p < byteLen) out[p++] = (triple >> 8) & 0xff
    if (p < byteLen) out[p++] = triple & 0xff
  }
  return out
}

export function toUint8Array(data: unknown): Uint8Array {
  if (data instanceof Uint8Array) return data
  if (data instanceof ArrayBuffer) return new Uint8Array(data)
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
  return utf8Encode(String(data))
}

export class GpxTextEncoder {
  readonly encoding = 'utf-8'

  encode(input?: string): Uint8Array {
    return utf8Encode(input)
  }

  encodeInto(src: string, dest: Uint8Array): { read: number; written: number } {
    const encoded = utf8Encode(src)
    const n = Math.min(encoded.length, dest.length)
    dest.set(encoded.subarray(0, n))
    return { read: String(src || '').length, written: n }
  }
}

export class GpxTextDecoder {
  readonly encoding: string

  constructor(label?: string) {
    this.encoding = label ? String(label).toLowerCase() : 'utf-8'
  }

  decode(input?: BufferSource): string {
    return utf8Decode(input)
  }
}

export function gpxBtoa(str: string): string {
  const s = String(str)
  const bytes = new Uint8Array(s.length)
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i)
    if (code > 0xff) throw new Error('btoa: character out of Latin1 range')
    bytes[i] = code
  }
  return bytesToBase64(bytes)
}

export function gpxAtob(b64: string): string {
  const bytes = base64ToBytes(b64)
  let out = ''
  for (let i = 0; i < bytes.length; i++) {
    out += String.fromCharCode(bytes[i])
  }
  return out
}

export function installTextPolyfills(): void {
  const g = globalThis as Record<string, unknown>
  if (typeof g.TextEncoder !== 'function') g.TextEncoder = GpxTextEncoder
  if (typeof g.TextDecoder !== 'function') g.TextDecoder = GpxTextDecoder
  if (typeof g.btoa !== 'function') g.btoa = gpxBtoa
  if (typeof g.atob !== 'function') g.atob = gpxAtob
}
