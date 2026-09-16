/**
 * نتيجةُ الحفظ المُهيكَلة (م٦ ق٤، Codex FP-04) — اختبارٌ نقيّ بلا React.
 * يثبت: النجاح ⇒ SAVED، الطلبُ المعلّق (بأيّ شكلٍ من البروتوكول) ⇒ REQUESTED لا SAVED،
 * رمز CONFLICT ⇒ CONFLICT مع إرشاد إعادة التحميل، وأيُّ خطأٍ آخر ⇒ FAILED برسالة الخادم كما هي.
 */
import { describe, expect, it } from "vitest";
import { ACTION_LABELS } from "@shared/actionLabels";
import { SAVE_OUTCOME_LABELS, deriveSaveOutcome, errorCodeOf, isRequestedResult } from "../saveOutcome";

class FakeTrpcError extends Error {
  data: { code: string };
  constructor(message: string, code: string) {
    super(message);
    this.data = { code };
  }
}

describe("deriveSaveOutcome", () => {
  it("النجاح العاديّ ⇒ SAVED بعبارة القاموس أو المخصَّصة", () => {
    expect(deriveSaveOutcome({ result: { productId: 1 }, now: 5 })).toEqual({ status: "SAVED", message: ACTION_LABELS.saved, at: 5 });
    expect(deriveSaveOutcome({ result: undefined, savedMessage: "تم حفظ المنتج", now: 5 }).message).toBe("تم حفظ المنتج");
  });

  it("طلبٌ معلّق ⇒ REQUESTED لا SAVED — بكلّ أشكال البروتوكول", () => {
    for (const result of [
      { outcome: "REQUESTED" },
      { status: "REQUESTED" },
      { requested: true },
      { controlRequestId: 42 },
      { requestId: 7 },
    ]) {
      expect(isRequestedResult(result)).toBe(true);
      expect(deriveSaveOutcome({ result }).status).toBe("REQUESTED");
    }
    expect(isRequestedResult({ controlRequestId: 0 })).toBe(false);
    expect(isRequestedResult({ requested: false })).toBe(false);
    expect(isRequestedResult(null)).toBe(false);
    expect(deriveSaveOutcome({ result: { outcome: "REQUESTED" } }).message).toBe(SAVE_OUTCOME_LABELS.REQUESTED);
  });

  it("رمز CONFLICT ⇒ CONFLICT برسالة الخادم + إرشاد إعادة التحميل", () => {
    const err = new FakeTrpcError("تغيّرت تكلفة الصنف أثناء التعديل", "CONFLICT");
    expect(errorCodeOf(err)).toBe("CONFLICT");
    const out = deriveSaveOutcome({ error: err });
    expect(out.status).toBe("CONFLICT");
    expect(out.message).toContain("تغيّرت تكلفة الصنف أثناء التعديل");
    expect(out.message).toContain("أعد تحميل الشاشة");
  });

  it("أيُّ خطأٍ آخر ⇒ FAILED برسالته كما هي (عقد ماذا/لماذا/ماذا تفعل يبقى سليماً)", () => {
    const err = new FakeTrpcError("تعذّرت الاستعادة — اللقطة تخصّ منتجاً آخر. اختر نسخة أخرى", "BAD_REQUEST");
    const out = deriveSaveOutcome({ error: err });
    expect(out).toMatchObject({ status: "FAILED", message: err.message });
    expect(deriveSaveOutcome({ error: new Error("   ") }).message).toBe(SAVE_OUTCOME_LABELS.FAILED);
    expect(deriveSaveOutcome({ error: "نصّ خطأ" }).message).toBe("نصّ خطأ");
  });

  it("الخطأ يغلب النتيجة حين يُمرَّران معاً", () => {
    expect(deriveSaveOutcome({ result: { ok: true }, error: new Error("x") }).status).toBe("FAILED");
  });
});
