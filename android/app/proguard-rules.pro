# Keep GPUIX NativeActivity host, bridges, and JNI entrypoints intact under R8.
-keep class dev.gpui.mobile.** { *; }
-keepclassmembers class dev.gpui.mobile.** {
    native <methods>;
    <methods>;
}
-keep class android.app.NativeActivity { *; }
-keep class androidx.core.splashscreen.** { *; }
-keep class org.json.** { *; }
-dontwarn java.lang.invoke.**
-dontwarn android.window.OnBackInvokedCallback
-dontwarn android.window.OnBackInvokedDispatcher
