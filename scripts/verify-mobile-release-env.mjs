#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const expected = Object.freeze({
  applicationId: "online.alarabiya.store",
  versionCode: 5,
  versionName: "1.0.0",
  productionBaseUrl: "https://srv1548487.hstgr.cloud",
});

function fail(message) {
  console.error(`mobile release gate: ${message}`);
  process.exitCode = 1;
  throw new Error("release gate rejected");
}

function requireText(name, { max = 131_072 } = {}) {
  const value = process.env[name]?.trim();
  if (!value) fail(`${name} is required`);
  if (value.length > max) fail(`${name} exceeds the accepted size`);
  return value;
}

function decodeBase64(name, { maxBytes }) {
  const raw = requireText(name, { max: Math.ceil(maxBytes * 1.5) });
  const compact = raw.replace(/\s/g, "");
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(compact) || compact.length % 4 !== 0) {
    fail(`${name} is not valid base64`);
  }
  const decoded = Buffer.from(compact, "base64");
  if (decoded.length === 0 || decoded.length > maxBytes) fail(`${name} has an invalid decoded size`);
  return decoded;
}

function parseJson(name, raw, { maxBytes = 131_072 } = {}) {
  if (Buffer.byteLength(raw, "utf8") > maxBytes) fail(`${name} exceeds the accepted size`);
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) fail(`${name} must contain a JSON object`);
    return parsed;
  } catch {
    fail(`${name} is not valid JSON`);
  }
}

function decodeEncryptionKey(raw) {
  if (/^[0-9a-fA-F]{64}$/.test(raw)) return Buffer.from(raw, "hex");
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(raw) || raw.length % 4 !== 0) return Buffer.alloc(0);
  return Buffer.from(raw, "base64");
}

function verifySourceContract() {
  const gradle = fs.readFileSync(path.join(root, "android-native/app/build.gradle.kts"), "utf8");
  const nativeCi = fs.readFileSync(path.join(root, ".github/workflows/android-native-ci.yml"), "utf8");
  const releaseCi = fs.readFileSync(path.join(root, ".github/workflows/android-release.yml"), "utf8");
  const serverIndex = fs.readFileSync(path.join(root, "server/index.ts"), "utf8");
  const serverReadiness = fs.readFileSync(path.join(root, "server/services/mobileProductionReadiness.ts"), "utf8");
  const productionEnvTemplate = fs.readFileSync(path.join(root, ".env.production.example"), "utf8");
  const deviceProof = fs.readFileSync(
    path.join(
      root,
      "android-native/app/src/main/java/online/alarabiya/superapp/core/security/DeviceProofKey.kt",
    ),
    "utf8",
  );

  const requiredGradleFragments = [
    `val productionApplicationId = "${expected.applicationId}"`,
    `val productionVersionCode = ${expected.versionCode}`,
    `val productionVersionName = "${expected.versionName}"`,
    `val expectedProductionEndpoint = "${expected.productionBaseUrl}"`,
    "applicationId = productionApplicationId",
    'applicationIdSuffix = ".debug"',
    "dependsOn(verifyProductionReleaseInputs)",
  ];
  for (const fragment of requiredGradleFragments) {
    if (!gradle.includes(fragment)) fail("native Gradle release identity/policy is incomplete");
  }
  const applicationIdSuffixes = [...gradle.matchAll(/applicationIdSuffix\s*=\s*"([^"]+)"/g)]
    .map((match) => match[1]);
  if (applicationIdSuffixes.length !== 1 || applicationIdSuffixes[0] !== ".debug") {
    fail("only the debug build type may add an applicationId suffix");
  }
  for (const fragment of [
    "fun requiresUnlockedDevice(apiLevel: Int): Boolean = apiLevel >= 35",
    "KeyProperties.SECURITY_LEVEL_UNKNOWN_SECURE",
    "KeyProperties.SECURITY_LEVEL_TRUSTED_ENVIRONMENT",
    "KeyProperties.SECURITY_LEVEL_STRONGBOX",
  ]) {
    if (!deviceProof.includes(fragment)) {
      fail("native device-proof compatibility or secure-hardware policy is incomplete");
    }
  }

  for (const task of [
    ":app:testDevDebugUnitTest",
    ":app:lintDevDebug",
    ":app:lintProdRelease",
    ":app:compileDevDebugAndroidTestKotlin",
    ":app:assembleDevDebug",
  ]) {
    if (!nativeCi.includes(task)) fail(`native CI is missing ${task}`);
  }
  if (!releaseCi.includes("working-directory: android-native")) fail("release workflow is not pinned to android-native");
  if (/working-directory:\s*twa|\btwa\/gradlew\b/i.test(releaseCi)) fail("release workflow references the legacy TWA build");
  if (!serverIndex.includes("assertMobileProductionReadiness();")) {
    fail("server startup does not enforce native mobile production readiness");
  }
  for (const fragment of [
    "FCM_CONFIGURATION_INVALID",
    "TWO_FACTOR_ENCRYPTION_KEY_INVALID",
    "TWO_FACTOR_ENFORCEMENT_DISABLED",
    "NATIVE_PUSH_ENVIRONMENT_INVALID",
    "ATTENDANCE_DEVICE_BRIDGE_DISABLED",
  ]) {
    if (!serverReadiness.includes(fragment)) fail("server mobile readiness policy is incomplete");
  }
  for (const declaration of [
    "SUPER_APP_NATIVE_REQUIRED=1",
    "NATIVE_PUSH_ENVIRONMENT=prod",
    "TWO_FACTOR_ENFORCEMENT=on",
    "HR_DEVICE_BRIDGE=1",
  ]) {
    if (!productionEnvTemplate.includes(declaration)) fail("production environment template is incomplete");
  }
}

function verifyReleaseEnvironment() {
  const keystore = decodeBase64("ANDROID_KEYSTORE_BASE64", { maxBytes: 16 * 1024 * 1024 });
  if (keystore.length < 256) fail("ANDROID_KEYSTORE_BASE64 does not contain a plausible keystore");
  requireText("ANDROID_KEYSTORE_PASSWORD", { max: 1024 });
  requireText("ANDROID_KEY_ALIAS", { max: 255 });
  requireText("ANDROID_KEY_PASSWORD", { max: 1024 });

  const expectedFingerprint = requireText("ANDROID_UPLOAD_SIGNING_SHA256", { max: 128 })
    .replace(/[:\s]/g, "");
  if (!/^[0-9a-fA-F]{64}$/.test(expectedFingerprint)) {
    fail("ANDROID_UPLOAD_SIGNING_SHA256 must be a SHA-256 fingerprint");
  }

  const googleServices = parseJson(
    "FIREBASE_GOOGLE_SERVICES_JSON_BASE64",
    decodeBase64("FIREBASE_GOOGLE_SERVICES_JSON_BASE64", { maxBytes: 256 * 1024 }).toString("utf8"),
  );
  const projectId = requireText("FCM_PROJECT_ID", { max: 128 });
  if (!/^[a-z][a-z0-9-]{4,61}[a-z0-9]$/.test(projectId)) fail("FCM_PROJECT_ID has an invalid format");
  const serviceAccount = parseJson(
    "FCM_SERVICE_ACCOUNT_JSON",
    requireText("FCM_SERVICE_ACCOUNT_JSON", { max: 64 * 1024 }),
    { maxBytes: 64 * 1024 },
  );
  if (serviceAccount.type !== "service_account") fail("FCM_SERVICE_ACCOUNT_JSON has the wrong account type");
  if (serviceAccount.project_id !== projectId || googleServices.project_info?.project_id !== projectId) {
    fail("Firebase project IDs do not match");
  }
  if (!/^[^\s@]+@[^\s@]+\.iam\.gserviceaccount\.com$/.test(serviceAccount.client_email ?? "")) {
    fail("FCM service-account email is invalid");
  }
  if (
    typeof serviceAccount.private_key !== "string" ||
    !serviceAccount.private_key.includes("-----BEGIN PRIVATE KEY-----") ||
    !serviceAccount.private_key.includes("-----END PRIVATE KEY-----")
  ) {
    fail("FCM service-account private key is incomplete");
  }
  const firebasePackages = (googleServices.client ?? [])
    .map((client) => client?.client_info?.android_client_info?.package_name)
    .filter(Boolean);
  if (!firebasePackages.includes(expected.applicationId)) {
    fail("Firebase Android client does not match the production applicationId");
  }

  const encryptionKey = decodeEncryptionKey(requireText("INTEGRATIONS_ENCRYPTION_KEY", { max: 256 }));
  if (encryptionKey.length !== 32) fail("INTEGRATIONS_ENCRYPTION_KEY must decode to exactly 32 bytes");
  if (requireText("TWO_FACTOR_ENFORCEMENT", { max: 16 }).toLowerCase() !== "on") {
    fail("TWO_FACTOR_ENFORCEMENT must be explicitly set to on for production release");
  }
  if (requireText("SUPER_APP_NATIVE_REQUIRED", { max: 8 }) !== "1") {
    fail("SUPER_APP_NATIVE_REQUIRED must be explicitly set to 1 for production release");
  }
  if (requireText("NATIVE_PUSH_ENVIRONMENT", { max: 16 }) !== "prod") {
    fail("NATIVE_PUSH_ENVIRONMENT must be prod for production release");
  }
  if (requireText("HR_DEVICE_BRIDGE", { max: 8 }) !== "1") {
    fail("HR_DEVICE_BRIDGE must be explicitly set to 1 for production release");
  }
  const attendanceDevicePort = Number(requireText("HR_DEVICE_PORT", { max: 5 }));
  if (!Number.isInteger(attendanceDevicePort) || attendanceDevicePort < 1 || attendanceDevicePort > 65_535) {
    fail("HR_DEVICE_PORT must be a valid TCP port");
  }
  if (requireText("ALRUEYA_PROD_BASE_URL", { max: 2048 }).replace(/\/$/, "") !== expected.productionBaseUrl) {
    fail("ALRUEYA_PROD_BASE_URL does not match the approved production endpoint");
  }
}

try {
  verifySourceContract();
  if (process.argv.includes("--release")) verifyReleaseEnvironment();
  console.log(process.argv.includes("--release")
    ? "mobile release gate: source and production inputs verified"
    : "mobile release gate: source contract verified");
} catch {
  if (!process.exitCode) {
    console.error("mobile release gate: unexpected validation failure");
    process.exitCode = 1;
  }
}
