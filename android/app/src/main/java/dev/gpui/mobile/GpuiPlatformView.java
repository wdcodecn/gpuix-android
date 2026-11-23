package dev.gpui.mobile;

import android.app.Activity;
import android.graphics.Color;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;
import android.widget.MediaController;
import android.widget.VideoView;
import java.util.HashMap;
import java.util.Iterator;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import org.json.JSONObject;

/**
 * Hybrid composition Android PlatformView host expected by gpui-mobile.
 * Supports built-in "webview" and "video" views plus custom registered factories.
 */
public final class GpuiPlatformView {

    public interface ViewFactory {
        View create(Activity activity, Map<String, String> params);
    }

    private static final String TAG = "GpuiPlatformView";
    private static final Handler MAIN_HANDLER = new Handler(Looper.getMainLooper());
    private static final ConcurrentHashMap<Long, View> VIEWS = new ConcurrentHashMap<>();
    private static final ConcurrentHashMap<String, ViewFactory> FACTORIES = new ConcurrentHashMap<>();
    private static volatile FrameLayout sContainer = null;

    static {
        FACTORIES.put("webview", (activity, params) -> {
            WebView wv = new WebView(activity);
            wv.setBackgroundColor(Color.WHITE);
            WebSettings settings = wv.getSettings();
            settings.setJavaScriptEnabled(!"false".equalsIgnoreCase(params.get("javascriptEnabled")));
            settings.setDomStorageEnabled(true);
            wv.setWebViewClient(new WebViewClient());
            String html = params.get("html");
            String url = params.get("url");
            if (html != null && !html.isEmpty()) {
                wv.loadDataWithBaseURL(url != null ? url : "https://gpuix.local/", html, "text/html", "UTF-8", null);
            } else if (url != null && !url.isEmpty()) {
                wv.loadUrl(url);
            }
            return wv;
        });

        FACTORIES.put("video", (activity, params) -> {
            VideoView video = new VideoView(activity);
            MediaController controller = new MediaController(activity);
            controller.setAnchorView(video);
            video.setMediaController(controller);
            String url = params.get("url");
            if (url != null && !url.isEmpty()) {
                video.setVideoPath(url);
                if (!"false".equalsIgnoreCase(params.get("autoplay"))) {
                    video.start();
                }
            }
            return video;
        });
    }

    private GpuiPlatformView() {
    }

    public static void registerFactory(String viewType, ViewFactory factory) {
        if (viewType != null && factory != null) {
            FACTORIES.put(viewType, factory);
        }
    }

    private static FrameLayout ensureContainer(Activity activity) {
        if (sContainer != null && sContainer.getParent() != null) {
            return sContainer;
        }
        FrameLayout container = new FrameLayout(activity);
        container.setBackgroundColor(Color.TRANSPARENT);
        container.setClickable(false);
        container.setFocusable(false);
        activity.addContentView(container, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT
        ));
        sContainer = container;
        return container;
    }

    private static Map<String, String> parseParams(String raw) {
        Map<String, String> map = new HashMap<>();
        if (raw == null || raw.isEmpty()) return map;
        String trimmed = raw.trim();
        if (trimmed.startsWith("{")) {
            try {
                JSONObject obj = new JSONObject(trimmed);
                Iterator<String> keys = obj.keys();
                while (keys.hasNext()) {
                    String k = keys.next();
                    if (!obj.isNull(k)) {
                        map.put(k, obj.optString(k, ""));
                    }
                }
                return map;
            } catch (Throwable t) {
                Log.w(TAG, "JSON params parse fallback", t);
            }
        }
        String[] pairs = raw.split("\\|");
        for (String pair : pairs) {
            int eq = pair.indexOf('=');
            if (eq > 0) {
                map.put(pair.substring(0, eq), pair.substring(eq + 1));
            }
        }
        return map;
    }

    public static boolean createView(
            final Activity activity,
            final String viewType,
            final long viewId,
            final float x,
            final float y,
            final float width,
            final float height,
            final String creationParams
    ) {
        if (activity == null || viewType == null) return false;
        final ViewFactory factory = FACTORIES.get(viewType);
        if (factory == null) {
            Log.w(TAG, "Unknown platform view type: " + viewType);
            return false;
        }
        final Map<String, String> params = parseParams(creationParams);
        MAIN_HANDLER.post(() -> {
            try {
                FrameLayout container = ensureContainer(activity);
                View old = VIEWS.remove(viewId);
                if (old != null) {
                    container.removeView(old);
                    if (old instanceof WebView) ((WebView) old).destroy();
                }
                View view = factory.create(activity, params);
                float density = activity.getResources().getDisplayMetrics().density;
                int pxW = Math.max(1, Math.round(width * density));
                int pxH = Math.max(1, Math.round(height * density));
                FrameLayout.LayoutParams lp = new FrameLayout.LayoutParams(pxW, pxH);
                lp.leftMargin = Math.round(x * density);
                lp.topMargin = Math.round(y * density);
                container.addView(view, lp);
                VIEWS.put(viewId, view);
            } catch (Throwable t) {
                Log.e(TAG, "createView failed for " + viewType, t);
            }
        });
        return true;
    }

    public static void setBounds(final long viewId, final float x, final float y, final float width, final float height) {
        MAIN_HANDLER.post(() -> {
            View view = VIEWS.get(viewId);
            if (view == null) return;
            float density = view.getResources().getDisplayMetrics().density;
            FrameLayout.LayoutParams lp = (FrameLayout.LayoutParams) view.getLayoutParams();
            if (lp == null) {
                lp = new FrameLayout.LayoutParams(Math.max(1, Math.round(width * density)), Math.max(1, Math.round(height * density)));
            } else {
                lp.width = Math.max(1, Math.round(width * density));
                lp.height = Math.max(1, Math.round(height * density));
            }
            lp.leftMargin = Math.round(x * density);
            lp.topMargin = Math.round(y * density);
            view.setLayoutParams(lp);
        });
    }

    public static void setVisible(final long viewId, final boolean visible) {
        MAIN_HANDLER.post(() -> {
            View view = VIEWS.get(viewId);
            if (view != null) {
                view.setVisibility(visible ? View.VISIBLE : View.GONE);
            }
        });
    }

    public static void setZIndex(final long viewId, final int zIndex) {
        MAIN_HANDLER.post(() -> {
            View view = VIEWS.get(viewId);
            if (view != null) {
                view.setZ(zIndex);
            }
        });
    }

    public static void disposeView(final long viewId) {
        MAIN_HANDLER.post(() -> {
            View view = VIEWS.remove(viewId);
            if (view == null) return;
            if (view.getParent() instanceof ViewGroup) {
                ((ViewGroup) view.getParent()).removeView(view);
            }
            if (view instanceof WebView) {
                ((WebView) view).destroy();
            } else if (view instanceof VideoView) {
                ((VideoView) view).stopPlayback();
            }
        });
    }

    public static void pauseAll() {
        MAIN_HANDLER.post(() -> {
            for (View view : VIEWS.values()) {
                if (view instanceof WebView) ((WebView) view).onPause();
                else if (view instanceof VideoView) ((VideoView) view).pause();
            }
        });
    }

    public static void resumeAll() {
        MAIN_HANDLER.post(() -> {
            for (View view : VIEWS.values()) {
                if (view instanceof WebView) ((WebView) view).onResume();
            }
        });
    }

    public static void disposeAll() {
        MAIN_HANDLER.post(() -> {
            for (View view : VIEWS.values()) {
                if (view.getParent() instanceof ViewGroup) {
                    ((ViewGroup) view.getParent()).removeView(view);
                }
                if (view instanceof WebView) ((WebView) view).destroy();
                else if (view instanceof VideoView) ((VideoView) view).stopPlayback();
            }
            VIEWS.clear();
            if (sContainer != null && sContainer.getParent() instanceof ViewGroup) {
                ((ViewGroup) sContainer.getParent()).removeView(sContainer);
            }
            sContainer = null;
        });
    }
}
