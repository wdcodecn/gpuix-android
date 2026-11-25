import { describe, expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { loadGpuixAndroidConfig, loadGpuixConfig, normalizeOtaPublicKey, resolveOtaConfig } from '../../scripts/config'
import { formatOtaMetaKv } from '../../scripts/bundler'
import {
  buildByteMerkleTree,
  buildMerkleProof,
  locateChainEntries,
  verifyMerkleProof,
  verifyReleaseChain,
} from '../ota-integrity'
import {
  buildManifestSigningPayload,
  buildOtaRelease,
  generateOtaProof,
  keygenOta,
  readOtaChain,
  verifyOtaRelease,
} from '../ota'

function makeTempProject(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'gpuix-ota-test-'))
  mkdirSync(path.join(dir, 'src'), { recursive: true })
  writeFileSync(
    path.join(dir, 'src/main.tsx'),
    'export function App() { return "hello ota" }\nconsole.log(App());\n',
  )
  writeFileSync(
    path.join(dir, 'gpuix.android.json'),
    JSON.stringify(
      {
        entrypoint: 'src/main.tsx',
        appId: 'dev.gpuix.otatest',
        appName: 'OTA Test',
        versionName: '1.2.3',
        versionCode: 42,
        ota: {
          manifestUrl: 'https://cdn.example.com/ota/manifest.json',
          channel: 'staging',
          runtimeVersion: '42',
          checkOnLaunch: 'background',
        },
      },
      null,
      2,
    ),
  )
  return dir
}

describe('OTA config parsing & metadata', () => {
  test('parses valid ota configuration and resolves defaults', async () => {
    const dir = makeTempProject()
    try {
      const config = await loadGpuixAndroidConfig(dir)
      expect(config.ota).toEqual({
        manifestUrl: 'https://cdn.example.com/ota/manifest.json',
        channel: 'staging',
        runtimeVersion: '42',
        checkOnLaunch: 'background',
      })
      const meta = formatOtaMetaKv(config, 'hbc', 'a'.repeat(64))
      expect(meta).toContain('app_id=dev.gpuix.otatest\n')
      expect(meta).toContain('version_code=42\n')
      expect(meta).toContain('runtime_version=42\n')
      expect(meta).toContain('channel=staging\n')
      expect(meta).toContain('check_on_launch=background\n')
      expect(meta).toContain('embedded_format=hbc\n')
      expect(meta).toContain(`embedded_build_id=${'a'.repeat(64)}\n`)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('normalizes PEM SPKI public key to single-line base64', () => {
    const fakeDer = Buffer.alloc(64, 0x30).toString('base64')
    const pem = `-----BEGIN PUBLIC KEY-----\n${fakeDer.slice(0, 32)}\n${fakeDer.slice(32)}\n-----END PUBLIC KEY-----\n`
    expect(normalizeOtaPublicKey(pem)).toBe(fakeDer)
  })

  test('rejects invalid channel, manifestUrl scheme, and checkOnLaunch', async () => {
    const dir = makeTempProject()
    try {
      writeFileSync(
        path.join(dir, 'gpuix.android.json'),
        JSON.stringify({
          entrypoint: 'src/main.tsx',
          appId: 'dev.gpuix.otatest',
          appName: 'OTA Test',
          versionName: '1.0.0',
          versionCode: 1,
          ota: { channel: '../bad' },
        }),
      )
      await expect(loadGpuixAndroidConfig(dir)).rejects.toThrow('ota.channel')

      writeFileSync(
        path.join(dir, 'gpuix.android.json'),
        JSON.stringify({
          entrypoint: 'src/main.tsx',
          appId: 'dev.gpuix.otatest',
          appName: 'OTA Test',
          versionName: '1.0.0',
          versionCode: 1,
          ota: { manifestUrl: 'ftp://example.com/manifest.json' },
        }),
      )
      await expect(loadGpuixAndroidConfig(dir)).rejects.toThrow('ota.manifestUrl')

      writeFileSync(
        path.join(dir, 'gpuix.android.json'),
        JSON.stringify({
          entrypoint: 'src/main.tsx',
          appId: 'dev.gpuix.otatest',
          appName: 'OTA Test',
          versionName: '1.0.0',
          versionCode: 1,
          ota: { checkOnLaunch: 'invalid' },
        }),
      )
      await expect(loadGpuixAndroidConfig(dir)).rejects.toThrow('ota.checkOnLaunch')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('resolveOtaConfig provides production defaults when ota block is absent', () => {
    const resolved = resolveOtaConfig({
      entrypoint: 'src/main.tsx',
      appId: 'dev.gpuix.app',
      appName: 'App',
      versionName: '1.0.0',
      versionCode: 7,
    })
    expect(resolved).toEqual({
      channel: 'production',
      runtimeVersion: '7',
      checkOnLaunch: 'manual',
    })
  })
})

describe('OTA keygen, build, verify & JVM cross-verification', () => {
  test('builds signed release, verifies it, and detects tampering or wrong key', async () => {
    const dir = makeTempProject()
    const keysDir = path.join(dir, 'keys')
    const outDir = path.join(dir, 'dist/ota')
    try {
      const keys = await keygenOta({ outDir: keysDir })
      expect(normalizeOtaPublicKey(readFileSync(keys.publicKeyPemPath, 'utf8'))).toBe(keys.publicKeyBase64)

      const built = await buildOtaRelease({
        projectRoot: dir,
        outDir,
        releaseId: 'rel-test-1',
        baseUrl: 'https://cdn.example.com/app',
        privateKey: keys.privateKeyPath,
        notes: 'signed build test',
        skipHbc: true,
      })

      expect(built.manifest.schemaVersion).toBe(1)
      expect(built.manifest.releaseId).toBe('rel-test-1')
      expect(built.manifest.bundle?.format).toBe('js')
      expect(built.manifest.bundle?.url).toBe('https://cdn.example.com/app/bundles/rel-test-1/app.js')
      expect(built.manifest.bundle?.signature).toBeTruthy()
      expect(built.manifest.manifestSignature).toBeTruthy()
      expect((built.manifest.manifestSeq ?? 0) > 0).toBe(true)

      const verified = await verifyOtaRelease(built.manifestPath, keys.publicKeyB64Path)
      expect(verified.signatureVerified).toBe(true)
      expect(verified.manifestSignatureVerified).toBe(true)
      expect(verified.releaseId).toBe('rel-test-1')

      // Wrong key must fail verification.
      const otherKeys = await keygenOta({ outDir: path.join(dir, 'other-keys') })
      await expect(verifyOtaRelease(built.manifestPath, otherKeys.publicKeyBase64)).rejects.toThrow('verification failed')

      // Tampering manifest metadata (channel, minVersionCode, mandatory, releaseId) must fail verification.
      const savedManifestJson = readFileSync(built.manifestPath, 'utf8')
      const tamperedChannel = { ...built.manifest, channel: 'production' }
      writeFileSync(built.manifestPath, JSON.stringify(tamperedChannel, null, 2))
      await expect(verifyOtaRelease(built.manifestPath, keys.publicKeyBase64)).rejects.toThrow('manifest signature verification failed')

      const tamperedMinVersion = { ...built.manifest, minVersionCode: 999 }
      writeFileSync(built.manifestPath, JSON.stringify(tamperedMinVersion, null, 2))
      await expect(verifyOtaRelease(built.manifestPath, keys.publicKeyBase64)).rejects.toThrow('manifest signature verification failed')

      const tamperedMandatory = { ...built.manifest, mandatory: true }
      writeFileSync(built.manifestPath, JSON.stringify(tamperedMandatory, null, 2))
      await expect(verifyOtaRelease(built.manifestPath, keys.publicKeyBase64)).rejects.toThrow('manifest signature verification failed')

      const tamperedReleaseId = { ...built.manifest, releaseId: 'rel-spoofed' }
      writeFileSync(built.manifestPath, JSON.stringify(tamperedReleaseId, null, 2))
      await expect(verifyOtaRelease(built.manifestPath, keys.publicKeyBase64)).rejects.toThrow('manifest signature verification failed')

      const missingManifestSig = { ...built.manifest, manifestSignature: undefined }
      writeFileSync(built.manifestPath, JSON.stringify(missingManifestSig, null, 2))
      await expect(verifyOtaRelease(built.manifestPath, keys.publicKeyBase64)).rejects.toThrow('manifestSignature is missing')

      // Restore manifest and verify bundle tampering still fails SHA-256 verification.
      writeFileSync(built.manifestPath, savedManifestJson)
      const original = readFileSync(built.bundlePath, 'utf8')
      writeFileSync(built.bundlePath, `${original}\n/*tampered*/\n`)
      await expect(verifyOtaRelease(built.manifestPath, keys.publicKeyBase64)).rejects.toThrow()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('signature generated by Bun crypto is accepted by Java SHA256withECDSA for both bundle and manifest', async () => {
    const hasJavac = Bun.which('javac')
    const hasJava = Bun.which('java')
    if (!hasJavac || !hasJava) return

    const dir = makeTempProject()
    const keysDir = path.join(dir, 'keys')
    const outDir = path.join(dir, 'dist/ota')
    const killOutDir = path.join(dir, 'dist/kill')
    try {
      const keys = await keygenOta({ outDir: keysDir })
      const built = await buildOtaRelease({
        projectRoot: dir,
        outDir,
        releaseId: 'rel-jvm-1',
        manifestSeq: 1001,
        privateKey: keys.privateKeyPath,
        skipHbc: true,
      })

      const killSwitch = await buildOtaRelease({
        projectRoot: dir,
        outDir: killOutDir,
        releaseId: 'kill-1002',
        manifestSeq: 1002,
        action: 'rollback_to_embedded',
        privateKey: keys.privateKeyPath,
      })
      expect(killSwitch.manifest.action).toBe('rollback_to_embedded')
      expect(killSwitch.manifest.manifestSignature).toBeTruthy()
      const killVerified = await verifyOtaRelease(killSwitch.manifestPath, keys.publicKeyBase64)
      expect(killVerified.manifestSignatureVerified).toBe(true)

      const javaFile = path.join(dir, 'VerifyOtaSig.java')
      writeFileSync(
        javaFile,
        `import java.nio.file.Files;
import java.nio.file.Paths;
import java.security.KeyFactory;
import java.security.PublicKey;
import java.security.Signature;
import java.security.spec.X509EncodedKeySpec;
import java.util.Base64;

public class VerifyOtaSig {
  public static void main(String[] args) throws Exception {
    byte[] keyBytes = Base64.getDecoder().decode(args[0]);
    byte[] sigBytes = Base64.getDecoder().decode(args[1]);
    byte[] dataBytes = Files.readAllBytes(Paths.get(args[2]));
    KeyFactory kf = KeyFactory.getInstance("EC");
    PublicKey pk = kf.generatePublic(new X509EncodedKeySpec(keyBytes));
    Signature sig = Signature.getInstance("SHA256withECDSA");
    sig.initVerify(pk);
    sig.update(dataBytes);
    System.out.println(sig.verify(sigBytes) ? "JVM_ECDSA_OK" : "JVM_ECDSA_FAIL");
  }
}
`,
      )

      const compile = Bun.spawnSync([hasJavac, javaFile, '-d', dir], { stdout: 'pipe', stderr: 'pipe' })
      expect(compile.exitCode).toBe(0)

      // 1) Verify bundle bytes signature
      const runBundle = Bun.spawnSync(
        [
          hasJava,
          '-cp',
          dir,
          'VerifyOtaSig',
          keys.publicKeyBase64,
          built.manifest.bundle?.signature ?? '',
          built.bundlePath,
        ],
        { stdout: 'pipe', stderr: 'pipe' },
      )
      expect(runBundle.exitCode).toBe(0)
      expect(new TextDecoder().decode(runBundle.stdout).trim()).toBe('JVM_ECDSA_OK')

      // 2) Verify canonical manifestSignature for both update & kill-switch
      const payloadUpdatePath = path.join(dir, 'manifest-update.payload')
      writeFileSync(payloadUpdatePath, buildManifestSigningPayload(built.manifest))
      const runManifestUpdate = Bun.spawnSync(
        [hasJava, '-cp', dir, 'VerifyOtaSig', keys.publicKeyBase64, built.manifest.manifestSignature ?? '', payloadUpdatePath],
        { stdout: 'pipe', stderr: 'pipe' },
      )
      expect(runManifestUpdate.exitCode).toBe(0)
      expect(new TextDecoder().decode(runManifestUpdate.stdout).trim()).toBe('JVM_ECDSA_OK')

      const payloadKillPath = path.join(dir, 'manifest-kill.payload')
      writeFileSync(payloadKillPath, buildManifestSigningPayload(killSwitch.manifest))
      const runManifestKill = Bun.spawnSync(
        [hasJava, '-cp', dir, 'VerifyOtaSig', keys.publicKeyBase64, killSwitch.manifest.manifestSignature ?? '', payloadKillPath],
        { stdout: 'pipe', stderr: 'pipe' },
      )
      expect(runManifestKill.exitCode).toBe(0)
      expect(new TextDecoder().decode(runManifestKill.stdout).trim()).toBe('JVM_ECDSA_OK')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('formatOtaMetaKv includes hbc_version line', async () => {
    const dir = makeTempProject()
    try {
      const config = await loadGpuixConfig(dir)
      const meta = formatOtaMetaKv(config, 'hbc', 'b'.repeat(64), 96)
      expect(meta).toContain('hbc_version=96\n')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('OTA hash chain, Merkle tree integrity & release locating', () => {
  test('buildByteMerkleTree and RFC 6962 inclusion proofs detect byte tampering', () => {
    const payload = new Uint8Array(1000)
    for (let i = 0; i < payload.length; i += 1) payload[i] = i & 0xff

    const tree = buildByteMerkleTree(payload, 256)
    expect(tree.chunkCount).toBe(4)
    expect(tree.leafHashes.length).toBe(4)

    for (let idx = 0; idx < tree.chunkCount; idx += 1) {
      const proof = buildMerkleProof(tree.leafHashes, idx)
      expect(verifyMerkleProof(tree.leafHashes[idx], idx, proof, tree.merkleRoot)).toBe(true)
      const flipped = `${tree.leafHashes[idx].startsWith('0') ? '1' : '0'}${tree.leafHashes[idx].slice(1)}`
      expect(verifyMerkleProof(flipped, idx, proof, tree.merkleRoot)).toBe(false)
    }
  })

  test('links sequential releases into a verified hash chain with chunk & chain proofs and locate queries', async () => {
    const dir = makeTempProject()
    const keysDir = path.join(dir, 'keys')
    const outDir = path.join(dir, 'dist/ota')
    try {
      const keys = await keygenOta({ outDir: keysDir })

      // Release #0: v1.0.0 (custom small chunkSize so multi-chunk Merkle proof is exercised)
      const r0 = await buildOtaRelease({
        projectRoot: dir,
        outDir,
        versionName: '1.0.0',
        releaseId: 'rel-1.0.0',
        manifestSeq: 1001,
        chunkSize: 256,
        privateKey: keys.privateKeyPath,
        skipHbc: true,
      })

      expect(r0.manifest.integrity?.chainIndex).toBe(0)
      expect(r0.manifest.integrity?.prevReleaseHash).toBe('0'.repeat(64))
      expect(buildManifestSigningPayload(r0.manifest).startsWith('gpuix-ota-manifest-v2\n')).toBe(true)
      expect(buildManifestSigningPayload({ ...r0.manifest, integrity: undefined }).startsWith('gpuix-ota-manifest-v1\n')).toBe(true)

      // Release #1: v1.1.1 updated source
      writeFileSync(
        path.join(dir, 'src/main.tsx'),
        `export function App() { return "hello ota v1.1.1 ${'x'.repeat(300)}" }\nconsole.log(App());\n`,
      )
      const r1 = await buildOtaRelease({
        projectRoot: dir,
        outDir,
        versionName: '1.1.1',
        releaseId: 'rel-1.1.1',
        manifestSeq: 1002,
        chunkSize: 256,
        privateKey: keys.privateKeyPath,
        skipHbc: true,
      })

      expect(r1.manifest.integrity?.chainIndex).toBe(1)
      expect(r1.manifest.integrity?.prevReleaseHash).toBe(r0.manifest.integrity?.releaseHash)

      // Release #2: kill switch linked on top of r1
      const r2 = await buildOtaRelease({
        projectRoot: dir,
        outDir,
        versionName: '1.1.2',
        releaseId: 'kill-1.1.2',
        manifestSeq: 1003,
        action: 'rollback_to_embedded',
        privateKey: keys.privateKeyPath,
      })
      expect(r2.manifest.integrity?.chainIndex).toBe(2)
      expect(r2.manifest.integrity?.prevReleaseHash).toBe(r1.manifest.integrity?.releaseHash)

      const chain = await readOtaChain(r2.chainPath)
      expect(chain.entries.length).toBe(3)
      expect(chain.headHash).toBe(r2.manifest.integrity!.releaseHash)
      expect(verifyReleaseChain(chain).valid).toBe(true)

      // Locate by releaseId, v-prefixed versionName, #index, and SHA-256 hash prefix
      expect(locateChainEntries(chain, 'rel-1.0.0').map((e) => e.releaseId)).toEqual(['rel-1.0.0'])
      expect(locateChainEntries(chain, 'v1.1.1').map((e) => e.releaseId)).toEqual(['rel-1.1.1'])
      expect(locateChainEntries(chain, '#2').map((e) => e.releaseId)).toEqual(['kill-1.1.2'])
      expect(
        locateChainEntries(chain, r1.manifest.integrity!.releaseHash.slice(0, 10)).map((e) => e.releaseId),
      ).toEqual(['rel-1.1.1'])

      // Generate & verify chain + chunk Merkle proofs
      const chainProof = await generateOtaProof({ dir: outDir, query: 'v1.1.1' })
      expect(chainProof.kind).toBe('chain')
      expect(chainProof.verified).toBe(true)
      expect(chainProof.rootHash).toBe(chain.chainMerkleRoot)

      const chunkProof = await generateOtaProof({ dir: outDir, query: 'rel-1.1.1', chunkIndex: 0 })
      expect(chunkProof.kind).toBe('chunk')
      expect(chunkProof.verified).toBe(true)
      expect(chunkProof.rootHash).toBe(r1.manifest.integrity!.merkleRoot)

      // verifyOtaRelease succeeds for linked manifest & detects corrupted chain
      const verifiedR1 = await verifyOtaRelease(path.join(outDir, 'bundles/rel-1.1.1/manifest.json'), keys.publicKeyBase64)
      expect(verifiedR1.chainVerified).toBe(true)
      expect(verifiedR1.versionName).toBe('1.1.1')

      // Corrupt merkle.json and verify detection
      const merkleFile = path.join(outDir, 'bundles/rel-1.1.1/merkle.json')
      const savedMerkle = readFileSync(merkleFile, 'utf8')
      const badMerkle = { ...JSON.parse(savedMerkle), merkleRoot: 'f'.repeat(64) }
      writeFileSync(merkleFile, JSON.stringify(badMerkle, null, 2))
      await expect(
        verifyOtaRelease(path.join(outDir, 'bundles/rel-1.1.1/manifest.json'), keys.publicKeyBase64),
      ).rejects.toThrow('merkle.json root mismatch')
      writeFileSync(merkleFile, savedMerkle)

      // Corrupt chain.json link and verify detection
      const corruptedChain = {
        ...chain,
        entries: chain.entries.map((entry, i) =>
          i === 1 ? { ...entry, prevReleaseHash: 'a'.repeat(64) } : entry,
        ),
      }
      writeFileSync(r2.chainPath, JSON.stringify(corruptedChain, null, 2))
      await expect(
        verifyOtaRelease(path.join(outDir, 'bundles/rel-1.1.1/manifest.json'), keys.publicKeyBase64),
      ).rejects.toThrow('chain verification failed')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
