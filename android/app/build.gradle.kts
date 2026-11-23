import java.util.Properties

plugins { id("com.android.application") }

val gpuixProperties = Properties().apply {
    val configFile = rootProject.projectDir.resolve(".build/gpuix.android.properties")
    if (configFile.isFile) {
        configFile.reader(Charsets.UTF_8).use(::load)
    }
}
val gpuixAppId = gpuixProperties.getProperty("appId") ?: "dev.gpui.app"
val gpuixAppName = gpuixProperties.getProperty("appName") ?: "GPUIX App"
val gpuixVersionName = gpuixProperties.getProperty("versionName") ?: "0.1.0"
val gpuixVersionCode = gpuixProperties.getProperty("versionCode")?.toIntOrNull() ?: 1
val gpuixAbisRaw = gpuixProperties.getProperty("abis") ?: System.getenv("GPUIX_ABIS") ?: "arm64-v8a"
val gpuixAbis = gpuixAbisRaw.split(",").map { it.trim() }.filter { it.isNotEmpty() }.ifEmpty { listOf("arm64-v8a") }

android {
    namespace = gpuixAppId
    compileSdk {
        version = release(37) { minorApiLevel = 2 }
    }
    buildToolsVersion = "37.0.0"
    ndkVersion = "30.0.16248370"
    sourceSets.getByName("main").assets.srcDir(rootProject.projectDir.resolve(".build/assets"))
    androidResources {
        // Keep Hermes bytecode uncompressed and page-aligned in the APK for zero-copy mmap.
        noCompress += listOf("hbc")
    }
    buildFeatures {
        // AGP 9 disables generated resource values by default. The app label
        // is generated from gpuix.android.json for each consumer project.
        resValues = true
    }
    defaultConfig {
        applicationId = gpuixAppId
        // Support Android 8.0+ (API 26) while keeping API 30+ capabilities runtime-gated.
        minSdk = 26
        targetSdk = 37
        versionCode = gpuixVersionCode
        versionName = gpuixVersionName
        ndk { abiFilters += gpuixAbis }
        resValue("string", "gpuix_app_name", gpuixAppName)
    }
    buildTypes {
        debug { isDebuggable = true }
        // Local release artifacts use the debug keystore so the starter can
        // be installed immediately. Configure a real upload key before store
        // distribution; `gpuix doctor` reports this boundary explicitly.
        release {
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro"
            )
            signingConfig = signingConfigs.getByName("debug")
        }
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_1_8
        targetCompatibility = JavaVersion.VERSION_1_8
    }
}

dependencies { implementation("androidx.core:core-splashscreen:1.2.0") }
