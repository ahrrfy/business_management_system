// CommonJS JavaScript — لا TypeScript ولا ESM.
// السبب: EAS يقرأ هذا الملف **قبل** تثبيت التبعيات فلا يستطيع transpile الـTypeScript.
// كان الملف سابقاً `app.config.ts` بـ`import type { ExpoConfig }` ⇒ SyntaxError على EAS
// (راجع build 0324a9c0 + f8fd0cb8 fail logs).

// ─── تحميل env vars بأولويّة: نظام > .env ──────────────────────────────────────
// (كان في scripts/load-env.js — inlined هنا لتفادي ملفٍ ESM إضافيّ).
const fs = require("fs");
const path = require("path");

const envPath = path.resolve(process.cwd(), ".env");
if (fs.existsSync(envPath)) {
  const envContent = fs.readFileSync(envPath, "utf8");
  envContent.split("\n").forEach((line) => {
    if (!line || line.trim().startsWith("#")) return;
    const match = line.match(/^([^=]+)=(.*)$/);
    if (match) {
      const key = match[1].trim();
      const value = match[2].trim().replace(/^["']|["']$/g, "");
      if (!process.env[key]) process.env[key] = value;
    }
  });
}

const mappings = {
  VITE_APP_ID: "EXPO_PUBLIC_APP_ID",
  VITE_OAUTH_PORTAL_URL: "EXPO_PUBLIC_OAUTH_PORTAL_URL",
  OAUTH_SERVER_URL: "EXPO_PUBLIC_OAUTH_SERVER_URL",
  OWNER_OPEN_ID: "EXPO_PUBLIC_OWNER_OPEN_ID",
  OWNER_NAME: "EXPO_PUBLIC_OWNER_NAME",
};
for (const [systemVar, expoVar] of Object.entries(mappings)) {
  if (process.env[systemVar] && !process.env[expoVar]) {
    process.env[expoVar] = process.env[systemVar];
  }
}

// ─── تكوين التطبيق ───────────────────────────────────────────────────────────────
const rawBundleId = "online.alarabiya.customerstore";
const bundleId =
  rawBundleId
    .replace(/[-_]/g, ".")
    .replace(/[^a-zA-Z0-9.]/g, "")
    .replace(/\.+/g, ".")
    .replace(/^\.+|\.+$/g, "")
    .toLowerCase()
    .split(".")
    .map((segment) => (/^[a-zA-Z]/.test(segment) ? segment : "x" + segment))
    .join(".") || "space.manus.app";
// رابط عميق ثابت لتطبيق العملاء؛ يلزم بناء تطوير/إصدار رسمي لتجربته، لا Expo Go.
const schemeFromBundleId = "maktabaalarabiya";

const env = {
  appName: "مكتبة العربية",
  appSlug: "customer-store-mobile",
  logoUrl: "/manus-storage/icon_0519150d.png",
  scheme: schemeFromBundleId,
  iosBundleId: bundleId,
  androidPackage: bundleId,
};

/** @type {import('expo/config').ExpoConfig} */
const config = {
  name: env.appName,
  slug: env.appSlug,
  version: "1.0.0",
  orientation: "portrait",
  icon: "./assets/images/icon.png",
  scheme: env.scheme,
  userInterfaceStyle: "light",
  newArchEnabled: true,
  ios: {
    supportsTablet: true,
    bundleIdentifier: env.iosBundleId,
    googleServicesFile: "./GoogleService-Info.plist",
    infoPlist: {
      ITSAppUsesNonExemptEncryption: false,
    },
  },
  android: {
    googleServicesFile: "./google-services.json",
    adaptiveIcon: {
      backgroundColor: "#FFF8F2",
      foregroundImage: "./assets/images/android-icon-foreground.png",
      backgroundImage: "./assets/images/android-icon-background.png",
      monochromeImage: "./assets/images/android-icon-monochrome.png",
    },
    edgeToEdgeEnabled: true,
    predictiveBackGestureEnabled: false,
    package: env.androidPackage,
    permissions: ["POST_NOTIFICATIONS"],
    intentFilters: [
      {
        action: "VIEW",
        autoVerify: true,
        data: [
          {
            scheme: "https",
            host: "alarabiya.online",
            pathPrefix: "/s/w/",
          },
        ],
        category: ["BROWSABLE", "DEFAULT"],
      },
    ],
  },
  web: {
    bundler: "metro",
    output: "static",
    favicon: "./assets/images/favicon.png",
  },
  extra: {
    eas: {
      projectId: process.env.EXPO_PUBLIC_EAS_PROJECT_ID || "0b99e2d2-5a59-4892-81b7-f504da7c7d0a",
    },
  },
  plugins: [
    "expo-router",
    "expo-secure-store",
    "@react-native-firebase/app",
    "@react-native-firebase/app-check",
    "@react-native-firebase/auth",
    "@react-native-firebase/crashlytics",
    [
      "expo-splash-screen",
      {
        image: "./assets/images/splash-icon.png",
        imageWidth: 200,
        resizeMode: "contain",
        backgroundColor: "#ffffff",
        dark: {
          backgroundColor: "#FFF8F2",
        },
      },
    ],
    [
      "expo-notifications",
      {
        color: "#0E806A",
        defaultChannel: "store_updates",
        enableBackgroundRemoteNotifications: false,
      },
    ],
    [
      "expo-build-properties",
      {
        android: {
          buildArchs: ["arm64-v8a"],
          minSdkVersion: 26,
        },
        ios: {
          useFrameworks: "dynamic",
        },
      },
    ],
  ],
  experiments: {
    typedRoutes: true,
    reactCompiler: false,
  },
};

module.exports = config;
