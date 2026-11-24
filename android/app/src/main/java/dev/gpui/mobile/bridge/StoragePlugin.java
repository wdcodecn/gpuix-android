package dev.gpui.mobile.bridge;

import android.app.Activity;
import android.content.Context;
import android.content.SharedPreferences;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;
import android.util.Log;
import dev.gpui.mobile.GpuiNativeBridge;
import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;
import org.json.JSONArray;
import org.json.JSONObject;

/**
 * Synchronous SharedPreferences KV storage and Keystore AES/GCM/NoPadding secure storage.
 */
public final class StoragePlugin {

    private static final String TAG = "StoragePlugin";
    private static final String KV_PREFS = "gpuix_kv";
    private static final String SECURE_PREFS = "gpuix_secure_kv";
    private static final String KEY_ALIAS = "gpuix_master_key";

    private StoragePlugin() {
    }

    public static void register() {
        GpuiNativeBridge.registerPlugin("storage", (a, r, m, args) -> handleStorage(r, m, args));
        GpuiNativeBridge.registerPlugin("secureStorage", (a, r, m, args) -> handleSecureStorage(r, m, args));
    }

    private static SharedPreferences kvPrefs() {
        Activity activity = BridgeContext.currentActivity();
        return activity != null ? activity.getApplicationContext().getSharedPreferences(KV_PREFS, Context.MODE_PRIVATE) : null;
    }

    public static String kvGet(String key) {
        SharedPreferences prefs = kvPrefs();
        if (prefs == null || key == null) return null;
        return prefs.getString(key, null);
    }

    public static boolean kvSet(String key, String value) {
        SharedPreferences prefs = kvPrefs();
        if (prefs == null || key == null) return false;
        return prefs.edit().putString(key, value).commit();
    }

    public static boolean kvRemove(String key) {
        SharedPreferences prefs = kvPrefs();
        if (prefs == null || key == null) return false;
        return prefs.edit().remove(key).commit();
    }

    public static boolean kvClear() {
        SharedPreferences prefs = kvPrefs();
        if (prefs == null) return false;
        return prefs.edit().clear().commit();
    }

    public static String kvKeysJson() {
        SharedPreferences prefs = kvPrefs();
        if (prefs == null) return "[]";
        JSONArray arr = new JSONArray();
        for (String k : prefs.getAll().keySet()) arr.put(k);
        return arr.toString();
    }

    public static void handleStorage(long reqId, String method, JSONObject args) throws Exception {
        String key = args.optString("key", "");
        switch (method) {
            case "get": {
                String v = kvGet(key);
                BridgeContext.resolve(reqId, new JSONObject().put("value", v != null ? v : JSONObject.NULL));
                break;
            }
            case "set": {
                BridgeContext.resolve(reqId, new JSONObject().put("ok", kvSet(key, args.optString("value", ""))));
                break;
            }
            case "remove": {
                BridgeContext.resolve(reqId, new JSONObject().put("ok", kvRemove(key)));
                break;
            }
            case "clear": {
                BridgeContext.resolve(reqId, new JSONObject().put("ok", kvClear()));
                break;
            }
            case "keys": {
                BridgeContext.resolve(reqId, new JSONObject().put("keys", new JSONArray(kvKeysJson())));
                break;
            }
            default:
                BridgeContext.reject(reqId, "Unsupported storage method: " + method);
        }
    }

    private static SecretKey getOrCreateMasterKey() throws Exception {
        KeyStore ks = KeyStore.getInstance("AndroidKeyStore");
        ks.load(null);
        if (ks.containsAlias(KEY_ALIAS)) {
            KeyStore.Entry entry = ks.getEntry(KEY_ALIAS, null);
            if (entry instanceof KeyStore.SecretKeyEntry) {
                return ((KeyStore.SecretKeyEntry) entry).getSecretKey();
            }
        }
        KeyGenerator kg = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
        kg.init(new KeyGenParameterSpec.Builder(
                KEY_ALIAS,
                KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .build());
        return kg.generateKey();
    }

    private static String secureKey(String service, String account) {
        return (service != null ? service : "default") + "::" + (account != null ? account : "default");
    }

    public static boolean secureWrite(String service, String account, String base64Value) {
        Activity activity = BridgeContext.currentActivity();
        if (activity == null || base64Value == null) return false;
        try {
            SecretKey key = getOrCreateMasterKey();
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.ENCRYPT_MODE, key);
            byte[] iv = cipher.getIV();
            byte[] encrypted = cipher.doFinal(base64Value.getBytes(StandardCharsets.UTF_8));
            byte[] combined = new byte[1 + iv.length + encrypted.length];
            combined[0] = (byte) iv.length;
            System.arraycopy(iv, 0, combined, 1, iv.length);
            System.arraycopy(encrypted, 0, combined, 1 + iv.length, encrypted.length);
            String stored = Base64.encodeToString(combined, Base64.NO_WRAP);
            SharedPreferences prefs = activity.getApplicationContext().getSharedPreferences(SECURE_PREFS, Context.MODE_PRIVATE);
            return prefs.edit().putString(secureKey(service, account), stored).commit();
        } catch (Throwable t) {
            Log.e(TAG, "secureWrite failed", t);
            return false;
        }
    }

    public static String secureRead(String service, String account) {
        Activity activity = BridgeContext.currentActivity();
        if (activity == null) return null;
        try {
            SharedPreferences prefs = activity.getApplicationContext().getSharedPreferences(SECURE_PREFS, Context.MODE_PRIVATE);
            String stored = prefs.getString(secureKey(service, account), null);
            if (stored == null) return null;
            byte[] combined = Base64.decode(stored, Base64.NO_WRAP);
            int ivLen = combined[0] & 0xff;
            if (ivLen <= 0 || combined.length <= 1 + ivLen) return null;
            byte[] iv = new byte[ivLen];
            byte[] encrypted = new byte[combined.length - 1 - ivLen];
            System.arraycopy(combined, 1, iv, 0, ivLen);
            System.arraycopy(combined, 1 + ivLen, encrypted, 0, encrypted.length);
            SecretKey key = getOrCreateMasterKey();
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.DECRYPT_MODE, key, new GCMParameterSpec(128, iv));
            byte[] plain = cipher.doFinal(encrypted);
            return new String(plain, StandardCharsets.UTF_8);
        } catch (Throwable t) {
            Log.e(TAG, "secureRead failed", t);
            return null;
        }
    }

    public static boolean secureDelete(String service, String account) {
        Activity activity = BridgeContext.currentActivity();
        if (activity == null) return false;
        SharedPreferences prefs = activity.getApplicationContext().getSharedPreferences(SECURE_PREFS, Context.MODE_PRIVATE);
        return prefs.edit().remove(secureKey(service, account)).commit();
    }

    public static void handleSecureStorage(long reqId, String method, JSONObject args) throws Exception {
        String service = args.optString("service", "gpuix");
        String account = args.optString("account", args.optString("key", "default"));
        switch (method) {
            case "write": {
                String val = args.optString("value", "");
                String b64 = Base64.encodeToString(val.getBytes(StandardCharsets.UTF_8), Base64.NO_WRAP);
                BridgeContext.resolve(reqId, new JSONObject().put("ok", secureWrite(service, account, b64)));
                break;
            }
            case "read": {
                String b64 = secureRead(service, account);
                if (b64 == null) {
                    BridgeContext.resolve(reqId, new JSONObject().put("value", JSONObject.NULL));
                } else {
                    String plain = new String(Base64.decode(b64, Base64.NO_WRAP), StandardCharsets.UTF_8);
                    BridgeContext.resolve(reqId, new JSONObject().put("value", plain));
                }
                break;
            }
            case "delete": {
                BridgeContext.resolve(reqId, new JSONObject().put("ok", secureDelete(service, account)));
                break;
            }
            default:
                BridgeContext.reject(reqId, "Unsupported secureStorage method: " + method);
        }
    }
}
