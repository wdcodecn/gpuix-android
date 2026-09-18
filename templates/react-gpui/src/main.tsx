import { render } from '@gpuix/react'
import { Badge, Button, Card, ThemeProvider, useTheme } from 'gpuix-base-ui'

function App() {
  const { tokens: C } = useTheme()
  return <div style={{ width: '100%', height: '100%', display: 'flex', flexDirection: 'column', gap: 16, padding: 24, backgroundColor: C.canvas, color: C.text }}>
    <text style={{ fontSize: 24, fontWeight: 800 }}>GPUIX App</text>
    <Card.Root>
      <Card.Header title="Native starter" description="React 描述 UI，GPUI/wgpu 直接绘制" icon="◇" />
      <Card.Content>
        <text style={{ fontSize: 13, color: C.muted }}>这是一个可替换的起始页面。把业务组件放进 src，Android 宿主会保持不变。</text>
        <div style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 10 }}>
          <Badge tone="success">GPUI native</Badge>
          <Button variant="primary">开始构建</Button>
        </div>
      </Card.Content>
    </Card.Root>
  </div>
}

render(<ThemeProvider initialMode="system"><App /></ThemeProvider>, Reflect.get(globalThis, '__gpuixAndroid') ? { title: 'GPUIX App' } : undefined)
