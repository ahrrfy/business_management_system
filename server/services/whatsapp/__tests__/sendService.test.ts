/**
 * اختبارات وحدة خالصة لـsendService — fetch مُموَّه بلا قاعدة بيانات (لا __setup__ يلمسها فعلياً؛
 * موجودة عالمياً في setupFiles لكن afterEach لا يفعل شيئاً هنا لأننا لا نكتب في DB).
 * تركّز على: تصنيف classifyGraphError (retryable/permanent/pauseworthy)، بناء حمولة القالب،
 * وtoWaId. اختبارات DB (dispatch/outbox) في server/services/__tests__/waOutbox.test.ts.
 */
import { describe, expect, it } from "vitest";
import { classifyGraphError, sendSessionText, sendTemplate, toWaId } from "../sendService";

describe("classifyGraphError", () => {
  it.each([
    [500, undefined, "retryable"],
    [502, undefined, "retryable"],
    [429, undefined, "retryable"],
    [400, 130429, "retryable"],
    [400, 131047, "permanent"],
    [400, 131026, "permanent"],
    [400, 131056, "permanent"],
    [400, 100, "permanent"],
    [400, 132001, "permanent"], // نطاق أخطاء القوالب 132000-132015
    [400, 131048, "pauseworthy"],
    [0, undefined, "retryable"], // فشل شبكة (graphFetch يُعيد status=0)
  ] as const)("status=%i code=%s ⇒ %s", (status, code, expected) => {
    const body = code != null ? { error: { code, message: "تفصيل تجريبي" } } : { error: { message: "تفصيل تجريبي" } };
    const r = classifyGraphError(status, body);
    expect(r.classification).toBe(expected);
  });

  it("رسالة 131047 عربية وتحوي «قالب» (نافذة الردّ الحرّ مغلقة)", () => {
    const r = classifyGraphError(400, { error: { code: 131047, message: "x" } });
    expect(r.detail).toContain("قالب");
  });

  it("code خارج الخريطة ⇒ يستعمل رسالة Meta الخام كـdetail", () => {
    const r = classifyGraphError(400, { error: { code: 999999, message: "Some unmapped error" } });
    expect(r.classification).toBe("permanent");
    expect(r.detail).toBe("Some unmapped error");
  });
});

describe("toWaId", () => {
  it("ينزع + من رقم دولي", () => {
    expect(toWaId("+9647701234567")).toBe("9647701234567");
  });
  it("لا يغيّر رقماً بلا + مسبقاً", () => {
    expect(toWaId("9647701234567")).toBe("9647701234567");
  });
});

describe("sendTemplate — بناء الحمولة", () => {
  it("يبني template.components[0].parameters نصية بنفس ترتيب bodyParams", async () => {
    let capturedBody: any = null;
    const fakeFetch: typeof fetch = async (_url, init) => {
      capturedBody = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ messages: [{ id: "wamid.TEST_TEMPLATE" }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };
    const integration = { accessToken: "tok", phoneNumberId: "123456" };
    const r = await sendTemplate(integration, "+9647701234567", "order_ready", "ar", ["أحمد", "١٢٣٤"], fakeFetch);

    expect(r.ok).toBe(true);
    expect(capturedBody.messaging_product).toBe("whatsapp");
    expect(capturedBody.to).toBe("9647701234567");
    expect(capturedBody.type).toBe("template");
    expect(capturedBody.template.name).toBe("order_ready");
    expect(capturedBody.template.language.code).toBe("ar");
    expect(capturedBody.template.components).toEqual([
      { type: "body", parameters: [{ type: "text", text: "أحمد" }, { type: "text", text: "١٢٣٤" }] },
    ]);
  });

  it("bodyParams فارغة ⇒ بلا مفتاح components (لا تُرسَل فارغة)", async () => {
    let capturedBody: any = null;
    const fakeFetch: typeof fetch = async (_url, init) => {
      capturedBody = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ messages: [{ id: "wamid.NOPARAMS" }] }), { status: 200 });
    };
    const integration = { accessToken: "tok", phoneNumberId: "123456" };
    await sendTemplate(integration, "9647701234567", "welcome", "ar", [], fakeFetch);
    expect(capturedBody.template.components).toBeUndefined();
  });
});

describe("sendSessionText — تصنيف فشل الشبكة", () => {
  it("استثناء fetch ⇒ retryable (graphFetch لا يرمي)", async () => {
    const fakeFetch: typeof fetch = async () => {
      throw new Error("network down");
    };
    const integration = { accessToken: "tok", phoneNumberId: "123456" };
    const r = await sendSessionText(integration, "+9647701234567", "نص تجريبي", fakeFetch);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.classification).toBe("retryable");
  });

  it("استجابة ناجحة بلا wamid في الجسم ⇒ permanent (لا نعتبرها نجاحاً)", async () => {
    const fakeFetch: typeof fetch = async () =>
      new Response(JSON.stringify({ messages: [] }), { status: 200, headers: { "content-type": "application/json" } });
    const integration = { accessToken: "tok", phoneNumberId: "123456" };
    const r = await sendSessionText(integration, "9647701234567", "نص", fakeFetch);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.classification).toBe("permanent");
  });
});
