import { createHash } from 'node:crypto'

export const DEFAULT_OTA_CHUNK_SIZE = 65536
export const GENESIS_RELEASE_HASH = '0'.repeat(64)
const HEX64_PATTERN = /^[0-9a-f]{64}$/i

export type MerkleProofStep = {
  position: 'left' | 'right'
  hash: string
}

export type ByteMerkleTree = {
  algorithm: 'sha256'
  chunkSize: number
  chunkCount: number
  leafHashes: string[]
  merkleRoot: string
}

export type HashMerkleTree = {
  algorithm: 'sha256'
  leafHashes: string[]
  merkleRoot: string
}

export type ReleaseHashInput = {
  prevReleaseHash: string
  appId: string
  channel: string
  runtimeVersion: string
  releaseId: string
  versionName: string
  manifestSeq: number
  action: 'update' | 'rollback_to_embedded'
  bundleSha256: string
  merkleRoot: string
}

export type OtaChainEntry = {
  index: number
  releaseId: string
  versionName: string
  platform: 'android' | 'ios' | 'all'
  action: 'update' | 'rollback_to_embedded'
  runtimeVersion: string
  manifestSeq: number
  publishedAt: string
  bundleFormat: 'hbc' | 'js' | 'embedded'
  bundleSize: number
  bundleSha256: string
  chunkSize: number
  chunkCount: number
  merkleRoot: string
  prevReleaseHash: string
  releaseHash: string
  manifestPath: string
  bundlePath: string
  merklePath?: string
}

export type OtaReleaseChain = {
  schemaVersion: 1
  algorithm: 'sha256'
  appId: string
  channel: string
  genesisHash: string
  headHash: string
  chainMerkleRoot: string
  entries: OtaChainEntry[]
}

export type ChainVerificationResult = {
  valid: boolean
  errors: string[]
  entryCount: number
  headHash: string
  chainMerkleRoot: string
}

export function sha256Hex(data: Uint8Array | string): string {
  return createHash('sha256').update(data).digest('hex')
}

/** RFC 6962 domain-separated leaf hash: SHA-256(0x00 || payload). */
export function hashMerkleLeaf(data: Uint8Array): string {
  const hash = createHash('sha256')
  hash.update(Buffer.from([0x00]))
  hash.update(data)
  return hash.digest('hex')
}

/** RFC 6962 domain-separated interior node hash: SHA-256(0x01 || left || right). */
export function hashMerkleNode(leftHex: string, rightHex: string): string {
  const normalizedLeft = leftHex.trim().toLowerCase()
  const normalizedRight = rightHex.trim().toLowerCase()
  if (!HEX64_PATTERN.test(normalizedLeft) || !HEX64_PATTERN.test(normalizedRight)) {
    throw new Error('Merkle node hashes must be 64-char SHA-256 hex strings')
  }
  const hash = createHash('sha256')
  hash.update(Buffer.from([0x01]))
  hash.update(Buffer.from(normalizedLeft, 'hex'))
  hash.update(Buffer.from(normalizedRight, 'hex'))
  return hash.digest('hex')
}

function buildTreeLevels(leafHashes: string[]): string[][] {
  if (leafHashes.length === 0) {
    return [[hashMerkleLeaf(new Uint8Array(0))]]
  }
  const levels: string[][] = [leafHashes.map((h) => h.toLowerCase())]
  while (levels[levels.length - 1].length > 1) {
    const current = levels[levels.length - 1]
    const next: string[] = []
    for (let i = 0; i < current.length; i += 2) {
      const left = current[i]
      const right = i + 1 < current.length ? current[i + 1] : current[i]
      next.push(hashMerkleNode(left, right))
    }
    levels.push(next)
  }
  return levels
}

export function buildMerkleFromLeafHashes(leafHashes: string[]): HashMerkleTree {
  const normalized = leafHashes.map((h) => {
    const lower = h.trim().toLowerCase()
    if (!HEX64_PATTERN.test(lower)) {
      throw new Error(`Invalid SHA-256 leaf hash: ${h}`)
    }
    return lower
  })
  const levels = buildTreeLevels(normalized)
  return {
    algorithm: 'sha256',
    leafHashes: normalized,
    merkleRoot: levels[levels.length - 1][0],
  }
}

export function buildByteMerkleTree(
  bytes: Uint8Array,
  chunkSize = DEFAULT_OTA_CHUNK_SIZE,
): ByteMerkleTree {
  if (!Number.isSafeInteger(chunkSize) || chunkSize < 1) {
    throw new Error(`Invalid Merkle chunkSize: ${String(chunkSize)}`)
  }
  if (bytes.length === 0) {
    return {
      algorithm: 'sha256',
      chunkSize,
      chunkCount: 0,
      leafHashes: [],
      merkleRoot: hashMerkleLeaf(new Uint8Array(0)),
    }
  }
  const leafHashes: string[] = []
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    leafHashes.push(hashMerkleLeaf(bytes.subarray(offset, Math.min(bytes.length, offset + chunkSize))))
  }
  const tree = buildMerkleFromLeafHashes(leafHashes)
  return {
    algorithm: 'sha256',
    chunkSize,
    chunkCount: leafHashes.length,
    leafHashes: tree.leafHashes,
    merkleRoot: tree.merkleRoot,
  }
}

export function buildHashMerkleTree(hashes: string[]): HashMerkleTree {
  const leafHashes = hashes.map((raw) => {
    const lower = raw.trim().toLowerCase()
    if (!HEX64_PATTERN.test(lower)) {
      throw new Error(`Invalid SHA-256 hash entry: ${raw}`)
    }
    return hashMerkleLeaf(Buffer.from(lower, 'hex'))
  })
  return buildMerkleFromLeafHashes(leafHashes)
}

export function buildMerkleProof(leafHashes: string[], index: number): MerkleProofStep[] {
  if (!Number.isSafeInteger(index) || index < 0 || index >= leafHashes.length) {
    throw new Error(`Merkle proof index ${index} out of bounds for ${leafHashes.length} leaves`)
  }
  const levels = buildTreeLevels(leafHashes)
  const proof: MerkleProofStep[] = []
  let cursor = index
  for (let levelIndex = 0; levelIndex < levels.length - 1; levelIndex += 1) {
    const level = levels[levelIndex]
    const isRight = (cursor & 1) === 1
    const siblingIndex = isRight ? cursor - 1 : cursor + 1 < level.length ? cursor + 1 : cursor
    proof.push({
      position: isRight ? 'left' : 'right',
      hash: level[siblingIndex],
    })
    cursor = Math.floor(cursor / 2)
  }
  return proof
}

export function verifyMerkleProof(
  leafHash: string,
  index: number,
  proof: MerkleProofStep[],
  expectedRoot: string,
): boolean {
  if (!Number.isSafeInteger(index) || index < 0) return false
  const normalizedLeaf = leafHash.trim().toLowerCase()
  const normalizedRoot = expectedRoot.trim().toLowerCase()
  if (!HEX64_PATTERN.test(normalizedLeaf) || !HEX64_PATTERN.test(normalizedRoot)) return false

  let current = normalizedLeaf
  let cursor = index
  for (const step of proof) {
    const sibling = step.hash.trim().toLowerCase()
    if (!HEX64_PATTERN.test(sibling)) return false
    const isRight = (cursor & 1) === 1
    if (isRight) {
      if (step.position !== 'left') return false
      current = hashMerkleNode(sibling, current)
    } else {
      if (step.position !== 'right') return false
      current = hashMerkleNode(current, sibling)
    }
    cursor = Math.floor(cursor / 2)
  }
  return cursor === 0 && current === normalizedRoot
}

export function buildReleaseChainPayload(input: ReleaseHashInput): string {
  return [
    'gpuix-ota-chain-v1',
    `prevReleaseHash=${input.prevReleaseHash.trim().toLowerCase()}`,
    `appId=${input.appId.trim()}`,
    `channel=${input.channel.trim()}`,
    `runtimeVersion=${input.runtimeVersion.trim()}`,
    `releaseId=${input.releaseId.trim()}`,
    `versionName=${input.versionName.trim()}`,
    `manifestSeq=${input.manifestSeq}`,
    `action=${input.action}`,
    `bundleSha256=${input.bundleSha256.trim().toLowerCase()}`,
    `merkleRoot=${input.merkleRoot.trim().toLowerCase()}`,
    '',
  ].join('\n')
}

export function computeReleaseHash(input: ReleaseHashInput): string {
  return sha256Hex(Buffer.from(buildReleaseChainPayload(input), 'utf8'))
}

export function createEmptyReleaseChain(appId: string, channel: string): OtaReleaseChain {
  const emptyTree = buildHashMerkleTree([])
  return {
    schemaVersion: 1,
    algorithm: 'sha256',
    appId,
    channel,
    genesisHash: GENESIS_RELEASE_HASH,
    headHash: GENESIS_RELEASE_HASH,
    chainMerkleRoot: emptyTree.merkleRoot,
    entries: [],
  }
}

export function appendReleaseChainEntry(
  chain: OtaReleaseChain,
  entryWithoutLink: Omit<OtaChainEntry, 'index' | 'prevReleaseHash' | 'releaseHash'>,
): OtaReleaseChain {
  const index = chain.entries.length
  const prevReleaseHash = index === 0 ? chain.genesisHash : chain.entries[index - 1].releaseHash
  const releaseHash = computeReleaseHash({
    prevReleaseHash,
    appId: chain.appId,
    channel: chain.channel,
    runtimeVersion: entryWithoutLink.runtimeVersion,
    releaseId: entryWithoutLink.releaseId,
    versionName: entryWithoutLink.versionName,
    manifestSeq: entryWithoutLink.manifestSeq,
    action: entryWithoutLink.action,
    bundleSha256: entryWithoutLink.bundleSha256,
    merkleRoot: entryWithoutLink.merkleRoot,
  })
  const nextEntry: OtaChainEntry = {
    ...entryWithoutLink,
    index,
    prevReleaseHash,
    releaseHash,
  }
  const entries = [...chain.entries, nextEntry]
  const tree = buildHashMerkleTree(entries.map((entry) => entry.releaseHash))
  return {
    ...chain,
    headHash: releaseHash,
    chainMerkleRoot: tree.merkleRoot,
    entries,
  }
}

export function verifyReleaseChain(chain: OtaReleaseChain): ChainVerificationResult {
  const errors: string[] = []
  if (chain.schemaVersion !== 1) {
    errors.push(`Unsupported chain schemaVersion: ${String(chain.schemaVersion)}`)
  }
  if (!HEX64_PATTERN.test(chain.genesisHash)) {
    errors.push(`Invalid genesisHash: ${chain.genesisHash}`)
  }

  let expectedPrev = chain.genesisHash.toLowerCase()
  for (let i = 0; i < chain.entries.length; i += 1) {
    const entry = chain.entries[i]
    if (entry.index !== i) {
      errors.push(`Entry ${entry.releaseId} index mismatch: expected ${i}, got ${entry.index}`)
    }
    if (entry.prevReleaseHash.toLowerCase() !== expectedPrev) {
      errors.push(
        `Entry #${i} (${entry.releaseId}) broken prevReleaseHash link: expected ${expectedPrev}, got ${entry.prevReleaseHash}`,
      )
    }
    const recomputed = computeReleaseHash({
      prevReleaseHash: entry.prevReleaseHash,
      appId: chain.appId,
      channel: chain.channel,
      runtimeVersion: entry.runtimeVersion,
      releaseId: entry.releaseId,
      versionName: entry.versionName,
      manifestSeq: entry.manifestSeq,
      action: entry.action,
      bundleSha256: entry.bundleSha256,
      merkleRoot: entry.merkleRoot,
    })
    if (recomputed !== entry.releaseHash.toLowerCase()) {
      errors.push(
        `Entry #${i} (${entry.releaseId}) releaseHash mismatch: expected ${recomputed}, got ${entry.releaseHash}`,
      )
    }
    expectedPrev = entry.releaseHash.toLowerCase()
  }

  const expectedHead =
    chain.entries.length > 0
      ? chain.entries[chain.entries.length - 1].releaseHash.toLowerCase()
      : chain.genesisHash.toLowerCase()
  if (chain.headHash.toLowerCase() !== expectedHead) {
    errors.push(`Chain headHash mismatch: expected ${expectedHead}, got ${chain.headHash}`)
  }

  let computedRoot = ''
  try {
    computedRoot = buildHashMerkleTree(chain.entries.map((entry) => entry.releaseHash)).merkleRoot
    if (chain.chainMerkleRoot.toLowerCase() !== computedRoot) {
      errors.push(
        `Chain chainMerkleRoot mismatch: expected ${computedRoot}, got ${chain.chainMerkleRoot}`,
      )
    }
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error))
  }

  return {
    valid: errors.length === 0,
    errors,
    entryCount: chain.entries.length,
    headHash: expectedHead,
    chainMerkleRoot: computedRoot || chain.chainMerkleRoot,
  }
}

export function locateChainEntries(chain: OtaReleaseChain, rawQuery: string): OtaChainEntry[] {
  const q = rawQuery.trim()
  if (!q) return []
  const lower = q.toLowerCase()
  const versionStripped = lower.startsWith('v') ? lower.slice(1) : lower
  const hexLike = /^[0-9a-f]{4,64}$/i.test(lower)

  const directMatches = chain.entries.filter((entry) => {
    if (entry.releaseId === q || entry.releaseId.toLowerCase() === lower) return true
    if (entry.versionName.toLowerCase() === lower || entry.versionName.toLowerCase() === versionStripped) {
      return true
    }
    if (/^#?\d+$/.test(q) && entry.index === Number(q.replace(/^#/, ''))) return true
    if (hexLike) {
      return (
        entry.releaseHash.toLowerCase().startsWith(lower) ||
        entry.bundleSha256.toLowerCase().startsWith(lower) ||
        entry.merkleRoot.toLowerCase().startsWith(lower)
      )
    }
    return false
  })

  if (directMatches.length > 0 || !hexLike) {
    return directMatches
  }
  return chain.entries.filter((entry) => entry.prevReleaseHash.toLowerCase().startsWith(lower))
}
