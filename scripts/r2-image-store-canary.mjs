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

/**
 * تُحقن التبعيات في الاختبار؛ في التشغيل الحقيقي store هو R2ImageStore والـURL هو endpoint الرسمي.
 * لا يقبل 200 من الطلب غير المصادق: ذلك يعني أن الكائن قابل للقراءة خارج بوابة التطبيق.
 */
export async function runR2ImageStoreCanary({
  store,
  key,
  endpointUrl,
  bytes = PNG_1X1,
  fetchUnauthenticated = globalThis.fetch,
}) {
  if (!Buffer.isBuffer(bytes) || bytes.length === 0 || bytes.length > MAX_CANARY_BYTES) {
    throw new R2CanaryError("CANARY_PAYLOAD_INVALID");
  }
  if (typeof fetchUnauthenticated !== "function") throw new R2CanaryError("CANARY_FETCH_UNAVAILABLE");
  const expectedHash = createHash("sha256").update(bytes).digest("hex");
  let cleanupRequired = false;
  let primaryError = null;
  let result = null;

  try {
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
        await store.delete(key);
        const afterDelete = await store.head(key);
        if (afterDelete.exists) throw new R2CanaryError("CANARY_CLEANUP_OBJECT_REMAINS");
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
  const [{ R2ImageStore, readR2ImageStoreConfig }] = await Promise.all([
    import("../server/lib/imageStore/r2Store.ts"),
  ]);
  const config = readR2ImageStoreConfig(process.env);
  const key = buildCanaryKey();
  const endpointUrl = buildUnauthenticatedObjectUrl(config.accountId, config.bucket, key);
  const result = await runR2ImageStoreCanary({ store: new R2ImageStore(config), key, endpointUrl });
  process.stdout.write(`R2 canary: OK bytes=${result.bytes} privacy=${result.privacyStatus} cleanup=verified\n`);
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  main().catch((error) => {
    process.stderr.write(`R2 canary: FAIL code=${safeCanaryFailureCode(error)}\n`);
    process.exitCode = 1;
  });
}
