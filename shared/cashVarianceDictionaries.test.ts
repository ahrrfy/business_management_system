import { describe, expect, it } from "vitest";

import { cashVarianceCases, shifts } from "../drizzle/schema";
import {
  CASH_VARIANCE_REASON_CODES,
  CASH_VARIANCE_REASON_CODES_BY_SOURCE,
  CASH_VARIANCE_REASON_LABELS,
  isCashVarianceReasonAllowed,
} from "./cashVariance";
import {
  SHIFT_VARIANCE_CODES,
  SHIFT_VARIANCE_LABELS,
} from "./shiftCashGovernance";

/**
 * قاموسا أسباب فرق النقد **متمايزان بقصد**، وتصادفُ ثلاثةِ مفاتيح بينهما نصّاً جعلهما يبدوان
 * تكراراً لمفهومٍ واحد (٢/٩/٢٦). هذا الاختبار يُثبّت التمايز ويمنع «التوحيد» الصامت:
 *  - `shifts.varianceReasonCode` — فرقُ درج الكاشير عند الإغلاق؛ تفسيرٌ بلا قيدٍ ولا ذمّة.
 *  - `cashVarianceCases.cashVarianceReasonCode` — قضيّةُ عهدةٍ أو خزينةٍ بدليلٍ واعتمادٍ وقيد.
 * دمجُهما يُسند سبباً لا يقع على مستنده (`OFFLINE_SALE` على خزينة، `CUSTODY_LOSS` على وردية).
 */
describe("قاموسا أسباب فرق النقد", () => {
  // الحارس الأهمّ: المفاتيح مخزَّنة حرفياً في MySQL. انحرافُ الثابت المشترك عن عمود
  // `mysqlEnum` يمرّ في CI (قاعدة الاختبار تُبنى من المخطط) ثم يسقط على الإنتاج بصفٍّ مرفوض.
  it("كل ثابتٍ مشترك يطابق عمود enum الذي يُكتَب فيه", () => {
    expect(shifts.varianceReasonCode.enumValues).toEqual([
      ...SHIFT_VARIANCE_CODES,
    ]);
    expect(cashVarianceCases.reasonCode.enumValues).toEqual([
      ...CASH_VARIANCE_REASON_CODES,
    ]);
  });

  // عمودان منفصلان باسمين مختلفين — لا يقرأ أحدهما الآخر. لو صارا عموداً واحداً يوماً
  // فذاك قرارُ حوكمةٍ لا إعادةُ تسمية، ويجب أن يسقط هنا أولاً.
  it("العمودان منفصلان ولا يتشاركان اسماً", () => {
    expect(shifts.varianceReasonCode.name).toBe("varianceReasonCode");
    expect(cashVarianceCases.reasonCode.name).toBe("cashVarianceReasonCode");
  });

  it("لكل رمزٍ تسميةٌ عربية (لا مفتاح خام يظهر للموظّف)", () => {
    for (const code of SHIFT_VARIANCE_CODES) {
      expect(SHIFT_VARIANCE_LABELS[code]?.trim()).toBeTruthy();
    }
    for (const code of CASH_VARIANCE_REASON_CODES) {
      expect(CASH_VARIANCE_REASON_LABELS[code]?.trim()).toBeTruthy();
    }
  });

  // التمايز جوهريّ لا نقصٌ يُستكمَل: علل نقطة البيع لا تقع على خزينةٍ أو عهدة، وتحميلُ
  // ذمّةِ عهدةٍ لا يقع على صفّ وردية. إضافةُ أيٍّ منها للقاموس الآخر تُسقط هذا الاختبار.
  it("الرموز الحصرية تبقى حصرية في كل قاموس", () => {
    const shiftOnly = ["UNRECORDED_SALE", "CHANGE_FUND_TRANSFER", "OFFLINE_SALE", "REFUND_ERROR"];
    const caseOnly = ["CUSTODY_LOSS", "DOCUMENTATION_ERROR"];

    for (const code of shiftOnly) {
      expect(SHIFT_VARIANCE_CODES).toContain(code);
      expect(CASH_VARIANCE_REASON_CODES).not.toContain(code);
    }
    for (const code of caseOnly) {
      expect(CASH_VARIANCE_REASON_CODES).toContain(code);
      expect(SHIFT_VARIANCE_CODES).not.toContain(code);
    }
  });

  // التقاطع النصّيّ هو أصل الالتباس، ويبقى أربعةً بالضبط: ثلاثةٌ جوهرية + `OTHER` المُنهي
  // الذي تتقاسمه أعرافُ القوائم كلّها في النظام. اتّساعُه يعني أنّ أحد القاموسين يُستنسَخ في
  // الآخر تدريجياً — وهو الانجراف الذي يسبق «التوحيد» الخاطئ.
  it("التقاطع النصّيّ يبقى أربعة مفاتيح لا أكثر", () => {
    const shared = SHIFT_VARIANCE_CODES.filter((code) =>
      (CASH_VARIANCE_REASON_CODES as readonly string[]).includes(code),
    );
    expect(shared).toEqual([
      "COUNT_ERROR",
      "UNRECORDED_CASH_IN",
      "UNRECORDED_CASH_OUT",
      "OTHER",
    ]);
  });

  // «عجز العهدة» يُحمّل ذمّةً على صاحب عهدةٍ مُسمّى، والخزينة اليومية لا تحمل عقد حيازةٍ
  // شخصياً ⇒ لا يجوز استعماله لمطابقتها (السياسة المكتوبة في cashVariance.ts).
  it("عجز العهدة ممنوع على المطابقة اليومية للخزينة", () => {
    expect(isCashVarianceReasonAllowed("CUSTODY", "CUSTODY_LOSS")).toBe(true);
    expect(isCashVarianceReasonAllowed("DAILY_TREASURY", "CUSTODY_LOSS")).toBe(false);
    expect(CASH_VARIANCE_REASON_CODES_BY_SOURCE.DAILY_TREASURY).not.toContain("CUSTODY_LOSS");
  });
});
