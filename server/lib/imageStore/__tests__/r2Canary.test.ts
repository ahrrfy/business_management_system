import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

// Vite SSR على Windows لا يزيل shebang إذا حوّل Git الملف CLI إلى CRLF، فيفشل parse قبل
// collection. نختبر نفس المصدر بعد إزالة غلاف التشغيل فقط؛ Node CLI نفسه يبقى بلا تعديل.
const canaryCliUrl = new globalThis.URL("../../../../scripts/r2-image-store-canary.mjs", import.meta.url);
const canaryModuleDir = await mkdtemp(join(tmpdir(), "r2-canary-vitest-"));
const canaryModulePath = join(canaryModuleDir, "r2-image-store-canary.mjs");
const canarySource = (await readFile(fileURLToPath(canaryCliUrl), "utf8"))
  .replace(/^#![^\r\n]*(?:\r?\n|$)/, "")
  .replace(/\r\n/g, "\n");
await writeFile(canaryModulePath, canarySource, "utf8");
afterAll(() => rm(canaryModuleDir, { recursive: true, force: true }));

const {
  R2CanaryError,
  buildCanaryKey,
  buildCloudflareBucketDomainUrls,
  buildUnauthenticatedObjectUrl,
  runR2ImageStoreCanary,
  safeCanaryFailureCode,
  verifyR2BucketPrivacyConfiguration,
} = await import(
  /* @vite-ignore -- الملف المؤقت خارج Vite graph عمداً. */
  pathToFileURL(canaryModulePath).href
);

const BYTES = Buffer.from("private-canary");
const KEY = "canary/r2-image-store/1-aaaaaaaaaaaaaaaaaaaaaaaa.png";
const URL = "https://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.r2.cloudflarestorage.com/private-images/canary";
const ACCOUNT_ID = "a".repeat(32);
const BUCKET = "private-images";
const API_TOKEN = "canary-read-token-never-log";

function cloudflareResponse(result: unknown, status = 200) {
  return {
    status,
    async json() {
      return status === 200 ? { success: true, errors: [], messages: [], result } : { success: false };
    },
  };
}

function privateCloudflareFetch() {
  return async (url: string) => {
    if (url.endsWith("/domains/managed")) {
      return cloudflareResponse({ bucketId: "b".repeat(32), domain: "private.r2.dev", enabled: false });
    }
    if (url.endsWith("/domains/custom")) return cloudflareResponse({ domains: [] });
    if (url.endsWith("/lock")) {
      return cloudflareResponse({
        rules: [
          {
            id: "retain-single-studio-90d",
            enabled: true,
            prefix: "single/studio/",
            condition: { type: "Age", maxAgeSeconds: 90 * 24 * 60 * 60 },
          },
          {
            id: "retain-all-company-namespaces-90d",
            enabled: true,
            prefix: "company-",
            condition: { type: "Age", maxAgeSeconds: 90 * 24 * 60 * 60 },
          },
        ],
      });
    }
    if (url.endsWith("/lifecycle")) {
      return cloudflareResponse({
        rules: [{
          id: "abort-incomplete-multipart",
          enabled: true,
          conditions: { prefix: "" },
          abortMultipartUploadsTransition: { condition: { type: "Age", maxAge: 7 * 24 * 60 * 60 } },
        }],
      });
    }
    throw new Error("unexpected Cloudflare URL");
  };
}

function privateConfiguration() {
  return {
    accountId: ACCOUNT_ID,
    bucket: BUCKET,
    apiToken: API_TOKEN,
    fetchCloudflareApi: privateCloudflareFetch(),
  };
}

function fakeStore(overrides: Record<string, unknown> = {}) {
  const calls: string[] = [];
  const store = {
    async put(key: string, bytes: Buffer) {
      calls.push("put");
      return { key, bytes: bytes.length, existed: false };
    },
    async head() {
      calls.push("head");
      return calls.includes("delete") ? { exists: false } : { exists: true, bytes: BYTES.length };
    },
    async getStream() {
      calls.push("get");
      return Readable.from([BYTES]);
    },
    async delete() {
      calls.push("delete");
    },
    ...overrides,
  };
  return { store, calls };
}

function independentCleanup(store: { delete: (key: string) => Promise<void>; head: (key: string) => Promise<unknown> }) {
  return {
    delete: (key: string) => store.delete(key),
    head: (key: string) => store.head(key),
  };
}

describe("R2 production canary", () => {
  it("ينفذ put/head/privacy/get/hash/delete ثم يؤكد الغياب", async () => {
    const { store, calls } = fakeStore();
    const result = await runR2ImageStoreCanary({
      store,
      cleanupStore: independentCleanup(store),
      key: KEY,
      endpointUrl: URL,
      bytes: BYTES,
      privacyConfiguration: privateConfiguration(),
      fetchUnauthenticated: async () => ({ status: 403, body: { cancel: async () => undefined } }),
    });
    expect(calls).toEqual(["put", "head", "get", "delete", "head"]);
    expect(result).toMatchObject({ bytes: BYTES.length, privacyStatus: 403, cleaned: true });
    expect(result.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("يفشل مغلقاً عند 200 غير مصادق ويحذف الكائن في finally", async () => {
    const { store, calls } = fakeStore();
    await expect(runR2ImageStoreCanary({
      store,
      cleanupStore: independentCleanup(store),
      key: KEY,
      endpointUrl: URL,
      bytes: BYTES,
      privacyConfiguration: privateConfiguration(),
      fetchUnauthenticated: async () => ({ status: 200, body: { cancel: async () => undefined } }),
    })).rejects.toMatchObject({ code: "CANARY_OBJECT_PUBLIC" });
    expect(calls).toEqual(["put", "head", "delete", "head"]);
  });

  it("لا يحذف كائناً سابقاً عند تصادم المفتاح", async () => {
    const { store, calls } = fakeStore({
      async put(key: string, bytes: Buffer) {
        calls.push("put");
        return { key, bytes: bytes.length, existed: true };
      },
    });
    await expect(runR2ImageStoreCanary({
      store,
      cleanupStore: independentCleanup(store),
      key: KEY,
      endpointUrl: URL,
      bytes: BYTES,
      privacyConfiguration: privateConfiguration(),
      fetchUnauthenticated: async () => ({ status: 403 }),
    })).rejects.toMatchObject({ code: "CANARY_KEY_COLLISION" });
    expect(calls).toEqual(["put"]);
  });

  it("لا يترك كائناً متراكماً عند فشل get/hash", async () => {
    const { store, calls } = fakeStore({
      getStream: async () => {
        calls.push("get");
        throw new Error("provider secret detail");
      },
    });
    await expect(runR2ImageStoreCanary({
      store,
      cleanupStore: independentCleanup(store),
      key: KEY,
      endpointUrl: URL,
      bytes: BYTES,
      privacyConfiguration: privateConfiguration(),
      fetchUnauthenticated: async () => ({ status: 404, body: { cancel: async () => undefined } }),
    })).rejects.toMatchObject({ code: "CANARY_R2_OPERATION_FAILED" });
    expect(calls).toEqual(["put", "head", "get", "delete", "head"]);
  });

  it("يحصر المفتاح في canary والـURL في endpoint الرسمي", () => {
    const key = buildCanaryKey(123, "a".repeat(24));
    expect(key).toBe(`canary/r2-image-store/123-${"a".repeat(24)}.png`);
    expect(buildUnauthenticatedObjectUrl("a".repeat(32), "private-images", key)).toBe(
      `https://${"a".repeat(32)}.r2.cloudflarestorage.com/private-images/canary/r2-image-store/123-${"a".repeat(24)}.png`,
    );
    expect(() => buildUnauthenticatedObjectUrl("evil.example", "private-images", key)).toThrow(/CANARY_ACCOUNT_INVALID/);
  });

  it("لا يطبع message/cause الحساسة", () => {
    const error = new R2CanaryError("CANARY_GET_MISSING", new Error("secret-key bucket-name endpoint"));
    expect(safeCanaryFailureCode(error)).toBe("CANARY_GET_MISSING");
    expect(safeCanaryFailureCode(error)).not.toMatch(/secret|bucket|endpoint/);
  });

  it("يفشل قبل PUT إذا كان managed r2.dev مفعلاً", async () => {
    const { store, calls } = fakeStore();
    await expect(runR2ImageStoreCanary({
      store,
      cleanupStore: independentCleanup(store),
      key: KEY,
      endpointUrl: URL,
      bytes: BYTES,
      privacyConfiguration: {
        ...privateConfiguration(),
        fetchCloudflareApi: async (url: string) => url.endsWith("/domains/managed")
          ? cloudflareResponse({ bucketId: "b".repeat(32), domain: "public.r2.dev", enabled: true })
          : privateCloudflareFetch()(url),
      },
      fetchUnauthenticated: async () => ({ status: 404 }),
    })).rejects.toMatchObject({ code: "CANARY_R2_DEV_PUBLIC" });
    expect(calls).toEqual([]);
  });

  it("يفشل إذا كان أي custom domain مسجلاً ولو كان disabled", async () => {
    await expect(verifyR2BucketPrivacyConfiguration({
      ...privateConfiguration(),
      fetchCloudflareApi: async (url: string) => url.endsWith("/domains/managed")
        ? cloudflareResponse({ bucketId: "b".repeat(32), domain: "private.r2.dev", enabled: false })
        : url.endsWith("/domains/custom")
          ? cloudflareResponse({ domains: [{ domain: "secret.example", enabled: false }] })
          : privateCloudflareFetch()(url),
    })).rejects.toMatchObject({ code: "CANARY_CUSTOM_DOMAIN_CONFIGURED" });
  });

  it("يفشل إذا لم يغط Bucket Lock مسار single/studio/ مدة 90 يوماً", async () => {
    await expect(verifyR2BucketPrivacyConfiguration({
      ...privateConfiguration(),
      fetchCloudflareApi: async (url: string) => url.endsWith("/lock")
        ? cloudflareResponse({ rules: [] })
        : privateCloudflareFetch()(url),
    })).rejects.toMatchObject({ code: "CANARY_BUCKET_LOCK_MISSING" });
  });

  it("يفشل إذا لم يغط Bucket Lock مسارات company-*/studio مدة 90 يوماً", async () => {
    await expect(verifyR2BucketPrivacyConfiguration({
      ...privateConfiguration(),
      fetchCloudflareApi: async (url: string) => url.endsWith("/lock")
        ? cloudflareResponse({ rules: [{
          id: "single-only",
          enabled: true,
          prefix: "single/studio/",
          condition: { type: "Age", maxAgeSeconds: 90 * 24 * 60 * 60 },
        }] })
        : privateCloudflareFetch()(url),
    })).rejects.toMatchObject({ code: "CANARY_BUCKET_LOCK_MISSING" });
  });

  it("يفشل إذا غطّى Bucket Lock مسار canary ومنع تنظيفه", async () => {
    await expect(verifyR2BucketPrivacyConfiguration({
      ...privateConfiguration(),
      fetchCloudflareApi: async (url: string) => url.endsWith("/lock")
        ? cloudflareResponse({
          rules: [{
            id: "unsafe-global-lock",
            enabled: true,
            prefix: "",
            condition: { type: "Age", maxAgeSeconds: 90 * 24 * 60 * 60 },
          }],
        })
        : privateCloudflareFetch()(url),
    })).rejects.toMatchObject({ code: "CANARY_BUCKET_LOCK_BLOCKS_CLEANUP" });
  });

  it("يفشل عند أي lifecycle delete مفعّل ولو بعد أكثر من 90 يوماً", async () => {
    await expect(verifyR2BucketPrivacyConfiguration({
      ...privateConfiguration(),
      fetchCloudflareApi: async (url: string) => url.endsWith("/lifecycle")
        ? cloudflareResponse({
          rules: [{
            id: "unsafe-delete",
            enabled: true,
            conditions: { prefix: "single/" },
            deleteObjectsTransition: { condition: { type: "Age", maxAge: 365 * 24 * 60 * 60 } },
          }],
        })
        : privateCloudflareFetch()(url),
    })).rejects.toMatchObject({ code: "CANARY_LIFECYCLE_DELETE_CONFIGURED" });
  });

  it.each([
    ["API auth", async () => cloudflareResponse(null, 403)],
    ["API error", async () => ({ status: 200, json: async () => ({ success: false, errors: [{ code: 1 }] }) })],
    ["unknown managed shape", async (url: string) => url.endsWith("/domains/managed")
      ? cloudflareResponse({ enabled: false })
      : cloudflareResponse({ domains: [] })],
    ["unknown custom shape", async (url: string) => url.endsWith("/domains/managed")
      ? cloudflareResponse({ bucketId: "b".repeat(32), domain: "private.r2.dev", enabled: false })
      : cloudflareResponse({})],
  ])("يفشل مغلقاً عند %s ولا يقبل 404 غير المصادق كبديل", async (_name, fetchCloudflareApi) => {
    const { store, calls } = fakeStore();
    await expect(runR2ImageStoreCanary({
      store,
      cleanupStore: independentCleanup(store),
      key: KEY,
      endpointUrl: URL,
      bytes: BYTES,
      privacyConfiguration: { ...privateConfiguration(), fetchCloudflareApi },
      fetchUnauthenticated: async () => ({ status: 404 }),
    })).rejects.toBeInstanceOf(R2CanaryError);
    expect(calls).toEqual([]);
  });

  it("ينظف بعميل مستقل إذا وصل PUT ثم فتح سائق التطبيق القاطع", async () => {
    const calls: string[] = [];
    let exists = true;
    const store = {
      async put() {
        calls.push("put-app");
        throw Object.assign(new Error("response lost after persist"), { $metadata: { httpStatusCode: 503 } });
      },
      async head() { throw new Error("app breaker must not be used"); },
      async getStream() { return null; },
      async delete() { throw new Error("app breaker must not be used"); },
    };
    const cleanupStore = {
      async delete() {
        calls.push("delete-cleanup");
        exists = false;
      },
      async head() {
        calls.push("head-cleanup");
        return { exists };
      },
    };
    await expect(runR2ImageStoreCanary({
      store,
      cleanupStore,
      key: KEY,
      endpointUrl: URL,
      bytes: BYTES,
      privacyConfiguration: privateConfiguration(),
      fetchUnauthenticated: async () => ({ status: 404 }),
    })).rejects.toMatchObject({ code: "CANARY_R2_OPERATION_FAILED" });
    expect(calls).toEqual(["put-app", "delete-cleanup", "head-cleanup"]);
  });

  it("يستعمل endpoints الرسمية وBearer دون تسريب الاعتماد في النتيجة", async () => {
    const calls: Array<{ url: string; options: Record<string, unknown> }> = [];
    const urls = buildCloudflareBucketDomainUrls(ACCOUNT_ID, BUCKET);
    const result = await verifyR2BucketPrivacyConfiguration({
      accountId: ACCOUNT_ID,
      bucket: BUCKET,
      apiToken: API_TOKEN,
      fetchCloudflareApi: async (url: string, options: Record<string, unknown>) => {
        calls.push({ url, options });
        return url === urls.managed
          ? cloudflareResponse({ bucketId: "b".repeat(32), domain: "private.r2.dev", enabled: false })
          : privateCloudflareFetch()(url);
      },
    });
    expect(calls.map((call) => call.url)).toEqual([urls.managed, urls.custom, urls.lock, urls.lifecycle]);
    expect(calls.every((call) => (call.options.headers as Record<string, string>).Authorization === `Bearer ${API_TOKEN}`)).toBe(true);
    expect(JSON.stringify(result)).not.toContain(API_TOKEN);
    expect(result).toEqual({
      managedR2DevEnabled: false,
      customDomainCount: 0,
      lifecycleDeleteRuleCount: 0,
      protectedPrefixes: ["single/studio/", "company-"],
    });
  });
});
