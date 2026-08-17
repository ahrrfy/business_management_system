import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import {
  R2CanaryError,
  buildCanaryKey,
  buildCloudflareBucketDomainUrls,
  buildUnauthenticatedObjectUrl,
  runR2ImageStoreCanary,
  safeCanaryFailureCode,
  verifyR2BucketPrivacyConfiguration,
} from "../../../../scripts/r2-image-store-canary.mjs";

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
  return async (url: string) => url.endsWith("/domains/managed")
    ? cloudflareResponse({ bucketId: "b".repeat(32), domain: "private.r2.dev", enabled: false })
    : cloudflareResponse({ domains: [] });
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
          : cloudflareResponse({ domains: [] }),
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
        : cloudflareResponse({ domains: [{ domain: "secret.example", enabled: false }] }),
    })).rejects.toMatchObject({ code: "CANARY_CUSTOM_DOMAIN_CONFIGURED" });
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
          : cloudflareResponse({ domains: [] });
      },
    });
    expect(calls.map((call) => call.url)).toEqual([urls.managed, urls.custom]);
    expect(calls.every((call) => (call.options.headers as Record<string, string>).Authorization === `Bearer ${API_TOKEN}`)).toBe(true);
    expect(JSON.stringify(result)).not.toContain(API_TOKEN);
    expect(result).toEqual({ managedR2DevEnabled: false, customDomainCount: 0 });
  });
});
