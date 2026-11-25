import path from 'node:path'
import {
  buildInjectedAppInfo,
  compileAndroidBundle,
  compileMobileBundle,
  createAndroidPlugins,
  createRuntimePlugins,
  DEBUG_WRAPPER_LINE_OFFSET,
  findHermesc,
  formatOtaMetaKv,
  normalizeAndroidFonts,
  normalizeFontsForPlatform,
  normalizeIosFonts,
  readHermesBytecodeVersion,
  runPlatformJsBuildCli,
  wrapDebugBundle,
  type CompileAndroidBundleOptions,
  type CompiledAndroidBundle,
  type CompiledMobileBundle,
  type CompileMobileBundleOptions,
  type MobileTargetPlatform,
} from '../../scripts/bundler'
import { loadGpuixConfig, resolveAndroidAppId } from '../../scripts/config'

export {
  buildInjectedAppInfo,
  compileAndroidBundle,
  compileMobileBundle,
  createAndroidPlugins,
  createRuntimePlugins,
  DEBUG_WRAPPER_LINE_OFFSET,
  findHermesc,
  formatOtaMetaKv,
  normalizeAndroidFonts,
  normalizeFontsForPlatform,
  normalizeIosFonts,
  readHermesBytecodeVersion,
  runPlatformJsBuildCli,
  wrapDebugBundle,
  type CompileAndroidBundleOptions,
  type CompiledAndroidBundle,
  type CompiledMobileBundle,
  type CompileMobileBundleOptions,
  type MobileTargetPlatform,
}

if (import.meta.main) {
  const androidRoot = path.resolve(import.meta.dir, '..')
  const projectRoot = process.env.GPUIX_PROJECT_ROOT
    ? path.resolve(process.env.GPUIX_PROJECT_ROOT)
    : path.dirname(androidRoot)
  const args = new Set(process.argv.slice(2))
  const isRelease = args.has('--release')
  const skipHbc = args.has('--no-hbc')
  const config = await loadGpuixConfig(projectRoot)
  const built = await runPlatformJsBuildCli('android', androidRoot, {
    projectRoot,
    isRelease,
    skipHbc,
  })
  if (built.format === 'hbc') {
    console.log(`Android HBC: ${path.join(built.assetsDir, 'app.hbc')} (${built.bytes.length} bytes, hash=${built.buildHash}, release=${isRelease})`)
  } else {
    console.log(`Android JS: ${path.join(built.assetsDir, 'app.js')} (${built.bytes.length} bytes, hash=${built.buildHash})`)
  }
  console.log(`Android config: ${config.entrypoint} -> ${resolveAndroidAppId(config)} v${config.versionName} (${config.versionCode})`)
}
