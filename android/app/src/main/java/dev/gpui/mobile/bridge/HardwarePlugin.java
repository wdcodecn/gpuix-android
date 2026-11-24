package dev.gpui.mobile.bridge;

import android.app.Activity;
import android.app.KeyguardManager;
import android.content.Context;
import android.content.Intent;
import android.hardware.Sensor;
import android.hardware.SensorEvent;
import android.hardware.SensorEventListener;
import android.hardware.SensorManager;
import android.hardware.camera2.CameraCharacteristics;
import android.hardware.camera2.CameraManager;
import android.os.Build;
import android.os.CancellationSignal;
import dev.gpui.mobile.GpuiNativeBridge;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import org.json.JSONArray;
import org.json.JSONObject;

/**
 * Hardware capabilities: biometrics / lockscreen authentication, flashlight torch, and sensors.
 */
public final class HardwarePlugin {

    private static final ConcurrentHashMap<String, SensorEventListener> ACTIVE_SENSORS = new ConcurrentHashMap<>();
    private static volatile boolean sTorchEnabled = false;

    static {
        BridgeContext.registerCleanup(HardwarePlugin::cleanupSensors);
    }

    private HardwarePlugin() {
    }

    public static void register() {
        GpuiNativeBridge.registerPlugin("biometrics", HardwarePlugin::handleBiometrics);
        GpuiNativeBridge.registerPlugin("torch", HardwarePlugin::handleTorch);
        GpuiNativeBridge.registerPlugin("sensors", HardwarePlugin::handleSensors);
    }

    private static void cleanupSensors() {
        Activity activity = BridgeContext.currentActivity();
        if (activity != null) {
            SensorManager sm = (SensorManager) activity.getSystemService(Context.SENSOR_SERVICE);
            if (sm != null) {
                for (SensorEventListener listener : ACTIVE_SENSORS.values()) {
                    try { sm.unregisterListener(listener); } catch (Throwable ignored) {}
                }
            }
        }
        ACTIVE_SENSORS.clear();
    }

    public static void handleBiometrics(Activity activity, long reqId, String method, JSONObject args) throws Exception {
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
            BridgeContext.resolve(reqId, new JSONObject().put("available", available).put("status", detail));
        } else if ("authenticate".equals(method)) {
            String title = args.optString("title", "身份验证");
            String subtitle = args.optString("subtitle", "验证指纹、面容或锁屏密码");
            String description = args.optString("description", "");
            String cancelText = args.optString("cancelText", "取消");
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
                BridgeContext.MAIN_HANDLER.post(() -> Api28BiometricHelper.authenticate(
                        activity, title, subtitle, description, cancelText, reqId));
            } else {
                KeyguardManager km = (KeyguardManager) activity.getSystemService(Context.KEYGUARD_SERVICE);
                if (km == null) {
                    BridgeContext.reject(reqId, "KeyguardManager unavailable");
                    return;
                }
                @SuppressWarnings("deprecation")
                Intent intent = km.createConfirmDeviceCredentialIntent(title, subtitle);
                if (intent == null) {
                    BridgeContext.reject(reqId, "Device lock screen credential is not configured");
                    return;
                }
                BridgeContext.startActivityForResult(activity, intent, (resultCode, data) -> {
                    try {
                        BridgeContext.resolve(reqId, new JSONObject().put("authenticated", resultCode == Activity.RESULT_OK));
                    } catch (Exception ignored) {}
                });
            }
        } else {
            BridgeContext.reject(reqId, "Unsupported biometrics method: " + method);
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
                            BridgeContext.resolve(reqId, new JSONObject().put("authenticated", false).put("reason", "cancelled"));
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
                                    BridgeContext.resolve(reqId, new JSONObject().put("authenticated", true));
                                } catch (Exception ignored) {}
                            }

                            @Override
                            public void onAuthenticationError(int errorCode, CharSequence errString) {
                                try {
                                    BridgeContext.resolve(reqId, new JSONObject()
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
                BridgeContext.reject(reqId, t.getMessage() != null ? t.getMessage() : "BiometricPrompt failed");
            }
        }
    }

    public static void handleTorch(Activity activity, long reqId, String method, JSONObject args) throws Exception {
        CameraManager cm = (CameraManager) activity.getSystemService(Context.CAMERA_SERVICE);
        if (cm == null) {
            BridgeContext.reject(reqId, "CameraManager unavailable");
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
            BridgeContext.resolve(reqId, new JSONObject().put("available", flashCamId != null).put("enabled", sTorchEnabled));
        } else if ("setEnabled".equals(method)) {
            if (flashCamId == null) {
                BridgeContext.reject(reqId, "No rear camera flash available");
                return;
            }
            boolean enabled = args.optBoolean("enabled", false);
            cm.setTorchMode(flashCamId, enabled);
            sTorchEnabled = enabled;
            BridgeContext.resolve(reqId, new JSONObject().put("enabled", enabled));
        } else {
            BridgeContext.reject(reqId, "Unsupported torch method: " + method);
        }
    }

    private static int parseSensorType(String type) {
        switch (type != null ? type : "accelerometer") {
            case "gyroscope": return Sensor.TYPE_GYROSCOPE;
            case "light": return Sensor.TYPE_LIGHT;
            case "magnetic": return Sensor.TYPE_MAGNETIC_FIELD;
            case "proximity": return Sensor.TYPE_PROXIMITY;
            default: return Sensor.TYPE_ACCELEROMETER;
        }
    }

    public static void handleSensors(Activity activity, long reqId, String method, JSONObject args) throws Exception {
        SensorManager sm = (SensorManager) activity.getSystemService(Context.SENSOR_SERVICE);
        if (sm == null) {
            BridgeContext.reject(reqId, "SensorManager unavailable");
            return;
        }
        String typeName = args.optString("type", "accelerometer");
        int sensorType = parseSensorType(typeName);
        Sensor sensor = sm.getDefaultSensor(sensorType);
        if ("sample".equals(method)) {
            if (sensor == null) {
                BridgeContext.reject(reqId, "Sensor not available: " + typeName);
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
                        BridgeContext.resolve(reqId, res);
                    } catch (Throwable t) {
                        BridgeContext.reject(reqId, t.getMessage());
                    }
                }

                @Override
                public void onAccuracyChanged(Sensor s, int accuracy) {}
            };
            holder[0] = listener;
            sm.registerListener(listener, sensor, SensorManager.SENSOR_DELAY_UI, BridgeContext.MAIN_HANDLER);
            BridgeContext.SCHEDULER.schedule(() -> {
                if (done.compareAndSet(false, true)) {
                    sm.unregisterListener(holder[0]);
                    BridgeContext.reject(reqId, "Sensor read timeout: " + typeName);
                }
            }, 1500, TimeUnit.MILLISECONDS);
        } else if ("start".equals(method)) {
            if (sensor == null) {
                BridgeContext.reject(reqId, "Sensor not available: " + typeName);
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
                        BridgeContext.emitEvent("sensor", payload);
                    } catch (Throwable ignored) {}
                }

                @Override
                public void onAccuracyChanged(Sensor s, int accuracy) {}
            };
            ACTIVE_SENSORS.put(typeName, listener);
            sm.registerListener(listener, sensor, SensorManager.SENSOR_DELAY_UI, BridgeContext.MAIN_HANDLER);
            BridgeContext.resolve(reqId, new JSONObject().put("started", typeName));
        } else if ("stop".equals(method)) {
            SensorEventListener prev = ACTIVE_SENSORS.remove(typeName);
            if (prev != null) sm.unregisterListener(prev);
            BridgeContext.resolve(reqId, new JSONObject().put("stopped", typeName));
        } else {
            BridgeContext.reject(reqId, "Unsupported sensors method: " + method);
        }
    }
}
