# Alrueya Native Super App

This directory is the native Android client. It does not embed the ERP website and does not
depend on a WebView, Custom Tab, Chrome, Bubblewrap, or Trusted Web Activity.

## Runtime contract

- Native Kotlin and Jetpack Compose UI for phone and tablet.
- HTTPS-only connection to `https://srv1548487.hstgr.cloud`.
- Existing server authentication rules are preserved, including account state, lockout, and 2FA.
- The server session cookie is stored encrypted with an Android Keystore AES-GCM key.
- Biometric or device-credential unlock is available only after a successful server login.
- Attendance is read-only; physical attendance devices remain the system of record.
- Role-scoped modules come from `superApp.bootstrap`; desktop URLs returned by legacy metrics are ignored.

## Build and verify

```powershell
./gradlew.bat :app:testDevDebugUnitTest :app:lintDevDebug :app:compileDevDebugAndroidTestKotlin :app:assembleDevDebug
./gradlew.bat :app:lintProdRelease :app:bundleProdRelease
./gradlew.bat :app:connectedDevDebugAndroidTest
```

The installable QA build is produced at
`app/build/outputs/apk/dev/debug/app-dev-debug.apk`. Environment variants are intentionally limited
to `devDebug`, `stagingDebug`, and `prodRelease`; a debuggable build cannot use the production API.
Override the HTTPS endpoints with `ALRUEYA_DEV_BASE_URL`, `ALRUEYA_STAGING_BASE_URL`, and
`ALRUEYA_PROD_BASE_URL`, or their camel-case Gradle property equivalents.

The Play update keeps the package ID `online.alarabiya.store`, `versionName 1.0.0`, and
`versionCode 5`. Only debug builds add the `.debug` application ID suffix. A signed production
build reads signing values from environment variables or Gradle properties; never commit them:

- `ANDROID_KEYSTORE_PATH` / `androidKeystorePath`
- `ANDROID_KEYSTORE_PASSWORD` / `androidKeystorePassword`
- `ANDROID_KEY_ALIAS` / `androidKeyAlias`
- `ANDROID_KEY_PASSWORD` / `androidKeyPassword`

CI can run production compilation and lint without signing secrets, but `bundleProdRelease` and
`assembleProdRelease` always depend on upload-keystore verification and therefore cannot create an
unsigned production artifact. The manual release workflow validates the upload certificate, builds
the native AAB and APK, then verifies both signatures. It only uploads verified workflow artifacts
and does not publish to Google Play.

Firebase Messaging and Navigation Compose are compile-time dependencies. Remote push remains
disabled (`BuildConfig.REMOTE_PUSH_CONFIGURED=false`) until the environment-specific Firebase
configuration is supplied and the flag is explicitly enabled. The official Google Services plugin
is applied, but its processing task is disabled for local/PR builds while remote push is off. The
signed release workflow restores `google-services.json` from
`FIREBASE_GOOGLE_SERVICES_JSON_BASE64`, enables remote push, and therefore fails closed if the
Firebase app configuration is absent or does not match `online.alarabiya.store`. The legacy `twa/`
bundle must never be uploaded as the native app.

Before a production artifact is built, `scripts/verify-mobile-release-env.mjs --release` also
requires a structurally valid Firebase server service account, a matching Firebase project ID, a
32-byte `INTEGRATIONS_ENCRYPTION_KEY`, and `TWO_FACTOR_ENFORCEMENT=on`. It reports configuration
names and validation results only; secret values are never printed. These are release-readiness
checks and do not copy server credentials into the Android artifact.

The manual GitHub release workflow is fail-closed. Configure these repository secrets:

- `ANDROID_KEYSTORE_BASE64`, `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS`, `ANDROID_KEY_PASSWORD`
- `FIREBASE_GOOGLE_SERVICES_JSON_BASE64`, `FCM_SERVICE_ACCOUNT_JSON`
- `INTEGRATIONS_ENCRYPTION_KEY`

Configure these repository variables:

- `ANDROID_UPLOAD_SIGNING_SHA256`
- `ALRUEYA_PROD_BASE_URL=https://srv1548487.hstgr.cloud`
- `FCM_PROJECT_ID` (a secret with the same name is also accepted)
- `TWO_FACTOR_ENFORCEMENT=on`
- `SUPER_APP_NATIVE_REQUIRED=1`, `NATIVE_PUSH_ENVIRONMENT=prod`
- `HR_DEVICE_BRIDGE=1`, `HR_DEVICE_PORT=7788` (or the approved physical-device bridge port)
