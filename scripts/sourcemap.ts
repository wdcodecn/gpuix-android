export type RawSourceMap = {
  version: number
  file?: string
  sourceRoot?: string
  sources?: string[]
  sourcesContent?: Array<string | null>
  names?: string[]
  mappings?: string
}

export type SourcePosition = {
  source: string
  line: number
  column: number
  name?: string
}

type Segment = {
  generatedColumn: number
  sourceIndex: number
  originalLine: number
  originalColumn: number
  nameIndex: number
}

export type ParsedSourceMap = {
  sources: string[]
  names: string[]
  lines: Segment[][]
}

const BASE64_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
const BASE64_LOOKUP = new Int16Array(128).fill(-1)
for (let i = 0; i < BASE64_CHARS.length; i += 1) {
  BASE64_LOOKUP[BASE64_CHARS.charCodeAt(i)] = i
}

export function decodeVlq(segment: string): number[] {
  const values: number[] = []
  let shift = 0
  let result = 0
  for (let i = 0; i < segment.length; i += 1) {
    const code = segment.charCodeAt(i)
    const digit = code < 128 ? BASE64_LOOKUP[code] : -1
    if (digit < 0) break
    const continuation = (digit & 32) !== 0
    result += (digit & 31) << shift
    if (continuation) {
      shift += 5
    } else {
      const negative = (result & 1) === 1
      const value = result >> 1
      values.push(negative ? -value : value)
      result = 0
      shift = 0
    }
  }
  return values
}

export function parseSourceMap(input: RawSourceMap | string): ParsedSourceMap {
  const raw: RawSourceMap = typeof input === 'string' ? (JSON.parse(input) as RawSourceMap) : input
  const sources = Array.isArray(raw.sources) ? raw.sources : []
  const names = Array.isArray(raw.names) ? raw.names : []
  const mappings = typeof raw.mappings === 'string' ? raw.mappings : ''

  const lines: Segment[][] = []
  let sourceIndex = 0
  let originalLine = 0
  let originalColumn = 0
  let nameIndex = 0

  for (const lineStr of mappings.split(';')) {
    const lineSegments: Segment[] = []
    let generatedColumn = 0
    if (lineStr.length > 0) {
      for (const segStr of lineStr.split(',')) {
        if (!segStr) continue
        const decoded = decodeVlq(segStr)
        if (decoded.length === 0) continue
        generatedColumn += decoded[0]
        if (decoded.length >= 4) {
          sourceIndex += decoded[1]
          originalLine += decoded[2]
          originalColumn += decoded[3]
          const segNameIndex = decoded.length >= 5 ? (nameIndex += decoded[4]) : -1
          lineSegments.push({
            generatedColumn,
            sourceIndex,
            originalLine,
            originalColumn,
            nameIndex: segNameIndex,
          })
        }
      }
    }
    lines.push(lineSegments)
  }

  return { sources, names, lines }
}

export function resolveOriginalPosition(
  map: ParsedSourceMap | RawSourceMap | string,
  generatedLine1Based: number,
  generatedColumn1Based: number,
): SourcePosition | null {
  if (!Number.isFinite(generatedLine1Based) || generatedLine1Based < 1) return null
  const parsed = typeof map === 'object' && map !== null && 'lines' in map ? map : parseSourceMap(map)
  const segments = parsed.lines[generatedLine1Based - 1]
  if (!segments || segments.length === 0) return null

  const targetCol = Math.max(0, generatedColumn1Based - 1)
  let lo = 0
  let hi = segments.length - 1
  let matched: Segment | null = null
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    const seg = segments[mid]
    if (seg.generatedColumn <= targetCol) {
      matched = seg
      lo = mid + 1
    } else {
      hi = mid - 1
    }
  }
  if (!matched) {
    matched = segments[0]
  }
  const source = parsed.sources[matched.sourceIndex]
  if (!source) return null
  const pos: SourcePosition = {
    source,
    line: matched.originalLine + 1,
    column: matched.originalColumn + 1,
  }
  if (matched.nameIndex >= 0 && parsed.names[matched.nameIndex]) {
    pos.name = parsed.names[matched.nameIndex]
  }
  return pos
}

const FRAME_PATTERN = /^(\s*(?:at\s+(?:.*?\()?|[^\s@]+@))([^\r\n():]*?):(\d+):(\d+)(\)?\s*)$/gm

export function symbolicateStack(
  stack: string,
  map: ParsedSourceMap | RawSourceMap | string,
  wrapperLineOffset = 0,
): string {
  if (!stack) return stack
  const parsed = typeof map === 'object' && map !== null && 'lines' in map ? map : parseSourceMap(map)
  return stack.replace(FRAME_PATTERN, (full, prefix: string, target: string, lineStr: string, colStr: string, suffix: string) => {
    const genLine = Number(lineStr) - wrapperLineOffset
    const genCol = Number(colStr)
    if (!Number.isFinite(genLine) || genLine < 1 || !Number.isFinite(genCol)) {
      return full
    }
    const pos = resolveOriginalPosition(parsed, genLine, genCol)
    if (!pos) return full
    const cleanSource = pos.source.replace(/^\.\.\//, '')
    const nameSuffix = pos.name && !prefix.includes(pos.name) ? ` [${pos.name}]` : ''
    void target
    return `${prefix}${cleanSource}:${pos.line}:${pos.column}${suffix.trimEnd()}${nameSuffix}`
  })
}
