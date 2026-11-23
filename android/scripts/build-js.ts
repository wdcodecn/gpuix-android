import path from 'node:path'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { rename, rm, stat } from 'node:fs/promises'
import type { BunPlugin } from 'bun'
import { loadGpuixAndroidConfig, writeGradleProperties, writeTextIfChanged } from './config'

const NATIVE_SHIM_SOURCE = `
globalThis.__gpuixAndroid = true;
var __gpxNative = globalThis.__gpuixNative || {};

// ── UTF-8 / Base64 / TextEncoder / TextDecoder / atob / btoa ─────────────────
var __gpxB64Chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
var __gpxB64Lookup = (function() {
  var table = new Uint8Array(256);
  table.fill(255);
  for (var i = 0; i < __gpxB64Chars.length; i++) {
    table[__gpxB64Chars.charCodeAt(i)] = i;
  }
  return table;
})();

function __gpxUtf8Encode(str) {
  var s = String(str == null ? "" : str);
  var out = new Uint8Array(s.length * 3);
  var pos = 0;
  for (var i = 0; i < s.length; i++) {
    var c = s.charCodeAt(i);
    if (c < 0x80) {
      out[pos++] = c;
    } else if (c < 0x800) {
      out[pos++] = 0xc0 | (c >> 6);
      out[pos++] = 0x80 | (c & 0x3f);
    } else if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
      var c2 = s.charCodeAt(i + 1);
      if (c2 >= 0xdc00 && c2 <= 0xdfff) {
        var cp = 0x10000 + ((c - 0xd800) << 10) + (c2 - 0xdc00);
        out[pos++] = 0xf0 | (cp >> 18);
        out[pos++] = 0x80 | ((cp >> 12) & 0x3f);
        out[pos++] = 0x80 | ((cp >> 6) & 0x3f);
        out[pos++] = 0x80 | (cp & 0x3f);
        i++;
        continue;
      }
      out[pos++] = 0xef; out[pos++] = 0xbf; out[pos++] = 0xbd;
    } else if (c >= 0xd800 && c <= 0xdfff) {
      out[pos++] = 0xef; out[pos++] = 0xbf; out[pos++] = 0xbd;
    } else {
      out[pos++] = 0xe0 | (c >> 12);
      out[pos++] = 0x80 | ((c >> 6) & 0x3f);
      out[pos++] = 0x80 | (c & 0x3f);
    }
  }
  return out.subarray(0, pos);
}

function __gpxUtf8Decode(input) {
  if (input == null) return "";
  var bytes;
  if (input instanceof Uint8Array) {
    bytes = input;
  } else if (input instanceof ArrayBuffer) {
    bytes = new Uint8Array(input);
  } else if (ArrayBuffer.isView(input)) {
    bytes = new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  } else {
    return String(input);
  }
  var out = "";
  var i = 0;
  var len = bytes.length;
  while (i < len) {
    var b0 = bytes[i++];
    if (b0 < 0x80) {
      out += String.fromCharCode(b0);
    } else if ((b0 & 0xe0) === 0xc0 && i < len) {
      var b1 = bytes[i++] & 0x3f;
      out += String.fromCharCode(((b0 & 0x1f) << 6) | b1);
    } else if ((b0 & 0xf0) === 0xe0 && i + 1 < len) {
      var b1e = bytes[i++] & 0x3f;
      var b2e = bytes[i++] & 0x3f;
      out += String.fromCharCode(((b0 & 0x0f) << 12) | (b1e << 6) | b2e);
    } else if ((b0 & 0xf8) === 0xf0 && i + 2 < len) {
      var b1f = bytes[i++] & 0x3f;
      var b2f = bytes[i++] & 0x3f;
      var b3f = bytes[i++] & 0x3f;
      var cp = ((b0 & 0x07) << 18) | (b1f << 12) | (b2f << 6) | b3f;
      if (cp > 0xffff) {
        cp -= 0x10000;
        out += String.fromCharCode(0xd800 + (cp >> 10), 0xdc00 + (cp & 0x3ff));
      } else {
        out += String.fromCharCode(cp);
      }
    } else {
      out += "\ufffd";
    }
  }
  return out;
}

function __gpxBytesToBase64(bytes) {
  var len = bytes.length;
  var out = "";
  for (var i = 0; i < len; i += 3) {
    var a = bytes[i];
    var b = i + 1 < len ? bytes[i + 1] : 0;
    var c = i + 2 < len ? bytes[i + 2] : 0;
    var triple = (a << 16) | (b << 8) | c;
    out += __gpxB64Chars.charAt((triple >> 18) & 0x3f);
    out += __gpxB64Chars.charAt((triple >> 12) & 0x3f);
    out += i + 1 < len ? __gpxB64Chars.charAt((triple >> 6) & 0x3f) : "=";
    out += i + 2 < len ? __gpxB64Chars.charAt(triple & 0x3f) : "=";
  }
  return out;
}

function __gpxBase64ToBytes(b64) {
  var clean = String(b64 || "").replace(/\\s+/g, "");
  if (!clean) return new Uint8Array(0);
  var len = clean.length;
  var pad = 0;
  if (len >= 2 && clean.charCodeAt(len - 1) === 61) pad++;
  if (len >= 2 && clean.charCodeAt(len - 2) === 61) pad++;
  var byteLen = Math.max(0, ((len / 4) | 0) * 3 - pad);
  var out = new Uint8Array(byteLen);
  var p = 0;
  for (var i = 0; i < len; i += 4) {
    var c0 = __gpxB64Lookup[clean.charCodeAt(i) & 0xff];
    var c1 = __gpxB64Lookup[clean.charCodeAt(i + 1) & 0xff];
    var c2 = clean.charCodeAt(i + 2) === 61 ? 0 : __gpxB64Lookup[clean.charCodeAt(i + 2) & 0xff];
    var c3 = clean.charCodeAt(i + 3) === 61 ? 0 : __gpxB64Lookup[clean.charCodeAt(i + 3) & 0xff];
    if (c0 === 255 || c1 === 255 || c2 === 255 || c3 === 255) {
      throw new Error("Invalid base64 string");
    }
    var triple = (c0 << 18) | (c1 << 12) | (c2 << 6) | c3;
    if (p < byteLen) out[p++] = (triple >> 16) & 0xff;
    if (p < byteLen) out[p++] = (triple >> 8) & 0xff;
    if (p < byteLen) out[p++] = triple & 0xff;
  }
  return out;
}

function __gpxToUint8Array(data) {
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  return __gpxUtf8Encode(String(data));
}

if (typeof globalThis.TextEncoder !== "function") {
  globalThis.TextEncoder = function TextEncoder() {
    this.encoding = "utf-8";
  };
  globalThis.TextEncoder.prototype.encode = function(input) {
    return __gpxUtf8Encode(input);
  };
  globalThis.TextEncoder.prototype.encodeInto = function(src, dest) {
    var encoded = __gpxUtf8Encode(src);
    var n = Math.min(encoded.length, dest.length);
    dest.set(encoded.subarray(0, n));
    return { read: String(src || "").length, written: n };
  };
}

if (typeof globalThis.TextDecoder !== "function") {
  globalThis.TextDecoder = function TextDecoder(label) {
    this.encoding = label ? String(label).toLowerCase() : "utf-8";
  };
  globalThis.TextDecoder.prototype.decode = function(input) {
    return __gpxUtf8Decode(input);
  };
}

if (typeof globalThis.btoa !== "function") {
  globalThis.btoa = function(str) {
    var s = String(str);
    var bytes = new Uint8Array(s.length);
    for (var i = 0; i < s.length; i++) {
      var code = s.charCodeAt(i);
      if (code > 0xff) throw new Error("btoa: character out of Latin1 range");
      bytes[i] = code;
    }
    return __gpxBytesToBase64(bytes);
  };
}

if (typeof globalThis.atob !== "function") {
  globalThis.atob = function(b64) {
    var bytes = __gpxBase64ToBytes(b64);
    var out = "";
    for (var i = 0; i < bytes.length; i++) {
      out += String.fromCharCode(bytes[i]);
    }
    return out;
  };
}

// ── URLSearchParams & URL ────────────────────────────────────────────────────
function __gpxDecodeComponent(str) {
  return decodeURIComponent(String(str).replace(/\\+/g, " "));
}

function __gpxEncodeComponent(str) {
  return encodeURIComponent(String(str)).replace(/%20/g, "+");
}

function GpxURLSearchParams(init) {
  this._entries = [];
  if (init === undefined || init === null) return;
  if (typeof init === "string") {
    var raw = init.charAt(0) === "?" ? init.slice(1) : init;
    if (raw) {
      var parts = raw.split("&");
      for (var i = 0; i < parts.length; i++) {
        var part = parts[i];
        if (!part) continue;
        var eq = part.indexOf("=");
        if (eq === -1) {
          this._entries.push([__gpxDecodeComponent(part), ""]);
        } else {
          this._entries.push([__gpxDecodeComponent(part.slice(0, eq)), __gpxDecodeComponent(part.slice(eq + 1))]);
        }
      }
    }
  } else if (init instanceof GpxURLSearchParams) {
    for (var j = 0; j < init._entries.length; j++) {
      this._entries.push([init._entries[j][0], init._entries[j][1]]);
    }
  } else if (Array.isArray(init)) {
    for (var k = 0; k < init.length; k++) {
      this._entries.push([String(init[k][0]), String(init[k][1])]);
    }
  } else if (typeof init === "object") {
    var keys = Object.keys(init);
    for (var m = 0; m < keys.length; m++) {
      this._entries.push([keys[m], String(init[keys[m]])]);
    }
  }
}
GpxURLSearchParams.prototype.append = function(name, value) {
  this._entries.push([String(name), String(value)]);
};
GpxURLSearchParams.prototype.delete = function(name) {
  var key = String(name);
  this._entries = this._entries.filter(function(pair) { return pair[0] !== key; });
};
GpxURLSearchParams.prototype.get = function(name) {
  var key = String(name);
  for (var i = 0; i < this._entries.length; i++) {
    if (this._entries[i][0] === key) return this._entries[i][1];
  }
  return null;
};
GpxURLSearchParams.prototype.getAll = function(name) {
  var key = String(name);
  var out = [];
  for (var i = 0; i < this._entries.length; i++) {
    if (this._entries[i][0] === key) out.push(this._entries[i][1]);
  }
  return out;
};
GpxURLSearchParams.prototype.has = function(name) {
  var key = String(name);
  for (var i = 0; i < this._entries.length; i++) {
    if (this._entries[i][0] === key) return true;
  }
  return false;
};
GpxURLSearchParams.prototype.set = function(name, value) {
  var key = String(name);
  var val = String(value);
  var replaced = false;
  var next = [];
  for (var i = 0; i < this._entries.length; i++) {
    if (this._entries[i][0] === key) {
      if (!replaced) {
        next.push([key, val]);
        replaced = true;
      }
    } else {
      next.push(this._entries[i]);
    }
  }
  if (!replaced) next.push([key, val]);
  this._entries = next;
};
GpxURLSearchParams.prototype.sort = function() {
  this._entries.sort(function(a, b) { return a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0; });
};
GpxURLSearchParams.prototype.entries = function() { return this._entries.slice()[Symbol.iterator](); };
GpxURLSearchParams.prototype.keys = function() { return this._entries.map(function(p) { return p[0]; })[Symbol.iterator](); };
GpxURLSearchParams.prototype.values = function() { return this._entries.map(function(p) { return p[1]; })[Symbol.iterator](); };
GpxURLSearchParams.prototype[Symbol.iterator] = function() { return this.entries(); };
GpxURLSearchParams.prototype.forEach = function(cb, thisArg) {
  for (var i = 0; i < this._entries.length; i++) {
    cb.call(thisArg, this._entries[i][1], this._entries[i][0], this);
  }
};
GpxURLSearchParams.prototype.toString = function() {
  return this._entries.map(function(p) {
    return __gpxEncodeComponent(p[0]) + "=" + __gpxEncodeComponent(p[1]);
  }).join("&");
};
if (typeof globalThis.URLSearchParams !== "function") {
  globalThis.URLSearchParams = GpxURLSearchParams;
}

function GpxURL(url, base) {
  var raw = String(url);
  var hashIdx = raw.indexOf("#");
  var hash = hashIdx >= 0 ? raw.slice(hashIdx) : "";
  var beforeHash = hashIdx >= 0 ? raw.slice(0, hashIdx) : raw;
  var qIdx = beforeHash.indexOf("?");
  var search = qIdx >= 0 ? beforeHash.slice(qIdx) : "";
  var main = qIdx >= 0 ? beforeHash.slice(0, qIdx) : beforeHash;
  var schemeMatch = main.match(/^([A-Za-z][A-Za-z0-9+.-]*):(\\/\\/)?(.*)$/);
  var protocol = "";
  var rest = main;
  var hasSlashes = false;
  if (schemeMatch) {
    protocol = schemeMatch[1].toLowerCase() + ":";
    hasSlashes = !!schemeMatch[2];
    rest = schemeMatch[3] || "";
  } else if (base !== undefined) {
    var b = base instanceof GpxURL ? base : new GpxURL(String(base));
    protocol = b.protocol;
    hasSlashes = true;
    if (main.charAt(0) === "/") {
      rest = b.host + main;
    } else if (!main) {
      rest = b.host + b.pathname;
      if (!search) search = b.search;
    } else {
      var baseDir = b.pathname.slice(0, b.pathname.lastIndexOf("/") + 1);
      rest = b.host + baseDir + main;
    }
  } else {
    throw new TypeError("Invalid URL: " + raw);
  }
  var host = "";
  var pathname = "/";
  var username = "";
  var password = "";
  if (hasSlashes) {
    var slashIdx = rest.indexOf("/");
    var authority = slashIdx >= 0 ? rest.slice(0, slashIdx) : rest;
    pathname = slashIdx >= 0 ? rest.slice(slashIdx) : "/";
    var atIdx = authority.lastIndexOf("@");
    if (atIdx >= 0) {
      var creds = authority.slice(0, atIdx);
      authority = authority.slice(atIdx + 1);
      var colonCred = creds.indexOf(":");
      username = colonCred >= 0 ? creds.slice(0, colonCred) : creds;
      password = colonCred >= 0 ? creds.slice(colonCred + 1) : "";
    }
    host = authority;
  } else {
    pathname = rest;
  }
  var hostname = host;
  var port = "";
  var portIdx = host.lastIndexOf(":");
  if (portIdx >= 0 && host.indexOf("]") < portIdx) {
    hostname = host.slice(0, portIdx);
    port = host.slice(portIdx + 1);
  }
  this.protocol = protocol;
  this.username = username;
  this.password = password;
  this.host = host;
  this.hostname = hostname;
  this.port = port;
  this.pathname = pathname || "/";
  this.search = search;
  this.searchParams = new globalThis.URLSearchParams(search);
  this.hash = hash;
  this.origin = hasSlashes && host ? protocol + "//" + host : "null";
  var credPrefix = username ? (password ? username + ":" + password + "@" : username + "@") : "";
  this.href = protocol + (hasSlashes ? "//" : "") + credPrefix + host + this.pathname + search + hash;
}
GpxURL.prototype.toString = function() {
  var sp = this.searchParams ? this.searchParams.toString() : "";
  var s = sp ? "?" + sp : "";
  var hasAuth = !!this.host;
  return this.protocol + (hasAuth ? "//" : "") + this.host + this.pathname + s + this.hash;
};
GpxURL.prototype.toJSON = function() { return this.toString(); };
if (typeof globalThis.URL !== "function") {
  globalThis.URL = GpxURL;
}

// ── AbortController / Headers / Response / fetch ─────────────────────────────
function GpxAbortSignal() {
  this.aborted = false;
  this.reason = undefined;
  this.onabort = null;
  this._listeners = new Set();
}
GpxAbortSignal.prototype.addEventListener = function(type, fn) {
  if (type === "abort" && typeof fn === "function") this._listeners.add(fn);
};
GpxAbortSignal.prototype.removeEventListener = function(type, fn) {
  if (type === "abort") this._listeners.delete(fn);
};
GpxAbortSignal.prototype.throwIfAborted = function() {
  if (this.aborted) {
    var err = new Error(this.reason ? String(this.reason) : "The operation was aborted");
    err.name = "AbortError";
    throw err;
  }
};
GpxAbortSignal.abort = function(reason) {
  var sig = new GpxAbortSignal();
  sig.aborted = true;
  sig.reason = reason;
  return sig;
};

function GpxAbortController() {
  this.signal = new GpxAbortSignal();
}
GpxAbortController.prototype.abort = function(reason) {
  if (this.signal.aborted) return;
  this.signal.aborted = true;
  this.signal.reason = reason;
  var ev = { type: "abort", target: this.signal };
  if (typeof this.signal.onabort === "function") {
    try { this.signal.onabort(ev); } catch (_) {}
  }
  this.signal._listeners.forEach(function(fn) {
    try { fn(ev); } catch (_) {}
  });
};
if (typeof globalThis.AbortSignal !== "function") globalThis.AbortSignal = GpxAbortSignal;
if (typeof globalThis.AbortController !== "function") globalThis.AbortController = GpxAbortController;

function GpxHeaders(init) {
  this._map = new Map();
  if (!init) return;
  var self = this;
  if (init instanceof GpxHeaders) {
    init._map.forEach(function(entry) {
      self._map.set(entry[0].toLowerCase(), [entry[0], entry[1]]);
    });
  } else if (Array.isArray(init)) {
    for (var i = 0; i < init.length; i++) {
      this.append(init[i][0], init[i][1]);
    }
  } else if (typeof init === "object") {
    var keys = Object.keys(init);
    for (var j = 0; j < keys.length; j++) {
      this.set(keys[j], init[keys[j]]);
    }
  }
}
GpxHeaders.prototype.append = function(name, value) {
  var k = String(name).toLowerCase();
  var existing = this._map.get(k);
  if (existing) {
    existing[1] = existing[1] + ", " + String(value);
  } else {
    this._map.set(k, [String(name), String(value)]);
  }
};
GpxHeaders.prototype.delete = function(name) { this._map.delete(String(name).toLowerCase()); };
GpxHeaders.prototype.get = function(name) {
  var entry = this._map.get(String(name).toLowerCase());
  return entry ? entry[1] : null;
};
GpxHeaders.prototype.has = function(name) { return this._map.has(String(name).toLowerCase()); };
GpxHeaders.prototype.set = function(name, value) {
  this._map.set(String(name).toLowerCase(), [String(name), String(value)]);
};
GpxHeaders.prototype.entries = function() {
  var arr = [];
  this._map.forEach(function(e) { arr.push([e[0].toLowerCase(), e[1]]); });
  return arr[Symbol.iterator]();
};
GpxHeaders.prototype.keys = function() {
  var arr = [];
  this._map.forEach(function(e) { arr.push(e[0].toLowerCase()); });
  return arr[Symbol.iterator]();
};
GpxHeaders.prototype.values = function() {
  var arr = [];
  this._map.forEach(function(e) { arr.push(e[1]); });
  return arr[Symbol.iterator]();
};
GpxHeaders.prototype[Symbol.iterator] = function() { return this.entries(); };
GpxHeaders.prototype.forEach = function(cb, thisArg) {
  var self = this;
  this._map.forEach(function(e) { cb.call(thisArg, e[1], e[0].toLowerCase(), self); });
};
if (typeof globalThis.Headers !== "function") globalThis.Headers = GpxHeaders;

function GpxResponse(bodyBytes, init) {
  var opts = init || {};
  this._bytes = bodyBytes instanceof Uint8Array ? bodyBytes : __gpxToUint8Array(bodyBytes || "");
  this.status = typeof opts.status === "number" ? opts.status : 200;
  this.statusText = typeof opts.statusText === "string" ? opts.statusText : "";
  this.ok = this.status >= 200 && this.status < 300;
  this.url = opts.url ? String(opts.url) : "";
  this.headers = opts.headers instanceof GpxHeaders ? opts.headers : new GpxHeaders(opts.headers);
  this.redirected = !!opts.redirected;
  this.type = "basic";
  this.bodyUsed = false;
}
GpxResponse.prototype.arrayBuffer = function() {
  this.bodyUsed = true;
  var copy = new Uint8Array(this._bytes.length);
  copy.set(this._bytes);
  return Promise.resolve(copy.buffer);
};
GpxResponse.prototype.bytes = function() {
  this.bodyUsed = true;
  return Promise.resolve(new Uint8Array(this._bytes));
};
GpxResponse.prototype.text = function() {
  this.bodyUsed = true;
  return Promise.resolve(__gpxUtf8Decode(this._bytes));
};
GpxResponse.prototype.json = function() {
  return this.text().then(function(txt) { return JSON.parse(txt); });
};
GpxResponse.prototype.clone = function() {
  return new GpxResponse(new Uint8Array(this._bytes), {
    status: this.status,
    statusText: this.statusText,
    url: this.url,
    headers: new GpxHeaders(this.headers),
    redirected: this.redirected,
  });
};
if (typeof globalThis.Response !== "function") globalThis.Response = GpxResponse;

if (typeof globalThis.fetch !== "function") {
  globalThis.fetch = function(input, init) {
    if (typeof __gpxNative.nativeFetch !== "function") {
      return Promise.reject(new Error("nativeFetch is unavailable on this GPUIX build"));
    }
    var opts = init || {};
    var url = typeof input === "string" ? input : (input && input.url ? String(input.url) : String(input));
    var method = (opts.method || (input && input.method) || "GET").toUpperCase();
    var headers = new GpxHeaders((input && input.headers) || undefined);
    if (opts.headers) {
      var extra = new GpxHeaders(opts.headers);
      extra.forEach(function(v, k) { headers.set(k, v); });
    }
    var signal = opts.signal;
    if (signal && signal.aborted) {
      var abortErr = new Error("Aborted");
      abortErr.name = "AbortError";
      return Promise.reject(abortErr);
    }
    var headerPairs = [];
    headers.forEach(function(v, k) { headerPairs.push([k, v]); });
    var req = {
      url: url,
      method: method,
      headers: headerPairs,
      timeoutMs: typeof opts.timeoutMs === "number" ? opts.timeoutMs : 30000,
      redirect: opts.redirect === "manual" ? "manual" : "follow",
    };
    var body = opts.body !== undefined ? opts.body : (input && input.body !== undefined ? input.body : undefined);
    if (body !== undefined && body !== null) {
      if (typeof body === "string") {
        req.bodyText = body;
      } else if (body instanceof globalThis.URLSearchParams) {
        req.bodyText = body.toString();
        if (!headers.has("content-type")) {
          req.headers.push(["content-type", "application/x-www-form-urlencoded;charset=UTF-8"]);
        }
      } else if (body instanceof ArrayBuffer || ArrayBuffer.isView(body)) {
        req.bodyBase64 = __gpxBytesToBase64(__gpxToUint8Array(body));
      } else {
        req.bodyText = String(body);
      }
    }
    return new Promise(function(resolve, reject) {
      var settled = false;
      var onAbort = function() {
        if (settled) return;
        settled = true;
        var err = new Error("The operation was aborted");
        err.name = "AbortError";
        reject(err);
      };
      if (signal && typeof signal.addEventListener === "function") {
        signal.addEventListener("abort", onAbort);
      }
      Promise.resolve(__gpxNative.nativeFetch(JSON.stringify(req))).then(
        function(rawJson) {
          if (signal && typeof signal.removeEventListener === "function") {
            signal.removeEventListener("abort", onAbort);
          }
          if (settled) return;
          settled = true;
          try {
            var parsed = JSON.parse(rawJson);
            var bytes = parsed.bodyBase64 ? __gpxBase64ToBytes(parsed.bodyBase64) : new Uint8Array(0);
            resolve(new GpxResponse(bytes, {
              status: parsed.status,
              ok: parsed.ok,
              headers: parsed.headers,
              url: parsed.url || url,
            }));
          } catch (e) {
            reject(e);
          }
        },
        function(err) {
          if (signal && typeof signal.removeEventListener === "function") {
            signal.removeEventListener("abort", onAbort);
          }
          if (settled) return;
          settled = true;
          reject(err instanceof Error ? err : new Error(String(err)));
        }
      );
    });
  };
}

// ── Persistent localStorage backed by Android SharedPreferences ──────────────
if (typeof globalThis.localStorage !== "object" || !globalThis.localStorage) {
  var __gpxFallbackStorage = new Map();
  globalThis.localStorage = {
    getItem: function(key) {
      var k = String(key);
      if (typeof __gpxNative.kvGet === "function") {
        var val = __gpxNative.kvGet(k);
        return val === undefined || val === null ? null : String(val);
      }
      return __gpxFallbackStorage.has(k) ? __gpxFallbackStorage.get(k) : null;
    },
    setItem: function(key, value) {
      var k = String(key);
      var v = String(value);
      if (typeof __gpxNative.kvSet === "function") {
        __gpxNative.kvSet(k, v);
      } else {
        __gpxFallbackStorage.set(k, v);
      }
    },
    removeItem: function(key) {
      var k = String(key);
      if (typeof __gpxNative.kvRemove === "function") {
        __gpxNative.kvRemove(k);
      } else {
        __gpxFallbackStorage.delete(k);
      }
    },
    clear: function() {
      if (typeof __gpxNative.kvClear === "function") {
        __gpxNative.kvClear();
      } else {
        __gpxFallbackStorage.clear();
      }
    },
    key: function(index) {
      var keys = typeof __gpxNative.kvKeys === "function"
        ? __gpxNative.kvKeys()
        : Array.from(__gpxFallbackStorage.keys());
      return index >= 0 && index < keys.length ? keys[index] : null;
    },
    get length() {
      if (typeof __gpxNative.kvKeys === "function") {
        return __gpxNative.kvKeys().length;
      }
      return __gpxFallbackStorage.size;
    }
  };
}

// ── Native Bridge Bus, WebSocket, BackHandler & DeepLink ─────────────────────
var __gpxNextReqId = 1;
var __gpxPendingBridge = new Map();
var __gpxEventChannels = new Map();
var __gpxBackHandlers = [];
var __gpxDeepLinkListeners = new Set();
var __gpxLastDeepLink = null;
var __gpxNextWsId = 1;
var __gpxWsRegistry = new Map();

function __gpxEmitChannel(channel, payload) {
  var set = __gpxEventChannels.get(channel);
  if (!set) return;
  set.forEach(function(fn) {
    try { fn(payload); } catch (_) {}
  });
}

function __gpxInvokeNative(module, method, args, timeoutMs) {
  if (typeof __gpxNative.nativeInvoke !== "function") {
    return Promise.reject(new Error("nativeInvoke is unavailable"));
  }
  var id = __gpxNextReqId++;
  var ttl = typeof timeoutMs === "number" ? timeoutMs : 30000;
  return new Promise(function(resolve, reject) {
    var timer = setTimeout(function() {
      if (__gpxPendingBridge.delete(id)) {
        reject(new Error("Native bridge timeout: " + module + "." + method));
      }
    }, ttl);
    __gpxPendingBridge.set(id, { resolve: resolve, reject: reject, timer: timer });
    var accepted = false;
    try {
      accepted = __gpxNative.nativeInvoke(id, String(module), String(method), JSON.stringify(args || {}));
    } catch (err) {
      clearTimeout(timer);
      __gpxPendingBridge.delete(id);
      reject(err instanceof Error ? err : new Error(String(err)));
      return;
    }
    if (!accepted) {
      clearTimeout(timer);
      __gpxPendingBridge.delete(id);
      reject(new Error("Native bridge rejected call: " + module + "." + method));
    }
  });
}

function __gpxEmitWs(ws, type, ev) {
  if (!ws) return;
  var handler = ws["on" + type];
  if (typeof handler === "function") {
    try { handler.call(ws, ev); } catch (_) {}
  }
  var set = ws._listeners[type];
  if (set) {
    set.forEach(function(fn) {
      try { fn.call(ws, ev); } catch (_) {}
    });
  }
}

function GpxWebSocket(url, protocols) {
  if (!(this instanceof GpxWebSocket)) {
    throw new TypeError("WebSocket must be constructed with new");
  }
  this.url = String(url);
  this.protocol = Array.isArray(protocols) ? String(protocols[0] || "") : (protocols ? String(protocols) : "");
  this.extensions = "";
  this.binaryType = "arraybuffer";
  this.bufferedAmount = 0;
  this.readyState = 0; // CONNECTING
  this.onopen = null;
  this.onmessage = null;
  this.onerror = null;
  this.onclose = null;
  this._listeners = { open: new Set(), message: new Set(), error: new Set(), close: new Set() };
  this._id = __gpxNextWsId++;
  this._closeTimer = null;
  __gpxWsRegistry.set(this._id, this);
  var ok = typeof __gpxNative.wsConnect === "function"
    ? __gpxNative.wsConnect(this._id, this.url, "{}")
    : false;
  if (!ok) {
    var self = this;
    setTimeout(function() {
      if (self.readyState === 3) return;
      self.readyState = 3;
      __gpxWsRegistry.delete(self._id);
      __gpxEmitWs(self, "error", { type: "error", message: "WebSocket connect failed", target: self });
      __gpxEmitWs(self, "close", { type: "close", code: 1006, reason: "Connect failed", wasClean: false, target: self });
    }, 0);
  }
}
GpxWebSocket.CONNECTING = GpxWebSocket.prototype.CONNECTING = 0;
GpxWebSocket.OPEN = GpxWebSocket.prototype.OPEN = 1;
GpxWebSocket.CLOSING = GpxWebSocket.prototype.CLOSING = 2;
GpxWebSocket.CLOSED = GpxWebSocket.prototype.CLOSED = 3;
GpxWebSocket.prototype.addEventListener = function(type, fn) {
  if (this._listeners[type] && typeof fn === "function") this._listeners[type].add(fn);
};
GpxWebSocket.prototype.removeEventListener = function(type, fn) {
  if (this._listeners[type]) this._listeners[type].delete(fn);
};
GpxWebSocket.prototype.send = function(data) {
  if (this.readyState !== 1) {
    throw new Error("WebSocket is not open (readyState=" + this.readyState + ")");
  }
  if (typeof __gpxNative.wsSend !== "function") return;
  if (typeof data === "string") {
    __gpxNative.wsSend(this._id, data, null);
  } else if (data instanceof ArrayBuffer || ArrayBuffer.isView(data)) {
    __gpxNative.wsSend(this._id, null, __gpxBytesToBase64(__gpxToUint8Array(data)));
  } else {
    __gpxNative.wsSend(this._id, String(data), null);
  }
};
GpxWebSocket.prototype.close = function(code, reason) {
  if (this.readyState === 2 || this.readyState === 3) return;
  this.readyState = 2;
  var closeCode = typeof code === "number" ? code : 1000;
  var closeReason = reason !== undefined ? String(reason) : "";
  if (typeof __gpxNative.wsClose === "function") {
    __gpxNative.wsClose(this._id, closeCode, closeReason);
  }
  var self = this;
  this._closeTimer = setTimeout(function() {
    if (self.readyState === 3) return;
    self.readyState = 3;
    __gpxWsRegistry.delete(self._id);
    __gpxEmitWs(self, "close", {
      type: "close",
      code: closeCode,
      reason: closeReason,
      wasClean: closeCode === 1000,
      target: self,
    });
  }, 80);
};
if (typeof globalThis.WebSocket !== "function") {
  globalThis.WebSocket = GpxWebSocket;
}

if (!globalThis.gpuix) {
  globalThis.gpuix = {
    invoke: function(module, method, args, timeoutMs) {
      return __gpxInvokeNative(module, method, args, timeoutMs);
    },
    onEvent: function(channel, fn) {
      if (typeof fn !== "function") return function() {};
      var key = String(channel);
      var set = __gpxEventChannels.get(key);
      if (!set) {
        set = new Set();
        __gpxEventChannels.set(key, set);
      }
      set.add(fn);
      return function() { set.delete(fn); };
    },
    onBackPressed: function(handler) {
      if (typeof handler !== "function") return function() {};
      __gpxBackHandlers.push(handler);
      return function() {
        var idx = __gpxBackHandlers.lastIndexOf(handler);
        if (idx >= 0) __gpxBackHandlers.splice(idx, 1);
      };
    },
    onDeepLink: function(handler) {
      if (typeof handler !== "function") return function() {};
      __gpxDeepLinkListeners.add(handler);
      if (__gpxLastDeepLink) {
        try { handler(__gpxLastDeepLink); } catch (_) {}
      }
      return function() { __gpxDeepLinkListeners.delete(handler); };
    },
    notifications: {
      areEnabled: function() { return __gpxInvokeNative("notifications", "areEnabled", {}); },
      show: function(opts) { return __gpxInvokeNative("notifications", "show", opts || {}); },
      schedule: function(opts) { return __gpxInvokeNative("notifications", "schedule", opts || {}); },
      showProgress: function(opts) { return __gpxInvokeNative("notifications", "showProgress", opts || {}); },
      cancel: function(id) { return __gpxInvokeNative("notifications", "cancel", { id: id }); },
      cancelAll: function() { return __gpxInvokeNative("notifications", "cancelAll", {}); },
    },
    audio: {
      playTone: function(type) { return __gpxInvokeNative("audio", "playTone", { type: type || "notification" }); },
      getVolume: function(stream) { return __gpxInvokeNative("audio", "getVolume", { stream: stream || "music" }); },
      setVolume: function(volume, stream) { return __gpxInvokeNative("audio", "setVolume", { volume: volume, stream: stream || "music" }); },
      speak: function(text, opts) { return __gpxInvokeNative("audio", "speak", Object.assign({ text: String(text || "") }, opts || {})); },
      stopSpeak: function() { return __gpxInvokeNative("audio", "stopSpeak", {}); },
    },
    haptics: {
      impact: function(style) { return __gpxInvokeNative("haptics", "impact", { style: style || "medium" }); },
      vibrate: function(opts) { return __gpxInvokeNative("haptics", "vibrate", opts || {}); },
    },
    biometrics: {
      canAuthenticate: function() { return __gpxInvokeNative("biometrics", "canAuthenticate", {}); },
      authenticate: function(opts) { return __gpxInvokeNative("biometrics", "authenticate", opts || {}, 120000); },
    },
    torch: {
      isAvailable: function() { return __gpxInvokeNative("torch", "isAvailable", {}); },
      setEnabled: function(enabled) { return __gpxInvokeNative("torch", "setEnabled", { enabled: !!enabled }); },
    },
    sensors: {
      sample: function(type) { return __gpxInvokeNative("sensors", "sample", { type: type || "accelerometer" }); },
      start: function(type, intervalMs) { return __gpxInvokeNative("sensors", "start", { type: type || "accelerometer", intervalMs: intervalMs || 100 }); },
      stop: function(type) { return __gpxInvokeNative("sensors", "stop", { type: type || "accelerometer" }); },
      onData: function(fn) { return globalThis.gpuix.onEvent("sensor", fn); },
    },
    device: {
      getInfo: function() { return __gpxInvokeNative("device", "getInfo", {}); },
      getBattery: function() { return __gpxInvokeNative("device", "getBattery", {}); },
    },
    system: {
      toast: function(message, isLong) { return __gpxInvokeNative("system", "toast", { message: String(message || ""), long: !!isLong }); },
      alert: function(opts) { return __gpxInvokeNative("system", "alert", opts || {}, 120000); },
      setKeepScreenOn: function(enabled) { return __gpxInvokeNative("system", "setKeepScreenOn", { enabled: !!enabled }); },
      setBrightness: function(value) { return __gpxInvokeNative("system", "setBrightness", { value: value }); },
      setStatusBar: function(opts) { return __gpxInvokeNative("system", "setStatusBar", opts || {}); },
      openAppSettings: function() { return __gpxInvokeNative("system", "openAppSettings", {}); },
      moveToBack: function() { return __gpxInvokeNative("system", "moveToBack", {}); },
    },
    clipboard: {
      read: function() { return __gpxInvokeNative("clipboard", "read", {}); },
      write: function(text) { return __gpxInvokeNative("clipboard", "write", { text: String(text || "") }); },
    },
    launcher: {
      openUrl: function(url) { return __gpxInvokeNative("launcher", "openUrl", { url: String(url || "") }); },
      canOpenUrl: function(url) { return __gpxInvokeNative("launcher", "canOpenUrl", { url: String(url || "") }); },
      getInitialUrl: function() { return __gpxInvokeNative("launcher", "getInitialUrl", {}); },
      share: function(opts) { return __gpxInvokeNative("launcher", "share", opts || {}, 120000); },
    },
    permissions: {
      check: function(permission) { return __gpxInvokeNative("permissions", "check", { permission: String(permission || "") }); },
      request: function(permissions) {
        var list = Array.isArray(permissions) ? permissions : [permissions];
        return __gpxInvokeNative("permissions", "request", { permissions: list }, 120000);
      },
    },
    storage: {
      get: function(key) { return __gpxInvokeNative("storage", "get", { key: String(key || "") }); },
      set: function(key, value) { return __gpxInvokeNative("storage", "set", { key: String(key || ""), value: String(value || "") }); },
      remove: function(key) { return __gpxInvokeNative("storage", "remove", { key: String(key || "") }); },
      clear: function() { return __gpxInvokeNative("storage", "clear", {}); },
      keys: function() { return __gpxInvokeNative("storage", "keys", {}); },
    },
    secureStorage: {
      write: function(service, account, value) {
        return __gpxInvokeNative("secureStorage", "write", { service: service || "gpuix", account: account || "default", value: String(value || "") });
      },
      read: function(service, account) {
        return __gpxInvokeNative("secureStorage", "read", { service: service || "gpuix", account: account || "default" });
      },
      delete: function(service, account) {
        return __gpxInvokeNative("secureStorage", "delete", { service: service || "gpuix", account: account || "default" });
      },
    },
    media: {
      pickImage: function() { return __gpxInvokeNative("media", "pickImage", {}, 120000); },
      pickFile: function(mimeType) { return __gpxInvokeNative("media", "pickFile", { mimeType: mimeType || "*/*" }, 120000); },
      takePhoto: function() { return __gpxInvokeNative("media", "takePhoto", {}, 120000); },
    },
    location: {
      getCurrentPosition: function() { return __gpxInvokeNative("location", "getCurrentPosition", {}, 30000); },
    },
  };
}

var __gpxViewport = globalThis.__gpuixViewport;
if (!__gpxViewport) {
  var sizeListeners = new Set();
  var insetsListeners = new Set();
  var lastSize = null;
  var lastInsets = null;
  __gpxViewport = {
    subscribeSize: function(fn) {
      sizeListeners.add(fn);
      if (lastSize) { try { fn(lastSize); } catch (_) {} }
      return function() { sizeListeners.delete(fn); };
    },
    subscribeInsets: function(fn) {
      insetsListeners.add(fn);
      if (lastInsets) { try { fn(lastInsets); } catch (_) {} }
      return function() { insetsListeners.delete(fn); };
    },
    __emitSize: function(next) {
      lastSize = next;
      sizeListeners.forEach(function(fn) { try { fn(next); } catch (_) {} });
    },
    __emitInsets: function(next) {
      lastInsets = next;
      insetsListeners.forEach(function(fn) { try { fn(next); } catch (_) {} });
    }
  };
  globalThis.__gpuixViewport = __gpxViewport;
}

// Reusable scratch buffer + hand-rolled UTF-8 encoder (standalone Hermes has no TextEncoder).
var __gpxBuf = new Uint8Array(4096);
var __gpxView = new DataView(__gpxBuf.buffer);
var __gpxPos = 0;

function __gpxEnsure(extra) {
  var needed = __gpxPos + extra;
  if (needed <= __gpxBuf.length) return;
  var cap = __gpxBuf.length;
  while (cap < needed) cap *= 2;
  var next = new Uint8Array(cap);
  next.set(__gpxBuf.subarray(0, __gpxPos));
  __gpxBuf = next;
  __gpxView = new DataView(next.buffer);
}

function __gpxWriteU8(v) {
  __gpxEnsure(1);
  __gpxBuf[__gpxPos++] = v & 0xff;
}

function __gpxWriteU16(v) {
  __gpxEnsure(2);
  __gpxView.setUint16(__gpxPos, v >>> 0, true);
  __gpxPos += 2;
}

function __gpxWriteU32(v) {
  __gpxEnsure(4);
  __gpxView.setUint32(__gpxPos, v >>> 0, true);
  __gpxPos += 4;
}

function __gpxWriteU64(v) {
  __gpxEnsure(8);
  var lo = v >>> 0;
  var hi = Math.floor(v / 0x100000000) >>> 0;
  __gpxView.setUint32(__gpxPos, lo, true);
  __gpxView.setUint32(__gpxPos + 4, hi, true);
  __gpxPos += 8;
}

function __gpxWriteStrWithLen(str, isU16) {
  var lenFieldBytes = isU16 ? 2 : 4;
  __gpxEnsure(lenFieldBytes + str.length * 3);
  var lenPos = __gpxPos;
  __gpxPos += lenFieldBytes;
  var start = __gpxPos;
  var buf = __gpxBuf;
  for (var i = 0; i < str.length; i++) {
    var c = str.charCodeAt(i);
    if (c < 0x80) {
      buf[__gpxPos++] = c;
    } else if (c < 0x800) {
      buf[__gpxPos++] = 0xc0 | (c >> 6);
      buf[__gpxPos++] = 0x80 | (c & 0x3f);
    } else if (c >= 0xd800 && c <= 0xdbff && i + 1 < str.length) {
      var c2 = str.charCodeAt(i + 1);
      if (c2 >= 0xdc00 && c2 <= 0xdfff) {
        var cp = 0x10000 + ((c - 0xd800) << 10) + (c2 - 0xdc00);
        buf[__gpxPos++] = 0xf0 | (cp >> 18);
        buf[__gpxPos++] = 0x80 | ((cp >> 12) & 0x3f);
        buf[__gpxPos++] = 0x80 | ((cp >> 6) & 0x3f);
        buf[__gpxPos++] = 0x80 | (cp & 0x3f);
        i++;
        continue;
      }
      buf[__gpxPos++] = 0xef; buf[__gpxPos++] = 0xbf; buf[__gpxPos++] = 0xbd;
    } else if (c >= 0xd800 && c <= 0xdfff) {
      buf[__gpxPos++] = 0xef; buf[__gpxPos++] = 0xbf; buf[__gpxPos++] = 0xbd;
    } else {
      buf[__gpxPos++] = 0xe0 | (c >> 12);
      buf[__gpxPos++] = 0x80 | ((c >> 6) & 0x3f);
      buf[__gpxPos++] = 0x80 | (c & 0x3f);
    }
  }
  var byteLen = __gpxPos - start;
  if (isU16) {
    __gpxView.setUint16(lenPos, byteLen, true);
  } else {
    __gpxView.setUint32(lenPos, byteLen, true);
  }
}

function __gpxCreateStyleCache() {
  return { nextId: 1, obj: new WeakMap(), json: new Map() };
}

function __gpxEncodeBatch(queue, styleCache) {
  __gpxPos = 0;
  __gpxEnsure(8);
  __gpxBuf[0] = 0x47; // 'G'
  __gpxBuf[1] = 0x50; // 'P'
  __gpxBuf[2] = 0x58; // 'X'
  __gpxBuf[3] = 0x31; // '1'
  __gpxPos = 8;
  var emitted = 0;
  for (var i = 0; i < queue.length; i++) {
    var op = queue[i];
    var name = op[0];
    if (name === "setStyle") {
      var elemId = op[1];
      var styleObj = op[2];
      var sid = styleObj && typeof styleObj === "object" ? styleCache.obj.get(styleObj) : undefined;
      if (sid === undefined) {
        var rawJson = JSON.stringify(styleObj ?? {});
        sid = styleCache.json.get(rawJson);
        if (sid === undefined) {
          sid = styleCache.nextId++;
          if (styleCache.nextId >= 0x7fffffff) styleCache.nextId = 1;
          if (styleCache.json.size >= 2048) {
            var oldestKey = styleCache.json.keys().next().value;
            if (oldestKey !== undefined) styleCache.json.delete(oldestKey);
          }
          styleCache.json.set(rawJson, sid);
          __gpxWriteU8(0x06);
          __gpxWriteU32(sid);
          __gpxWriteStrWithLen(rawJson, false);
          emitted++;
        }
        if (styleObj && typeof styleObj === "object") {
          styleCache.obj.set(styleObj, sid);
        }
      }
      __gpxWriteU8(0x07);
      __gpxWriteU64(elemId);
      __gpxWriteU32(sid);
      emitted++;
    } else if (name === "createElement") {
      __gpxWriteU8(0x01);
      __gpxWriteU64(op[1]);
      __gpxWriteStrWithLen(String(op[2]), true);
      emitted++;
    } else if (name === "destroyElement") {
      __gpxWriteU8(0x02);
      __gpxWriteU64(op[1]);
      emitted++;
    } else if (name === "appendChild") {
      __gpxWriteU8(0x03);
      __gpxWriteU64(op[1]);
      __gpxWriteU64(op[2]);
      emitted++;
    } else if (name === "insertBefore") {
      __gpxWriteU8(0x04);
      __gpxWriteU64(op[1]);
      __gpxWriteU64(op[2]);
      __gpxWriteU64(op[3]);
      emitted++;
    } else if (name === "setText") {
      __gpxWriteU8(0x08);
      __gpxWriteU64(op[1]);
      __gpxWriteStrWithLen(String(op[2]), false);
      emitted++;
    } else if (name === "setEventListener") {
      __gpxWriteU8(0x09);
      __gpxWriteU64(op[1]);
      __gpxWriteStrWithLen(String(op[2]), true);
      __gpxWriteU8(op[3] ? 1 : 0);
      emitted++;
    } else if (name === "setRoot") {
      __gpxWriteU8(0x0a);
      __gpxWriteU64(op[1]);
      emitted++;
    } else if (name === "setKeyboardFocusDim") {
      __gpxWriteU8(0x0b);
      __gpxWriteU8(op[1] ? 1 : 0);
      emitted++;
    } else if (name === "setCustomProp") {
      __gpxWriteU8(0x0c);
      __gpxWriteU64(op[1]);
      __gpxWriteStrWithLen(String(op[2]), true);
      var propJson = JSON.stringify(op[3]);
      __gpxWriteStrWithLen(propJson === undefined ? "null" : propJson, false);
      emitted++;
    } else {
      return null;
    }
  }
  __gpxView.setUint32(4, emitted, true);
  return __gpxBuf.slice(0, __gpxPos);
}

var NativeGpuixRenderer = globalThis.__gpuixNative.GpuixRenderer;
export function GpuixRenderer(callback) {
  var wrappedCallback = typeof callback === "function"
    ? function(error, event) {
        if (!error && event && event.elementId === 0) {
          if (event.eventType === "windowResize" && typeof event.width === "number" && typeof event.height === "number") {
            __gpxViewport.__emitSize({ width: event.width, height: event.height });
            return;
          }
          if (event.eventType === "windowInsets" && typeof event.value === "string") {
            try { __gpxViewport.__emitInsets(JSON.parse(event.value)); } catch (_) {}
            return;
          }
          if (event.eventType === "nativeBridgeResult" && typeof event.value === "string") {
            try {
              var br = JSON.parse(event.value);
              var entry = __gpxPendingBridge.get(br.requestId);
              if (entry) {
                __gpxPendingBridge.delete(br.requestId);
                clearTimeout(entry.timer);
                var payload = br.payloadJson;
                try { payload = JSON.parse(br.payloadJson); } catch (_) {}
                if (br.ok) {
                  entry.resolve(payload);
                } else {
                  var errMsg = payload && payload.error ? String(payload.error) : String(payload || "Native error");
                  entry.reject(new Error(errMsg));
                }
              }
            } catch (_) {}
            return;
          }
          if (event.eventType === "nativeBridgeEvent" && typeof event.value === "string") {
            try {
              var ev = JSON.parse(event.value);
              var evPayload = ev.payloadJson;
              try { evPayload = JSON.parse(ev.payloadJson); } catch (_) {}
              __gpxEmitChannel(String(ev.channel || ""), evPayload);
            } catch (_) {}
            return;
          }
          if (event.eventType === "wsEvent" && typeof event.value === "string") {
            try {
              var wsMsg = JSON.parse(event.value);
              var ws = __gpxWsRegistry.get(wsMsg.socketId);
              if (ws) {
                if (wsMsg.type === "open") {
                  ws.readyState = 1;
                  __gpxEmitWs(ws, "open", { type: "open", target: ws });
                } else if (wsMsg.type === "message") {
                  var msgData = typeof wsMsg.text === "string"
                    ? wsMsg.text
                    : (wsMsg.binaryBase64 ? __gpxBase64ToBytes(wsMsg.binaryBase64).buffer : "");
                  __gpxEmitWs(ws, "message", { type: "message", data: msgData, target: ws });
                } else if (wsMsg.type === "error") {
                  __gpxEmitWs(ws, "error", { type: "error", message: wsMsg.reason || "WebSocket error", target: ws });
                } else if (wsMsg.type === "close") {
                  if (ws._closeTimer) { clearTimeout(ws._closeTimer); ws._closeTimer = null; }
                  if (ws.readyState !== 3) {
                    ws.readyState = 3;
                    __gpxWsRegistry.delete(wsMsg.socketId);
                    var code = typeof wsMsg.code === "number" ? wsMsg.code : 1000;
                    __gpxEmitWs(ws, "close", {
                      type: "close",
                      code: code,
                      reason: wsMsg.reason || "",
                      wasClean: code === 1000,
                      target: ws,
                    });
                  }
                }
              }
            } catch (_) {}
            return;
          }
          if (event.eventType === "backPressed") {
            var handled = false;
            var snapshot = __gpxBackHandlers.slice();
            for (var bi = snapshot.length - 1; bi >= 0; bi--) {
              try {
                if (snapshot[bi]() === true) {
                  handled = true;
                  break;
                }
              } catch (_) {}
            }
            if (!handled && typeof __gpxNative.moveAppToBack === "function") {
              __gpxNative.moveAppToBack();
            }
            return;
          }
          if (event.eventType === "deepLink" && typeof event.value === "string") {
            __gpxLastDeepLink = event.value;
            __gpxDeepLinkListeners.forEach(function(fn) {
              try { fn(event.value); } catch (_) {}
            });
            return;
          }
          if (event.eventType === "a11yAction" && typeof event.value === "string") {
            try { __gpxEmitChannel("a11yAction", JSON.parse(event.value)); } catch (_) {}
            return;
          }
        }
        return callback(error, event);
      }
    : callback;
  var instance = new NativeGpuixRenderer(wrappedCallback);
  globalThis.__gpuixLastRenderer = instance;
  if (typeof instance.applyBinaryBatch === "function") {
    var styleCache = __gpxCreateStyleCache();
    instance.__applyBatchQueue = function(queue) {
      var bin = __gpxEncodeBatch(queue, styleCache);
      if (bin !== null) {
        return instance.applyBinaryBatch(bin);
      }
      return instance.applyBatch(JSON.stringify(queue));
    };
  }
  return instance;
}
export const isTerminal = () => false;
`

export function createAndroidPlugins(): BunPlugin[] {
  return [
    {
      name: 'gpuix-android-native',
      setup(build) {
        build.onResolve({ filter: /^@gpuix\/native$/ }, () => ({ path: 'native', namespace: 'android' }))
        build.onLoad({ filter: /.*/, namespace: 'android' }, () => ({
          contents: NATIVE_SHIM_SOURCE,
          loader: 'js',
        }))
        build.onLoad({ filter: /[\\/]@gpuix[\\/]native[\\/]dist[\\/]mutations\.js$/ }, async (args) => {
          const raw = await Bun.file(args.path).text()
          const patched = raw.replace(
            'renderer.applyBatch(JSON.stringify(queue))',
            '(typeof renderer.__applyBatchQueue === "function" ? renderer.__applyBatchQueue(queue) : renderer.applyBatch(JSON.stringify(queue)))',
          )
          return { contents: patched, loader: 'js' }
        })
      },
    },
  ]
}

export function normalizeAndroidFonts(source: string): string {
  return source
    .replaceAll('"Helvetica"', '".SystemUIFont"')
    .replaceAll('"Menlo"', '"Droid Sans Mono"')
    .replaceAll('"sans-serif"', '".SystemUIFont"')
}

export function wrapDebugBundle(source: string): string {
  return `;(function() {
  if (!globalThis.__gpuixHotCleanups) {
    globalThis.__gpuixHotCleanups = [];
  }
  globalThis.__gpuixRegisterHotCleanup = function(fn) {
    if (typeof fn === 'function') globalThis.__gpuixHotCleanups.push(fn);
  };
  globalThis.__gpuixRunHotCleanup = function() {
    var list = globalThis.__gpuixHotCleanups.splice(0, globalThis.__gpuixHotCleanups.length);
    for (var i = list.length - 1; i >= 0; i--) {
      try { list[i](); } catch (e) { console.error('[gpuix-dev] cleanup error:', e); }
    }
  };
  globalThis.__gpuixShowRedBox = function(title, message) {
    var renderer = globalThis.__gpuixLastRenderer;
    if (!renderer || typeof renderer.applyBatch !== 'function') return;
    try {
      renderer.applyBatch(JSON.stringify([
        ['createElement', 990001, 'div'],
        ['setStyle', 990001, { width: '100%', height: '100%', backgroundColor: '#7f1d1d', padding: 24, flexDirection: 'column', gap: 12 }],
        ['createElement', 990002, 'text'],
        ['setStyle', 990002, { fontSize: 18, fontWeight: 'bold', color: '#ffffff' }],
        ['setText', 990002, String(title || 'Runtime Error')],
        ['createElement', 990003, 'text'],
        ['setStyle', 990003, { fontSize: 12, color: '#fee2e2', fontFamily: 'Droid Sans Mono' }],
        ['setText', 990003, String(message || '').slice(0, 2000)],
        ['appendChild', 990001, 990002],
        ['appendChild', 990001, 990003],
        ['setRoot', 990001]
      ]));
    } catch (_) {}
  };
  globalThis.__gpuixClearRedBox = function() {};
  if (typeof globalThis.__gpuixRunHotCleanup === 'function') {
    globalThis.__gpuixRunHotCleanup();
  }
  try {
    ${source}
  } catch (err) {
    var detail = err && (err.stack || err.message) ? (err.stack || err.message) : String(err);
    console.error('[gpuix-dev] Fatal error:', detail);
    if (typeof globalThis.__gpuixShowRedBox === 'function') {
      globalThis.__gpuixShowRedBox('Fatal Error', detail);
    }
  }
})();`
}

function findHermesc(androidRoot: string): string | null {
  const candidates = [
    path.join(androidRoot, '.build/hermes-host/bin/hermesc'),
    path.join(androidRoot, '.build/hermes-host/bin/hermesc.exe'),
  ]
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate
  }
  return null
}

if (import.meta.main) {
  const androidRoot = path.resolve(import.meta.dir, '..')
  const project = process.env.GPUIX_PROJECT_ROOT
    ? path.resolve(process.env.GPUIX_PROJECT_ROOT)
    : path.dirname(androidRoot)
  const args = new Set(process.argv.slice(2))
  const isRelease = args.has('--release')
  const skipHbc = args.has('--no-hbc')
  const config = await loadGpuixAndroidConfig(project)
  const entrypoint = path.join(project, config.entrypoint)
  const bundlePath = path.join(androidRoot, '.build/assets/gpuix/app.js')
  const hbcPath = path.join(androidRoot, '.build/assets/gpuix/app.hbc')
  const devJsonPath = path.join(androidRoot, '.build/assets/gpuix/dev.json')

  const result = await Bun.build({
    entrypoints: [entrypoint],
    naming: 'app.js',
    target: 'browser', // Standard JavaScript output; execution is in standalone Hermes.
    format: 'iife',
    minify: true,
    define: {
      'process.env.NODE_ENV': isRelease ? '"production"' : '"development"',
      process: 'undefined',
      window: 'undefined',
      Bun: 'undefined',
    },
    plugins: createAndroidPlugins(),
  })
  if (!result.success) throw new AggregateError(result.logs, 'Android JavaScript bundle failed')

  const output = result.outputs[0]
  const rawSource = await output.text()
  const fontNormalized = normalizeAndroidFonts(rawSource)
  const androidSource = isRelease ? fontNormalized : wrapDebugBundle(fontNormalized)

  if (isRelease) {
    await rm(devJsonPath, { force: true })
  } else {
    await writeTextIfChanged(devJsonPath, JSON.stringify({ port: 8081 }))
  }

  let compiledHbc = false
  const hermesc = skipHbc ? null : findHermesc(androidRoot)
  if (hermesc) {
    const hermescStat = await stat(hermesc)
    const hbcInputHash = createHash('sha256')
      .update(androidSource)
      .update(`\0mode=${isRelease ? 'release' : 'debug'}\0`)
      .update(`hermesc=${hermescStat.size}:${Math.trunc(hermescStat.mtimeMs)}\0`)
      .digest('hex')
    const hbcStampPath = path.join(androidRoot, '.build/.hbc-input.sha256')
    const prevStamp = (await Bun.file(hbcStampPath).exists())
      ? (await Bun.file(hbcStampPath).text()).trim()
      : ''

    if (prevStamp === hbcInputHash && existsSync(hbcPath)) {
      compiledHbc = true
      if (isRelease) {
        await rm(bundlePath, { force: true })
      } else {
        await writeTextIfChanged(bundlePath, androidSource)
      }
      console.log(`Android HBC up to date (${hbcInputHash.slice(0, 12)})`)
    } else {
      const hermesInputPath = isRelease
        ? path.join(androidRoot, `.build/.hermes-input.${process.pid}.js`)
        : bundlePath
      if (isRelease) {
        await Bun.write(hermesInputPath, androidSource)
      } else {
        await writeTextIfChanged(bundlePath, androidSource)
      }
      const tmpHbcPath = `${hbcPath}.${process.pid}.${Date.now()}.tmp`
      try {
        const proc = Bun.spawnSync([hermesc, '-emit-binary', '-O', '-out', tmpHbcPath, hermesInputPath], {
          stdout: 'pipe',
          stderr: 'pipe',
        })
        if (proc.exitCode === 0 && existsSync(tmpHbcPath)) {
          const nextBytes = Buffer.from(await Bun.file(tmpHbcPath).arrayBuffer())
          const sameHbc = existsSync(hbcPath) && nextBytes.equals(Buffer.from(await Bun.file(hbcPath).arrayBuffer()))
          if (!sameHbc) {
            await rename(tmpHbcPath, hbcPath)
          } else {
            await rm(tmpHbcPath, { force: true })
          }
          await writeTextIfChanged(hbcStampPath, `${hbcInputHash}\n`)
          compiledHbc = true
          if (isRelease) {
            await rm(bundlePath, { force: true })
          }
        } else {
          await rm(tmpHbcPath, { force: true })
          await writeTextIfChanged(bundlePath, androidSource)
          const errText = new TextDecoder().decode(proc.stderr).trim()
          console.warn(`Warning: hermesc bytecode compilation failed (${errText}); falling back to app.js`)
        }
      } catch (error) {
        await rm(tmpHbcPath, { force: true })
        throw error
      } finally {
        if (isRelease) {
          await rm(hermesInputPath, { force: true })
        }
      }
    }
  } else {
    await writeTextIfChanged(bundlePath, androidSource)
  }

  const gradleProperties = await writeGradleProperties(androidRoot, config)
  if (compiledHbc) {
    const hbcBytes = Bun.file(hbcPath).size
    console.log(`Android HBC: ${hbcPath} (${hbcBytes} bytes, release=${isRelease})`)
  } else {
    console.log(`Android JS: ${bundlePath} (${Buffer.byteLength(androidSource)} bytes)`)
  }
  console.log(`Android config: ${config.entrypoint} → ${config.appId} (${gradleProperties})`)
}
