package dev.gpui.mobile.bridge;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.net.ConnectivityManager;
import android.net.Network;
import android.net.NetworkCapabilities;
import android.net.Uri;
import android.os.BatteryManager;
import android.os.Build;
import android.provider.Settings;
import android.util.DisplayMetrics;
import android.view.WindowManager;
import android.widget.Toast;
import dev.gpui.mobile.GpuiActivity;
import dev.gpui.mobile.GpuiNativeBridge;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import org.json.JSONArray;
import org.json.JSONObject;

/**
 * Device/battery info, system UI (toast, alert, status bar, keepScreenOn), clipboard, launcher, permissions, and network monitor.
 */
public final class DeviceSystemPlugin {

    private static volatile String sInitialDeepLink = null;
    private static ConnectivityManager.NetworkCallback sNetworkCallback = null;
    private static final Object NET_LOCK = new Object();

    private DeviceSystemPlugin() {
    }

    public static void register() {
        GpuiNativeBridge.registerPlugin("device", (a, r, m, args) -> handleDevice(a, r, m));
        GpuiNativeBridge.registerPlugin("system", DeviceSystemPlugin::handleSystem);
        GpuiNativeBridge.registerPlugin("clipboard", (a, r, m, args) -> handleClipboard(r, m, args));
        GpuiNativeBridge.registerPlugin("launcher", DeviceSystemPlugin::handleLauncher);
        GpuiNativeBridge.registerPlugin("permissions", DeviceSystemPlugin::handlePermissions);
    }

    public static void setInitialDeepLink(String url) {
        sInitialDeepLink = url;
    }

    public static void startNetworkMonitor(Context ctx) {
        Context appCtx = ctx.getApplicationContext();
        ConnectivityManager cm = (ConnectivityManager) appCtx.getSystemService(Context.CONNECTIVITY_SERVICE);
        if (cm == null) return;
        synchronized (NET_LOCK) {
            if (sNetworkCallback != null) return;
            ConnectivityManager.NetworkCallback cb = new ConnectivityManager.NetworkCallback() {
                @Override
                public void onAvailable(Network network) {
                    emitNetworkState(cm);
                }

                @Override
                public void onLost(Network network) {
                    emitNetworkState(cm);
                }

                @Override
                public void onCapabilitiesChanged(Network network, NetworkCapabilities caps) {
                    emitNetworkState(cm);
                }
            };
            try {
                cm.registerDefaultNetworkCallback(cb);
                sNetworkCallback = cb;
            } catch (Throwable ignored) {
            }
        }
    }

    public static void stopNetworkMonitor(Context ctx) {
        ConnectivityManager cm = (ConnectivityManager) ctx.getApplicationContext().getSystemService(Context.CONNECTIVITY_SERVICE);
        synchronized (NET_LOCK) {
            if (cm != null && sNetworkCallback != null) {
                try {
                    cm.unregisterNetworkCallback(sNetworkCallback);
                } catch (Throwable ignored) {
                }
            }
            sNetworkCallback = null;
        }
    }

    private static void emitNetworkState(ConnectivityManager cm) {
        try {
            Network active = cm.getActiveNetwork();
            NetworkCapabilities caps = active != null ? cm.getNetworkCapabilities(active) : null;
            String netType = "none";
            if (caps != null) {
                if (caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI)) netType = "wifi";
                else if (caps.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR)) netType = "cellular";
                else if (caps.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET)) netType = "ethernet";
                else netType = "other";
            }
            JSONObject payload = new JSONObject()
                    .put("connected", !"none".equals(netType))
                    .put("networkType", netType)
                    .put("isMetered", cm.isActiveNetworkMetered());
            BridgeContext.emitEvent("networkChange", payload);
        } catch (Throwable ignored) {
        }
    }

    public static void handleDevice(Activity activity, long reqId, String method) throws Exception {
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
            BridgeContext.resolve(reqId, res);
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
            BridgeContext.resolve(reqId, res);
        } else {
            BridgeContext.reject(reqId, "Unsupported device method: " + method);
        }
    }

    public static void handleSystem(Activity activity, long reqId, String method, JSONObject args) throws Exception {
        switch (method) {
            case "toast": {
                String msg = args.optString("message", "");
                int duration = args.optBoolean("long", false) ? Toast.LENGTH_LONG : Toast.LENGTH_SHORT;
                BridgeContext.MAIN_HANDLER.post(() -> Toast.makeText(activity, msg, duration).show());
                BridgeContext.resolve(reqId, new JSONObject().put("shown", true));
                break;
            }
            case "alert": {
                String title = args.optString("title", "提示");
                String message = args.optString("message", "");
                String confirmText = args.optString("confirmText", "确定");
                String cancelText = args.optString("cancelText", "");
                BridgeContext.MAIN_HANDLER.post(() -> {
                    AlertDialog.Builder builder = new AlertDialog.Builder(activity)
                            .setTitle(title)
                            .setMessage(message)
                            .setPositiveButton(confirmText, (d, w) -> {
                                try { BridgeContext.resolve(reqId, new JSONObject().put("confirmed", true)); } catch (Exception ignored) {}
                            });
                    if (!cancelText.isEmpty()) {
                        builder.setNegativeButton(cancelText, (d, w) -> {
                            try { BridgeContext.resolve(reqId, new JSONObject().put("confirmed", false)); } catch (Exception ignored) {}
                        });
                    }
                    builder.setOnCancelListener(d -> {
                        try { BridgeContext.resolve(reqId, new JSONObject().put("confirmed", false)); } catch (Exception ignored) {}
                    });
                    builder.show();
                });
                break;
            }
            case "setKeepScreenOn": {
                boolean enabled = args.optBoolean("enabled", false);
                BridgeContext.MAIN_HANDLER.post(() -> {
                    if (enabled) activity.getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
                    else activity.getWindow().clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
                });
                BridgeContext.resolve(reqId, new JSONObject().put("keepScreenOn", enabled));
                break;
            }
            case "setBrightness": {
                float value = (float) args.optDouble("value", -1.0);
                BridgeContext.MAIN_HANDLER.post(() -> {
                    WindowManager.LayoutParams lp = activity.getWindow().getAttributes();
                    lp.screenBrightness = value < 0f ? WindowManager.LayoutParams.BRIGHTNESS_OVERRIDE_NONE
                            : Math.max(0.02f, Math.min(1.0f, value));
                    activity.getWindow().setAttributes(lp);
                });
                BridgeContext.resolve(reqId, new JSONObject().put("brightness", value));
                break;
            }
            case "setStatusBar": {
                BridgeContext.MAIN_HANDLER.post(() -> {
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
                BridgeContext.resolve(reqId, new JSONObject().put("updated", true));
                break;
            }
            case "openAppSettings": {
                Intent intent = new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS,
                        Uri.fromParts("package", activity.getPackageName(), null));
                activity.startActivity(intent);
                BridgeContext.resolve(reqId, new JSONObject().put("opened", true));
                break;
            }
            case "moveToBack": {
                GpuiActivity.moveAppToBack();
                BridgeContext.resolve(reqId, new JSONObject().put("ok", true));
                break;
            }
            default:
                BridgeContext.reject(reqId, "Unsupported system method: " + method);
        }
    }

    public static void handleClipboard(long reqId, String method, JSONObject args) throws Exception {
        if ("read".equals(method)) {
            String text = GpuiActivity.getClipboardText();
            BridgeContext.resolve(reqId, new JSONObject().put("text", text != null ? text : JSONObject.NULL));
        } else if ("write".equals(method)) {
            boolean ok = GpuiActivity.setClipboardText(args.optString("text", ""));
            BridgeContext.resolve(reqId, new JSONObject().put("written", ok));
        } else {
            BridgeContext.reject(reqId, "Unsupported clipboard method: " + method);
        }
    }

    public static void handleLauncher(Activity activity, long reqId, String method, JSONObject args) throws Exception {
        switch (method) {
            case "openUrl": {
                String url = args.optString("url", "");
                Intent intent = new Intent(Intent.ACTION_VIEW, Uri.parse(url));
                intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                activity.startActivity(intent);
                BridgeContext.resolve(reqId, new JSONObject().put("opened", true));
                break;
            }
            case "canOpenUrl": {
                String url = args.optString("url", "");
                Intent intent = new Intent(Intent.ACTION_VIEW, Uri.parse(url));
                boolean can = intent.resolveActivity(activity.getPackageManager()) != null;
                BridgeContext.resolve(reqId, new JSONObject().put("canOpen", can));
                break;
            }
            case "getInitialUrl": {
                BridgeContext.resolve(reqId, new JSONObject().put("url", sInitialDeepLink != null ? sInitialDeepLink : JSONObject.NULL));
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
                BridgeContext.resolve(reqId, new JSONObject().put("shared", true));
                break;
            }
            case "isAppInstalled": {
                String pkg = args.optString("packageName", "").trim();
                boolean installed = false;
                if (!pkg.isEmpty()) {
                    try {
                        activity.getPackageManager().getPackageInfo(pkg, 0);
                        installed = true;
                    } catch (PackageManager.NameNotFoundException ignored) {
                    }
                }
                BridgeContext.resolve(reqId, new JSONObject().put("installed", installed));
                break;
            }
            case "openMarket": {
                String pkg = args.optString("packageName", "").trim();
                if (pkg.isEmpty()) pkg = activity.getPackageName();
                Intent market = new Intent(Intent.ACTION_VIEW, Uri.parse("market://details?id=" + Uri.encode(pkg)));
                market.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                try {
                    activity.startActivity(market);
                } catch (Throwable ignored) {
                    Intent web = new Intent(Intent.ACTION_VIEW,
                            Uri.parse("https://play.google.com/store/apps/details?id=" + Uri.encode(pkg)));
                    web.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                    activity.startActivity(web);
                }
                BridgeContext.resolve(reqId, new JSONObject().put("opened", true));
                break;
            }
            default:
                BridgeContext.reject(reqId, "Unsupported launcher method: " + method);
        }
    }

    public static void handlePermissions(Activity activity, long reqId, String method, JSONObject args) throws Exception {
        if ("check".equals(method)) {
            String perm = args.optString("permission", "");
            boolean granted = activity.checkSelfPermission(perm) == PackageManager.PERMISSION_GRANTED;
            BridgeContext.resolve(reqId, new JSONObject().put("granted", granted));
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
                BridgeContext.resolve(reqId, new JSONObject().put("granted", true).put("results", new JSONObject()));
                return;
            }
            String[] perms = list.toArray(new String[0]);
            BridgeContext.requestPermissions(activity, perms, (outPerms, grantResults) -> {
                try {
                    boolean allGranted = grantResults.length > 0;
                    JSONObject results = new JSONObject();
                    for (int i = 0; i < outPerms.length; i++) {
                        boolean g = i < grantResults.length && grantResults[i] == PackageManager.PERMISSION_GRANTED;
                        if (!g) allGranted = false;
                        results.put(outPerms[i], g ? "granted" : "denied");
                    }
                    BridgeContext.resolve(reqId, new JSONObject().put("granted", allGranted).put("results", results));
                } catch (Exception e) {
                    BridgeContext.reject(reqId, e.getMessage());
                }
            });
        } else {
            BridgeContext.reject(reqId, "Unsupported permissions method: " + method);
        }
    }
}
