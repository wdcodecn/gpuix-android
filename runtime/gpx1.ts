import type { GpuixBatchMutation } from './types'

export type GpxStyleCache = {
  nextId: number
  obj: WeakMap<object, number>
  json: Map<string, number>
}

export const GPX1_OPCODES = {
  createElement: 0x01,
  destroyElement: 0x02,
  appendChild: 0x03,
  insertBefore: 0x04,
  internStyle: 0x06,
  setStyleById: 0x07,
  setText: 0x08,
  setEventListener: 0x09,
  setRoot: 0x0a,
  setKeyboardFocusDim: 0x0b,
  setCustomProp: 0x0c,
} as const

// Reusable scratch buffer + hand-rolled UTF-8 encoder (standalone Hermes has no TextEncoder).
let gpxBuf = new Uint8Array(4096)
let gpxView = new DataView(gpxBuf.buffer)
let gpxPos = 0

function ensure(extra: number): void {
  const needed = gpxPos + extra
  if (needed <= gpxBuf.length) return
  let cap = gpxBuf.length
  while (cap < needed) cap *= 2
  const next = new Uint8Array(cap)
  next.set(gpxBuf.subarray(0, gpxPos))
  gpxBuf = next
  gpxView = new DataView(next.buffer)
}

function writeU8(v: number): void {
  ensure(1)
  gpxBuf[gpxPos++] = v & 0xff
}

function writeU32(v: number): void {
  ensure(4)
  gpxView.setUint32(gpxPos, v >>> 0, true)
  gpxPos += 4
}

function writeU64(v: number): void {
  ensure(8)
  const lo = v >>> 0
  const hi = Math.floor(v / 0x100000000) >>> 0
  gpxView.setUint32(gpxPos, lo, true)
  gpxView.setUint32(gpxPos + 4, hi, true)
  gpxPos += 8
}

function writeStrWithLen(str: string, isU16: boolean): void {
  const lenFieldBytes = isU16 ? 2 : 4
  ensure(lenFieldBytes + str.length * 3)
  const lenPos = gpxPos
  gpxPos += lenFieldBytes
  const start = gpxPos
  const buf = gpxBuf
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i)
    if (c < 0x80) {
      buf[gpxPos++] = c
    } else if (c < 0x800) {
      buf[gpxPos++] = 0xc0 | (c >> 6)
      buf[gpxPos++] = 0x80 | (c & 0x3f)
    } else if (c >= 0xd800 && c <= 0xdbff && i + 1 < str.length) {
      const c2 = str.charCodeAt(i + 1)
      if (c2 >= 0xdc00 && c2 <= 0xdfff) {
        const cp = 0x10000 + ((c - 0xd800) << 10) + (c2 - 0xdc00)
        buf[gpxPos++] = 0xf0 | (cp >> 18)
        buf[gpxPos++] = 0x80 | ((cp >> 12) & 0x3f)
        buf[gpxPos++] = 0x80 | ((cp >> 6) & 0x3f)
        buf[gpxPos++] = 0x80 | (cp & 0x3f)
        i++
        continue
      }
      buf[gpxPos++] = 0xef
      buf[gpxPos++] = 0xbf
      buf[gpxPos++] = 0xbd
    } else if (c >= 0xd800 && c <= 0xdfff) {
      buf[gpxPos++] = 0xef
      buf[gpxPos++] = 0xbf
      buf[gpxPos++] = 0xbd
    } else {
      buf[gpxPos++] = 0xe0 | (c >> 12)
      buf[gpxPos++] = 0x80 | ((c >> 6) & 0x3f)
      buf[gpxPos++] = 0x80 | (c & 0x3f)
    }
  }
  const byteLen = gpxPos - start
  if (isU16) {
    gpxView.setUint16(lenPos, byteLen, true)
  } else {
    gpxView.setUint32(lenPos, byteLen, true)
  }
}

export function createStyleCache(): GpxStyleCache {
  return { nextId: 1, obj: new WeakMap(), json: new Map() }
}

export function encodeBatch(queue: GpuixBatchMutation[], styleCache: GpxStyleCache): Uint8Array | null {
  gpxPos = 0
  ensure(8)
  gpxBuf[0] = 0x47 // 'G'
  gpxBuf[1] = 0x50 // 'P'
  gpxBuf[2] = 0x58 // 'X'
  gpxBuf[3] = 0x31 // '1'
  gpxPos = 8
  let emitted = 0

  for (let i = 0; i < queue.length; i++) {
    const op = queue[i]
    const name = op[0]
    if (name === 'setStyle') {
      const elemId = op[1] as number
      const styleObj = op[2]
      let sid = styleObj && typeof styleObj === 'object' ? styleCache.obj.get(styleObj) : undefined
      if (sid === undefined) {
        const rawJson = JSON.stringify(styleObj ?? {})
        sid = styleCache.json.get(rawJson)
        if (sid === undefined) {
          sid = styleCache.nextId++
          if (styleCache.nextId >= 0x7fffffff) styleCache.nextId = 1
          if (styleCache.json.size >= 2048) {
            const oldestKey = styleCache.json.keys().next().value
            if (oldestKey !== undefined) styleCache.json.delete(oldestKey)
          }
          styleCache.json.set(rawJson, sid)
          writeU8(GPX1_OPCODES.internStyle)
          writeU32(sid)
          writeStrWithLen(rawJson, false)
          emitted++
        }
        if (styleObj && typeof styleObj === 'object') {
          styleCache.obj.set(styleObj, sid)
        }
      }
      writeU8(GPX1_OPCODES.setStyleById)
      writeU64(elemId)
      writeU32(sid)
      emitted++
    } else if (name === 'createElement') {
      writeU8(GPX1_OPCODES.createElement)
      writeU64(op[1] as number)
      writeStrWithLen(String(op[2]), true)
      emitted++
    } else if (name === 'destroyElement') {
      writeU8(GPX1_OPCODES.destroyElement)
      writeU64(op[1] as number)
      emitted++
    } else if (name === 'appendChild') {
      writeU8(GPX1_OPCODES.appendChild)
      writeU64(op[1] as number)
      writeU64(op[2] as number)
      emitted++
    } else if (name === 'insertBefore') {
      writeU8(GPX1_OPCODES.insertBefore)
      writeU64(op[1] as number)
      writeU64(op[2] as number)
      writeU64(op[3] as number)
      emitted++
    } else if (name === 'setText') {
      writeU8(GPX1_OPCODES.setText)
      writeU64(op[1] as number)
      writeStrWithLen(String(op[2]), false)
      emitted++
    } else if (name === 'setEventListener') {
      writeU8(GPX1_OPCODES.setEventListener)
      writeU64(op[1] as number)
      writeStrWithLen(String(op[2]), true)
      writeU8(op[3] ? 1 : 0)
      emitted++
    } else if (name === 'setRoot') {
      writeU8(GPX1_OPCODES.setRoot)
      writeU64(op[1] as number)
      emitted++
    } else if (name === 'setKeyboardFocusDim') {
      writeU8(GPX1_OPCODES.setKeyboardFocusDim)
      writeU8(op[1] ? 1 : 0)
      emitted++
    } else if (name === 'setCustomProp') {
      writeU8(GPX1_OPCODES.setCustomProp)
      writeU64(op[1] as number)
      writeStrWithLen(String(op[2]), true)
      const propJson = JSON.stringify(op[3])
      writeStrWithLen(propJson === undefined ? 'null' : propJson, false)
      emitted++
    } else {
      return null
    }
  }

  gpxView.setUint32(4, emitted, true)
  return gpxBuf.slice(0, gpxPos)
}
