plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

// Alamat server default (Cloudflare Workers). Bisa diganti saat build:
//   ./gradlew assembleRelease -PserverUrl=https://kasir-five5star.akun-anda.workers.dev
val serverUrl: String = (project.findProperty("serverUrl") as String?) ?: ""

android {
    namespace = "com.five5star.kasir"
    compileSdk = 35

    defaultConfig {
        applicationId = "com.five5star.kasir"
        minSdk = 26
        targetSdk = 35
        versionCode = 1
        versionName = "1.0.0"
        buildConfigField("String", "DEFAULT_SERVER_URL", "\"$serverUrl\"")
    }

    buildFeatures { buildConfig = true }

    signingConfigs {
        // Keystore rilis dari environment (dipakai GitHub Actions). Jika tidak ada, rilis ditandatangani kunci debug.
        val ks = System.getenv("ANDROID_KEYSTORE_FILE")
        if (ks != null && file(ks).exists()) {
            create("release") {
                storeFile = file(ks)
                storePassword = System.getenv("ANDROID_KEYSTORE_PASSWORD")
                keyAlias = System.getenv("ANDROID_KEY_ALIAS")
                keyPassword = System.getenv("ANDROID_KEY_PASSWORD")
            }
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            signingConfig = signingConfigs.findByName("release") ?: signingConfigs.getByName("debug")
        }
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions { jvmTarget = "17" }
}

dependencies {
    implementation("androidx.core:core-ktx:1.13.1")
    implementation("androidx.appcompat:appcompat:1.7.0")
    implementation("androidx.webkit:webkit:1.12.1")
}
