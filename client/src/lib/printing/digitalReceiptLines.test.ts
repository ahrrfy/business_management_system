import { describe, expect, it } from "vitest";
import {
  buildDigitalBlocks, digitalDetailLines, maskPhone, type DigitalReceiptDetail,
} from "./digitalReceiptLines";

/**
 * البطاقات الرقمية — ش١٠: أسطر الكرت على الإيصال.
 * راجع docs/digital-cards-platform-subscriptions-implementation-plan-2026-07-29.md §١٢.
 */

const edu: DigitalReceiptDetail = {
  lineName: "اشتراك منصّة نجاح — شهر",
  providerReference: "PLT-99881",
  studentName: "مريم عادل",
  studentPhone: "+9647713334444",
  guardianPhone: "+9647705556666",
  studentAddress: "بغداد — زيونة",
};

const telecom: DigitalReceiptDetail = {
  lineName: "كارت آسياسيل ١٠ آلاف",
  providerReference: "ASIA-12345",
};

describe("ش١٠ — تقنيع الهاتف", () => {
  it("يُبقي البداية والنهاية ويُخفي الوسط", () => {
    const m = maskPhone("+9647713334444");
    expect(m.startsWith("+9647")).toBe(true);
    expect(m.endsWith("4444")).toBe(true);
    expect(m).not.toContain("713334");
    expect(m.length).toBe("+9647713334444".length);
  });

  it("رقم قصير يُقنَّع كلياً بدل كشفه", () => {
    expect(maskPhone("12345")).toBe("•••••");
    expect(maskPhone("")).toBe("");
    expect(maskPhone(null)).toBe("");
  });
});

describe("ش١٠ — أسطر الكرت", () => {
  it("الاشتراك التعليميّ يطبع الترتيب المنصوص عليه في §١٢.٢", () => {
    const rows = digitalDetailLines(edu);
    expect(rows.map((r) => r.label)).toEqual([
      "الطالب", "هاتف الطالب", "هاتف ولي الأمر", "العنوان", "مرجع العملية",
    ]);
    expect(rows[0].value).toBe("مريم عادل");
    expect(rows[4].value).toBe("PLT-99881");
  });

  it("الكرت غير التعليميّ يطبع المرجع فقط", () => {
    const rows = digitalDetailLines(telecom);
    expect(rows.map((r) => r.label)).toEqual(["مرجع العملية"]);
  });

  it("التقنيع مُفعَّل افتراضياً ويُعطَّل صراحةً للنسخة الداخلية", () => {
    expect(digitalDetailLines(edu)[1].value).not.toBe("+9647713334444");
    expect(digitalDetailLines(edu, { maskPhones: false })[1].value).toBe("+9647713334444");
  });

  it("الحقول الفارغة لا تُنتج أسطراً فارغة", () => {
    const rows = digitalDetailLines({ lineName: "كرت", studentName: "  ", providerReference: "" });
    expect(rows).toHaveLength(0);
  });
});

describe("ش١٠ — معيار الخروج: لا معلومات مالية داخلية", () => {
  it("لا يُنتج أي سطرٍ يحمل حصة المزوّد أو الربح أو الرصيد", () => {
    // نحقن الحقول الممنوعة عمداً على الكائن؛ يجب ألّا تظهر في أي سطر.
    const leaky = {
      ...edu,
      providerShare: "80000",
      profit: "20000",
      walletBalance: "1490400",
      cost: "80000",
    } as unknown as DigitalReceiptDetail;

    const serialized = JSON.stringify(buildDigitalBlocks([leaky]));
    for (const forbidden of ["80000", "20000", "1490400", "providerShare", "profit", "walletBalance", "cost"]) {
      expect(serialized, `تسريب ${forbidden}`).not.toContain(forbidden);
    }
  });

  it("الكتل تحمل اسم الكرت وأسطره فقط", () => {
    const blocks = buildDigitalBlocks([edu, telecom]);
    expect(blocks).toHaveLength(2);
    expect(Object.keys(blocks[0])).toEqual(["lineName", "rows"]);
    expect(Object.keys(blocks[0].rows[0])).toEqual(["label", "value"]);
  });

  it("كرتٌ بلا أي تفصيل يُحذف من الكتل بدل طباعة عنوانٍ فارغ", () => {
    expect(buildDigitalBlocks([{ lineName: "كرت بلا مرجع" }])).toHaveLength(0);
    expect(buildDigitalBlocks(null)).toHaveLength(0);
    expect(buildDigitalBlocks([])).toHaveLength(0);
  });
});

describe("ش١٠ — معيار الخروج: نفس البيانات في المسارين", () => {
  it("المسار الحراريّ وقالب المتصفّح يستهلكان الكتل ذاتها", () => {
    // كلاهما يستدعي buildDigitalBlocks بنفس المدخلات ⇒ نفس المخرَج حرفياً.
    const forThermal = buildDigitalBlocks([edu, telecom], { maskPhones: true });
    const forBrowser = buildDigitalBlocks([edu, telecom], { maskPhones: true });
    expect(forThermal).toEqual(forBrowser);

    // وتغيير سياسة التقنيع ينعكس على المسارين معاً لا على أحدهما.
    const unmasked = buildDigitalBlocks([edu], { maskPhones: false });
    expect(unmasked[0].rows[1].value).not.toEqual(forThermal[0].rows[1].value);
  });
});
