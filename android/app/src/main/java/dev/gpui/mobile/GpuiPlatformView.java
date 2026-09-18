package dev.gpui.mobile;

import android.app.Activity;

/**
 * Optional platform-view bridge expected by gpui-mobile.
 *
 * <p>This demo deliberately renders only through GPUIX's native GPU surface.
 * It does not embed Android {@code View} controls, WebView, or a React Native
 * runtime. Returning {@code false} from {@link #createView} makes an accidental
 * platform-view request fail explicitly instead of leaving a partially-created
 * overlay behind.</p>
 */
public final class GpuiPlatformView {
    private GpuiPlatformView() {
    }

    public static boolean createView(
            Activity activity,
            String viewType,
            long viewId,
            float x,
            float y,
            float width,
            float height,
            String creationParams
    ) {
        return false;
    }

    public static void setBounds(long viewId, float x, float y, float width, float height) {
    }

    public static void setVisible(long viewId, boolean visible) {
    }

    public static void setZIndex(long viewId, int zIndex) {
    }

    public static void disposeView(long viewId) {
    }

    public static void pauseAll() {
    }

    public static void resumeAll() {
    }

    public static void disposeAll() {
    }
}
