#!/usr/bin/env bun

import path from 'node:path'
import { homedir } from 'node:os'
import { cp, lstat, mkdir } from 'node:fs/promises'
import { loadGpuixAndroidConfig } from '../android/scripts/config'

type ParsedArgs = {
  values: Map<string, string>
  flags: Set<string>
  positional: string[]
}

const packageRoot = path.resolve(import.meta.dir, '..')
const nativeCli = path.join(packageRoot, 'scripts/gpuix-android.ts')
const starterRoot = path.join(packageRoot, 'templates/react-gpui')
const booleanOptions = new Set(['aab', 'help', 'release'])

function usage(): string {
  return `gpuix — React + GPUIX native project toolchain (no WebView)

Usage:
  gpuix create DIR [--app-id ID] [--name APP_NAME] [--version VERSION] [--version-code N]
  gpuix init [--cwd DIR] [--entry FILE] [--app-id ID] [--name APP_NAME]
  gpuix doctor [--cwd DIR]
  gpuix info [--cwd DIR]
  gpuix build [--cwd DIR] [--release] [--aab]
  gpuix install ADB_SERIAL [--cwd DIR] [--release]
  gpuix run ADB_SERIAL [--cwd DIR] [--release]

Artifacts:
  debug build  dist/android/<project>-debug.apk
  release build dist/android/<project>-release.apk
  --aab       dist/android/<project>-release.aab

The Android host is GPUI + wgpu with standalone Hermes. It does not use
WebView or React Native's view system.`
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
    return typeof manifest.version === 'string' && manifest.version.length > 0 ? manifest.version : '0.1.0'
  } catch {
    return '0.1.0'
  }
}

async function run(command: string, args: string[], cwd: string): Promise<void> {
  const child = Bun.spawn([command, ...args], {
    cwd,
    stdin: 'inherit',
    stdout: 'inherit',
    stderr: 'inherit',
  })
  const exitCode = await child.exited
  if (exitCode !== 0) fail(`${command} exited with status ${exitCode}`)
}

async function capture(command: string, args: string[], cwd = process.cwd()): Promise<{ ok: boolean; output: string }> {
  try {
    const child = Bun.spawn([command, ...args], { cwd, stdout: 'pipe', stderr: 'pipe' })
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

async function requireHost(projectRoot: string): Promise<void> {
  const buildScript = path.join(projectRoot, 'android/scripts/build-android.sh')
  if (!(await exists(buildScript))) {
    fail(`no Android host at ${path.join(projectRoot, 'android')}; run gpuix init first`)
  }
}

async function init(parsed: ParsedArgs, projectRoot: string): Promise<void> {
  await run('bun', [nativeCli, 'init', '--cwd', projectRoot, ...forwardInitArgs(parsed)], packageRoot)
}

function forwardInitArgs(parsed: ParsedArgs): string[] {
  const args: string[] = []
  for (const [key, value] of parsed.values) {
    if (key === 'cwd') continue
    args.push(`--${key}`, value)
  }
  return args
}

async function create(parsed: ParsedArgs): Promise<void> {
  if (parsed.positional.length !== 1) fail('create needs exactly one target directory')
  const parent = path.resolve(option(parsed, 'cwd') ?? process.cwd())
  const projectRoot = path.resolve(parent, parsed.positional[0])
  if (await exists(projectRoot)) fail(`${projectRoot} already exists; refusing to overwrite it`)
  assertKnownOptions(parsed, ['cwd', 'app-id', 'name', 'app-name', 'version', 'version-name', 'version-code'])

  const appId = option(parsed, 'app-id') ?? `dev.gpuix.${appIdSuffix(projectRoot)}`
  if (!/^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)+$/.test(appId)) {
    fail('--app-id must be a dotted Android package id, for example com.example.myapp')
  }
  const appName = (option(parsed, 'name', 'app-name') ?? defaultAppName(projectRoot)).trim()
  if (!appName || /[\r\n\0]/.test(appName)) fail('--name must be a non-empty single-line string')
  const versionName = (option(parsed, 'version', 'version-name') ?? '0.1.0').trim()
  if (!versionName || /[\r\n\0]/.test(versionName)) fail('--version must be a non-empty single-line string')
  const versionCode = Number(option(parsed, 'version-code') ?? '1')
  if (!Number.isSafeInteger(versionCode) || versionCode < 1) fail('--version-code must be a positive integer')
  if (!(await exists(starterRoot))) fail(`starter template is missing at ${starterRoot}`)

  await mkdir(projectRoot, { recursive: true })
  await cp(starterRoot, projectRoot, { recursive: true })
  const manifestPath = path.join(projectRoot, 'package.json')
  const manifest = (await Bun.file(manifestPath).text())
    .replaceAll('__PROJECT_NAME__', packageSlug(projectRoot))
    .replaceAll('__GPUX_BASE_UI_VERSION__', '0.1.0')
    .replaceAll('__GPUIX_ANDROID_VERSION__', await packageVersion())
  await Bun.write(manifestPath, manifest)
  await run('bun', [nativeCli, 'init', '--cwd', projectRoot, '--entry', 'src/main.tsx', '--app-id', appId, '--name', appName], packageRoot)
  const configPath = path.join(projectRoot, 'gpuix.android.json')
  const config = JSON.parse(await Bun.file(configPath).text()) as Record<string, unknown>
  config.versionName = versionName
  config.versionCode = versionCode
  await Bun.write(configPath, `${JSON.stringify(config, null, 2)}\n`)
  process.stdout.write(`Created GPUIX project in ${projectRoot}\n`)
  process.stdout.write('Next:\n  cd ' + projectRoot + '\n  bun install\n  bun run gpuix:doctor\n  bun run gpuix:run -- ADB_SERIAL\n')
}

async function doctor(projectRoot: string): Promise<void> {
  const checks: Array<[string, string, string[]]> = [
    ['Bun', 'bun', ['--version']],
    ['Rust', 'rustc', ['--version']],
    ['Cargo NDK', 'cargo', ['ndk', '--version']],
    ['Android SDK', 'adb', ['version']],
    ['Java', 'java', ['-version']],
  ]
  let failures = 0
  process.stdout.write(`GPUIX doctor · ${projectRoot}\n`)
  for (const [label, command, args] of checks) {
    const result = await capture(command, args, projectRoot)
    if (result.ok) {
      process.stdout.write(`✓ ${label}: ${result.output.split('\n')[0]}\n`)
    } else {
      failures += 1
      process.stdout.write(`✗ ${label}: ${result.output.split('\n')[0] || 'not available'}\n`)
    }
  }
  const sdkRoot = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT || path.join(homedir(), 'Library/Android/sdk')
  const sdkAvailable = await exists(sdkRoot)
  if (!sdkAvailable) failures += 1
  process.stdout.write(`${sdkAvailable ? '✓' : '✗'} ANDROID_HOME: ${sdkRoot}\n`)
  const ndkRoot = process.env.ANDROID_NDK_ROOT || path.join(sdkRoot, 'ndk/28.2.13676358')
  const ndkAvailable = await exists(ndkRoot)
  if (!ndkAvailable) failures += 1
  process.stdout.write(`${ndkAvailable ? '✓' : '✗'} Android NDK: ${ndkRoot}\n`)
  if (await exists(path.join(projectRoot, 'android'))) {
    try {
      const config = await loadGpuixAndroidConfig(projectRoot)
      process.stdout.write(`✓ config: ${config.appId} · ${config.entrypoint} · v${config.versionName} (${config.versionCode})\n`)
    } catch (error) {
      failures += 1
      process.stdout.write(`✗ config: ${error instanceof Error ? error.message : String(error)}\n`)
    }
  } else {
    process.stdout.write('! config: no Android host yet; run gpuix init\n')
  }
  const adb = await capture('adb', ['devices'], projectRoot)
  const connected = adb.output.split('\n').some((line) => /\tdevice$/.test(line))
  process.stdout.write(`${connected ? '✓' : '!'} adb device: ${connected ? 'connected' : 'none (optional until install)'}\n`)
  if (failures > 0) fail(`${failures} required checks failed`)
}

async function info(projectRoot: string): Promise<void> {
  await requireHost(projectRoot)
  const config = await loadGpuixAndroidConfig(projectRoot)
  const artifactStem = packageSlug(projectRoot)
  process.stdout.write(JSON.stringify({
    projectRoot,
    entrypoint: config.entrypoint,
    appId: config.appId,
    appName: config.appName,
    versionName: config.versionName,
    versionCode: config.versionCode,
    renderer: 'GPUI + wgpu',
    javascript: 'standalone Hermes',
    webView: false,
    reactNativeViews: false,
    artifacts: {
      debugApk: path.join(projectRoot, `dist/android/${artifactStem}-debug.apk`),
      releaseApk: path.join(projectRoot, `dist/android/${artifactStem}-release.apk`),
      releaseAab: path.join(projectRoot, `dist/android/${artifactStem}-release.aab`),
    },
  }, null, 2) + '\n')
}

async function build(parsed: ParsedArgs, projectRoot: string): Promise<void> {
  await requireHost(projectRoot)
  const args: string[] = []
  if (hasFlag(parsed, 'release')) args.push('--release')
  if (hasFlag(parsed, 'aab')) args.push('--aab')
  await run('bash', ['android/scripts/build-android.sh', ...args], projectRoot)
}

async function install(parsed: ParsedArgs, projectRoot: string): Promise<void> {
  const serial = parsed.positional[0]
  if (!serial || parsed.positional.length !== 1) fail('install needs exactly one ADB serial')
  if (hasFlag(parsed, 'aab')) fail('an AAB cannot be installed directly; build an APK for adb')
  await requireHost(projectRoot)
  await run('bash', ['android/scripts/install-android.sh', serial, ...(hasFlag(parsed, 'release') ? ['--release'] : [])], projectRoot)
}

async function main(): Promise<void> {
  const [command, ...rawArgs] = process.argv.slice(2)
  if (!command || command === 'help' || command === '--help' || command === '-h') {
    process.stdout.write(`${usage()}\n`)
    return
  }
  const parsed = parseArgs(rawArgs)
  const projectRoot = path.resolve(option(parsed, 'cwd') ?? process.cwd())
  if (command === 'create') {
    await create(parsed)
    return
  }
  if (command === 'init') {
    assertKnownOptions(parsed, ['cwd', 'entry', 'entrypoint', 'app-id', 'name', 'app-name'])
    if (parsed.positional.length > 0) fail('init does not accept positional arguments')
    await init(parsed, projectRoot)
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
    assertKnownOptions(parsed, ['cwd'], ['release', 'aab'])
    if (parsed.positional.length > 0) fail('build does not accept positional arguments')
    await build(parsed, projectRoot)
    return
  }
  if (command === 'install') {
    assertKnownOptions(parsed, ['cwd'], ['release'])
    await install(parsed, projectRoot)
    return
  }
  if (command === 'run') {
    assertKnownOptions(parsed, ['cwd'], ['release'])
    if (parsed.positional.length !== 1) fail('run needs exactly one ADB serial')
    await build(parsed, projectRoot)
    await install(parsed, projectRoot)
    return
  }
  fail(`unknown command ${command}`)
}

try {
  await main()
} catch (error) {
  const message = error instanceof Error ? error.message : String(error)
  process.stderr.write(`${message}\n`)
  process.exitCode = 1
}
