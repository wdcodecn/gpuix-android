package dev.gpui.mobile;

import android.app.Activity;
import android.content.Intent;
import android.util.Log;
import dev.gpui.mobile.bridge.AudioHapticsPlugin;
import dev.gpui.mobile.bridge.BridgeContext;
import dev.gpui.mobile.bridge.DeviceSystemPlugin;
import dev.gpui.mobile.bridge.FileTransferPlugin;
import dev.gpui.mobile.bridge.HardwarePlugin;
import dev.gpui.mobile.bridge.MediaLocationPlugin;
import dev.gpui.mobile.bridge.NotificationsPlugin;
import dev.gpui.mobile.bridge.StoragePlugin;
import java.util.concurrent.ConcurrentHashMap;
import org.json.JSONObject;

/**
 * Unified Android native capabilities bridge & extensible plugin registry.
 * Delegates built-in modules to modular plugins under {@code dev.gpui.mobile.bridge}.
 */
public final class GpuiNativeBridge {

    public interface PluginHandler {
        void handle(Activity activity, long requestId, String method, JSONObject args) throws Exception;
    }

    private static final String TAG = "GpuiNativeBridge";
    private static final ConcurrentHashMap<String, PluginHandler> PLUGINS = new ConcurrentHashMap<>();

    static {
        NotificationsPlugin.register();
        AudioHapticsPlugin.register();
        HardwarePlugin.register();
        DeviceSystemPlugin.register();
        StoragePlugin.register();
        MediaLocationPlugin.register();
        FileTransferPlugin.register();
        registerPlugin("ota", GpuiOtaManager::handle);
    }

    private GpuiNativeBridge() {
    }

    public static void registerPlugin(String module, PluginHandler handler) {
        if (module != null && handler != null) {
            PLUGINS.put(module, handler);
        }
    }

    public static void setInitialDeepLink(String url) {
        DeviceSystemPlugin.setInitialDeepLink(url);
    }

    public static void cleanup() {
        BridgeContext.runCleanups();
    }

    // ── Unified async dispatcher ─────────────────────────────────────────────

    public static void invokeAsync(final long requestId, final String module, final String method, final String argsJson) {
        BridgeContext.WORKER.execute(() -> {
            try {
                Activity activity = GpuiActivity.currentActivity();
                if (activity == null) {
                    reject(requestId, "No active GpuiActivity");
                    return;
                }
                JSONObject args = (argsJson != null && !argsJson.trim().isEmpty())
                        ? new JSONObject(argsJson)
                        : new JSONObject();

                PluginHandler handler = module != null ? PLUGINS.get(module) : null;
                if (handler != null) {
                    handler.handle(activity, requestId, method, args);
                } else {
                    reject(requestId, "Unknown native module: " + module);
                }
            } catch (Throwable t) {
                Log.e(TAG, "invokeAsync failed: " + module + "." + method, t);
                reject(requestId, t.getMessage() != null ? t.getMessage() : t.getClass().getSimpleName());
            }
        });
    }

    public static void resolve(long requestId, Object result) {
        try {
            String json = result != null ? result.toString() : "null";
            nativeBridgeResult(requestId, true, json);
        } catch (UnsatisfiedLinkError ignored) {
        }
    }

    public static void reject(long requestId, String error) {
        try {
            JSONObject obj = new JSONObject();
            obj.put("error", error != null ? error : "Unknown native error");
            nativeBridgeResult(requestId, false, obj.toString());
        } catch (Throwable ignored) {
        }
    }

    public static void emitEvent(String channel, Object payload) {
        try {
            nativeBridgeEvent(channel != null ? channel : "", payload != null ? payload.toString() : "null");
        } catch (UnsatisfiedLinkError ignored) {
        }
    }

    // ── Activity / permission callbacks ──────────────────────────────────────

    public static void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
        BridgeContext.onRequestPermissionsResult(requestCode, permissions, grantResults);
    }

    public static void onActivityResult(int requestCode, int resultCode, Intent data) {
        BridgeContext.onActivityResult(requestCode, resultCode, data);
    }

    // ── Sync storage entrypoints exposed to Rust/JNI ─────────────────────────

    public static String kvGet(String key) {
        return StoragePlugin.kvGet(key);
    }

    public static boolean kvSet(String key, String value) {
        return StoragePlugin.kvSet(key, value);
    }

    public static boolean kvRemove(String key) {
        return StoragePlugin.kvRemove(key);
    }

    public static boolean kvClear() {
        return StoragePlugin.kvClear();
    }

    public static String kvKeysJson() {
        return StoragePlugin.kvKeysJson();
    }

    public static boolean secureWrite(String service, String account, String base64Value) {
        return StoragePlugin.secureWrite(service, account, base64Value);
    }

    public static String secureRead(String service, String account) {
        return StoragePlugin.secureRead(service, account);
    }

    public static boolean secureDelete(String service, String account) {
        return StoragePlugin.secureDelete(service, account);
    }

    // ── JNI callbacks implemented by Rust gpui-mobile ────────────────────────

    public static native void nativeBridgeResult(long requestId, boolean ok, String payloadJson);

    public static native void nativeBridgeEvent(String channel, String payloadJson);
}
