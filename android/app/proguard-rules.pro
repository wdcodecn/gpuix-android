# Keep GPUIX NativeActivity host and JNI entrypoints intact under R8.
-keep class dev.gpui.mobile.** { *; }
-keepclassmembers class dev.gpui.mobile.** {
    native <methods>;
    <methods>;
}
-keep class android.app.NativeActivity { *; }
-keep class androidx.core.splashscreen.** { *; }
-dontwarn java.lang.invoke.**
