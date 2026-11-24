package dev.gpui.mobile.bridge;

import android.app.Activity;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import dev.gpui.mobile.GpuiActivity;
import dev.gpui.mobile.GpuiNativeBridge;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import org.json.JSONObject;

/**
 * Push notification simulation, scheduled alerts, progress notifications, and channels.
 */
public final class NotificationsPlugin {

    private static final String DEFAULT_CHANNEL_ID = "gpuix_default_high";
    private static final String DEFAULT_CHANNEL_NAME = "GPUIX 通知";
    private static final AtomicInteger NEXT_NOTIF_ID = new AtomicInteger(1001);

    private NotificationsPlugin() {
    }

    public static void register() {
        GpuiNativeBridge.registerPlugin("notifications", NotificationsPlugin::handle);
    }

    public static void handle(Activity activity, long reqId, String method, JSONObject args) throws Exception {
        NotificationManager nm = (NotificationManager) activity.getSystemService(Context.NOTIFICATION_SERVICE);
        if (nm == null) {
            BridgeContext.reject(reqId, "NotificationManager unavailable");
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
                BridgeContext.resolve(reqId, res);
                break;
            }
            case "show": {
                int id = args.optInt("id", NEXT_NOTIF_ID.getAndIncrement());
                postNotification(activity, nm, id, args, -1, 0, false);
                JSONObject res = new JSONObject();
                res.put("id", id);
                res.put("shown", nm.areNotificationsEnabled());
                BridgeContext.resolve(reqId, res);
                break;
            }
            case "schedule": {
                long delayMs = Math.max(100L, args.optLong("delayMs", 3000L));
                int id = args.optInt("id", NEXT_NOTIF_ID.getAndIncrement());
                JSONObject copy = new JSONObject(args.toString());
                BridgeContext.SCHEDULER.schedule(() -> {
                    Activity cur = BridgeContext.currentActivity();
                    Context ctx = cur != null ? cur : activity.getApplicationContext();
                    NotificationManager mgr = (NotificationManager) ctx.getSystemService(Context.NOTIFICATION_SERVICE);
                    if (mgr != null) {
                        postNotification(ctx, mgr, id, copy, -1, 0, false);
                        try {
                            JSONObject ev = new JSONObject();
                            ev.put("id", id);
                            ev.put("title", copy.optString("title", ""));
                            BridgeContext.emitEvent("notificationDelivered", ev);
                        } catch (Throwable ignored) {}
                    }
                }, delayMs, TimeUnit.MILLISECONDS);
                JSONObject res = new JSONObject();
                res.put("id", id);
                res.put("delayMs", delayMs);
                BridgeContext.resolve(reqId, res);
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
                BridgeContext.resolve(reqId, res);
                break;
            }
            case "cancel": {
                int id = args.optInt("id", -1);
                if (id >= 0) nm.cancel(id);
                BridgeContext.resolve(reqId, new JSONObject().put("cancelled", true));
                break;
            }
            case "cancelAll": {
                nm.cancelAll();
                BridgeContext.resolve(reqId, new JSONObject().put("cancelledAll", true));
                break;
            }
            default:
                BridgeContext.reject(reqId, "Unsupported notifications method: " + method);
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
}
