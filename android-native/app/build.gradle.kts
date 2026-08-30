import groovy.json.JsonSlurper
import org.gradle.api.GradleException
import java.net.URI

plugins {
    id("com.android.application")
    id("com.google.gms.google-services")
    id("org.jetbrains.kotlin.android")
    id("org.jetbrains.kotlin.plugin.compose")
}

fun configValue(gradleProperty: String, environmentVariable: String, fallback: String? = null): String? =
    providers.gradleProperty(gradleProperty)
        .orElse(providers.environmentVariable(environmentVariable))
        .orNull
        ?.trim()
        ?.takeIf(String::isNotEmpty)
        ?: fallback

fun quoted(value: String): String = "\"${value.replace("\\", "\\\\").replace("\"", "\\\"")}\""

// Play identity is deliberately not configurable from CI or a developer workstation. Keeping the
// identity in one place prevents a staging/package override from producing an artifact that cannot
// update the installed application.
val productionApplicationId = "online.alarabiya.store"
val productionVersionCode = 13
val productionVersionName = "1.0.2"
val expectedProductionEndpoint = "https://srv1548487.hstgr.cloud"

fun httpsEndpoint(gradleProperty: String, environmentVariable: String, fallback: String): String =
    requireNotNull(configValue(gradleProperty, environmentVariable, fallback)).also { value ->
        if (!value.startsWith("https://")) {
            throw GradleException("$gradleProperty/$environmentVariable must be an HTTPS URL.")
        }
    }.removeSuffix("/")

fun developmentEndpoint(gradleProperty: String, environmentVariable: String, fallback: String): String =
    requireNotNull(configValue(gradleProperty, environmentVariable, fallback)).also { value ->
        val uri = runCatching { URI(value) }.getOrNull()
        val host = uri?.host?.lowercase()
        val cleanAuthority = uri?.userInfo == null && uri?.query == null && uri?.fragment == null
        val cleanPath = uri?.path.isNullOrEmpty() || uri?.path == "/"
        val isHttps = uri?.scheme.equals("https", ignoreCase = true) && !host.isNullOrBlank()
        val isLoopbackHttp = uri?.scheme.equals("http", ignoreCase = true) &&
            host in setOf("10.0.2.2", "127.0.0.1", "localhost")
        if (cleanAuthority != true || !cleanPath || (!isHttps && !isLoopbackHttp)) {
            throw GradleException(
                "$gradleProperty/$environmentVariable must use HTTPS, or HTTP only on an Android loopback host.",
            )
        }
    }.removeSuffix("/")

val devBaseUrl = developmentEndpoint("alrueyaDevBaseUrl", "ALRUEYA_DEV_BASE_URL", "https://dev.invalid")
val stagingBaseUrl = httpsEndpoint("alrueyaStagingBaseUrl", "ALRUEYA_STAGING_BASE_URL", "https://staging.invalid")
val productionBaseUrl = httpsEndpoint(
    "alrueyaProdBaseUrl",
    "ALRUEYA_PROD_BASE_URL",
    expectedProductionEndpoint,
)
val remotePushConfigured = when (
    val value = configValue("remotePushConfigured", "REMOTE_PUSH_CONFIGURED", "false")?.lowercase()
) {
    "true" -> true
    "false" -> false
    else -> throw GradleException("remotePushConfigured/REMOTE_PUSH_CONFIGURED must be true or false.")
}
val notificationDeepLinkScheme = requireNotNull(
    configValue("notificationDeepLinkScheme", "NOTIFICATION_DEEP_LINK_SCHEME", "alrueya"),
).also { value ->
    if (!value.matches(Regex("[a-z][a-z0-9+.-]*"))) {
        throw GradleException("notificationDeepLinkScheme must be a lowercase URI scheme.")
    }
}

val releaseKeystorePath = configValue("androidKeystorePath", "ANDROID_KEYSTORE_PATH")
val releaseKeystorePassword = configValue("androidKeystorePassword", "ANDROID_KEYSTORE_PASSWORD")
val releaseKeyAlias = configValue("androidKeyAlias", "ANDROID_KEY_ALIAS")
val releaseKeyPassword = configValue("androidKeyPassword", "ANDROID_KEY_PASSWORD")
val releaseSigningValues = listOf(
    releaseKeystorePath,
    releaseKeystorePassword,
    releaseKeyAlias,
    releaseKeyPassword,
)
val releaseSigningReady = releaseSigningValues.all { !it.isNullOrBlank() }
val releaseSigningPartiallyConfigured = releaseSigningValues.any { !it.isNullOrBlank() } && !releaseSigningReady
if (releaseSigningPartiallyConfigured) {
    throw GradleException(
        "Android release signing is only partially configured. Provide all four ANDROID_KEYSTORE_* variables " +
            "(or androidKeystorePath/androidKeystorePassword/androidKeyAlias/androidKeyPassword Gradle properties).",
    )
}

android {
    namespace = "online.alarabiya.superapp"
    compileSdk = 36

    defaultConfig {
        // Preserve the installed Play application identity while replacing the legacy TWA client.
        applicationId = productionApplicationId
        minSdk = 26
        targetSdk = 36
        versionCode = productionVersionCode
        versionName = productionVersionName

        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
        vectorDrawables.useSupportLibrary = true
        buildConfigField("String", "PUSH_PROVIDER", quoted("fcm"))
        buildConfigField("Boolean", "REMOTE_PUSH_CONFIGURED", remotePushConfigured.toString())
        buildConfigField("String", "NOTIFICATION_DEEP_LINK_SCHEME", quoted(notificationDeepLinkScheme))
        manifestPlaceholders["notificationDeepLinkScheme"] = notificationDeepLinkScheme
        manifestPlaceholders["firebaseMessagingAutoInitEnabled"] = remotePushConfigured.toString()
        manifestPlaceholders["firebaseMessagingInstallationIdEnabled"] = remotePushConfigured.toString()
    }

    flavorDimensions += "environment"
    productFlavors {
        create("dev") {
            dimension = "environment"
            versionNameSuffix = "-dev"
            buildConfigField("String", "ERP_BASE_URL", quoted(devBaseUrl))
            buildConfigField("String", "ENVIRONMENT", quoted("dev"))
        }
        create("staging") {
            dimension = "environment"
            versionNameSuffix = "-staging"
            buildConfigField("String", "ERP_BASE_URL", quoted(stagingBaseUrl))
            buildConfigField("String", "ENVIRONMENT", quoted("staging"))
        }
        create("prod") {
            dimension = "environment"
            buildConfigField("String", "ERP_BASE_URL", quoted(productionBaseUrl))
            buildConfigField("String", "ENVIRONMENT", quoted("prod"))
        }
    }

    signingConfigs {
        create("release") {
            if (releaseSigningReady) {
                storeFile = file(requireNotNull(releaseKeystorePath))
                storePassword = releaseKeystorePassword
                keyAlias = releaseKeyAlias
                keyPassword = releaseKeyPassword
            }
        }
    }

    buildTypes {
        debug {
            applicationIdSuffix = ".debug"
            versionNameSuffix = "-debug"
        }
        release {
            isMinifyEnabled = true
            isShrinkResources = true
            if (releaseSigningReady) signingConfig = signingConfigs.getByName("release")
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro",
            )
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions.jvmTarget = "17"

    buildFeatures {
        compose = true
        buildConfig = true
    }

    packaging.resources.excludes += "/META-INF/{AL2.0,LGPL2.1}"
    // The app owns no NDK code. These optional AndroidX libraries are unreachable in this
    // single-process app (no PathIterator or MultiProcessDataStore use), and their upstream AARs
    // ship pre-stripped binaries with no public symbols. Compose/Firebase BOM upgrades must re-audit
    // this reachability on API 26 before updating the source-contract pins below.
    packaging.jniLibs.excludes += setOf(
        "**/libandroidx.graphics.path.so",
        "**/libdatastore_shared_counter.so",
    )

    testOptions {
        animationsDisabled = true
        managedDevices {
            localDevices {
                create("phoneApi26") {
                    device = "Pixel 2"
                    apiLevel = 26
                    systemImageSource = "aosp"
                }
                create("phoneApi35") {
                    device = "Pixel 2"
                    apiLevel = 35
                    systemImageSource = "aosp"
                }
                create("tabletApi35") {
                    // Nexus 7 keeps a real >= 600dp tablet viewport while avoiding the
                    // 4 GB Nexus 9 emulator allocation that exhausts hosted CI runners.
                    device = "Nexus 7 (2012)"
                    apiLevel = 35
                    systemImageSource = "aosp"
                }
            }
        }
    }
}

// Only dev/staging debug builds and the production release are valid deliverables. This makes it
// impossible to accidentally run a debuggable build against the production ERP endpoint.
androidComponents {
    beforeVariants(selector().all()) { variant ->
        val environment = variant.productFlavors.firstOrNull { it.first == "environment" }?.second
        variant.enable = when (variant.buildType) {
            "debug" -> environment == "dev" || environment == "staging"
            "release" -> environment == "prod"
            else -> false
        }
    }
}

// Local/PR builds intentionally keep remote push disabled and therefore do not need a Firebase
// project file. A production release with REMOTE_PUSH_CONFIGURED=true executes the official
// google-services task and fails closed when google-services.json is absent or mismatched.
tasks.matching { it.name.matches(Regex("process.+GoogleServices")) }.configureEach {
    enabled = remotePushConfigured
}

val verifyReleaseSigning by tasks.registering {
    group = "verification"
    description = "Fails unless all production upload-signing inputs are present and the keystore exists."
    doLast {
        if (!releaseSigningReady) {
            throw GradleException(
                "Signed Android release requested, but ANDROID_KEYSTORE_PATH, ANDROID_KEYSTORE_PASSWORD, " +
                    "ANDROID_KEY_ALIAS and ANDROID_KEY_PASSWORD are not all configured.",
            )
        }
        val keystore = file(requireNotNull(releaseKeystorePath))
        if (!keystore.isFile) throw GradleException("Android release keystore does not exist: $keystore")
    }
}

val verifyProductionReleaseInputs by tasks.registering {
    group = "verification"
    description = "Fails closed unless the Play identity, signing, endpoint, and Firebase client are production-ready."
    dependsOn(verifyReleaseSigning)
    doLast {
        if (productionApplicationId != "online.alarabiya.store") {
            throw GradleException("Unexpected production applicationId.")
        }
        if (productionVersionCode != 13 || productionVersionName != "1.0.2") {
            throw GradleException("Unexpected production version contract.")
        }
        if (productionBaseUrl != expectedProductionEndpoint) {
            throw GradleException("The production endpoint does not match the approved endpoint.")
        }
        if (!remotePushConfigured) {
            throw GradleException("Production release requires REMOTE_PUSH_CONFIGURED=true.")
        }

        val firebaseConfig = file("google-services.json")
        if (!firebaseConfig.isFile) {
            throw GradleException("Production release requires app/google-services.json.")
        }
        val json = runCatching { JsonSlurper().parse(firebaseConfig) as? Map<*, *> }
            .getOrElse { throw GradleException("app/google-services.json is not valid JSON.") }
            ?: throw GradleException("app/google-services.json must contain a JSON object.")
        val clients = json["client"] as? List<*>
        val packageMatches = clients?.any { rawClient ->
            val client = rawClient as? Map<*, *> ?: return@any false
            val clientInfo = client["client_info"] as? Map<*, *> ?: return@any false
            val androidClientInfo = clientInfo["android_client_info"] as? Map<*, *> ?: return@any false
            androidClientInfo["package_name"] == productionApplicationId
        }
        if (packageMatches != true) {
            throw GradleException("Firebase Android client does not match the production applicationId.")
        }
    }
}

// A production artifact is never allowed to exist unsigned. Lint and compilation tasks can still
// run without secrets, but both Play (AAB) and direct-install (APK) packaging fail closed.
tasks.matching {
    it.name == "bundleProdRelease" ||
        it.name == "assembleProdRelease" ||
        it.name == "packageProdRelease" ||
        it.name == "packageProdReleaseBundle" ||
        it.name == "packageProdReleaseUniversalApk" ||
        it.name == "signProdReleaseBundle" ||
        it.name == "zipApksForProdRelease"
}.configureEach {
    dependsOn(verifyProductionReleaseInputs)
}

dependencies {
    val composeBom = platform("androidx.compose:compose-bom:2025.05.01")
    implementation(composeBom)
    androidTestImplementation(composeBom)

    implementation("androidx.core:core-ktx:1.16.0")
    implementation("androidx.core:core-splashscreen:1.2.0")
    implementation("androidx.activity:activity-compose:1.10.1")
    implementation("androidx.lifecycle:lifecycle-runtime-compose:2.9.0")
    implementation("androidx.lifecycle:lifecycle-viewmodel-compose:2.9.0")
    implementation("androidx.compose.ui:ui")
    implementation("androidx.compose.ui:ui-tooling-preview")
    implementation("androidx.compose.foundation:foundation")
    implementation("androidx.compose.material3:material3")
    implementation("androidx.compose.material:material-icons-extended")
    implementation("androidx.biometric:biometric:1.1.0")
    implementation("androidx.navigation:navigation-compose:2.9.8")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.10.2")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-play-services:1.10.2")
    // Scanner/OCR engines are downloaded and executed by Google Play services, so proprietary
    // native engines are never embedded as unsymbolicated .so files in the Play bundle.
    implementation("com.google.android.gms:play-services-code-scanner:16.1.0")
    implementation("com.google.android.gms:play-services-mlkit-text-recognition:19.0.1")

    // Firebase is inactive unless the release pipeline explicitly supplies google-services.json
    // and sets REMOTE_PUSH_CONFIGURED=true.
    implementation(platform("com.google.firebase:firebase-bom:34.16.0"))
    implementation("com.google.firebase:firebase-messaging")

    debugImplementation("androidx.compose.ui:ui-tooling")
    debugImplementation("androidx.compose.ui:ui-test-manifest")
    testImplementation("junit:junit:4.13.2")
    // Android's framework org.json classes are stubs in local JVM tests. Use the real,
    // API-compatible implementation so mapper and repository contract tests execute.
    testImplementation("org.json:json:20240303")
    androidTestImplementation("androidx.test.ext:junit:1.2.1")
    androidTestImplementation("androidx.compose.ui:ui-test-junit4")
    androidTestImplementation("com.google.android.gms:play-services-base-testing:16.2.0")
}
