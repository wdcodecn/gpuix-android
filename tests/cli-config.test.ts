import { afterEach, describe, expect, test } from 'bun:test'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { existsSync } from 'node:fs'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import {
  loadGpuixAndroidConfig,
  loadGpuixConfig,
  resolveAndroidAppId,
  resolveIosBuildNumber,
  resolveIosBundleId,
  resolveIosDeploymentTarget,
  resolveIosStatusBarStyle,
  syncGeneratedManifest,
  writeGradleProperties,
} from '../scripts/config'
import { DEBUG_WRAPPER_LINE_OFFSET, wrapDebugBundle } from '../scripts/bundler'
import { extractCandidateSurfaceLayers } from '../scripts/gpuix'
import { decodeVlq, parseSourceMap, resolveOriginalPosition, symbolicateStack } from '../scripts/sourcemap'

const repoRoot = path.resolve(import.meta.dir, '..')
const tempDirs: string[] = []

async function createTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!
    await rm(dir, { recursive: true, force: true })
  }
})

describe('android/scripts/config', () => {
  test('loads valid config, validates constraints, and escapes Gradle properties', async () => {
    const project = await createTempDir('gpuix-cfg-')
    await mkdir(path.join(project, 'src'), { recursive: true })
    await Bun.write(path.join(project, 'src/main.tsx'), 'export const app = 1\n')
    await Bun.write(
      path.join(project, 'gpuix.android.json'),
      JSON.stringify({
        entrypoint: 'src/main.tsx',
        appId: 'dev.gpuix.testapp',
        appName: 'Test:App#1!',
        versionName: '1.2.3',
        versionCode: 42,
        features: ['http-client'],
        abis: ['arm64-v8a'],
      }),
    )

    const cfg = await loadGpuixAndroidConfig(project)
    expect(cfg.entrypoint).toBe('src/main.tsx')
    expect(cfg.appId).toBe('dev.gpuix.testapp')
    expect(cfg.features).toEqual(['http-client'])
    expect(cfg.abis).toEqual(['arm64-v8a'])

    const propsPath = await writeGradleProperties(project, cfg)
    const propsText = await Bun.file(propsPath).text()
    expect(propsText).toContain('appId=dev.gpuix.testapp')
    expect(propsText).toContain('appName=Test\\:App\\#1\\!')
    expect(propsText).toContain('versionCode=42')
    expect(propsText).toContain('abis=arm64-v8a')
  })

  test('rejects invalid appId, escaping entrypoint, or unknown features', async () => {
    const project = await createTempDir('gpuix-badcfg-')
    await mkdir(path.join(project, 'src'), { recursive: true })
    await Bun.write(path.join(project, 'src/main.tsx'), 'export {}\n')

    await Bun.write(
      path.join(project, 'gpuix.android.json'),
      JSON.stringify({ entrypoint: '../outside.tsx', appId: 'dev.gpuix.ok' }),
    )
    await expect(loadGpuixAndroidConfig(project)).rejects.toThrow('must stay inside the project directory')

    await Bun.write(
      path.join(project, 'gpuix.android.json'),
      JSON.stringify({ entrypoint: 'src/main.tsx', appId: 'invalid' }),
    )
    await expect(loadGpuixAndroidConfig(project)).rejects.toThrow('dotted Android package id')

    await Bun.write(
      path.join(project, 'gpuix.android.json'),
      JSON.stringify({ entrypoint: 'src/main.tsx', appId: 'dev.gpuix.ok', features: ['unknown-feat'] }),
    )
    await expect(loadGpuixAndroidConfig(project)).rejects.toThrow('features entries')
  })
})

describe('scripts/sourcemap', () => {
  test('decodes VLQ segments and resolves original positions across wrapped debug bundles', async () => {
    expect(decodeVlq('AAAA')).toEqual([0, 0, 0, 0])
    expect(decodeVlq('IAAM')).toEqual([4, 0, 0, 6])
    expect(decodeVlq('JAAnB')).toEqual([-4, 0, 0, -19])

    const srcDir = await createTempDir('gpuix-sm-')
    const entryFile = path.join(srcDir, 'entry.ts')
    await Bun.write(
      entryFile,
      [
        'export function helperValue(): number {',
        '  return 10',
        '}',
        'export function boomCall(): never {',
        '  throw new Error("boom-marker")',
        '}',
        'boomCall()',
        '',
      ].join('\n'),
    )

    const built = await Bun.build({
      entrypoints: [entryFile],
      naming: 'app.js',
      target: 'browser',
      format: 'iife',
      minify: false,
      sourcemap: 'external',
    })
    expect(built.success).toBe(true)

    const output = built.outputs[0]
    const rawCode = await output.text()
    const mapText = await output.sourcemap!.text()
    const parsed = parseSourceMap(mapText)

    const wrapped = wrapDebugBundle(rawCode, 8081)
    const wrappedLines = wrapped.split('\n')
    const throwIdx0 = wrappedLines.findIndex((line) => line.includes('boom-marker'))
    const throwLineIndex1Based = throwIdx0 + 1
    const throwCol1Based = wrappedLines[throwIdx0].indexOf('new Error') + 1
    expect(throwLineIndex1Based).toBeGreaterThan(DEBUG_WRAPPER_LINE_OFFSET)
    expect(throwCol1Based).toBeGreaterThan(0)

    const resolvedDirect = resolveOriginalPosition(
      parsed,
      throwLineIndex1Based - DEBUG_WRAPPER_LINE_OFFSET,
      throwCol1Based,
    )
    expect(resolvedDirect).not.toBeNull()
    expect(resolvedDirect!.source).toContain('entry.ts')
    expect(resolvedDirect!.line).toBe(5)

    const hermesStack = [
      'Error: boom-marker',
      `    at boomCall (address at app.js:${throwLineIndex1Based}:${throwCol1Based})`,
    ].join('\n')
    const symbolicated = symbolicateStack(hermesStack, parsed, DEBUG_WRAPPER_LINE_OFFSET)
    expect(symbolicated).toContain('entry.ts:5:')
  })
})

describe('scripts/gpuix CLI managed host & eject flow', () => {
  test('init writes managed config without copying android/, info resolves managed mode, and eject copies host', async () => {
    const project = await createTempDir('gpuix-managed-')
    await mkdir(path.join(project, 'src'), { recursive: true })
    await Bun.write(path.join(project, 'src/main.tsx'), 'export const main = true\n')

    const initProc = Bun.spawnSync(
      ['bun', path.join(repoRoot, 'scripts/gpuix.ts'), 'init', '--cwd', project, '--app-id', 'dev.gpuix.managed', '--name', 'Managed Test', '--version', '2.7.0'],
      { stdout: 'pipe', stderr: 'pipe' },
    )
    expect(initProc.exitCode).toBe(0)
    expect(existsSync(path.join(project, 'gpuix.config.json'))).toBe(true)
    expect(existsSync(path.join(project, 'android'))).toBe(false)

    const infoProc = Bun.spawnSync(
      ['bun', path.join(repoRoot, 'scripts/gpuix.ts'), 'info', '--cwd', project],
      { stdout: 'pipe', stderr: 'pipe' },
    )
    expect(infoProc.exitCode).toBe(0)
    const infoJson = JSON.parse(new TextDecoder().decode(infoProc.stdout)) as {
      cliVersion: string
      hostMode: string
      appId: string
      versionName: string
      ios: { bundleId: string; statusBarStyle: string; deploymentTarget: string }
    }
    expect(infoJson.hostMode).toBe('managed')
    expect(infoJson.appId).toBe('dev.gpuix.managed')
    expect(infoJson.versionName).toBe('2.7.0')
    expect(infoJson.ios.bundleId).toBe('dev.gpuix.managed')
    expect(infoJson.ios.statusBarStyle).toBe('light')
    expect(infoJson.ios.deploymentTarget).toBe('17.0')

    const ejectProc = Bun.spawnSync(
      ['bun', path.join(repoRoot, 'scripts/gpuix.ts'), 'eject', '--cwd', project],
      { stdout: 'pipe', stderr: 'pipe' },
    )
    expect(ejectProc.exitCode).toBe(0)
    expect(existsSync(path.join(project, 'android/scripts/build-android.sh'))).toBe(true)
    expect(existsSync(path.join(project, 'android/app/src/main/java/dev/gpui/mobile/GpuiNativeBridge.java'))).toBe(true)
    expect(existsSync(path.join(project, 'native/vendor/gpuix-native/Cargo.toml'))).toBe(true)
    expect(existsSync(path.join(project, 'runtime/index.ts'))).toBe(true)
    expect(existsSync(path.join(project, 'android/.build'))).toBe(false)
    expect(existsSync(path.join(project, 'android/app/src/main/jniLibs'))).toBe(false)

    const ejectedInfoProc = Bun.spawnSync(
      ['bun', path.join(repoRoot, 'scripts/gpuix.ts'), 'info', '--cwd', project],
      { stdout: 'pipe', stderr: 'pipe' },
    )
    const ejectedInfo = JSON.parse(new TextDecoder().decode(ejectedInfoProc.stdout)) as { hostMode: string }
    expect(ejectedInfo.hostMode).toBe('ejected')
  })

  test('init --eject creates both config and android/ host in one step', async () => {
    const project = await createTempDir('gpuix-init-eject-')
    await mkdir(path.join(project, 'src'), { recursive: true })
    await Bun.write(path.join(project, 'src/main.tsx'), 'export const main = true\n')

    const proc = Bun.spawnSync(
      ['bun', path.join(repoRoot, 'scripts/gpuix.ts'), 'init', '--cwd', project, '--eject'],
      { stdout: 'pipe', stderr: 'pipe' },
    )
    expect(proc.exitCode).toBe(0)
    expect(existsSync(path.join(project, 'gpuix.config.json'))).toBe(true)
    expect(existsSync(path.join(project, 'android/scripts/build-android.sh'))).toBe(true)
    expect(existsSync(path.join(project, 'native/vendor/gpuix-native/Cargo.toml'))).toBe(true)
  })

  test('extractCandidateSurfaceLayers filters InputSink/leash and unwraps Android 16/17 VRI layers', () => {
    const sfOutput = [
      'RequestedLayerState{5b4b391 ActivityRecordInputSink dev.gpuix.baseui/dev.gpui.mobile.GpuiActivity#267631 parentId=267625 z=-2147483648}',
      'RequestedLayerState{bf7de90 ActivityRecordInputSink dev.gpuix.starter/dev.gpui.mobile.GpuiActivity#251122 parentId=251116 z=-2147483648}',
      'RequestedLayerState{Surface(name=6d07462 dev.gpuix.baseui/dev.gpui.mobile.GpuiActivity#267632)/@0xf1c12a9 - animation-leash of starting_reveal#267636}',
      'RequestedLayerState{VRI-dev.gpuix.baseui/dev.gpui.mobile.GpuiActivity#267633}',
      'RequestedLayerState{ActivityRecord{202191899 u0 dev.gpuix.baseui/dev.gpui.mobile.GpuiActivity t6572}#267625 parentId=267624}',
      'RequestedLayerState{VRI-dev.gpuix.baseui/dev.gpui.mobile.GpuiActivity#267679 parentId=267632}',
      'SurfaceView[dev.gpuix.baseui/dev.gpui.mobile.GpuiActivity]#0',
    ].join('\n')

    const ranked = extractCandidateSurfaceLayers(sfOutput, 'dev.gpuix.baseui')
    expect(ranked[0]).toBe('VRI-dev.gpuix.baseui/dev.gpui.mobile.GpuiActivity#267679')
    expect(ranked).toContain('VRI-dev.gpuix.baseui/dev.gpui.mobile.GpuiActivity#267633')
    expect(ranked).toContain('SurfaceView[dev.gpuix.baseui/dev.gpui.mobile.GpuiActivity]#0')
    expect(ranked.some((l) => l.includes('ActivityRecordInputSink'))).toBe(false)
    expect(ranked.some((l) => l.includes('animation-leash'))).toBe(false)
    expect(ranked.some((l) => l.includes('dev.gpuix.starter'))).toBe(false)
  })

  test('permissions config normalizes names, preserves INTERNET, and trims generated AndroidManifest.xml', async () => {
    const project = await createTempDir('gpuix-perms-')
    await mkdir(path.join(project, 'src'), { recursive: true })
    await mkdir(path.join(project, 'android/app/src/main'), { recursive: true })
    await Bun.write(path.join(project, 'src/main.tsx'), 'export {}\n')
    await Bun.write(
      path.join(project, 'android/app/src/main/AndroidManifest.xml'),
      [
        '<?xml version="1.0" encoding="utf-8"?>',
        '<manifest xmlns:android="http://schemas.android.com/apk/res/android">',
        '    <uses-permission android:name="android.permission.INTERNET" />',
        '    <uses-permission android:name="android.permission.CAMERA" />',
        '    <uses-permission android:name="android.permission.ACCESS_FINE_LOCATION" />',
        '    <application android:label="Test" />',
        '</manifest>',
        '',
      ].join('\n'),
    )
    await Bun.write(
      path.join(project, 'gpuix.android.json'),
      JSON.stringify({
        entrypoint: 'src/main.tsx',
        appId: 'dev.gpuix.permtest',
        permissions: ['CAMERA', 'android.permission.VIBRATE', 'CAMERA'],
      }),
    )

    const cfg = await loadGpuixAndroidConfig(project)
    expect(cfg.permissions).toEqual([
      'android.permission.INTERNET',
      'android.permission.CAMERA',
      'android.permission.VIBRATE',
    ])

    const generated = await syncGeneratedManifest(path.join(project, 'android'), cfg)
    expect(generated).not.toBeNull()
    const manifestText = await Bun.file(generated!).text()
    expect(manifestText).toContain('android.permission.INTERNET')
    expect(manifestText).toContain('android.permission.CAMERA')
    expect(manifestText).toContain('android.permission.VIBRATE')
    expect(manifestText).not.toContain('ACCESS_FINE_LOCATION')

    delete cfg.permissions
    const removed = await syncGeneratedManifest(path.join(project, 'android'), cfg)
    expect(removed).toBeNull()
    expect(existsSync(generated!)).toBe(false)
  })

  test('loads unified gpuix.config.json with platform-specific android/ios overrides and falls back cleanly', async () => {
    const project = await createTempDir('gpuix-unified-cfg-')
    await mkdir(path.join(project, 'src'), { recursive: true })
    await Bun.write(path.join(project, 'src/main.tsx'), 'export const ok = 1\n')
    await Bun.write(
      path.join(project, 'gpuix.config.json'),
      JSON.stringify({
        entrypoint: 'src/main.tsx',
        appId: 'dev.gpuix.unified',
        appName: 'Unified App',
        versionName: '2.7.0',
        versionCode: 27,
        android: {
          applicationId: 'dev.gpuix.unified.android',
          abis: ['arm64-v8a'],
        },
        ios: {
          bundleId: 'dev.gpuix.unified-ios',
          buildNumber: '27.1',
          deploymentTarget: '18.0',
          statusBarStyle: 'dark',
        },
      }),
    )

    const cfg = await loadGpuixConfig(project)
    expect(cfg.versionName).toBe('2.7.0')
    expect(resolveAndroidAppId(cfg)).toBe('dev.gpuix.unified.android')
    expect(resolveIosBundleId(cfg)).toBe('dev.gpuix.unified-ios')
    expect(resolveIosBuildNumber(cfg)).toBe('27.1')
    expect(resolveIosDeploymentTarget(cfg)).toBe('18.0')
    expect(resolveIosStatusBarStyle(cfg)).toBe('dark')
  })
})
