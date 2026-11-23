import path from 'node:path'
import { watch } from 'node:fs'
import { createAndroidPlugins, normalizeAndroidFonts, wrapDebugBundle } from '../android/scripts/build-js'
import { loadGpuixAndroidConfig } from '../android/scripts/config'

export type DevServerOptions = {
  projectRoot: string
  serial?: string
  port: number
}

type PendingWaiter = {
  resolve: (response: Response) => void
  timer: ReturnType<typeof setTimeout>
}

const IGNORED_PREFIXES = ['.git/', 'node_modules/', 'dist/', 'android/.build/', 'android/target/', 'android/.gradle/', 'android/app/build/']

function isIgnoredPath(relativePath: string): boolean {
  const normalized = relativePath.split(path.sep).join('/')
  return IGNORED_PREFIXES.some((prefix) => normalized === prefix.slice(0, -1) || normalized.startsWith(prefix))
}

async function setupAdbReverse(port: number, serial?: string): Promise<void> {
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
        process.stdout.write('! 未检测到在线 ADB 设备；设备接入后可手动执行: adb reverse tcp:' + port + ' tcp:' + port + '\n')
        return
      }
    }
    const revProc = Bun.spawn(['adb', '-s', targetSerial, 'reverse', `tcp:${port}`, `tcp:${port}`], {
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const stderr = await new Response(revProc.stderr).text()
    const code = await revProc.exited
    if (code === 0) {
      process.stdout.write(`✓ adb reverse (${targetSerial}): tcp:${port} -> tcp:${port}\n`)
    } else {
      process.stdout.write(`! adb reverse 失败 (${targetSerial}): ${stderr.trim()}\n`)
    }
  } catch (error) {
    process.stdout.write(`! adb reverse 不可用: ${error instanceof Error ? error.message : String(error)}\n`)
  }
}

async function buildHotBundle(projectRoot: string, entrypointRel: string): Promise<string> {
  const entrypoint = path.join(projectRoot, entrypointRel)
  const result = await Bun.build({
    entrypoints: [entrypoint],
    naming: 'app.js',
    target: 'browser',
    format: 'iife',
    minify: false,
    define: {
      'process.env.NODE_ENV': '"development"',
      process: 'undefined',
      window: 'undefined',
      Bun: 'undefined',
    },
    plugins: createAndroidPlugins(),
  })

  if (!result.success) {
    const messages = result.logs.map((log) => log.message || String(log)).join('\n')
    throw new Error(messages || 'Bun.build failed')
  }

  const rawSource = await result.outputs[0].text()
  return wrapDebugBundle(normalizeAndroidFonts(rawSource))
}

function buildCompileErrorScript(title: string, message: string): string {
  return `
;(function() {
  if (typeof globalThis.__gpuixShowRedBox === 'function') {
    globalThis.__gpuixShowRedBox(${JSON.stringify(title)}, ${JSON.stringify(message)});
  }
  console.error('[gpuix-dev] ' + ${JSON.stringify(title)} + ': ' + ${JSON.stringify(message)});
})();
`
}

export async function runDevServer(options: DevServerOptions): Promise<void> {
  const { projectRoot, serial, port } = options
  const config = await loadGpuixAndroidConfig(projectRoot)
  await setupAdbReverse(port, serial)

  let version = 1
  let building = false
  let lastBuildMs = 0
  let lastError: string | null = null
  let latestBundle = ''
  const waiters = new Set<PendingWaiter>()

  function wakeWaiters(): void {
    if (waiters.size === 0) return
    const snapshotVersion = String(version)
    const snapshotBody = latestBundle
    for (const waiter of waiters) {
      clearTimeout(waiter.timer)
      waiters.delete(waiter)
      waiter.resolve(
        new Response(snapshotBody, {
          status: 200,
          headers: {
            'Content-Type': 'application/javascript; charset=utf-8',
            'X-Gpuix-Version': snapshotVersion,
            'Cache-Control': 'no-store',
          },
        }),
      )
    }
  }

  async function rebuild(reason: string): Promise<void> {
    if (building) return
    building = true
    const startedAt = performance.now()
    try {
      const bundle = await buildHotBundle(projectRoot, config.entrypoint)
      lastBuildMs = Math.round((performance.now() - startedAt) * 10) / 10
      lastError = null
      version += 1
      latestBundle = bundle
      process.stdout.write(`✓ [v${version}] ${reason} rebuilt in ${lastBuildMs} ms (${Buffer.byteLength(bundle)} B)\n`)
      wakeWaiters()
    } catch (error) {
      lastBuildMs = Math.round((performance.now() - startedAt) * 10) / 10
      lastError = error instanceof Error ? error.message : String(error)
      version += 1
      latestBundle = buildCompileErrorScript('Bundle Compile Error', lastError)
      process.stderr.write(`✗ [v${version}] ${reason} compile error (${lastBuildMs} ms):\n${lastError}\n`)
      wakeWaiters()
    } finally {
      building = false
    }
  }

  await rebuild('initial')

  const server = Bun.serve({
    hostname: '127.0.0.1',
    port,
    fetch(req) {
      const url = new URL(req.url)
      if (url.pathname === '/status') {
        return Response.json({
          version,
          building,
          lastBuildMs,
          error: lastError,
          entrypoint: config.entrypoint,
        })
      }
      if (url.pathname === '/poll') {
        const clientVersion = Number(url.searchParams.get('version') ?? '0')
        if (Number.isFinite(clientVersion) && version > clientVersion && latestBundle.length > 0) {
          return new Response(latestBundle, {
            status: 200,
            headers: {
              'Content-Type': 'application/javascript; charset=utf-8',
              'X-Gpuix-Version': String(version),
              'Cache-Control': 'no-store',
            },
          })
        }
        return new Promise<Response>((resolve) => {
          const waiter: PendingWaiter = {
            resolve,
            timer: setTimeout(() => {
              waiters.delete(waiter)
              resolve(new Response(null, { status: 204 }))
            }, 15_000),
          }
          waiters.add(waiter)
          req.signal.addEventListener(
            'abort',
            () => {
              clearTimeout(waiter.timer)
              waiters.delete(waiter)
            },
            { once: true },
          )
        })
      }
      return new Response('GPUIX Dev Server: /status | /poll?version=N\n', { status: 200 })
    },
  })

  process.stdout.write(`GPUIX Dev Server listening on http://127.0.0.1:${server.port} (${config.entrypoint})\n`)

  let debounceTimer: ReturnType<typeof setTimeout> | null = null
  const watcher = watch(projectRoot, { recursive: true }, (_eventType, filename) => {
    if (!filename || isIgnoredPath(filename)) return
    if (debounceTimer) clearTimeout(debounceTimer)
    debounceTimer = setTimeout(() => {
      void rebuild(filename)
    }, 100)
  })

  await new Promise<void>((resolve) => {
    const shutdown = () => {
      watcher.close()
      if (debounceTimer) clearTimeout(debounceTimer)
      for (const waiter of waiters) {
        clearTimeout(waiter.timer)
        waiter.resolve(new Response(null, { status: 204 }))
      }
      waiters.clear()
      server.stop(true)
      resolve()
    }
    process.once('SIGINT', shutdown)
    process.once('SIGTERM', shutdown)
  })
}
