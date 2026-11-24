package dev.gpui.mobile.bridge;

import android.app.Activity;
import android.content.Context;
import android.content.pm.ApplicationInfo;
import android.os.StatFs;
import android.util.Base64;
import dev.gpui.mobile.GpuiNativeBridge;
import java.io.BufferedInputStream;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.Iterator;
import org.json.JSONArray;
import org.json.JSONObject;

/**
 * Sandboxed file-system operations (`fs`) and streaming file download/multipart upload (`transfer`)
 * requiring zero extra Android manifest permissions.
 */
public final class FileTransferPlugin {

    private static final String FS_DIR_NAME = "gpuix_fs";
    private static final int MAX_MEM_BYTES = 16 * 1024 * 1024;
    private static final long MAX_DOWNLOAD_BYTES = 256L * 1024L * 1024L;

    private FileTransferPlugin() {
    }

    public static void register() {
        GpuiNativeBridge.registerPlugin("fs", FileTransferPlugin::handleFs);
        GpuiNativeBridge.registerPlugin("transfer", FileTransferPlugin::handleTransfer);
    }

    private static File resolveSandboxRoot(Context ctx, String scope) throws Exception {
        File base = "cache".equalsIgnoreCase(scope) ? ctx.getCacheDir() : ctx.getFilesDir();
        File root = new File(base, FS_DIR_NAME);
        if (!root.exists() && !root.mkdirs()) {
            throw new IllegalStateException("Cannot create sandbox fs directory");
        }
        return root.getCanonicalFile();
    }

    public static File resolveSandboxFile(Context ctx, String relPath, String scope, boolean allowRoot) throws Exception {
        File root = resolveSandboxRoot(ctx, scope);
        String clean = relPath != null ? relPath.trim() : "";
        while (clean.startsWith("/")) {
            clean = clean.substring(1);
        }
        if (clean.isEmpty()) {
            if (allowRoot) return root;
            throw new IllegalArgumentException("path must be a non-empty relative path");
        }
        if (clean.contains("\0") || clean.contains("\\")) {
            throw new IllegalArgumentException("Invalid character in path");
        }
        File target = new File(root, clean).getCanonicalFile();
        String rootPath = root.getPath();
        String targetPath = target.getPath();
        if (!targetPath.equals(rootPath) && !targetPath.startsWith(rootPath + File.separator)) {
            throw new SecurityException("Path escapes sandbox directory");
        }
        return target;
    }

    private static long directorySize(File dir) {
        if (dir == null || !dir.exists()) return 0L;
        if (dir.isFile()) return dir.length();
        long total = 0L;
        File[] children = dir.listFiles();
        if (children != null) {
            for (File child : children) {
                total += directorySize(child);
            }
        }
        return total;
    }

    private static void deleteRecursively(File target) {
        if (target == null || !target.exists()) return;
        if (target.isDirectory()) {
            File[] children = target.listFiles();
            if (children != null) {
                for (File child : children) {
                    deleteRecursively(child);
                }
            }
        }
        //noinspection ResultOfMethodCallIgnored
        target.delete();
    }

    public static void handleFs(Activity activity, long reqId, String method, JSONObject args) throws Exception {
        Context ctx = activity.getApplicationContext();
        String scope = args.optString("scope", "files");
        String relPath = args.optString("path", "");

        switch (method) {
            case "readText": {
                File f = resolveSandboxFile(ctx, relPath, scope, false);
                if (!f.isFile()) {
                    BridgeContext.reject(reqId, "File not found: " + relPath);
                    return;
                }
                if (f.length() > MAX_MEM_BYTES) {
                    BridgeContext.reject(reqId, "File exceeds 16 MiB readText limit");
                    return;
                }
                byte[] bytes = readAllBytes(f);
                BridgeContext.resolve(reqId, new JSONObject()
                        .put("content", new String(bytes, StandardCharsets.UTF_8))
                        .put("size", bytes.length));
                break;
            }
            case "writeText": {
                File f = resolveSandboxFile(ctx, relPath, scope, false);
                ensureParent(f);
                boolean append = args.optBoolean("append", false);
                byte[] bytes = args.optString("content", "").getBytes(StandardCharsets.UTF_8);
                try (FileOutputStream fos = new FileOutputStream(f, append)) {
                    fos.write(bytes);
                }
                BridgeContext.resolve(reqId, new JSONObject()
                        .put("written", bytes.length)
                        .put("path", f.getAbsolutePath()));
                break;
            }
            case "readBase64": {
                File f = resolveSandboxFile(ctx, relPath, scope, false);
                if (!f.isFile()) {
                    BridgeContext.reject(reqId, "File not found: " + relPath);
                    return;
                }
                if (f.length() > MAX_MEM_BYTES) {
                    BridgeContext.reject(reqId, "File exceeds 16 MiB readBase64 limit");
                    return;
                }
                byte[] bytes = readAllBytes(f);
                BridgeContext.resolve(reqId, new JSONObject()
                        .put("base64", Base64.encodeToString(bytes, Base64.NO_WRAP))
                        .put("size", bytes.length));
                break;
            }
            case "writeBase64": {
                File f = resolveSandboxFile(ctx, relPath, scope, false);
                ensureParent(f);
                boolean append = args.optBoolean("append", false);
                byte[] bytes = Base64.decode(args.optString("base64", ""), Base64.DEFAULT);
                try (FileOutputStream fos = new FileOutputStream(f, append)) {
                    fos.write(bytes);
                }
                BridgeContext.resolve(reqId, new JSONObject()
                        .put("written", bytes.length)
                        .put("path", f.getAbsolutePath()));
                break;
            }
            case "exists": {
                File f = resolveSandboxFile(ctx, relPath, scope, true);
                BridgeContext.resolve(reqId, new JSONObject()
                        .put("exists", f.exists())
                        .put("isDirectory", f.isDirectory()));
                break;
            }
            case "stat": {
                File f = resolveSandboxFile(ctx, relPath, scope, true);
                JSONObject res = new JSONObject();
                res.put("exists", f.exists());
                res.put("size", f.isFile() ? f.length() : 0L);
                res.put("isDirectory", f.isDirectory());
                res.put("modifiedAt", f.exists() ? f.lastModified() : 0L);
                BridgeContext.resolve(reqId, res);
                break;
            }
            case "list": {
                File dir = resolveSandboxFile(ctx, relPath, scope, true);
                if (!dir.isDirectory()) {
                    BridgeContext.reject(reqId, "Directory not found: " + relPath);
                    return;
                }
                JSONArray entries = new JSONArray();
                File[] children = dir.listFiles();
                if (children != null) {
                    for (File child : children) {
                        entries.put(new JSONObject()
                                .put("name", child.getName())
                                .put("isDirectory", child.isDirectory())
                                .put("size", child.isFile() ? child.length() : 0L)
                                .put("modifiedAt", child.lastModified()));
                    }
                }
                BridgeContext.resolve(reqId, new JSONObject().put("entries", entries));
                break;
            }
            case "mkdir": {
                File dir = resolveSandboxFile(ctx, relPath, scope, false);
                boolean ok = dir.isDirectory() || dir.mkdirs();
                BridgeContext.resolve(reqId, new JSONObject().put("created", ok));
                break;
            }
            case "remove": {
                File f = resolveSandboxFile(ctx, relPath, scope, false);
                if (!f.exists()) {
                    BridgeContext.resolve(reqId, new JSONObject().put("removed", false));
                    return;
                }
                boolean recursive = args.optBoolean("recursive", true);
                if (f.isDirectory() && recursive) {
                    deleteRecursively(f);
                    BridgeContext.resolve(reqId, new JSONObject().put("removed", !f.exists()));
                } else {
                    BridgeContext.resolve(reqId, new JSONObject().put("removed", f.delete()));
                }
                break;
            }
            case "getStorageInfo": {
                File filesRoot = resolveSandboxRoot(ctx, "files");
                File cacheRoot = resolveSandboxRoot(ctx, "cache");
                StatFs filesStat = new StatFs(filesRoot.getAbsolutePath());
                StatFs cacheStat = new StatFs(cacheRoot.getAbsolutePath());
                BridgeContext.resolve(reqId, new JSONObject()
                        .put("filesAvailableBytes", filesStat.getAvailableBytes())
                        .put("filesTotalBytes", filesStat.getTotalBytes())
                        .put("cacheAvailableBytes", cacheStat.getAvailableBytes())
                        .put("fsFilesUsedBytes", directorySize(filesRoot))
                        .put("fsCacheUsedBytes", directorySize(cacheRoot)));
                break;
            }
            default:
                BridgeContext.reject(reqId, "Unsupported fs method: " + method);
        }
    }

    public static void handleTransfer(Activity activity, long reqId, String method, JSONObject args) throws Exception {
        Context ctx = activity.getApplicationContext();
        switch (method) {
            case "downloadFile": {
                String url = args.optString("url", "").trim();
                String relPath = args.optString("path", "").trim();
                String scope = args.optString("scope", "files");
                int timeoutMs = Math.max(3000, Math.min(180000, args.optInt("timeoutMs", 45000)));
                validateHttpUrl(ctx, url);
                File dest = resolveSandboxFile(ctx, relPath, scope, false);
                ensureParent(dest);
                File tmp = new File(dest.getParentFile(), dest.getName() + "." + System.currentTimeMillis() + ".part");
                HttpURLConnection conn = openConnection(url, "GET", args.optJSONObject("headers"), timeoutMs);
                try {
                    int status = conn.getResponseCode();
                    if (status < 200 || status >= 300) {
                        throw new IllegalStateException("HTTP " + status + " downloading file");
                    }
                    long total = conn.getContentLengthLong();
                    MessageDigest md = MessageDigest.getInstance("SHA-256");
                    long written = 0L;
                    long lastEmit = 0L;
                    try (InputStream in = new BufferedInputStream(conn.getInputStream());
                         FileOutputStream fos = new FileOutputStream(tmp)) {
                        byte[] buf = new byte[16384];
                        int n;
                        while ((n = in.read(buf)) >= 0) {
                            if (n == 0) continue;
                            written += n;
                            if (written > MAX_DOWNLOAD_BYTES) {
                                throw new IllegalStateException("Download exceeds 256 MiB limit");
                            }
                            md.update(buf, 0, n);
                            fos.write(buf, 0, n);
                            long now = System.currentTimeMillis();
                            if (now - lastEmit >= 120) {
                                lastEmit = now;
                                emitTransferProgress("download", url, relPath, written, total);
                            }
                        }
                        fos.getFD().sync();
                    }
                    if (!tmp.renameTo(dest)) {
                        copyFile(tmp, dest);
                    }
                    emitTransferProgress("download", url, relPath, written, written);
                    BridgeContext.resolve(reqId, new JSONObject()
                            .put("path", dest.getAbsolutePath())
                            .put("scope", scope)
                            .put("bytes", written)
                            .put("sha256", toHex(md.digest())));
                } finally {
                    conn.disconnect();
                    if (tmp.exists()) {
                        //noinspection ResultOfMethodCallIgnored
                        tmp.delete();
                    }
                }
                break;
            }
            case "uploadFile": {
                String url = args.optString("url", "").trim();
                String relPath = args.optString("path", "").trim();
                String scope = args.optString("scope", "files");
                String fieldName = args.optString("fieldName", "file");
                String mimeType = args.optString("mimeType", "application/octet-stream");
                int timeoutMs = Math.max(3000, Math.min(180000, args.optInt("timeoutMs", 60000)));
                validateHttpUrl(ctx, url);
                File src = resolveUploadFile(ctx, relPath, scope);
                if (!src.isFile()) {
                    BridgeContext.reject(reqId, "Upload file not found: " + relPath);
                    return;
                }
                String fileName = sanitizeHeaderToken(args.optString("fileName", src.getName()));
                String boundary = "----GpuixBoundary" + System.currentTimeMillis();
                HttpURLConnection conn = openConnection(url, "POST", args.optJSONObject("headers"), timeoutMs);
                try {
                    conn.setDoOutput(true);
                    conn.setChunkedStreamingMode(16384);
                    conn.setRequestProperty("Content-Type", "multipart/form-data; boundary=" + boundary);
                    try (OutputStream out = conn.getOutputStream();
                         InputStream in = new BufferedInputStream(new FileInputStream(src))) {
                        JSONObject fields = args.optJSONObject("fields");
                        if (fields != null) {
                            Iterator<String> keys = fields.keys();
                            while (keys.hasNext()) {
                                String k = sanitizeHeaderToken(keys.next());
                                String v = fields.optString(k, "");
                                String partHead = "--" + boundary + "\r\nContent-Disposition: form-data; name=\"" + k + "\"\r\n\r\n" + v + "\r\n";
                                out.write(partHead.getBytes(StandardCharsets.UTF_8));
                            }
                        }
                        String fileHead = "--" + boundary + "\r\nContent-Disposition: form-data; name=\"" + sanitizeHeaderToken(fieldName)
                                + "\"; filename=\"" + fileName + "\"\r\nContent-Type: " + sanitizeHeaderToken(mimeType) + "\r\n\r\n";
                        out.write(fileHead.getBytes(StandardCharsets.UTF_8));
                        long total = src.length();
                        long sent = 0L;
                        long lastEmit = 0L;
                        byte[] buf = new byte[16384];
                        int n;
                        while ((n = in.read(buf)) >= 0) {
                            if (n == 0) continue;
                            out.write(buf, 0, n);
                            sent += n;
                            long now = System.currentTimeMillis();
                            if (now - lastEmit >= 120) {
                                lastEmit = now;
                                emitTransferProgress("upload", url, relPath, sent, total);
                            }
                        }
                        out.write(("\r\n--" + boundary + "--\r\n").getBytes(StandardCharsets.UTF_8));
                        out.flush();
                        emitTransferProgress("upload", url, relPath, sent, total);
                    }
                    int status = conn.getResponseCode();
                    InputStream respStream = status >= 400 ? conn.getErrorStream() : conn.getInputStream();
                    String respBody = respStream != null ? readLimitedUtf8(respStream, 1024 * 1024) : "";
                    BridgeContext.resolve(reqId, new JSONObject()
                            .put("status", status)
                            .put("ok", status >= 200 && status < 300)
                            .put("body", respBody));
                } finally {
                    conn.disconnect();
                }
                break;
            }
            default:
                BridgeContext.reject(reqId, "Unsupported transfer method: " + method);
        }
    }

    private static File resolveUploadFile(Context ctx, String pathInput, String scope) throws Exception {
        if (pathInput.startsWith("/")) {
            File target = new File(pathInput).getCanonicalFile();
            String filesRoot = ctx.getFilesDir().getCanonicalPath();
            String cacheRoot = ctx.getCacheDir().getCanonicalPath();
            String targetPath = target.getPath();
            if (targetPath.startsWith(filesRoot + File.separator) || targetPath.startsWith(cacheRoot + File.separator)) {
                return target;
            }
            throw new SecurityException("Absolute upload path must stay inside app sandbox");
        }
        return resolveSandboxFile(ctx, pathInput, scope, false);
    }

    private static void validateHttpUrl(Context ctx, String urlStr) throws Exception {
        URL parsed = new URL(urlStr);
        String scheme = parsed.getProtocol() != null ? parsed.getProtocol().toLowerCase() : "";
        boolean debuggable = (ctx.getApplicationInfo().flags & ApplicationInfo.FLAG_DEBUGGABLE) != 0;
        if ("https".equals(scheme) || ("http".equals(scheme) && debuggable)) {
            return;
        }
        throw new SecurityException("Transfer URL must use https:// in release builds");
    }

    private static HttpURLConnection openConnection(String urlStr, String method, JSONObject headers, int timeoutMs) throws Exception {
        HttpURLConnection conn = (HttpURLConnection) new URL(urlStr).openConnection();
        conn.setRequestMethod(method);
        conn.setConnectTimeout(timeoutMs);
        conn.setReadTimeout(timeoutMs);
        conn.setInstanceFollowRedirects(true);
        conn.setUseCaches(false);
        if (headers != null) {
            Iterator<String> keys = headers.keys();
            while (keys.hasNext()) {
                String k = keys.next();
                String v = headers.optString(k, "");
                if (!k.isEmpty() && !v.isEmpty()) {
                    conn.setRequestProperty(k, v);
                }
            }
        }
        return conn;
    }

    private static void emitTransferProgress(String direction, String url, String path, long transferred, long total) {
        try {
            JSONObject ev = new JSONObject();
            ev.put("direction", direction);
            ev.put("url", url);
            ev.put("path", path);
            ev.put("bytesTransferred", transferred);
            ev.put("totalBytes", total);
            ev.put("progress", total > 0 ? Math.min(1.0, (double) transferred / (double) total) : -1);
            BridgeContext.emitEvent("transferProgress", ev);
        } catch (Throwable ignored) {
        }
    }

    private static void ensureParent(File f) throws Exception {
        File parent = f.getParentFile();
        if (parent != null && !parent.exists() && !parent.mkdirs()) {
            throw new IllegalStateException("Cannot create parent directory");
        }
    }

    private static byte[] readAllBytes(File file) throws Exception {
        try (InputStream in = new BufferedInputStream(new FileInputStream(file));
             ByteArrayOutputStream out = new ByteArrayOutputStream()) {
            byte[] buf = new byte[8192];
            int n;
            while ((n = in.read(buf)) >= 0) {
                if (n > 0) out.write(buf, 0, n);
            }
            return out.toByteArray();
        }
    }

    private static String readLimitedUtf8(InputStream in, int maxBytes) throws Exception {
        try (InputStream bis = new BufferedInputStream(in);
             ByteArrayOutputStream out = new ByteArrayOutputStream()) {
            byte[] buf = new byte[8192];
            int n;
            while ((n = bis.read(buf)) >= 0) {
                if (out.size() + n > maxBytes) break;
                out.write(buf, 0, n);
            }
            return new String(out.toByteArray(), StandardCharsets.UTF_8);
        }
    }

    private static void copyFile(File src, File dst) throws Exception {
        try (InputStream in = new FileInputStream(src);
             FileOutputStream out = new FileOutputStream(dst)) {
            byte[] buf = new byte[16384];
            int n;
            while ((n = in.read(buf)) >= 0) {
                out.write(buf, 0, n);
            }
            out.getFD().sync();
        }
    }

    private static String sanitizeHeaderToken(String raw) {
        return raw != null ? raw.replace('\r', '_').replace('\n', '_').replace('"', '_') : "";
    }

    private static String toHex(byte[] bytes) {
        char[] hex = new char[bytes.length * 2];
        char[] digits = "0123456789abcdef".toCharArray();
        for (int i = 0; i < bytes.length; i++) {
            int v = bytes[i] & 0xFF;
            hex[i * 2] = digits[v >>> 4];
            hex[i * 2 + 1] = digits[v & 0x0F];
        }
        return new String(hex);
    }
}
