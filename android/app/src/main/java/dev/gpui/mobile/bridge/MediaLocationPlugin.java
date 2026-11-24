package dev.gpui.mobile.bridge;

import android.app.Activity;
import android.content.ContentResolver;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.database.Cursor;
import android.graphics.Bitmap;
import android.location.Location;
import android.location.LocationListener;
import android.location.LocationManager;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Looper;
import android.provider.MediaStore;
import android.provider.OpenableColumns;
import dev.gpui.mobile.GpuiNativeBridge;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import org.json.JSONObject;

/**
 * Media picker (image/file/camera capture) and geolocation providers.
 */
public final class MediaLocationPlugin {

    private MediaLocationPlugin() {
    }

    public static void register() {
        GpuiNativeBridge.registerPlugin("media", MediaLocationPlugin::handleMedia);
        GpuiNativeBridge.registerPlugin("location", (a, r, m, args) -> handleLocation(a, r, m));
    }

    public static void handleMedia(Activity activity, long reqId, String method, JSONObject args) throws Exception {
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
                BridgeContext.startActivityForResult(activity, intent, (resultCode, data) ->
                        BridgeContext.WORKER.execute(() -> handlePickedUriResult(activity, reqId, resultCode, data)));
                break;
            }
            case "pickFile": {
                Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT);
                intent.addCategory(Intent.CATEGORY_OPENABLE);
                intent.setType(args.optString("mimeType", "*/*"));
                BridgeContext.startActivityForResult(activity, intent, (resultCode, data) ->
                        BridgeContext.WORKER.execute(() -> handlePickedUriResult(activity, reqId, resultCode, data)));
                break;
            }
            case "takePhoto": {
                if (activity.checkSelfPermission("android.permission.CAMERA") != PackageManager.PERMISSION_GRANTED) {
                    BridgeContext.requestPermissions(activity, new String[]{"android.permission.CAMERA"}, (p, g) -> {
                        if (g.length > 0 && g[0] == PackageManager.PERMISSION_GRANTED) {
                            launchCameraCapture(activity, reqId);
                        } else {
                            BridgeContext.reject(reqId, "Camera permission denied");
                        }
                    });
                } else {
                    launchCameraCapture(activity, reqId);
                }
                break;
            }
            default:
                BridgeContext.reject(reqId, "Unsupported media method: " + method);
        }
    }

    private static void launchCameraCapture(Activity activity, long reqId) {
        Intent intent = new Intent(MediaStore.ACTION_IMAGE_CAPTURE);
        BridgeContext.startActivityForResult(activity, intent, (resultCode, data) -> BridgeContext.WORKER.execute(() -> {
            if (resultCode != Activity.RESULT_OK || data == null) {
                try { BridgeContext.resolve(reqId, new JSONObject().put("cancelled", true)); } catch (Exception ignored) {}
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
                    BridgeContext.resolve(reqId, res);
                } else if (data.getData() != null) {
                    handlePickedUriResult(activity, reqId, resultCode, data);
                } else {
                    BridgeContext.reject(reqId, "Camera did not return image data");
                }
            } catch (Throwable t) {
                BridgeContext.reject(reqId, t.getMessage());
            }
        }));
    }

    private static void handlePickedUriResult(Activity activity, long reqId, int resultCode, Intent data) {
        if (resultCode != Activity.RESULT_OK || data == null || data.getData() == null) {
            try { BridgeContext.resolve(reqId, new JSONObject().put("cancelled", true)); } catch (Exception ignored) {}
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
                    BridgeContext.reject(reqId, "Cannot open selected content URI");
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
            BridgeContext.resolve(reqId, res);
        } catch (Throwable t) {
            BridgeContext.reject(reqId, t.getMessage());
        }
    }

    @SuppressWarnings("MissingPermission")
    public static void handleLocation(Activity activity, long reqId, String method) throws Exception {
        if (!"getCurrentPosition".equals(method)) {
            BridgeContext.reject(reqId, "Unsupported location method: " + method);
            return;
        }
        boolean hasFine = activity.checkSelfPermission("android.permission.ACCESS_FINE_LOCATION") == PackageManager.PERMISSION_GRANTED;
        boolean hasCoarse = activity.checkSelfPermission("android.permission.ACCESS_COARSE_LOCATION") == PackageManager.PERMISSION_GRANTED;
        if (!hasFine && !hasCoarse) {
            BridgeContext.reject(reqId, "Location permission not granted");
            return;
        }
        LocationManager lm = (LocationManager) activity.getSystemService(Context.LOCATION_SERVICE);
        if (lm == null) {
            BridgeContext.reject(reqId, "LocationManager unavailable");
            return;
        }
        String provider = lm.isProviderEnabled(LocationManager.GPS_PROVIDER)
                ? LocationManager.GPS_PROVIDER
                : lm.isProviderEnabled(LocationManager.NETWORK_PROVIDER)
                        ? LocationManager.NETWORK_PROVIDER
                        : LocationManager.PASSIVE_PROVIDER;
        Location last = lm.getLastKnownLocation(provider);
        if (last != null && (System.currentTimeMillis() - last.getTime()) < 120_000L) {
            BridgeContext.resolve(reqId, locationToJson(last));
            return;
        }
        final AtomicBoolean done = new AtomicBoolean(false);
        final LocationListener[] holder = new LocationListener[1];
        LocationListener listener = new LocationListener() {
            @Override
            public void onLocationChanged(Location loc) {
                if (!done.compareAndSet(false, true)) return;
                lm.removeUpdates(this);
                try { BridgeContext.resolve(reqId, locationToJson(loc)); } catch (Exception ignored) {}
            }
            @Override public void onStatusChanged(String p, int s, Bundle e) {}
            @Override public void onProviderEnabled(String p) {}
            @Override public void onProviderDisabled(String p) {}
        };
        holder[0] = listener;
        BridgeContext.MAIN_HANDLER.post(() -> {
            try {
                lm.requestSingleUpdate(provider, listener, Looper.getMainLooper());
            } catch (Throwable t) {
                if (done.compareAndSet(false, true)) BridgeContext.reject(reqId, t.getMessage());
            }
        });
        BridgeContext.SCHEDULER.schedule(() -> {
            if (done.compareAndSet(false, true)) {
                BridgeContext.MAIN_HANDLER.post(() -> lm.removeUpdates(holder[0]));
                if (last != null) {
                    try { BridgeContext.resolve(reqId, locationToJson(last)); } catch (Exception ignored) {}
                } else {
                    BridgeContext.reject(reqId, "Location fix timeout");
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
}
