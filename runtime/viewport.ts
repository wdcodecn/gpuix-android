import type { ViewportInsets, ViewportMetrics, ViewportSize } from './types'

export function ensureViewportMetrics(): ViewportMetrics {
  const g = globalThis as { __gpuixViewport?: ViewportMetrics }
  if (g.__gpuixViewport) return g.__gpuixViewport

  const sizeListeners = new Set<(size: ViewportSize) => void>()
  const insetsListeners = new Set<(insets: ViewportInsets) => void>()
  let lastSize: ViewportSize | null = null
  let lastInsets: ViewportInsets | null = null

  const metrics: ViewportMetrics = {
    subscribeSize(fn) {
      sizeListeners.add(fn)
      if (lastSize) {
        try {
          fn(lastSize)
        } catch {
          // Ignore subscriber errors
        }
      }
      return () => {
        sizeListeners.delete(fn)
      }
    },
    subscribeInsets(fn) {
      insetsListeners.add(fn)
      if (lastInsets) {
        try {
          fn(lastInsets)
        } catch {
          // Ignore subscriber errors
        }
      }
      return () => {
        insetsListeners.delete(fn)
      }
    },
    __emitSize(next) {
      lastSize = next
      sizeListeners.forEach((fn) => {
        try {
          fn(next)
        } catch {
          // Ignore subscriber errors
        }
      })
    },
    __emitInsets(next) {
      lastInsets = next
      insetsListeners.forEach((fn) => {
        try {
          fn(next)
        } catch {
          // Ignore subscriber errors
        }
      })
    },
    __resetListeners() {
      sizeListeners.clear()
      insetsListeners.clear()
    },
  }
  g.__gpuixViewport = metrics
  return metrics
}
