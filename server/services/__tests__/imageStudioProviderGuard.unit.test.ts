/** اختبارات بلا قاعدة بيانات لحواجز مزوّدي الاستوديو: المهلة وحجم الرد ونوع الصورة. */
import { describe, expect, it } from "vitest";
import { generateStudioImage } from "../aiImageStudioService";
import { callRemovebg } from "../removebgService";

describe("image-studio provider hard limits", () => {
  it("remove.bg: يقطع الجسم المصرّح أنه أكبر من الحد", async () => {
    const fakeFetch: typeof fetch = async () => new Response(Buffer.from([1, 2, 3]), { status: 200, headers: { "content-length": "3" } });
    await expect(callRemovebg("key", "QUJD", { fetchImpl: fakeFetch, maxResponseBytes: 2 })).rejects.toMatchObject({ kind: "RESPONSE_TOO_LARGE" });
  });

  it("Gemini: المهلة تُحوّل إلى TIMEOUT قابل للمعالجة", async () => {
    const fakeFetch: typeof fetch = async (_url, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("timed out", "TimeoutError")), { once: true });
      });
    await expect(generateStudioImage({ apiKey: "key", prompt: "product" }, { fetchImpl: fakeFetch, timeoutMs: 1 })).rejects.toMatchObject({ kind: "TIMEOUT" });
  });

  it("Gemini: يمنع نتيجة ليست صورة من الوصول إلى data URL", async () => {
    const fakeFetch: typeof fetch = async () =>
      new Response(JSON.stringify({ candidates: [{ content: { parts: [{ inlineData: { mimeType: "text/html", data: "QUJD" } }] } }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    await expect(generateStudioImage({ apiKey: "key", prompt: "product" }, { fetchImpl: fakeFetch })).rejects.toMatchObject({ kind: "SERVICE" });
  });
});
