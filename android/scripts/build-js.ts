import path from 'node:path'
import { existsSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import type { BunPlugin } from 'bun'
import { loadGpuixAndroidConfig, writeGradleProperties, writeTextIfChanged } from './config'

const NATIVE_SHIM_SOURCE = `
globalThis.__gpuixAndroid = true;

var __gpxViewport = globalThis.__gpuixViewport;
if (!__gpxViewport) {
  var sizeListeners = new Set();
  var insetsListeners = new Set();
  var lastSize = null;
  var lastInsets = null;
  __gpxViewport = {
    subscribeSize: function(fn) {
      sizeListeners.add(fn);
      if (lastSize) { try { fn(lastSize); } catch (_) {} }
      return function() { sizeListeners.delete(fn); };
    },
    subscribeInsets: function(fn) {
      insetsListeners.add(fn);
      if (lastInsets) { try { fn(lastInsets); } catch (_) {} }
      return function() { insetsListeners.delete(fn); };
    },
    __emitSize: function(next) {
      lastSize = next;
      sizeListeners.forEach(function(fn) { try { fn(next); } catch (_) {} });
    },
    __emitInsets: function(next) {
      lastInsets = next;
      insetsListeners.forEach(function(fn) { try { fn(next); } catch (_) {} });
    }
  };
  globalThis.__gpuixViewport = __gpxViewport;
}

// Reusable scratch buffer + hand-rolled UTF-8 encoder (standalone Hermes has no TextEncoder).
var __gpxBuf = new Uint8Array(4096);
var __gpxView = new DataView(__gpxBuf.buffer);
var __gpxPos = 0;

function __gpxEnsure(extra) {
  var needed = __gpxPos + extra;
  if (needed <= __gpxBuf.length) return;
  var cap = __gpxBuf.length;
  while (cap < needed) cap *= 2;
  var next = new Uint8Array(cap);
  next.set(__gpxBuf.subarray(0, __gpxPos));
  __gpxBuf = next;
  __gpxView = new DataView(next.buffer);
}

function __gpxWriteU8(v) {
  __gpxEnsure(1);
  __gpxBuf[__gpxPos++] = v & 0xff;
}

function __gpxWriteU16(v) {
  __gpxEnsure(2);
  __gpxView.setUint16(__gpxPos, v >>> 0, true);
  __gpxPos += 2;
}

function __gpxWriteU32(v) {
  __gpxEnsure(4);
  __gpxView.setUint32(__gpxPos, v >>> 0, true);
  __gpxPos += 4;
}

function __gpxWriteU64(v) {
  __gpxEnsure(8);
  var lo = v >>> 0;
  var hi = Math.floor(v / 0x100000000) >>> 0;
  __gpxView.setUint32(__gpxPos, lo, true);
  __gpxView.setUint32(__gpxPos + 4, hi, true);
  __gpxPos += 8;
}

function __gpxWriteStrWithLen(str, isU16) {
  var lenFieldBytes = isU16 ? 2 : 4;
  __gpxEnsure(lenFieldBytes + str.length * 3);
  var lenPos = __gpxPos;
  __gpxPos += lenFieldBytes;
  var start = __gpxPos;
  var buf = __gpxBuf;
  for (var i = 0; i < str.length; i++) {
    var c = str.charCodeAt(i);
    if (c < 0x80) {
      buf[__gpxPos++] = c;
    } else if (c < 0x800) {
      buf[__gpxPos++] = 0xc0 | (c >> 6);
      buf[__gpxPos++] = 0x80 | (c & 0x3f);
    } else if (c >= 0xd800 && c <= 0xdbff && i + 1 < str.length) {
      var c2 = str.charCodeAt(i + 1);
      if (c2 >= 0xdc00 && c2 <= 0xdfff) {
        var cp = 0x10000 + ((c - 0xd800) << 10) + (c2 - 0xdc00);
        buf[__gpxPos++] = 0xf0 | (cp >> 18);
        buf[__gpxPos++] = 0x80 | ((cp >> 12) & 0x3f);
        buf[__gpxPos++] = 0x80 | ((cp >> 6) & 0x3f);
        buf[__gpxPos++] = 0x80 | (cp & 0x3f);
        i++;
        continue;
      }
      buf[__gpxPos++] = 0xef; buf[__gpxPos++] = 0xbf; buf[__gpxPos++] = 0xbd;
    } else if (c >= 0xd800 && c <= 0xdfff) {
      buf[__gpxPos++] = 0xef; buf[__gpxPos++] = 0xbf; buf[__gpxPos++] = 0xbd;
    } else {
      buf[__gpxPos++] = 0xe0 | (c >> 12);
      buf[__gpxPos++] = 0x80 | ((c >> 6) & 0x3f);
      buf[__gpxPos++] = 0x80 | (c & 0x3f);
    }
  }
  var byteLen = __gpxPos - start;
  if (isU16) {
    __gpxView.setUint16(lenPos, byteLen, true);
  } else {
    __gpxView.setUint32(lenPos, byteLen, true);
  }
}

function __gpxCreateStyleCache() {
  return { nextId: 1, obj: new WeakMap(), json: new Map() };
}

function __gpxEncodeBatch(queue, styleCache) {
  __gpxPos = 0;
  __gpxEnsure(8);
  __gpxBuf[0] = 0x47; // 'G'
  __gpxBuf[1] = 0x50; // 'P'
  __gpxBuf[2] = 0x58; // 'X'
  __gpxBuf[3] = 0x31; // '1'
  __gpxPos = 8;
  var emitted = 0;
  for (var i = 0; i < queue.length; i++) {
    var op = queue[i];
    var name = op[0];
    if (name === "setStyle") {
      var elemId = op[1];
      var styleObj = op[2];
      var sid = styleObj && typeof styleObj === "object" ? styleCache.obj.get(styleObj) : undefined;
      if (sid === undefined) {
        var rawJson = JSON.stringify(styleObj ?? {});
        sid = styleCache.json.get(rawJson);
        if (sid === undefined) {
          sid = styleCache.nextId++;
          if (styleCache.nextId >= 0x7fffffff) styleCache.nextId = 1;
          if (styleCache.json.size >= 2048) {
            var oldestKey = styleCache.json.keys().next().value;
            if (oldestKey !== undefined) styleCache.json.delete(oldestKey);
          }
          styleCache.json.set(rawJson, sid);
          __gpxWriteU8(0x06);
          __gpxWriteU32(sid);
          __gpxWriteStrWithLen(rawJson, false);
          emitted++;
        }
        if (styleObj && typeof styleObj === "object") {
          styleCache.obj.set(styleObj, sid);
        }
      }
      __gpxWriteU8(0x07);
      __gpxWriteU64(elemId);
      __gpxWriteU32(sid);
      emitted++;
    } else if (name === "createElement") {
      __gpxWriteU8(0x01);
      __gpxWriteU64(op[1]);
      __gpxWriteStrWithLen(String(op[2]), true);
      emitted++;
    } else if (name === "destroyElement") {
      __gpxWriteU8(0x02);
      __gpxWriteU64(op[1]);
      emitted++;
    } else if (name === "appendChild") {
      __gpxWriteU8(0x03);
      __gpxWriteU64(op[1]);
      __gpxWriteU64(op[2]);
      emitted++;
    } else if (name === "insertBefore") {
      __gpxWriteU8(0x04);
      __gpxWriteU64(op[1]);
      __gpxWriteU64(op[2]);
      __gpxWriteU64(op[3]);
      emitted++;
    } else if (name === "setText") {
      __gpxWriteU8(0x08);
      __gpxWriteU64(op[1]);
      __gpxWriteStrWithLen(String(op[2]), false);
      emitted++;
    } else if (name === "setEventListener") {
      __gpxWriteU8(0x09);
      __gpxWriteU64(op[1]);
      __gpxWriteStrWithLen(String(op[2]), true);
      __gpxWriteU8(op[3] ? 1 : 0);
      emitted++;
    } else if (name === "setRoot") {
      __gpxWriteU8(0x0a);
      __gpxWriteU64(op[1]);
      emitted++;
    } else if (name === "setKeyboardFocusDim") {
      __gpxWriteU8(0x0b);
      __gpxWriteU8(op[1] ? 1 : 0);
      emitted++;
    } else if (name === "setCustomProp") {
      __gpxWriteU8(0x0c);
      __gpxWriteU64(op[1]);
      __gpxWriteStrWithLen(String(op[2]), true);
      var propJson = JSON.stringify(op[3]);
      __gpxWriteStrWithLen(propJson === undefined ? "null" : propJson, false);
      emitted++;
    } else {
      return null;
    }
  }
  __gpxView.setUint32(4, emitted, true);
  return __gpxBuf.slice(0, __gpxPos);
}

var NativeGpuixRenderer = globalThis.__gpuixNative.GpuixRenderer;
export function GpuixRenderer(callback) {
  var wrappedCallback = typeof callback === "function"
    ? function(error, event) {
        if (!error && event && event.elementId === 0) {
          if (event.eventType === "windowResize" && typeof event.width === "number" && typeof event.height === "number") {
            __gpxViewport.__emitSize({ width: event.width, height: event.height });
            return;
          }
          if (event.eventType === "windowInsets" && typeof event.value === "string") {
            try { __gpxViewport.__emitInsets(JSON.parse(event.value)); } catch (_) {}
            return;
          }
        }
        return callback(error, event);
      }
    : callback;
  var instance = new NativeGpuixRenderer(wrappedCallback);
  globalThis.__gpuixLastRenderer = instance;
  if (typeof instance.applyBinaryBatch === "function") {
    var styleCache = __gpxCreateStyleCache();
    instance.__applyBatchQueue = function(queue) {
      var bin = __gpxEncodeBatch(queue, styleCache);
      if (bin !== null) {
        return instance.applyBinaryBatch(bin);
      }
      return instance.applyBatch(JSON.stringify(queue));
    };
  }
  return instance;
}
export const isTerminal = () => false;
`

export function createAndroidPlugins(): BunPlugin[] {
  return [
    {
      name: 'gpuix-android-native',
      setup(build) {
        build.onResolve({ filter: /^@gpuix\/native$/ }, () => ({ path: 'native', namespace: 'android' }))
        build.onLoad({ filter: /.*/, namespace: 'android' }, () => ({
          contents: NATIVE_SHIM_SOURCE,
          loader: 'js',
        }))
        build.onLoad({ filter: /[\\/]@gpuix[\\/]native[\\/]dist[\\/]mutations\.js$/ }, async (args) => {
          const raw = await Bun.file(args.path).text()
          const patched = raw.replace(
            'renderer.applyBatch(JSON.stringify(queue))',
            '(typeof renderer.__applyBatchQueue === "function" ? renderer.__applyBatchQueue(queue) : renderer.applyBatch(JSON.stringify(queue)))',
          )
          return { contents: patched, loader: 'js' }
        })
      },
    },
  ]
}

export function normalizeAndroidFonts(source: string): string {
  return source
    .replaceAll('"Helvetica"', '".SystemUIFont"')
    .replaceAll('"Menlo"', '"Droid Sans Mono"')
    .replaceAll('"sans-serif"', '".SystemUIFont"')
}

export function wrapDebugBundle(source: string): string {
  return `;(function() {
  if (!globalThis.__gpuixHotCleanups) {
    globalThis.__gpuixHotCleanups = [];
  }
  globalThis.__gpuixRegisterHotCleanup = function(fn) {
    if (typeof fn === 'function') globalThis.__gpuixHotCleanups.push(fn);
  };
  globalThis.__gpuixRunHotCleanup = function() {
    var list = globalThis.__gpuixHotCleanups.splice(0, globalThis.__gpuixHotCleanups.length);
    for (var i = list.length - 1; i >= 0; i--) {
      try { list[i](); } catch (e) { console.error('[gpuix-dev] cleanup error:', e); }
    }
  };
  globalThis.__gpuixShowRedBox = function(title, message) {
    var renderer = globalThis.__gpuixLastRenderer;
    if (!renderer || typeof renderer.applyBatch !== 'function') return;
    try {
      renderer.applyBatch(JSON.stringify([
        ['createElement', 990001, 'div'],
        ['setStyle', 990001, { width: '100%', height: '100%', backgroundColor: '#7f1d1d', padding: 24, flexDirection: 'column', gap: 12 }],
        ['createElement', 990002, 'text'],
        ['setStyle', 990002, { fontSize: 18, fontWeight: 'bold', color: '#ffffff' }],
        ['setText', 990002, String(title || 'Runtime Error')],
        ['createElement', 990003, 'text'],
        ['setStyle', 990003, { fontSize: 12, color: '#fee2e2', fontFamily: 'Droid Sans Mono' }],
        ['setText', 990003, String(message || '').slice(0, 2000)],
        ['appendChild', 990001, 990002],
        ['appendChild', 990001, 990003],
        ['setRoot', 990001]
      ]));
    } catch (_) {}
  };
  globalThis.__gpuixClearRedBox = function() {};
  if (typeof globalThis.__gpuixRunHotCleanup === 'function') {
    globalThis.__gpuixRunHotCleanup();
  }
  try {
    ${source}
  } catch (err) {
    var detail = err && (err.stack || err.message) ? (err.stack || err.message) : String(err);
    console.error('[gpuix-dev] Fatal error:', detail);
    if (typeof globalThis.__gpuixShowRedBox === 'function') {
      globalThis.__gpuixShowRedBox('Fatal Error', detail);
    }
  }
})();`
}

function findHermesc(androidRoot: string): string | null {
  const candidates = [
    path.join(androidRoot, '.build/hermes-host/bin/hermesc'),
    path.join(androidRoot, '.build/hermes-host/bin/hermesc.exe'),
  ]
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate
  }
  return null
}

if (import.meta.main) {
  const androidRoot = path.resolve(import.meta.dir, '..')
  const project = process.env.GPUIX_PROJECT_ROOT
    ? path.resolve(process.env.GPUIX_PROJECT_ROOT)
    : path.dirname(androidRoot)
  const args = new Set(process.argv.slice(2))
  const isRelease = args.has('--release')
  const skipHbc = args.has('--no-hbc')
  const config = await loadGpuixAndroidConfig(project)
  const entrypoint = path.join(project, config.entrypoint)
  const bundlePath = path.join(androidRoot, '.build/assets/gpuix/app.js')
  const hbcPath = path.join(androidRoot, '.build/assets/gpuix/app.hbc')
  const devJsonPath = path.join(androidRoot, '.build/assets/gpuix/dev.json')

  const result = await Bun.build({
    entrypoints: [entrypoint],
    naming: 'app.js',
    target: 'browser', // Standard JavaScript output; execution is in standalone Hermes.
    format: 'iife',
    minify: true,
    define: {
      'process.env.NODE_ENV': isRelease ? '"production"' : '"development"',
      process: 'undefined',
      window: 'undefined',
      Bun: 'undefined',
    },
    plugins: createAndroidPlugins(),
  })
  if (!result.success) throw new AggregateError(result.logs, 'Android JavaScript bundle failed')

  const output = result.outputs[0]
  const rawSource = await output.text()
  const fontNormalized = normalizeAndroidFonts(rawSource)
  const androidSource = isRelease ? fontNormalized : wrapDebugBundle(fontNormalized)
  await writeTextIfChanged(bundlePath, androidSource)

  if (isRelease) {
    await rm(devJsonPath, { force: true })
  } else {
    await writeTextIfChanged(devJsonPath, JSON.stringify({ port: 8081 }))
  }

  let compiledHbc = false
  const hermesc = skipHbc ? null : findHermesc(androidRoot)
  if (hermesc) {
    const proc = Bun.spawnSync([hermesc, '-emit-binary', '-O', '-out', hbcPath, bundlePath], {
      stdout: 'pipe',
      stderr: 'pipe',
    })
    if (proc.exitCode === 0 && existsSync(hbcPath)) {
      compiledHbc = true
      if (isRelease) {
        await rm(bundlePath, { force: true })
      }
    } else {
      const errText = new TextDecoder().decode(proc.stderr).trim()
      console.warn(`Warning: hermesc bytecode compilation failed (${errText}); falling back to app.js`)
    }
  }

  const gradleProperties = await writeGradleProperties(androidRoot, config)
  if (compiledHbc) {
    const hbcBytes = Bun.file(hbcPath).size
    console.log(`Android HBC: ${hbcPath} (${hbcBytes} bytes, release=${isRelease})`)
  } else {
    console.log(`Android JS: ${bundlePath} (${Buffer.byteLength(androidSource)} bytes)`)
  }
  console.log(`Android config: ${config.entrypoint} → ${config.appId} (${gradleProperties})`)
}
