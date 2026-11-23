package dev.gpui.mobile;

import android.app.Activity;
import android.app.AlertDialog;
import android.app.KeyguardManager;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.ContentResolver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.SharedPreferences;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.database.Cursor;
import android.graphics.Bitmap;
import android.hardware.Sensor;
import android.hardware.SensorEvent;
import android.hardware.SensorEventListener;
import android.hardware.SensorManager;
import android.hardware.camera2.CameraCharacteristics;
import android.hardware.camera2.CameraManager;
import android.location.Location;
import android.location.LocationListener;
import android.location.LocationManager;
import android.media.AudioManager;
import android.media.Ringtone;
import android.media.RingtoneManager;
import android.media.ToneGenerator;
import android.net.ConnectivityManager;
import android.net.Network;
import android.net.NetworkCapabilities;
import android.net.Uri;
import android.os.BatteryManager;
import android.os.Build;
import android.os.Bundle;
import android.os.CancellationSignal;
import android.os.Handler;
import android.os.Looper;
import android.os.VibrationEffect;
import android.os.Vibrator;
import android.provider.MediaStore;
import android.provider.OpenableColumns;
import android.provider.Settings;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.speech.tts.TextToSpeech;
import android.util.Base64;
import android.util.DisplayMetrics;
import android.util.Log;
import android.view.HapticFeedbackConstants;
import android.view.View;
import android.view.WindowManager;
import android.widget.Toast;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;
import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;
import org.json.JSONArray;
import org.json.JSONObject;

/**
 * Unified Android native capabilities bridge & extensible plugin registry.
 * Exposes notifications, audio/TTS, haptics, biometrics, torch, sensors,
 * device/battery, system UI, clipboard, launcher, permissions, KV/Keystore
 * storage, media picker/camera, and geolocation to GPUIX Rust & Hermes JS.
 */
public final class GpuiNativeBridge {

    public interface PluginHandler {
        void handle(Activity activity, long requestId, String method, JSONObject args) throws Exception;
    }

    private interface ActivityResultConsumer {
        void onResult(int resultCode, Intent data);
    }

    private interface PermissionResultConsumer {
        void onResult(String[] permissions, int[] grantResults);
    }

    private static final String TAG = "GpuiNativeBridge";
    private static final String KV_PREFS = "gpuix_kv";
    private static final String SECURE_PREFS = "gpuix_secure_kv";
    private static final String KEY_ALIAS = "gpuix_master_key";
    private static final String DEFAULT_CHANNEL_ID = "gpuix_default_high";
    private static final String DEFAULT_CHANNEL_NAME = "GPUIX 通知";

    private static final Handler MAIN_HANDLER = new Handler(Looper.getMainLooper());
    private static final ExecutorService WORKER = Executors.newCachedThreadPool();
    private static final ScheduledExecutorService SCHEDULER = Executors.newScheduledThreadPool(2);

    private static final ConcurrentHashMap<String, PluginHandler> PLUGINS = new ConcurrentHashMap<>();
    private static final ConcurrentHashMap<Integer, PermissionResultConsumer> PERM_WAITERS = new ConcurrentHashMap<>();
    private static final ConcurrentHashMap<Integer, ActivityResultConsumer> ACT_WAITERS = new ConcurrentHashMap<>();
    private static final ConcurrentHashMap<String, SensorEventListener> ACTIVE_SENSORS = new ConcurrentHashMap<>();
    private static final AtomicInteger NEXT_REQ_CODE = new AtomicInteger(4100);
    private static final AtomicInteger NEXT_NOTIF_ID = new AtomicInteger(1001);

    private static volatile String sInitialDeepLink = null;
    private static volatile boolean sTorchEnabled = false;
    private static volatile TextToSpeech sTts = null;
    private static volatile boolean sTtsReady = false;
    private static final Object TTS_LOCK = new Object();

    private GpuiNativeBridge() {
    }

    public static void registerPlugin(String module, PluginHandler handler) {
        if (module != null && handler != null) {
            PLUGINS.put(module, handler);
        }
    }

    public static void setInitialDeepLink(String url) {
        sInitialDeepLink = url;
    }

    public static void cleanup() {
        Activity activity = GpuiActivity.currentActivity();
        if (activity != null) {
            SensorManager sm = (SensorManager) activity.getSystemService(Context.SENSOR_SERVICE);
            if (sm != null) {
                for (SensorEventListener listener : ACTIVE_SENSORS.values()) {
                    try { sm.unregisterListener(listener); } catch (Throwable ignored) {}
                }
            }
        }
        ACTIVE_SENSORS.clear();
        PERM_WAITERS.clear();
        ACT_WAITERS.clear();
        synchronized (TTS_LOCK) {
            if (sTts != null) {
                try { sTts.stop(); sTts.shutdown(); } catch (Throwable ignored) {}
                sTts = null;
                sTtsReady = false;
            }
        }
    }

    // ── Unified async dispatcher ─────────────────────────────────────────────

    public static void invokeAsync(final long requestId, final String module, final String method, final String argsJson) {
        WORKER.execute(() -> {
            try {
                Activity activity = GpuiActivity.currentActivity();
                if (activity == null) {
                    reject(requestId, "No active GpuiActivity");
                    return;
                }
                JSONObject args = (argsJson != null && !argsJson.trim().isEmpty())
                        ? new JSONObject(argsJson)
                        : new JSONObject();

                PluginHandler custom = PLUGINS.get(module);
                if (custom != null) {
                    custom.handle(activity, requestId, method, args);
                    return;
                }

                switch (module != null ? module : "") {
                    case "notifications":
                        handleNotifications(activity, requestId, method, args);
                        break;
                    case "audio":
                        handleAudio(activity, requestId, method, args);
                        break;
                    case "haptics":
                        handleHaptics(activity, requestId, method, args);
                        break;
                    case "biometrics":
                        handleBiometrics(activity, requestId, method, args);
                        break;
                    case "torch":
                        handleTorch(activity, requestId, method, args);
                        break;
                    case "sensors":
                        handleSensors(activity, requestId, method, args);
                        break;
                    case "device":
                        handleDevice(activity, requestId, method);
                        break;
                    case "system":
                        handleSystem(activity, requestId, method, args);
                        break;
                    case "clipboard":
                        handleClipboard(requestId, method, args);
                        break;
                    case "launcher":
                        handleLauncher(activity, requestId, method, args);
                        break;
                    case "permissions":
                        handlePermissions(activity, requestId, method, args);
                        break;
                    case "storage":
                        handleStorage(requestId, method, args);
                        break;
                    case "secureStorage":
                        handleSecureStorage(requestId, method, args);
                        break;
                    case "media":
                        handleMedia(activity, requestId, method, args);
                        break;
                    case "location":
                        handleLocation(activity, requestId, method);
                        break;
                    default:
                        reject(requestId, "Unknown native module: " + module);
                        break;
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

    // ── 1. Notifications (push simulation, delayed, progress, channels) ──────

    private static void handleNotifications(Activity activity, long reqId, String method, JSONObject args) throws Exception {
        NotificationManager nm = (NotificationManager) activity.getSystemService(Context.NOTIFICATION_SERVICE);
        if (nm == null) {
            reject(reqId, "NotificationManager unavailable");
            return;
        }
        switch (method) {
            case "areEnabled": {
                JSONObject res = new JSONObject();
                boolean enabled = nm.areNotificationsEnabled();
                boolean permGranted = Build.VERSION.SDK_INT < 33
                        || activity.checkSelfPermission("android.permission.POST_NOTIFICATIONS") == PackageManager.PERMISSION_GRANTED;
                res.put("enabled", enabled);
                res.put("permissionGranted", permGranted);
                resolve(reqId, res);
                break;
            }
            case "show": {
                int id = args.optInt("id", NEXT_NOTIF_ID.getAndIncrement());
                postNotification(activity, nm, id, args, -1, 0, false);
                JSONObject res = new JSONObject();
                res.put("id", id);
                res.put("shown", nm.areNotificationsEnabled());
                resolve(reqId, res);
                break;
            }
            case "schedule": {
                long delayMs = Math.max(100L, args.optLong("delayMs", 3000L));
                int id = args.optInt("id", NEXT_NOTIF_ID.getAndIncrement());
                JSONObject copy = new JSONObject(args.toString());
                SCHEDULER.schedule(() -> {
                    Activity cur = GpuiActivity.currentActivity();
                    Context ctx = cur != null ? cur : activity.getApplicationContext();
                    NotificationManager mgr = (NotificationManager) ctx.getSystemService(Context.NOTIFICATION_SERVICE);
                    if (mgr != null) {
                        postNotification(ctx, mgr, id, copy, -1, 0, false);
                        try {
                            JSONObject ev = new JSONObject();
                            ev.put("id", id);
                            ev.put("title", copy.optString("title", ""));
                            emitEvent("notificationDelivered", ev);
                        } catch (Throwable ignored) {}
                    }
                }, delayMs, TimeUnit.MILLISECONDS);
                JSONObject res = new JSONObject();
                res.put("id", id);
                res.put("delayMs", delayMs);
                resolve(reqId, res);
                break;
            }
            case "showProgress": {
                int id = args.optInt("id", 2001);
                int progress = args.optInt("progress", 0);
                int max = args.optInt("max", 100);
                boolean indeterminate = args.optBoolean("indeterminate", false);
                postNotification(activity, nm, id, args, progress, max, indeterminate);
                JSONObject res = new JSONObject();
                res.put("id", id);
                res.put("progress", progress);
                resolve(reqId, res);
                break;
            }
            case "cancel": {
                int id = args.optInt("id", -1);
                if (id >= 0) nm.cancel(id);
                resolve(reqId, new JSONObject().put("cancelled", true));
                break;
            }
            case "cancelAll": {
                nm.cancelAll();
                resolve(reqId, new JSONObject().put("cancelledAll", true));
                break;
            }
            default:
                reject(reqId, "Unsupported notifications method: " + method);
        }
    }

    private static void postNotification(
            Context ctx,
            NotificationManager nm,
            int id,
            JSONObject args,
            int progress,
            int max,
            boolean indeterminate
    ) {
        String channelId = args.optString("channelId", DEFAULT_CHANNEL_ID);
        String channelName = args.optString("channelName", DEFAULT_CHANNEL_NAME);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationChannel existing = nm.getNotificationChannel(channelId);
            if (existing == null) {
                NotificationChannel channel = new NotificationChannel(
                        channelId,
                        channelName,
                        NotificationManager.IMPORTANCE_HIGH
                );
                channel.setDescription("GPUIX High-Priority Notifications");
                channel.enableVibration(true);
                channel.setVibrationPattern(new long[]{0, 180, 90, 180});
                nm.createNotificationChannel(channel);
            }
        }

        Intent launch = new Intent(ctx, GpuiActivity.class);
        launch.addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        String deepLink = args.optString("deepLink", "");
        if (!deepLink.isEmpty()) {
            launch.putExtra("gpuix_deeplink", deepLink);
            launch.setData(Uri.parse(deepLink));
        }
        int flags = PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE;
        PendingIntent pi = PendingIntent.getActivity(ctx, id, launch, flags);

        Notification.Builder builder = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
                ? new Notification.Builder(ctx, channelId)
                : new Notification.Builder(ctx);
        builder.setSmallIcon(ctx.getApplicationInfo().icon)
                .setContentTitle(args.optString("title", "GPUIX 通知"))
                .setContentText(args.optString("body", ""))
                .setAutoCancel(!args.optBoolean("ongoing", false))
                .setOngoing(args.optBoolean("ongoing", false))
                .setContentIntent(pi);

        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
            builder.setPriority(Notification.PRIORITY_HIGH);
            if (args.optBoolean("sound", true)) {
                builder.setDefaults(Notification.DEFAULT_SOUND | Notification.DEFAULT_VIBRATE);
            }
        }
        if (progress >= 0) {
            builder.setProgress(max, progress, indeterminate);
            builder.setOnlyAlertOnce(true);
        }
        nm.notify(id, builder.build());
    }

    // ── 2. Audio (System tones, volume, Text-To-Speech) ──────────────────────

    private static void handleAudio(Activity activity, long reqId, String method, JSONObject args) throws Exception {
        AudioManager am = (AudioManager) activity.getSystemService(Context.AUDIO_SERVICE);
        switch (method) {
            case "playTone": {
                String type = args.optString("type", "notification");
                switch (type) {
                    case "notification":
                    case "alarm":
                    case "ringtone": {
                        int uriType = "alarm".equals(type)
                                ? RingtoneManager.TYPE_ALARM
                                : "ringtone".equals(type)
                                        ? RingtoneManager.TYPE_RINGTONE
                                        : RingtoneManager.TYPE_NOTIFICATION;
                        Uri uri = RingtoneManager.getDefaultUri(uriType);
                        if (uri == null) uri = RingtoneManager.getDefaultUri(RingtoneManager.TYPE_NOTIFICATION);
                        Ringtone ringtone = uri != null ? RingtoneManager.getRingtone(activity, uri) : null;
                        if (ringtone != null) {
                            ringtone.play();
                            SCHEDULER.schedule(() -> {
                                try { if (ringtone.isPlaying()) ringtone.stop(); } catch (Throwable ignored) {}
                            }, 1600, TimeUnit.MILLISECONDS);
                        }
                        break;
                    }
                    case "click": {
                        if (am != null) am.playSoundEffect(AudioManager.FX_KEY_CLICK);
                        break;
                    }
                    case "success": {
                        playToneGen(ToneGenerator.TONE_PROP_ACK, 260);
                        break;
                    }
                    case "error": {
                        playToneGen(ToneGenerator.TONE_PROP_NACK, 320);
                        break;
                    }
                    case "dtmf": {
                        playToneGen(ToneGenerator.TONE_DTMF_9, 220);
                        break;
                    }
                    default: {
                        playToneGen(ToneGenerator.TONE_PROP_BEEP, 220);
                        break;
                    }
                }
                resolve(reqId, new JSONObject().put("played", type));
                break;
            }
            case "getVolume": {
                if (am == null) {
                    reject(reqId, "AudioManager unavailable");
                    return;
                }
                int stream = parseAudioStream(args.optString("stream", "music"));
                int cur = am.getStreamVolume(stream);
                int max = Math.max(1, am.getStreamMaxVolume(stream));
                JSONObject res = new JSONObject();
                res.put("volume", (double) cur / max);
                res.put("current", cur);
                res.put("max", max);
                resolve(reqId, res);
                break;
            }
            case "setVolume": {
                if (am == null) {
                    reject(reqId, "AudioManager unavailable");
                    return;
                }
                int stream = parseAudioStream(args.optString("stream", "music"));
                double ratio = Math.max(0.0, Math.min(1.0, args.optDouble("volume", 0.5)));
                int max = Math.max(1, am.getStreamMaxVolume(stream));
                int target = (int) Math.round(ratio * max);
                am.setStreamVolume(stream, target, 0);
                resolve(reqId, new JSONObject().put("volume", (double) target / max).put("current", target).put("max", max));
                break;
            }
            case "speak": {
                String text = args.optString("text", "");
                float rate = (float) args.optDouble("rate", 1.0);
                float pitch = (float) args.optDouble("pitch", 1.0);
                if (text.isEmpty()) {
                    reject(reqId, "TTS text cannot be empty");
                    return;
                }
                speakWithTts(activity, text, rate, pitch, reqId);
                break;
            }
            case "stopSpeak": {
                synchronized (TTS_LOCK) {
                    if (sTts != null) sTts.stop();
                }
                resolve(reqId, new JSONObject().put("stopped", true));
                break;
            }
            default:
                reject(reqId, "Unsupported audio method: " + method);
        }
    }

    private static void playToneGen(int tone, int durationMs) {
        ToneGenerator tg = new ToneGenerator(AudioManager.STREAM_NOTIFICATION, 85);
        tg.startTone(tone, durationMs);
        SCHEDULER.schedule(tg::release, durationMs + 150L, TimeUnit.MILLISECONDS);
    }

    private static int parseAudioStream(String stream) {
        switch (stream) {
            case "notification": return AudioManager.STREAM_NOTIFICATION;
            case "alarm": return AudioManager.STREAM_ALARM;
            case "ring": return AudioManager.STREAM_RING;
            default: return AudioManager.STREAM_MUSIC;
        }
    }

    private static void speakWithTts(Activity activity, String text, float rate, float pitch, long reqId) {
        synchronized (TTS_LOCK) {
            if (sTts != null && sTtsReady) {
                sTts.setSpeechRate(rate);
                sTts.setPitch(pitch);
                sTts.speak(text, TextToSpeech.QUEUE_FLUSH, null, "gpuix_" + reqId);
                try {
                    resolve(reqId, new JSONObject().put("speaking", true).put("text", text));
                } catch (Exception ignored) {}
                return;
            }
            sTts = new TextToSpeech(activity.getApplicationContext(), status -> {
                synchronized (TTS_LOCK) {
                    if (status == TextToSpeech.SUCCESS && sTts != null) {
                        sTtsReady = true;
                        int res = sTts.setLanguage(Locale.CHINA);
                        if (res == TextToSpeech.LANG_MISSING_DATA || res == TextToSpeech.LANG_NOT_SUPPORTED) {
                            sTts.setLanguage(Locale.getDefault());
                        }
                        sTts.setSpeechRate(rate);
                        sTts.setPitch(pitch);
                        sTts.speak(text, TextToSpeech.QUEUE_FLUSH, null, "gpuix_" + reqId);
                        try {
                            resolve(reqId, new JSONObject().put("speaking", true).put("text", text));
                        } catch (Exception ignored) {}
                    } else {
                        sTtsReady = false;
                        reject(reqId, "TextToSpeech init failed (status=" + status + ")");
                    }
                }
            });
        }
    }

    // ── 3. Haptics & Vibration ───────────────────────────────────────────────

    private static void handleHaptics(Activity activity, long reqId, String method, JSONObject args) throws Exception {
        Vibrator vibrator = (Vibrator) activity.getSystemService(Context.VIBRATOR_SERVICE);
        if ("impact".equals(method)) {
            String style = args.optString("style", "medium");
            int constant;
            long ms;
            int amp;
            switch (style) {
                case "light":
                    constant = HapticFeedbackConstants.CLOCK_TICK;
                    ms = 14;
                    amp = 80;
                    break;
                case "heavy":
                    constant = HapticFeedbackConstants.LONG_PRESS;
                    ms = 35;
                    amp = 255;
                    break;
                case "selection":
                    constant = HapticFeedbackConstants.KEYBOARD_TAP;
                    ms = 10;
                    amp = 60;
                    break;
                case "success":
                case "warning":
                case "error":
                    constant = HapticFeedbackConstants.VIRTUAL_KEY;
                    ms = 24;
                    amp = 180;
                    break;
                default:
                    constant = HapticFeedbackConstants.VIRTUAL_KEY;
                    ms = 20;
                    amp = 140;
                    break;
            }
            MAIN_HANDLER.post(() -> {
                try {
                    activity.getWindow().getDecorView().performHapticFeedback(constant);
                } catch (Throwable ignored) {}
            });
            if (vibrator != null && vibrator.hasVibrator()) {
                vibrator.vibrate(VibrationEffect.createOneShot(ms, amp));
            }
            resolve(reqId, new JSONObject().put("style", style));
        } else if ("vibrate".equals(method)) {
            if (vibrator == null || !vibrator.hasVibrator()) {
                reject(reqId, "No vibrator hardware");
                return;
            }
            JSONArray patternArr = args.optJSONArray("pattern");
            if (patternArr != null && patternArr.length() > 0) {
                long[] pattern = new long[patternArr.length()];
                for (int i = 0; i < patternArr.length(); i++) {
                    pattern[i] = Math.max(0L, patternArr.optLong(i, 50L));
                }
                vibrator.vibrate(VibrationEffect.createWaveform(pattern, -1));
            } else {
                long duration = Math.max(10L, args.optLong("durationMs", 120L));
                vibrator.vibrate(VibrationEffect.createOneShot(duration, VibrationEffect.DEFAULT_AMPLITUDE));
            }
            resolve(reqId, new JSONObject().put("vibrated", true));
        } else {
            reject(reqId, "Unsupported haptics method: " + method);
        }
    }

    // ── 4. Biometrics / Lockscreen Authentication ────────────────────────────

    private static void handleBiometrics(Activity activity, long reqId, String method, JSONObject args) throws Exception {
        if ("canAuthenticate".equals(method)) {
            boolean available = false;
            String detail = "unavailable";
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                detail = Api29BiometricHelper.check(activity);
                available = "available".equals(detail);
            } else {
                KeyguardManager km = (KeyguardManager) activity.getSystemService(Context.KEYGUARD_SERVICE);
                available = km != null && km.isDeviceSecure();
                detail = available ? "device_credential" : "none_enrolled";
            }
            resolve(reqId, new JSONObject().put("available", available).put("status", detail));
        } else if ("authenticate".equals(method)) {
            String title = args.optString("title", "身份验证");
            String subtitle = args.optString("subtitle", "验证指纹、面容或锁屏密码");
            String description = args.optString("description", "");
            String cancelText = args.optString("cancelText", "取消");
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
                MAIN_HANDLER.post(() -> Api28BiometricHelper.authenticate(
                        activity, title, subtitle, description, cancelText, reqId));
            } else {
                KeyguardManager km = (KeyguardManager) activity.getSystemService(Context.KEYGUARD_SERVICE);
                if (km == null) {
                    reject(reqId, "KeyguardManager unavailable");
                    return;
                }
                @SuppressWarnings("deprecation")
                Intent intent = km.createConfirmDeviceCredentialIntent(title, subtitle);
                if (intent == null) {
                    reject(reqId, "Device lock screen credential is not configured");
                    return;
                }
                startActivityForResult(activity, intent, (resultCode, data) -> {
                    try {
                        resolve(reqId, new JSONObject().put("authenticated", resultCode == Activity.RESULT_OK));
                    } catch (Exception ignored) {}
                });
            }
        } else {
            reject(reqId, "Unsupported biometrics method: " + method);
        }
    }

    private static final class Api29BiometricHelper {
        static String check(Activity activity) {
            android.hardware.biometrics.BiometricManager bm =
                    activity.getSystemService(android.hardware.biometrics.BiometricManager.class);
            if (bm == null) return "unavailable";
            int status;
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                status = bm.canAuthenticate(
                        android.hardware.biometrics.BiometricManager.Authenticators.BIOMETRIC_WEAK
                                | android.hardware.biometrics.BiometricManager.Authenticators.DEVICE_CREDENTIAL);
            } else {
                @SuppressWarnings("deprecation")
                int legacy = bm.canAuthenticate();
                status = legacy;
            }
            switch (status) {
                case android.hardware.biometrics.BiometricManager.BIOMETRIC_SUCCESS:
                    return "available";
                case android.hardware.biometrics.BiometricManager.BIOMETRIC_ERROR_NONE_ENROLLED:
                    return "none_enrolled";
                case android.hardware.biometrics.BiometricManager.BIOMETRIC_ERROR_NO_HARDWARE:
                    return "no_hardware";
                default:
                    return "unavailable_" + status;
            }
        }
    }

    private static final class Api28BiometricHelper {
        static void authenticate(
                Activity activity, String title, String subtitle,
                String description, String cancelText, long reqId
        ) {
            try {
                android.hardware.biometrics.BiometricPrompt.Builder builder =
                        new android.hardware.biometrics.BiometricPrompt.Builder(activity)
                                .setTitle(title)
                                .setSubtitle(subtitle);
                if (!description.isEmpty()) builder.setDescription(description);
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                    builder.setAllowedAuthenticators(
                            android.hardware.biometrics.BiometricManager.Authenticators.BIOMETRIC_WEAK
                                    | android.hardware.biometrics.BiometricManager.Authenticators.DEVICE_CREDENTIAL);
                } else {
                    builder.setNegativeButton(cancelText, activity.getMainExecutor(), (d, w) -> {
                        try {
                            resolve(reqId, new JSONObject().put("authenticated", false).put("reason", "cancelled"));
                        } catch (Exception ignored) {}
                    });
                }
                android.hardware.biometrics.BiometricPrompt prompt = builder.build();
                CancellationSignal signal = new CancellationSignal();
                prompt.authenticate(signal, activity.getMainExecutor(),
                        new android.hardware.biometrics.BiometricPrompt.AuthenticationCallback() {
                            @Override
                            public void onAuthenticationSucceeded(android.hardware.biometrics.BiometricPrompt.AuthenticationResult result) {
                                try {
                                    resolve(reqId, new JSONObject().put("authenticated", true));
                                } catch (Exception ignored) {}
                            }

                            @Override
                            public void onAuthenticationError(int errorCode, CharSequence errString) {
                                try {
                                    resolve(reqId, new JSONObject()
                                            .put("authenticated", false)
                                            .put("errorCode", errorCode)
                                            .put("reason", errString != null ? errString.toString() : "error"));
                                } catch (Exception ignored) {}
                            }

                            @Override
                            public void onAuthenticationFailed() {
                                // User can retry until error/cancel.
                            }
                        });
            } catch (Throwable t) {
                reject(reqId, t.getMessage() != null ? t.getMessage() : "BiometricPrompt failed");
            }
        }
    }

    // ── 5. Torch / Flashlight ────────────────────────────────────────────────

    private static void handleTorch(Activity activity, long reqId, String method, JSONObject args) throws Exception {
        CameraManager cm = (CameraManager) activity.getSystemService(Context.CAMERA_SERVICE);
        if (cm == null) {
            reject(reqId, "CameraManager unavailable");
            return;
        }
        String flashCamId = null;
        for (String id : cm.getCameraIdList()) {
            CameraCharacteristics chars = cm.getCameraCharacteristics(id);
            Boolean hasFlash = chars.get(CameraCharacteristics.FLASH_INFO_AVAILABLE);
            Integer facing = chars.get(CameraCharacteristics.LENS_FACING);
            if (Boolean.TRUE.equals(hasFlash) && (facing == null || facing == CameraCharacteristics.LENS_FACING_BACK)) {
                flashCamId = id;
                break;
            }
        }
        if ("isAvailable".equals(method)) {
            resolve(reqId, new JSONObject().put("available", flashCamId != null).put("enabled", sTorchEnabled));
        } else if ("setEnabled".equals(method)) {
            if (flashCamId == null) {
                reject(reqId, "No rear camera flash available");
                return;
            }
            boolean enabled = args.optBoolean("enabled", false);
            cm.setTorchMode(flashCamId, enabled);
            sTorchEnabled = enabled;
            resolve(reqId, new JSONObject().put("enabled", enabled));
        } else {
            reject(reqId, "Unsupported torch method: " + method);
        }
    }

    // ── 6. Hardware Sensors ──────────────────────────────────────────────────

    private static int parseSensorType(String type) {
        switch (type != null ? type : "accelerometer") {
            case "gyroscope": return Sensor.TYPE_GYROSCOPE;
            case "light": return Sensor.TYPE_LIGHT;
            case "magnetic": return Sensor.TYPE_MAGNETIC_FIELD;
            case "proximity": return Sensor.TYPE_PROXIMITY;
            default: return Sensor.TYPE_ACCELEROMETER;
        }
    }

    private static void handleSensors(Activity activity, long reqId, String method, JSONObject args) throws Exception {
        SensorManager sm = (SensorManager) activity.getSystemService(Context.SENSOR_SERVICE);
        if (sm == null) {
            reject(reqId, "SensorManager unavailable");
            return;
        }
        String typeName = args.optString("type", "accelerometer");
        int sensorType = parseSensorType(typeName);
        Sensor sensor = sm.getDefaultSensor(sensorType);
        if ("sample".equals(method)) {
            if (sensor == null) {
                reject(reqId, "Sensor not available: " + typeName);
                return;
            }
            final AtomicBoolean done = new AtomicBoolean(false);
            final SensorEventListener[] holder = new SensorEventListener[1];
            SensorEventListener listener = new SensorEventListener() {
                @Override
                public void onSensorChanged(SensorEvent event) {
                    if (!done.compareAndSet(false, true)) return;
                    sm.unregisterListener(this);
                    try {
                        JSONArray vals = new JSONArray();
                        for (float v : event.values) vals.put(Math.round(v * 1000.0) / 1000.0);
                        JSONObject res = new JSONObject();
                        res.put("type", typeName);
                        res.put("values", vals);
                        res.put("accuracy", event.accuracy);
                        res.put("timestamp", event.timestamp);
                        resolve(reqId, res);
                    } catch (Throwable t) {
                        reject(reqId, t.getMessage());
                    }
                }

                @Override
                public void onAccuracyChanged(Sensor s, int accuracy) {}
            };
            holder[0] = listener;
            sm.registerListener(listener, sensor, SensorManager.SENSOR_DELAY_UI, MAIN_HANDLER);
            SCHEDULER.schedule(() -> {
                if (done.compareAndSet(false, true)) {
                    sm.unregisterListener(holder[0]);
                    reject(reqId, "Sensor read timeout: " + typeName);
                }
            }, 1500, TimeUnit.MILLISECONDS);
        } else if ("start".equals(method)) {
            if (sensor == null) {
                reject(reqId, "Sensor not available: " + typeName);
                return;
            }
            SensorEventListener prev = ACTIVE_SENSORS.remove(typeName);
            if (prev != null) sm.unregisterListener(prev);
            final long minIntervalMs = Math.max(80L, args.optLong("intervalMs", 100L));
            final long[] lastEmit = new long[]{0L};
            SensorEventListener listener = new SensorEventListener() {
                @Override
                public void onSensorChanged(SensorEvent event) {
                    long now = System.currentTimeMillis();
                    if (now - lastEmit[0] < minIntervalMs) return;
                    lastEmit[0] = now;
                    try {
                        JSONArray vals = new JSONArray();
                        for (float v : event.values) vals.put(Math.round(v * 1000.0) / 1000.0);
                        JSONObject payload = new JSONObject();
                        payload.put("type", typeName);
                        payload.put("values", vals);
                        payload.put("timestamp", now);
                        emitEvent("sensor", payload);
                    } catch (Throwable ignored) {}
                }

                @Override
                public void onAccuracyChanged(Sensor s, int accuracy) {}
            };
            ACTIVE_SENSORS.put(typeName, listener);
            sm.registerListener(listener, sensor, SensorManager.SENSOR_DELAY_UI, MAIN_HANDLER);
            resolve(reqId, new JSONObject().put("started", typeName));
        } else if ("stop".equals(method)) {
            SensorEventListener prev = ACTIVE_SENSORS.remove(typeName);
            if (prev != null) sm.unregisterListener(prev);
            resolve(reqId, new JSONObject().put("stopped", typeName));
        } else {
            reject(reqId, "Unsupported sensors method: " + method);
        }
    }

    // ── 7. Device & Battery Info ─────────────────────────────────────────────

    private static void handleDevice(Activity activity, long reqId, String method) throws Exception {
        if ("getInfo".equals(method)) {
            JSONObject res = new JSONObject();
            res.put("model", Build.MODEL);
            res.put("manufacturer", Build.MANUFACTURER);
            res.put("brand", Build.BRAND);
            res.put("device", Build.DEVICE);
            res.put("sdkInt", Build.VERSION.SDK_INT);
            res.put("release", Build.VERSION.RELEASE);
            res.put("abis", new JSONArray(Build.SUPPORTED_ABIS));
            res.put("packageName", activity.getPackageName());
            PackageInfo pi = activity.getPackageManager().getPackageInfo(activity.getPackageName(), 0);
            res.put("versionName", pi.versionName != null ? pi.versionName : "");
            res.put("versionCode", Build.VERSION.SDK_INT >= Build.VERSION_CODES.P ? pi.getLongVersionCode() : pi.versionCode);
            res.put("locale", Locale.getDefault().toLanguageTag());
            String fp = Build.FINGERPRINT != null ? Build.FINGERPRINT : "";
            res.put("isPhysicalDevice", !fp.contains("generic") && !fp.contains("emulator"));
            DisplayMetrics dm = activity.getResources().getDisplayMetrics();
            res.put("screenWidthPx", dm.widthPixels);
            res.put("screenHeightPx", dm.heightPixels);
            res.put("density", dm.density);
            ConnectivityManager cm = (ConnectivityManager) activity.getSystemService(Context.CONNECTIVITY_SERVICE);
            String netType = "none";
            boolean metered = false;
            if (cm != null) {
                Network activeNet = cm.getActiveNetwork();
                NetworkCapabilities caps = activeNet != null ? cm.getNetworkCapabilities(activeNet) : null;
                if (caps != null) {
                    if (caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI)) netType = "wifi";
                    else if (caps.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR)) netType = "cellular";
                    else if (caps.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET)) netType = "ethernet";
                    else netType = "other";
                }
                metered = cm.isActiveNetworkMetered();
            }
            res.put("networkType", netType);
            res.put("isMetered", metered);
            resolve(reqId, res);
        } else if ("getBattery".equals(method)) {
            Intent bat = activity.registerReceiver(null, new IntentFilter(Intent.ACTION_BATTERY_CHANGED));
            JSONObject res = new JSONObject();
            if (bat != null) {
                int level = bat.getIntExtra(BatteryManager.EXTRA_LEVEL, -1);
                int scale = Math.max(1, bat.getIntExtra(BatteryManager.EXTRA_SCALE, 100));
                int status = bat.getIntExtra(BatteryManager.EXTRA_STATUS, -1);
                boolean charging = status == BatteryManager.BATTERY_STATUS_CHARGING
                        || status == BatteryManager.BATTERY_STATUS_FULL;
                int tempTenths = bat.getIntExtra(BatteryManager.EXTRA_TEMPERATURE, 0);
                int voltage = bat.getIntExtra(BatteryManager.EXTRA_VOLTAGE, 0);
                res.put("level", level >= 0 ? (level * 100) / scale : -1);
                res.put("charging", charging);
                res.put("temperatureC", tempTenths / 10.0);
                res.put("voltageMv", voltage);
            }
            resolve(reqId, res);
        } else {
            reject(reqId, "Unsupported device method: " + method);
        }
    }

    // ── 8. System UI (Toast, AlertDialog, Brightness, KeepScreenOn) ──────────

    private static void handleSystem(Activity activity, long reqId, String method, JSONObject args) throws Exception {
        switch (method) {
            case "toast": {
                String msg = args.optString("message", "");
                int duration = args.optBoolean("long", false) ? Toast.LENGTH_LONG : Toast.LENGTH_SHORT;
                MAIN_HANDLER.post(() -> Toast.makeText(activity, msg, duration).show());
                resolve(reqId, new JSONObject().put("shown", true));
                break;
            }
            case "alert": {
                String title = args.optString("title", "提示");
                String message = args.optString("message", "");
                String confirmText = args.optString("confirmText", "确定");
                String cancelText = args.optString("cancelText", "");
                MAIN_HANDLER.post(() -> {
                    AlertDialog.Builder builder = new AlertDialog.Builder(activity)
                            .setTitle(title)
                            .setMessage(message)
                            .setPositiveButton(confirmText, (d, w) -> {
                                try { resolve(reqId, new JSONObject().put("confirmed", true)); } catch (Exception ignored) {}
                            });
                    if (!cancelText.isEmpty()) {
                        builder.setNegativeButton(cancelText, (d, w) -> {
                            try { resolve(reqId, new JSONObject().put("confirmed", false)); } catch (Exception ignored) {}
                        });
                    }
                    builder.setOnCancelListener(d -> {
                        try { resolve(reqId, new JSONObject().put("confirmed", false)); } catch (Exception ignored) {}
                    });
                    builder.show();
                });
                break;
            }
            case "setKeepScreenOn": {
                boolean enabled = args.optBoolean("enabled", false);
                MAIN_HANDLER.post(() -> {
                    if (enabled) activity.getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
                    else activity.getWindow().clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
                });
                resolve(reqId, new JSONObject().put("keepScreenOn", enabled));
                break;
            }
            case "setBrightness": {
                float value = (float) args.optDouble("value", -1.0);
                MAIN_HANDLER.post(() -> {
                    WindowManager.LayoutParams lp = activity.getWindow().getAttributes();
                    lp.screenBrightness = value < 0f ? WindowManager.LayoutParams.BRIGHTNESS_OVERRIDE_NONE
                            : Math.max(0.02f, Math.min(1.0f, value));
                    activity.getWindow().setAttributes(lp);
                });
                resolve(reqId, new JSONObject().put("brightness", value));
                break;
            }
            case "setStatusBar": {
                MAIN_HANDLER.post(() -> {
                    if (args.has("color") && !args.isNull("color")) {
                        activity.getWindow().setStatusBarColor(args.optInt("color"));
                    }
                    if (args.has("darkIcons")) {
                        boolean darkIcons = args.optBoolean("darkIcons", false);
                        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                            android.view.WindowInsetsController ctl = activity.getWindow().getInsetsController();
                            if (ctl != null) {
                                int mask = android.view.WindowInsetsController.APPEARANCE_LIGHT_STATUS_BARS;
                                ctl.setSystemBarsAppearance(darkIcons ? mask : 0, mask);
                            }
                        }
                    }
                });
                resolve(reqId, new JSONObject().put("updated", true));
                break;
            }
            case "openAppSettings": {
                Intent intent = new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS,
                        Uri.fromParts("package", activity.getPackageName(), null));
                activity.startActivity(intent);
                resolve(reqId, new JSONObject().put("opened", true));
                break;
            }
            case "moveToBack": {
                GpuiActivity.moveAppToBack();
                resolve(reqId, new JSONObject().put("ok", true));
                break;
            }
            default:
                reject(reqId, "Unsupported system method: " + method);
        }
    }

    // ── 9. Clipboard ─────────────────────────────────────────────────────────

    private static void handleClipboard(long reqId, String method, JSONObject args) throws Exception {
        if ("read".equals(method)) {
            String text = GpuiActivity.getClipboardText();
            resolve(reqId, new JSONObject().put("text", text != null ? text : JSONObject.NULL));
        } else if ("write".equals(method)) {
            boolean ok = GpuiActivity.setClipboardText(args.optString("text", ""));
            resolve(reqId, new JSONObject().put("written", ok));
        } else {
            reject(reqId, "Unsupported clipboard method: " + method);
        }
    }

    // ── 10. Launcher / Share / DeepLink ──────────────────────────────────────

    private static void handleLauncher(Activity activity, long reqId, String method, JSONObject args) throws Exception {
        switch (method) {
            case "openUrl": {
                String url = args.optString("url", "");
                Intent intent = new Intent(Intent.ACTION_VIEW, Uri.parse(url));
                intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                activity.startActivity(intent);
                resolve(reqId, new JSONObject().put("opened", true));
                break;
            }
            case "canOpenUrl": {
                String url = args.optString("url", "");
                Intent intent = new Intent(Intent.ACTION_VIEW, Uri.parse(url));
                boolean can = intent.resolveActivity(activity.getPackageManager()) != null;
                resolve(reqId, new JSONObject().put("canOpen", can));
                break;
            }
            case "getInitialUrl": {
                resolve(reqId, new JSONObject().put("url", sInitialDeepLink != null ? sInitialDeepLink : JSONObject.NULL));
                break;
            }
            case "share": {
                String title = args.optString("title", "分享");
                String text = args.optString("text", "");
                String url = args.optString("url", "");
                String combined = !url.isEmpty() ? (text.isEmpty() ? url : text + "\n" + url) : text;
                Intent send = new Intent(Intent.ACTION_SEND);
                send.setType("text/plain");
                if (!title.isEmpty()) send.putExtra(Intent.EXTRA_SUBJECT, title);
                send.putExtra(Intent.EXTRA_TEXT, combined);
                Intent chooser = Intent.createChooser(send, title);
                activity.startActivity(chooser);
                resolve(reqId, new JSONObject().put("shared", true));
                break;
            }
            default:
                reject(reqId, "Unsupported launcher method: " + method);
        }
    }

    // ── 11. Runtime Permissions ──────────────────────────────────────────────

    private static void handlePermissions(Activity activity, long reqId, String method, JSONObject args) throws Exception {
        if ("check".equals(method)) {
            String perm = args.optString("permission", "");
            boolean granted = activity.checkSelfPermission(perm) == PackageManager.PERMISSION_GRANTED;
            resolve(reqId, new JSONObject().put("granted", granted));
        } else if ("request".equals(method)) {
            JSONArray arr = args.optJSONArray("permissions");
            List<String> list = new ArrayList<>();
            if (arr != null) {
                for (int i = 0; i < arr.length(); i++) {
                    String p = arr.optString(i, "");
                    if (!p.isEmpty()) list.add(p);
                }
            }
            if (list.isEmpty()) {
                resolve(reqId, new JSONObject().put("granted", true).put("results", new JSONObject()));
                return;
            }
            String[] perms = list.toArray(new String[0]);
            int code = NEXT_REQ_CODE.getAndIncrement();
            PERM_WAITERS.put(code, (outPerms, grantResults) -> {
                try {
                    boolean allGranted = grantResults.length > 0;
                    JSONObject results = new JSONObject();
                    for (int i = 0; i < outPerms.length; i++) {
                        boolean g = i < grantResults.length && grantResults[i] == PackageManager.PERMISSION_GRANTED;
                        if (!g) allGranted = false;
                        results.put(outPerms[i], g ? "granted" : "denied");
                    }
                    resolve(reqId, new JSONObject().put("granted", allGranted).put("results", results));
                } catch (Exception e) {
                    reject(reqId, e.getMessage());
                }
            });
            MAIN_HANDLER.post(() -> activity.requestPermissions(perms, code));
        } else {
            reject(reqId, "Unsupported permissions method: " + method);
        }
    }

    public static void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
        PermissionResultConsumer consumer = PERM_WAITERS.remove(requestCode);
        if (consumer != null) {
            consumer.onResult(permissions, grantResults);
        }
    }

    // ── 12. KV Storage (JS async + Rust/JNI sync) ────────────────────────────

    private static SharedPreferences kvPrefs() {
        Activity activity = GpuiActivity.currentActivity();
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

    private static void handleStorage(long reqId, String method, JSONObject args) throws Exception {
        String key = args.optString("key", "");
        switch (method) {
            case "get": {
                String v = kvGet(key);
                resolve(reqId, new JSONObject().put("value", v != null ? v : JSONObject.NULL));
                break;
            }
            case "set": {
                resolve(reqId, new JSONObject().put("ok", kvSet(key, args.optString("value", ""))));
                break;
            }
            case "remove": {
                resolve(reqId, new JSONObject().put("ok", kvRemove(key)));
                break;
            }
            case "clear": {
                resolve(reqId, new JSONObject().put("ok", kvClear()));
                break;
            }
            case "keys": {
                resolve(reqId, new JSONObject().put("keys", new JSONArray(kvKeysJson())));
                break;
            }
            default:
                reject(reqId, "Unsupported storage method: " + method);
        }
    }

    // ── 13. Secure Storage (Android Keystore AES/GCM/NoPadding) ──────────────

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
        Activity activity = GpuiActivity.currentActivity();
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
        Activity activity = GpuiActivity.currentActivity();
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
        Activity activity = GpuiActivity.currentActivity();
        if (activity == null) return false;
        SharedPreferences prefs = activity.getApplicationContext().getSharedPreferences(SECURE_PREFS, Context.MODE_PRIVATE);
        return prefs.edit().remove(secureKey(service, account)).commit();
    }

    private static void handleSecureStorage(long reqId, String method, JSONObject args) throws Exception {
        String service = args.optString("service", "gpuix");
        String account = args.optString("account", args.optString("key", "default"));
        switch (method) {
            case "write": {
                String val = args.optString("value", "");
                String b64 = Base64.encodeToString(val.getBytes(StandardCharsets.UTF_8), Base64.NO_WRAP);
                resolve(reqId, new JSONObject().put("ok", secureWrite(service, account, b64)));
                break;
            }
            case "read": {
                String b64 = secureRead(service, account);
                if (b64 == null) {
                    resolve(reqId, new JSONObject().put("value", JSONObject.NULL));
                } else {
                    String plain = new String(Base64.decode(b64, Base64.NO_WRAP), StandardCharsets.UTF_8);
                    resolve(reqId, new JSONObject().put("value", plain));
                }
                break;
            }
            case "delete": {
                resolve(reqId, new JSONObject().put("ok", secureDelete(service, account)));
                break;
            }
            default:
                reject(reqId, "Unsupported secureStorage method: " + method);
        }
    }

    // ── 14. Media (Pick Image / Pick File / Camera) & Location ───────────────

    private static void startActivityForResult(Activity activity, Intent intent, ActivityResultConsumer consumer) {
        int code = NEXT_REQ_CODE.getAndIncrement();
        ACT_WAITERS.put(code, consumer);
        MAIN_HANDLER.post(() -> {
            try {
                activity.startActivityForResult(intent, code);
            } catch (Throwable t) {
                ACT_WAITERS.remove(code);
                consumer.onResult(Activity.RESULT_CANCELED, null);
            }
        });
    }

    public static void onActivityResult(int requestCode, int resultCode, Intent data) {
        ActivityResultConsumer consumer = ACT_WAITERS.remove(requestCode);
        if (consumer != null) {
            consumer.onResult(resultCode, data);
        }
    }

    private static void handleMedia(Activity activity, long reqId, String method, JSONObject args) throws Exception {
        switch (method) {
            case "pickImage": {
                Intent intent;
                if (Build.VERSION.SDK_INT >= 33) {
                    intent = new Intent("android.provider.action.PICK_IMAGES");
                    intent.setType("image/*");
                } else {
                    intent = new Intent(Intent.ACTION_OPEN_DOCUMENT);
                    intent.addCategory(Intent.CATEGORY_OPENABLE);
                    intent.setType("image/*");
                }
                startActivityForResult(activity, intent, (resultCode, data) ->
                        WORKER.execute(() -> handlePickedUriResult(activity, reqId, resultCode, data)));
                break;
            }
            case "pickFile": {
                Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT);
                intent.addCategory(Intent.CATEGORY_OPENABLE);
                intent.setType(args.optString("mimeType", "*/*"));
                startActivityForResult(activity, intent, (resultCode, data) ->
                        WORKER.execute(() -> handlePickedUriResult(activity, reqId, resultCode, data)));
                break;
            }
            case "takePhoto": {
                if (activity.checkSelfPermission("android.permission.CAMERA") != PackageManager.PERMISSION_GRANTED) {
                    int permCode = NEXT_REQ_CODE.getAndIncrement();
                    PERM_WAITERS.put(permCode, (p, g) -> {
                        if (g.length > 0 && g[0] == PackageManager.PERMISSION_GRANTED) {
                            launchCameraCapture(activity, reqId);
                        } else {
                            reject(reqId, "Camera permission denied");
                        }
                    });
                    MAIN_HANDLER.post(() -> activity.requestPermissions(new String[]{"android.permission.CAMERA"}, permCode));
                } else {
                    launchCameraCapture(activity, reqId);
                }
                break;
            }
            default:
                reject(reqId, "Unsupported media method: " + method);
        }
    }

    private static void launchCameraCapture(Activity activity, long reqId) {
        Intent intent = new Intent(MediaStore.ACTION_IMAGE_CAPTURE);
        startActivityForResult(activity, intent, (resultCode, data) -> WORKER.execute(() -> {
            if (resultCode != Activity.RESULT_OK || data == null) {
                try { resolve(reqId, new JSONObject().put("cancelled", true)); } catch (Exception ignored) {}
                return;
            }
            try {
                File dir = new File(activity.getCacheDir(), "gpuix_media");
                if (!dir.exists()) dir.mkdirs();
                File out = new File(dir, "photo_" + System.currentTimeMillis() + ".png");
                Bundle extras = data.getExtras();
                Object rawBmp = extras != null ? extras.get("data") : null;
                if (rawBmp instanceof Bitmap) {
                    Bitmap bmp = (Bitmap) rawBmp;
                    try (FileOutputStream fos = new FileOutputStream(out)) {
                        bmp.compress(Bitmap.CompressFormat.PNG, 95, fos);
                    }
                    JSONObject res = new JSONObject();
                    res.put("cancelled", false);
                    res.put("path", out.getAbsolutePath());
                    res.put("uri", Uri.fromFile(out).toString());
                    res.put("mimeType", "image/png");
                    res.put("width", bmp.getWidth());
                    res.put("height", bmp.getHeight());
                    res.put("size", out.length());
                    resolve(reqId, res);
                } else if (data.getData() != null) {
                    handlePickedUriResult(activity, reqId, resultCode, data);
                } else {
                    reject(reqId, "Camera did not return image data");
                }
            } catch (Throwable t) {
                reject(reqId, t.getMessage());
            }
        }));
    }

    private static void handlePickedUriResult(Activity activity, long reqId, int resultCode, Intent data) {
        if (resultCode != Activity.RESULT_OK || data == null || data.getData() == null) {
            try { resolve(reqId, new JSONObject().put("cancelled", true)); } catch (Exception ignored) {}
            return;
        }
        try {
            Uri uri = data.getData();
            ContentResolver cr = activity.getContentResolver();
            String mime = cr.getType(uri);
            String name = "file_" + System.currentTimeMillis();
            try (Cursor cursor = cr.query(uri, null, null, null, null)) {
                if (cursor != null && cursor.moveToFirst()) {
                    int idx = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME);
                    if (idx >= 0) {
                        String n = cursor.getString(idx);
                        if (n != null && !n.isEmpty()) name = n.replaceAll("[^A-Za-z0-9._-]", "_");
                    }
                }
            } catch (Throwable ignored) {}

            File dir = new File(activity.getCacheDir(), "gpuix_media");
            if (!dir.exists()) dir.mkdirs();
            File dest = new File(dir, System.currentTimeMillis() + "_" + name);
            long total = 0;
            try (InputStream in = cr.openInputStream(uri); FileOutputStream out = new FileOutputStream(dest)) {
                if (in == null) {
                    reject(reqId, "Cannot open selected content URI");
                    return;
                }
                byte[] buf = new byte[16384];
                int n;
                while ((n = in.read(buf)) >= 0) {
                    out.write(buf, 0, n);
                    total += n;
                }
            }
            JSONObject res = new JSONObject();
            res.put("cancelled", false);
            res.put("uri", uri.toString());
            res.put("path", dest.getAbsolutePath());
            res.put("name", name);
            res.put("mimeType", mime != null ? mime : "application/octet-stream");
            res.put("size", total);
            resolve(reqId, res);
        } catch (Throwable t) {
            reject(reqId, t.getMessage());
        }
    }

    @SuppressWarnings("MissingPermission")
    private static void handleLocation(Activity activity, long reqId, String method) throws Exception {
        if (!"getCurrentPosition".equals(method)) {
            reject(reqId, "Unsupported location method: " + method);
            return;
        }
        boolean hasFine = activity.checkSelfPermission("android.permission.ACCESS_FINE_LOCATION") == PackageManager.PERMISSION_GRANTED;
        boolean hasCoarse = activity.checkSelfPermission("android.permission.ACCESS_COARSE_LOCATION") == PackageManager.PERMISSION_GRANTED;
        if (!hasFine && !hasCoarse) {
            reject(reqId, "Location permission not granted");
            return;
        }
        LocationManager lm = (LocationManager) activity.getSystemService(Context.LOCATION_SERVICE);
        if (lm == null) {
            reject(reqId, "LocationManager unavailable");
            return;
        }
        String provider = lm.isProviderEnabled(LocationManager.GPS_PROVIDER)
                ? LocationManager.GPS_PROVIDER
                : lm.isProviderEnabled(LocationManager.NETWORK_PROVIDER)
                        ? LocationManager.NETWORK_PROVIDER
                        : LocationManager.PASSIVE_PROVIDER;
        Location last = lm.getLastKnownLocation(provider);
        if (last != null && (System.currentTimeMillis() - last.getTime()) < 120_000L) {
            resolve(reqId, locationToJson(last));
            return;
        }
        final AtomicBoolean done = new AtomicBoolean(false);
        final LocationListener[] holder = new LocationListener[1];
        LocationListener listener = new LocationListener() {
            @Override
            public void onLocationChanged(Location loc) {
                if (!done.compareAndSet(false, true)) return;
                lm.removeUpdates(this);
                try { resolve(reqId, locationToJson(loc)); } catch (Exception ignored) {}
            }
            @Override public void onStatusChanged(String p, int s, Bundle e) {}
            @Override public void onProviderEnabled(String p) {}
            @Override public void onProviderDisabled(String p) {}
        };
        holder[0] = listener;
        MAIN_HANDLER.post(() -> {
            try {
                lm.requestSingleUpdate(provider, listener, Looper.getMainLooper());
            } catch (Throwable t) {
                if (done.compareAndSet(false, true)) reject(reqId, t.getMessage());
            }
        });
        SCHEDULER.schedule(() -> {
            if (done.compareAndSet(false, true)) {
                MAIN_HANDLER.post(() -> lm.removeUpdates(holder[0]));
                if (last != null) {
                    try { resolve(reqId, locationToJson(last)); } catch (Exception ignored) {}
                } else {
                    reject(reqId, "Location fix timeout");
                }
            }
        }, 4000, TimeUnit.MILLISECONDS);
    }

    private static JSONObject locationToJson(Location loc) throws Exception {
        JSONObject res = new JSONObject();
        res.put("latitude", loc.getLatitude());
        res.put("longitude", loc.getLongitude());
        res.put("accuracy", loc.getAccuracy());
        res.put("altitude", loc.getAltitude());
        res.put("provider", loc.getProvider() != null ? loc.getProvider() : "unknown");
        res.put("timestamp", loc.getTime());
        return res;
    }

    // ── JNI callbacks implemented by Rust gpui-mobile ────────────────────────

    public static native void nativeBridgeResult(long requestId, boolean ok, String payloadJson);

    public static native void nativeBridgeEvent(String channel, String payloadJson);
}
