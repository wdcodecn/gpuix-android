package dev.gpui.mobile;

import android.app.Activity;
import android.content.Context;
import android.graphics.Color;
import android.graphics.Rect;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.view.MotionEvent;
import android.view.View;
import android.view.ViewGroup;
import android.view.accessibility.AccessibilityEvent;
import android.view.accessibility.AccessibilityManager;
import android.view.accessibility.AccessibilityNodeInfo;
import android.view.accessibility.AccessibilityNodeProvider;
import android.widget.FrameLayout;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import org.json.JSONArray;
import org.json.JSONObject;

/**
 * On-demand TalkBack AccessibilityNodeProvider bridge.
 * Passes through all touch events when TalkBack is disabled (zero interference with NativeActivity).
 */
public final class GpuiAccessibilityBridge {

    private static final class A11yNode {
        long id;
        String role;
        String label;
        String value;
        boolean clickable;
        boolean checkable;
        boolean checked;
        boolean enabled;
        boolean focused;
        int left, top, right, bottom;
    }

    private static final Handler MAIN_HANDLER = new Handler(Looper.getMainLooper());
    private static volatile GpuiA11yHostView sHostView = null;
    private static volatile AccessibilityManager.AccessibilityStateChangeListener sListener = null;
    private static volatile List<A11yNode> sNodes = Collections.emptyList();
    private static volatile boolean sEnabled = false;

    private GpuiAccessibilityBridge() {
    }

    public static void attach(final Activity activity) {
        if (activity == null) return;
        MAIN_HANDLER.post(() -> {
            if (sHostView != null) return;
            AccessibilityManager am = (AccessibilityManager) activity.getSystemService(Context.ACCESSIBILITY_SERVICE);
            sEnabled = am != null && am.isEnabled();
            notifyStateChanged(sEnabled);

            if (am != null) {
                sListener = enabled -> {
                    sEnabled = enabled;
                    notifyStateChanged(enabled);
                };
                am.addAccessibilityStateChangeListener(sListener);
            }

            GpuiA11yHostView host = new GpuiA11yHostView(activity);
            activity.addContentView(host, new FrameLayout.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT,
                    ViewGroup.LayoutParams.MATCH_PARENT
            ));
            sHostView = host;
        });
    }

    public static void detach(final Activity activity) {
        MAIN_HANDLER.post(() -> {
            if (activity != null && sListener != null) {
                AccessibilityManager am = (AccessibilityManager) activity.getSystemService(Context.ACCESSIBILITY_SERVICE);
                if (am != null) am.removeAccessibilityStateChangeListener(sListener);
            }
            sListener = null;
            if (sHostView != null && sHostView.getParent() instanceof ViewGroup) {
                ((ViewGroup) sHostView.getParent()).removeView(sHostView);
            }
            sHostView = null;
            sNodes = Collections.emptyList();
        });
    }

    public static boolean isEnabled() {
        return sEnabled;
    }

    public static void updateTreeJson(final String nodesJson) {
        if (nodesJson == null || nodesJson.isEmpty()) return;
        final List<A11yNode> parsed = new ArrayList<>();
        try {
            JSONArray arr = new JSONArray(nodesJson);
            Activity act = GpuiActivity.currentActivity();
            float density = act != null ? act.getResources().getDisplayMetrics().density : 1.0f;
            for (int i = 0; i < arr.length(); i++) {
                JSONObject o = arr.optJSONObject(i);
                if (o == null) continue;
                A11yNode n = new A11yNode();
                n.id = o.optLong("id", i + 1L);
                n.role = o.optString("role", "generic");
                n.label = o.optString("label", "");
                n.value = o.optString("value", "");
                n.clickable = o.optBoolean("clickable", false);
                n.checkable = o.optBoolean("checkable", false);
                n.checked = o.optBoolean("checked", false);
                n.enabled = o.optBoolean("enabled", true);
                n.focused = o.optBoolean("focused", false);
                JSONArray b = o.optJSONArray("bounds");
                if (b != null && b.length() == 4) {
                    float x = (float) b.optDouble(0, 0) * density;
                    float y = (float) b.optDouble(1, 0) * density;
                    float w = (float) b.optDouble(2, 0) * density;
                    float h = (float) b.optDouble(3, 0) * density;
                    n.left = Math.round(x);
                    n.top = Math.round(y);
                    n.right = Math.round(x + w);
                    n.bottom = Math.round(y + h);
                }
                parsed.add(n);
            }
        } catch (Throwable ignored) {
            return;
        }
        sNodes = parsed;
        MAIN_HANDLER.post(() -> {
            GpuiA11yHostView host = sHostView;
            if (host != null && sEnabled) {
                host.sendAccessibilityEvent(AccessibilityEvent.TYPE_WINDOW_CONTENT_CHANGED);
            }
        });
    }

    private static void notifyStateChanged(boolean enabled) {
        try {
            nativeA11yStateChanged(enabled);
        } catch (UnsatisfiedLinkError ignored) {
        }
    }

    private static final class GpuiA11yHostView extends View {
        private final AccessibilityNodeProvider mProvider;

        GpuiA11yHostView(Context context) {
            super(context);
            setFocusable(false);
            setClickable(false);
            setBackgroundColor(Color.TRANSPARENT);
            setImportantForAccessibility(View.IMPORTANT_FOR_ACCESSIBILITY_YES);
            mProvider = new GpuiNodeProvider(this);
        }

        @Override
        public boolean onTouchEvent(MotionEvent event) {
            return false;
        }

        @Override
        public AccessibilityNodeProvider getAccessibilityNodeProvider() {
            return sEnabled ? mProvider : null;
        }
    }

    private static final class GpuiNodeProvider extends AccessibilityNodeProvider {
        private final View mHost;
        private int mFocusedId = View.NO_ID;

        GpuiNodeProvider(View host) {
            this.mHost = host;
        }

        @Override
        public AccessibilityNodeInfo createAccessibilityNodeInfo(int virtualViewId) {
            List<A11yNode> nodes = sNodes;
            int[] winLoc = new int[2];
            mHost.getLocationOnScreen(winLoc);

            if (virtualViewId == HOST_VIEW_ID) {
                AccessibilityNodeInfo root = AccessibilityNodeInfo.obtain(mHost);
                mHost.onInitializeAccessibilityNodeInfo(root);
                root.setPackageName(mHost.getContext().getPackageName());
                for (int i = 0; i < nodes.size(); i++) {
                    root.addChild(mHost, (int) nodes.get(i).id);
                }
                return root;
            }

            A11yNode target = null;
            for (int i = 0; i < nodes.size(); i++) {
                if ((int) nodes.get(i).id == virtualViewId) {
                    target = nodes.get(i);
                    break;
                }
            }
            if (target == null) return null;

            AccessibilityNodeInfo info = AccessibilityNodeInfo.obtain(mHost, virtualViewId);
            info.setPackageName(mHost.getContext().getPackageName());
            info.setParent(mHost);
            info.setClassName(androidClassName(target.role));
            info.setText(!target.value.isEmpty() ? target.value : target.label);
            info.setContentDescription(!target.label.isEmpty() ? target.label : target.value);
            info.setEnabled(target.enabled);
            info.setClickable(target.clickable);
            info.setCheckable(target.checkable);
            info.setChecked(target.checked);
            info.setFocusable(true);
            info.setFocused(target.focused);
            info.setVisibleToUser(true);
            info.setAccessibilityFocused(mFocusedId == virtualViewId);

            Rect parentBounds = new Rect(target.left, target.top, target.right, target.bottom);
            info.setBoundsInParent(parentBounds);
            Rect screenBounds = new Rect(
                    winLoc[0] + target.left,
                    winLoc[1] + target.top,
                    winLoc[0] + target.right,
                    winLoc[1] + target.bottom
            );
            info.setBoundsInScreen(screenBounds);

            if (target.clickable) {
                info.addAction(AccessibilityNodeInfo.ACTION_CLICK);
            }
            if (mFocusedId == virtualViewId) {
                info.addAction(AccessibilityNodeInfo.ACTION_CLEAR_ACCESSIBILITY_FOCUS);
            } else {
                info.addAction(AccessibilityNodeInfo.ACTION_ACCESSIBILITY_FOCUS);
            }
            return info;
        }

        @Override
        public boolean performAction(int virtualViewId, int action, Bundle arguments) {
            if (action == AccessibilityNodeInfo.ACTION_ACCESSIBILITY_FOCUS) {
                mFocusedId = virtualViewId;
                mHost.invalidate();
                return true;
            }
            if (action == AccessibilityNodeInfo.ACTION_CLEAR_ACCESSIBILITY_FOCUS) {
                if (mFocusedId == virtualViewId) mFocusedId = View.NO_ID;
                return true;
            }
            if (action == AccessibilityNodeInfo.ACTION_CLICK && virtualViewId != HOST_VIEW_ID) {
                try {
                    nativeA11yAction(virtualViewId, "click", null);
                } catch (UnsatisfiedLinkError ignored) {}
                return true;
            }
            return mHost.performAccessibilityAction(action, arguments);
        }

        private static String androidClassName(String role) {
            switch (role != null ? role : "") {
                case "button": return "android.widget.Button";
                case "textbox":
                case "searchbox": return "android.widget.EditText";
                case "checkbox": return "android.widget.CheckBox";
                case "switch": return "android.widget.Switch";
                case "radio": return "android.widget.RadioButton";
                case "slider": return "android.widget.SeekBar";
                case "heading":
                case "paragraph":
                case "text": return "android.widget.TextView";
                case "img": return "android.widget.ImageView";
                default: return "android.view.View";
            }
        }
    }

    public static native void nativeA11yStateChanged(boolean enabled);

    public static native void nativeA11yAction(long nodeId, String action, String arg);
}
