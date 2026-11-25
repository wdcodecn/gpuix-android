#!/usr/bin/env bun

import path from 'node:path'
import { createHash } from 'node:crypto'
import { homedir } from 'node:os'
import { existsSync } from 'node:fs'
import { chmod, cp, lstat, mkdir, readdir, rm, stat } from 'node:fs/promises'
import { legacySharedCacheDir, sharedCacheDir } from './bundler'
import {
  loadGpuixConfig,
  resolveAndroidAppId,
  resolveConfigFile,
  resolveIosBuildNumber,
  resolveIosBundleId,
  resolveIosDeploymentTarget,
  resolveIosStatusBarStyle,
  type GpuixConfig,
} from './config'
import { runDevServer } from './dev-server'
import { runOtaCommand } from './ota'

type ParsedArgs = {
  values: Map<string, string>
  flags: Set<string>
  positional: string[]
}

type AndroidHost = {
  mode: 'ejected' | 'managed'
  androidRoot: string
  nativeRoot: string
}

type ZipEntryInfo = {
  name: string
  compressedSize: number
  uncompressedSize: number
  compressionMethod: number
  localHeaderOffset: number
}

const packageRoot = path.resolve(import.meta.dir, '..')
const templateAndroidRoot = path.join(packageRoot, 'android')
const templateNativeRoot = path.join(packageRoot, 'native')
const templateRuntimeRoot = path.join(packageRoot, 'runtime')
const templateIosRoot = path.join(packageRoot, 'ios')
const starterRoot = path.join(packageRoot, 'templates/react-gpui')
const booleanOptions = new Set(['aab', 'all', 'eject', 'fast', 'help', 'js-only', 'logcat', 'no-hbc', 'release'])

function usage(): string {
  return `gpuix — React + GPUIX unified native mobile toolchain (Android & iOS, no WebView)

Usage:
  gpuix --version
  gpuix create DIR [--app-id ID] [--name APP_NAME] [--version VERSION] [--version-code N] [--eject]
  gpuix init [--cwd DIR] [--entry FILE] [--app-id ID] [--name APP_NAME] [--version VERSION] [--version-code N] [--eject]
  gpuix eject [--cwd DIR]
  gpuix doctor [--cwd DIR]
  gpuix info [--cwd DIR]
  gpuix dev [ADB_SERIAL] [--cwd DIR] [--port 8081] [--logcat]
  gpuix build [android|ios] [--cwd DIR] [--release] [--aab] [--fast] [--js-only] [--no-hbc]
  gpuix install ADB_SERIAL [--cwd DIR] [--release]
  gpuix run [android] ADB_SERIAL [--cwd DIR] [--release] [--fast] [--js-only]
  gpuix run ios [DEVICE_NAME_OR_UDID] [--cwd DIR] [--device NAME_OR_UDID] [--entry FILE] [--release] [--js-only]
  gpuix bench [ADB_SERIAL] [--cwd DIR] [--release]
  gpuix cache [status|clean] [--cwd DIR] [--all]
  gpuix ota <keygen|build|verify|chain|proof|locate|serve> [OPTIONS]

Artifacts:
  Android debug   dist/android/<project>-debug.apk
  Android release dist/android/<project>-release.apk / -release.aab
  iOS Simulator   dist/ios/<project>.app

Both hosts render via GPUI + wgpu with standalone Hermes (no WebView / RN UI).`
}

function fail(message: string): never {
  throw new Error(`gpuix: ${message}`)
}

function parseArgs(args: string[]): ParsedArgs {
  const values = new Map<string, string>()
  const flags = new Set<string>()
  const positional: string[] = []
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (!arg.startsWith('--')) {
      positional.push(arg)
      continue
    }
    const equals = arg.indexOf('=')
    const key = equals === -1 ? arg.slice(2) : arg.slice(2, equals)
    if (!key) fail(`${arg} is not a valid option`)
    if (equals === -1 && booleanOptions.has(key)) {
      flags.add(key)
      continue
    }
    const value = equals === -1 ? args[index + 1] : arg.slice(equals + 1)
    if (!value || value.startsWith('--')) fail(`${arg} needs a value`)
    if (equals === -1) index += 1
    values.set(key, value)
  }
  return { values, flags, positional }
}

function option(parsed: ParsedArgs, ...names: string[]): string | undefined {
  for (const name of names) {
    const value = parsed.values.get(name)
    if (value !== undefined) return value
  }
  return undefined
}

function hasFlag(parsed: ParsedArgs, name: string): boolean {
  return parsed.flags.has(name)
}

function assertKnownOptions(parsed: ParsedArgs, allowedValues: string[], allowedFlags: string[] = []): void {
  for (const key of parsed.values.keys()) {
    if (!allowedValues.includes(key)) fail(`unknown option --${key}`)
  }
  for (const key of parsed.flags) {
    if (!allowedFlags.includes(key)) fail(`unknown option --${key}`)
  }
}

async function exists(target: string): Promise<boolean> {
  try {
    await lstat(target)
    return true
  } catch {
    return false
  }
}

function appIdSuffix(projectRoot: string): string {
  let suffix = path.basename(projectRoot).toLowerCase().replaceAll(/[^a-z0-9_]+/g, '_')
  suffix = suffix.replaceAll(/^_+|_+$/g, '')
  if (!suffix || !/^[a-z]/.test(suffix)) suffix = `app_${suffix || 'project'}`
  return suffix
}

function defaultAppName(projectRoot: string): string {
  const name = path.basename(projectRoot).replaceAll(/[-_]+/g, ' ').trim()
  return name.length > 0 ? name.replace(/\b\w/g, (letter) => letter.toUpperCase()) : 'GPUIX App'
}

function packageSlug(projectRoot: string): string {
  const slug = path.basename(projectRoot).toLowerCase().replaceAll(/[^a-z0-9._-]+/g, '-')
  return slug.replaceAll(/^-+|-+$/g, '') || 'gpuix-app'
}

async function packageVersion(): Promise<string> {
  try {
    const manifest = JSON.parse(await Bun.file(path.join(packageRoot, 'package.json')).text()) as { version?: unknown }
    return typeof manifest.version === 'string' && manifest.version.length > 0 ? manifest.version : '1.0.0'
  } catch {
    return '1.0.0'
  }
}

async function run(
  command: string,
  args: string[],
  cwd: string,
  envOverrides?: Record<string, string>,
): Promise<void> {
  const child = Bun.spawn([command, ...args], {
    cwd,
    env: envOverrides ? { ...process.env, ...envOverrides } : process.env,
    stdin: 'inherit',
    stdout: 'inherit',
    stderr: 'inherit',
  })
  const exitCode = await child.exited
  if (exitCode !== 0) fail(`${command} exited with status ${exitCode}`)
}

function shellCommand(): string {
  if (process.platform !== 'win32') return 'bash'
  for (const candidate of ['C:\\Program Files\\Git\\bin\\bash.exe', 'C:\\Program Files\\Git\\usr\\bin\\bash.exe']) {
    if (existsSync(candidate)) return candidate
  }
  return 'bash'
}

async function capture(
  command: string,
  args: string[],
  cwd = process.cwd(),
  envOverrides?: Record<string, string>,
): Promise<{ ok: boolean; output: string }> {
  try {
    const child = Bun.spawn([command, ...args], {
      cwd,
      env: envOverrides ? { ...process.env, ...envOverrides } : process.env,
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ])
    return { ok: exitCode === 0, output: `${stdout}${stderr}`.trim() }
  } catch (error) {
    return { ok: false, output: error instanceof Error ? error.message : String(error) }
  }
}

function relativeEntrypoint(projectRoot: string, entrypoint: string): string {
  const absolute = path.resolve(projectRoot, entrypoint)
  const relative = path.relative(projectRoot, absolute)
  if (
    relative.length === 0 ||
    relative === '..' ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    fail('--entry must point to a file inside the project directory')
  }
  return relative.split(path.sep).join('/')
}

async function discoverEntrypoint(projectRoot: string): Promise<string | undefined> {
  for (const candidate of ['playground.tsx', 'src/main.tsx', 'src/index.tsx', 'index.tsx']) {
    if (await exists(path.join(projectRoot, candidate))) return candidate
  }
  return undefined
}

function excludedTemplatePath(relativePath: string): boolean {
  const normalized = relativePath.split(path.sep).join('/')
  const segments = normalized.split('/')
  if (segments.includes('target') || segments.includes('.git')) return true
  return [
    '.deps',
    '.build',
    '.gradle',
    'build',
    'app/build',
    'app/src/main/jniLibs',
  ].some((excluded) => normalized === excluded || normalized.startsWith(`${excluded}/`))
}

async function copyAndroidHost(targetProjectRoot: string): Promise<void> {
  if (!(await exists(templateAndroidRoot))) {
    fail(`the packaged Android template is missing at ${templateAndroidRoot}`)
  }
  const targetAndroidRoot = path.join(targetProjectRoot, 'android')
  await cp(templateAndroidRoot, targetAndroidRoot, {
    recursive: true,
    filter(source) {
      return !excludedTemplatePath(path.relative(templateAndroidRoot, source))
    },
  })
  const targetNativeRoot = path.join(targetProjectRoot, 'native')
  if ((await exists(templateNativeRoot)) && !(await exists(targetNativeRoot))) {
    await cp(templateNativeRoot, targetNativeRoot, {
      recursive: true,
      filter(source) {
        return !excludedTemplatePath(path.relative(templateNativeRoot, source))
      },
    })
  }
  const targetRuntimeRoot = path.join(targetProjectRoot, 'runtime')
  if ((await exists(templateRuntimeRoot)) && !(await exists(targetRuntimeRoot))) {
    await cp(templateRuntimeRoot, targetRuntimeRoot, { recursive: true })
  }
  await Promise.all([
    chmod(path.join(targetAndroidRoot, 'gradlew'), 0o755),
    chmod(path.join(targetAndroidRoot, 'scripts/build-android.sh'), 0o755),
    chmod(path.join(targetAndroidRoot, 'scripts/build-hermes.sh'), 0o755),
    chmod(path.join(targetAndroidRoot, 'scripts/install-android.sh'), 0o755),
  ])
}

async function resolveAndroidHost(projectRoot: string): Promise<AndroidHost> {
  const localAndroidRoot = path.join(projectRoot, 'android')
  const localBuildScript = path.join(localAndroidRoot, 'scripts/build-android.sh')
  if (await exists(localBuildScript)) {
    const localNativeRoot = (await exists(path.join(projectRoot, 'native')))
      ? path.join(projectRoot, 'native')
      : (await exists(path.join(localAndroidRoot, 'vendor')))
        ? localAndroidRoot
        : templateNativeRoot
    return { mode: 'ejected', androidRoot: localAndroidRoot, nativeRoot: localNativeRoot }
  }
  if (resolveConfigFile(projectRoot) !== null) {
    return { mode: 'managed', androidRoot: templateAndroidRoot, nativeRoot: templateNativeRoot }
  }
  if (process.env.GPUIX_ENTRYPOINT && process.env.GPUIX_APP_ID) {
    return { mode: 'managed', androidRoot: templateAndroidRoot, nativeRoot: templateNativeRoot }
  }
  fail(`no gpuix.config.json (or gpuix.android.json) or android/ host in ${projectRoot}; run gpuix init first`)
}

function hostEnv(projectRoot: string, platform: 'android' | 'ios', nativeRoot = templateNativeRoot): Record<string, string> {
  return {
    GPUIX_PROJECT_ROOT: projectRoot,
    GPUIX_OUT_DIR: path.join(projectRoot, `dist/${platform}`),
    GPUIX_NATIVE_ROOT: nativeRoot,
  }
}

function buildConfigJson(options: {
  entrypoint: string
  appId: string
  appName: string
  versionName: string
  versionCode: number
}): string {
  return `${JSON.stringify(
    {
      entrypoint: options.entrypoint,
      appId: options.appId,
      appName: options.appName,
      versionName: options.versionName,
      versionCode: options.versionCode,
      android: {
        abis: ['arm64-v8a'],
      },
      ios: {
        bundleId: options.appId,
        buildNumber: String(options.versionCode),
        deploymentTarget: '17.0',
        statusBarStyle: 'light',
      },
    },
    null,
    2,
  )}\n`
}

async function init(parsed: ParsedArgs, projectRoot: string): Promise<void> {
  const existingCfg = resolveConfigFile(projectRoot)
  const configPath = path.join(projectRoot, 'gpuix.config.json')
  const localAndroidRoot = path.join(projectRoot, 'android')
  const shouldEject = hasFlag(parsed, 'eject')

  if (existingCfg) {
    fail(`${existingCfg.path} already exists; refusing to overwrite it (run gpuix eject if you want a local android/ host)`)
  }
  if (shouldEject && (await exists(localAndroidRoot))) {
    fail(`${localAndroidRoot} already exists; refusing to overwrite it`)
  }

  const discoveredEntrypoint = option(parsed, 'entry', 'entrypoint') ?? (await discoverEntrypoint(projectRoot))
  if (!discoveredEntrypoint) {
    fail('could not find an entry point; pass --entry path/to/app.tsx')
  }
  const entrypoint = relativeEntrypoint(projectRoot, discoveredEntrypoint)
  if (!(await exists(path.join(projectRoot, entrypoint)))) {
    fail(`entry point does not exist: ${entrypoint}. Pass --entry path/to/app.tsx`)
  }
  const appId = option(parsed, 'app-id') ?? `dev.gpuix.${appIdSuffix(projectRoot)}`
  if (!/^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)+$/.test(appId)) {
    fail('--app-id must be a dotted package id, for example com.example.myapp')
  }
  const appName = (option(parsed, 'name', 'app-name') ?? defaultAppName(projectRoot)).trim()
  if (!appName || /[\r\n\0]/.test(appName)) fail('--name must be a non-empty single-line string')
  const versionName = (option(parsed, 'version', 'version-name') ?? '1.0.0').trim()
  if (!versionName || /[\r\n\0]/.test(versionName)) fail('--version must be a non-empty single-line string')
  const versionCode = Number(option(parsed, 'version-code') ?? '1')
  if (!Number.isSafeInteger(versionCode) || versionCode < 1) fail('--version-code must be a positive integer')

  await Bun.write(configPath, buildConfigJson({ entrypoint, appId, appName, versionName, versionCode }))
  if (shouldEject) {
    await copyAndroidHost(projectRoot)
    process.stdout.write(`Created ejected Android host in ${localAndroidRoot}\nConfig: ${configPath}\n`)
  } else {
    process.stdout.write(
      `Initialized managed GPUIX config: ${configPath}\n(Zero-boilerplate mode: run \`gpuix run ios\` or \`gpuix run android <SERIAL>\`; use \`gpuix eject\` only if you need custom Java/Gradle/Rust files.)\n`,
    )
  }
}

async function ejectHost(projectRoot: string): Promise<void> {
  const existingCfg = resolveConfigFile(projectRoot)
  const localAndroidRoot = path.join(projectRoot, 'android')
  if (await exists(localAndroidRoot)) {
    fail(`${localAndroidRoot} already exists; refusing to overwrite it`)
  }
  if (!existingCfg) {
    fail(`${path.join(projectRoot, 'gpuix.config.json')} does not exist; run gpuix init first`)
  }
  await loadGpuixConfig(projectRoot)
  await copyAndroidHost(projectRoot)
  process.stdout.write(`Ejected Android host into ${localAndroidRoot}\n`)
}

async function create(parsed: ParsedArgs): Promise<void> {
  if (parsed.positional.length !== 1) fail('create needs exactly one target directory')
  const parent = path.resolve(option(parsed, 'cwd') ?? process.cwd())
  const projectRoot = path.resolve(parent, parsed.positional[0])
  if (await exists(projectRoot)) fail(`${projectRoot} already exists; refusing to overwrite it`)
  assertKnownOptions(parsed, ['cwd', 'app-id', 'name', 'app-name', 'version', 'version-name', 'version-code'], ['eject'])

  const appId = option(parsed, 'app-id') ?? `dev.gpuix.${appIdSuffix(projectRoot)}`
  if (!/^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)+$/.test(appId)) {
    fail('--app-id must be a dotted package id, for example com.example.myapp')
  }
  const appName = (option(parsed, 'name', 'app-name') ?? defaultAppName(projectRoot)).trim()
  if (!appName || /[\r\n\0]/.test(appName)) fail('--name must be a non-empty single-line string')
  const versionName = (option(parsed, 'version', 'version-name') ?? '1.0.0').trim()
  if (!versionName || /[\r\n\0]/.test(versionName)) fail('--version must be a non-empty single-line string')
  const versionCode = Number(option(parsed, 'version-code') ?? '1')
  if (!Number.isSafeInteger(versionCode) || versionCode < 1) fail('--version-code must be a positive integer')
  if (!(await exists(starterRoot))) fail(`starter template is missing at ${starterRoot}`)

  await mkdir(projectRoot, { recursive: true })
  await cp(starterRoot, projectRoot, { recursive: true })
  const pkgVersion = await packageVersion()
  const manifestPath = path.join(projectRoot, 'package.json')
  const manifest = (await Bun.file(manifestPath).text())
    .replaceAll('__PROJECT_NAME__', packageSlug(projectRoot))
    .replaceAll('__GPUX_BASE_UI_VERSION__', '1.0.0')
    .replaceAll('__GPUIX_MOBILE_VERSION__', pkgVersion)
    .replaceAll('__GPUIX_ANDROID_VERSION__', pkgVersion)
  await Bun.write(manifestPath, manifest)

  const configPath = path.join(projectRoot, 'gpuix.config.json')
  await Bun.write(
    configPath,
    buildConfigJson({ entrypoint: 'src/main.tsx', appId, appName, versionName, versionCode }),
  )
  const shouldEject = hasFlag(parsed, 'eject')
  if (shouldEject) {
    await copyAndroidHost(projectRoot)
  }
  process.stdout.write(`Created GPUIX project in ${projectRoot} (${shouldEject ? 'ejected' : 'managed'} host)\n`)
  process.stdout.write(
    `Next:\n  cd ${projectRoot}\n  bun install\n  bun run gpuix:doctor\n  bun run gpuix:run -- <ADB_SERIAL>\n  bun run gpuix -- run ios\n`,
  )
}

async function dirSizeBytes(targetPath: string): Promise<number> {
  try {
    const st = await lstat(targetPath)
    if (st.isSymbolicLink()) return 0
    if (st.isFile()) return st.blocks > 0 ? st.blocks * 512 : st.size
    if (!st.isDirectory()) return 0
    let total = 0
    const entries = await readdir(targetPath, { withFileTypes: true })
    for (const entry of entries) {
      total += await dirSizeBytes(path.join(targetPath, entry.name))
    }
    return total
  } catch {
    return 0
  }
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const units = ['KiB', 'MiB', 'GiB', 'TiB']
  let value = bytes / 1024
  let idx = 0
  while (value >= 1024 && idx < units.length - 1) {
    value /= 1024
    idx += 1
  }
  return `${value.toFixed(value >= 100 ? 0 : value >= 10 ? 1 : 2)} ${units[idx]}`
}

function redundantLocalTargetDirs(projectRoot: string): string[] {
  const androidRoot = path.join(projectRoot, 'android')
  const nativeRoot = path.join(projectRoot, 'native')
  return [
    path.join(androidRoot, 'rust/target'),
    path.join(nativeRoot, 'vendor/gpuix-native/target'),
    path.join(nativeRoot, 'vendor/gpui-mobile/target'),
    path.join(androidRoot, 'vendor/gpuix-native/target'),
    path.join(androidRoot, 'vendor/gpui-mobile/target'),
    path.join(androidRoot, 'target/aarch64-linux-android/debug'),
    path.join(projectRoot, 'ios/target'),
  ]
}

function resolveSdkAndNdk(): { sdkRoot: string; ndkRoot: string } {
  const sdkRoot =
    process.env.ANDROID_HOME ||
    process.env.ANDROID_SDK_ROOT ||
    path.join(homedir(), process.platform === 'win32' ? 'AppData/Local/Android/Sdk' : 'Library/Android/sdk')
  const ndkRoot = process.env.ANDROID_NDK_ROOT || path.join(sdkRoot, 'ndk/30.0.16248370')
  return { sdkRoot, ndkRoot }
}

function ndkHostTag(): string {
  if (process.platform === 'darwin') return 'darwin-x86_64'
  if (process.platform === 'win32') return 'windows-x86_64'
  return 'linux-x86_64'
}

async function doctor(projectRoot: string): Promise<void> {
  const cliVer = await packageVersion()
  const checks: Array<[string, string, string[]]> = [
    ['Bun', 'bun', ['--version']],
    ['Rust', 'rustc', ['--version']],
    ['Cargo NDK', 'cargo', ['ndk', '--version']],
    ['Android SDK', 'adb', ['version']],
    ['Java', 'java', ['-version']],
  ]
  let failures = 0
  process.stdout.write(`GPUIX Mobile doctor v${cliVer} · ${projectRoot}\n`)
  for (const [label, command, args] of checks) {
    const result = await capture(command, args, projectRoot)
    if (result.ok) {
      process.stdout.write(`✓ ${label}: ${result.output.split('\n')[0]}\n`)
    } else {
      failures += 1
      process.stdout.write(`✗ ${label}: ${result.output.split('\n')[0] || 'not available'}\n`)
    }
  }
  const { sdkRoot, ndkRoot } = resolveSdkAndNdk()
  const sdkAvailable = await exists(sdkRoot)
  if (!sdkAvailable) failures += 1
  process.stdout.write(`${sdkAvailable ? '✓' : '✗'} ANDROID_HOME: ${sdkRoot}\n`)
  const ndkAvailable = await exists(ndkRoot)
  if (!ndkAvailable) failures += 1
  process.stdout.write(`${ndkAvailable ? '✓' : '✗'} Android NDK: ${ndkRoot}\n`)

  if (process.platform === 'darwin') {
    const devDir = process.env.DEVELOPER_DIR || (existsSync('/Applications/Xcode.app/Contents/Developer') ? '/Applications/Xcode.app/Contents/Developer' : '')
    const macEnv = devDir ? { DEVELOPER_DIR: devDir } : undefined
    const xcode = await capture('xcodebuild', ['-version'], projectRoot, macEnv)
    const simctl = await capture('xcrun', ['simctl', 'help'], projectRoot, macEnv)
    const rustTargets = await capture('rustup', ['+1.100.0', 'target', 'list', '--installed'], projectRoot)
    const hasIosTarget = rustTargets.ok && rustTargets.output.split(/\r?\n/).includes('aarch64-apple-ios-sim')
    process.stdout.write(`${xcode.ok ? '✓' : '!'} iOS Xcode: ${xcode.ok ? xcode.output.replace('\n', ' · ') : 'not active (set DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer)'}\n`)
    process.stdout.write(`${simctl.ok ? '✓' : '!'} iOS Simulator (simctl): ${simctl.ok ? 'ready' : 'unavailable'}\n`)
    process.stdout.write(`${hasIosTarget ? '✓' : '!'} Rust target (aarch64-apple-ios-sim): ${hasIosTarget ? 'installed' : 'missing (run rustup +1.100.0 target add aarch64-apple-ios-sim)'}\n`)
  }

  const cacheRoot = sharedCacheDir()
  if (process.env.GPUIX_SHARED_CACHE === '0') {
    process.stdout.write('! shared cache: disabled (GPUIX_SHARED_CACHE=0)\n')
  } else {
    const cacheBytes = await dirSizeBytes(cacheRoot)
    process.stdout.write(`✓ shared cache: ${cacheRoot} (${formatBytes(cacheBytes)})\n`)
    const legacy = legacySharedCacheDir()
    if (legacy !== cacheRoot && (await exists(legacy))) {
      const st = await lstat(legacy)
      if (st.isSymbolicLink()) {
        process.stdout.write(`✓ legacy cache alias: ${legacy} -> ${cacheRoot}\n`)
      }
    }
  }

  const hasLocalAndroid = await exists(path.join(projectRoot, 'android/scripts/build-android.sh'))
  const existingCfg = resolveConfigFile(projectRoot)
  if (hasLocalAndroid || existingCfg) {
    process.stdout.write(`✓ host: ${hasLocalAndroid ? 'ejected (local android/)' : `managed (${packageRoot})`}\n`)
    try {
      const config = await loadGpuixConfig(projectRoot)
      process.stdout.write(
        `✓ config (${existingCfg?.filename ?? 'env'}): ${config.appName} · Android=${resolveAndroidAppId(config)} · iOS=${resolveIosBundleId(config)} · v${config.versionName} (${config.versionCode})\n`,
      )
    } catch (error) {
      failures += 1
      process.stdout.write(`✗ config: ${error instanceof Error ? error.message : String(error)}\n`)
    }
  } else {
    process.stdout.write('! config: no gpuix.config.json yet; run gpuix init\n')
  }
  const adb = await capture('adb', ['devices'], projectRoot)
  const connected = adb.output.split('\n').some((line) => /\tdevice$/.test(line))
  process.stdout.write(`${connected ? '✓' : '!'} adb device: ${connected ? 'connected' : 'none (optional until install)'}\n`)
  if (failures > 0) fail(`${failures} required checks failed`)
}

async function info(projectRoot: string): Promise<void> {
  const host = await resolveAndroidHost(projectRoot)
  const config = await loadGpuixConfig(projectRoot)
  const cfgFile = resolveConfigFile(projectRoot)?.filename ?? 'env'
  const artifactStem = packageSlug(projectRoot)
  const cliVersion = await packageVersion()
  const appInfoPayload = {
    cliVersion,
    projectRoot,
    configFile: cfgFile,
    hostMode: host.mode,
    androidRoot: host.androidRoot,
    iosRoot: templateIosRoot,
    nativeRoot: host.nativeRoot,
    entrypoint: config.entrypoint,
    appId: resolveAndroidAppId(config),
    appName: config.appName,
    versionName: config.versionName,
    versionCode: config.versionCode,
    ios: {
      bundleId: resolveIosBundleId(config),
      buildNumber: resolveIosBuildNumber(config),
      deploymentTarget: resolveIosDeploymentTarget(config),
      statusBarStyle: resolveIosStatusBarStyle(config),
    },
    renderer: 'GPUI + wgpu (Vulkan / Metal)',
    javascript: 'standalone Hermes',
    webView: false,
    reactNativeViews: false,
    artifacts: {
      debugApk: path.join(projectRoot, `dist/android/${artifactStem}-debug.apk`),
      releaseApk: path.join(projectRoot, `dist/android/${artifactStem}-release.apk`),
      releaseAab: path.join(projectRoot, `dist/android/${artifactStem}-release.aab`),
      iosSimApp: path.join(projectRoot, `dist/ios/${artifactStem}.app`),
    },
  }
  process.stdout.write(`${JSON.stringify(appInfoPayload, null, 2)}\n`)
}

function splitPlatformTarget(positional: string[]): { target: 'android' | 'ios'; rest: string[] } {
  if (positional[0] === 'ios') return { target: 'ios', rest: positional.slice(1) }
  if (positional[0] === 'android') return { target: 'android', rest: positional.slice(1) }
  return { target: 'android', rest: positional }
}

async function build(parsed: ParsedArgs, projectRoot: string): Promise<void> {
  const { target, rest } = splitPlatformTarget(parsed.positional)
  if (rest.length > 0) fail('build does not accept extra positional arguments')

  if (target === 'ios') {
    const args: string[] = ['--project', projectRoot]
    if (hasFlag(parsed, 'release')) args.push('--release')
    if (hasFlag(parsed, 'js-only')) args.push('--js-only')
    if (hasFlag(parsed, 'no-hbc')) args.push('--no-hbc')
    const entry = option(parsed, 'entry')
    if (entry) args.push('--entry', entry)
    const scriptPath = path.join(templateIosRoot, 'scripts/build-ios.sh')
    await run(shellCommand(), [scriptPath, ...args], projectRoot, hostEnv(projectRoot, 'ios'))
    return
  }

  const host = await resolveAndroidHost(projectRoot)
  const args: string[] = []
  if (hasFlag(parsed, 'release')) args.push('--release')
  if (hasFlag(parsed, 'aab')) args.push('--aab')
  if (hasFlag(parsed, 'fast')) args.push('--fast')
  if (hasFlag(parsed, 'js-only')) args.push('--js-only')
  const scriptPath = path.join(host.androidRoot, 'scripts/build-android.sh')
  await run(shellCommand(), [scriptPath, ...args], projectRoot, hostEnv(projectRoot, 'android', host.nativeRoot))
}

async function install(parsed: ParsedArgs, projectRoot: string): Promise<void> {
  const serial = parsed.positional[0]
  if (!serial || parsed.positional.length !== 1) fail('install needs exactly one ADB serial')
  if (hasFlag(parsed, 'aab')) fail('an AAB cannot be installed directly; build an APK for adb')
  const host = await resolveAndroidHost(projectRoot)
  const scriptPath = path.join(host.androidRoot, 'scripts/install-android.sh')
  await run(
    shellCommand(),
    [scriptPath, serial, ...(hasFlag(parsed, 'release') ? ['--release'] : [])],
    projectRoot,
    hostEnv(projectRoot, 'android', host.nativeRoot),
  )
}

async function runTarget(parsed: ParsedArgs, projectRoot: string): Promise<void> {
  const { target, rest } = splitPlatformTarget(parsed.positional)
  if (target === 'ios') {
    if (rest.length > 1) fail('run ios accepts at most one simulator name or UDID')
    const args: string[] = ['--project', projectRoot]
    const device = option(parsed, 'device') ?? rest[0]
    if (device) args.push('--device', device)
    const entry = option(parsed, 'entry')
    if (entry) args.push('--entry', entry)
    if (hasFlag(parsed, 'release')) args.push('--release')
    if (hasFlag(parsed, 'js-only')) args.push('--js-only')
    if (hasFlag(parsed, 'no-hbc')) args.push('--no-hbc')
    const scriptPath = path.join(templateIosRoot, 'scripts/run-ios-sim.sh')
    await run(shellCommand(), [scriptPath, ...args], projectRoot, hostEnv(projectRoot, 'ios'))
    return
  }

  if (rest.length !== 1) fail('run [android] needs exactly one ADB serial (or use `gpuix run ios`)')
  const host = await resolveAndroidHost(projectRoot)
  const buildArgs: string[] = []
  if (hasFlag(parsed, 'release')) buildArgs.push('--release')
  if (hasFlag(parsed, 'fast')) buildArgs.push('--fast')
  if (hasFlag(parsed, 'js-only')) buildArgs.push('--js-only')
  await run(
    shellCommand(),
    [path.join(host.androidRoot, 'scripts/build-android.sh'), ...buildArgs],
    projectRoot,
    hostEnv(projectRoot, 'android', host.nativeRoot),
  )
  await run(
    shellCommand(),
    [path.join(host.androidRoot, 'scripts/install-android.sh'), rest[0], ...(hasFlag(parsed, 'release') ? ['--release'] : [])],
    projectRoot,
    hostEnv(projectRoot, 'android', host.nativeRoot),
  )
}

function parseZipEntries(buffer: Buffer): ZipEntryInfo[] {
  const eocdSig = 0x06054b50
  let eocdOffset = -1
  const minOffset = Math.max(0, buffer.length - 65557)
  for (let i = buffer.length - 22; i >= minOffset; i -= 1) {
    if (buffer.readUInt32LE(i) === eocdSig) {
      eocdOffset = i
      break
    }
  }
  if (eocdOffset < 0) fail('invalid APK/ZIP archive (missing EOCD)')
  const cdSize = buffer.readUInt32LE(eocdOffset + 12)
  const cdOffset = buffer.readUInt32LE(eocdOffset + 16)
  const entries: ZipEntryInfo[] = []
  let cursor = cdOffset
  const cdEnd = Math.min(buffer.length, cdOffset + cdSize)
  while (cursor + 46 <= cdEnd && buffer.readUInt32LE(cursor) === 0x02014b50) {
    const method = buffer.readUInt16LE(cursor + 10)
    const compressedSize = buffer.readUInt32LE(cursor + 20)
    const uncompressedSize = buffer.readUInt32LE(cursor + 24)
    const nameLen = buffer.readUInt16LE(cursor + 28)
    const extraLen = buffer.readUInt16LE(cursor + 30)
    const commentLen = buffer.readUInt16LE(cursor + 32)
    const localHeaderOffset = buffer.readUInt32LE(cursor + 42)
    const name = buffer.toString('utf8', cursor + 46, cursor + 46 + nameLen)
    entries.push({ name, compressedSize, uncompressedSize, compressionMethod: method, localHeaderOffset })
    cursor += 46 + nameLen + extraLen + commentLen
  }
  return entries
}

function readStoredZipEntry(buffer: Buffer, entry: ZipEntryInfo): Buffer | null {
  if (entry.compressionMethod !== 0) return null
  const off = entry.localHeaderOffset
  if (off + 30 > buffer.length || buffer.readUInt32LE(off) !== 0x04034b50) return null
  const nameLen = buffer.readUInt16LE(off + 26)
  const extraLen = buffer.readUInt16LE(off + 28)
  const dataStart = off + 30 + nameLen + extraLen
  return buffer.subarray(dataStart, dataStart + entry.compressedSize)
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))
  return sorted[idx]
}

export function extractCandidateSurfaceLayers(sfListOutput: string, appId: string): string[] {
  const candidates: string[] = []
  for (const rawLine of sfListOutput.split(/\r?\n/)) {
    const trimmed = rawLine.trim()
    if (!trimmed) continue
    const match = trimmed.match(/^RequestedLayerState\{(.+)\}$/)
    const layer = match
      ? match[1].replace(/\s+(?:parentId|z|layerStack)=.*$/, '').trim()
      : trimmed
    if (!layer || !layer.includes(appId)) continue
    if (
      layer.includes('ActivityRecordInputSink') ||
      layer.includes('animation-leash') ||
      layer.includes('ActivityRecord{') ||
      layer.includes('Splash Screen')
    ) {
      continue
    }
    candidates.push(layer)
  }
  const reversed = candidates.reverse()
  const rank = (name: string): number => {
    if (name.startsWith('VRI-')) return 0
    if (name.startsWith('SurfaceView[')) return 1
    if (name.includes('GpuiActivity')) return 2
    return 3
  }
  reversed.sort((a, b) => rank(a) - rank(b))
  const fallback = `SurfaceView[${appId}/dev.gpui.mobile.GpuiActivity]#0`
  const unique: string[] = []
  for (const item of [...reversed, fallback]) {
    if (!unique.includes(item)) unique.push(item)
  }
  return unique
}

function parseSurfaceFlingerLatency(rawOutput: string): { refreshNs: number; intervals: number[] } {
  const lines = rawOutput.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
  const refreshNs = lines.length > 0 ? Number(lines[0]) : 0
  const presentTimesNs: number[] = []
  for (const line of lines.slice(1)) {
    const cols = line.split(/\s+/)
    if (cols.length < 3) continue
    const actual = Number(cols[1])
    if (Number.isFinite(actual) && actual > 0 && actual < 9e18) {
      presentTimesNs.push(actual)
    }
  }
  presentTimesNs.sort((a, b) => a - b)
  const intervals: number[] = []
  for (let i = 1; i < presentTimesNs.length; i += 1) {
    const deltaMs = (presentTimesNs[i] - presentTimesNs[i - 1]) / 1e6
    if (deltaMs > 0.5 && deltaMs < 500) {
      intervals.push(deltaMs)
    }
  }
  intervals.sort((a, b) => a - b)
  return { refreshNs, intervals }
}

async function resolveBenchSerial(explicit?: string): Promise<string | undefined> {
  if (explicit) return explicit
  const devices = await capture('adb', ['devices'])
  if (!devices.ok) return undefined
  const online = devices.output
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.endsWith('\tdevice'))
    .map((line) => line.split('\t')[0])
  return online.length === 1 ? online[0] : undefined
}

async function bench(parsed: ParsedArgs, projectRoot: string): Promise<void> {
  if (parsed.positional.length > 1) fail('bench accepts at most one ADB serial')
  const host = await resolveAndroidHost(projectRoot)
  const config = await loadGpuixConfig(projectRoot)
  const appId = resolveAndroidAppId(config)
  const variant = hasFlag(parsed, 'release') ? 'release' : 'debug'
  const apkPath = path.join(projectRoot, `dist/android/${packageSlug(projectRoot)}-${variant}.apk`)
  if (!(await exists(apkPath))) {
    fail(`APK not found at ${apkPath}; run gpuix build${variant === 'release' ? ' --release' : ''} first`)
  }

  const apkBuffer = Buffer.from(await Bun.file(apkPath).arrayBuffer())
  const apkSha256 = createHash('sha256').update(apkBuffer).digest('hex')
  const entries = parseZipEntries(apkBuffer)

  let nativeBytes = 0
  let jsBytes = 0
  let dexBytes = 0
  let resBytes = 0
  const nativeEntries: ZipEntryInfo[] = []
  const jsEntries: ZipEntryInfo[] = []

  for (const entry of entries) {
    if (entry.name.startsWith('lib/') && entry.name.endsWith('.so')) {
      nativeBytes += entry.compressedSize
      nativeEntries.push(entry)
    } else if (entry.name.startsWith('assets/gpuix/')) {
      jsBytes += entry.compressedSize
      jsEntries.push(entry)
    } else if (entry.name.endsWith('.dex')) {
      dexBytes += entry.compressedSize
    } else {
      resBytes += entry.compressedSize
    }
  }

  process.stdout.write(`GPUIX Benchmark · ${config.appName} v${config.versionName} (${appId}, ${variant})\n`)
  process.stdout.write(`APK: ${apkPath}\n`)
  process.stdout.write(`  Total size : ${formatBytes(apkBuffer.length)} (${apkBuffer.length} bytes, sha256=${apkSha256.slice(0, 12)})\n`)
  process.stdout.write(`  Native .so : ${formatBytes(nativeBytes)} (${nativeEntries.map((e) => `${e.name.replace(/^lib\//, '')}=${formatBytes(e.compressedSize)}`).join(', ') || 'none'})\n`)
  process.stdout.write(`  JS/HBC     : ${formatBytes(jsBytes)} (${jsEntries.map((e) => `${path.basename(e.name)}=${formatBytes(e.compressedSize)}`).join(', ') || 'none'})\n`)
  process.stdout.write(`  DEX        : ${formatBytes(dexBytes)}\n`)
  process.stdout.write(`  Resources  : ${formatBytes(resBytes)}\n`)

  const { ndkRoot } = resolveSdkAndNdk()
  const readelf = path.join(ndkRoot, `toolchains/llvm/prebuilt/${ndkHostTag()}/bin/llvm-readelf`)
  const hasReadelf = existsSync(readelf) || existsSync(`${readelf}.exe`)
  if (hasReadelf) {
    const tmpDir = path.join(host.androidRoot, `.build/.bench-elf-${process.pid}`)
    let allAligned = true
    try {
      await mkdir(tmpDir, { recursive: true })
      for (const entry of nativeEntries) {
        const parts = entry.name.split('/')
        const abi = parts[1] ?? ''
        if (abi !== 'arm64-v8a' && abi !== 'x86_64') continue
        const jniCandidate = path.join(host.androidRoot, 'app/src/main/jniLibs', abi, path.basename(entry.name))
        let targetSo: string | null = null
        const stored = readStoredZipEntry(apkBuffer, entry)
        if (stored) {
          targetSo = path.join(tmpDir, `${abi}_${path.basename(entry.name)}`)
          await Bun.write(targetSo, stored)
        } else if (existsSync(jniCandidate)) {
          targetSo = jniCandidate
        }
        if (!targetSo) continue
        const res = await capture(readelf, ['-l', '--wide', targetSo])
        if (!res.ok) continue
        const loadLines = res.output.split(/\r?\n/).filter((l) => /^\s*LOAD\s+/.test(l))
        const bad = loadLines.find((l) => {
          const cols = l.trim().split(/\s+/)
          const align = Number(cols[cols.length - 1] || '')
          return !Number.isFinite(align) || align < 0x4000
        })
        if (loadLines.length === 0 || bad) {
          allAligned = false
          process.stdout.write(`  ✗ 16KB align: ${entry.name} FAILED (${bad?.trim() ?? 'no LOAD'})\n`)
        }
      }
      if (allAligned) {
        process.stdout.write('  ✓ 16KB ELF LOAD alignment: verified (>= 0x4000)\n')
      }
    } finally {
      await rm(tmpDir, { recursive: true, force: true })
    }
  } else {
    process.stdout.write('  ! 16KB align: skipped (llvm-readelf not found)\n')
  }

  const serial = await resolveBenchSerial(parsed.positional[0])
  if (!serial) {
    process.stdout.write('Device: none connected (pass ADB_SERIAL to compare installed APK SHA-256 and measure frame latency)\n')
    return
  }

  process.stdout.write(`Device (${serial}):\n`)
  const pmPath = await capture('adb', ['-s', serial, 'shell', 'pm', 'path', appId])
  const remoteApk = pmPath.output.split(/\r?\n/).find((l) => l.startsWith('package:'))?.slice('package:'.length).trim()
  if (!pmPath.ok || !remoteApk) {
    process.stdout.write(`  ! Installed APK: ${appId} is not installed on ${serial}\n`)
  } else {
    const remoteHashRes = await capture('adb', ['-s', serial, 'shell', 'sha256sum', remoteApk])
    const remoteHash = remoteHashRes.output.split(/\s+/)[0] ?? ''
    if (remoteHash === apkSha256) {
      process.stdout.write(`  ✓ Installed APK matches local SHA-256 (${apkSha256.slice(0, 12)})\n`)
    } else {
      process.stdout.write(`  ! Installed APK differs (device=${remoteHash.slice(0, 12) || 'unknown'}, local=${apkSha256.slice(0, 12)})\n`)
    }
  }

  const sfList = await capture('adb', ['-s', serial, 'shell', 'dumpsys', 'SurfaceFlinger', '--list'])
  const candidates = extractCandidateSurfaceLayers(sfList.ok ? sfList.output : '', appId)
  let chosenLayer = candidates[0] ?? `SurfaceView[${appId}/dev.gpui.mobile.GpuiActivity]#0`
  let refreshNs = 0
  let frameIntervalsMs: number[] = []
  for (const candidate of candidates) {
    const latencyRes = await capture('adb', ['-s', serial, 'shell', 'dumpsys', 'SurfaceFlinger', '--latency', candidate])
    if (!latencyRes.ok) continue
    const parsedLatency = parseSurfaceFlingerLatency(latencyRes.output)
    if (parsedLatency.intervals.length > 0) {
      chosenLayer = candidate
      refreshNs = parsedLatency.refreshNs
      frameIntervalsMs = parsedLatency.intervals
      break
    }
  }
  if (frameIntervalsMs.length > 0) {
    const p50 = percentile(frameIntervalsMs, 50)
    const p99 = percentile(frameIntervalsMs, 99)
    const refreshHz = refreshNs > 0 ? Math.round(1e9 / refreshNs) : 0
    const avgMs = frameIntervalsMs.reduce((acc, v) => acc + v, 0) / frameIntervalsMs.length
    process.stdout.write(
      `  ✓ Frame latency (${chosenLayer}): N=${frameIntervalsMs.length}, P50=${p50.toFixed(2)} ms, P99=${p99.toFixed(2)} ms, est=${(1000 / avgMs).toFixed(1)} fps${refreshHz ? ` (panel ${refreshHz} Hz)` : ''}\n`,
    )
  } else {
    process.stdout.write(`  ! Frame latency: no active SurfaceFlinger frame samples for "${chosenLayer}" (keep app open & scroll briefly before running bench)\n`)
  }
}

async function cacheCommand(parsed: ParsedArgs, projectRoot: string): Promise<void> {
  const action = parsed.positional[0] ?? 'status'
  if (parsed.positional.length > 1 || (action !== 'status' && action !== 'clean')) {
    fail('usage: gpuix cache [status|clean] [--cwd DIR] [--all]')
  }
  const cacheRoot = sharedCacheDir()
  if (action === 'status') {
    if (hasFlag(parsed, 'all')) fail('--all is only valid with `gpuix cache clean`')
    const buckets = ['deps', 'hermes', 'cargo-target', 'native'] as const
    const total = await dirSizeBytes(cacheRoot)
    process.stdout.write(`Shared cache: ${cacheRoot} (${formatBytes(total)})\n`)
    for (const bucket of buckets) {
      const size = await dirSizeBytes(path.join(cacheRoot, bucket))
      process.stdout.write(`  - ${bucket.padEnd(13)} ${formatBytes(size)}\n`)
    }
    const androidRoot = path.join(projectRoot, 'android')
    if (await exists(androidRoot)) {
      const redundant: Array<{ label: string; size: number }> = []
      for (const candidate of redundantLocalTargetDirs(projectRoot)) {
        const size = await dirSizeBytes(candidate)
        if (size > 0) {
          redundant.push({ label: path.relative(projectRoot, candidate), size })
        }
      }
      const localTarget = path.join(androidRoot, 'target')
      const localTargetSize = await dirSizeBytes(localTarget)
      if (localTargetSize > 0) {
        redundant.push({ label: path.relative(projectRoot, localTarget), size: localTargetSize })
      }
      if (redundant.length > 0) {
        process.stdout.write(`Local build targets in ${projectRoot}:\n`)
        for (const item of redundant) {
          process.stdout.write(`  - ${item.label}: ${formatBytes(item.size)}\n`)
        }
      } else {
        process.stdout.write(`Local workspace (${projectRoot}): clean (no split targets)\n`)
      }
    }
    return
  }

  let reclaimed = 0
  for (const candidate of redundantLocalTargetDirs(projectRoot)) {
    try {
      const st = await lstat(candidate)
      if (!st.isSymbolicLink() && st.isDirectory()) {
        const size = await dirSizeBytes(candidate)
        await rm(candidate, { recursive: true, force: true })
        reclaimed += size
        process.stdout.write(`Removed ${path.relative(projectRoot, candidate)} (${formatBytes(size)})\n`)
      }
    } catch {
      // Ignore missing directories
    }
  }

  if (hasFlag(parsed, 'all')) {
    const size = await dirSizeBytes(cacheRoot)
    if (size > 0 || (await exists(cacheRoot))) {
      await rm(cacheRoot, { recursive: true, force: true })
      reclaimed += size
      process.stdout.write(`Removed shared cache ${cacheRoot} (${formatBytes(size)})\n`)
    }
  } else {
    const staleDebug = path.join(cacheRoot, 'cargo-target/aarch64-linux-android/debug')
    const staleDebugSize = await dirSizeBytes(staleDebug)
    if (staleDebugSize > 0) {
      await rm(staleDebug, { recursive: true, force: true })
      reclaimed += staleDebugSize
      process.stdout.write(`Removed stale shared debug target (${formatBytes(staleDebugSize)})\n`)
    }
    const nativeDir = path.join(cacheRoot, 'native')
    if (await exists(nativeDir)) {
      const keepRaw = Number(process.env.GPUIX_NATIVE_CACHE_KEEP ?? '8')
      const keep = Number.isSafeInteger(keepRaw) && keepRaw >= 0 ? keepRaw : 8
      const entries = await readdir(nativeDir, { withFileTypes: true })
      const dirs: Array<{ p: string; mtime: number }> = []
      for (const entry of entries) {
        if (!entry.isDirectory()) continue
        const p = path.join(nativeDir, entry.name)
        const so = path.join(p, 'libgpuix_android.so')
        const st = await stat(existsSync(so) ? so : p)
        dirs.push({ p, mtime: st.mtimeMs })
      }
      dirs.sort((a, b) => b.mtime - a.mtime)
      for (const old of dirs.slice(keep)) {
        const size = await dirSizeBytes(old.p)
        await rm(old.p, { recursive: true, force: true })
        reclaimed += size
      }
    }
  }

  process.stdout.write(`Reclaimed ${formatBytes(reclaimed)}\n`)
}

async function main(): Promise<void> {
  const [command, ...rawArgs] = process.argv.slice(2)
  if (!command || command === 'help' || command === '--help' || command === '-h') {
    process.stdout.write(`${usage()}\n`)
    return
  }
  if (command === 'version' || command === '--version' || command === '-v') {
    process.stdout.write(`gpuix-mobile v${await packageVersion()}\n`)
    return
  }
  if (command === 'ota') {
    await runOtaCommand(rawArgs, process.cwd())
    return
  }
  const parsed = parseArgs(rawArgs)
  if (hasFlag(parsed, 'help')) {
    process.stdout.write(`${usage()}\n`)
    return
  }
  const projectRoot = path.resolve(option(parsed, 'cwd') ?? process.cwd())
  if (command === 'create') {
    await create(parsed)
    return
  }
  if (command === 'init') {
    assertKnownOptions(
      parsed,
      ['cwd', 'entry', 'entrypoint', 'app-id', 'name', 'app-name', 'version', 'version-name', 'version-code'],
      ['eject'],
    )
    if (parsed.positional.length > 0) fail('init does not accept positional arguments')
    await init(parsed, projectRoot)
    return
  }
  if (command === 'eject') {
    assertKnownOptions(parsed, ['cwd'], [])
    if (parsed.positional.length > 0) fail('eject does not accept positional arguments')
    await ejectHost(projectRoot)
    return
  }
  if (command === 'doctor') {
    assertKnownOptions(parsed, ['cwd'])
    if (parsed.positional.length > 0) fail('doctor does not accept positional arguments')
    await doctor(projectRoot)
    return
  }
  if (command === 'info') {
    assertKnownOptions(parsed, ['cwd'])
    if (parsed.positional.length > 0) fail('info does not accept positional arguments')
    await info(projectRoot)
    return
  }
  if (command === 'build') {
    assertKnownOptions(parsed, ['cwd', 'entry'], ['release', 'aab', 'fast', 'js-only', 'no-hbc'])
    await build(parsed, projectRoot)
    return
  }
  if (command === 'install') {
    assertKnownOptions(parsed, ['cwd'], ['release'])
    await install(parsed, projectRoot)
    return
  }
  if (command === 'run') {
    assertKnownOptions(parsed, ['cwd', 'device', 'entry'], ['release', 'fast', 'js-only', 'no-hbc'])
    await runTarget(parsed, projectRoot)
    return
  }
  if (command === 'bench') {
    assertKnownOptions(parsed, ['cwd'], ['release'])
    await bench(parsed, projectRoot)
    return
  }
  if (command === 'cache') {
    assertKnownOptions(parsed, ['cwd'], ['all'])
    await cacheCommand(parsed, projectRoot)
    return
  }
  if (command === 'dev') {
    assertKnownOptions(parsed, ['cwd', 'port'], ['logcat'])
    if (parsed.positional.length > 1) fail('dev accepts at most one ADB serial')
    const rawPort = option(parsed, 'port') ?? '8081'
    const port = Number(rawPort)
    if (!Number.isSafeInteger(port) || port < 1 || port > 65535) {
      fail(`invalid --port value: ${rawPort}`)
    }
    await resolveAndroidHost(projectRoot)
    await runDevServer({
      projectRoot,
      serial: parsed.positional[0],
      port,
      logcat: hasFlag(parsed, 'logcat'),
    })
    return
  }
  fail(`unknown command ${command}`)
}

if (import.meta.main) {
  try {
    await main()
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    process.stderr.write(`${message}\n`)
    process.exitCode = 1
  }
}
