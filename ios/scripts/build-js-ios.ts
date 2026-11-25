#!/usr/bin/env bun

import path from 'node:path'
import { runPlatformJsBuildCli } from '../../scripts/bundler'
import { loadGpuixConfig, resolveIosBundleId } from '../../scripts/config'

function parseOption(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag)
  if (index !== -1 && index + 1 < args.length) {
    return args[index + 1]
  }
  const prefixed = `${flag}=`
  const match = args.find((item) => item.startsWith(prefixed))
  return match ? match.slice(prefixed.length) : undefined
}

const repoRoot = path.resolve(import.meta.dir, '../..')
const iosRoot = path.join(repoRoot, 'ios')

const args = process.argv.slice(2)
const isRelease = args.includes('--release')
const skipHbc = args.includes('--no-hbc')
const projectRoot = path.resolve(
  parseOption(args, '--project') ?? process.env.GPUIX_PROJECT_ROOT ?? path.resolve(repoRoot, '../gpuix-base-ui'),
)
const entryOverride = parseOption(args, '--entry')
const config = await loadGpuixConfig(projectRoot)
const built = await runPlatformJsBuildCli('ios', iosRoot, {
  projectRoot,
  isRelease,
  skipHbc,
  ...(entryOverride ? { entrypointOverride: entryOverride } : {}),
})

console.log(
  `iOS bundle ready: ${path.join(built.assetsDir, built.format === 'hbc' ? 'app.hbc' : 'app.js')} (${built.bytes.length} B, hash=${built.buildHash})`,
)
console.log(
  `iOS config: ${entryOverride ?? config.entrypoint} -> ${resolveIosBundleId(config)} v${config.versionName} (${config.versionCode})`,
)
