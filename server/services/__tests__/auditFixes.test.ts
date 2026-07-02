// اختبارات انحدار لإصلاحات تدقيق السلامة المالية (٢/٧) — الأجزاء منطقية بحتة (بلا قاعدة بيانات).
// السلوكيات المعتمدة على القاعدة (cashBucket/ملكية الوردية/الكشوف) تُغطّى بمسارات التكامل في CI.
import { describe, expect, it } from "vitest";
import { isDupEntry, isDeadlock, isRetryableDbError } from "@shared/errorMap.ar";
import { computeInvoiceStatus } from "../ledgerService";
import { retryOnDup } from "../../lib/retryDup";

describe("C3 — isDupEntry يمشي على سلسلة cause (Drizzle يلفّ خطأ mysql2)", () => {
  it("يلتقط الرمز على المستوى الأعلى", () => {
    expect(isDupEntry({ code: "ER_DUP_ENTRY" })).toBe(true);
  });
  it("يلتقط الرمز المغلَّف في cause (نمط DrizzleQueryError)", () => {
    expect(isDupEntry({ message: "Failed query", cause: { code: "ER_DUP_ENTRY" } })).toBe(true);
  });
  it("يلتقط الرمز المغلَّف مرّتين", () => {
    expect(isDupEntry({ cause: { cause: { code: "ER_DUP_ENTRY" } } })).toBe(true);
  });
  it("لا يُطلق إيجاباً كاذباً على خطأ آخر", () => {
    expect(isDupEntry({ cause: { code: "ER_NO_SUCH_TABLE" } })).toBe(false);
    expect(isDupEntry(new Error("boom"))).toBe(false);
    expect(isDupEntry(null)).toBe(false);
  });
  it("isDeadlock/isRetryableDbError عبر السلسلة", () => {
    expect(isDeadlock({ cause: { code: "ER_LOCK_DEADLOCK" } })).toBe(true);
    expect(isDeadlock({ cause: { code: "ER_LOCK_WAIT_TIMEOUT" } })).toBe(true);
    expect(isRetryableDbError({ cause: { code: "ER_DUP_ENTRY" } })).toBe(true);
    expect(isRetryableDbError({ code: "ER_BAD_FIELD_ERROR" })).toBe(false);
  });
});

describe("C16 — retryOnDup يعيد المحاولة على التصادم القابل للإعادة فقط", () => {
  it("ينجح من أول محاولة", async () => {
    let calls = 0;
    const r = await retryOnDup(async () => { calls++; return "ok"; });
    expect(r).toBe("ok");
    expect(calls).toBe(1);
  });
  it("يعيد المحاولة على ER_DUP_ENTRY المغلَّف ثم ينجح", async () => {
    let calls = 0;
    const r = await retryOnDup(async () => {
      calls++;
      if (calls < 2) throw { cause: { code: "ER_DUP_ENTRY" } };
      return "ok";
    });
    expect(r).toBe("ok");
    expect(calls).toBe(2);
  });
  it("لا يعيد المحاولة على خطأ غير قابل للإعادة", async () => {
    let calls = 0;
    await expect(
      retryOnDup(async () => { calls++; throw new Error("business rule"); }),
    ).rejects.toThrow("business rule");
    expect(calls).toBe(1);
  });
  it("يستسلم بعد استنفاد المحاولات ويرمي آخر خطأ", async () => {
    let calls = 0;
    await expect(
      retryOnDup(async () => { calls++; throw { cause: { code: "ER_DUP_ENTRY" } }; }, 3),
    ).rejects.toBeTruthy();
    expect(calls).toBe(3);
  });
});

describe("C17 — computeInvoiceStatus يحسب الحالة على الصافي بعد المرتجعات", () => {
  it("سلوك متطابق للفواتير بلا مرتجعات (الافتراضي 0)", () => {
    expect(computeInvoiceStatus("1000", "0")).toBe("PENDING");
    expect(computeInvoiceStatus("1000", "400")).toBe("PARTIALLY_PAID");
    expect(computeInvoiceStatus("1000", "1000")).toBe("PAID");
  });
  it("فاتورة مُرتجَعة جزئياً وسُدّد صافيها = PAID (لا مستحقّة أبداً)", () => {
    // total=1000، مُرتجَع 400 ⇒ الصافي 600؛ سُدّد 600 ⇒ PAID.
    expect(computeInvoiceStatus("1000", "600", "400")).toBe("PAID");
  });
  it("صافٍ موجب مدفوع جزئياً يبقى PARTIALLY_PAID", () => {
    expect(computeInvoiceStatus("1000", "300", "400")).toBe("PARTIALLY_PAID");
  });
  it("الصافي صفر أو أقل (عُوّض بالمرتجعات) = PAID", () => {
    expect(computeInvoiceStatus("1000", "0", "1000")).toBe("PAID");
    expect(computeInvoiceStatus("1000", "0", "1200")).toBe("PAID");
  });
});
