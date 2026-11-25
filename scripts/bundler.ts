import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { mkdir, rename, rm, stat } from 'node:fs/promises'
import type { BunPlugin } from 'bun'
import {
  loadGpuixConfig,
  resolveAndroidAppId,
  resolveConfigFile,
  resolveIosBundleId,
  resolveOtaConfig,
  type GpuixConfig,
} from './config'

const repoRoot = path.resolve(import.meta.dir, '..')
const runtimeEntry = path.join(repoRoot, 'runtime/index.ts')

export type MobileTargetPlatform = 'android' | 'ios'

export function createRuntimePlugins(): BunPlugin[] {
  return [
    {
      name: 'gpuix-mobile-native',
      setup(build) {
        build.onResolve({ filter: /^@gpuix\/native$/ }, () => ({
          path: runtimeEntry,
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

/** Backward-compatible alias for `createRuntimePlugins`. */
export const createAndroidPlugins = createRuntimePlugins

export function normalizeAndroidFonts(source: string): string {
  return source
    .replaceAll('"Helvetica"', '".SystemUIFont"')
    .replaceAll('"Menlo"', '"Droid Sans Mono"')
    .replaceAll('"sans-serif"', '".SystemUIFont"')
}

export function normalizeIosFonts(source: string): string {
  // iOS natively supports Helvetica and Menlo via CoreText; normalize generic sans-serif.
  return source.replaceAll('"sans-serif"', '".SystemUIFont"')
}

export function normalizeFontsForPlatform(source: string, platform: MobileTargetPlatform): string {
  return platform === 'ios' ? normalizeIosFonts(source) : normalizeAndroidFonts(source)
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

export function sharedCacheDir(): string {
  const custom = process.env.GPUIX_CACHE_DIR
  if (custom && custom.trim().length > 0) return path.resolve(custom)
  const xdg = process.env.XDG_CACHE_HOME
  const base = xdg && xdg.trim().length > 0 ? xdg : path.join(homedir(), '.cache')
  return path.join(base, 'gpuix-mobile')
}

export function legacySharedCacheDir(): string {
  const xdg = process.env.XDG_CACHE_HOME
  const base = xdg && xdg.trim().length > 0 ? xdg : path.join(homedir(), '.cache')
  return path.join(base, 'gpuix-android')
}

export function findHermesc(hostRoot?: string): string | null {
  const localCandidates = [
    ...(hostRoot
      ? [
          path.join(hostRoot, '.build/hermes-host/bin/hermesc'),
          path.join(hostRoot, '.build/hermes-host/bin/hermesc.exe'),
          path.join(hostRoot, '../native/.build/hermes-host/bin/hermesc'),
          path.join(hostRoot, '../native/.build/hermes-host/bin/hermesc.exe'),
        ]
      : []),
    path.join(repoRoot, 'native/.build/hermes-host/bin/hermesc'),
    path.join(repoRoot, 'native/.build/hermes-host/bin/hermesc.exe'),
    path.join(repoRoot, 'android/.build/hermes-host/bin/hermesc'),
    path.join(repoRoot, 'android/.build/hermes-host/bin/hermesc.exe'),
  ]
  for (const candidate of localCandidates) {
    if (existsSync(candidate)) return candidate
  }

  for (const cacheRoot of [sharedCacheDir(), legacySharedCacheDir()]) {
    const hermesCacheDir = path.join(cacheRoot, 'hermes')
    if (!existsSync(hermesCacheDir)) continue
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
      if (entries[0]?.binPath) return entries[0].binPath
    } catch {
      // Ignore unreadable cache dirs
    }
  }
  return null
}

const HERMES_BYTECODE_MAGIC = Buffer.from([0xc6, 0x1f, 0xbc, 0x03, 0xc1, 0x03, 0x19, 0x1f])

export function readHermesBytecodeVersion(bytes: Uint8Array): number {
  if (bytes.length < 12) return 0
  for (let i = 0; i < HERMES_BYTECODE_MAGIC.length; i += 1) {
    if (bytes[i] !== HERMES_BYTECODE_MAGIC[i]) return 0
  }
  return (bytes[8] | (bytes[9] << 8) | (bytes[10] << 16) | ((bytes[11] << 24) >>> 0)) >>> 0
}

export function buildInjectedAppInfo(
  platform: MobileTargetPlatform,
  config?: GpuixConfig,
  overrides?: { channel?: string; runtimeVersion?: string; releaseId?: string },
): Record<string, unknown> {
  const appId = config
    ? platform === 'ios'
      ? resolveIosBundleId(config)
      : resolveAndroidAppId(config)
    : 'dev.gpuix.app'
  const ota = config ? resolveOtaConfig(config) : { channel: 'production', runtimeVersion: '1' }
  return {
    appId,
    appName: config?.appName ?? 'GPUIX App',
    versionName: config?.versionName ?? '1.0.0',
    versionCode: config?.versionCode ?? 1,
    platform,
    channel: overrides?.channel ?? ota.channel,
    runtimeVersion: overrides?.runtimeVersion ?? ota.runtimeVersion,
    buildHash: '__GPUIX_BUILD_HASH__',
    ...(overrides?.releaseId ? { releaseId: overrides.releaseId } : {}),
  }
}

export function stampBuildHash(source: string, platform: MobileTargetPlatform, config?: GpuixConfig): {
  source: string
  buildHash: string
} {
  const buildHash = createHash('sha256')
    .update(source)
    .update(`\0${platform}\0${config?.appId ?? ''}\0${config?.versionName ?? ''}\0${config?.versionCode ?? 1}\0`)
    .digest('hex')
    .slice(0, 12)
  return {
    source: source.replaceAll('__GPUIX_BUILD_HASH__', buildHash),
    buildHash,
  }
}

export type CompileMobileBundleOptions = {
  projectRoot: string
  androidRoot?: string
  hostRoot?: string
  entrypointRel: string
  platform?: MobileTargetPlatform
  config?: GpuixConfig
  isRelease: boolean
  skipHbc?: boolean
  tempWorkDir?: string
  channel?: string
  runtimeVersion?: string
  releaseId?: string
}

export type CompileAndroidBundleOptions = CompileMobileBundleOptions

export type CompiledMobileBundle = {
  platform: MobileTargetPlatform
  format: 'hbc' | 'js'
  bytes: Buffer
  jsSource: string
  sha256: string
  buildHash: string
  hermescPath: string | null
  hbcVersion: number
}

export type CompiledAndroidBundle = CompiledMobileBundle

/**
 * Bundles a React + GPUIX entrypoint for Android or iOS and compiles it to
 * Hermes bytecode (`.hbc`) when `hermesc` is available.
 */
export async function compileMobileBundle(options: CompileMobileBundleOptions): Promise<CompiledMobileBundle> {
  const platform: MobileTargetPlatform = options.platform ?? 'android'
  const config =
    options.config ??
    (resolveConfigFile(options.projectRoot) ? await loadGpuixConfig(options.projectRoot) : undefined)
  const appInfo = buildInjectedAppInfo(platform, config, {
    channel: options.channel,
    runtimeVersion: options.runtimeVersion,
    releaseId: options.releaseId,
  })

  const entrypoint = path.join(options.projectRoot, options.entrypointRel)
  const result = await Bun.build({
    entrypoints: [entrypoint],
    naming: 'app.js',
    target: 'browser',
    format: 'iife',
    minify: true,
    define: {
      'process.env.NODE_ENV': options.isRelease ? '"production"' : '"development"',
      process: 'undefined',
      window: 'undefined',
      Bun: 'undefined',
      __GPUIX_PLATFORM__: JSON.stringify(platform),
      __GPUIX_APP_INFO__: JSON.stringify(appInfo),
    },
    plugins: createRuntimePlugins(),
  })
  if (!result.success) throw new AggregateError(result.logs, `${platform} JavaScript bundle failed`)

  const rawSource = await result.outputs[0].text()
  const fontNormalized = normalizeFontsForPlatform(rawSource, platform)
  const { source: stampedSource, buildHash } = stampBuildHash(fontNormalized, platform, config)
  const jsSource = options.isRelease ? stampedSource : wrapDebugBundle(stampedSource)
  const hostRoot = options.hostRoot ?? options.androidRoot
  const hermesc = options.skipHbc ? null : findHermesc(hostRoot)

  if (hermesc) {
    const workDir = options.tempWorkDir ?? path.join(hostRoot ?? path.join(repoRoot, platform), '.build')
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
          platform,
          format: 'hbc',
          bytes,
          jsSource,
          sha256,
          buildHash,
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
  return {
    platform,
    format: 'js',
    bytes,
    jsSource,
    sha256,
    buildHash,
    hermescPath: null,
    hbcVersion: 0,
  }
}

/** Backward-compatible alias for `compileMobileBundle`. */
export const compileAndroidBundle = compileMobileBundle

export function formatOtaMetaKv(
  config: GpuixConfig,
  format: 'hbc' | 'js',
  embeddedBuildId: string,
  hbcVersion = 0,
  platform: MobileTargetPlatform = 'android',
): string {
  const ota = resolveOtaConfig(config)
  const clean = (value: string) => value.replace(/[\r\n\0]/g, ' ')
  const appId = platform === 'ios' ? resolveIosBundleId(config) : resolveAndroidAppId(config)
  return [
    'schema=1',
    `app_id=${clean(appId)}`,
    `platform=${platform}`,
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

export async function runPlatformJsBuildCli(
  platform: MobileTargetPlatform,
  hostRoot: string,
  options: { projectRoot: string; isRelease: boolean; skipHbc: boolean; entrypointOverride?: string },
): Promise<CompiledMobileBundle & { assetsDir: string; gradleProperties?: string }> {
  const hasConfig = resolveConfigFile(options.projectRoot) !== null
  const config = hasConfig
    ? await loadGpuixConfig(options.projectRoot)
    : {
        entrypoint: options.entrypointOverride ?? 'src/main.tsx',
        appId: 'dev.gpuix.app',
        appName: 'GPUIX App',
        versionName: '1.0.0',
        versionCode: 1,
      }
  const entrypointRel = options.entrypointOverride ?? config.entrypoint
  const assetsDir = path.join(hostRoot, '.build/assets/gpuix')
  const bundlePath = path.join(assetsDir, 'app.js')
  const hbcPath = path.join(assetsDir, 'app.hbc')
  const devJsonPath = path.join(assetsDir, 'dev.json')
  const otaMetaPath = path.join(assetsDir, 'ota-meta.kv')

  const { writeTextIfChanged, writeGradleProperties, syncGeneratedManifest } = await import('./config')

  const appInfo = buildInjectedAppInfo(platform, config)
  const entrypoint = path.join(options.projectRoot, entrypointRel)
  if (!existsSync(entrypoint)) {
    throw new Error(`Entrypoint not found: ${entrypoint}`)
  }

  const result = await Bun.build({
    entrypoints: [entrypoint],
    naming: 'app.js',
    target: 'browser',
    format: 'iife',
    minify: true,
    define: {
      'process.env.NODE_ENV': options.isRelease ? '"production"' : '"development"',
      process: 'undefined',
      window: 'undefined',
      Bun: 'undefined',
      __GPUIX_PLATFORM__: JSON.stringify(platform),
      __GPUIX_APP_INFO__: JSON.stringify(appInfo),
    },
    plugins: createRuntimePlugins(),
  })
  if (!result.success) throw new AggregateError(result.logs, `${platform} JavaScript bundle failed`)

  const rawSource = await result.outputs[0].text()
  const fontNormalized = normalizeFontsForPlatform(rawSource, platform)
  const { source: stampedSource, buildHash } = stampBuildHash(fontNormalized, platform, config)
  const finalSource = options.isRelease ? stampedSource : wrapDebugBundle(stampedSource)

  if (options.isRelease) {
    await rm(devJsonPath, { force: true })
  } else {
    await writeTextIfChanged(devJsonPath, JSON.stringify({ port: 8081 }))
  }

  let compiledHbc = false
  const hermesc = options.skipHbc ? null : findHermesc(hostRoot)
  if (hermesc) {
    const hermescStat = await stat(hermesc)
    const hbcInputHash = createHash('sha256')
      .update(finalSource)
      .update(`\0platform=${platform}\0mode=${options.isRelease ? 'release' : 'debug'}\0`)
      .update(`hermesc=${hermescStat.size}:${Math.trunc(hermescStat.mtimeMs)}\0`)
      .digest('hex')
    const hbcStampPath = path.join(hostRoot, '.build/.hbc-input.sha256')
    const prevStamp = (await Bun.file(hbcStampPath).exists())
      ? (await Bun.file(hbcStampPath).text()).trim()
      : ''

    if (prevStamp === hbcInputHash && existsSync(hbcPath)) {
      compiledHbc = true
      if (options.isRelease) {
        await rm(bundlePath, { force: true })
      } else {
        await writeTextIfChanged(bundlePath, finalSource)
      }
      console.log(`${platform.toUpperCase()} HBC up to date (${hbcInputHash.slice(0, 12)})`)
    } else {
      await mkdir(path.dirname(hbcPath), { recursive: true })
      const hermesInputPath = options.isRelease
        ? path.join(hostRoot, `.build/.hermes-input.${process.pid}.js`)
        : bundlePath
      if (options.isRelease) {
        await Bun.write(hermesInputPath, finalSource)
      } else {
        await writeTextIfChanged(bundlePath, finalSource)
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
          if (options.isRelease) {
            await rm(bundlePath, { force: true })
          }
        } else {
          await rm(tmpHbcPath, { force: true })
          await writeTextIfChanged(bundlePath, finalSource)
          const errText = new TextDecoder().decode(proc.stderr).trim()
          console.warn(`Warning: hermesc bytecode compilation failed (${errText}); falling back to app.js`)
        }
      } catch (error) {
        await rm(tmpHbcPath, { force: true })
        throw error
      } finally {
        if (options.isRelease) {
          await rm(hermesInputPath, { force: true })
        }
      }
    }
  } else {
    await writeTextIfChanged(bundlePath, finalSource)
  }

  const finalFormat: 'hbc' | 'js' = compiledHbc ? 'hbc' : 'js'
  const finalBytes = compiledHbc
    ? Buffer.from(await Bun.file(hbcPath).arrayBuffer())
    : Buffer.from(finalSource, 'utf8')
  const embeddedBuildId = createHash('sha256').update(finalBytes).digest('hex')
  const hbcVersion = compiledHbc ? readHermesBytecodeVersion(finalBytes) : 0
  await writeTextIfChanged(otaMetaPath, formatOtaMetaKv(config, finalFormat, embeddedBuildId, hbcVersion, platform))

  let gradleProperties: string | undefined
  if (platform === 'android') {
    gradleProperties = await writeGradleProperties(hostRoot, config)
    await syncGeneratedManifest(hostRoot, config)
  }

  return {
    platform,
    format: finalFormat,
    bytes: finalBytes,
    jsSource: finalSource,
    sha256: embeddedBuildId,
    buildHash,
    hermescPath: hermesc,
    hbcVersion,
    assetsDir,
    ...(gradleProperties ? { gradleProperties } : {}),
  }
}
