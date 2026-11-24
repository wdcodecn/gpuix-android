import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { mkdir, rename, rm, stat } from 'node:fs/promises'
import type { BunPlugin } from 'bun'
import {
  loadGpuixAndroidConfig,
  resolveOtaConfig,
  syncGeneratedManifest,
  writeGradleProperties,
  writeTextIfChanged,
  type GpuixAndroidConfig,
} from './config'

const androidRuntimeEntry = path.resolve(import.meta.dir, '../runtime/index.ts')

export function createAndroidPlugins(): BunPlugin[] {
  return [
    {
      name: 'gpuix-android-native',
      setup(build) {
        build.onResolve({ filter: /^@gpuix\/native$/ }, () => ({
          path: androidRuntimeEntry,
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

const DEBUG_WRAPPER_PREFIX = `;(function() {
  if (!globalThis.__gpuixHotCleanups) {
    globalThis.__gpuixHotCleanups = [];
  }
  if (!globalThis.__gpuixHotState || typeof globalThis.__gpuixHotState !== 'object') {
    globalThis.__gpuixHotState = {};
  }
  globalThis.__gpuixHotReloadCount = (globalThis.__gpuixHotReloadCount || 0) + 1;
  if (typeof globalThis.__gpuixRegisterHotCleanup !== 'function') {
    globalThis.__gpuixRegisterHotCleanup = function(fn) {
      if (typeof fn === 'function') globalThis.__gpuixHotCleanups.push(fn);
    };
  }
  if (typeof globalThis.__gpuixRunHotCleanup !== 'function') {
    globalThis.__gpuixRunHotCleanup = function() {
      var list = globalThis.__gpuixHotCleanups.splice(0, globalThis.__gpuixHotCleanups.length);
      for (var i = list.length - 1; i >= 0; i--) {
        try { list[i](); } catch (e) { console.error('[gpuix-dev] cleanup error:', e); }
      }
    };
  }
  globalThis.__gpuixShowRedBox = function(title, message) {
    globalThis.__gpuixRedBoxActive = true;
    if (typeof globalThis.__gpuixCancelOtaAutoConfirm === 'function') {
      globalThis.__gpuixCancelOtaAutoConfirm();
    }
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
  globalThis.__gpuixClearRedBox = function() {
    globalThis.__gpuixRedBoxActive = false;
  };
  if (typeof globalThis.__gpuixRunHotCleanup === 'function') {
    globalThis.__gpuixRunHotCleanup();
  }
  try {
    `

export const DEBUG_WRAPPER_LINE_OFFSET = DEBUG_WRAPPER_PREFIX.split('\n').length - 1

export function wrapDebugBundle(source: string, devPort = 8081): string {
  return `${DEBUG_WRAPPER_PREFIX}${source}
  } catch (err) {
    var detail = err && (err.stack || err.message) ? (err.stack || err.message) : String(err);
    console.error('[gpuix-dev] Fatal error:', detail);
    if (typeof globalThis.__gpuixShowRedBox === 'function') {
      globalThis.__gpuixShowRedBox('Fatal Error', detail);
      if (typeof fetch === 'function') {
        fetch('http://127.0.0.1:${devPort}/symbolicate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ stack: detail }),
          timeoutMs: 2500
        }).then(function(res) {
          return res && res.ok ? res.json() : null;
        }).then(function(data) {
          if (data && typeof data.symbolicated === 'string' && data.symbolicated !== detail) {
            globalThis.__gpuixShowRedBox('Fatal Error', data.symbolicated);
          }
        }).catch(function() {});
      }
    }
  }
})();`
}

function sharedCacheDir(): string {
  const custom = process.env.GPUIX_CACHE_DIR
  if (custom && custom.trim().length > 0) return path.resolve(custom)
  const xdg = process.env.XDG_CACHE_HOME
  const base = xdg && xdg.trim().length > 0 ? xdg : path.join(homedir(), '.cache')
  return path.join(base, 'gpuix-android')
}

export function findHermesc(androidRoot: string): string | null {
  const candidates = [
    path.join(androidRoot, '.build/hermes-host/bin/hermesc'),
    path.join(androidRoot, '.build/hermes-host/bin/hermesc.exe'),
  ]
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate
  }

  const hermesCacheDir = path.join(sharedCacheDir(), 'hermes')
  if (!existsSync(hermesCacheDir)) return null
  try {
    const entries = readdirSync(hermesCacheDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => {
        const dirPath = path.join(hermesCacheDir, entry.name)
        const binPath = existsSync(path.join(dirPath, 'hermesc.exe'))
          ? path.join(dirPath, 'hermesc.exe')
          : path.join(dirPath, 'hermesc')
        const mtime = existsSync(binPath) ? statSync(binPath).mtimeMs : 0
        return { binPath, mtime }
      })
      .filter((item) => item.mtime > 0)
      .sort((a, b) => b.mtime - a.mtime)
    return entries[0]?.binPath ?? null
  } catch {
    return null
  }
}

export type CompileAndroidBundleOptions = {
  projectRoot: string
  androidRoot: string
  entrypointRel: string
  isRelease: boolean
  skipHbc?: boolean
  tempWorkDir?: string
}

const HERMES_BYTECODE_MAGIC = Buffer.from([0xc6, 0x1f, 0xbc, 0x03, 0xc1, 0x03, 0x19, 0x1f])

export function readHermesBytecodeVersion(bytes: Uint8Array): number {
  if (bytes.length < 12) return 0
  for (let i = 0; i < HERMES_BYTECODE_MAGIC.length; i += 1) {
    if (bytes[i] !== HERMES_BYTECODE_MAGIC[i]) return 0
  }
  return (bytes[8] | (bytes[9] << 8) | (bytes[10] << 16) | ((bytes[11] << 24) >>> 0)) >>> 0
}

export type CompiledAndroidBundle = {
  format: 'hbc' | 'js'
  bytes: Buffer
  jsSource: string
  sha256: string
  hermescPath: string | null
  hbcVersion: number
}

/**
 * Bundles the React + GPUIX entrypoint into Android JS and compiles it to
 * Hermes bytecode (`.hbc`) when `hermesc` is available.
 */
export async function compileAndroidBundle(options: CompileAndroidBundleOptions): Promise<CompiledAndroidBundle> {
  const entrypoint = path.join(options.projectRoot, options.entrypointRel)
  const result = await Bun.build({
    entrypoints: [entrypoint],
    naming: 'app.js',
    target: 'browser', // Standard JavaScript output; execution is in standalone Hermes.
    format: 'iife',
    minify: true,
    define: {
      'process.env.NODE_ENV': options.isRelease ? '"production"' : '"development"',
      process: 'undefined',
      window: 'undefined',
      Bun: 'undefined',
    },
    plugins: createAndroidPlugins(),
  })
  if (!result.success) throw new AggregateError(result.logs, 'Android JavaScript bundle failed')

  const rawSource = await result.outputs[0].text()
  const fontNormalized = normalizeAndroidFonts(rawSource)
  const jsSource = options.isRelease ? fontNormalized : wrapDebugBundle(fontNormalized)
  const hermesc = options.skipHbc ? null : findHermesc(options.androidRoot)

  if (hermesc) {
    const workDir = options.tempWorkDir ?? path.join(options.androidRoot, '.build')
    await mkdir(workDir, { recursive: true })
    const stamp = `${process.pid}.${Date.now()}.${randomUUID()}`
    const tmpJs = path.join(workDir, `.ota-bundle-${stamp}.js`)
    const tmpHbc = path.join(workDir, `.ota-bundle-${stamp}.hbc`)
    try {
      await Bun.write(tmpJs, jsSource)
      const proc = Bun.spawnSync([hermesc, '-emit-binary', '-O', '-out', tmpHbc, tmpJs], {
        stdout: 'pipe',
        stderr: 'pipe',
      })
      if (proc.exitCode === 0 && existsSync(tmpHbc)) {
        const bytes = Buffer.from(await Bun.file(tmpHbc).arrayBuffer())
        const sha256 = createHash('sha256').update(bytes).digest('hex')
        return {
          format: 'hbc',
          bytes,
          jsSource,
          sha256,
          hermescPath: hermesc,
          hbcVersion: readHermesBytecodeVersion(bytes),
        }
      }
      const errText = new TextDecoder().decode(proc.stderr).trim()
      console.warn(`Warning: hermesc bytecode compilation failed (${errText}); falling back to JS bundle`)
    } finally {
      await rm(tmpJs, { force: true })
      await rm(tmpHbc, { force: true })
    }
  }

  const bytes = Buffer.from(jsSource, 'utf8')
  const sha256 = createHash('sha256').update(bytes).digest('hex')
  return { format: 'js', bytes, jsSource, sha256, hermescPath: null, hbcVersion: 0 }
}

export function formatOtaMetaKv(
  config: GpuixAndroidConfig,
  format: 'hbc' | 'js',
  embeddedBuildId: string,
  hbcVersion = 0,
): string {
  const ota = resolveOtaConfig(config)
  const clean = (value: string) => value.replace(/[\r\n\0]/g, ' ')
  return [
    'schema=1',
    `app_id=${clean(config.appId)}`,
    `version_name=${clean(config.versionName)}`,
    `version_code=${config.versionCode}`,
    `runtime_version=${clean(ota.runtimeVersion)}`,
    `channel=${clean(ota.channel)}`,
    `manifest_url=${clean(ota.manifestUrl ?? '')}`,
    `public_key=${clean(ota.publicKey ?? '')}`,
    `check_on_launch=${ota.checkOnLaunch}`,
    `embedded_format=${format}`,
    `embedded_build_id=${embeddedBuildId}`,
    `hbc_version=${hbcVersion}`,
    '',
  ].join('\n')
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
  const otaMetaPath = path.join(androidRoot, '.build/assets/gpuix/ota-meta.kv')

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

  if (isRelease) {
    await rm(devJsonPath, { force: true })
  } else {
    await writeTextIfChanged(devJsonPath, JSON.stringify({ port: 8081 }))
  }

  let compiledHbc = false
  const hermesc = skipHbc ? null : findHermesc(androidRoot)
  if (hermesc) {
    const hermescStat = await stat(hermesc)
    const hbcInputHash = createHash('sha256')
      .update(androidSource)
      .update(`\0mode=${isRelease ? 'release' : 'debug'}\0`)
      .update(`hermesc=${hermescStat.size}:${Math.trunc(hermescStat.mtimeMs)}\0`)
      .digest('hex')
    const hbcStampPath = path.join(androidRoot, '.build/.hbc-input.sha256')
    const prevStamp = (await Bun.file(hbcStampPath).exists())
      ? (await Bun.file(hbcStampPath).text()).trim()
      : ''

    if (prevStamp === hbcInputHash && existsSync(hbcPath)) {
      compiledHbc = true
      if (isRelease) {
        await rm(bundlePath, { force: true })
      } else {
        await writeTextIfChanged(bundlePath, androidSource)
      }
      console.log(`Android HBC up to date (${hbcInputHash.slice(0, 12)})`)
    } else {
      await mkdir(path.dirname(hbcPath), { recursive: true })
      const hermesInputPath = isRelease
        ? path.join(androidRoot, `.build/.hermes-input.${process.pid}.js`)
        : bundlePath
      if (isRelease) {
        await Bun.write(hermesInputPath, androidSource)
      } else {
        await writeTextIfChanged(bundlePath, androidSource)
      }
      const tmpHbcPath = `${hbcPath}.${process.pid}.${Date.now()}.tmp`
      try {
        const proc = Bun.spawnSync([hermesc, '-emit-binary', '-O', '-out', tmpHbcPath, hermesInputPath], {
          stdout: 'pipe',
          stderr: 'pipe',
        })
        if (proc.exitCode === 0 && existsSync(tmpHbcPath)) {
          const nextBytes = Buffer.from(await Bun.file(tmpHbcPath).arrayBuffer())
          const sameHbc = existsSync(hbcPath) && nextBytes.equals(Buffer.from(await Bun.file(hbcPath).arrayBuffer()))
          if (!sameHbc) {
            await rename(tmpHbcPath, hbcPath)
          } else {
            await rm(tmpHbcPath, { force: true })
          }
          await writeTextIfChanged(hbcStampPath, `${hbcInputHash}\n`)
          compiledHbc = true
          if (isRelease) {
            await rm(bundlePath, { force: true })
          }
        } else {
          await rm(tmpHbcPath, { force: true })
          await writeTextIfChanged(bundlePath, androidSource)
          const errText = new TextDecoder().decode(proc.stderr).trim()
          console.warn(`Warning: hermesc bytecode compilation failed (${errText}); falling back to app.js`)
        }
      } catch (error) {
        await rm(tmpHbcPath, { force: true })
        throw error
      } finally {
        if (isRelease) {
          await rm(hermesInputPath, { force: true })
        }
      }
    }
  } else {
    await writeTextIfChanged(bundlePath, androidSource)
  }

  const finalFormat: 'hbc' | 'js' = compiledHbc ? 'hbc' : 'js'
  const finalBytes = compiledHbc
    ? Buffer.from(await Bun.file(hbcPath).arrayBuffer())
    : Buffer.from(androidSource, 'utf8')
  const embeddedBuildId = createHash('sha256').update(finalBytes).digest('hex')
  const hbcVersion = compiledHbc ? readHermesBytecodeVersion(finalBytes) : 0
  await writeTextIfChanged(otaMetaPath, formatOtaMetaKv(config, finalFormat, embeddedBuildId, hbcVersion))

  const gradleProperties = await writeGradleProperties(androidRoot, config)
  await syncGeneratedManifest(androidRoot, config)
  if (compiledHbc) {
    const hbcBytes = Bun.file(hbcPath).size
    console.log(`Android HBC: ${hbcPath} (${hbcBytes} bytes, release=${isRelease})`)
  } else {
    console.log(`Android JS: ${bundlePath} (${Buffer.byteLength(androidSource)} bytes)`)
  }
  console.log(`Android config: ${config.entrypoint} → ${config.appId} (${gradleProperties})`)
}
