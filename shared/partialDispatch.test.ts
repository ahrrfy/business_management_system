/**
 * حارسٌ نصّيّ: **لا مطابقةَ برسالةٍ حرفيّة** لرفض الإرسال الجزئيّ (٢٠/٨).
 *
 * الشاشتان تتعرّفان على هذا الرفض بعينه لتعرضا زرَّ الإقرار. وحين كان التعرّف بنصٍّ حرفيٍّ
 * مكرَّرٍ في ثلاثة ملفّات، كان تعديلُ كلمةٍ في رسالة الخادم يُخفي الزرَّ **صامتاً**: الموظّف
 * يقف أمام خطأٍ بلا مخرج، ولا اختبارَ يسقط. يقرأ الحارسُ الملفّات **الحيّة** لا قائمةً
 * مكتوبةً بيد (نمط `shared/workOrderStatus.test.ts`).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  PARTIAL_DISPATCH_MARKER,
  isPartialDispatchRejection,
  partialDispatchMessage,
} from "./partialDispatch";

const ROOT = join(__dirname, "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

/** الملفّات التي تنتج الرفض أو تتعرّف عليه. */
const CONSUMERS = [
  "server/services/delivery/dispatchInvoice.ts",
  "client/src/components/delivery/InvoiceDispatchDialog.tsx",
  "client/src/components/reception/ReceptionInvoiceQueue.tsx",
];

describe("علامة رفض الإرسال الجزئيّ", () => {
  it("⭐ الرسالةُ المبنيّة تحوي العلامة — فلا تنفصل عن مفتاحها", () => {
    const msg = partialDispatchMessage(3, "WO-1، WO-2، WO-3", false);
    expect(msg).toContain(PARTIAL_DISPATCH_MARKER);
    expect(msg).toContain("3");
    expect(msg).toContain("WO-2");
  });

  it("⭐ لا ملفَّ يطابق النصّ حرفيّاً — الكلُّ يمرّ بالمصدر المشترك", () => {
    const offenders = CONSUMERS.filter((f) => {
      const src = read(f);
      // ورودُ العلامة نصّاً **داخل** ملفٍّ مستهلك = مطابقةٌ يدويّة عادت.
      return src.includes(`"${PARTIAL_DISPATCH_MARKER}"`) || src.includes(`'${PARTIAL_DISPATCH_MARKER}'`);
    });
    expect({ offenders }).toEqual({ offenders: [] });
  });

  it("⭐ كلُّ مستهلكٍ يستورد من `@shared/partialDispatch`", () => {
    const missing = CONSUMERS.filter((f) => !read(f).includes("@shared/partialDispatch"));
    expect({ missing }).toEqual({ missing: [] });
  });

  it("التعرّف يشترط الرمز **والنصّ** معاً — لا يبتلع خطأً آخر", () => {
    expect(isPartialDispatchRejection({
      message: partialDispatchMessage(1, "WO-9", false),
      data: { code: "PRECONDITION_FAILED" },
    })).toBe(true);

    // نفس الرسالة برمزٍ آخر ⇒ ليست هي (قد تكون صدىً في سجلّ أو خطأً مغلّفاً).
    expect(isPartialDispatchRejection({
      message: partialDispatchMessage(1, "WO-9", false),
      data: { code: "INTERNAL_SERVER_ERROR" },
    })).toBe(false);

    // رمزٌ مطابق برسالةٍ أخرى ⇒ ليست هي (حارسٌ آخر يردّ بنفس الرمز).
    expect(isPartialDispatchRejection({
      message: "الفاتورة مُسنَدة أصلاً للإرسالية CN-1",
      data: { code: "PRECONDITION_FAILED" },
    })).toBe(false);

    expect(isPartialDispatchRejection(null)).toBe(false);
    expect(isPartialDispatchRejection({ message: "", data: null })).toBe(false);
  });
});
