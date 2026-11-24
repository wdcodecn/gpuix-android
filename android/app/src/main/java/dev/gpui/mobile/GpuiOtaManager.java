package dev.gpui.mobile;

import android.app.Activity;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ApplicationInfo;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.util.Base64;
import android.util.Log;
import java.io.BufferedInputStream;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URI;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.security.KeyFactory;
import java.security.MessageDigest;
import java.security.PublicKey;
import java.security.Signature;
import java.security.spec.X509EncodedKeySpec;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;
import java.util.regex.Pattern;
import org.json.JSONArray;
import org.json.JSONObject;

/**
 * Production Over-The-Air (OTA) JS/HBC update manager for GPUIX Android.
 *
 * Shares an atomic key-value state file (`filesDir/gpuix_ota/state.kv`) with
 * the Rust cold-boot loader in `android/rust/src/ota.rs` so failed or
 * unconfirmed releases automatically roll back to the previous healthy slot or
 * the APK-embedded bundle.
 */
public final class GpuiOtaManager {

    private static final String TAG = "GpuiOtaManager";
    private static final String META_ASSET_PATH = "gpuix/ota-meta.kv";
    private static final String OTA_DIR_NAME = "gpuix_ota";
    private static final String STATE_FILE_NAME = "state.kv";
    private static final int MAX_BUNDLE_BYTES = 32 * 1024 * 1024;
    private static final int MAX_MANIFEST_BYTES = 1024 * 1024;
    private static final int MAX_FAILED_IDS = 32;
    private static final byte[] HERMES_MAGIC = new byte[] {
        (byte) 0xC6, (byte) 0x1F, (byte) 0xBC, (byte) 0x03,
        (byte) 0xC1, (byte) 0x03, (byte) 0x19, (byte) 0x1F
    };
    private static final Pattern RELEASE_ID_PATTERN = Pattern.compile("^[A-Za-z0-9._-]{1,128}$");
    private static final Pattern SHA256_PATTERN = Pattern.compile("^[0-9a-fA-F]{64}$");

    private static final Object STATE_LOCK = new Object();
    private static final Handler MAIN_HANDLER = new Handler(Looper.getMainLooper());
    private static final ScheduledExecutorService SCHEDULER = Executors.newSingleThreadScheduledExecutor();

    private GpuiOtaManager() {
    }

    private static final class EmbeddedMeta {
        String appId = "";
        String versionName = "";
        long versionCode = 0;
        String runtimeVersion = "";
        String channel = "production";
        String manifestUrl = "";
        String publicKey = "";
        String checkOnLaunch = "manual";
        String embeddedFormat = "hbc";
        String embeddedBuildId = "";
    }

    private static final class BundleSlot {
        String id = "";
        String sha256 = "";
        String format = "hbc";
        String bundleRel = "";
        boolean confirmed = false;
        int attempts = 0;

        BundleSlot copy() {
            BundleSlot s = new BundleSlot();
            s.id = id;
            s.sha256 = sha256;
            s.format = format;
            s.bundleRel = bundleRel;
            s.confirmed = confirmed;
            s.attempts = attempts;
            return s;
        }
    }

    private static final class OtaState {
        long baseVersionCode = 0;
        String runtimeVersion = "";
        String embeddedBuildId = "";
        BundleSlot active = null;
        BundleSlot prev = null;
        BundleSlot staged = null;
        final List<String> failedIds = new ArrayList<>();
        String lastRollbackReason = "";
        long lastCheckedAt = 0;
    }

    public static void handle(Activity activity, long reqId, String method, JSONObject args) throws Exception {
        if (method == null) {
            GpuiNativeBridge.reject(reqId, "OTA method is required");
            return;
        }
        switch (method) {
            case "getState":
                handleGetState(activity, reqId);
                break;
            case "check":
                handleCheck(activity, reqId, args);
                break;
            case "download":
                handleDownload(activity, reqId, args);
                break;
            case "apply":
                handleApply(activity, reqId, args);
                break;
            case "confirm":
                handleConfirm(activity, reqId);
                break;
            case "rollback":
                handleRollback(activity, reqId, args);
                break;
            case "reset":
                handleReset(activity, reqId, args);
                break;
            default:
                GpuiNativeBridge.reject(reqId, "Unsupported ota method: " + method);
                break;
        }
    }

    // ── Bridge handlers ──────────────────────────────────────────────────────

    private static void handleGetState(Activity activity, long reqId) throws Exception {
        Context ctx = activity.getApplicationContext();
        EmbeddedMeta meta = loadEmbeddedMeta(ctx);
        OtaState state;
        synchronized (STATE_LOCK) {
            state = loadOrSyncStateLocked(ctx, meta);
        }
        GpuiNativeBridge.resolve(reqId, buildStateJson(meta, state));
    }

    private static void handleCheck(Activity activity, long reqId, JSONObject args) throws Exception {
        Context ctx = activity.getApplicationContext();
        EmbeddedMeta meta = loadEmbeddedMeta(ctx);
        String manifestUrl = args.optString("manifestUrl", "").trim();
        if (manifestUrl.isEmpty()) {
            manifestUrl = meta.manifestUrl;
        }
        if (manifestUrl.isEmpty()) {
            GpuiNativeBridge.reject(reqId, "OTA manifestUrl is not configured");
            return;
        }
        String targetChannel = args.optString("channel", "").trim();
        if (targetChannel.isEmpty()) {
            targetChannel = meta.channel;
        }
        validateHttpUrl(ctx, manifestUrl, "manifestUrl");

        int timeoutMs = Math.max(2000, Math.min(60000, args.optInt("timeoutMs", 15000)));
        JSONObject headers = args.optJSONObject("headers");
        String body = fetchText(manifestUrl, headers, timeoutMs);
        JSONObject rawManifest = new JSONObject(body);
        JSONObject resolved = normalizeAndValidateManifest(ctx, manifestUrl, rawManifest);

        long now = System.currentTimeMillis();
        OtaState state;
        synchronized (STATE_LOCK) {
            state = loadOrSyncStateLocked(ctx, meta);
            state.lastCheckedAt = now;
            saveStateLocked(ctx, state);
        }

        String releaseId = resolved.getString("releaseId");
        String manifestAppId = resolved.getString("appId");
        String manifestRuntime = resolved.getString("runtimeVersion");
        String manifestChannel = resolved.optString("channel", "");
        long minVersionCode = resolved.optLong("minVersionCode", 1);
        JSONObject bundleObj = resolved.getJSONObject("bundle");
        String bundleSha = bundleObj.getString("sha256").toLowerCase(Locale.US);

        String reason = null;
        boolean available = true;
        if (!meta.appId.isEmpty() && !meta.appId.equals(manifestAppId)) {
            available = false;
            reason = "app_id_mismatch";
        } else if (!manifestChannel.isEmpty() && !targetChannel.isEmpty() && !targetChannel.equals(manifestChannel)) {
            available = false;
            reason = "channel_mismatch";
        } else if (!meta.runtimeVersion.isEmpty() && !meta.runtimeVersion.equals(manifestRuntime)) {
            available = false;
            reason = "runtime_mismatch";
        } else if (meta.versionCode > 0 && meta.versionCode < minVersionCode) {
            available = false;
            reason = "min_version_not_met";
        } else if (state.failedIds.contains(releaseId)) {
            available = false;
            reason = "blocklisted";
        } else if (state.active != null && (releaseId.equals(state.active.id) || bundleSha.equalsIgnoreCase(state.active.sha256))) {
            available = false;
            reason = "up_to_date";
        } else if (state.active == null && !meta.embeddedBuildId.isEmpty() && bundleSha.equalsIgnoreCase(meta.embeddedBuildId)) {
            available = false;
            reason = "up_to_date";
        } else if (state.staged != null && releaseId.equals(state.staged.id) && verifySlotFile(ctx, state.staged)) {
            available = false;
            reason = "already_staged";
        }

        JSONObject res = new JSONObject();
        res.put("available", available);
        res.put("reason", reason != null ? reason : JSONObject.NULL);
        res.put("currentReleaseId", state.active != null ? state.active.id : JSONObject.NULL);
        res.put("stagedReleaseId", state.staged != null ? state.staged.id : JSONObject.NULL);
        res.put("embeddedBuildId", meta.embeddedBuildId);
        res.put("manifest", resolved);
        GpuiNativeBridge.resolve(reqId, res);
    }

    private static void handleDownload(Activity activity, long reqId, JSONObject args) throws Exception {
        Context ctx = activity.getApplicationContext();
        EmbeddedMeta meta = loadEmbeddedMeta(ctx);

        JSONObject manifestInput = args.optJSONObject("manifest");
        String manifestUrl = args.optString("manifestUrl", "").trim();
        if (manifestUrl.isEmpty()) {
            manifestUrl = meta.manifestUrl;
        }
        if (manifestInput == null) {
            if (manifestUrl.isEmpty()) {
                GpuiNativeBridge.reject(reqId, "download requires manifest or manifestUrl");
                return;
            }
            validateHttpUrl(ctx, manifestUrl, "manifestUrl");
            int timeoutMs = Math.max(2000, Math.min(60000, args.optInt("timeoutMs", 15000)));
            manifestInput = new JSONObject(fetchText(manifestUrl, args.optJSONObject("headers"), timeoutMs));
        }

        JSONObject manifest = normalizeAndValidateManifest(ctx, manifestUrl.isEmpty() ? null : manifestUrl, manifestInput);
        String releaseId = manifest.getString("releaseId");
        String manifestAppId = manifest.getString("appId");
        String manifestRuntime = manifest.getString("runtimeVersion");
        long minVersionCode = manifest.optLong("minVersionCode", 1);

        if (!meta.appId.isEmpty() && !meta.appId.equals(manifestAppId)) {
            GpuiNativeBridge.reject(reqId, "OTA manifest appId mismatch: " + manifestAppId);
            return;
        }
        if (!meta.runtimeVersion.isEmpty() && !meta.runtimeVersion.equals(manifestRuntime)) {
            GpuiNativeBridge.reject(reqId, "OTA runtimeVersion mismatch: " + manifestRuntime + " != " + meta.runtimeVersion);
            return;
        }
        if (meta.versionCode > 0 && meta.versionCode < minVersionCode) {
            GpuiNativeBridge.reject(reqId, "APK versionCode " + meta.versionCode + " < minVersionCode " + minVersionCode);
            return;
        }

        JSONObject bundleObj = manifest.getJSONObject("bundle");
        String format = bundleObj.getString("format");
        String bundleUrl = bundleObj.getString("url");
        String expectedSha = bundleObj.getString("sha256").toLowerCase(Locale.US);
        long expectedSize = bundleObj.optLong("size", -1);
        String signatureB64 = bundleObj.optString("signature", "").trim();

        validateHttpUrl(ctx, bundleUrl, "bundle.url");
        if (!meta.publicKey.isEmpty() && signatureB64.isEmpty()) {
            GpuiNativeBridge.reject(reqId, "OTA publicKey is configured, but bundle.signature is missing");
            return;
        }

        synchronized (STATE_LOCK) {
            OtaState current = loadOrSyncStateLocked(ctx, meta);
            if (current.failedIds.contains(releaseId)) {
                GpuiNativeBridge.reject(reqId, "Release " + releaseId + " is blocklisted after prior failure");
                return;
            }
            if (current.staged != null && releaseId.equals(current.staged.id)
                    && expectedSha.equalsIgnoreCase(current.staged.sha256)
                    && verifySlotFile(ctx, current.staged)) {
                emitProgress(releaseId, expectedSize > 0 ? expectedSize : 0, expectedSize, "ready");
                JSONObject res = buildStateJson(meta, current);
                res.put("downloaded", false);
                res.put("reused", true);
                res.put("releaseId", releaseId);
                GpuiNativeBridge.resolve(reqId, res);
                return;
            }
        }

        File otaDir = getOtaDir(ctx);
        File tmpDir = new File(otaDir, "tmp");
        if (!tmpDir.exists() && !tmpDir.mkdirs()) {
            throw new IllegalStateException("Cannot create OTA tmp directory");
        }
        File tmpFile = new File(tmpDir, releaseId + "." + System.currentTimeMillis() + ".part");
        int timeoutMs = Math.max(5000, Math.min(120000, args.optInt("timeoutMs", 45000)));

        try {
            DownloadDigest digest = downloadToTempFile(
                    bundleUrl,
                    args.optJSONObject("headers"),
                    timeoutMs,
                    tmpFile,
                    releaseId,
                    expectedSize);

            emitProgress(releaseId, digest.bytesWritten, expectedSize > 0 ? expectedSize : digest.bytesWritten, "verifying");

            if (expectedSize > 0 && digest.bytesWritten != expectedSize) {
                throw new IllegalStateException("Downloaded size mismatch: expected " + expectedSize + ", got " + digest.bytesWritten);
            }
            if (!digest.sha256Hex.equalsIgnoreCase(expectedSha)) {
                throw new IllegalStateException("SHA-256 mismatch: expected " + expectedSha + ", got " + digest.sha256Hex);
            }
            if ("hbc".equals(format) && !hasValidHermesMagic(tmpFile)) {
                throw new IllegalStateException("Invalid Hermes bytecode magic header");
            }
            if (!meta.publicKey.isEmpty()) {
                verifyEcdsaSignature(tmpFile, meta.publicKey, signatureB64);
            }

            String relPath = "releases/" + releaseId + "/bundle." + format;
            File destFile = new File(otaDir, relPath);
            File destParent = destFile.getParentFile();
            if (destParent != null && !destParent.exists() && !destParent.mkdirs()) {
                throw new IllegalStateException("Cannot create release directory");
            }
            if (destFile.exists() && !destFile.delete()) {
                throw new IllegalStateException("Cannot overwrite staged bundle file");
            }
            if (!tmpFile.renameTo(destFile)) {
                copyFileAtomic(tmpFile, destFile);
            }

            BundleSlot staged = new BundleSlot();
            staged.id = releaseId;
            staged.sha256 = digest.sha256Hex.toLowerCase(Locale.US);
            staged.format = format;
            staged.bundleRel = relPath;
            staged.confirmed = false;
            staged.attempts = 0;

            OtaState updated;
            synchronized (STATE_LOCK) {
                updated = loadOrSyncStateLocked(ctx, meta);
                updated.staged = staged;
                saveStateLocked(ctx, updated);
                gcUnusedReleasesLocked(otaDir, updated);
            }

            emitProgress(releaseId, digest.bytesWritten, digest.bytesWritten, "ready");
            JSONObject res = buildStateJson(meta, updated);
            res.put("downloaded", true);
            res.put("reused", false);
            res.put("releaseId", releaseId);
            res.put("bytes", digest.bytesWritten);
            GpuiNativeBridge.resolve(reqId, res);
        } finally {
            if (tmpFile.exists()) {
                //noinspection ResultOfMethodCallIgnored
                tmpFile.delete();
            }
        }
    }

    private static void handleApply(Activity activity, long reqId, JSONObject args) throws Exception {
        Context ctx = activity.getApplicationContext();
        EmbeddedMeta meta = loadEmbeddedMeta(ctx);
        String mode = args.optString("mode", "hot").trim().toLowerCase(Locale.US);
        if (!"hot".equals(mode) && !"next_launch".equals(mode) && !"restart".equals(mode)) {
            GpuiNativeBridge.reject(reqId, "Unsupported apply mode: " + mode);
            return;
        }

        OtaState updated;
        String appliedId;
        synchronized (STATE_LOCK) {
            updated = loadOrSyncStateLocked(ctx, meta);
            if (updated.staged == null) {
                GpuiNativeBridge.reject(reqId, "No staged OTA bundle is ready to apply");
                return;
            }
            if (!verifySlotFile(ctx, updated.staged)) {
                updated.staged = null;
                saveStateLocked(ctx, updated);
                GpuiNativeBridge.reject(reqId, "Staged OTA bundle failed integrity verification");
                return;
            }
            if (updated.active != null && updated.active.confirmed
                    && !updated.active.id.equals(updated.staged.id)
                    && !updated.failedIds.contains(updated.active.id)
                    && verifySlotFile(ctx, updated.active)) {
                BundleSlot prev = updated.active.copy();
                prev.confirmed = true;
                prev.attempts = 0;
                updated.prev = prev;
            }
            BundleSlot nextActive = updated.staged.copy();
            nextActive.confirmed = false;
            nextActive.attempts = 0;
            appliedId = nextActive.id;
            updated.active = nextActive;
            updated.staged = null;
            updated.lastRollbackReason = "";
            saveStateLocked(ctx, updated);
            gcUnusedReleasesLocked(getOtaDir(ctx), updated);
        }

        JSONObject res = buildStateJson(meta, updated);
        res.put("applied", true);
        res.put("mode", mode);
        res.put("releaseId", appliedId);
        GpuiNativeBridge.resolve(reqId, res);

        if ("hot".equals(mode)) {
            SCHEDULER.schedule(() -> {
                try {
                    boolean queued = nativeTriggerHotApply();
                    Log.i(TAG, "nativeTriggerHotApply(" + appliedId + ") -> " + queued);
                } catch (Throwable t) {
                    Log.e(TAG, "nativeTriggerHotApply failed", t);
                }
            }, 40, TimeUnit.MILLISECONDS);
        } else if ("restart".equals(mode)) {
            scheduleProcessRestart(ctx);
        }
    }

    private static void handleConfirm(Activity activity, long reqId) throws Exception {
        Context ctx = activity.getApplicationContext();
        EmbeddedMeta meta = loadEmbeddedMeta(ctx);
        OtaState state;
        boolean confirmedNow = false;
        synchronized (STATE_LOCK) {
            state = loadOrSyncStateLocked(ctx, meta);
            if (state.active != null) {
                state.active.confirmed = true;
                state.active.attempts = 0;
                state.lastRollbackReason = "";
                saveStateLocked(ctx, state);
                confirmedNow = true;
            }
        }
        JSONObject res = buildStateJson(meta, state);
        res.put("confirmedNow", confirmedNow);
        GpuiNativeBridge.resolve(reqId, res);
    }

    private static void handleRollback(Activity activity, long reqId, JSONObject args) throws Exception {
        Context ctx = activity.getApplicationContext();
        EmbeddedMeta meta = loadEmbeddedMeta(ctx);
        boolean applyNow = args.optBoolean("applyNow", true);
        String mode = args.optString("mode", "hot").trim().toLowerCase(Locale.US);
        String reason = args.optString("reason", "manual rollback").trim();
        if (reason.isEmpty()) reason = "manual rollback";

        OtaState state;
        String rolledBackFrom = null;
        synchronized (STATE_LOCK) {
            state = loadOrSyncStateLocked(ctx, meta);
            if (state.active != null) {
                rolledBackFrom = state.active.id;
                addFailedId(state.failedIds, rolledBackFrom);
                state.active = null;
            }
            if (state.prev != null && !state.failedIds.contains(state.prev.id) && verifySlotFile(ctx, state.prev)) {
                BundleSlot restored = state.prev.copy();
                restored.confirmed = true;
                restored.attempts = 0;
                state.active = restored;
                state.prev = null;
            } else {
                state.prev = null;
            }
            state.lastRollbackReason = sanitizeSingleLine(reason);
            saveStateLocked(ctx, state);
            gcUnusedReleasesLocked(getOtaDir(ctx), state);
        }

        JSONObject res = buildStateJson(meta, state);
        res.put("rolledBackFrom", rolledBackFrom != null ? rolledBackFrom : JSONObject.NULL);
        GpuiNativeBridge.resolve(reqId, res);

        if (applyNow) {
            if ("restart".equals(mode)) {
                scheduleProcessRestart(ctx);
            } else {
                SCHEDULER.schedule(() -> {
                    try {
                        nativeTriggerHotRollback();
                    } catch (Throwable t) {
                        Log.e(TAG, "nativeTriggerHotRollback failed", t);
                    }
                }, 40, TimeUnit.MILLISECONDS);
            }
        }
    }

    private static void handleReset(Activity activity, long reqId, JSONObject args) throws Exception {
        Context ctx = activity.getApplicationContext();
        EmbeddedMeta meta = loadEmbeddedMeta(ctx);
        boolean applyNow = args.optBoolean("applyNow", true);
        OtaState fresh;
        synchronized (STATE_LOCK) {
            File otaDir = getOtaDir(ctx);
            deleteRecursively(new File(otaDir, "releases"));
            deleteRecursively(new File(otaDir, "tmp"));
            fresh = resetStateForMeta(meta);
            saveStateLocked(ctx, fresh);
        }
        JSONObject res = buildStateJson(meta, fresh);
        res.put("reset", true);
        GpuiNativeBridge.resolve(reqId, res);

        if (applyNow) {
            SCHEDULER.schedule(() -> {
                try {
                    nativeTriggerHotRollback();
                } catch (Throwable t) {
                    Log.e(TAG, "nativeTriggerHotRollback after reset failed", t);
                }
            }, 40, TimeUnit.MILLISECONDS);
        }
    }

    // ── Manifest & HTTP helpers ──────────────────────────────────────────────

    private static JSONObject normalizeAndValidateManifest(Context ctx, String baseUrl, JSONObject raw) throws Exception {
        int schemaVersion = raw.optInt("schemaVersion", -1);
        if (schemaVersion != 1) {
            throw new IllegalArgumentException("Unsupported OTA manifest schemaVersion: " + schemaVersion);
        }
        String appId = raw.optString("appId", "").trim();
        String runtimeVersion = raw.optString("runtimeVersion", "").trim();
        String releaseId = raw.optString("releaseId", "").trim();
        if (appId.isEmpty() || runtimeVersion.isEmpty() || !isValidReleaseId(releaseId)) {
            throw new IllegalArgumentException("Invalid manifest appId, runtimeVersion, or releaseId");
        }
        JSONObject bundle = raw.optJSONObject("bundle");
        if (bundle == null) {
            throw new IllegalArgumentException("Manifest missing bundle object");
        }
        String format = bundle.optString("format", "").trim().toLowerCase(Locale.US);
        if (!"hbc".equals(format) && !"js".equals(format)) {
            throw new IllegalArgumentException("Unsupported OTA bundle format: " + format);
        }
        String rawBundleUrl = bundle.optString("url", "").trim();
        if (rawBundleUrl.isEmpty()) {
            throw new IllegalArgumentException("Manifest missing bundle.url");
        }
        String resolvedUrl = rawBundleUrl;
        if (!rawBundleUrl.startsWith("http://") && !rawBundleUrl.startsWith("https://")) {
            if (baseUrl == null || baseUrl.isEmpty()) {
                throw new IllegalArgumentException("Relative bundle.url requires manifestUrl");
            }
            resolvedUrl = new URI(baseUrl).resolve(rawBundleUrl).toString();
        }
        validateHttpUrl(ctx, resolvedUrl, "bundle.url");

        String sha256 = bundle.optString("sha256", "").trim().toLowerCase(Locale.US);
        if (!SHA256_PATTERN.matcher(sha256).matches()) {
            throw new IllegalArgumentException("Invalid bundle.sha256 in manifest");
        }
        long size = bundle.optLong("size", -1);
        if (size == 0 || size > MAX_BUNDLE_BYTES) {
            throw new IllegalArgumentException("Invalid bundle.size in manifest: " + size);
        }

        JSONObject normalized = new JSONObject(raw.toString());
        JSONObject normBundle = new JSONObject(bundle.toString());
        normBundle.put("format", format);
        normBundle.put("url", resolvedUrl);
        normBundle.put("sha256", sha256);
        normalized.put("bundle", normBundle);
        return normalized;
    }

    private static void validateHttpUrl(Context ctx, String rawUrl, String label) throws Exception {
        URL parsed = new URL(rawUrl);
        String scheme = parsed.getProtocol() != null ? parsed.getProtocol().toLowerCase(Locale.US) : "";
        boolean isDebuggable = (ctx.getApplicationInfo().flags & ApplicationInfo.FLAG_DEBUGGABLE) != 0;
        if ("https".equals(scheme)) {
            return;
        }
        if ("http".equals(scheme) && isDebuggable) {
            return;
        }
        throw new SecurityException(label + " must use https:// in release builds");
    }

    private static String fetchText(String urlStr, JSONObject headers, int timeoutMs) throws Exception {
        HttpURLConnection conn = openConnection(urlStr, headers, timeoutMs);
        try {
            int status = conn.getResponseCode();
            InputStream stream = status >= 400 ? conn.getErrorStream() : conn.getInputStream();
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            if (stream != null) {
                try (InputStream in = new BufferedInputStream(stream)) {
                    byte[] buf = new byte[8192];
                    int n;
                    while ((n = in.read(buf)) >= 0) {
                        if (out.size() + n > MAX_MANIFEST_BYTES) {
                            throw new IllegalStateException("Manifest exceeds 1 MiB limit");
                        }
                        out.write(buf, 0, n);
                    }
                }
            }
            if (status < 200 || status >= 300) {
                throw new IllegalStateException("HTTP " + status + " fetching manifest");
            }
            return new String(out.toByteArray(), StandardCharsets.UTF_8);
        } finally {
            conn.disconnect();
        }
    }

    private static final class DownloadDigest {
        final long bytesWritten;
        final String sha256Hex;

        DownloadDigest(long bytesWritten, String sha256Hex) {
            this.bytesWritten = bytesWritten;
            this.sha256Hex = sha256Hex;
        }
    }

    private static DownloadDigest downloadToTempFile(
            String urlStr,
            JSONObject headers,
            int timeoutMs,
            File dest,
            String releaseId,
            long expectedSize
    ) throws Exception {
        HttpURLConnection conn = openConnection(urlStr, headers, timeoutMs);
        try {
            int status = conn.getResponseCode();
            if (status < 200 || status >= 300) {
                throw new IllegalStateException("HTTP " + status + " downloading OTA bundle");
            }
            long total = expectedSize > 0 ? expectedSize : conn.getContentLengthLong();
            MessageDigest md = MessageDigest.getInstance("SHA-256");
            long received = 0;
            long lastEmitAt = 0;
            emitProgress(releaseId, 0, total, "downloading");
            try (InputStream in = new BufferedInputStream(conn.getInputStream());
                 FileOutputStream fos = new FileOutputStream(dest)) {
                byte[] buf = new byte[16384];
                int n;
                while ((n = in.read(buf)) >= 0) {
                    if (n == 0) continue;
                    received += n;
                    if (received > MAX_BUNDLE_BYTES) {
                        throw new IllegalStateException("OTA bundle exceeds 32 MiB safety limit");
                    }
                    md.update(buf, 0, n);
                    fos.write(buf, 0, n);
                    long now = System.currentTimeMillis();
                    if (now - lastEmitAt >= 120) {
                        lastEmitAt = now;
                        emitProgress(releaseId, received, total, "downloading");
                    }
                }
                fos.getFD().sync();
            }
            return new DownloadDigest(received, toHex(md.digest()));
        } finally {
            conn.disconnect();
        }
    }

    private static HttpURLConnection openConnection(String urlStr, JSONObject headers, int timeoutMs) throws Exception {
        HttpURLConnection conn = (HttpURLConnection) new URL(urlStr).openConnection();
        conn.setRequestMethod("GET");
        conn.setConnectTimeout(timeoutMs);
        conn.setReadTimeout(timeoutMs);
        conn.setInstanceFollowRedirects(true);
        conn.setUseCaches(false);
        conn.setRequestProperty("Cache-Control", "no-cache");
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

    private static void verifyEcdsaSignature(File bundleFile, String publicKeyB64, String signatureB64) throws Exception {
        byte[] keyBytes = Base64.decode(publicKeyB64, Base64.DEFAULT);
        byte[] sigBytes = Base64.decode(signatureB64, Base64.DEFAULT);
        KeyFactory kf = KeyFactory.getInstance("EC");
        PublicKey publicKey = kf.generatePublic(new X509EncodedKeySpec(keyBytes));
        Signature verifier = Signature.getInstance("SHA256withECDSA");
        verifier.initVerify(publicKey);
        try (InputStream in = new BufferedInputStream(new FileInputStream(bundleFile))) {
            byte[] buf = new byte[16384];
            int n;
            while ((n = in.read(buf)) >= 0) {
                if (n > 0) verifier.update(buf, 0, n);
            }
        }
        if (!verifier.verify(sigBytes)) {
            throw new SecurityException("OTA ECDSA signature verification failed");
        }
    }

    // ── Metadata & state persistence (aligned with android/rust/src/ota.rs) ──

    private static EmbeddedMeta loadEmbeddedMeta(Context ctx) {
        EmbeddedMeta meta = new EmbeddedMeta();
        try {
            PackageInfo pkg = getPackageInfo(ctx);
            meta.appId = ctx.getPackageName();
            meta.versionName = pkg.versionName != null ? pkg.versionName : "0.1.0";
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
                meta.versionCode = pkg.getLongVersionCode();
            } else {
                //noinspection deprecation
                meta.versionCode = pkg.versionCode;
            }
            meta.runtimeVersion = String.valueOf(meta.versionCode);
        } catch (Throwable ignored) {
        }

        try (InputStream in = ctx.getAssets().open(META_ASSET_PATH)) {
            String raw = readStreamUtf8(in);
            Map<String, String> kv = parseKv(raw);
            if (!kv.getOrDefault("app_id", "").isEmpty()) meta.appId = kv.get("app_id");
            if (!kv.getOrDefault("version_name", "").isEmpty()) meta.versionName = kv.get("version_name");
            long vc = parseLong(kv.get("version_code"), 0);
            if (vc > 0) meta.versionCode = vc;
            if (!kv.getOrDefault("runtime_version", "").isEmpty()) meta.runtimeVersion = kv.get("runtime_version");
            if (!kv.getOrDefault("channel", "").isEmpty()) meta.channel = kv.get("channel");
            meta.manifestUrl = kv.getOrDefault("manifest_url", "");
            meta.publicKey = kv.getOrDefault("public_key", "");
            if (!kv.getOrDefault("check_on_launch", "").isEmpty()) meta.checkOnLaunch = kv.get("check_on_launch");
            if (!kv.getOrDefault("embedded_format", "").isEmpty()) meta.embeddedFormat = kv.get("embedded_format");
            meta.embeddedBuildId = kv.getOrDefault("embedded_build_id", "");
        } catch (Throwable ignored) {
        }
        return meta;
    }

    @SuppressWarnings("deprecation")
    private static PackageInfo getPackageInfo(Context ctx) throws PackageManager.NameNotFoundException {
        PackageManager pm = ctx.getPackageManager();
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            return pm.getPackageInfo(ctx.getPackageName(), PackageManager.PackageInfoFlags.of(0));
        }
        return pm.getPackageInfo(ctx.getPackageName(), 0);
    }

    private static File getOtaDir(Context ctx) {
        return new File(ctx.getFilesDir(), OTA_DIR_NAME);
    }

    private static OtaState resetStateForMeta(EmbeddedMeta meta) {
        OtaState state = new OtaState();
        state.baseVersionCode = meta.versionCode;
        state.runtimeVersion = meta.runtimeVersion;
        state.embeddedBuildId = meta.embeddedBuildId;
        return state;
    }

    private static OtaState loadOrSyncStateLocked(Context ctx, EmbeddedMeta meta) {
        File otaDir = getOtaDir(ctx);
        File stateFile = new File(otaDir, STATE_FILE_NAME);
        if (!stateFile.isFile()) {
            OtaState fresh = resetStateForMeta(meta);
            try { saveStateLocked(ctx, fresh); } catch (Throwable ignored) {}
            return fresh;
        }
        try {
            String raw = readFileUtf8(stateFile);
            OtaState state = parseStateKv(raw);
            boolean hasMetaIdentity = meta.versionCode > 0 || !meta.embeddedBuildId.isEmpty();
            boolean mismatch = state.baseVersionCode != meta.versionCode
                    || !meta.runtimeVersion.equals(state.runtimeVersion)
                    || !meta.embeddedBuildId.equals(state.embeddedBuildId);
            if (hasMetaIdentity && mismatch) {
                deleteRecursively(new File(otaDir, "releases"));
                deleteRecursively(new File(otaDir, "tmp"));
                OtaState fresh = resetStateForMeta(meta);
                saveStateLocked(ctx, fresh);
                return fresh;
            }
            return state;
        } catch (Throwable t) {
            Log.w(TAG, "Failed to read OTA state, resetting", t);
            OtaState fresh = resetStateForMeta(meta);
            try { saveStateLocked(ctx, fresh); } catch (Throwable ignored) {}
            return fresh;
        }
    }

    private static void saveStateLocked(Context ctx, OtaState state) throws Exception {
        File otaDir = getOtaDir(ctx);
        if (!otaDir.exists() && !otaDir.mkdirs()) {
            throw new IllegalStateException("Cannot create gpuix_ota directory");
        }
        File target = new File(otaDir, STATE_FILE_NAME);
        File tmp = new File(otaDir, STATE_FILE_NAME + ".tmp");
        String encoded = serializeStateKv(state);
        try (FileOutputStream fos = new FileOutputStream(tmp)) {
            fos.write(encoded.getBytes(StandardCharsets.UTF_8));
            fos.getFD().sync();
        }
        if (target.exists() && !target.delete()) {
            // Fallback replace when rename cannot overwrite directly.
            Log.w(TAG, "Could not delete previous state.kv before rename");
        }
        if (!tmp.renameTo(target)) {
            copyFileAtomic(tmp, target);
            //noinspection ResultOfMethodCallIgnored
            tmp.delete();
        }
    }

    private static OtaState parseStateKv(String raw) {
        Map<String, String> kv = parseKv(raw);
        OtaState state = new OtaState();
        state.baseVersionCode = parseLong(kv.get("base_version_code"), 0);
        state.runtimeVersion = kv.getOrDefault("runtime_version", "");
        state.embeddedBuildId = kv.getOrDefault("embedded_build_id", "");

        String activeId = kv.getOrDefault("active_id", "");
        if (!activeId.isEmpty()) {
            BundleSlot slot = new BundleSlot();
            slot.id = activeId;
            slot.sha256 = kv.getOrDefault("active_sha256", "");
            slot.format = kv.getOrDefault("active_format", "hbc");
            slot.bundleRel = kv.getOrDefault("active_bundle", "");
            slot.confirmed = "1".equals(kv.get("active_confirmed"));
            slot.attempts = (int) parseLong(kv.get("active_attempts"), 0);
            state.active = slot;
        }

        String prevId = kv.getOrDefault("prev_id", "");
        if (!prevId.isEmpty()) {
            BundleSlot slot = new BundleSlot();
            slot.id = prevId;
            slot.sha256 = kv.getOrDefault("prev_sha256", "");
            slot.format = kv.getOrDefault("prev_format", "hbc");
            slot.bundleRel = kv.getOrDefault("prev_bundle", "");
            slot.confirmed = true;
            slot.attempts = 0;
            state.prev = slot;
        }

        String stagedId = kv.getOrDefault("staged_id", "");
        if (!stagedId.isEmpty()) {
            BundleSlot slot = new BundleSlot();
            slot.id = stagedId;
            slot.sha256 = kv.getOrDefault("staged_sha256", "");
            slot.format = kv.getOrDefault("staged_format", "hbc");
            slot.bundleRel = kv.getOrDefault("staged_bundle", "");
            slot.confirmed = false;
            slot.attempts = 0;
            state.staged = slot;
        }

        String failedRaw = kv.getOrDefault("failed_ids", "");
        if (!failedRaw.isEmpty()) {
            for (String item : failedRaw.split(",")) {
                String trimmed = item.trim();
                if (!trimmed.isEmpty()) state.failedIds.add(trimmed);
            }
        }
        state.lastRollbackReason = kv.getOrDefault("last_rollback_reason", "");
        state.lastCheckedAt = parseLong(kv.get("last_checked_at"), 0);
        return state;
    }

    private static String serializeStateKv(OtaState state) {
        StringBuilder sb = new StringBuilder();
        sb.append("schema=1\n");
        sb.append("base_version_code=").append(state.baseVersionCode).append('\n');
        sb.append("runtime_version=").append(sanitizeSingleLine(state.runtimeVersion)).append('\n');
        sb.append("embedded_build_id=").append(sanitizeSingleLine(state.embeddedBuildId)).append('\n');

        BundleSlot a = state.active;
        sb.append("active_id=").append(a != null ? sanitizeSingleLine(a.id) : "").append('\n');
        sb.append("active_sha256=").append(a != null ? sanitizeSingleLine(a.sha256) : "").append('\n');
        sb.append("active_format=").append(a != null ? sanitizeSingleLine(a.format) : "").append('\n');
        sb.append("active_bundle=").append(a != null ? sanitizeSingleLine(a.bundleRel) : "").append('\n');
        sb.append("active_confirmed=").append(a != null && a.confirmed ? "1" : "0").append('\n');
        sb.append("active_attempts=").append(a != null ? a.attempts : 0).append('\n');

        BundleSlot p = state.prev;
        sb.append("prev_id=").append(p != null ? sanitizeSingleLine(p.id) : "").append('\n');
        sb.append("prev_sha256=").append(p != null ? sanitizeSingleLine(p.sha256) : "").append('\n');
        sb.append("prev_format=").append(p != null ? sanitizeSingleLine(p.format) : "").append('\n');
        sb.append("prev_bundle=").append(p != null ? sanitizeSingleLine(p.bundleRel) : "").append('\n');

        BundleSlot s = state.staged;
        sb.append("staged_id=").append(s != null ? sanitizeSingleLine(s.id) : "").append('\n');
        sb.append("staged_sha256=").append(s != null ? sanitizeSingleLine(s.sha256) : "").append('\n');
        sb.append("staged_format=").append(s != null ? sanitizeSingleLine(s.format) : "").append('\n');
        sb.append("staged_bundle=").append(s != null ? sanitizeSingleLine(s.bundleRel) : "").append('\n');

        StringBuilder failed = new StringBuilder();
        for (int i = 0; i < state.failedIds.size(); i++) {
            if (i > 0) failed.append(',');
            failed.append(sanitizeSingleLine(state.failedIds.get(i)));
        }
        sb.append("failed_ids=").append(failed).append('\n');
        sb.append("last_rollback_reason=").append(sanitizeSingleLine(state.lastRollbackReason)).append('\n');
        sb.append("last_checked_at=").append(state.lastCheckedAt).append('\n');
        return sb.toString();
    }

    private static JSONObject buildStateJson(EmbeddedMeta meta, OtaState state) throws Exception {
        JSONObject res = new JSONObject();
        res.put("source", state.active != null ? "ota" : "embedded");
        res.put("appId", meta.appId);
        res.put("versionName", meta.versionName);
        res.put("versionCode", meta.versionCode);
        res.put("runtimeVersion", meta.runtimeVersion);
        res.put("channel", meta.channel);
        res.put("manifestUrl", !meta.manifestUrl.isEmpty() ? meta.manifestUrl : JSONObject.NULL);
        res.put("hasPublicKey", !meta.publicKey.isEmpty());
        res.put("checkOnLaunch", meta.checkOnLaunch);
        res.put("embeddedFormat", meta.embeddedFormat);
        res.put("embeddedBuildId", meta.embeddedBuildId);
        res.put("currentReleaseId", state.active != null ? state.active.id : JSONObject.NULL);
        res.put("currentFormat", state.active != null ? state.active.format : meta.embeddedFormat);
        res.put("stagedReleaseId", state.staged != null ? state.staged.id : JSONObject.NULL);
        res.put("previousReleaseId", state.prev != null ? state.prev.id : JSONObject.NULL);
        res.put("confirmed", state.active == null || state.active.confirmed);
        res.put("launchAttempts", state.active != null ? state.active.attempts : 0);
        JSONArray failedArr = new JSONArray();
        for (String id : state.failedIds) failedArr.put(id);
        res.put("failedReleaseIds", failedArr);
        res.put("lastRollbackReason", !state.lastRollbackReason.isEmpty() ? state.lastRollbackReason : JSONObject.NULL);
        res.put("lastCheckedAt", state.lastCheckedAt);
        return res;
    }

    // ── File, crypto, GC & process restart helpers ───────────────────────────

    private static boolean verifySlotFile(Context ctx, BundleSlot slot) {
        if (slot == null || !isValidReleaseId(slot.id) || !SHA256_PATTERN.matcher(slot.sha256).matches()) {
            return false;
        }
        if (slot.bundleRel == null || !slot.bundleRel.startsWith("releases/") || slot.bundleRel.contains("..") || slot.bundleRel.contains("\\")) {
            return false;
        }
        File file = new File(getOtaDir(ctx), slot.bundleRel);
        if (!file.isFile() || file.length() <= 0 || file.length() > MAX_BUNDLE_BYTES) {
            return false;
        }
        try {
            if ("hbc".equals(slot.format) && !hasValidHermesMagic(file)) {
                return false;
            }
            String actual = computeSha256Hex(file);
            return actual.equalsIgnoreCase(slot.sha256);
        } catch (Throwable ignored) {
            return false;
        }
    }

    private static boolean hasValidHermesMagic(File file) throws Exception {
        if (file.length() < HERMES_MAGIC.length) return false;
        byte[] header = new byte[HERMES_MAGIC.length];
        try (FileInputStream fis = new FileInputStream(file)) {
            int n = fis.read(header);
            if (n < HERMES_MAGIC.length) return false;
        }
        for (int i = 0; i < HERMES_MAGIC.length; i++) {
            if (header[i] != HERMES_MAGIC[i]) return false;
        }
        return true;
    }

    private static String computeSha256Hex(File file) throws Exception {
        MessageDigest md = MessageDigest.getInstance("SHA-256");
        try (InputStream in = new BufferedInputStream(new FileInputStream(file))) {
            byte[] buf = new byte[16384];
            int n;
            while ((n = in.read(buf)) >= 0) {
                if (n > 0) md.update(buf, 0, n);
            }
        }
        return toHex(md.digest());
    }

    private static void gcUnusedReleasesLocked(File otaDir, OtaState state) {
        File releasesDir = new File(otaDir, "releases");
        if (!releasesDir.isDirectory()) return;
        Set<String> keep = new HashSet<>();
        if (state.active != null) keep.add(state.active.id);
        if (state.prev != null) keep.add(state.prev.id);
        if (state.staged != null) keep.add(state.staged.id);
        File[] children = releasesDir.listFiles();
        if (children == null) return;
        for (File child : children) {
            if (!keep.contains(child.getName())) {
                deleteRecursively(child);
            }
        }
    }

    private static void scheduleProcessRestart(Context ctx) {
        SCHEDULER.schedule(() -> MAIN_HANDLER.post(() -> {
            try {
                PackageManager pm = ctx.getPackageManager();
                Intent launch = pm.getLaunchIntentForPackage(ctx.getPackageName());
                if (launch != null && launch.getComponent() != null) {
                    Intent restart = Intent.makeRestartActivityTask(launch.getComponent());
                    restart.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TASK);
                    ctx.startActivity(restart);
                }
            } catch (Throwable t) {
                Log.e(TAG, "Failed to relaunch activity on OTA restart", t);
            } finally {
                android.os.Process.killProcess(android.os.Process.myPid());
                System.exit(0);
            }
        }), 150, TimeUnit.MILLISECONDS);
    }

    private static void emitProgress(String releaseId, long received, long total, String phase) {
        try {
            JSONObject ev = new JSONObject();
            ev.put("releaseId", releaseId);
            ev.put("bytesReceived", received);
            ev.put("totalBytes", total);
            ev.put("progress", total > 0 ? Math.min(1.0, (double) received / (double) total) : -1);
            ev.put("phase", phase);
            GpuiNativeBridge.nativeBridgeEvent("otaProgress", ev.toString());
        } catch (Throwable ignored) {
        }
    }

    private static boolean isValidReleaseId(String id) {
        return id != null && !id.contains("..") && RELEASE_ID_PATTERN.matcher(id).matches();
    }

    private static void addFailedId(List<String> failedIds, String id) {
        if (!isValidReleaseId(id)) return;
        failedIds.remove(id);
        failedIds.add(id);
        while (failedIds.size() > MAX_FAILED_IDS) {
            failedIds.remove(0);
        }
    }

    private static Map<String, String> parseKv(String raw) {
        Map<String, String> map = new LinkedHashMap<>();
        if (raw == null) return map;
        String[] lines = raw.split("\n");
        for (String line : lines) {
            String trimmed = line.trim();
            if (trimmed.isEmpty() || trimmed.startsWith("#")) continue;
            int eq = line.indexOf('=');
            if (eq > 0) {
                String k = line.substring(0, eq).trim();
                String v = line.substring(eq + 1).replace("\r", "");
                map.put(k, v);
            }
        }
        return map;
    }

    private static String sanitizeSingleLine(String raw) {
        if (raw == null) return "";
        return raw.replace('\r', ' ').replace('\n', ' ').replace('\0', ' ');
    }

    private static long parseLong(String raw, long fallback) {
        if (raw == null || raw.isEmpty()) return fallback;
        try {
            return Long.parseLong(raw.trim());
        } catch (NumberFormatException ignored) {
            return fallback;
        }
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

    private static String readFileUtf8(File file) throws Exception {
        try (InputStream in = new FileInputStream(file)) {
            return readStreamUtf8(in);
        }
    }

    private static String readStreamUtf8(InputStream in) throws Exception {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        byte[] buf = new byte[4096];
        int n;
        while ((n = in.read(buf)) >= 0) {
            out.write(buf, 0, n);
        }
        return new String(out.toByteArray(), StandardCharsets.UTF_8);
    }

    private static void copyFileAtomic(File src, File dst) throws Exception {
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

    // ── JNI hooks implemented by android/rust/src/lib.rs ─────────────────────

    private static native boolean nativeTriggerHotApply();

    private static native boolean nativeTriggerHotRollback();
}
