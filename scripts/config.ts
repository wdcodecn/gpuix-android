import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, rename, rm } from 'node:fs/promises'

export type GpuixOtaCheckPolicy = 'manual' | 'background' | 'immediate'
export type GpuixStatusBarStyle = 'light' | 'dark'

export type GpuixOtaConfig = {
  /** Remote manifest JSON URL (GitHub Releases, R2, S3, OSS, Nginx, or local dev server). */
  manifestUrl?: string
  /** Release channel name, e.g. `production`, `staging`, `beta`. */
  channel: string
  /** Binary compatibility runtime version. Defaults to `String(versionCode)`. */
  runtimeVersion: string
  /** Base64-encoded SPKI ECDSA P-256 public key for verifying OTA bundle signatures. */
  publicKey?: string
  /** Automatic OTA check strategy on launch: `manual` | `background` | `immediate`. */
  checkOnLaunch: GpuixOtaCheckPolicy
}

export type GpuixAndroidPlatformConfig = {
  /** Optional Android-specific applicationId overriding top-level `appId`. */
  applicationId?: string
  /** Optional Android ABIs to package (e.g. `["arm64-v8a"]` or `["arm64-v8a", "armeabi-v7a"]`). */
  abis?: string[]
  /** Optional trimmed list of Android permissions (always preserves `INTERNET`). */
  permissions?: string[]
}

export type GpuixIosPlatformConfig = {
  /** Optional iOS-specific bundle identifier overriding top-level `appId`. */
  bundleId?: string
  /** Optional iOS CFBundleVersion overriding `String(versionCode)`. */
  buildNumber?: string
  /** Minimum iOS deployment target (default `"17.0"`). */
  deploymentTarget?: string
  /** Status bar foreground content style (default `"light"`). */
  statusBarStyle?: GpuixStatusBarStyle
}

export type GpuixConfig = {
  /** Project-relative React entry point compiled for the standalone Hermes host. */
  entrypoint: string
  /** Default reverse-DNS application id, e.g. `com.example.myapp`. */
  appId: string
  /** User-visible application display name. */
  appName: string
  /** Semver-like version name shown to users, e.g. `1.1.1` or `2.7.0`. */
  versionName: string
  /** Monotonically increasing integer build/version code for release artifacts. */
  versionCode: number
  /** Optional native Cargo features to enable (e.g. `["http-client", "rich-content"]`). */
  features?: string[]
  /** Top-level Android ABIs fallback (prefer `android.abis` in `gpuix.config.json`). */
  abis?: string[]
  /** Top-level Android permissions fallback (prefer `android.permissions` in `gpuix.config.json`). */
  permissions?: string[]
  /** Android-specific overrides. */
  android?: GpuixAndroidPlatformConfig
  /** iOS-specific overrides. */
  ios?: GpuixIosPlatformConfig
  /** Optional Over-The-Air JS/HBC hot-update configuration. */
  ota?: GpuixOtaConfig
}

/** Backward-compatible type alias for existing consumers. */
export type GpuixAndroidConfig = GpuixConfig

export const CONFIG_FILENAMES = ['gpuix.config.json', 'gpuix.android.json'] as const
export type GpuixConfigFilename = (typeof CONFIG_FILENAMES)[number]

const legacyDemoDefaults: GpuixConfig = {
  entrypoint: 'src/main.tsx',
  appId: 'dev.gpuix.app',
  appName: 'GPUIX App',
  versionName: '1.0.0',
  versionCode: 1,
}

const appIdPattern = /^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)+$/
const iosBundleIdPattern = /^[A-Za-z][A-Za-z0-9_-]*(?:\.[A-Za-z][A-Za-z0-9_-]*)+$/
const channelPattern = /^[A-Za-z0-9._-]{1,64}$/
const allowedOtaPolicies = new Set<GpuixOtaCheckPolicy>(['manual', 'background', 'immediate'])
const allowedFeatures = new Set(['http-client', 'rich-content'])
const allowedAbis = new Set(['arm64-v8a', 'armeabi-v7a'])
const permissionNamePattern = /^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z0-9_]+)*$/

export function resolveConfigFile(projectRoot: string): { path: string; filename: GpuixConfigFilename } | null {
  const root = path.resolve(projectRoot)
  for (const filename of CONFIG_FILENAMES) {
    const candidate = path.join(root, filename)
    if (existsSync(candidate)) {
      return { path: candidate, filename }
    }
  }
  return null
}

function configError(sourceLabel: string, message: string): never {
  throw new Error(`${sourceLabel}: ${message}`)
}

function asNonEmptyString(value: unknown, field: string, fallback: string, sourceLabel: string): string {
  if (value === undefined) return fallback
  if (typeof value !== 'string' || value.trim().length === 0) {
    configError(sourceLabel, `${field} must be a non-empty string`)
  }
  return value.trim()
}

function asOptionalNonEmptyString(value: unknown, field: string, sourceLabel: string): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string' || value.trim().length === 0) {
    configError(sourceLabel, `${field} must be a non-empty string`)
  }
  return value.trim()
}

function asPositiveInteger(value: unknown, field: keyof GpuixConfig, fallback: number, sourceLabel: string): number {
  if (value === undefined) return fallback
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    configError(sourceLabel, `${field} must be a positive integer`)
  }
  return value
}

function projectRelativePath(projectRoot: string, input: string, sourceLabel: string): string {
  const absolutePath = path.resolve(projectRoot, input)
  const relativePath = path.relative(projectRoot, absolutePath)
  if (
    relativePath.length === 0 ||
    relativePath === '..' ||
    relativePath.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relativePath)
  ) {
    configError(sourceLabel, 'entrypoint must stay inside the project directory')
  }
  return relativePath.split(path.sep).join('/')
}

/**
 * Normalizes an ECDSA SPKI public key (either PEM or raw base64) into single-line base64.
 */
export function normalizeOtaPublicKey(raw: string, sourceLabel = 'gpuix.config.json'): string {
  const stripped = raw
    .replace(/-----BEGIN [^-]+-----/g, '')
    .replace(/-----END [^-]+-----/g, '')
    .replace(/\s+/g, '')
  if (!stripped || !/^[A-Za-z0-9+/]+={0,2}$/.test(stripped) || stripped.length % 4 !== 0) {
    configError(sourceLabel, 'ota.publicKey must be valid base64 or PEM SPKI public key')
  }
  const decoded = Buffer.from(stripped, 'base64')
  if (decoded.length < 32) {
    configError(sourceLabel, 'ota.publicKey decoded length is too short for an ECDSA SPKI key')
  }
  return stripped
}

function parseOtaConfig(
  rawOta: unknown,
  defaultRuntimeVersion: string,
  sourceLabel: string,
): GpuixOtaConfig | undefined {
  const envManifestUrl = process.env.GPUIX_OTA_MANIFEST_URL
  const envChannel = process.env.GPUIX_OTA_CHANNEL
  const envRuntimeVersion = process.env.GPUIX_OTA_RUNTIME_VERSION
  const envPublicKey = process.env.GPUIX_OTA_PUBLIC_KEY

  const hasEnvOverride =
    envManifestUrl !== undefined ||
    envChannel !== undefined ||
    envRuntimeVersion !== undefined ||
    envPublicKey !== undefined

  if (rawOta === undefined && !hasEnvOverride) {
    return undefined
  }

  let obj: Record<string, unknown> = {}
  if (rawOta !== undefined) {
    if (rawOta === null || Array.isArray(rawOta) || typeof rawOta !== 'object') {
      configError(sourceLabel, 'ota must be a JSON object')
    }
    obj = rawOta as Record<string, unknown>
  }

  const rawManifest = envManifestUrl ?? obj.manifestUrl
  let manifestUrl: string | undefined
  if (rawManifest !== undefined) {
    if (typeof rawManifest !== 'string') {
      configError(sourceLabel, 'ota.manifestUrl must be a string')
    }
    const trimmed = rawManifest.trim()
    if (trimmed.length > 0) {
      let parsedUrl: URL
      try {
        parsedUrl = new URL(trimmed)
      } catch {
        configError(sourceLabel, 'ota.manifestUrl must be a valid URL')
      }
      if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
        configError(sourceLabel, 'ota.manifestUrl must use http: or https:')
      }
      if (/[\r\n\0]/.test(trimmed)) {
        configError(sourceLabel, 'ota.manifestUrl cannot contain line breaks or NUL')
      }
      manifestUrl = trimmed
    }
  }

  const channel = asNonEmptyString(envChannel ?? obj.channel, 'ota.channel', 'production', sourceLabel)
  if (!channelPattern.test(channel)) {
    configError(sourceLabel, 'ota.channel must match /^[A-Za-z0-9._-]{1,64}$/')
  }

  const runtimeVersion = asNonEmptyString(
    envRuntimeVersion ?? obj.runtimeVersion,
    'ota.runtimeVersion',
    defaultRuntimeVersion,
    sourceLabel,
  )
  if (/[\r\n\0]/.test(runtimeVersion)) {
    configError(sourceLabel, 'ota.runtimeVersion cannot contain line breaks or NUL')
  }

  const rawKey = envPublicKey ?? obj.publicKey
  let publicKey: string | undefined
  if (rawKey !== undefined) {
    if (typeof rawKey !== 'string') {
      configError(sourceLabel, 'ota.publicKey must be a string')
    }
    if (rawKey.trim().length > 0) {
      publicKey = normalizeOtaPublicKey(rawKey, sourceLabel)
    }
  }

  const rawPolicy = obj.checkOnLaunch
  let checkOnLaunch: GpuixOtaCheckPolicy = 'manual'
  if (rawPolicy !== undefined) {
    if (typeof rawPolicy !== 'string' || !allowedOtaPolicies.has(rawPolicy as GpuixOtaCheckPolicy)) {
      configError(sourceLabel, 'ota.checkOnLaunch must be "manual", "background", or "immediate"')
    }
    checkOnLaunch = rawPolicy as GpuixOtaCheckPolicy
  }

  return {
    ...(manifestUrl ? { manifestUrl } : {}),
    channel,
    runtimeVersion,
    ...(publicKey ? { publicKey } : {}),
    checkOnLaunch,
  }
}

/** Returns resolved OTA settings with defaults even when `config.ota` is omitted. */
export function resolveOtaConfig(config: GpuixConfig): GpuixOtaConfig {
  return {
    channel: config.ota?.channel ?? 'production',
    runtimeVersion: config.ota?.runtimeVersion ?? String(config.versionCode),
    checkOnLaunch: config.ota?.checkOnLaunch ?? 'manual',
    ...(config.ota?.manifestUrl ? { manifestUrl: config.ota.manifestUrl } : {}),
    ...(config.ota?.publicKey ? { publicKey: config.ota.publicKey } : {}),
  }
}

function asAbisList(value: unknown, sourceLabel: string, fieldName = 'abis'): string[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value)) {
    configError(sourceLabel, `${fieldName} must be an array of Android ABI strings`)
  }
  const normalized: string[] = []
  for (const item of value) {
    if (typeof item !== 'string' || !allowedAbis.has(item.trim())) {
      configError(sourceLabel, `${fieldName} entries must be "arm64-v8a" or "armeabi-v7a"`)
    }
    const name = item.trim()
    if (!normalized.includes(name)) normalized.push(name)
  }
  return normalized.length > 0 ? normalized : undefined
}

function asFeaturesList(value: unknown, sourceLabel: string): string[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value)) {
    configError(sourceLabel, 'features must be an array of feature names')
  }
  const normalized: string[] = []
  for (const item of value) {
    if (typeof item !== 'string' || !allowedFeatures.has(item.trim())) {
      configError(sourceLabel, 'features entries must be "http-client" or "rich-content"')
    }
    const name = item.trim()
    if (!normalized.includes(name)) normalized.push(name)
  }
  return normalized
}

function asPermissionsList(
  value: unknown,
  sourceLabel: string,
  fieldName = 'permissions',
): string[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value)) {
    configError(sourceLabel, `${fieldName} must be an array of Android permission strings`)
  }
  const normalized: string[] = ['android.permission.INTERNET']
  for (const item of value) {
    if (typeof item !== 'string' || item.trim().length === 0) {
      configError(sourceLabel, `${fieldName} entries must be non-empty strings`)
    }
    const raw = item.trim()
    if (!permissionNamePattern.test(raw)) {
      configError(sourceLabel, `invalid Android permission name: ${raw}`)
    }
    const full = raw.includes('.') ? raw : `android.permission.${raw}`
    if (!normalized.includes(full)) normalized.push(full)
  }
  return normalized
}

function parseAndroidPlatformConfig(
  rawAndroid: unknown,
  sourceLabel: string,
): GpuixAndroidPlatformConfig | undefined {
  if (rawAndroid === undefined) return undefined
  if (rawAndroid === null || Array.isArray(rawAndroid) || typeof rawAndroid !== 'object') {
    configError(sourceLabel, 'android must be a JSON object')
  }
  const obj = rawAndroid as Record<string, unknown>
  const applicationId = asOptionalNonEmptyString(
    obj.applicationId ?? obj.appId,
    'android.applicationId',
    sourceLabel,
  )
  if (applicationId && !appIdPattern.test(applicationId)) {
    configError(
      sourceLabel,
      'android.applicationId must be a dotted Android package id, for example com.example.myapp',
    )
  }
  const abis = asAbisList(obj.abis, sourceLabel, 'android.abis')
  const permissions = asPermissionsList(obj.permissions, sourceLabel, 'android.permissions')
  if (applicationId === undefined && abis === undefined && permissions === undefined) {
    return undefined
  }
  return {
    ...(applicationId ? { applicationId } : {}),
    ...(abis ? { abis } : {}),
    ...(permissions ? { permissions } : {}),
  }
}

function parseIosPlatformConfig(rawIos: unknown, sourceLabel: string): GpuixIosPlatformConfig | undefined {
  if (rawIos === undefined) return undefined
  if (rawIos === null || Array.isArray(rawIos) || typeof rawIos !== 'object') {
    configError(sourceLabel, 'ios must be a JSON object')
  }
  const obj = rawIos as Record<string, unknown>
  const bundleId = asOptionalNonEmptyString(obj.bundleId ?? obj.appId, 'ios.bundleId', sourceLabel)
  if (bundleId && !iosBundleIdPattern.test(bundleId)) {
    configError(sourceLabel, 'ios.bundleId must be a reverse-DNS bundle identifier, for example dev.gpuix.myapp')
  }
  const buildNumber = asOptionalNonEmptyString(
    typeof obj.buildNumber === 'number' ? String(obj.buildNumber) : obj.buildNumber,
    'ios.buildNumber',
    sourceLabel,
  )
  if (buildNumber && !/^[0-9]+(?:\.[0-9]+)*$/.test(buildNumber)) {
    configError(sourceLabel, 'ios.buildNumber must match Apple CFBundleVersion digits (e.g. "1" or "1.0.1")')
  }
  const deploymentTarget = asOptionalNonEmptyString(obj.deploymentTarget, 'ios.deploymentTarget', sourceLabel)
  if (deploymentTarget && !/^[0-9]+(?:\.[0-9]+)?$/.test(deploymentTarget)) {
    configError(sourceLabel, 'ios.deploymentTarget must be an iOS version like "17.0"')
  }
  let statusBarStyle: GpuixStatusBarStyle | undefined
  if (obj.statusBarStyle !== undefined) {
    if (obj.statusBarStyle !== 'light' && obj.statusBarStyle !== 'dark') {
      configError(sourceLabel, 'ios.statusBarStyle must be "light" or "dark"')
    }
    statusBarStyle = obj.statusBarStyle
  }
  if (!bundleId && !buildNumber && !deploymentTarget && !statusBarStyle) {
    return undefined
  }
  return {
    ...(bundleId ? { bundleId } : {}),
    ...(buildNumber ? { buildNumber } : {}),
    ...(deploymentTarget ? { deploymentTarget } : {}),
    ...(statusBarStyle ? { statusBarStyle } : {}),
  }
}

export function resolveAndroidAppId(config: GpuixConfig): string {
  return config.android?.applicationId ?? config.appId
}

export function resolveAndroidAbis(config: GpuixConfig): string[] {
  return config.android?.abis ?? config.abis ?? ['arm64-v8a']
}

export function resolveAndroidPermissions(config: GpuixConfig): string[] | undefined {
  return config.android?.permissions ?? config.permissions
}

export function resolveIosBundleId(config: GpuixConfig): string {
  return config.ios?.bundleId ?? config.appId
}

export function resolveIosBuildNumber(config: GpuixConfig): string {
  return config.ios?.buildNumber ?? String(config.versionCode)
}

export function resolveIosDeploymentTarget(config: GpuixConfig): string {
  return config.ios?.deploymentTarget ?? '17.0'
}

export function resolveIosStatusBarStyle(config: GpuixConfig): GpuixStatusBarStyle {
  return config.ios?.statusBarStyle ?? 'light'
}

/**
 * Loads `gpuix.config.json` (preferred) or legacy `gpuix.android.json`.
 */
export async function loadGpuixConfig(projectRoot: string): Promise<GpuixConfig> {
  const root = path.resolve(projectRoot)
  const resolved = resolveConfigFile(root)
  const sourceLabel = resolved?.filename ?? 'gpuix.config.json'
  let raw: Record<string, unknown> = {}

  if (resolved) {
    try {
      const parsed: unknown = JSON.parse(await Bun.file(resolved.path).text())
      if (parsed === null || Array.isArray(parsed) || typeof parsed !== 'object') {
        configError(sourceLabel, 'must contain a JSON object')
      }
      raw = parsed as Record<string, unknown>
    } catch (error) {
      if (error instanceof Error && error.message.startsWith(`${sourceLabel}:`)) throw error
      const detail = error instanceof Error ? error.message : String(error)
      configError(sourceLabel, `is not valid JSON (${detail})`)
    }
  }

  const entrypointInput = asNonEmptyString(
    process.env.GPUIX_ENTRYPOINT ?? raw.entrypoint,
    'entrypoint',
    legacyDemoDefaults.entrypoint,
    sourceLabel,
  )
  const versionCode = asPositiveInteger(
    raw.versionCode,
    'versionCode',
    legacyDemoDefaults.versionCode,
    sourceLabel,
  )
  const ota = parseOtaConfig(raw.ota, String(versionCode), sourceLabel)
  const topPermissions = asPermissionsList(raw.permissions, sourceLabel)
  const topAbis = asAbisList(
    process.env.GPUIX_ABIS ? process.env.GPUIX_ABIS.split(',') : raw.abis,
    sourceLabel,
  )
  const androidSection = parseAndroidPlatformConfig(raw.android, sourceLabel)
  const iosSection = parseIosPlatformConfig(raw.ios, sourceLabel)

  const config: GpuixConfig = {
    entrypoint: projectRelativePath(root, entrypointInput, sourceLabel),
    appId: asNonEmptyString(
      process.env.GPUIX_APP_ID ?? raw.appId,
      'appId',
      legacyDemoDefaults.appId,
      sourceLabel,
    ),
    appName: asNonEmptyString(
      process.env.GPUIX_APP_NAME ?? raw.appName,
      'appName',
      legacyDemoDefaults.appName,
      sourceLabel,
    ),
    versionName: asNonEmptyString(
      raw.versionName,
      'versionName',
      legacyDemoDefaults.versionName,
      sourceLabel,
    ),
    versionCode,
    ...(raw.features !== undefined ? { features: asFeaturesList(raw.features, sourceLabel) } : {}),
    ...(topAbis !== undefined ? { abis: topAbis } : {}),
    ...(topPermissions !== undefined ? { permissions: topPermissions } : {}),
    ...(androidSection ? { android: androidSection } : {}),
    ...(iosSection ? { ios: iosSection } : {}),
    ...(ota ? { ota } : {}),
  }

  if (!appIdPattern.test(config.appId)) {
    configError(
      sourceLabel,
      'appId must be a dotted package id (dotted Android package id), for example com.example.myapp',
    )
  }
  if (/[\r\n\0]/.test(config.appName)) {
    configError(sourceLabel, 'appName cannot contain a line break or NUL character')
  }
  if (/[\r\n\0]/.test(config.versionName)) {
    configError(sourceLabel, 'versionName cannot contain a line break or NUL character')
  }

  const entrypointPath = path.join(root, config.entrypoint)
  if (!(await Bun.file(entrypointPath).exists())) {
    configError(sourceLabel, `entrypoint does not exist: ${config.entrypoint}`)
  }
  return config
}

/** Backward-compatible alias for `loadGpuixConfig`. */
export const loadGpuixAndroidConfig = loadGpuixConfig

function escapeProperty(value: string): string {
  return value
    .replaceAll('\\', '\\\\')
    .replaceAll('\r', '\\r')
    .replaceAll('\n', '\\n')
    .replace(/([:=#!])/g, '\\$1')
}

export async function writeTextIfChanged(outputPath: string, contents: string): Promise<void> {
  const data = Buffer.from(contents)
  const current = Bun.file(outputPath)
  if ((await current.exists()) && data.equals(Buffer.from(await current.arrayBuffer()))) return

  await mkdir(path.dirname(outputPath), { recursive: true })
  const temporaryPath = `${outputPath}.${randomUUID()}.tmp`
  try {
    await Bun.write(temporaryPath, data)
    await rename(temporaryPath, outputPath)
  } finally {
    await rm(temporaryPath, { force: true })
  }
}

/** Writes the small Gradle-only projection of the canonical JSON config. */
export async function writeGradleProperties(targetRoot: string, config: GpuixConfig): Promise<string> {
  const androidDir = path.basename(targetRoot) === 'android'
    ? targetRoot
    : path.join(targetRoot, 'android')
  const outputPath = path.join(androidDir, '.build/gpuix.android.properties')
  const abisValue = process.env.GPUIX_ABIS?.trim() || resolveAndroidAbis(config).join(',')
  await writeTextIfChanged(
    outputPath,
    [
      '# Generated from gpuix.config.json / gpuix.android.json. Do not edit.',
      `appId=${escapeProperty(resolveAndroidAppId(config))}`,
      `appName=${escapeProperty(config.appName)}`,
      `versionName=${escapeProperty(config.versionName)}`,
      `versionCode=${config.versionCode}`,
      `abis=${escapeProperty(abisValue)}`,
      '',
    ].join('\n'),
  )
  return outputPath
}

/**
 * Generates `.build/AndroidManifest.xml` with trimmed `<uses-permission>` entries when `permissions`
 * is configured, or removes any stale generated manifest when omitted.
 */
export async function syncGeneratedManifest(
  targetRoot: string,
  config: GpuixConfig,
): Promise<string | null> {
  const androidDir = path.basename(targetRoot) === 'android'
    ? targetRoot
    : path.join(targetRoot, 'android')
  const generatedPath = path.join(androidDir, '.build/AndroidManifest.xml')
  const permissions = resolveAndroidPermissions(config)
  if (permissions === undefined) {
    await rm(generatedPath, { force: true })
    return null
  }
  const sourceManifestPath = path.join(androidDir, 'app/src/main/AndroidManifest.xml')
  const template = await Bun.file(sourceManifestPath).text()
  const lines = permissions.map((perm) => `    <uses-permission android:name="${perm}" />`).join('\n')
  const permissionBlockRegex = /(?:^[ \t]*<uses-permission\b[^>]*\/>\r?\n)+/m
  if (!permissionBlockRegex.test(template)) {
    throw new Error(`Could not locate <uses-permission> block in ${sourceManifestPath}`)
  }
  const updated = template.replace(permissionBlockRegex, `${lines}\n`)
  await writeTextIfChanged(generatedPath, updated)
  return generatedPath
}

function valueAfter(flag: string, args: string[]): string | undefined {
  const index = args.indexOf(flag)
  if (index === -1) return undefined
  const value = args[index + 1]
  if (!value || value.startsWith('--')) throw new Error(`${flag} needs a value`)
  return value
}

const allowedCliFields = new Set([
  'entrypoint',
  'appId',
  'androidAppId',
  'appName',
  'versionName',
  'versionCode',
  'features',
  'abis',
  'ota',
  'iosBundleId',
  'iosBuildNumber',
  'iosDeploymentTarget',
  'iosStatusBarStyle',
  'configFile',
])

export async function runConfigCli(args = process.argv.slice(2)): Promise<void> {
  const field = valueAfter('--field', args)
  const projectRoot = valueAfter('--project', args) ?? path.resolve(import.meta.dir, '..')
  if (!field || !allowedCliFields.has(field)) {
    throw new Error(
      `Usage: bun config.ts --field ${Array.from(allowedCliFields).join('|')} [--project PROJECT_ROOT]`,
    )
  }
  const config = await loadGpuixConfig(projectRoot)
  if (field === 'features') {
    if (config.features !== undefined) {
      process.stdout.write(`${config.features.join(',')}\n`)
    }
  } else if (field === 'abis') {
    process.stdout.write(`${resolveAndroidAbis(config).join(',')}\n`)
  } else if (field === 'androidAppId') {
    process.stdout.write(`${resolveAndroidAppId(config)}\n`)
  } else if (field === 'iosBundleId') {
    process.stdout.write(`${resolveIosBundleId(config)}\n`)
  } else if (field === 'iosBuildNumber') {
    process.stdout.write(`${resolveIosBuildNumber(config)}\n`)
  } else if (field === 'iosDeploymentTarget') {
    process.stdout.write(`${resolveIosDeploymentTarget(config)}\n`)
  } else if (field === 'iosStatusBarStyle') {
    process.stdout.write(`${resolveIosStatusBarStyle(config)}\n`)
  } else if (field === 'configFile') {
    process.stdout.write(`${resolveConfigFile(projectRoot)?.filename ?? ''}\n`)
  } else if (field === 'ota') {
    process.stdout.write(`${JSON.stringify(resolveOtaConfig(config))}\n`)
  } else {
    process.stdout.write(`${config[field as keyof GpuixConfig]}\n`)
  }
}

if (import.meta.main) {
  await runConfigCli()
}
