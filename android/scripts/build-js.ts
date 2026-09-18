import path from 'node:path'
import { loadGpuixAndroidConfig, writeGradleProperties } from './config'

const project = path.resolve(import.meta.dir, '../..')
const config = await loadGpuixAndroidConfig(project)
const entrypoint = path.join(project, config.entrypoint)
const result = await Bun.build({
  entrypoints: [entrypoint],
  outdir: path.join(project, 'android/.build'),
  naming: 'app.js',
  target: 'browser', // Standard JavaScript output; execution is in standalone Hermes.
  format: 'iife',
  minify: true,
  define: {
    'process.env.NODE_ENV': '"production"',
    process: 'undefined',
    window: 'undefined',
    Bun: 'undefined',
  },
  plugins: [{
    name: 'gpuix-android-native',
    setup(build) {
      build.onResolve({ filter: /^@gpuix\/native$/ }, () => ({ path: 'native', namespace: 'android' }))
      build.onLoad({ filter: /.*/, namespace: 'android' }, () => ({
        contents: 'globalThis.__gpuixAndroid = true; export const GpuixRenderer = globalThis.__gpuixNative.GpuixRenderer;',
        loader: 'js',
      }))
    },
  }],
})
if (!result.success) throw new AggregateError(result.logs, 'Android JavaScript bundle failed')

// GPUI's Android platform maps `.SystemUIFont` to the real system Roboto
// family.  Keep the public Base UI source desktop-neutral, but normalize the
// browser-family names in the Android artifact before Hermes sees it.  This is
// deliberately a bundle-target adaptation, not a change to GPUIX or to the
// component API.
const output = result.outputs[0]
const source = await output.text()
const androidSource = source
  .replaceAll('"Helvetica"', '".SystemUIFont"')
  .replaceAll('"Menlo"', '"Droid Sans Mono"')
  .replaceAll('"sans-serif"', '".SystemUIFont"')
await Bun.write(output.path, androidSource)
const gradleProperties = await writeGradleProperties(project, config)
console.log(`Android JS: ${output.path} (${androidSource.length} bytes)`)
console.log(`Android config: ${config.entrypoint} → ${config.appId} (${gradleProperties})`)
