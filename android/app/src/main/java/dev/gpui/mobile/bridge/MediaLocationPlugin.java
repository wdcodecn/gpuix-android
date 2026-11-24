package dev.gpui.mobile.bridge;

import android.app.Activity;
import android.content.ContentResolver;
import android.content.ContentValues;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.database.Cursor;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.location.Location;
import android.location.LocationListener;
import android.location.LocationManager;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.os.Looper;
import android.provider.MediaStore;
import android.provider.OpenableColumns;
import dev.gpui.mobile.GpuiNativeBridge;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
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
            case "saveToGallery": {
                saveImageToGallery(activity, reqId, args);
                break;
            }
            case "compressImage": {
                compressImageFile(activity, reqId, args);
                break;
            }
            default:
                BridgeContext.reject(reqId, "Unsupported media method: " + method);
        }
    }

    private static File resolveReadableMediaFile(Context ctx, String pathInput) throws Exception {
        String raw = pathInput != null ? pathInput.trim() : "";
        if (raw.isEmpty()) {
            throw new IllegalArgumentException("path is required");
        }
        File target = raw.startsWith("/")
                ? new File(raw).getCanonicalFile()
                : FileTransferPlugin.resolveSandboxFile(ctx, raw, "files", false);
        String filesRoot = ctx.getFilesDir().getCanonicalPath();
        String cacheRoot = ctx.getCacheDir().getCanonicalPath();
        String tp = target.getPath();
        if (!tp.startsWith(filesRoot + File.separator) && !tp.startsWith(cacheRoot + File.separator)) {
            throw new SecurityException("Media path must stay inside app sandbox");
        }
        if (!target.isFile()) {
            throw new IllegalArgumentException("File not found: " + raw);
        }
        return target;
    }

    private static void saveImageToGallery(Activity activity, long reqId, JSONObject args) throws Exception {
        Context ctx = activity.getApplicationContext();
        File src = resolveReadableMediaFile(ctx, args.optString("path", ""));
        String mimeType = args.optString("mimeType", "").trim();
        if (mimeType.isEmpty()) {
            String lower = src.getName().toLowerCase(java.util.Locale.US);
            mimeType = lower.endsWith(".png") ? "image/png" : lower.endsWith(".webp") ? "image/webp" : "image/jpeg";
        }
        String displayName = args.optString("displayName", "").trim();
        if (displayName.isEmpty()) {
            displayName = "gpuix_" + System.currentTimeMillis() + (mimeType.contains("png") ? ".png" : ".jpg");
        }

        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) {
            BridgeContext.reject(reqId, "saveToGallery requires Android 10 (API 29) or higher");
            return;
        }
        ContentResolver cr = ctx.getContentResolver();
        ContentValues values = new ContentValues();
        values.put(MediaStore.Images.Media.DISPLAY_NAME, displayName);
        values.put(MediaStore.Images.Media.MIME_TYPE, mimeType);
        values.put(MediaStore.Images.Media.RELATIVE_PATH, Environment.DIRECTORY_PICTURES + File.separator + "GPUIX");
        values.put(MediaStore.Images.Media.IS_PENDING, 1);

        Uri uri = cr.insert(MediaStore.Images.Media.EXTERNAL_CONTENT_URI, values);
        if (uri == null) {
            BridgeContext.reject(reqId, "Failed to create MediaStore gallery entry");
            return;
        }
        try {
            try (InputStream in = new FileInputStream(src); OutputStream out = cr.openOutputStream(uri)) {
                if (out == null) throw new IllegalStateException("Cannot open MediaStore output stream");
                byte[] buf = new byte[16384];
                int n;
                while ((n = in.read(buf)) >= 0) {
                    out.write(buf, 0, n);
                }
            }
            ContentValues done = new ContentValues();
            done.put(MediaStore.Images.Media.IS_PENDING, 0);
            cr.update(uri, done, null, null);
            BridgeContext.resolve(reqId, new JSONObject().put("saved", true).put("uri", uri.toString()));
        } catch (Throwable t) {
            cr.delete(uri, null, null);
            throw t;
        }
    }

    private static void compressImageFile(Activity activity, long reqId, JSONObject args) throws Exception {
        Context ctx = activity.getApplicationContext();
        File src = resolveReadableMediaFile(ctx, args.optString("path", ""));
        int maxW = Math.max(64, args.optInt("maxWidth", 1280));
        int maxH = Math.max(64, args.optInt("maxHeight", 1280));
        int quality = Math.max(10, Math.min(100, args.optInt("quality", 82)));
        String fmt = args.optString("format", "jpeg").trim().toLowerCase(java.util.Locale.US);

        BitmapFactory.Options bounds = new BitmapFactory.Options();
        bounds.inJustDecodeBounds = true;
        BitmapFactory.decodeFile(src.getAbsolutePath(), bounds);
        if (bounds.outWidth <= 0 || bounds.outHeight <= 0) {
            BridgeContext.reject(reqId, "Invalid image file");
            return;
        }

        int inSample = 1;
        while ((bounds.outWidth / inSample) > maxW * 2 || (bounds.outHeight / inSample) > maxH * 2) {
            inSample *= 2;
        }
        BitmapFactory.Options opts = new BitmapFactory.Options();
        opts.inSampleSize = inSample;
        Bitmap decoded = BitmapFactory.decodeFile(src.getAbsolutePath(), opts);
        if (decoded == null) {
            BridgeContext.reject(reqId, "Failed to decode image");
            return;
        }

        Bitmap outputBmp = decoded;
        int w = decoded.getWidth();
        int h = decoded.getHeight();
        if (w > maxW || h > maxH) {
            double scale = Math.min((double) maxW / (double) w, (double) maxH / (double) h);
            int targetW = Math.max(1, (int) Math.round(w * scale));
            int targetH = Math.max(1, (int) Math.round(h * scale));
            outputBmp = Bitmap.createScaledBitmap(decoded, targetW, targetH, true);
            if (outputBmp != decoded) {
                decoded.recycle();
            }
        }

        Bitmap.CompressFormat compressFmt = "png".equals(fmt)
                ? Bitmap.CompressFormat.PNG
                : "webp".equals(fmt) && Build.VERSION.SDK_INT >= Build.VERSION_CODES.R
                        ? Bitmap.CompressFormat.WEBP_LOSSY
                        : Bitmap.CompressFormat.JPEG;
        String ext = compressFmt == Bitmap.CompressFormat.PNG ? ".png"
                : compressFmt == Bitmap.CompressFormat.JPEG ? ".jpg" : ".webp";
        String mimeType = compressFmt == Bitmap.CompressFormat.PNG ? "image/png"
                : compressFmt == Bitmap.CompressFormat.JPEG ? "image/jpeg" : "image/webp";

        File dir = new File(ctx.getCacheDir(), "gpuix_media");
        if (!dir.exists()) dir.mkdirs();
        File dest = new File(dir, "compressed_" + System.currentTimeMillis() + ext);
        int outW = outputBmp.getWidth();
        int outH = outputBmp.getHeight();
        try (FileOutputStream fos = new FileOutputStream(dest)) {
            outputBmp.compress(compressFmt, quality, fos);
        } finally {
            outputBmp.recycle();
        }

        BridgeContext.resolve(reqId, new JSONObject()
                .put("path", dest.getAbsolutePath())
                .put("uri", Uri.fromFile(dest).toString())
                .put("width", outW)
                .put("height", outH)
                .put("size", dest.length())
                .put("mimeType", mimeType));
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
