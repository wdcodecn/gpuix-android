import path from 'node:path'
import { mkdir } from 'node:fs/promises'

export type GpuixAndroidConfig = {
  /** Project-relative React entry point compiled for the standalone Hermes host. */
  entrypoint: string
  /** Android application id, for example `com.example.myapp`. */
  appId: string
  /** User-visible Android application name. */
  appName: string
  /** Semver-like Android version name shown to users. */
  versionName: string
  /** Monotonically increasing Android version code for release artifacts. */
  versionCode: number
}

const legacyDemoDefaults: GpuixAndroidConfig = {
  entrypoint: 'src/main.tsx',
  appId: 'dev.gpuix.app',
  appName: 'GPUIX App',
  versionName: '0.1.0',
  versionCode: 1,
}

const appIdPattern = /^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)+$/

function configError(message: string): never {
  throw new Error(`gpuix.android.json: ${message}`)
}

function asNonEmptyString(value: unknown, field: keyof GpuixAndroidConfig, fallback: string): string {
  if (value === undefined) return fallback
  if (typeof value !== 'string' || value.trim().length === 0) {
    configError(`${field} must be a non-empty string`)
  }
  return value.trim()
}

function asPositiveInteger(value: unknown, field: keyof GpuixAndroidConfig, fallback: number): number {
  if (value === undefined) return fallback
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    configError(`${field} must be a positive integer`)
  }
  return value
}

function projectRelativePath(projectRoot: string, input: string): string {
  const absolutePath = path.resolve(projectRoot, input)
  const relativePath = path.relative(projectRoot, absolutePath)
  if (
    relativePath.length === 0 ||
    relativePath === '..' ||
    relativePath.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relativePath)
  ) {
    configError('entrypoint must stay inside the project directory')
  }
  return relativePath.split(path.sep).join('/')
}

/**
 * Reads the project-level configuration. The defaults retain the demo's
 * original identity so an existing checkout can still invoke its scripts
 * directly; `gpuix-android init` always writes an explicit config for a new
 * project.
 */
export async function loadGpuixAndroidConfig(projectRoot: string): Promise<GpuixAndroidConfig> {
  const root = path.resolve(projectRoot)
  const configPath = path.join(root, 'gpuix.android.json')
  let raw: Record<string, unknown> = {}

  if (await Bun.file(configPath).exists()) {
    try {
      const parsed: unknown = JSON.parse(await Bun.file(configPath).text())
      if (parsed === null || Array.isArray(parsed) || typeof parsed !== 'object') {
        configError('must contain a JSON object')
      }
      raw = parsed as Record<string, unknown>
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('gpuix.android.json:')) throw error
      const detail = error instanceof Error ? error.message : String(error)
      configError(`is not valid JSON (${detail})`)
    }
  }

  const entrypointInput = asNonEmptyString(raw.entrypoint, 'entrypoint', legacyDemoDefaults.entrypoint)
  const config: GpuixAndroidConfig = {
    entrypoint: projectRelativePath(root, entrypointInput),
    appId: asNonEmptyString(raw.appId, 'appId', legacyDemoDefaults.appId),
    appName: asNonEmptyString(raw.appName, 'appName', legacyDemoDefaults.appName),
    versionName: asNonEmptyString(raw.versionName, 'versionName', legacyDemoDefaults.versionName),
    versionCode: asPositiveInteger(raw.versionCode, 'versionCode', legacyDemoDefaults.versionCode),
  }

  if (!appIdPattern.test(config.appId)) {
    configError('appId must be a dotted Android package id, for example com.example.myapp')
  }
  if (/[\r\n\0]/.test(config.appName)) {
    configError('appName cannot contain a line break or NUL character')
  }

  const entrypointPath = path.join(root, config.entrypoint)
  if (!(await Bun.file(entrypointPath).exists())) {
    configError(`entrypoint does not exist: ${config.entrypoint}`)
  }
  return config
}

function escapeProperty(value: string): string {
  return value
    .replaceAll('\\', '\\\\')
    .replaceAll('\r', '\\r')
    .replaceAll('\n', '\\n')
    .replace(/([:=#!])/g, '\\$1')
}

/** Writes the small Gradle-only projection of the canonical JSON config. */
export async function writeGradleProperties(projectRoot: string, config: GpuixAndroidConfig): Promise<string> {
  const outputPath = path.join(projectRoot, 'android/.build/gpuix.android.properties')
  await mkdir(path.dirname(outputPath), { recursive: true })
  await Bun.write(
    outputPath,
    [
      '# Generated from gpuix.android.json. Do not edit.',
      `appId=${escapeProperty(config.appId)}`,
      `appName=${escapeProperty(config.appName)}`,
      `versionName=${escapeProperty(config.versionName)}`,
      `versionCode=${config.versionCode}`,
      '',
    ].join('\n'),
  )
  return outputPath
}

function valueAfter(flag: string, args: string[]): string | undefined {
  const index = args.indexOf(flag)
  if (index === -1) return undefined
  const value = args[index + 1]
  if (!value || value.startsWith('--')) throw new Error(`${flag} needs a value`)
  return value
}

if (import.meta.main) {
  const args = process.argv.slice(2)
  const field = valueAfter('--field', args)
  const projectRoot = valueAfter('--project', args) ?? path.resolve(import.meta.dir, '../..')
  if (!field || !['entrypoint', 'appId', 'appName', 'versionName', 'versionCode'].includes(field)) {
    throw new Error('Usage: bun config.ts --field entrypoint|appId|appName|versionName|versionCode [--project PROJECT_ROOT]')
  }
  const config = await loadGpuixAndroidConfig(projectRoot)
  process.stdout.write(`${config[field as keyof GpuixAndroidConfig]}\n`)
}
