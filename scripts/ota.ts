import path from 'node:path'
import { createHash, createPublicKey, generateKeyPairSync, sign as cryptoSign, verify as cryptoVerify } from 'node:crypto'
import { existsSync } from 'node:fs'
import { chmod, mkdir, readFile, rm } from 'node:fs/promises'
import { compileMobileBundle, type MobileTargetPlatform } from './bundler'
import {
  loadGpuixConfig,
  normalizeOtaPublicKey,
  resolveAndroidAppId,
  resolveIosBundleId,
  resolveOtaConfig,
} from './config'
import {
  appendReleaseChainEntry,
  buildByteMerkleTree,
  buildHashMerkleTree,
  buildMerkleProof,
  computeReleaseHash,
  createEmptyReleaseChain,
  DEFAULT_OTA_CHUNK_SIZE,
  hashMerkleLeaf,
  locateChainEntries,
  verifyMerkleProof,
  verifyReleaseChain,
  type ByteMerkleTree,
  type MerkleProofStep,
  type OtaChainEntry,
  type OtaReleaseChain,
} from './ota-integrity'

export type OtaManifestAction = 'update' | 'rollback_to_embedded'
export type OtaTargetPlatform = MobileTargetPlatform | 'all'

export type OtaManifestIntegrity = {
  algorithm: 'sha256'
  chunkSize: number
  chunkCount: number
  merkleRoot: string
  prevReleaseHash: string
  releaseHash: string
  chainIndex: number
  chainMerkleRoot: string
}

export type OtaManifest = {
  schemaVersion: 1
  action?: OtaManifestAction
  appId: string
  channel: string
  platform?: OtaTargetPlatform
  versionName?: string
  runtimeVersion: string
  releaseId: string
  minVersionCode: number
  manifestSeq?: number
  mandatory: boolean
  notes?: string
  publishedAt: string
  manifestSignature?: string
  integrity?: OtaManifestIntegrity
  bundle?: {
    format: 'hbc' | 'js'
    url: string
    sha256: string
    size: number
    hermesBytecodeVersion?: number
    signature?: string
  }
}

export type KeygenResult = {
  outDir: string
  privateKeyPath: string
  publicKeyPemPath: string
  publicKeyB64Path: string
  publicKeyBase64: string
}

export type BuildOtaReleaseOptions = {
  projectRoot: string
  androidRoot?: string
  outDir?: string
  channel?: string
  platform?: OtaTargetPlatform
  versionName?: string
  runtimeVersion?: string
  releaseId?: string
  baseUrl?: string
  mandatory?: boolean
  notes?: string
  privateKey?: string
  skipHbc?: boolean
  debug?: boolean
  manifestSeq?: number
  action?: OtaManifestAction
  chunkSize?: number
  chainPath?: string
}

export type BuildOtaReleaseResult = {
  outDir: string
  manifestPath: string
  bundlePath: string
  merklePath: string
  chainPath: string
  manifest: OtaManifest
  chain: OtaReleaseChain
  hermescUsed: boolean
}

export type VerifyOtaReleaseResult = {
  manifestPath: string
  bundlePath: string
  releaseId: string
  versionName: string
  action: OtaManifestAction
  format: 'hbc' | 'js' | 'embedded'
  sha256: string
  size: number
  merkleRoot?: string
  releaseHash?: string
  prevReleaseHash?: string
  chainIndex?: number
  chainMerkleRoot?: string
  chainVerified: boolean
  signatureVerified: boolean
  manifestSignatureVerified: boolean
}

export type ServeOtaOptions = {
  projectRoot: string
  dir: string
  port: number
  serial?: string
}

export type OtaProofResult = {
  kind: 'chain' | 'chunk'
  releaseId: string
  versionName: string
  index: number
  leafHash: string
  rootHash: string
  proof: MerkleProofStep[]
  verified: boolean
}

const HERMES_MAGIC = Buffer.from([0xc6, 0x1f, 0xbc, 0x03, 0xc1, 0x03, 0x19, 0x1f])
const RELEASE_ID_PATTERN = /^[A-Za-z0-9._-]{1,128}$/

export function otaUsage(): string {
  return `gpuix ota — Over-The-Air JS/HBC release, hash-chain & Merkle proof toolchain

Usage:
  gpuix ota keygen [--out DIR]
  gpuix ota build [--cwd DIR] [--out DIR] [--platform android|ios|all] [--version VER]
                  [--channel NAME] [--runtime-version VER] [--release-id ID] [--base-url URL]
                  [--seq N] [--chunk-size BYTES] [--chain PATH] [--mandatory] [--notes TEXT]
                  [--private-key FILE_OR_PEM] [--rollback-to-embedded] [--no-hbc] [--debug]
  gpuix ota verify <MANIFEST_PATH> [--public-key FILE_OR_B64]
  gpuix ota chain [--cwd DIR] [--dir DIR] [--verify] [--json]
  gpuix ota proof <RELEASE_ID_OR_HASH> [--cwd DIR] [--dir DIR] [--chunk N] [--json]
  gpuix ota locate <QUERY> [--cwd DIR] [--dir DIR] [--json]
  gpuix ota serve [ADB_SERIAL] [--cwd DIR] [--dir DIR] [--port 8787]`
}

function fail(message: string): never {
  throw new Error(`gpuix ota: ${message}`)
}

function parseOtaArgs(args: string[], booleanFlags: Set<string>): {
  values: Map<string, string>
  flags: Set<string>
  positional: string[]
} {
  const values = new Map<string, string>()
  const flags = new Set<string>()
  const positional: string[] = []
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]
    if (!arg.startsWith('--')) {
      positional.push(arg)
      continue
    }
    const eq = arg.indexOf('=')
    const key = eq === -1 ? arg.slice(2) : arg.slice(2, eq)
    if (!key) fail(`invalid option: ${arg}`)
    if (eq === -1 && booleanFlags.has(key)) {
      flags.add(key)
      continue
    }
    const value = eq === -1 ? args[i + 1] : arg.slice(eq + 1)
    if (!value || value.startsWith('--')) fail(`${arg} needs a value`)
    if (eq === -1) i += 1
    values.set(key, value)
  }
  return { values, flags, positional }
}

function formatReleaseTimestamp(date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  return [
    date.getUTCFullYear(),
    pad(date.getUTCMonth() + 1),
    pad(date.getUTCDate()),
    '-',
    pad(date.getUTCHours()),
    pad(date.getUTCMinutes()),
    pad(date.getUTCSeconds()),
  ].join('')
}

function toPublicKeyPem(base64Spki: string): string {
  const lines = base64Spki.match(/.{1,64}/g) ?? [base64Spki]
  return `-----BEGIN PUBLIC KEY-----\n${lines.join('\n')}\n-----END PUBLIC KEY-----\n`
}

async function resolvePrivateKeyPem(input: string): Promise<string> {
  if (input.includes('-----BEGIN')) return input
  const abs = path.resolve(input)
  if (!existsSync(abs)) {
    fail(`private key file not found: ${abs}`)
  }
  return readFile(abs, 'utf8')
}

async function resolvePublicKeyObject(input: string) {
  let raw = input.trim()
  if (!raw.includes('-----BEGIN') && existsSync(path.resolve(raw))) {
    raw = await readFile(path.resolve(raw), 'utf8')
  }
  const normalizedB64 = normalizeOtaPublicKey(raw)
  return createPublicKey(toPublicKeyPem(normalizedB64))
}

/**
 * Canonical manifest signing payload matched byte-for-byte with `GpuiOtaManager.buildManifestSigningPayload`.
 * Legacy manifests without `integrity` keep `gpuix-ota-manifest-v1`; integrity-enabled manifests sign `gpuix-ota-manifest-v2`.
 */
export function buildManifestSigningPayload(manifest: Partial<OtaManifest>): string {
  const schemaVersion = manifest.schemaVersion ?? 1
  const action = manifest.action?.trim() || 'update'
  const appId = manifest.appId?.trim() ?? ''
  const channel = manifest.channel?.trim() ?? ''
  const runtimeVersion = manifest.runtimeVersion?.trim() ?? ''
  const releaseId = manifest.releaseId?.trim() ?? ''
  const minVersionCode = manifest.minVersionCode ?? 1
  const manifestSeq = manifest.manifestSeq ?? 0
  const mandatory = Boolean(manifest.mandatory) ? 'true' : 'false'
  const bundleFormat = manifest.bundle?.format?.trim().toLowerCase() ?? ''
  const bundleSha256 = manifest.bundle?.sha256?.trim().toLowerCase() ?? ''
  const bundleSize = manifest.bundle?.size ?? 0
  const hbcVersion = manifest.bundle?.hermesBytecodeVersion ?? 0

  if (manifest.integrity) {
    const platform = manifest.platform?.trim() || 'all'
    const versionName = manifest.versionName?.trim() ?? ''
    return [
      'gpuix-ota-manifest-v2',
      `schemaVersion=${schemaVersion}`,
      `action=${action}`,
      `appId=${appId}`,
      `channel=${channel}`,
      `platform=${platform}`,
      `versionName=${versionName}`,
      `runtimeVersion=${runtimeVersion}`,
      `releaseId=${releaseId}`,
      `minVersionCode=${minVersionCode}`,
      `manifestSeq=${manifestSeq}`,
      `mandatory=${mandatory}`,
      `bundleFormat=${bundleFormat}`,
      `bundleSha256=${bundleSha256}`,
      `bundleSize=${bundleSize}`,
      `hermesBytecodeVersion=${hbcVersion}`,
      `chunkSize=${manifest.integrity.chunkSize}`,
      `chunkCount=${manifest.integrity.chunkCount}`,
      `merkleRoot=${manifest.integrity.merkleRoot.trim().toLowerCase()}`,
      `prevReleaseHash=${manifest.integrity.prevReleaseHash.trim().toLowerCase()}`,
      `releaseHash=${manifest.integrity.releaseHash.trim().toLowerCase()}`,
      `chainIndex=${manifest.integrity.chainIndex}`,
      `chainMerkleRoot=${manifest.integrity.chainMerkleRoot.trim().toLowerCase()}`,
      '',
    ].join('\n')
  }

  return [
    'gpuix-ota-manifest-v1',
    `schemaVersion=${schemaVersion}`,
    `action=${action}`,
    `appId=${appId}`,
    `channel=${channel}`,
    `runtimeVersion=${runtimeVersion}`,
    `releaseId=${releaseId}`,
    `minVersionCode=${minVersionCode}`,
    `manifestSeq=${manifestSeq}`,
    `mandatory=${mandatory}`,
    `bundleFormat=${bundleFormat}`,
    `bundleSha256=${bundleSha256}`,
    `bundleSize=${bundleSize}`,
    `hermesBytecodeVersion=${hbcVersion}`,
    '',
  ].join('\n')
}

export async function readOtaChain(chainPathInput: string): Promise<OtaReleaseChain> {
  const chainPath = path.resolve(chainPathInput)
  if (!existsSync(chainPath)) {
    fail(`OTA chain file not found: ${chainPath}`)
  }
  const parsed = JSON.parse(await readFile(chainPath, 'utf8')) as OtaReleaseChain
  if (parsed.schemaVersion !== 1 || !Array.isArray(parsed.entries)) {
    fail(`invalid OTA chain format in ${chainPath}`)
  }
  return parsed
}

async function loadOrInitializeChain(
  chainPath: string,
  appId: string,
  channel: string,
): Promise<OtaReleaseChain> {
  if (!existsSync(chainPath)) {
    return createEmptyReleaseChain(appId, channel)
  }
  const existing = JSON.parse(await readFile(chainPath, 'utf8')) as OtaReleaseChain
  if (existing.appId !== appId || existing.channel !== channel) {
    return createEmptyReleaseChain(appId, channel)
  }
  const verified = verifyReleaseChain(existing)
  if (!verified.valid) {
    fail(`existing OTA chain at ${chainPath} failed integrity check: ${verified.errors.join('; ')}`)
  }
  return existing
}

export async function generateOtaProof(options: {
  dir: string
  query: string
  chunkIndex?: number
}): Promise<OtaProofResult> {
  const dir = path.resolve(options.dir)
  const chainPath = path.join(dir, 'chain.json')
  const chain = await readOtaChain(chainPath)
  const verifiedChain = verifyReleaseChain(chain)
  if (!verifiedChain.valid) {
    fail(`OTA chain verification failed: ${verifiedChain.errors.join('; ')}`)
  }

  const matches = locateChainEntries(chain, options.query)
  if (matches.length === 0) {
    fail(`no OTA release matching "${options.query}" in ${chainPath}`)
  }
  if (matches.length > 1) {
    fail(
      `ambiguous query "${options.query}" matched ${matches.length} releases: ${matches.map((m) => m.releaseId).join(', ')}`,
    )
  }
  const entry = matches[0]

  if (options.chunkIndex === undefined) {
    const leafHashes = chain.entries.map((item) => hashMerkleLeaf(Buffer.from(item.releaseHash, 'hex')))
    const leafHash = leafHashes[entry.index]
    const proof = buildMerkleProof(leafHashes, entry.index)
    const verified = verifyMerkleProof(leafHash, entry.index, proof, chain.chainMerkleRoot)
    return {
      kind: 'chain',
      releaseId: entry.releaseId,
      versionName: entry.versionName,
      index: entry.index,
      leafHash,
      rootHash: chain.chainMerkleRoot,
      proof,
      verified,
    }
  }

  if (!entry.merklePath) {
    fail(`release "${entry.releaseId}" has no chunk merkle.json (action=${entry.action})`)
  }
  const merkleFilePath = path.resolve(dir, entry.merklePath)
  if (!existsSync(merkleFilePath)) {
    fail(`merkle metadata missing: ${merkleFilePath}`)
  }
  const merkle = JSON.parse(await readFile(merkleFilePath, 'utf8')) as ByteMerkleTree
  if (
    !Number.isSafeInteger(options.chunkIndex) ||
    options.chunkIndex < 0 ||
    options.chunkIndex >= merkle.leafHashes.length
  ) {
    fail(
      `chunk index ${options.chunkIndex} out of bounds (release "${entry.releaseId}" has ${merkle.leafHashes.length} chunks)`,
    )
  }
  const leafHash = merkle.leafHashes[options.chunkIndex]
  const proof = buildMerkleProof(merkle.leafHashes, options.chunkIndex)
  const verified = verifyMerkleProof(leafHash, options.chunkIndex, proof, merkle.merkleRoot)
  return {
    kind: 'chunk',
    releaseId: entry.releaseId,
    versionName: entry.versionName,
    index: options.chunkIndex,
    leafHash,
    rootHash: merkle.merkleRoot,
    proof,
    verified,
  }
}

export async function keygenOta(options: { outDir: string }): Promise<KeygenResult> {
  const outDir = path.resolve(options.outDir)
  await mkdir(outDir, { recursive: true })

  const { privateKey, publicKey } = generateKeyPairSync('ec', {
    namedCurve: 'prime256v1',
    publicKeyEncoding: { type: 'spki', format: 'der' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  })

  const publicKeyBase64 = Buffer.from(publicKey).toString('base64')
  const publicKeyPem = toPublicKeyPem(publicKeyBase64)

  const privateKeyPath = path.join(outDir, 'ota-private.pem')
  const publicKeyPemPath = path.join(outDir, 'ota-public.pem')
  const publicKeyB64Path = path.join(outDir, 'ota-public.b64')

  await Bun.write(privateKeyPath, privateKey)
  await chmod(privateKeyPath, 0o600)
  await Bun.write(publicKeyPemPath, publicKeyPem)
  await Bun.write(publicKeyB64Path, `${publicKeyBase64}\n`)

  return {
    outDir,
    privateKeyPath,
    publicKeyPemPath,
    publicKeyB64Path,
    publicKeyBase64,
  }
}

export async function buildOtaRelease(options: BuildOtaReleaseOptions): Promise<BuildOtaReleaseResult> {
  const projectRoot = path.resolve(options.projectRoot)
  const androidRoot = options.androidRoot
    ? path.resolve(options.androidRoot)
    : existsSync(path.join(projectRoot, 'android/scripts/build-js.ts'))
      ? path.join(projectRoot, 'android')
      : path.resolve(import.meta.dir, '../android')

  const config = await loadGpuixConfig(projectRoot)
  const resolvedOta = resolveOtaConfig(config)
  const outDir = path.resolve(options.outDir ?? path.join(projectRoot, 'dist/ota'))
  const chainPath = path.resolve(options.chainPath ?? path.join(outDir, 'chain.json'))
  const channel = (options.channel ?? resolvedOta.channel).trim()
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(channel)) {
    fail(`invalid channel: ${channel}`)
  }
  const platform: OtaTargetPlatform = options.platform ?? 'android'
  const appId = platform === 'ios' ? resolveIosBundleId(config) : resolveAndroidAppId(config)
  const versionName = (options.versionName ?? config.versionName).trim()
  if (!versionName || /[\r\n\0]/.test(versionName)) {
    fail('versionName must be a non-empty single-line string')
  }
  const runtimeVersion = (options.runtimeVersion ?? resolvedOta.runtimeVersion).trim()
  if (!runtimeVersion || /[\r\n\0]/.test(runtimeVersion)) {
    fail('runtimeVersion must be a non-empty single-line string')
  }
  const chunkSize = options.chunkSize ?? DEFAULT_OTA_CHUNK_SIZE
  if (!Number.isSafeInteger(chunkSize) || chunkSize < 256) {
    fail(`invalid chunkSize: ${String(chunkSize)} (minimum 256 bytes)`)
  }

  const action: OtaManifestAction = options.action ?? 'update'
  const manifestSeq = options.manifestSeq ?? Math.floor(Date.now() / 1000)
  if (!Number.isSafeInteger(manifestSeq) || manifestSeq < 1) {
    fail(`invalid manifestSeq: ${String(manifestSeq)}`)
  }

  const rawPrivateKey = options.privateKey ?? process.env.GPUIX_OTA_PRIVATE_KEY
  const privatePem =
    rawPrivateKey && rawPrivateKey.trim().length > 0 ? await resolvePrivateKeyPem(rawPrivateKey.trim()) : undefined

  const existingChain = await loadOrInitializeChain(chainPath, appId, channel)
  const publishedAt = new Date().toISOString()

  if (action === 'rollback_to_embedded') {
    if (!privatePem) {
      fail('--rollback-to-embedded requires --private-key or GPUIX_OTA_PRIVATE_KEY')
    }
    const releaseId = (options.releaseId ?? `rollback-${formatReleaseTimestamp()}`).trim()
    if (!RELEASE_ID_PATTERN.test(releaseId) || releaseId.includes('..')) {
      fail(`invalid releaseId: ${releaseId}`)
    }
    const emptyMerkleRoot = buildHashMerkleTree([]).merkleRoot
    const nextChain = appendReleaseChainEntry(existingChain, {
      releaseId,
      versionName,
      platform,
      action: 'rollback_to_embedded',
      runtimeVersion,
      manifestSeq,
      publishedAt,
      bundleFormat: 'embedded',
      bundleSize: 0,
      bundleSha256: '',
      chunkSize: 0,
      chunkCount: 0,
      merkleRoot: emptyMerkleRoot,
      manifestPath: 'manifest.json',
      bundlePath: '',
    })
    const latestEntry = nextChain.entries[nextChain.entries.length - 1]
    const manifest: OtaManifest = {
      schemaVersion: 1,
      action: 'rollback_to_embedded',
      appId,
      channel,
      platform,
      versionName,
      runtimeVersion,
      releaseId,
      minVersionCode: config.versionCode,
      manifestSeq,
      mandatory: true,
      ...(options.notes ? { notes: options.notes } : {}),
      publishedAt,
      integrity: {
        algorithm: 'sha256',
        chunkSize: 0,
        chunkCount: 0,
        merkleRoot: latestEntry.merkleRoot,
        prevReleaseHash: latestEntry.prevReleaseHash,
        releaseHash: latestEntry.releaseHash,
        chainIndex: latestEntry.index,
        chainMerkleRoot: nextChain.chainMerkleRoot,
      },
    }
    manifest.manifestSignature = cryptoSign(
      'sha256',
      Buffer.from(buildManifestSigningPayload(manifest), 'utf8'),
      privatePem,
    ).toString('base64')

    await mkdir(outDir, { recursive: true })
    const manifestPath = path.join(outDir, 'manifest.json')
    await Bun.write(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
    await Bun.write(chainPath, `${JSON.stringify(nextChain, null, 2)}\n`)
    return {
      outDir,
      manifestPath,
      bundlePath: '',
      merklePath: '',
      chainPath,
      manifest,
      chain: nextChain,
      hermescUsed: false,
    }
  }

  const tmpBuildDir = path.join(outDir, '.tmp-build')
  await mkdir(tmpBuildDir, { recursive: true })
  let compiled
  try {
    compiled = await compileMobileBundle({
      projectRoot,
      androidRoot,
      entrypointRel: config.entrypoint,
      platform: platform === 'ios' ? 'ios' : 'android',
      config,
      channel,
      runtimeVersion,
      isRelease: !options.debug,
      skipHbc: options.skipHbc,
      tempWorkDir: tmpBuildDir,
    })
  } finally {
    await rm(tmpBuildDir, { recursive: true, force: true })
  }

  const merkle = buildByteMerkleTree(compiled.bytes, chunkSize)
  const releaseId = (options.releaseId ?? `v${versionName}-${formatReleaseTimestamp()}-${compiled.sha256.slice(0, 8)}`).trim()
  if (!RELEASE_ID_PATTERN.test(releaseId) || releaseId.includes('..')) {
    fail(`invalid releaseId: ${releaseId}`)
  }

  const fileName = compiled.format === 'hbc' ? 'app.hbc' : 'app.js'
  const relBundlePath = `bundles/${releaseId}/${fileName}`
  const relMerklePath = `bundles/${releaseId}/merkle.json`
  const relReleaseManifestPath = `bundles/${releaseId}/manifest.json`
  const bundlePath = path.join(outDir, relBundlePath)
  const merklePath = path.join(outDir, relMerklePath)
  const releaseManifestPath = path.join(outDir, relReleaseManifestPath)
  await mkdir(path.dirname(bundlePath), { recursive: true })
  await Bun.write(bundlePath, compiled.bytes)
  await Bun.write(merklePath, `${JSON.stringify(merkle, null, 2)}\n`)

  let signature: string | undefined
  if (privatePem) {
    signature = cryptoSign('sha256', compiled.bytes, privatePem).toString('base64')
  }

  let bundleUrl = relBundlePath
  if (options.baseUrl && options.baseUrl.trim().length > 0) {
    const base = options.baseUrl.trim().replace(/\/+$/, '')
    bundleUrl = `${base}/${relBundlePath}`
  }

  const nextChain = appendReleaseChainEntry(existingChain, {
    releaseId,
    versionName,
    platform,
    action: 'update',
    runtimeVersion,
    manifestSeq,
    publishedAt,
    bundleFormat: compiled.format,
    bundleSize: compiled.bytes.length,
    bundleSha256: compiled.sha256,
    chunkSize: merkle.chunkSize,
    chunkCount: merkle.chunkCount,
    merkleRoot: merkle.merkleRoot,
    manifestPath: relReleaseManifestPath,
    bundlePath: relBundlePath,
    merklePath: relMerklePath,
  })
  const latestEntry = nextChain.entries[nextChain.entries.length - 1]

  const manifest: OtaManifest = {
    schemaVersion: 1,
    action: 'update',
    appId,
    channel,
    platform,
    versionName,
    runtimeVersion,
    releaseId,
    minVersionCode: config.versionCode,
    manifestSeq,
    mandatory: Boolean(options.mandatory),
    ...(options.notes ? { notes: options.notes } : {}),
    publishedAt,
    integrity: {
      algorithm: 'sha256',
      chunkSize: merkle.chunkSize,
      chunkCount: merkle.chunkCount,
      merkleRoot: merkle.merkleRoot,
      prevReleaseHash: latestEntry.prevReleaseHash,
      releaseHash: latestEntry.releaseHash,
      chainIndex: latestEntry.index,
      chainMerkleRoot: nextChain.chainMerkleRoot,
    },
    bundle: {
      format: compiled.format,
      url: bundleUrl,
      sha256: compiled.sha256,
      size: compiled.bytes.length,
      ...(compiled.hbcVersion > 0 ? { hermesBytecodeVersion: compiled.hbcVersion } : {}),
      ...(signature ? { signature } : {}),
    },
  }
  if (privatePem) {
    manifest.manifestSignature = cryptoSign(
      'sha256',
      Buffer.from(buildManifestSigningPayload(manifest), 'utf8'),
      privatePem,
    ).toString('base64')
  }

  const manifestPath = path.join(outDir, 'manifest.json')
  const manifestJson = `${JSON.stringify(manifest, null, 2)}\n`
  await Bun.write(manifestPath, manifestJson)
  await Bun.write(releaseManifestPath, manifestJson)
  await Bun.write(chainPath, `${JSON.stringify(nextChain, null, 2)}\n`)

  return {
    outDir,
    manifestPath,
    bundlePath,
    merklePath,
    chainPath,
    manifest,
    chain: nextChain,
    hermescUsed: compiled.format === 'hbc',
  }
}

export async function verifyOtaRelease(
  manifestPathInput: string,
  publicKeyInput?: string,
): Promise<VerifyOtaReleaseResult> {
  const manifestPath = path.resolve(manifestPathInput)
  if (!existsSync(manifestPath)) {
    fail(`manifest not found: ${manifestPath}`)
  }
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as Partial<OtaManifest>
  if (manifest.schemaVersion !== 1) {
    fail(`unsupported manifest schemaVersion: ${String(manifest.schemaVersion)}`)
  }
  const action: OtaManifestAction = manifest.action ?? 'update'
  if (action !== 'update' && action !== 'rollback_to_embedded') {
    fail(`unsupported manifest action: ${String(manifest.action)}`)
  }
  if (!manifest.releaseId || !RELEASE_ID_PATTERN.test(manifest.releaseId) || manifest.releaseId.includes('..')) {
    fail(`invalid manifest releaseId: ${String(manifest.releaseId)}`)
  }

  const pubKey = publicKeyInput && publicKeyInput.trim().length > 0
    ? await resolvePublicKeyObject(publicKeyInput)
    : null

  let manifestSignatureVerified = false
  if (pubKey) {
    if (!manifest.manifestSignature) {
      fail('public key provided, but manifest.manifestSignature is missing')
    }
    const sigBytes = Buffer.from(manifest.manifestSignature, 'base64')
    const payload = Buffer.from(buildManifestSigningPayload(manifest), 'utf8')
    if (!cryptoVerify('sha256', payload, pubKey, sigBytes)) {
      fail('ECDSA SHA-256 manifest signature verification failed')
    }
    manifestSignatureVerified = true
  }

  const manifestDir = path.dirname(manifestPath)
  const versionName = manifest.versionName?.trim() || '0.0.0'

  if (action === 'rollback_to_embedded') {
    let chainVerified = false
    if (manifest.integrity) {
      const expectedReleaseHash = computeReleaseHash({
        prevReleaseHash: manifest.integrity.prevReleaseHash,
        appId: manifest.appId ?? '',
        channel: manifest.channel ?? 'production',
        runtimeVersion: manifest.runtimeVersion ?? '',
        releaseId: manifest.releaseId,
        versionName,
        manifestSeq: manifest.manifestSeq ?? 0,
        action: 'rollback_to_embedded',
        bundleSha256: '',
        merkleRoot: manifest.integrity.merkleRoot,
      })
      if (expectedReleaseHash !== manifest.integrity.releaseHash.toLowerCase()) {
        fail(`releaseHash mismatch: expected ${expectedReleaseHash}, got ${manifest.integrity.releaseHash}`)
      }
      const chainCandidate = [
        path.join(manifestDir, 'chain.json'),
        path.resolve(manifestDir, '../../chain.json'),
      ].find((candidate) => existsSync(candidate))
      if (chainCandidate) {
        const chain = await readOtaChain(chainCandidate)
        const chainRes = verifyReleaseChain(chain)
        if (!chainRes.valid) {
          fail(`OTA chain verification failed: ${chainRes.errors.join('; ')}`)
        }
        chainVerified = true
      }
    }
    return {
      manifestPath,
      bundlePath: '',
      releaseId: manifest.releaseId,
      versionName,
      action,
      format: 'embedded',
      sha256: '',
      size: 0,
      ...(manifest.integrity
        ? {
            merkleRoot: manifest.integrity.merkleRoot,
            releaseHash: manifest.integrity.releaseHash,
            prevReleaseHash: manifest.integrity.prevReleaseHash,
            chainIndex: manifest.integrity.chainIndex,
            chainMerkleRoot: manifest.integrity.chainMerkleRoot,
          }
        : {}),
      chainVerified,
      signatureVerified: manifestSignatureVerified,
      manifestSignatureVerified,
    }
  }

  if (!manifest.bundle || (manifest.bundle.format !== 'hbc' && manifest.bundle.format !== 'js')) {
    fail('manifest missing valid bundle.format ("hbc" | "js")')
  }
  if (!manifest.bundle.url || !manifest.bundle.sha256 || !/^[0-9a-fA-F]{64}$/.test(manifest.bundle.sha256)) {
    fail('manifest missing valid bundle.url or bundle.sha256')
  }

  const expectedRel = path.join('bundles', manifest.releaseId, `app.${manifest.bundle.format}`)
  const candidates = [
    path.resolve(manifestDir, manifest.bundle.url),
    path.join(manifestDir, expectedRel),
    path.join(manifestDir, `app.${manifest.bundle.format}`),
    path.resolve(manifestDir, '../..', manifest.bundle.url),
  ]
  if (/^https?:\/\//i.test(manifest.bundle.url)) {
    try {
      const parsed = new URL(manifest.bundle.url)
      const relPathname = parsed.pathname.replace(/^\/+/, '')
      candidates.unshift(path.join(manifestDir, relPathname))
    } catch {
      // Ignore malformed URL; fallback candidates still checked.
    }
  }

  const bundlePath = candidates.find((candidate) => existsSync(candidate))
  if (!bundlePath) {
    fail(`bundle file not found near ${manifestDir} for url=${manifest.bundle.url}`)
  }

  const bytes = Buffer.from(await readFile(bundlePath))
  if (bytes.length !== manifest.bundle.size) {
    fail(`bundle size mismatch: expected ${manifest.bundle.size}, got ${bytes.length}`)
  }
  const actualSha = createHash('sha256').update(bytes).digest('hex')
  if (actualSha !== manifest.bundle.sha256.toLowerCase()) {
    fail(`bundle sha256 mismatch: expected ${manifest.bundle.sha256}, got ${actualSha}`)
  }
  if (manifest.bundle.format === 'hbc') {
    if (bytes.length < HERMES_MAGIC.length || !bytes.subarray(0, 8).equals(HERMES_MAGIC)) {
      fail('bundle has .hbc format but lacks Hermes bytecode magic header')
    }
    if (manifest.bundle.hermesBytecodeVersion && bytes.length >= 12) {
      const actualHbcVer = bytes.readUInt32LE(8)
      if (actualHbcVer !== manifest.bundle.hermesBytecodeVersion) {
        fail(`Hermes bytecode version mismatch: manifest ${manifest.bundle.hermesBytecodeVersion}, got ${actualHbcVer}`)
      }
    }
  }

  let signatureVerified = false
  if (pubKey) {
    if (!manifest.bundle.signature) {
      fail('public key provided, but manifest.bundle.signature is missing')
    }
    const sigBytes = Buffer.from(manifest.bundle.signature, 'base64')
    if (!cryptoVerify('sha256', bytes, pubKey, sigBytes)) {
      fail('ECDSA SHA-256 bundle signature verification failed')
    }
    signatureVerified = true
  }

  let chainVerified = false
  if (manifest.integrity) {
    const computedTree = buildByteMerkleTree(bytes, manifest.integrity.chunkSize)
    if (computedTree.merkleRoot !== manifest.integrity.merkleRoot.toLowerCase()) {
      fail(
        `bundle merkleRoot mismatch: expected ${manifest.integrity.merkleRoot}, got ${computedTree.merkleRoot}`,
      )
    }
    if (computedTree.chunkCount !== manifest.integrity.chunkCount) {
      fail(
        `bundle chunkCount mismatch: expected ${manifest.integrity.chunkCount}, got ${computedTree.chunkCount}`,
      )
    }
    const merkleSiblingPath = path.join(path.dirname(bundlePath), 'merkle.json')
    if (existsSync(merkleSiblingPath)) {
      const merkleJson = JSON.parse(await readFile(merkleSiblingPath, 'utf8')) as ByteMerkleTree
      if (merkleJson.merkleRoot.toLowerCase() !== computedTree.merkleRoot) {
        fail(`merkle.json root mismatch: ${merkleJson.merkleRoot} != ${computedTree.merkleRoot}`)
      }
    }
    const expectedReleaseHash = computeReleaseHash({
      prevReleaseHash: manifest.integrity.prevReleaseHash,
      appId: manifest.appId ?? '',
      channel: manifest.channel ?? 'production',
      runtimeVersion: manifest.runtimeVersion ?? '',
      releaseId: manifest.releaseId,
      versionName,
      manifestSeq: manifest.manifestSeq ?? 0,
      action: 'update',
      bundleSha256: actualSha,
      merkleRoot: computedTree.merkleRoot,
    })
    if (expectedReleaseHash !== manifest.integrity.releaseHash.toLowerCase()) {
      fail(`releaseHash mismatch: expected ${expectedReleaseHash}, got ${manifest.integrity.releaseHash}`)
    }

    const chainCandidates = [
      path.join(manifestDir, 'chain.json'),
      path.resolve(manifestDir, '../../chain.json'),
    ]
    const chainCandidate = chainCandidates.find((p) => existsSync(p))
    if (chainCandidate) {
      const chain = await readOtaChain(chainCandidate)
      const chainRes = verifyReleaseChain(chain)
      if (!chainRes.valid) {
        fail(`OTA chain verification failed: ${chainRes.errors.join('; ')}`)
      }
      const chainLeaves = chain.entries.map((entry) => hashMerkleLeaf(Buffer.from(entry.releaseHash, 'hex')))
      const entry = chain.entries[manifest.integrity.chainIndex]
      if (!entry || entry.releaseId !== manifest.releaseId) {
        fail(`OTA chain entry #${manifest.integrity.chainIndex} does not match releaseId=${manifest.releaseId}`)
      }
      const proof = buildMerkleProof(chainLeaves, entry.index)
      if (!verifyMerkleProof(chainLeaves[entry.index], entry.index, proof, chain.chainMerkleRoot)) {
        fail(`OTA chain Merkle proof failed for release ${manifest.releaseId}`)
      }
      chainVerified = true
    }
  }

  return {
    manifestPath,
    bundlePath,
    releaseId: manifest.releaseId,
    versionName,
    action,
    format: manifest.bundle.format,
    sha256: actualSha,
    size: bytes.length,
    ...(manifest.integrity
      ? {
          merkleRoot: manifest.integrity.merkleRoot,
          releaseHash: manifest.integrity.releaseHash,
          prevReleaseHash: manifest.integrity.prevReleaseHash,
          chainIndex: manifest.integrity.chainIndex,
          chainMerkleRoot: manifest.integrity.chainMerkleRoot,
        }
      : {}),
    chainVerified,
    signatureVerified,
    manifestSignatureVerified,
  }
}

async function setupOtaAdbReverse(port: number, serial?: string): Promise<void> {
  try {
    let targetSerial = serial
    if (!targetSerial) {
      const devicesProc = Bun.spawn(['adb', 'devices'], { stdout: 'pipe', stderr: 'pipe' })
      const output = await new Response(devicesProc.stdout).text()
      await devicesProc.exited
      const online = output
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.endsWith('\tdevice'))
        .map((line) => line.split('\t')[0])
      if (online.length === 1) {
        targetSerial = online[0]
      } else if (online.length > 1) {
        process.stdout.write(`! 检测到 ${online.length} 台设备 (${online.join(', ')})，请传入设备序列号以自动执行 adb reverse。\n`)
        return
      } else {
        process.stdout.write(`! 未检测到在线 ADB 设备；接入后请执行: adb reverse tcp:${port} tcp:${port}\n`)
        return
      }
    }
    const proc = Bun.spawn(['adb', '-s', targetSerial, 'reverse', `tcp:${port}`, `tcp:${port}`], {
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const stderr = await new Response(proc.stderr).text()
    const code = await proc.exited
    if (code === 0) {
      process.stdout.write(`✓ adb reverse (${targetSerial}): tcp:${port} -> tcp:${port}\n`)
    } else {
      process.stdout.write(`! adb reverse 失败 (${targetSerial}): ${stderr.trim()}\n`)
    }
  } catch (error) {
    process.stdout.write(`! adb reverse 不可用: ${error instanceof Error ? error.message : String(error)}\n`)
  }
}

export async function serveOtaDirectory(options: ServeOtaOptions): Promise<void> {
  const rootDir = path.resolve(options.dir)
  if (!existsSync(rootDir)) {
    fail(`OTA directory does not exist: ${rootDir}`)
  }
  await setupOtaAdbReverse(options.port, options.serial)

  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: options.port,
    async fetch(req) {
      const url = new URL(req.url)
      const rel = decodeURIComponent(url.pathname).replace(/^\/+/, '') || 'manifest.json'
      const candidate = path.resolve(rootDir, rel)
      const relative = path.relative(rootDir, candidate)
      if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
        return new Response('Forbidden', { status: 403 })
      }
      const file = Bun.file(candidate)
      if (!(await file.exists())) {
        return new Response('Not Found', { status: 404 })
      }
      const contentType = candidate.endsWith('.json')
        ? 'application/json; charset=utf-8'
        : candidate.endsWith('.js')
          ? 'application/javascript; charset=utf-8'
          : 'application/octet-stream'
      return new Response(file, {
        status: 200,
        headers: {
          'Content-Type': contentType,
          'Cache-Control': 'no-store',
        },
      })
    },
  })

  process.stdout.write(
    `GPUIX OTA Server listening on http://127.0.0.1:${server.port}\n` +
      `  Manifest URL (for adb reverse device): http://127.0.0.1:${server.port}/manifest.json\n` +
      `  Serving directory: ${rootDir}\n`,
  )

  await new Promise<void>((resolve) => {
    const shutdown = () => {
      server.stop(true)
      resolve()
    }
    process.once('SIGINT', shutdown)
    process.once('SIGTERM', shutdown)
  })
}

export async function runOtaCommand(args: string[], defaultCwd: string): Promise<void> {
  const [sub, ...rest] = args
  if (!sub || sub === 'help' || sub === '--help' || sub === '-h') {
    process.stdout.write(`${otaUsage()}\n`)
    return
  }

  if (sub === 'keygen') {
    const parsed = parseOtaArgs(rest, new Set(['help']))
    if (parsed.flags.has('help') || parsed.positional.length > 0) {
      process.stdout.write(`${otaUsage()}\n`)
      return
    }
    const outDir = path.resolve(parsed.values.get('out') ?? path.join(defaultCwd, '.gpuix-ota-keys'))
    const res = await keygenOta({ outDir })
    process.stdout.write(
      `Generated ECDSA P-256 OTA keypair in ${res.outDir}:\n` +
        `  Private key (keep secret!): ${res.privateKeyPath}\n` +
        `  Public PEM:                 ${res.publicKeyPemPath}\n` +
        `  Public SPKI Base64:         ${res.publicKeyB64Path}\n` +
        `\nAdd to gpuix.config.json -> ota.publicKey:\n  ${res.publicKeyBase64}\n`,
    )
    return
  }

  if (sub === 'build') {
    const parsed = parseOtaArgs(rest, new Set(['mandatory', 'no-hbc', 'debug', 'rollback-to-embedded', 'help']))
    if (parsed.flags.has('help') || parsed.positional.length > 0) {
      process.stdout.write(`${otaUsage()}\n`)
      return
    }
    const rawSeq = parsed.values.get('seq')
    const manifestSeq = rawSeq !== undefined ? Number(rawSeq) : undefined
    if (rawSeq !== undefined && (!Number.isSafeInteger(manifestSeq) || (manifestSeq ?? 0) < 1)) {
      fail(`invalid --seq value: ${rawSeq}`)
    }
    const rawChunk = parsed.values.get('chunk-size')
    const chunkSize = rawChunk !== undefined ? Number(rawChunk) : undefined
    const rawPlatform = parsed.values.get('platform')
    if (rawPlatform !== undefined && rawPlatform !== 'android' && rawPlatform !== 'ios' && rawPlatform !== 'all') {
      fail(`invalid --platform value: ${rawPlatform} (expected android|ios|all)`)
    }
    const projectRoot = path.resolve(parsed.values.get('cwd') ?? defaultCwd)
    const res = await buildOtaRelease({
      projectRoot,
      outDir: parsed.values.get('out'),
      channel: parsed.values.get('channel'),
      platform: rawPlatform as OtaTargetPlatform | undefined,
      versionName: parsed.values.get('version'),
      runtimeVersion: parsed.values.get('runtime-version'),
      releaseId: parsed.values.get('release-id'),
      baseUrl: parsed.values.get('base-url'),
      mandatory: parsed.flags.has('mandatory'),
      notes: parsed.values.get('notes'),
      privateKey: parsed.values.get('private-key'),
      skipHbc: parsed.flags.has('no-hbc'),
      debug: parsed.flags.has('debug'),
      manifestSeq,
      chunkSize,
      chainPath: parsed.values.get('chain'),
      action: parsed.flags.has('rollback-to-embedded') ? 'rollback_to_embedded' : 'update',
    })
    const integrity = res.manifest.integrity!
    if (res.manifest.action === 'rollback_to_embedded') {
      process.stdout.write(
        `✓ Built OTA kill-switch manifest ${res.manifest.releaseId} (v${res.manifest.versionName}, seq=${res.manifest.manifestSeq})\n` +
          `  Manifest:    ${res.manifestPath}\n` +
          `  Chain:       ${res.chainPath} (#${integrity.chainIndex})\n` +
          `  ReleaseHash: ${integrity.releaseHash}\n` +
          `  PrevHash:    ${integrity.prevReleaseHash}\n` +
          `  ChainRoot:   ${integrity.chainMerkleRoot}\n` +
          `  Signed:      yes (ECDSA P-256 v2)\n`,
      )
      return
    }
    process.stdout.write(
      `✓ Built OTA release ${res.manifest.releaseId} (v${res.manifest.versionName}, ${res.manifest.bundle?.format}, ${res.manifest.bundle?.size} B)\n` +
        `  Bundle:      ${res.bundlePath}\n` +
        `  Manifest:    ${res.manifestPath}\n` +
        `  Merkle:      ${res.merklePath} (${integrity.chunkCount} chunks x ${integrity.chunkSize} B)\n` +
        `  Chain:       ${res.chainPath} (#${integrity.chainIndex})\n` +
        `  BundleSHA:   ${res.manifest.bundle?.sha256}\n` +
        `  MerkleRoot:  ${integrity.merkleRoot}\n` +
        `  ReleaseHash: ${integrity.releaseHash}\n` +
        `  PrevHash:    ${integrity.prevReleaseHash}\n` +
        `  ChainRoot:   ${integrity.chainMerkleRoot}\n` +
        `  Seq:         ${res.manifest.manifestSeq}\n` +
        `  Signed:      ${res.manifest.manifestSignature && res.manifest.bundle?.signature ? 'yes (ECDSA P-256 v2)' : 'no'}\n`,
    )
    return
  }

  if (sub === 'verify') {
    const parsed = parseOtaArgs(rest, new Set(['help']))
    if (parsed.flags.has('help') || parsed.positional.length !== 1) {
      fail('verify requires exactly one <MANIFEST_PATH>')
    }
    const res = await verifyOtaRelease(parsed.positional[0], parsed.values.get('public-key'))
    process.stdout.write(
      `✓ Verified OTA release ${res.releaseId} (v${res.versionName}, ${res.action}, ${res.format}, ${res.size} B)\n` +
        (res.bundlePath ? `  Bundle:      ${res.bundlePath}\n  BundleSHA:   ${res.sha256}\n` : '') +
        (res.merkleRoot ? `  MerkleRoot:  ${res.merkleRoot}\n` : '') +
        (res.releaseHash ? `  ReleaseHash: ${res.releaseHash} (prev=${res.prevReleaseHash?.slice(0, 12)}..., #${res.chainIndex})\n` : '') +
        (res.chainMerkleRoot ? `  ChainRoot:   ${res.chainMerkleRoot} (chainVerified=${res.chainVerified})\n` : '') +
        `  Signature:   ${res.signatureVerified ? 'verified' : 'skipped (no --public-key)'}` +
        `${res.manifestSignatureVerified ? ' (+manifestSignature)' : ''}\n`,
    )
    return
  }

  if (sub === 'chain') {
    const parsed = parseOtaArgs(rest, new Set(['verify', 'json', 'help']))
    if (parsed.flags.has('help') || parsed.positional.length > 0) {
      process.stdout.write(`${otaUsage()}\n`)
      return
    }
    const projectRoot = path.resolve(parsed.values.get('cwd') ?? defaultCwd)
    const dir = path.resolve(parsed.values.get('dir') ?? path.join(projectRoot, 'dist/ota'))
    const chainPath = path.join(dir, 'chain.json')
    const chain = await readOtaChain(chainPath)
    const check = verifyReleaseChain(chain)
    if (parsed.flags.has('verify') && !check.valid) {
      if (parsed.flags.has('json')) {
        process.stdout.write(`${JSON.stringify({ chain, verification: check }, null, 2)}\n`)
      } else {
        process.stderr.write(`✗ OTA chain verification failed:\n  - ${check.errors.join('\n  - ')}\n`)
      }
      process.exitCode = 1
      return
    }
    if (parsed.flags.has('json')) {
      process.stdout.write(`${JSON.stringify({ chain, verification: check }, null, 2)}\n`)
      return
    }
    process.stdout.write(
      `GPUIX OTA Hash Chain · ${chain.appId} [${chain.channel}]\n` +
        `  Entries:    ${chain.entries.length}\n` +
        `  HeadHash:   ${chain.headHash}\n` +
        `  ChainRoot:  ${chain.chainMerkleRoot}\n` +
        `  Integrity:  ${check.valid ? 'VALID' : `INVALID (${check.errors.length} error(s))`}\n`,
    )
    for (const entry of chain.entries) {
      process.stdout.write(
        `  #${entry.index} v${entry.versionName} (${entry.releaseId}) seq=${entry.manifestSeq} ` +
          `hash=${entry.releaseHash.slice(0, 12)} prev=${entry.prevReleaseHash.slice(0, 12)} ` +
          `merkle=${entry.merkleRoot.slice(0, 12)} (${entry.chunkCount}c)\n`,
      )
    }
    return
  }

  if (sub === 'proof') {
    const parsed = parseOtaArgs(rest, new Set(['json', 'help']))
    if (parsed.flags.has('help') || parsed.positional.length !== 1) {
      fail('proof requires <RELEASE_ID_OR_HASH>')
    }
    const projectRoot = path.resolve(parsed.values.get('cwd') ?? defaultCwd)
    const dir = path.resolve(parsed.values.get('dir') ?? path.join(projectRoot, 'dist/ota'))
    const rawChunk = parsed.values.get('chunk')
    const chunkIndex = rawChunk !== undefined ? Number(rawChunk) : undefined
    const res = await generateOtaProof({
      dir,
      query: parsed.positional[0],
      chunkIndex,
    })
    if (parsed.flags.has('json')) {
      process.stdout.write(`${JSON.stringify(res, null, 2)}\n`)
      return
    }
    process.stdout.write(
      `✓ OTA Merkle Proof (${res.kind}) · ${res.releaseId} v${res.versionName} [#${res.index}]\n` +
        `  LeafHash: ${res.leafHash}\n` +
        `  RootHash: ${res.rootHash}\n` +
        `  Steps:    ${res.proof.length}\n` +
        `  Verified: ${res.verified}\n`,
    )
    for (const [i, step] of res.proof.entries()) {
      process.stdout.write(`    [${i}] ${step.position.padEnd(5)} ${step.hash}\n`)
    }
    return
  }

  if (sub === 'locate') {
    const parsed = parseOtaArgs(rest, new Set(['json', 'help']))
    if (parsed.flags.has('help') || parsed.positional.length !== 1) {
      fail('locate requires <QUERY> (releaseId, versionName, index, or SHA-256 hash prefix)')
    }
    const projectRoot = path.resolve(parsed.values.get('cwd') ?? defaultCwd)
    const dir = path.resolve(parsed.values.get('dir') ?? path.join(projectRoot, 'dist/ota'))
    const chain = await readOtaChain(path.join(dir, 'chain.json'))
    const matches: OtaChainEntry[] = locateChainEntries(chain, parsed.positional[0])
    if (parsed.flags.has('json')) {
      process.stdout.write(`${JSON.stringify({ query: parsed.positional[0], matches }, null, 2)}\n`)
      return
    }
    if (matches.length === 0) {
      fail(`no OTA release matched "${parsed.positional[0]}"`)
    }
    process.stdout.write(`Matched ${matches.length} OTA release(s) for "${parsed.positional[0]}":\n`)
    for (const item of matches) {
      process.stdout.write(
        `  #${item.index} v${item.versionName} · ${item.releaseId} [${item.platform}/${item.bundleFormat}]\n` +
          `    ReleaseHash: ${item.releaseHash}\n` +
          `    PrevHash:    ${item.prevReleaseHash}\n` +
          `    MerkleRoot:  ${item.merkleRoot} (${item.chunkCount} chunks)\n` +
          `    BundleSHA:   ${item.bundleSha256 || '<embedded>'}\n` +
          `    Paths:       manifest=${path.join(dir, item.manifestPath)}${item.bundlePath ? ` bundle=${path.join(dir, item.bundlePath)}` : ''}\n`,
      )
    }
    return
  }

  if (sub === 'serve') {
    const parsed = parseOtaArgs(rest, new Set(['help']))
    if (parsed.flags.has('help') || parsed.positional.length > 1) {
      fail('serve accepts at most one [ADB_SERIAL]')
    }
    const projectRoot = path.resolve(parsed.values.get('cwd') ?? defaultCwd)
    const dir = path.resolve(parsed.values.get('dir') ?? path.join(projectRoot, 'dist/ota'))
    const rawPort = parsed.values.get('port') ?? '8787'
    const port = Number(rawPort)
    if (!Number.isSafeInteger(port) || port < 1 || port > 65535) {
      fail(`invalid --port value: ${rawPort}`)
    }
    await serveOtaDirectory({
      projectRoot,
      dir,
      port,
      serial: parsed.positional[0],
    })
    return
  }

  fail(`unknown subcommand "${sub}"\n\n${otaUsage()}`)
}
