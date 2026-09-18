#!/usr/bin/env bun

import path from 'node:path'
import { cp, chmod, lstat } from 'node:fs/promises'

type InitOptions = {
  cwd: string
  entrypoint?: string
  appId?: string
  appName?: string
}

type ParsedArgs = {
  values: Map<string, string>
  positional: string[]
}

const packageRoot = path.resolve(import.meta.dir, '..')
const templateRoot = path.join(packageRoot, 'android')

function usage(): string {
  return `gpuix-android — legacy Android host command (use gpuix for the full toolchain)

Usage:
  gpuix-android init [--cwd DIR] [--entry FILE] [--app-id ID] [--name APP_NAME]
  gpuix-android build [--cwd DIR]
  gpuix-android install <ADB_SERIAL> [--cwd DIR]

init copies the native host template and writes gpuix.android.json. It refuses to
overwrite an existing android/ directory or configuration file.`
}

function fail(message: string): never {
  throw new Error(`gpuix-android: ${message}`)
}

function parseArgs(args: string[]): ParsedArgs {
  const values = new Map<string, string>()
  const positional: string[] = []
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (!arg.startsWith('--')) {
      positional.push(arg)
      continue
    }
    const equals = arg.indexOf('=')
    const key = equals === -1 ? arg.slice(2) : arg.slice(2, equals)
    const value = equals === -1 ? args[index + 1] : arg.slice(equals + 1)
    if (!key || !value || value.startsWith('--')) fail(`${arg} needs a value`)
    if (equals === -1) index += 1
    values.set(key, value)
  }
  return { values, positional }
}

function option(parsed: ParsedArgs, ...names: string[]): string | undefined {
  for (const name of names) {
    const value = parsed.values.get(name)
    if (value !== undefined) return value
  }
  return undefined
}

function assertKnownOptions(parsed: ParsedArgs, allowed: string[]): void {
  for (const key of parsed.values.keys()) {
    if (!allowed.includes(key)) fail(`unknown option --${key}`)
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

async function discoverEntrypoint(projectRoot: string): Promise<string | undefined> {
  for (const candidate of ['playground.tsx', 'src/main.tsx', 'src/index.tsx', 'index.tsx']) {
    if (await exists(path.join(projectRoot, candidate))) return candidate
  }
  return undefined
}

function excludedTemplatePath(relativePath: string): boolean {
  const normalized = relativePath.split(path.sep).join('/')
  return [
    '.deps',
    '.build',
    '.gradle',
    'target',
    'build',
    'app/build',
    'app/src/main/jniLibs',
  ].some((excluded) => normalized === excluded || normalized.startsWith(`${excluded}/`))
}

async function copyTemplate(targetAndroidRoot: string): Promise<void> {
  if (!(await exists(templateRoot))) {
    fail(`the packaged Android template is missing at ${templateRoot}`)
  }
  await cp(templateRoot, targetAndroidRoot, {
    recursive: true,
    filter(source) {
      return !excludedTemplatePath(path.relative(templateRoot, source))
    },
  })
  await Promise.all([
    chmod(path.join(targetAndroidRoot, 'gradlew'), 0o755),
    chmod(path.join(targetAndroidRoot, 'scripts/build-android.sh'), 0o755),
    chmod(path.join(targetAndroidRoot, 'scripts/build-hermes.sh'), 0o755),
    chmod(path.join(targetAndroidRoot, 'scripts/install-android.sh'), 0o755),
  ])
}

async function init(options: InitOptions): Promise<void> {
  const projectRoot = path.resolve(options.cwd)
  const androidRoot = path.join(projectRoot, 'android')
  const configPath = path.join(projectRoot, 'gpuix.android.json')
  if (await exists(androidRoot)) fail(`${androidRoot} already exists; refusing to overwrite it`)
  if (await exists(configPath)) fail(`${configPath} already exists; refusing to overwrite it`)

  const discoveredEntrypoint = options.entrypoint ?? await discoverEntrypoint(projectRoot)
  if (!discoveredEntrypoint) {
    fail('could not find an entry point; pass --entry path/to/app.tsx')
  }
  const entrypoint = relativeEntrypoint(projectRoot, discoveredEntrypoint)
  if (!(await exists(path.join(projectRoot, entrypoint)))) {
    fail(`entry point does not exist: ${entrypoint}. Pass --entry path/to/app.tsx`)
  }
  const appId = options.appId ?? `dev.gpuix.${appIdSuffix(projectRoot)}`
  if (!/^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)+$/.test(appId)) {
    fail('--app-id must be a dotted Android package id, for example com.example.myapp')
  }
  const appName = (options.appName ?? defaultAppName(projectRoot)).trim()
  if (!appName || /[\r\n\0]/.test(appName)) fail('--name must be a non-empty single-line string')

  await copyTemplate(androidRoot)
  await Bun.write(
    configPath,
    `${JSON.stringify({ entrypoint, appId, appName, versionName: '0.1.0', versionCode: 1 }, null, 2)}\n`,
  )
  process.stdout.write(
    `Created Android host in ${androidRoot}\n` +
    `Config: ${configPath}\n` +
    `Next: gpuix build --cwd ${projectRoot}\n`,
  )
}

async function requireHost(projectRoot: string): Promise<void> {
  const buildScript = path.join(projectRoot, 'android/scripts/build-android.sh')
  if (!(await exists(buildScript))) {
    fail(`no Android host at ${path.join(projectRoot, 'android')}; run gpuix-android init first`)
  }
}

async function run(command: string, args: string[], cwd: string): Promise<void> {
  const processHandle = Bun.spawn([command, ...args], {
    cwd,
    stdin: 'inherit',
    stdout: 'inherit',
    stderr: 'inherit',
  })
  const exitCode = await processHandle.exited
  if (exitCode !== 0) fail(`${command} exited with status ${exitCode}`)
}

async function main(): Promise<void> {
  const [command, ...rawArgs] = process.argv.slice(2)
  if (!command || command === '--help' || command === '-h' || command === 'help') {
    process.stdout.write(`${usage()}\n`)
    return
  }

  const parsed = parseArgs(rawArgs)
  const cwd = path.resolve(option(parsed, 'cwd') ?? process.cwd())
  if (command === 'init') {
    assertKnownOptions(parsed, ['cwd', 'entry', 'entrypoint', 'app-id', 'name', 'app-name'])
    if (parsed.positional.length > 0) fail('init does not accept positional arguments')
    await init({
      cwd,
      entrypoint: option(parsed, 'entry', 'entrypoint'),
      appId: option(parsed, 'app-id'),
      appName: option(parsed, 'name', 'app-name'),
    })
    return
  }

  assertKnownOptions(parsed, ['cwd', 'serial'])
  await requireHost(cwd)
  if (command === 'build') {
    if (parsed.positional.length > 0) fail('build does not accept positional arguments')
    await run('bash', ['android/scripts/build-android.sh'], cwd)
    return
  }
  if (command === 'install') {
    const serial = option(parsed, 'serial') ?? parsed.positional[0]
    if (!serial || parsed.positional.length > 1) fail('install needs exactly one ADB serial')
    await run('bash', ['android/scripts/install-android.sh', serial], cwd)
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
