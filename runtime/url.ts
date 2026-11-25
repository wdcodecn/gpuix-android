function decodeComponent(str: string): string {
  return decodeURIComponent(String(str).replace(/\+/g, ' '))
}

function encodeComponent(str: string): string {
  return encodeURIComponent(String(str)).replace(/%20/g, '+')
}

export type URLSearchParamsInit =
  | string
  | GpxURLSearchParams
  | Array<[string, string]>
  | Record<string, string>
  | null
  | undefined

export class GpxURLSearchParams {
  private _entries: Array<[string, string]> = []

  constructor(init?: URLSearchParamsInit) {
    if (init === undefined || init === null) return
    if (typeof init === 'string') {
      const raw = init.charAt(0) === '?' ? init.slice(1) : init
      if (raw) {
        const parts = raw.split('&')
        for (let i = 0; i < parts.length; i++) {
          const part = parts[i]
          if (!part) continue
          const eq = part.indexOf('=')
          if (eq === -1) {
            this._entries.push([decodeComponent(part), ''])
          } else {
            this._entries.push([decodeComponent(part.slice(0, eq)), decodeComponent(part.slice(eq + 1))])
          }
        }
      }
    } else if (init instanceof GpxURLSearchParams) {
      for (let j = 0; j < init._entries.length; j++) {
        this._entries.push([init._entries[j][0], init._entries[j][1]])
      }
    } else if (Array.isArray(init)) {
      for (let k = 0; k < init.length; k++) {
        this._entries.push([String(init[k][0]), String(init[k][1])])
      }
    } else if (typeof init === 'object') {
      const keys = Object.keys(init)
      for (let m = 0; m < keys.length; m++) {
        this._entries.push([keys[m], String(init[keys[m]])])
      }
    }
  }

  append(name: string, value: string): void {
    this._entries.push([String(name), String(value)])
  }

  delete(name: string): void {
    const key = String(name)
    this._entries = this._entries.filter((pair) => pair[0] !== key)
  }

  get(name: string): string | null {
    const key = String(name)
    for (let i = 0; i < this._entries.length; i++) {
      if (this._entries[i][0] === key) return this._entries[i][1]
    }
    return null
  }

  getAll(name: string): string[] {
    const key = String(name)
    const out: string[] = []
    for (let i = 0; i < this._entries.length; i++) {
      if (this._entries[i][0] === key) out.push(this._entries[i][1])
    }
    return out
  }

  has(name: string): boolean {
    const key = String(name)
    for (let i = 0; i < this._entries.length; i++) {
      if (this._entries[i][0] === key) return true
    }
    return false
  }

  set(name: string, value: string): void {
    const key = String(name)
    const val = String(value)
    let replaced = false
    const next: Array<[string, string]> = []
    for (let i = 0; i < this._entries.length; i++) {
      if (this._entries[i][0] === key) {
        if (!replaced) {
          next.push([key, val])
          replaced = true
        }
      } else {
        next.push(this._entries[i])
      }
    }
    if (!replaced) next.push([key, val])
    this._entries = next
  }

  sort(): void {
    this._entries.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
  }

  entries(): IterableIterator<[string, string]> {
    return this._entries.slice()[Symbol.iterator]()
  }

  keys(): IterableIterator<string> {
    return this._entries.map((p) => p[0])[Symbol.iterator]()
  }

  values(): IterableIterator<string> {
    return this._entries.map((p) => p[1])[Symbol.iterator]()
  }

  [Symbol.iterator](): IterableIterator<[string, string]> {
    return this.entries()
  }

  forEach(cb: (value: string, key: string, parent: this) => void, thisArg?: unknown): void {
    for (let i = 0; i < this._entries.length; i++) {
      cb.call(thisArg, this._entries[i][1], this._entries[i][0], this)
    }
  }

  toString(): string {
    return this._entries.map((p) => `${encodeComponent(p[0])}=${encodeComponent(p[1])}`).join('&')
  }
}

export class GpxURL {
  protocol: string
  username: string
  password: string
  host: string
  hostname: string
  port: string
  pathname: string
  search: string
  searchParams: GpxURLSearchParams
  hash: string
  origin: string
  href: string

  constructor(url: string | URL | GpxURL, base?: string | URL | GpxURL) {
    const raw = String(url)
    const hashIdx = raw.indexOf('#')
    const hash = hashIdx >= 0 ? raw.slice(hashIdx) : ''
    const beforeHash = hashIdx >= 0 ? raw.slice(0, hashIdx) : raw
    const qIdx = beforeHash.indexOf('?')
    let search = qIdx >= 0 ? beforeHash.slice(qIdx) : ''
    const main = qIdx >= 0 ? beforeHash.slice(0, qIdx) : beforeHash
    const schemeMatch = main.match(/^([A-Za-z][A-Za-z0-9+.-]*):(\/\/)?(.*)$/)
    let protocol = ''
    let rest = main
    let hasSlashes = false
    if (schemeMatch) {
      protocol = `${schemeMatch[1].toLowerCase()}:`
      hasSlashes = !!schemeMatch[2]
      rest = schemeMatch[3] || ''
    } else if (base !== undefined) {
      const b = base instanceof GpxURL ? base : new GpxURL(String(base))
      protocol = b.protocol
      hasSlashes = true
      if (main.charAt(0) === '/') {
        rest = b.host + main
      } else if (!main) {
        rest = b.host + b.pathname
        if (!search) search = b.search
      } else {
        const baseDir = b.pathname.slice(0, b.pathname.lastIndexOf('/') + 1)
        rest = b.host + baseDir + main
      }
    } else {
      throw new TypeError(`Invalid URL: ${raw}`)
    }

    let host = ''
    let pathname = '/'
    let username = ''
    let password = ''
    if (hasSlashes) {
      const slashIdx = rest.indexOf('/')
      let authority = slashIdx >= 0 ? rest.slice(0, slashIdx) : rest
      pathname = slashIdx >= 0 ? rest.slice(slashIdx) : '/'
      const atIdx = authority.lastIndexOf('@')
      if (atIdx >= 0) {
        const creds = authority.slice(0, atIdx)
        authority = authority.slice(atIdx + 1)
        const colonCred = creds.indexOf(':')
        username = colonCred >= 0 ? creds.slice(0, colonCred) : creds
        password = colonCred >= 0 ? creds.slice(colonCred + 1) : ''
      }
      host = authority
    } else {
      pathname = rest
    }

    let hostname = host
    let port = ''
    const portIdx = host.lastIndexOf(':')
    if (portIdx >= 0 && host.indexOf(']') < portIdx) {
      hostname = host.slice(0, portIdx)
      port = host.slice(portIdx + 1)
    }

    this.protocol = protocol
    this.username = username
    this.password = password
    this.host = host
    this.hostname = hostname
    this.port = port
    this.pathname = pathname || '/'
    this.search = search
    const SearchParamsCtor = (globalThis as Record<string, unknown>).URLSearchParams as
      | (new (init?: string) => GpxURLSearchParams)
      | undefined
    this.searchParams =
      typeof SearchParamsCtor === 'function'
        ? new SearchParamsCtor(search)
        : new GpxURLSearchParams(search)
    this.hash = hash
    this.origin = hasSlashes && host ? `${protocol}//${host}` : 'null'
    const credPrefix = username ? (password ? `${username}:${password}@` : `${username}@`) : ''
    this.href = `${protocol}${hasSlashes ? '//' : ''}${credPrefix}${host}${this.pathname}${search}${hash}`
  }

  toString(): string {
    const sp = this.searchParams ? this.searchParams.toString() : ''
    const s = sp ? `?${sp}` : ''
    const hasAuth = !!this.host
    return `${this.protocol}${hasAuth ? '//' : ''}${this.host}${this.pathname}${s}${this.hash}`
  }

  toJSON(): string {
    return this.toString()
  }
}

export function installUrlPolyfills(): void {
  const g = globalThis as Record<string, unknown>
  if (typeof g.URLSearchParams !== 'function') {
    g.URLSearchParams = GpxURLSearchParams
  }
  if (typeof g.URL !== 'function') {
    g.URL = GpxURL
  }
}
