package dev.gpui.mobile.bridge;

import android.app.Activity;
import android.content.Context;
import android.media.AudioManager;
import android.media.Ringtone;
import android.media.RingtoneManager;
import android.media.ToneGenerator;
import android.net.Uri;
import android.os.VibrationEffect;
import android.os.Vibrator;
import android.speech.tts.TextToSpeech;
import android.view.HapticFeedbackConstants;
import dev.gpui.mobile.GpuiNativeBridge;
import java.util.Locale;
import java.util.concurrent.TimeUnit;
import org.json.JSONArray;
import org.json.JSONObject;

/**
 * Audio playback (system tones, volume, TTS) and haptic feedback / vibration.
 */
public final class AudioHapticsPlugin {

    private static volatile TextToSpeech sTts = null;
    private static volatile boolean sTtsReady = false;
    private static final Object TTS_LOCK = new Object();

    static {
        BridgeContext.registerCleanup(AudioHapticsPlugin::cleanupTts);
    }

    private AudioHapticsPlugin() {
    }

    public static void register() {
        GpuiNativeBridge.registerPlugin("audio", AudioHapticsPlugin::handleAudio);
        GpuiNativeBridge.registerPlugin("haptics", AudioHapticsPlugin::handleHaptics);
    }

    private static void cleanupTts() {
        synchronized (TTS_LOCK) {
            if (sTts != null) {
                try {
                    sTts.stop();
                    sTts.shutdown();
                } catch (Throwable ignored) {}
                sTts = null;
                sTtsReady = false;
            }
        }
    }

    public static void handleAudio(Activity activity, long reqId, String method, JSONObject args) throws Exception {
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
                            BridgeContext.SCHEDULER.schedule(() -> {
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
                BridgeContext.resolve(reqId, new JSONObject().put("played", type));
                break;
            }
            case "getVolume": {
                if (am == null) {
                    BridgeContext.reject(reqId, "AudioManager unavailable");
                    return;
                }
                int stream = parseAudioStream(args.optString("stream", "music"));
                int cur = am.getStreamVolume(stream);
                int max = Math.max(1, am.getStreamMaxVolume(stream));
                JSONObject res = new JSONObject();
                res.put("volume", (double) cur / max);
                res.put("current", cur);
                res.put("max", max);
                BridgeContext.resolve(reqId, res);
                break;
            }
            case "setVolume": {
                if (am == null) {
                    BridgeContext.reject(reqId, "AudioManager unavailable");
                    return;
                }
                int stream = parseAudioStream(args.optString("stream", "music"));
                double ratio = Math.max(0.0, Math.min(1.0, args.optDouble("volume", 0.5)));
                int max = Math.max(1, am.getStreamMaxVolume(stream));
                int target = (int) Math.round(ratio * max);
                am.setStreamVolume(stream, target, 0);
                BridgeContext.resolve(reqId, new JSONObject().put("volume", (double) target / max).put("current", target).put("max", max));
                break;
            }
            case "speak": {
                String text = args.optString("text", "");
                float rate = (float) args.optDouble("rate", 1.0);
                float pitch = (float) args.optDouble("pitch", 1.0);
                if (text.isEmpty()) {
                    BridgeContext.reject(reqId, "TTS text cannot be empty");
                    return;
                }
                speakWithTts(activity, text, rate, pitch, reqId);
                break;
            }
            case "stopSpeak": {
                synchronized (TTS_LOCK) {
                    if (sTts != null) sTts.stop();
                }
                BridgeContext.resolve(reqId, new JSONObject().put("stopped", true));
                break;
            }
            default:
                BridgeContext.reject(reqId, "Unsupported audio method: " + method);
        }
    }

    private static void playToneGen(int tone, int durationMs) {
        ToneGenerator tg = new ToneGenerator(AudioManager.STREAM_NOTIFICATION, 85);
        tg.startTone(tone, durationMs);
        BridgeContext.SCHEDULER.schedule(tg::release, durationMs + 150L, TimeUnit.MILLISECONDS);
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
                    BridgeContext.resolve(reqId, new JSONObject().put("speaking", true).put("text", text));
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
                            BridgeContext.resolve(reqId, new JSONObject().put("speaking", true).put("text", text));
                        } catch (Exception ignored) {}
                    } else {
                        sTtsReady = false;
                        BridgeContext.reject(reqId, "TextToSpeech init failed (status=" + status + ")");
                    }
                }
            });
        }
    }

    public static void handleHaptics(Activity activity, long reqId, String method, JSONObject args) throws Exception {
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
            BridgeContext.MAIN_HANDLER.post(() -> {
                try {
                    activity.getWindow().getDecorView().performHapticFeedback(constant);
                } catch (Throwable ignored) {}
            });
            if (vibrator != null && vibrator.hasVibrator()) {
                vibrator.vibrate(VibrationEffect.createOneShot(ms, amp));
            }
            BridgeContext.resolve(reqId, new JSONObject().put("style", style));
        } else if ("vibrate".equals(method)) {
            if (vibrator == null || !vibrator.hasVibrator()) {
                BridgeContext.reject(reqId, "No vibrator hardware");
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
            BridgeContext.resolve(reqId, new JSONObject().put("vibrated", true));
        } else {
            BridgeContext.reject(reqId, "Unsupported haptics method: " + method);
        }
    }
}
