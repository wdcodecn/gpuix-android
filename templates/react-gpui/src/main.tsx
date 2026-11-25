import { render } from '@gpuix/react'
import { Badge, Button, Card, ThemeProvider, useTheme } from 'gpuix-base-ui'

type InjectedAppInfo = {
  appName?: string
  versionName?: string
  platform?: string
  buildHash?: string
}

function readAppInfo(): InjectedAppInfo {
  const raw = Reflect.get(globalThis, '__gpuixAppInfo')
  return raw && typeof raw === 'object' ? (raw as InjectedAppInfo) : {}
}

function App() {
  const { tokens: C } = useTheme()
  const appInfo = readAppInfo()
  const versionLabel = `v${appInfo.versionName || '1.0.0'}`
  return <div style={{ width: '100%', height: '100%', display: 'flex', flexDirection: 'column', gap: 16, padding: 24, backgroundColor: C.canvas, color: C.text }}>
    <div style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 10 }}>
      <text style={{ fontSize: 24, fontWeight: 800 }}>{appInfo.appName || 'GPUIX App'}</text>
      <Badge tone="info">{versionLabel}</Badge>
    </div>
    <Card.Root>
      <Card.Header title="Native starter" description="React 描述 UI，GPUI/wgpu 直接绘制" icon="◇" />
      <Card.Content>
        <text style={{ fontSize: 13, color: C.muted }}>这是一个可替换的起始页面。把业务组件放进 src，Android / iOS 原生宿主会保持不变。</text>
        <div style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 10 }}>
          <Badge tone="success">GPUI native</Badge>
          <Button variant="primary">开始构建</Button>
        </div>
      </Card.Content>
    </Card.Root>
  </div>
}

const isMobileHost = Boolean(
  Reflect.get(globalThis, '__gpuixMobile') || Reflect.get(globalThis, '__gpuixAndroid'),
)

render(<ThemeProvider initialMode="system"><App /></ThemeProvider>, isMobileHost ? { title: 'GPUIX App' } : undefined)
