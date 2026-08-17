import assert from "node:assert/strict";
import { Readable } from "node:stream";
import test from "node:test";
import {
  R2CanaryError,
  buildCanaryKey,
  buildUnauthenticatedObjectUrl,
  runR2ImageStoreCanary,
  safeCanaryFailureCode,
} from "./r2-image-store-canary.mjs";

const BYTES = Buffer.from("private-canary");
const KEY = "canary/r2-image-store/1-aaaaaaaaaaaaaaaaaaaaaaaa.png";
const URL = "https://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.r2.cloudflarestorage.com/private-images/canary";

function fakeStore(overrides = {}) {
  const calls = [];
  const store = {
    async put(key, bytes) {
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

test("canary ينفذ put/head/privacy/get/hash/delete ثم يؤكد الغياب", async () => {
  const { store, calls } = fakeStore();
  const result = await runR2ImageStoreCanary({
    store,
    key: KEY,
    endpointUrl: URL,
    bytes: BYTES,
    fetchUnauthenticated: async () => ({ status: 403, body: { cancel: async () => undefined } }),
  });
  assert.deepEqual(calls, ["put", "head", "get", "delete", "head"]);
  assert.equal(result.bytes, BYTES.length);
  assert.match(result.sha256, /^[0-9a-f]{64}$/);
  assert.equal(result.privacyStatus, 403);
  assert.equal(result.cleaned, true);
});

test("200 غير مصادق يفشل مغلقاً ويحذف الكائن في finally", async () => {
  const { store, calls } = fakeStore();
  await assert.rejects(
    runR2ImageStoreCanary({
      store,
      key: KEY,
      endpointUrl: URL,
      bytes: BYTES,
      fetchUnauthenticated: async () => ({ status: 200, body: { cancel: async () => undefined } }),
    }),
    (error) => error instanceof R2CanaryError && error.code === "CANARY_OBJECT_PUBLIC",
  );
  assert.deepEqual(calls, ["put", "head", "delete", "head"]);
});

test("تصادم المفتاح لا يحذف كائناً سابقاً لا يملكه canary", async () => {
  const { store, calls } = fakeStore({
    async put(key, bytes) {
      calls.push("put");
      return { key, bytes: bytes.length, existed: true };
    },
  });
  await assert.rejects(runR2ImageStoreCanary({
    store,
    key: KEY,
    endpointUrl: URL,
    bytes: BYTES,
    fetchUnauthenticated: async () => ({ status: 403 }),
  }), (error) => error instanceof R2CanaryError && error.code === "CANARY_KEY_COLLISION");
  assert.deepEqual(calls, ["put"]);
});

test("فشل get أو hash لا يترك canary متراكماً", async () => {
  const { store, calls } = fakeStore({ getStream: async () => { calls.push("get"); throw new Error("provider secret detail"); } });
  await assert.rejects(runR2ImageStoreCanary({
    store,
    key: KEY,
    endpointUrl: URL,
    bytes: BYTES,
    fetchUnauthenticated: async () => ({ status: 404, body: { cancel: async () => undefined } }),
  }), (error) => error instanceof R2CanaryError && error.code === "CANARY_R2_OPERATION_FAILED");
  assert.deepEqual(calls, ["put", "head", "get", "delete", "head"]);
});

test("المفتاح محصور في canary والـURL الرسمي لا يقبل endpoint حراً", () => {
  const key = buildCanaryKey(123, "a".repeat(24));
  assert.equal(key, `canary/r2-image-store/123-${"a".repeat(24)}.png`);
  assert.equal(
    buildUnauthenticatedObjectUrl("a".repeat(32), "private-images", key),
    `https://${"a".repeat(32)}.r2.cloudflarestorage.com/private-images/canary/r2-image-store/123-${"a".repeat(24)}.png`,
  );
  assert.throws(() => buildUnauthenticatedObjectUrl("evil.example", "private-images", key), /CANARY_ACCOUNT_INVALID/);
});

test("تنسيق الفشل لا يطبع message/cause الحساسة", () => {
  const error = new R2CanaryError("CANARY_GET_MISSING", new Error("secret-key bucket-name endpoint"));
  assert.equal(safeCanaryFailureCode(error), "CANARY_GET_MISSING");
  assert.doesNotMatch(safeCanaryFailureCode(error), /secret|bucket|endpoint/);
});
