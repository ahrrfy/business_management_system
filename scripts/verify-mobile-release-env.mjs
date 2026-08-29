#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { BlockList, isIP } from "node:net";
import {
  createHash,
  createPrivateKey,
  generateKeyPairSync,
  randomBytes,
  sign as signData,
  timingSafeEqual,
  verify as verifySignature,
} from "node:crypto";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const expected = Object.freeze({
  applicationId: "online.alarabiya.store",
  versionCode: 10,
  versionName: "1.0.2",
  productionBaseUrl: "https://srv1548487.hstgr.cloud",
  certificatePinExpiration: "2027-08-01",
  certificateSpkiPins: Object.freeze([
    "heyx24VzgigLNUK/xrMM4IODY0kLR33mjqjg/b8HUPg=",
    "brzvtCELCIZUo4sD/qPX0ccRtPsd3DY6RfmxpOU9oB4=",
  ]),
});
const firebaseTokenUri = "https://oauth2.googleapis.com/token";
const firebaseMessagingScope = "https://www.googleapis.com/auth/firebase.messaging";
const knownWeakEncryptionKeys = new Set(
  [
    "password",
    "change-me",
    "placeholder",
    "encryption-key",
    "super-alarabiya",
    "alrueya",
  ].map((value) => createHash("sha256").update(value, "utf8").digest("hex")),
);

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

function hasPlaceholderText(value) {
  const normalized = value.toLowerCase().replace(/[^a-z0-9]+/g, "");
  return [
    "changeme",
    "defaultkey",
    "developmentkey",
    "dummykey",
    "encryptionkey",
    "examplekey",
    "password",
    "placeholder",
    "samplekey",
    "testsecret",
    "yourkeyhere",
  ].some((marker) => normalized.includes(marker));
}

function hasRepeatedBytePattern(value, maxPeriod = 16) {
  for (let period = 1; period <= Math.min(maxPeriod, Math.floor(value.length / 2)); period += 1) {
    if (value.length % period !== 0) continue;
    let repeated = true;
    for (let index = period; index < value.length; index += 1) {
      if (value[index] !== value[index % period]) {
        repeated = false;
        break;
      }
    }
    if (repeated) return true;
  }
  return false;
}

function hasArithmeticByteSequence(value) {
  if (value.length < 3) return false;
  const delta = (value[1] - value[0] + 256) % 256;
  for (let index = 2; index < value.length; index += 1) {
    if ((value[index] - value[index - 1] + 256) % 256 !== delta) return false;
  }
  return true;
}

function byteEntropy(value) {
  const counts = new Map();
  for (const byte of value) counts.set(byte, (counts.get(byte) ?? 0) + 1);
  let entropy = 0;
  for (const count of counts.values()) {
    const probability = count / value.length;
    entropy -= probability * Math.log2(probability);
  }
  return entropy;
}

function passesEncryptionKeyPolicy(raw, decoded) {
  if (!Buffer.isBuffer(decoded) || decoded.length !== 32) return false;
  if (new Set(decoded).size < 16) return false;
  if (byteEntropy(decoded) < 4) return false;
  if (hasRepeatedBytePattern(decoded) || hasArithmeticByteSequence(decoded)) return false;
  const printable = decoded.every((byte) => byte >= 0x20 && byte <= 0x7e);
  if (printable) return false;
  if (hasPlaceholderText(raw) || hasPlaceholderText(decoded.toString("utf8"))) return false;
  if (knownWeakEncryptionKeys.has(decoded.toString("hex"))) return false;
  return true;
}

function encryptionKeyMatchesFingerprint(decoded, rawFingerprint) {
  if (!Buffer.isBuffer(decoded) || decoded.length !== 32 || typeof rawFingerprint !== "string") return false;
  const compact = rawFingerprint.replace(/[:\s]/g, "");
  if (!/^[0-9a-fA-F]{64}$/.test(compact)) return false;
  const expectedFingerprint = Buffer.from(compact, "hex");
  const actualFingerprint = createHash("sha256").update(decoded).digest();
  return timingSafeEqual(actualFingerprint, expectedFingerprint);
}

function isAllowedFirebasePrivateKeyObject(key) {
  const details = key?.asymmetricKeyDetails;
  return key?.type === "private" &&
    key?.asymmetricKeyType === "rsa" &&
    Number(details?.modulusLength ?? 0) >= 2048 &&
    Number(details?.publicExponent ?? 0) === 65_537;
}

function parseFirebasePrivateKey(value) {
  if (typeof value !== "string") return null;
  const pem = value.trim();
  if (!pem.startsWith("-----BEGIN PRIVATE KEY-----") || !pem.endsWith("-----END PRIVATE KEY-----")) {
    return null;
  }
  try {
    const key = createPrivateKey({ key: pem, format: "pem" });
    return isAllowedFirebasePrivateKeyObject(key) ? key : null;
  } catch {
    return null;
  }
}

function isValidFirebasePrivateKey(value) {
  return parseFirebasePrivateKey(value) !== null;
}

function validFirebasePrivateKeyId(value) {
  return typeof value === "string" && /^[A-Za-z0-9_-]{16,128}$/.test(value);
}

function base64UrlJson(value) {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function firebaseServiceAccountAssertion(serviceAccount, privateKey, nowMilliseconds) {
  const issuedAt = Math.floor(nowMilliseconds / 1000) - 30;
  const header = base64UrlJson({ alg: "RS256", typ: "JWT", kid: serviceAccount.private_key_id });
  const payload = base64UrlJson({
    iss: serviceAccount.client_email,
    scope: firebaseMessagingScope,
    aud: firebaseTokenUri,
    iat: issuedAt,
    exp: issuedAt + 300,
  });
  const signingInput = `${header}.${payload}`;
  const signature = signData("RSA-SHA256", Buffer.from(signingInput, "ascii"), privateKey)
    .toString("base64url");
  return `${signingInput}.${signature}`;
}

async function verifyFirebaseCredentialExchange(
  serviceAccount,
  privateKey,
  { fetchImpl = globalThis.fetch, nowMilliseconds = Date.now() } = {},
) {
  if (
    typeof fetchImpl !== "function" ||
    !validFirebasePrivateKeyId(serviceAccount?.private_key_id) ||
    serviceAccount?.token_uri !== firebaseTokenUri
  ) {
    return false;
  }
  try {
    const assertion = firebaseServiceAccountAssertion(serviceAccount, privateKey, nowMilliseconds);
    const body = new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion,
    });
    const response = await fetchImpl(firebaseTokenUri, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
      cache: "no-store",
      redirect: "error",
      signal: globalThis.AbortSignal?.timeout?.(15_000),
    });
    if (!response?.ok) return false;
    const result = await response.json();
    return typeof result?.access_token === "string" &&
      result.access_token.length >= 32 &&
      result.access_token.length <= 8192 &&
      result.token_type === "Bearer" &&
      Number.isFinite(result.expires_in) &&
      result.expires_in >= 60 &&
      result.expires_in <= 7200;
  } catch {
    return false;
  }
}

function exportPkcs8Pem(privateKey) {
  return privateKey.export({ format: "pem", type: "pkcs8" }).toString("utf8");
}

async function verifyProductionSecretPolicySelfTests() {
  const strongKey = randomBytes(32);
  const placeholderKey = Buffer.concat([
    Buffer.from("placeholder", "utf8"),
    Buffer.from(Array.from({ length: 21 }, (_, index) => 0x80 + index)),
  ]);
  const sequentialKey = Buffer.from(Array.from({ length: 32 }, (_, index) => index));
  const repeatedBlock = Buffer.from("00112233445566778899aabbccddeeff".repeat(2), "hex");
  const lowEntropyKey = Buffer.concat([
    Buffer.alloc(17),
    Buffer.from(Array.from({ length: 15 }, (_, index) => index + 1)),
  ]);
  const printablePassphrase = Buffer.from("abcdefghijklmnopqrstuvwxyzABCDEF", "ascii");
  const knownDerivedKey = createHash("sha256").update("password", "utf8").digest();
  const encryptionCases = [
    ["strong hex", strongKey.toString("hex"), strongKey, true],
    ["strong base64", strongKey.toString("base64"), strongKey, true],
    ["wrong length", "00", Buffer.alloc(1), false],
    ["all zero", "00".repeat(32), Buffer.alloc(32), false],
    ["single byte repeated", "ab".repeat(32), Buffer.alloc(32, 0xab), false],
    ["block repeated", repeatedBlock.toString("hex"), repeatedBlock, false],
    ["arithmetic sequence", sequentialKey.toString("hex"), sequentialKey, false],
    ["low entropy", lowEntropyKey.toString("hex"), lowEntropyKey, false],
    ["printable passphrase", printablePassphrase.toString("base64"), printablePassphrase, false],
    ["high-diversity placeholder", placeholderKey.toString("base64"), placeholderKey, false],
    ["known derived key", knownDerivedKey.toString("hex"), knownDerivedKey, false],
  ];
  for (const [label, raw, decoded, expectedResult] of encryptionCases) {
    if (passesEncryptionKeyPolicy(raw, decoded) !== expectedResult) {
      throw new Error(`production secret self-test failed: encryption ${label}`);
    }
  }
  const strongFingerprint = createHash("sha256").update(strongKey).digest("hex");
  if (!encryptionKeyMatchesFingerprint(strongKey, strongFingerprint)) {
    throw new Error("production secret self-test failed: matching encryption fingerprint");
  }
  if (encryptionKeyMatchesFingerprint(strongKey, "00".repeat(32))) {
    throw new Error("production secret self-test failed: mismatched encryption fingerprint");
  }

  const validRsa = generateKeyPairSync("rsa", { modulusLength: 2048, publicExponent: 0x10001 });
  const wrongAlgorithm = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const validPrivateKeyPem = exportPkcs8Pem(validRsa.privateKey);
  const firebaseCases = [
    ["valid RSA", validPrivateKeyPem, true],
    ["wrong algorithm", exportPkcs8Pem(wrongAlgorithm.privateKey), false],
    ["malformed PEM", "-----BEGIN PRIVATE KEY-----\ninvalid\n-----END PRIVATE KEY-----", false],
    ["missing key", undefined, false],
  ];
  for (const [label, value, expectedResult] of firebaseCases) {
    if (isValidFirebasePrivateKey(value) !== expectedResult) {
      throw new Error(`production secret self-test failed: Firebase ${label}`);
    }
  }
  for (const [label, key] of [
    ["weak RSA", {
      type: "private",
      asymmetricKeyType: "rsa",
      asymmetricKeyDetails: { modulusLength: 1024, publicExponent: 65_537n },
    }],
    ["weak exponent", {
      type: "private",
      asymmetricKeyType: "rsa",
      asymmetricKeyDetails: { modulusLength: 2048, publicExponent: 3n },
    }],
  ]) {
    if (isAllowedFirebasePrivateKeyObject(key)) {
      throw new Error(`production secret self-test failed: Firebase ${label}`);
    }
  }

  const fixedNow = Date.UTC(2026, 7, 10, 12, 0, 0);
  const serviceAccount = {
    client_email: "firebase-adminsdk-release@example-project.iam.gserviceaccount.com",
    private_key_id: "0123456789abcdef0123456789abcdef01234567",
    token_uri: firebaseTokenUri,
  };
  let exchangeCalls = 0;
  const successfulExchange = await verifyFirebaseCredentialExchange(
    serviceAccount,
    validRsa.privateKey,
    {
      nowMilliseconds: fixedNow,
      fetchImpl: async (url, options) => {
        exchangeCalls += 1;
        if (url !== firebaseTokenUri || options?.method !== "POST" || options?.redirect !== "error") {
          throw new Error("production secret self-test failed: Firebase OAuth request policy");
        }
        const assertion = options.body?.get?.("assertion");
        const grantType = options.body?.get?.("grant_type");
        const parts = typeof assertion === "string" ? assertion.split(".") : [];
        if (grantType !== "urn:ietf:params:oauth:grant-type:jwt-bearer" || parts.length !== 3) {
          throw new Error("production secret self-test failed: Firebase OAuth assertion shape");
        }
        const header = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8"));
        const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
        const signatureValid = verifySignature(
          "RSA-SHA256",
          Buffer.from(`${parts[0]}.${parts[1]}`, "ascii"),
          validRsa.publicKey,
          Buffer.from(parts[2], "base64url"),
        );
        if (
          header.alg !== "RS256" ||
          header.kid !== serviceAccount.private_key_id ||
          payload.iss !== serviceAccount.client_email ||
          payload.scope !== firebaseMessagingScope ||
          payload.aud !== firebaseTokenUri ||
          payload.exp - payload.iat !== 300 ||
          !signatureValid
        ) {
          throw new Error("production secret self-test failed: Firebase OAuth assertion binding");
        }
        return {
          ok: true,
          json: async () => ({
            access_token: "self-test-access-token-value-never-used-outside-memory",
            token_type: "Bearer",
            expires_in: 3600,
          }),
        };
      },
    },
  );
  if (!successfulExchange || exchangeCalls !== 1) {
    throw new Error("production secret self-test failed: Firebase OAuth success path");
  }
  const rejectedExchange = await verifyFirebaseCredentialExchange(
    serviceAccount,
    validRsa.privateKey,
    { fetchImpl: async () => ({ ok: false, status: 401 }) },
  );
  if (rejectedExchange) {
    throw new Error("production secret self-test failed: Firebase OAuth rejection path");
  }
}

function isStrongMachineSecret(secret) {
  if (Buffer.byteLength(secret, "utf8") < 32 || Buffer.byteLength(secret, "utf8") > 512) return false;
  if (/(?:change[ _-]?me|password|example|placeholder|test[ _-]?secret)/i.test(secret)) return false;
  if (new Set(Array.from(secret)).size < 10) return false;
  for (let period = 1; period <= Math.min(16, Math.floor(secret.length / 2)); period += 1) {
    if (secret.length % period === 0 && secret.slice(0, period).repeat(secret.length / period) === secret) {
      return false;
    }
  }
  return true;
}

function validateNetworkEntry(entry) {
  const [network, prefixText, extra] = entry.split("/");
  if (extra !== undefined) return false;
  const family = isIP(network);
  if (!family) return false;
  if (prefixText === undefined) return true;
  const prefix = Number(prefixText);
  return Number.isInteger(prefix) && prefix > 0 && prefix <= (family === 4 ? 32 : 128);
}

function isExactHostNetwork(entry) {
  const [network, prefixText, extra] = entry.split("/");
  if (extra !== undefined) return false;
  const family = isIP(network);
  if (!family) return false;
  return prefixText === undefined || Number(prefixText) === (family === 4 ? 32 : 128);
}

function sameExactHostNetwork(left, right) {
  if (!isExactHostNetwork(left) || !isExactHostNetwork(right)) return false;
  const leftAddress = left.split("/")[0];
  const rightAddress = right.split("/")[0];
  const family = isIP(leftAddress);
  if (!family || isIP(rightAddress) !== family) return false;
  try {
    const block = new BlockList();
    const type = family === 4 ? "ipv4" : "ipv6";
    block.addAddress(leftAddress, type);
    return block.check(rightAddress, type);
  } catch {
    return false;
  }
}

function secretFingerprint(secret) {
  return createHash("sha256").update(secret).digest("hex");
}

function validateDeviceIdentityBindings(raw, globalSecret) {
  if (!raw) return;
  const bindings = parseJson("HR_DEVICE_IDENTITY_BINDINGS", raw, { maxBytes: 64 * 1024 });
  const globalSecretFingerprint = globalSecret ? secretFingerprint(globalSecret) : "";
  const deviceSecretFingerprints = new Set();
  const uncredentialedAddresses = [];
  for (const [serialNumber, binding] of Object.entries(bindings)) {
    if (!/^[A-Za-z0-9._:-]{1,64}$/.test(serialNumber) || !binding || typeof binding !== "object" || Array.isArray(binding)) {
      fail("HR_DEVICE_IDENTITY_BINDINGS contains an invalid serial or binding");
    }
    const allowlist = binding.allowlist ?? binding.ips ?? [];
    if (!Array.isArray(allowlist) || allowlist.length > 16 || allowlist.some((entry) => typeof entry !== "string" || !validateNetworkEntry(entry.trim()))) {
      fail("HR_DEVICE_IDENTITY_BINDINGS contains an invalid or universal device network");
    }
    const secret = typeof binding.sharedSecret === "string"
      ? binding.sharedSecret.trim()
      : typeof binding.secret === "string"
        ? binding.secret.trim()
        : "";
    if (secret && !isStrongMachineSecret(secret)) {
      fail("HR_DEVICE_IDENTITY_BINDINGS contains a weak or repeated device secret");
    }
    if (allowlist.length === 0 && !secret) fail("HR_DEVICE_IDENTITY_BINDINGS contains an unbound device");
    if (!secret && allowlist.some((entry) => !isExactHostNetwork(entry.trim()))) {
      fail("a shared device CIDR requires a unique per-device secret");
    }
    if (secret) {
      const fingerprint = secretFingerprint(secret);
      if (fingerprint === globalSecretFingerprint || deviceSecretFingerprints.has(fingerprint)) {
        fail("every device secret must be unique and different from HR_DEVICE_SHARED_SECRET");
      }
      deviceSecretFingerprints.add(fingerprint);
    } else {
      for (const entry of allowlist) {
        const normalized = entry.trim();
        if (uncredentialedAddresses.some((existing) => sameExactHostNetwork(existing, normalized))) {
          fail("two devices cannot share an IP without unique per-device secrets");
        }
        uncredentialedAddresses.push(normalized);
      }
    }
  }
}

function yamlJobBlock(source, jobName) {
  const lines = source.replace(/\r\n/g, "\n").split("\n");
  const start = lines.findIndex((line) => line === `  ${jobName}:`);
  if (start < 0) fail(`release workflow is missing the ${jobName} job`);
  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    if (/^  [A-Za-z0-9_-]+:\s*$/.test(lines[index])) {
      end = index;
      break;
    }
  }
  return lines
    .slice(start, end)
    .filter((line) => !line.trimStart().startsWith("#"))
    .join("\n");
}

function xmlAttribute(attributes, name) {
  return attributes.match(new RegExp(`\\b${name}\\s*=\\s*"([^"]*)"`))?.[1] ?? null;
}

function verifyNetworkSecurityPinning(source) {
  if (/PLACEHOLDER|BASE64_SHA256|YYYY-MM-DD|dev\.invalid|staging\.invalid/i.test(source)) {
    fail("native production certificate pinning contains a placeholder or non-production host");
  }

  const expectedHost = new URL(expected.productionBaseUrl).hostname;
  const domainConfigs = [...source.matchAll(/<domain-config\b([^>]*)>([\s\S]*?)<\/domain-config>/g)];
  if (domainConfigs.length !== 1) {
    fail("native production network security config must contain exactly one pinned domain-config");
  }

  const [, domainConfigAttributes, domainConfigBody] = domainConfigs[0];
  if (xmlAttribute(domainConfigAttributes, "cleartextTrafficPermitted") !== "false") {
    fail("native production pinned domain must explicitly reject cleartext traffic");
  }

  const domains = [...domainConfigBody.matchAll(/<domain\b([^>]*)>([^<]+)<\/domain>/g)];
  if (
    domains.length !== 1 ||
    domains[0][2].trim() !== expectedHost ||
    xmlAttribute(domains[0][1], "includeSubdomains") !== "false"
  ) {
    fail("native certificate pinning must target only the exact approved production host");
  }

  const pinSets = [...domainConfigBody.matchAll(/<pin-set\b([^>]*)>([\s\S]*?)<\/pin-set>/g)];
  if (
    pinSets.length !== 1 ||
    xmlAttribute(pinSets[0][1], "expiration") !== expected.certificatePinExpiration
  ) {
    fail("native certificate pin expiration is missing or does not match the reviewed rotation date");
  }

  const pins = [...pinSets[0][2].matchAll(/<pin\b([^>]*)>([^<]+)<\/pin>/g)].map(
    ([, attributes, value]) => {
      const pin = value.trim();
      if (xmlAttribute(attributes, "digest") !== "SHA-256") {
        fail("native certificate pins must use SHA-256");
      }
      if (
        !/^[A-Za-z0-9+/]{43}=$/.test(pin) ||
        Buffer.from(pin, "base64").length !== 32 ||
        Buffer.from(pin, "base64").toString("base64") !== pin
      ) {
        fail("native certificate pin is not a canonical SHA-256 SPKI value");
      }
      return pin;
    },
  );
  const actualPins = [...new Set(pins)].sort();
  const reviewedPins = [...expected.certificateSpkiPins].sort();
  if (
    pins.length !== reviewedPins.length ||
    actualPins.length !== reviewedPins.length ||
    actualPins.some((pin, index) => pin !== reviewedPins[index])
  ) {
    fail("native certificate pins do not match the independently reviewed production chain");
  }

  const trustAnchors = [...domainConfigBody.matchAll(/<certificates\b([^>]*)\/>/g)].map((match) =>
    xmlAttribute(match[1], "src"),
  );
  if (!trustAnchors.includes("system") || trustAnchors.some((anchor) => anchor !== "system")) {
    fail("native pinned production traffic must trust system anchors only");
  }
}

function verifySourceContract() {
  const gradle = fs.readFileSync(path.join(root, "android-native/app/build.gradle.kts"), "utf8");
  const networkSecurityConfig = fs.readFileSync(
    path.join(root, "android-native/app/src/main/res/xml/network_security_config.xml"),
    "utf8",
  );
  const nativeCi = fs.readFileSync(path.join(root, ".github/workflows/android-native-ci.yml"), "utf8");
  const releaseCi = fs.readFileSync(path.join(root, ".github/workflows/android-release.yml"), "utf8");
  const releaseWorkflowGate = fs.readFileSync(
    path.join(root, "scripts/verify-android-release-workflow-gate.mjs"),
    "utf8",
  );
  const serverIndex = fs.readFileSync(path.join(root, "server/index.ts"), "utf8");
  const serverReadiness = fs.readFileSync(path.join(root, "server/services/mobileProductionReadiness.ts"), "utf8");
  const deployScript = fs.readFileSync(path.join(root, "scripts/deploy.mjs"), "utf8");
  const bridgeRuntimeGate = fs.readFileSync(path.join(root, "scripts/verify-hr-bridge-runtime.mjs"), "utf8");
  const bridgeArtifactGate = fs.readFileSync(path.join(root, "scripts/verify-hr-bridge-artifact.mjs"), "utf8");
  const bridgeRelease = fs.readFileSync(path.join(root, "scripts/hr-bridge-release.cjs"), "utf8");
  const bridgeActivation = fs.readFileSync(path.join(root, "scripts/hr-bridge-activation.cjs"), "utf8");
  const bridgePm2App = fs.readFileSync(path.join(root, "scripts/hr-bridge-pm2-app.cjs"), "utf8");
  const bridgePm2Config = fs.readFileSync(path.join(root, "scripts/hr-bridge-pm2.config.cjs"), "utf8");
  const bridgeBootstrap = fs.readFileSync(
    path.join(root, "scripts/hr-bridge-release-worker.mjs"),
    "utf8",
  );
  const bridgePolicy = fs.readFileSync(path.join(root, "scripts/hr-bridge-runtime-policy.cjs"), "utf8");
  const bridgeWorker = fs.readFileSync(path.join(root, "server/hr-bridge-worker.ts"), "utf8");
  const bridgeReadiness = fs.readFileSync(path.join(root, "server/services/hrDevices/readiness.ts"), "utf8");
  const bridgeImplementation = fs.readFileSync(path.join(root, "server/services/hrDevices/bridge.ts"), "utf8");
  const packageJson = fs.readFileSync(path.join(root, "package.json"), "utf8");
  const ecosystem = fs.readFileSync(path.join(root, "ecosystem.config.cjs"), "utf8");
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
    // بوّابة إصدار الإنتاج (verifyProductionReleaseInputs) تؤكّد الرقمَ حرفياً؛ ربطُها بالمتوقَّع هنا
    // يمنع فخّاً أمسكه Codex على #722: رفعُ الرقم دون تحديث هذا التأكيد يُسقط bundleProdRelease وحده
    // (لا يظهر في بناء dev المحليّ)، وكان check:mobile-release أعمى عنه.
    `if (productionVersionCode != ${expected.versionCode} || productionVersionName != "${expected.versionName}") {`,
    `val expectedProductionEndpoint = "${expected.productionBaseUrl}"`,
    "applicationId = productionApplicationId",
    'applicationIdSuffix = ".debug"',
    "dependsOn(verifyProductionReleaseInputs)",
  ];
  for (const fragment of requiredGradleFragments) {
    if (!gradle.includes(fragment)) fail("native Gradle release identity/policy is incomplete");
  }
  verifyNetworkSecurityPinning(networkSecurityConfig);
  const applicationIdSuffixes = [...gradle.matchAll(/applicationIdSuffix\s*=\s*"([^"]+)"/g)]
    .map((match) => match[1]);
  if (applicationIdSuffixes.length !== 1 || applicationIdSuffixes[0] !== ".debug") {
    fail("only the debug build type may add an applicationId suffix");
  }
  for (const fragment of [
    'const val KEY_ALIAS = "alrueya_native_device_proof_v2"',
    "builder.setIsStrongBoxBacked(useStrongBox)",
    "private fun loadExistingKeyPair(): KeyPair?",
    "runCatching { keyStore.deleteEntry(KEY_ALIAS) }",
  ]) {
    if (!deviceProof.includes(fragment)) {
      fail("native device-proof compatibility, key rotation, or recovery policy is incomplete");
    }
  }
  if (deviceProof.includes("setUnlockedDeviceRequired") || deviceProof.includes("isHardwareBacked(")) {
    fail("native device proof must work while locked and must not enforce an unverifiable hardware-only policy");
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
  const releaseGateJob = yamlJobBlock(releaseCi, "release-gate");
  const signedArtifactsJob = yamlJobBlock(releaseCi, "signed-native-artifacts");
  if (!/^\s+run:\s+node scripts\/verify-android-release-workflow-gate\.mjs\s*$/m.test(releaseGateJob)) {
    fail("release workflow does not execute the exact-SHA workflow gate");
  }
  if (!/^    needs:\s*release-gate\s*$/m.test(signedArtifactsJob)) {
    fail("signed Android artifacts are not blocked on the release gate");
  }
  const signedJobGateCalls = [
    ...signedArtifactsJob.matchAll(
      /^\s+run:\s+node scripts\/verify-android-release-workflow-gate\.mjs\s*$/gm,
    ),
  ].length;
  if (signedJobGateCalls !== 2) {
    fail("signed Android artifacts must recheck exact-SHA gates before signing and publication");
  }
  if (
    !signedArtifactsJob.includes('aab_actual="$(keytool -printcert -jarfile') ||
    !signedArtifactsJob.includes('test "$aab_actual" = "$expected"')
  ) {
    fail("release workflow does not verify the AAB signing certificate");
  }
  const expectedProductionHost = new URL(expected.productionBaseUrl).hostname;
  for (const fragment of [
    'dump resources "$apk"',
    '$NF == "xml/network_security_config"',
    'network_security_config packaged path was not found',
    'dump xmltree --file "$network_config_path" "$apk"',
    `grep -Fq "T: '${expectedProductionHost}'"`,
    "grep -Fq 'A: includeSubdomains=false'",
    `grep -Fq 'A: expiration="${expected.certificatePinExpiration}"'`,
    'test "$pin_count" -eq 2',
  ]) {
    if (!signedArtifactsJob.includes(fragment)) {
      fail("release workflow does not verify certificate pinning in the packaged production APK");
    }
  }
  if (!nativeCi.includes('- "scripts/verify-android-release-workflow-gate.mjs"')) {
    fail("native CI path filters do not cover release gate changes");
  }
  const normalizedNativeCi = nativeCi.replace(/\r\n/g, "\n");
  const nativePushTrigger = normalizedNativeCi.match(
    /\n  push:\n([\s\S]*?)\n\npermissions:/,
  )?.[1];
  if (
    !nativePushTrigger ||
    !/^    branches:\s*\[main\]\s*$/m.test(nativePushTrigger) ||
    /^    paths(?:-ignore)?:\s*$/m.test(nativePushTrigger)
  ) {
    fail("native CI must run on every main push so the exact-SHA release gate can succeed");
  }
  for (const fragment of [
    // متطلبات المصفوفة الثلاثية والوظائف — ثابتة عبر أيّ تشدُّد أو تخفيف للنافذة.
    'file: "ci.yml"',
    'file: "security.yml"',
    'file: "android-native-ci.yml"',
    '"check-test-build"',
    '"authz-guard"',
    '"audit"',
    '"native-android-check"',
    '"native-android-device-smoke"',
    // البوّابة الأساسية: workflow_dispatch على main حصراً.
    'eventName !== "workflow_dispatch"',
    'ref !== "refs/heads/main"',
    // نافذة السلف (٢٧/٨/٢٦): بدل exact-SHA، نتحقّق أن الترتيب المُحدَّث سليم — قراءةُ آخر
    // N SHAs من commits API، وGITHUB_SHA نفسه ضمن النافذة (يمنع dispatch من stale)، ونجاح
    // البوّابات الثلاث كلها على السلف المختار. القوالب أدناه تكفل بقاء هذه الضمانات إن
    // أعاد أحدهم صياغة الملف. `RELEASE_GATE_ANCESTOR_WINDOW` يبقى مرئياً كسقف مضبوط.
    "RELEASE_GATE_ANCESTOR_WINDOW",
    "listRecentShas",
    "/commits?",
    "dispatchIndex < 0",
    // شرط نجاح CI: run.status/conclusion يجب أن يكونا completed/success لكل بوّابة.
    'run.status !== "completed"',
    'run.conclusion !== "success"',
    // شرط نجاح الوظائف المطلوبة — verifyRequiredJobs يبقى حادّاً (لا يتغاضى عن انحدار).
    '/jobs?per_page=100&filter=latest',
    'job.status !== "completed" || job.conclusion !== "success"',
  ]) {
    if (!releaseWorkflowGate.includes(fragment)) {
      fail("release workflow ancestor-window CI/security/native policy is incomplete");
    }
  }
  for (const fragment of [
    "INTEGRATIONS_ENCRYPTION_KEY_SHA256:",
    "HR_DEVICE_IP_ALLOWLIST:",
    "HR_DEVICE_SHARED_SECRET:",
    "HR_DEVICE_IDENTITY_BINDINGS:",
    "HR_DEVICE_LEGACY_IDENTITY_MIGRATION:",
  ]) {
    if (!releaseCi.includes(fragment)) fail("release workflow is missing attendance bridge security inputs");
  }
  if (!serverIndex.includes("assertMobileProductionReadiness();")) {
    fail("server startup does not enforce native mobile production readiness");
  }
  for (const fragment of [
    "FCM_CONFIGURATION_INVALID",
    "TWO_FACTOR_ENCRYPTION_KEY_INVALID",
    "TWO_FACTOR_ENFORCEMENT_DISABLED",
    "NATIVE_PUSH_ENVIRONMENT_INVALID",
    "ATTENDANCE_DEVICE_BRIDGE_DISABLED",
    "ATTENDANCE_DEVICE_BRIDGE_PORT_INVALID",
    "ATTENDANCE_DEVICE_BRIDGE_INSECURE",
  ]) {
    if (!serverReadiness.includes(fragment)) fail("server mobile readiness policy is incomplete");
  }
  for (const declaration of [
    "SUPER_APP_NATIVE_REQUIRED=1",
    "NATIVE_PUSH_ENVIRONMENT=prod",
    "TWO_FACTOR_ENFORCEMENT=on",
    "INTEGRATIONS_ENCRYPTION_KEY_SHA256=",
    "HR_DEVICE_BRIDGE=1",
    "HR_DEVICE_LEGACY_IDENTITY_MIGRATION=0",
    // App Links للتطبيق الأصيل — إن غاب المفتاح، wellKnown يخدم بصمة EAS-dev فتنكسر App Links
    // لكلّ عميل Play. راجع expo/customer-store-mobile/docs/erp-followups.md § ك-٢.
    "STOREFRONT_ANDROID_PACKAGE=online.alarabiya.customerstore",
    "STOREFRONT_ANDROID_SHA256_CERT_FINGERPRINTS=",
  ]) {
    if (!productionEnvTemplate.includes(declaration)) fail("production environment template is incomplete");
  }
  if (!deployScript.includes("scripts/verify-hr-bridge-runtime.mjs")) {
    fail("production deployment does not execute the attendance bridge runtime gate");
  }
  for (const fragment of [
    "--preflight",
    "--after-pull",
    "--update-env",
    "assertRepository",
    "recoverInterruptedActivation",
    "activateBridgeRelease",
    "pm2ConfigPath",
    'args.push("--expect-disabled")',
    "HR_BRIDGE_ACTIVATION_FAILED_ROLLBACK_FAILED",
    "HR_BRIDGE_LEGACY_ADOPTION_REQUIRED",
    "acquirePrePullLock",
    "PM2_VERSION_UNSUPPORTED",
    "DEPLOY_IDENTITY_INVALID",
    "sudo -iu deploy",
  ]) {
    if (!deployScript.includes(fragment)) fail("production deployment bridge preflight/update policy is incomplete");
  }
  if (!bridgeWorker.includes("assertEnabledDeviceIdentityReadiness")) {
    fail("attendance bridge worker does not audit enabled device identity bindings before listen");
  }
  if (
    !bridgeWorker.includes("./services/hrDevices/readiness")
    || bridgeWorker.includes("./services/hrDeviceService")
  ) {
    fail("attendance bridge worker must load identity readiness from the isolated startup module");
  }
  for (const fragment of [
    "enabledDeviceIdentityRuntimeFailure",
    "resolveBridgeSecurityConfig",
    "HR_DEVICE_IDENTITY_NOT_READY",
  ]) {
    if (!bridgeReadiness.includes(fragment)) fail("attendance bridge readiness module is incomplete");
  }
  for (const fragment of ["await startHrDeviceBridge", "options.onReady()", "HR_BRIDGE_DB_READINESS_TIMEOUT"]) {
    if (!bridgeWorker.includes(fragment)) fail("attendance bridge worker does not prove listener readiness");
  }
  for (const fragment of ['server.once("listening"', "HR_DEVICE_BRIDGE_LISTEN_TIMEOUT", "await listenForBridge"]) {
    if (!bridgeImplementation.includes(fragment)) fail("attendance bridge TCP listen contract is incomplete");
  }
  for (const fragment of [
    'path.join(projectRoot, "dist", "hr-bridge-worker.cjs")',
    "pathToFileURL(artifactPath)",
    "HR_BRIDGE_MUTABLE_SOURCE_RUNTIME_FORBIDDEN",
    "hr-bridge-release.json",
    "hr-bridge-environment.json",
    "hr-bridge-mode.cjs",
    "HR_BRIDGE_RELEASE_RUNTIME_MARKER_INVALID",
    "HR_BRIDGE_MANAGED_ENVIRONMENT_REQUIRED",
    "HR_BRIDGE_ENV_SANITIZED",
    "HR_BRIDGE_EXTERNAL_RUNTIME_REQUIRE_BLOCKED",
    "HR_BRIDGE_STARTUP_TIMEOUT",
    'process.send("ready")',
  ]) {
    if (!bridgeBootstrap.includes(fragment)) fail("attendance bridge bootstrap watchdog/readiness is incomplete");
  }
  for (const fragment of [
    "startupTimeoutMs",
    "pm2Version",
    "pm2ListenTimeoutMs",
    "runtimeStableSamples",
    "disabledExitCode",
    "allowedEnvironmentKeys",
    "pm2EnvironmentMetadataKeys",
  ]) {
    if (!bridgePolicy.includes(fragment)) fail("attendance bridge lifecycle policy is incomplete");
  }
  for (const fragment of [
    "server/hr-bridge-worker.ts",
    "scripts/verify-hr-bridge-runtime.mjs --selftest",
    "scripts/verify-hr-bridge-artifact.mjs",
    "scripts/verify-hr-bridge-deployment.mjs",
    "hr-bridge-optional-module-stub.cjs",
  ]) {
    if (!packageJson.includes(fragment)) fail("production build does not compile and verify the attendance bridge artifact");
  }
  for (const fragment of [
    "artifactSmokeBridgeApp",
    "HR_BRIDGE_ECOSYSTEM_ARTIFACT_SMOKE",
  ]) {
    if (!ecosystem.includes(fragment)) fail("mutable ecosystem bridge isolation policy is incomplete");
  }
  for (const fragment of [
    "wait_ready: true",
    "listen_timeout: policy.pm2ListenTimeoutMs",
    'filter_env: [""]',
    "stop_exit_codes: [policy.disabledExitCode]",
  ]) {
    if (!bridgePm2App.includes(fragment)) fail("PM2 attendance bridge readiness policy is incomplete");
  }
  for (const fragment of [
    "hr-bridge-release.json",
    "hr-bridge-worker.mjs",
    "hr-bridge-environment.json",
    "hr-bridge-mode.cjs",
    "allowedEnvironmentKeys",
  ]) {
    if (!bridgePm2Config.includes(fragment)) fail("immutable PM2 bridge definition is incomplete");
  }
  for (const fragment of [
    "beginActivation",
    "markActivationPhase",
    "commitActivation",
    "loadReleaseEnvironment",
    "HR_BRIDGE_RELEASE_CANDIDATE_MODE_MISMATCH",
    "establishBaseline",
    "fsyncSync",
  ]) {
    if (!bridgeRelease.includes(fragment)) fail("attendance bridge release journal is incomplete");
  }
  for (const fragment of [
    "restorePrior",
    "rollback-saved",
    "HR_BRIDGE_ACTIVATION_FAILED_ROLLBACK_FAILED",
    "adoptLegacyBridgeBaseline",
  ]) {
    if (!bridgeActivation.includes(fragment)) fail("attendance bridge automatic rollback is incomplete");
  }
  if (
    bridgeBootstrap.includes("tsx/esm/api") ||
    bridgeBootstrap.includes("tsImport(") ||
    bridgeWorker.includes("tsx/esm/api") ||
    bridgeWorker.includes("tsImport(")
  ) {
    fail("attendance bridge production startup must not interpret TypeScript at runtime");
  }
  for (const fragment of [
    "hr-bridge-release-worker.mjs",
    "hr-bridge-worker.cjs",
    "HR_BRIDGE_RELEASE_ISOLATION_SMOKE_FAILED",
    "spawnSync",
    "timeout: 10_000",
    "HR_BRIDGE_ENVIRONMENT_ISOLATION_SMOKE_FAILED",
    "HR_BRIDGE_NATIVE_REQUIRE_GUARD_SMOKE_FAILED",
  ]) {
    if (!bridgeArtifactGate.includes(fragment)) fail("attendance bridge compiled-artifact smoke gate is incomplete");
  }
  for (const fragment of [
    "erp-hr-bridge",
    "PM2_BRIDGE_NOT_ONLINE",
    "BRIDGE_PORT_NOT_LISTENING",
    "PM2_BRIDGE_ENV_LEAK",
    "PM2_BRIDGE_MANAGED_ENVIRONMENT_MISSING",
    "PM2_BRIDGE_RELEASE_PATH_MISMATCH",
    "BRIDGE_DISABLED_PORT_STILL_LISTENING",
    '"-ltnp"',
    "runtimeStableSamples",
  ]) {
    if (!bridgeRuntimeGate.includes(fragment)) fail("attendance bridge runtime gate is incomplete");
  }
}

async function verifyReleaseEnvironment() {
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
  const firebasePrivateKey = parseFirebasePrivateKey(serviceAccount.private_key);
  if (!firebasePrivateKey) {
    fail("FCM service-account private key must be a valid RSA-2048+ PKCS#8 key");
  }
  if (!validFirebasePrivateKeyId(serviceAccount.private_key_id)) {
    fail("FCM service-account private_key_id has an invalid format");
  }
  if (serviceAccount.token_uri !== firebaseTokenUri) {
    fail("FCM service-account token_uri must use the approved Google OAuth endpoint");
  }
  const firebasePackages = (googleServices.client ?? [])
    .map((client) => client?.client_info?.android_client_info?.package_name)
    .filter(Boolean);
  if (!firebasePackages.includes(expected.applicationId)) {
    fail("Firebase Android client does not match the production applicationId");
  }

  const encryptionKeyRaw = requireText("INTEGRATIONS_ENCRYPTION_KEY", { max: 256 });
  const encryptionKey = decodeEncryptionKey(encryptionKeyRaw);
  if (!passesEncryptionKeyPolicy(encryptionKeyRaw, encryptionKey)) {
    fail("INTEGRATIONS_ENCRYPTION_KEY must contain 32-byte cryptographic material without weak patterns");
  }
  if (!encryptionKeyMatchesFingerprint(
    encryptionKey,
    requireText("INTEGRATIONS_ENCRYPTION_KEY_SHA256", { max: 128 }),
  )) {
    fail("INTEGRATIONS_ENCRYPTION_KEY does not match the approved SHA-256 fingerprint");
  }
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
  const bridgeAllowlist = (process.env.HR_DEVICE_IP_ALLOWLIST ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  if (bridgeAllowlist.some((entry) => !validateNetworkEntry(entry))) {
    fail("HR_DEVICE_IP_ALLOWLIST contains an invalid or universal IP/CIDR");
  }
  const bridgeSecret = process.env.HR_DEVICE_SHARED_SECRET?.trim() ?? "";
  if (bridgeSecret && !isStrongMachineSecret(bridgeSecret)) {
    fail("HR_DEVICE_SHARED_SECRET must be random, non-repeated and at least 32 bytes");
  }
  if (bridgeAllowlist.length === 0 && !bridgeSecret) {
    fail("the attendance bridge requires a restricted IP allowlist or a strong shared secret");
  }
  const legacyIdentityMigration = requireText("HR_DEVICE_LEGACY_IDENTITY_MIGRATION", { max: 1 });
  if (legacyIdentityMigration !== "0") {
    fail("HR_DEVICE_LEGACY_IDENTITY_MIGRATION must be 0 for production release");
  }
  validateDeviceIdentityBindings(process.env.HR_DEVICE_IDENTITY_BINDINGS?.trim() ?? "", bridgeSecret);
  if (requireText("ALRUEYA_PROD_BASE_URL", { max: 2048 }).replace(/\/$/, "") !== expected.productionBaseUrl) {
    fail("ALRUEYA_PROD_BASE_URL does not match the approved production endpoint");
  }
  // App Links للتطبيق الأصيل expo/customer-store-mobile — بلا هذه البصمة، /.well-known/assetlinks.json
  // يخدم بصمة EAS-dev المدمجة في wellKnown.ts، فApp Links على كلّ عميل Play يفتح Chrome بدل التطبيق.
  // البصمة تُقرأ من Play Console → Setup → App integrity → App signing → SHA-256.
  const storefrontFingerprintsRaw = requireText("STOREFRONT_ANDROID_SHA256_CERT_FINGERPRINTS", { max: 8192 });
  const storefrontFingerprints = storefrontFingerprintsRaw
    .split(",")
    .map((entry) => entry.trim().replace(/:/g, ""))
    .filter(Boolean);
  if (storefrontFingerprints.length === 0) {
    fail("STOREFRONT_ANDROID_SHA256_CERT_FINGERPRINTS is required for production storefront App Links");
  }
  for (const fingerprint of storefrontFingerprints) {
    if (!/^[0-9a-fA-F]{64}$/.test(fingerprint)) {
      fail("STOREFRONT_ANDROID_SHA256_CERT_FINGERPRINTS must be one or more SHA-256 hex fingerprints");
    }
  }
  const storefrontPackage = requireText("STOREFRONT_ANDROID_PACKAGE", { max: 255 });
  if (storefrontPackage !== "online.alarabiya.customerstore") {
    fail("STOREFRONT_ANDROID_PACKAGE must match the approved storefront applicationId");
  }
  if (!await verifyFirebaseCredentialExchange(serviceAccount, firebasePrivateKey)) {
    fail("FCM service-account OAuth credential exchange failed");
  }
}

const releaseMode = process.argv.includes("--release");
const selfTestOnly = process.argv.includes("--selftest") && !releaseMode;

try {
  await verifyProductionSecretPolicySelfTests();
  if (selfTestOnly) {
    console.log("mobile release gate: production secret policy self-tests passed");
  } else {
    verifySourceContract();
    if (releaseMode) await verifyReleaseEnvironment();
    console.log(releaseMode
      ? "mobile release gate: source, secret policy, and production inputs verified"
      : "mobile release gate: source contract and secret policy verified");
  }
} catch {
  if (!process.exitCode) {
    console.error("mobile release gate: unexpected validation failure");
    process.exitCode = 1;
  }
}
