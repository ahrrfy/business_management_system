#!/usr/bin/env node
/**
 * Canary إنتاجي خاص لـR2. لا يطبع account/bucket/key/URL أو تفاصيل أخطاء المزوّد.
 * التشغيل المقصود: node --import tsx scripts/r2-image-store-canary.mjs
 */
import { createHash, randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";

export const CANARY_CONFIRMATION = "RUN_PRIVATE_R2_CANARY";
const MAX_CANARY_BYTES = 64 * 1024;
const FETCH_TIMEOUT_MS = 10_000;
const MIN_BUCKET_LOCK_SECONDS = 90 * 24 * 60 * 60;
const REQUIRED_LOCK_PREFIXES = ["single/studio/"];
const CANARY_PREFIX = "canary/r2-image-store/";
const PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

export class R2CanaryError extends Error {
  constructor(code, cause) {
    super(code, cause === undefined ? undefined : { cause });
    this.name = "R2CanaryError";
    this.code = code;
  }
}

export function buildCanaryKey(now = Date.now(), entropy = randomBytes(12).toString("hex")) {
  if (!/^[0-9a-f]{24}$/i.test(entropy)) throw new R2CanaryError("CANARY_ENTROPY_INVALID");
  return `canary/r2-image-store/${now}-${entropy}.png`;
}

export function buildUnauthenticatedObjectUrl(accountId, bucket, key) {
  if (!/^[a-f0-9]{32}$/.test(accountId)) throw new R2CanaryError("CANARY_ACCOUNT_INVALID");
  if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket)) throw new R2CanaryError("CANARY_BUCKET_INVALID");
  if (!/^canary\/r2-image-store\/[A-Za-z0-9._/-]+$/.test(key) || key.includes("..") || key.includes("//")) {
    throw new R2CanaryError("CANARY_KEY_INVALID");
  }
  const path = [bucket, ...key.split("/")].map(encodeURIComponent).join("/");
  return `https://${accountId}.r2.cloudflarestorage.com/${path}`;
}

function assertCanaryAccountAndBucket(accountId, bucket) {
  if (!/^[a-f0-9]{32}$/.test(accountId)) throw new R2CanaryError("CANARY_ACCOUNT_INVALID");
  if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket)) throw new R2CanaryError("CANARY_BUCKET_INVALID");
}

export function buildCloudflareBucketDomainUrls(accountId, bucket) {
  assertCanaryAccountAndBucket(accountId, bucket);
  const prefix = `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}` +
    `/r2/buckets/${encodeURIComponent(bucket)}/domains`;
  const bucketPrefix = `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}` +
    `/r2/buckets/${encodeURIComponent(bucket)}`;
  return {
    managed: `${prefix}/managed`,
    custom: `${prefix}/custom`,
    lock: `${bucketPrefix}/lock`,
    lifecycle: `${bucketPrefix}/lifecycle`,
  };
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

async function fetchCloudflareApiResult(url, apiToken, fetchCloudflareApi) {
  let response;
  try {
    response = await fetchCloudflareApi(url, {
      method: "GET",
      headers: { Authorization: `Bearer ${apiToken}`, Accept: "application/json" },
      redirect: "error",
      cache: "no-store",
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch (error) {
    throw new R2CanaryError("CANARY_PRIVACY_CONFIG_API_FAILED", error);
  }
  if (response?.status !== 200 || typeof response.json !== "function") {
    throw new R2CanaryError("CANARY_PRIVACY_CONFIG_API_FAILED");
  }
  let body;
  try {
    body = await response.json();
  } catch (error) {
    throw new R2CanaryError("CANARY_PRIVACY_CONFIG_INVALID", error);
  }
  if (!isPlainObject(body) || body.success !== true || !Array.isArray(body.errors) || body.errors.length !== 0 ||
      !isPlainObject(body.result)) {
    throw new R2CanaryError("CANARY_PRIVACY_CONFIG_INVALID");
  }
  return body.result;
}

/**
 * يثبت أن مساري النشر المباشر مغلقان من مصدر الحقيقة الرسمي في Cloudflare.
 * 403/404 من S3 وحده لا يثبت ذلك لأن r2.dev وcustom domains مساران مستقلان.
 */
export async function verifyR2BucketPrivacyConfiguration({
  accountId,
  bucket,
  apiToken,
  fetchCloudflareApi = globalThis.fetch,
}) {
  assertCanaryAccountAndBucket(accountId, bucket);
  if (typeof apiToken !== "string" || apiToken.trim() !== apiToken || apiToken.length < 16 ||
      apiToken.length > 2048 || /[\x00-\x20\x7f]/.test(apiToken)) {
    throw new R2CanaryError("CANARY_PRIVACY_CONFIG_TOKEN_REQUIRED");
  }
  if (typeof fetchCloudflareApi !== "function") throw new R2CanaryError("CANARY_FETCH_UNAVAILABLE");
  const urls = buildCloudflareBucketDomainUrls(accountId, bucket);
  const managed = await fetchCloudflareApiResult(urls.managed, apiToken, fetchCloudflareApi);
  if (typeof managed.bucketId !== "string" || !/^[a-f0-9]{32}$/i.test(managed.bucketId) ||
      typeof managed.domain !== "string" || managed.domain.length === 0 || typeof managed.enabled !== "boolean") {
    throw new R2CanaryError("CANARY_PRIVACY_CONFIG_INVALID");
  }
  if (managed.enabled) throw new R2CanaryError("CANARY_R2_DEV_PUBLIC");

  const custom = await fetchCloudflareApiResult(urls.custom, apiToken, fetchCloudflareApi);
  if (!Array.isArray(custom.domains)) throw new R2CanaryError("CANARY_PRIVACY_CONFIG_INVALID");
  if (custom.domains.length !== 0) throw new R2CanaryError("CANARY_CUSTOM_DOMAIN_CONFIGURED");

  const lock = await fetchCloudflareApiResult(urls.lock, apiToken, fetchCloudflareApi);
  if (!Array.isArray(lock.rules)) throw new R2CanaryError("CANARY_BUCKET_LOCK_CONFIG_INVALID");
  const enabledLocks = lock.rules.filter((rule) => {
    if (!isPlainObject(rule) || typeof rule.enabled !== "boolean" ||
        (rule.prefix !== undefined && typeof rule.prefix !== "string") || !isPlainObject(rule.condition)) {
      throw new R2CanaryError("CANARY_BUCKET_LOCK_CONFIG_INVALID");
    }
    const condition = rule.condition;
    if (condition.type === "Age") {
      if (!Number.isSafeInteger(condition.maxAgeSeconds) || condition.maxAgeSeconds <= 0) {
        throw new R2CanaryError("CANARY_BUCKET_LOCK_CONFIG_INVALID");
      }
    } else if (condition.type !== "Indefinite" && condition.type !== "Date") {
      throw new R2CanaryError("CANARY_BUCKET_LOCK_CONFIG_INVALID");
    }
    return rule.enabled;
  });
  if (enabledLocks.some((rule) => CANARY_PREFIX.startsWith(rule.prefix ?? ""))) {
    throw new R2CanaryError("CANARY_BUCKET_LOCK_BLOCKS_CLEANUP");
  }
  const protectedPrefixes = REQUIRED_LOCK_PREFIXES.filter((requiredPrefix) => enabledLocks.some((rule) => {
    const prefix = rule.prefix ?? "";
    const condition = rule.condition;
    return requiredPrefix.startsWith(prefix) && (
      condition.type === "Indefinite" ||
      (condition.type === "Age" && condition.maxAgeSeconds >= MIN_BUCKET_LOCK_SECONDS)
    );
  }));
  if (protectedPrefixes.length !== REQUIRED_LOCK_PREFIXES.length) {
    throw new R2CanaryError("CANARY_BUCKET_LOCK_MISSING");
  }

  const lifecycle = await fetchCloudflareApiResult(urls.lifecycle, apiToken, fetchCloudflareApi);
  if (!Array.isArray(lifecycle.rules)) throw new R2CanaryError("CANARY_LIFECYCLE_CONFIG_INVALID");
  let lifecycleDeleteRuleCount = 0;
  for (const rule of lifecycle.rules) {
    if (!isPlainObject(rule) || typeof rule.enabled !== "boolean") {
      throw new R2CanaryError("CANARY_LIFECYCLE_CONFIG_INVALID");
    }
    if (rule.enabled && rule.deleteObjectsTransition !== undefined) lifecycleDeleteRuleCount += 1;
  }
  if (lifecycleDeleteRuleCount > 0) throw new R2CanaryError("CANARY_LIFECYCLE_DELETE_CONFIGURED");
  return { managedR2DevEnabled: false, customDomainCount: 0, lifecycleDeleteRuleCount, protectedPrefixes };
}

async function streamBytes(stream, expectedMaximum) {
  const chunks = [];
  let total = 0;
  for await (const chunk of stream) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += bytes.length;
    if (total > expectedMaximum) {
      stream.destroy?.();
      throw new R2CanaryError("CANARY_GET_TOO_LARGE");
    }
    chunks.push(bytes);
  }
  return Buffer.concat(chunks);
}

function isNotFound(error) {
  if (!error || typeof error !== "object") return false;
  return error.name === "NotFound" || error.name === "NoSuchKey" || error.Code === "NoSuchKey" ||
    error.code === "NoSuchKey" || error.$metadata?.httpStatusCode === 404;
}

async function cleanupCanaryObject(cleanupStore, key) {
  let lastError;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      await cleanupStore.delete(key);
    } catch (error) {
      lastError = error;
    }
    try {
      const head = await cleanupStore.head(key);
      if (!head.exists) return;
      lastError = new R2CanaryError("CANARY_CLEANUP_OBJECT_REMAINS");
    } catch (error) {
      lastError = error;
    }
  }
  throw new R2CanaryError("CANARY_CLEANUP_FAILED", lastError);
}

/**
 * تُحقن التبعيات في الاختبار؛ في التشغيل الحقيقي store هو R2ImageStore والـURL هو endpoint الرسمي.
 * لا يقبل 200 من الطلب غير المصادق: ذلك يعني أن الكائن قابل للقراءة خارج بوابة التطبيق.
 */
export async function runR2ImageStoreCanary({
  store,
  cleanupStore,
  key,
  endpointUrl,
  bytes = PNG_1X1,
  privacyConfiguration,
  fetchUnauthenticated = globalThis.fetch,
}) {
  if (!Buffer.isBuffer(bytes) || bytes.length === 0 || bytes.length > MAX_CANARY_BYTES) {
    throw new R2CanaryError("CANARY_PAYLOAD_INVALID");
  }
  if (!cleanupStore || cleanupStore === store || typeof cleanupStore.delete !== "function" ||
      typeof cleanupStore.head !== "function") {
    throw new R2CanaryError("CANARY_INDEPENDENT_CLEANUP_REQUIRED");
  }
  if (typeof fetchUnauthenticated !== "function") throw new R2CanaryError("CANARY_FETCH_UNAVAILABLE");
  const expectedHash = createHash("sha256").update(bytes).digest("hex");
  let cleanupRequired = false;
  let primaryError = null;
  let result = null;

  try {
    if (!privacyConfiguration || typeof privacyConfiguration !== "object") {
      throw new R2CanaryError("CANARY_PRIVACY_CONFIG_REQUIRED");
    }
    await verifyR2BucketPrivacyConfiguration(privacyConfiguration);

    // إن رمى PUT بعد وصوله للمزوّد فوجود الكائن غير محسوم، لذلك ننظف. لكن إن عاد existed=true
    // فلا نحذف كائناً سابقاً (تصادم عشوائي شديد الندرة) لا نملكه.
    cleanupRequired = true;
    const put = await store.put(key, bytes, "image/png");
    if (put.existed) {
      cleanupRequired = false;
      throw new R2CanaryError("CANARY_KEY_COLLISION");
    }
    if (put.key !== key || put.bytes !== bytes.length) throw new R2CanaryError("CANARY_PUT_CONTRACT");

    const head = await store.head(key);
    if (!head.exists || head.bytes !== bytes.length) throw new R2CanaryError("CANARY_HEAD_MISMATCH");

    // أعد الإثبات والكائن موجود لإغلاق نافذة تغيّر الإعداد بين الفحص الأول وPUT.
    await verifyR2BucketPrivacyConfiguration(privacyConfiguration);

    let privacyResponse;
    try {
      privacyResponse = await fetchUnauthenticated(endpointUrl, {
        method: "GET",
        redirect: "manual",
        cache: "no-store",
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
    } catch (error) {
      throw new R2CanaryError("CANARY_PRIVACY_PROBE_FAILED", error);
    }
    if (privacyResponse.status !== 403 && privacyResponse.status !== 404) {
      throw new R2CanaryError("CANARY_OBJECT_PUBLIC");
    }
    await privacyResponse.body?.cancel?.();

    const stream = await store.getStream(key);
    if (!stream) throw new R2CanaryError("CANARY_GET_MISSING");
    const received = await streamBytes(stream, bytes.length);
    const actualHash = createHash("sha256").update(received).digest("hex");
    if (received.length !== bytes.length || actualHash !== expectedHash) {
      throw new R2CanaryError("CANARY_HASH_MISMATCH");
    }
    result = { bytes: bytes.length, sha256: expectedHash, privacyStatus: privacyResponse.status };
  } catch (error) {
    primaryError = error;
  } finally {
    if (cleanupRequired) {
      try {
        await cleanupCanaryObject(cleanupStore, key);
      } catch (cleanupError) {
        if (!primaryError) primaryError = cleanupError;
        else primaryError = new R2CanaryError("CANARY_CLEANUP_FAILED", cleanupError);
      }
    }
  }

  if (primaryError) {
    if (primaryError instanceof R2CanaryError) throw primaryError;
    throw new R2CanaryError("CANARY_R2_OPERATION_FAILED", primaryError);
  }
  return { ...result, cleaned: true };
}

/** لا يعرض message/cause لأن SDK قد يضمّن endpoint أو معرّفات في تفاصيل الخطأ. */
export function safeCanaryFailureCode(error) {
  return error instanceof R2CanaryError ? error.code : "CANARY_UNEXPECTED_FAILURE";
}

async function main() {
  if (process.env.R2_CANARY_CONFIRM !== CANARY_CONFIRMATION) {
    throw new R2CanaryError("CANARY_CONFIRMATION_REQUIRED");
  }
  if (process.env.IMAGE_STORE_DRIVER?.trim().toLowerCase() !== "r2") {
    throw new R2CanaryError("CANARY_R2_DRIVER_REQUIRED");
  }
  const [{ R2ImageStore, readR2ImageStoreConfig }, { S3Client, DeleteObjectCommand, HeadObjectCommand }] = await Promise.all([
    import("../server/lib/imageStore/r2Store.ts"),
    import("@aws-sdk/client-s3"),
  ]);
  const config = readR2ImageStoreConfig(process.env);
  const cloudflareApiToken = process.env.R2_CANARY_CLOUDFLARE_API_TOKEN;
  if (!cloudflareApiToken) throw new R2CanaryError("CANARY_PRIVACY_CONFIG_TOKEN_REQUIRED");
  const key = buildCanaryKey();
  const endpointUrl = buildUnauthenticatedObjectUrl(config.accountId, config.bucket, key);
  // عميل cleanup خاص بالـCLI فقط، بلا semaphore/breaker التطبيق: إذا وصل PUT ثم عاد 503 لا
  // يجوز أن يمنع circuit_open حذف مفتاح canary. لا تُصدّر هذه البوابة إلى runtime التطبيق.
  const cleanupClient = new S3Client({
    region: "auto",
    endpoint: `https://${config.accountId}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
    maxAttempts: 2,
    requestHandler: {
      connectionTimeout: 5_000,
      requestTimeout: 10_000,
      socketTimeout: 10_000,
      throwOnRequestTimeout: true,
    },
  });
  const cleanupStore = {
    async delete(objectKey) {
      await cleanupClient.send(new DeleteObjectCommand({ Bucket: config.bucket, Key: objectKey }));
    },
    async head(objectKey) {
      try {
        await cleanupClient.send(new HeadObjectCommand({ Bucket: config.bucket, Key: objectKey }));
        return { exists: true };
      } catch (error) {
        if (isNotFound(error)) return { exists: false };
        throw error;
      }
    },
  };
  const result = await runR2ImageStoreCanary({
    store: new R2ImageStore(config),
    cleanupStore,
    key,
    endpointUrl,
    privacyConfiguration: {
      accountId: config.accountId,
      bucket: config.bucket,
      apiToken: cloudflareApiToken,
    },
  });
  process.stdout.write(`R2 canary: OK bytes=${result.bytes} privacy=${result.privacyStatus} cleanup=verified\n`);
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  main().catch((error) => {
    process.stderr.write(`R2 canary: FAIL code=${safeCanaryFailureCode(error)}\n`);
    process.exitCode = 1;
  });
}
