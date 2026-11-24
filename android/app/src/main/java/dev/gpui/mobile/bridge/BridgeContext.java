package dev.gpui.mobile.bridge;

import android.app.Activity;
import android.content.Intent;
import android.os.Handler;
import android.os.Looper;
import dev.gpui.mobile.GpuiActivity;
import dev.gpui.mobile.GpuiNativeBridge;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.atomic.AtomicInteger;

/**
 * Shared execution, callback, and lifecycle context for modular GPUIX bridge plugins.
 */
public final class BridgeContext {

    public interface ActivityResultConsumer {
        void onResult(int resultCode, Intent data);
    }

    public interface PermissionResultConsumer {
        void onResult(String[] permissions, int[] grantResults);
    }

    public static final Handler MAIN_HANDLER = new Handler(Looper.getMainLooper());
    public static final ExecutorService WORKER = Executors.newCachedThreadPool();
    public static final ScheduledExecutorService SCHEDULER = Executors.newScheduledThreadPool(2);

    private static final ConcurrentHashMap<Integer, PermissionResultConsumer> PERM_WAITERS = new ConcurrentHashMap<>();
    private static final ConcurrentHashMap<Integer, ActivityResultConsumer> ACT_WAITERS = new ConcurrentHashMap<>();
    private static final CopyOnWriteArrayList<Runnable> CLEANUPS = new CopyOnWriteArrayList<>();
    private static final AtomicInteger NEXT_REQ_CODE = new AtomicInteger(4100);

    private BridgeContext() {
    }

    public static Activity currentActivity() {
        return GpuiActivity.currentActivity();
    }

    public static void registerCleanup(Runnable cleanup) {
        if (cleanup != null) {
            CLEANUPS.addIfAbsent(cleanup);
        }
    }

    public static void runCleanups() {
        for (Runnable cleanup : CLEANUPS) {
            try {
                cleanup.run();
            } catch (Throwable ignored) {
            }
        }
        PERM_WAITERS.clear();
        ACT_WAITERS.clear();
    }

    public static void resolve(long requestId, Object result) {
        GpuiNativeBridge.resolve(requestId, result);
    }

    public static void reject(long requestId, String error) {
        GpuiNativeBridge.reject(requestId, error);
    }

    public static void emitEvent(String channel, Object payload) {
        GpuiNativeBridge.emitEvent(channel, payload);
    }

    public static void startActivityForResult(Activity activity, Intent intent, ActivityResultConsumer consumer) {
        int code = NEXT_REQ_CODE.getAndIncrement();
        ACT_WAITERS.put(code, consumer);
        MAIN_HANDLER.post(() -> {
            try {
                activity.startActivityForResult(intent, code);
            } catch (Throwable t) {
                ACT_WAITERS.remove(code);
                consumer.onResult(Activity.RESULT_CANCELED, null);
            }
        });
    }

    public static void requestPermissions(Activity activity, String[] perms, PermissionResultConsumer consumer) {
        int code = NEXT_REQ_CODE.getAndIncrement();
        PERM_WAITERS.put(code, consumer);
        MAIN_HANDLER.post(() -> {
            try {
                activity.requestPermissions(perms, code);
            } catch (Throwable t) {
                PERM_WAITERS.remove(code);
                consumer.onResult(perms, new int[0]);
            }
        });
    }

    public static void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
        PermissionResultConsumer consumer = PERM_WAITERS.remove(requestCode);
        if (consumer != null) {
            consumer.onResult(permissions, grantResults);
        }
    }

    public static void onActivityResult(int requestCode, int resultCode, Intent data) {
        ActivityResultConsumer consumer = ACT_WAITERS.remove(requestCode);
        if (consumer != null) {
            consumer.onResult(resultCode, data);
        }
    }
}
