const variant = process.env.APP_VARIANT === "production" ? "production" : "development";
const isProduction = variant === "production";
// Deliberately empty by default: a Development Build remains a local preview
// until engineering supplies its reviewed endpoint at build time. A plausible
// but non-routable URL would make the UI advertise a login that cannot work.
const apiBaseUrl = (process.env.ERP_API_BASE_URL || "").trim();
const spkiPins = (process.env.ERP_TLS_SPKI_PINS || "")
  .split(",")
  .map((pin) => pin.trim())
  .filter(Boolean);
// A UUID identifying the dedicated Super Arabia EAS project is public
// configuration, not a secret. An environment override is accepted only for
// reproducible validation of an explicitly reviewed replacement project.
const reviewedExpoProjectId = "a10a37e0-8e04-47eb-8d71-3e00434a34d7";
const expoProjectId = (process.env.EXPO_EAS_PROJECT_ID || reviewedExpoProjectId).trim();
const googleServicesFile = (process.env.ERP_GOOGLE_SERVICES_FILE || "").trim();

const identity = isProduction
  ? {
      name: "سوبر العربية",
      scheme: "super-arabia",
      androidPackage: "online.alarabiya.store",
      iosBundleId: "online.alarabiya.superapp",
    }
  : {
      name: "سوبر العربية — معاينة",
      scheme: "super-arabia-preview",
      androidPackage: "online.alarabiya.store.expo",
      iosBundleId: "online.alarabiya.superapp.preview",
    };

/** @type {import('expo/config').ExpoConfig} */
const config = {
  owner: "shrkh-alruyh-alarbyh",
  name: identity.name,
  // EAS project identity remains stable across QA and store variants.
  slug: "super-arabia",
  // Required by Expo Router/Linking in a native production build. The preview
  // identity intentionally uses a different scheme so it cannot intercept the
  // future production app's links.
  scheme: identity.scheme,
  version: "1.1.2",
  orientation: "portrait",
  userInterfaceStyle: "light",
  newArchEnabled: true,
  // This product's release targets are Android and iOS. Keeping web as a
  // single-page preview avoids enabling Expo Router's server renderer during
  // native Development Build sessions, where it is unrelated to the app and
  // can terminate Metro on Windows file-watch events.
  web: {
    output: "single",
  },
  ios: {
    buildNumber: "2",
    supportsTablet: true,
    bundleIdentifier: identity.iosBundleId,
    infoPlist: {
      NSFaceIDUsageDescription: "يُستخدم التحقق الحيوي لحماية جلسة العمل على هذا الجهاز.",
      ITSAppUsesNonExemptEncryption: false,
    },
  },
  android: {
    versionCode: 20,
    package: identity.androidPackage,
    edgeToEdgeEnabled: true,
    predictiveBackGestureEnabled: false,
    usesCleartextTraffic: false,
    permissions: ["USE_BIOMETRIC", "POST_NOTIFICATIONS"],
    // expo-dev-client contributes this overlay permission during prebuild, but
    // the store app never draws above other applications. Block it explicitly
    // so release manifests stay least-privilege.
    blockedPermissions: [
      "android.permission.SYSTEM_ALERT_WINDOW",
      "android.permission.READ_EXTERNAL_STORAGE",
      "android.permission.WRITE_EXTERNAL_STORAGE",
      "android.permission.READ_MEDIA_IMAGES",
    ],
    ...(googleServicesFile ? { googleServicesFile } : {}),
  },
  plugins: [
    "expo-router",
    "expo-notifications",
    "expo-secure-store",
    "expo-local-authentication",
    "./plugins/withAndroidSplashApiGuard",
    ["./plugins/withAlrueyaSecureTransport", {
      environment: variant,
      baseUrl: apiBaseUrl,
      spkiPins,
    }],
  ],
  experiments: {
    typedRoutes: true,
    reactCompiler: false,
  },
  extra: {
    buildVariant: variant,
    expoProjectId,
    eas: {
      projectId: expoProjectId,
    },
  },
};

module.exports = config;
