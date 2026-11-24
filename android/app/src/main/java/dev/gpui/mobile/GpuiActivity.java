package dev.gpui.mobile;

import android.app.NativeActivity;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ActivityInfo;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.graphics.Insets;
import android.graphics.Rect;
import android.media.AudioManager;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.text.InputType;
import android.util.Log;
import android.view.Display;
import android.view.DisplayCutout;
import android.view.KeyEvent;
import android.view.MotionEvent;
import android.view.View;
import android.view.ViewGroup;
import android.view.WindowInsets;
import android.view.WindowInsetsAnimation;
import android.view.WindowManager;
import android.view.inputmethod.BaseInputConnection;
import android.view.inputmethod.CursorAnchorInfo;
import android.view.inputmethod.EditorInfo;
import android.view.inputmethod.InputConnection;
import android.view.inputmethod.InputMethodManager;
import android.widget.FrameLayout;
import java.util.List;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicReference;

import androidx.core.splashscreen.SplashScreen;

/**
 * Custom Activity extending NativeActivity that integrates:
 * - AndroidX SplashScreen API (API 26–37)
 * - API 26–29 & API 30+ window insets + IME keyboard height tracking
 * - Full CJK / soft keyboard IME host via transparent GpuiImeView + InputConnection
 * - Predictive back / KEYCODE_BACK forwarding to Rust/JS
 * - DeepLink, runtime permissions, ActivityResult, PlatformView, and TalkBack bridges
 */
public class GpuiActivity extends NativeActivity {

    private static final String TAG = "GpuiActivity";

    /** Whether the native .so has been loaded via System.loadLibrary. */
    private static volatile boolean sNativeLibLoaded = false;

    /** Live activity reference used by thread-safe JNI system helpers. */
    private static volatile GpuiActivity sInstance = null;

    /** Current requested keyboard type (0=default,1=email,2=phone,3=number,4=uri,5=decimal). */
    private static volatile int sKeyboardType = 0;

    private static final Handler MAIN_HANDLER = new Handler(Looper.getMainLooper());

    private GpuiImeView mImeView;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        sInstance = this;
        SplashScreen splash = SplashScreen.installSplashScreen(this);

        if (!sNativeLibLoaded) {
            try {
                ActivityInfo ai = getPackageManager().getActivityInfo(
                        getComponentName(), PackageManager.GET_META_DATA);
                String libName = ai.metaData != null ? ai.metaData.getString("android.app.lib_name") : null;
                if (libName != null) {
                    System.loadLibrary(libName);
                    sNativeLibLoaded = true;
                }
            } catch (PackageManager.NameNotFoundException ignored) {
            } catch (UnsatisfiedLinkError e) {
                sNativeLibLoaded = true;
            }
        }

        splash.setKeepOnScreenCondition(() -> !isNativeReady());
        setVolumeControlStream(AudioManager.STREAM_MUSIC);

        super.onCreate(savedInstanceState);
        applyHighRefreshRate();

        setupInsetsHandling();
        setupImeView();
        setupBackHandler();
        GpuiAccessibilityBridge.attach(this);

        String initialUrl = extractDeepLink(getIntent());
        if (initialUrl != null && !initialUrl.isEmpty()) {
            GpuiNativeBridge.setInitialDeepLink(initialUrl);
        }
    }

    private void setupInsetsHandling() {
        final View decor = getWindow().getDecorView();
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            Api30InsetsHelper.setup(this, decor);
        } else {
            decor.setSystemUiVisibility(
                    View.SYSTEM_UI_FLAG_LAYOUT_STABLE
                            | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
                            | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION);
            decor.setOnApplyWindowInsetsListener((view, insets) -> {
                sendLegacyInsets(view, insets);
                return insets;
            });
            decor.getViewTreeObserver().addOnGlobalLayoutListener(() -> {
                WindowInsets rootInsets = decor.getRootWindowInsets();
                if (rootInsets != null) {
                    sendLegacyInsets(decor, rootInsets);
                }
            });
            decor.requestApplyInsets();
        }
    }

    @SuppressWarnings("deprecation")
    private static void sendLegacyInsets(View decor, WindowInsets insets) {
        int safeLeft = insets.getSystemWindowInsetLeft();
        int safeTop = insets.getSystemWindowInsetTop();
        int safeRight = insets.getSystemWindowInsetRight();
        int safeBottom = insets.getSystemWindowInsetBottom();
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            DisplayCutout cutout = insets.getDisplayCutout();
            if (cutout != null) {
                safeLeft = Math.max(safeLeft, cutout.getSafeInsetLeft());
                safeTop = Math.max(safeTop, cutout.getSafeInsetTop());
                safeRight = Math.max(safeRight, cutout.getSafeInsetRight());
                safeBottom = Math.max(safeBottom, cutout.getSafeInsetBottom());
            }
        }
        Rect visible = new Rect();
        decor.getWindowVisibleDisplayFrame(visible);
        int decorHeight = decor.getHeight();
        int imeBottom = 0;
        if (decorHeight > 0 && visible.bottom > 0) {
            int rawIme = decorHeight - visible.bottom - safeBottom;
            if (rawIme > decorHeight / 6) {
                imeBottom = rawIme + safeBottom;
            }
        }
        safeNativeInsetsChanged(safeLeft, safeTop, safeRight, safeBottom, 0, 0, 0, imeBottom);
    }

    private void setupImeView() {
        mImeView = new GpuiImeView(this);
        FrameLayout.LayoutParams params = new FrameLayout.LayoutParams(1, 1);
        addContentView(mImeView, params);
    }

    private void setupBackHandler() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            Api33BackHelper.register(this);
        }
    }

    private static void safeNativeInsetsChanged(
            int safeLeft, int safeTop, int safeRight, int safeBottom,
            int imeLeft, int imeTop, int imeRight, int imeBottom) {
        if (!sNativeLibLoaded) return;
        try {
            nativeInsetsChanged(safeLeft, safeTop, safeRight, safeBottom,
                    imeLeft, imeTop, imeRight, imeBottom);
        } catch (UnsatisfiedLinkError ignored) {
        }
    }

    private static void safeNativeBackPressed() {
        if (!sNativeLibLoaded) return;
        try {
            nativeBackPressed();
        } catch (UnsatisfiedLinkError e) {
            Log.w(TAG, "nativeBackPressed unavailable");
        }
    }

    private boolean isNativeReady() {
        if (!sNativeLibLoaded) {
            return false;
        }
        try {
            return nativeIsInitialized();
        } catch (UnsatisfiedLinkError e) {
            return false;
        }
    }

    @Override
    public boolean dispatchKeyEvent(KeyEvent event) {
        int keyCode = event.getKeyCode();
        switch (keyCode) {
            case KeyEvent.KEYCODE_VOLUME_UP:
            case KeyEvent.KEYCODE_VOLUME_DOWN:
            case KeyEvent.KEYCODE_VOLUME_MUTE:
            case KeyEvent.KEYCODE_MEDIA_PLAY:
            case KeyEvent.KEYCODE_MEDIA_PAUSE:
            case KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE:
            case KeyEvent.KEYCODE_MEDIA_NEXT:
            case KeyEvent.KEYCODE_MEDIA_PREVIOUS:
            case KeyEvent.KEYCODE_MEDIA_STOP:
            case KeyEvent.KEYCODE_HEADSETHOOK:
                return super.dispatchKeyEvent(event);

            case KeyEvent.KEYCODE_BACK:
                if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) {
                    if (event.getAction() == KeyEvent.ACTION_UP && !event.isCanceled()) {
                        safeNativeBackPressed();
                    }
                    return true;
                }
                return super.dispatchKeyEvent(event);

            default:
                return super.dispatchKeyEvent(event);
        }
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);

        String url = extractDeepLink(intent);
        if (url != null && !url.isEmpty()) {
            Log.i(TAG, "onNewIntent deeplink: " + url);
            GpuiNativeBridge.setInitialDeepLink(url);
            if (sNativeLibLoaded) {
                try {
                    nativeOnDeepLink(url);
                } catch (UnsatisfiedLinkError e) {
                    Log.w(TAG, "nativeOnDeepLink not available yet");
                }
            }
        }
    }

    private static String extractDeepLink(Intent intent) {
        if (intent == null) return null;
        String extraLink = intent.getStringExtra("gpuix_deeplink");
        if (extraLink != null && !extraLink.isEmpty()) {
            return extraLink;
        }
        Uri data = intent.getData();
        return data != null ? data.toString() : null;
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        GpuiNativeBridge.onRequestPermissionsResult(requestCode, permissions, grantResults);
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        GpuiNativeBridge.onActivityResult(requestCode, resultCode, data);
    }

    @Override
    protected void onPause() {
        if (sInstance == this) {
            GpuiPlatformView.pauseAll();
        }
        super.onPause();
    }

    @Override
    protected void onResume() {
        super.onResume();
        if (sInstance == this) {
            applyHighRefreshRate();
            GpuiPlatformView.resumeAll();
        }
    }

    @SuppressWarnings("deprecation")
    private void applyHighRefreshRate() {
        try {
            Display display = null;
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                display = getDisplay();
            }
            if (display == null) {
                WindowManager wm = getWindowManager();
                if (wm != null) {
                    display = wm.getDefaultDisplay();
                }
            }
            if (display == null) {
                return;
            }
            Display.Mode current = display.getMode();
            Display.Mode[] modes = display.getSupportedModes();
            if (current == null || modes == null) {
                return;
            }
            Display.Mode bestMode = current;
            for (Display.Mode mode : modes) {
                if (mode.getPhysicalWidth() == current.getPhysicalWidth()
                        && mode.getPhysicalHeight() == current.getPhysicalHeight()
                        && mode.getRefreshRate() > bestMode.getRefreshRate()) {
                    bestMode = mode;
                }
            }
            if (bestMode.getRefreshRate() > 1f) {
                WindowManager.LayoutParams lp = getWindow().getAttributes();
                if (lp.preferredDisplayModeId != bestMode.getModeId()
                        || Math.abs(lp.preferredRefreshRate - bestMode.getRefreshRate()) > 0.5f) {
                    lp.preferredDisplayModeId = bestMode.getModeId();
                    lp.preferredRefreshRate = bestMode.getRefreshRate();
                    getWindow().setAttributes(lp);
                    Log.i(TAG, "Applied high refresh mode: id=" + bestMode.getModeId()
                            + " rate=" + bestMode.getRefreshRate() + "Hz");
                }
            }
        } catch (Throwable t) {
            Log.w(TAG, "applyHighRefreshRate failed", t);
        }
    }

    @Override
    protected void onDestroy() {
        if (sInstance == this) {
            GpuiAccessibilityBridge.detach(this);
            GpuiNativeBridge.cleanup();
            GpuiWebSocket.closeAll();
            GpuiPlatformView.disposeAll();
            sInstance = null;
        }
        super.onDestroy();
    }

    // ── IME bridge (invoked from Rust via JNI) ───────────────────────────────

    /** Show software keyboard via GpuiImeView InputConnection on UI thread. */
    public static void showIme(final int keyboardType) {
        sKeyboardType = keyboardType;
        final GpuiActivity activity = sInstance;
        if (activity == null) return;
        MAIN_HANDLER.post(() -> {
            if (activity.mImeView == null) return;
            activity.mImeView.requestFocus();
            InputMethodManager imm = (InputMethodManager) activity.getSystemService(Context.INPUT_METHOD_SERVICE);
            if (imm != null) {
                imm.restartInput(activity.mImeView);
                imm.showSoftInput(activity.mImeView, InputMethodManager.SHOW_IMPLICIT);
            }
        });
    }

    /** Hide software keyboard on UI thread. */
    public static void hideIme() {
        final GpuiActivity activity = sInstance;
        if (activity == null) return;
        MAIN_HANDLER.post(() -> {
            InputMethodManager imm = (InputMethodManager) activity.getSystemService(Context.INPUT_METHOD_SERVICE);
            if (imm != null && activity.getWindow() != null) {
                View target = activity.mImeView != null ? activity.mImeView : activity.getWindow().getDecorView();
                imm.hideSoftInputFromWindow(target.getWindowToken(), 0);
            }
        });
    }

    /** Update IME candidate/cursor anchor bounds safely on UI thread. */
    public static void updateImeCursor(final float x, final float y, final float height) {
        final GpuiActivity activity = sInstance;
        if (activity == null) return;
        MAIN_HANDLER.post(() -> {
            if (activity.mImeView == null) return;
            try {
                InputMethodManager imm = (InputMethodManager) activity.getSystemService(Context.INPUT_METHOD_SERVICE);
                if (imm == null) return;
                float density = activity.getResources().getDisplayMetrics().density;
                float px = x * density;
                float py = y * density;
                float ph = Math.max(1f, height * density);
                CursorAnchorInfo info = new CursorAnchorInfo.Builder()
                        .setInsertionMarkerLocation(px, py, py + ph * 0.8f, py + ph, CursorAnchorInfo.FLAG_HAS_VISIBLE_REGION)
                        .build();
                imm.updateCursorAnchorInfo(activity.mImeView, info);
            } catch (Throwable ignored) {
            }
        });
    }

    /** Move task to background when back press is not consumed by JS UI. */
    public static void moveAppToBack() {
        final GpuiActivity activity = sInstance;
        if (activity == null) return;
        MAIN_HANDLER.post(() -> {
            try {
                activity.moveTaskToBack(true);
            } catch (Throwable ignored) {
            }
        });
    }

    /** Public accessor for other bridge helpers. */
    public static GpuiActivity currentActivity() {
        return sInstance;
    }

    // ── Clipboard helpers (invoked from Rust via JNI) ────────────────────────

    /** Thread-safe clipboard reader invoked from Rust via JNI. */
    public static String getClipboardText() {
        final GpuiActivity activity = sInstance;
        if (activity == null) {
            return null;
        }
        RunnableWithResult<String> task = () -> {
            try {
                ClipboardManager cm = (ClipboardManager) activity.getSystemService(Context.CLIPBOARD_SERVICE);
                if (cm == null || !cm.hasPrimaryClip()) {
                    return null;
                }
                ClipData clip = cm.getPrimaryClip();
                if (clip == null || clip.getItemCount() == 0) {
                    return null;
                }
                CharSequence text = clip.getItemAt(0).coerceToText(activity);
                return text != null ? text.toString() : null;
            } catch (Throwable ignored) {
                return null;
            }
        };
        if (Looper.myLooper() == Looper.getMainLooper()) {
            return task.run();
        }
        final AtomicReference<String> ref = new AtomicReference<>(null);
        final CountDownLatch latch = new CountDownLatch(1);
        MAIN_HANDLER.post(() -> {
            try {
                ref.set(task.run());
            } finally {
                latch.countDown();
            }
        });
        try {
            latch.await(500, TimeUnit.MILLISECONDS);
        } catch (InterruptedException ignored) {
            Thread.currentThread().interrupt();
        }
        return ref.get();
    }

    /** Thread-safe clipboard writer invoked from Rust via JNI. */
    public static boolean setClipboardText(final String text) {
        final GpuiActivity activity = sInstance;
        if (activity == null || text == null) {
            return false;
        }
        RunnableWithResult<Boolean> task = () -> {
            try {
                ClipboardManager cm = (ClipboardManager) activity.getSystemService(Context.CLIPBOARD_SERVICE);
                if (cm == null) {
                    return false;
                }
                cm.setPrimaryClip(ClipData.newPlainText("gpuix", text));
                return true;
            } catch (Throwable ignored) {
                return false;
            }
        };
        if (Looper.myLooper() == Looper.getMainLooper()) {
            return Boolean.TRUE.equals(task.run());
        }
        final AtomicBoolean ok = new AtomicBoolean(false);
        final CountDownLatch latch = new CountDownLatch(1);
        MAIN_HANDLER.post(() -> {
            try {
                ok.set(Boolean.TRUE.equals(task.run()));
            } finally {
                latch.countDown();
            }
        });
        try {
            latch.await(500, TimeUnit.MILLISECONDS);
        } catch (InterruptedException ignored) {
            Thread.currentThread().interrupt();
        }
        return ok.get();
    }

    private interface RunnableWithResult<T> {
        T run();
    }

    // ── Version-isolated helper classes ──────────────────────────────────────

    private static final class Api30InsetsHelper {
        static void setup(GpuiActivity activity, View decor) {
            activity.getWindow().setDecorFitsSystemWindows(false);
            decor.setOnApplyWindowInsetsListener((view, insets) -> {
                sendInsets(insets);
                return insets;
            });
            decor.setWindowInsetsAnimationCallback(new WindowInsetsAnimation.Callback(
                    WindowInsetsAnimation.Callback.DISPATCH_MODE_CONTINUE_ON_SUBTREE) {
                @Override
                public WindowInsets onProgress(WindowInsets insets, List<WindowInsetsAnimation> running) {
                    sendInsets(insets);
                    return insets;
                }
            });
            decor.requestApplyInsets();
        }

        private static void sendInsets(WindowInsets insets) {
            Insets safe = insets.getInsets(WindowInsets.Type.systemBars() | WindowInsets.Type.displayCutout());
            Insets ime = insets.getInsets(WindowInsets.Type.ime());
            safeNativeInsetsChanged(safe.left, safe.top, safe.right, safe.bottom,
                    ime.left, ime.top, ime.right, ime.bottom);
        }
    }

    private static final class Api33BackHelper {
        static void register(GpuiActivity activity) {
            activity.getOnBackInvokedDispatcher().registerOnBackInvokedCallback(
                    android.window.OnBackInvokedDispatcher.PRIORITY_DEFAULT,
                    GpuiActivity::safeNativeBackPressed
            );
        }
    }

    // ── Transparent CJK IME Host View & InputConnection ──────────────────────

    private static final class GpuiImeView extends View {
        GpuiImeView(Context context) {
            super(context);
            setFocusable(true);
            setFocusableInTouchMode(true);
            setClickable(false);
            setLongClickable(false);
            setBackgroundColor(Color.TRANSPARENT);
            setImportantForAccessibility(View.IMPORTANT_FOR_ACCESSIBILITY_NO);
        }

        @Override
        public boolean onTouchEvent(MotionEvent event) {
            return false;
        }

        @Override
        public boolean onCheckIsTextEditor() {
            return true;
        }

        @Override
        public InputConnection onCreateInputConnection(EditorInfo outAttrs) {
            int inputType;
            switch (sKeyboardType) {
                case 1:
                    inputType = InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_EMAIL_ADDRESS;
                    break;
                case 2:
                    inputType = InputType.TYPE_CLASS_PHONE;
                    break;
                case 3:
                    inputType = InputType.TYPE_CLASS_NUMBER;
                    break;
                case 4:
                    inputType = InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_URI;
                    break;
                case 5:
                    inputType = InputType.TYPE_CLASS_NUMBER | InputType.TYPE_NUMBER_FLAG_DECIMAL;
                    break;
                default:
                    inputType = InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_FLAG_MULTI_LINE;
                    break;
            }
            outAttrs.inputType = inputType;
            outAttrs.imeOptions = EditorInfo.IME_FLAG_NO_EXTRACT_UI | EditorInfo.IME_ACTION_DONE;
            return new GpuiInputConnection(this);
        }
    }

    private static final class GpuiInputConnection extends BaseInputConnection {
        GpuiInputConnection(View targetView) {
            super(targetView, false);
        }

        @Override
        public boolean commitText(CharSequence text, int newCursorPosition) {
            if (sNativeLibLoaded && text != null) {
                try {
                    nativeImeCommitText(text.toString());
                } catch (UnsatisfiedLinkError ignored) {
                }
            }
            return true;
        }

        @Override
        public boolean setComposingText(CharSequence text, int newCursorPosition) {
            if (sNativeLibLoaded) {
                try {
                    nativeImeSetComposingText(text != null ? text.toString() : "");
                } catch (UnsatisfiedLinkError ignored) {
                }
            }
            return true;
        }

        @Override
        public boolean finishComposingText() {
            if (sNativeLibLoaded) {
                try {
                    nativeImeFinishComposing();
                } catch (UnsatisfiedLinkError ignored) {
                }
            }
            return true;
        }

        @Override
        public boolean deleteSurroundingText(int beforeLength, int afterLength) {
            if (sNativeLibLoaded && (beforeLength > 0 || afterLength > 0)) {
                try {
                    nativeImeDeleteSurrounding(beforeLength, afterLength);
                } catch (UnsatisfiedLinkError ignored) {
                }
            }
            return true;
        }

        @Override
        public boolean deleteSurroundingTextInCodePoints(int beforeLength, int afterLength) {
            if (sNativeLibLoaded && (beforeLength > 0 || afterLength > 0)) {
                try {
                    nativeImeDeleteSurrounding(beforeLength, afterLength);
                } catch (UnsatisfiedLinkError ignored) {
                }
            }
            return true;
        }

        @Override
        public boolean performEditorAction(int editorAction) {
            if (sNativeLibLoaded) {
                try {
                    nativeImeEditorAction(editorAction);
                } catch (UnsatisfiedLinkError ignored) {
                }
            }
            return true;
        }

        @Override
        public boolean sendKeyEvent(KeyEvent event) {
            if (event != null && event.getAction() == KeyEvent.ACTION_DOWN && sNativeLibLoaded) {
                int code = event.getKeyCode();
                if (code == KeyEvent.KEYCODE_DEL) {
                    try {
                        nativeImeDeleteSurrounding(1, 0);
                    } catch (UnsatisfiedLinkError ignored) {
                    }
                    return true;
                }
                if (code == KeyEvent.KEYCODE_ENTER || code == KeyEvent.KEYCODE_NUMPAD_ENTER) {
                    try {
                        nativeImeEditorAction(EditorInfo.IME_ACTION_DONE);
                    } catch (UnsatisfiedLinkError ignored) {
                    }
                    return true;
                }
                int unicode = event.getUnicodeChar();
                if (unicode > 0) {
                    try {
                        nativeImeCommitText(new String(Character.toChars(unicode)));
                    } catch (UnsatisfiedLinkError ignored) {
                    }
                    return true;
                }
            }
            return super.sendKeyEvent(event);
        }
    }

    // ── JNI methods implemented by Rust gpui-mobile ──────────────────────────

    private static native boolean nativeIsInitialized();

    private static native void nativeOnDeepLink(String url);

    private static native void nativeInsetsChanged(int safeLeft, int safeTop, int safeRight,
            int safeBottom, int imeLeft, int imeTop, int imeRight, int imeBottom);

    private static native void nativeImeCommitText(String text);

    private static native void nativeImeSetComposingText(String text);

    private static native void nativeImeFinishComposing();

    private static native void nativeImeDeleteSurrounding(int before, int after);

    private static native void nativeImeEditorAction(int actionCode);

    private static native void nativeBackPressed();
}
