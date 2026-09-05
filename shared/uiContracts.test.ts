/**
 * اختبار نصّيّ لعقود الواجهة — على نمط `actionLabels.test.ts` و`invoiceStatus` القائمَين.
 *
 * الغرض: تجميد المفردات المشتركة كي لا تعود الصياغات الثلاث («مسح الفلاتر» · «مسح كل
 * الفلاتر» · «مسح») تنجرف عبر الشاشات، وتجميد **أدوار الإسناد الأربعة** كي لا يُدمج
 * «نفّذها» بـ«المستفيد» في عمودٍ واحد اسمه «المستخدم» — وهو جوهر شكوى المالك (١/٩/٢٦).
 */
import { describe, expect, it } from "vitest";
import {
  ATTRIBUTION_LABELS,
  ATTRIBUTION_ROLES,
  FILTER_GRID_CLASS,
  FILTER_GRID_COLUMNS,
  FILTER_LABELS,
  TABLE_LABELS,
} from "./uiContracts";

describe("مفردات الفلاتر", () => {
  it("صياغةٌ واحدة لزرّ التصفير", () => {
    expect(FILTER_LABELS.reset).toBe("مسح الفلاتر");
  });

  it("كل النصوص عربية غير فارغة", () => {
    for (const [key, value] of Object.entries(FILTER_LABELS)) {
      expect(value.trim(), `FILTER_LABELS.${key} فارغة`).not.toBe("");
      expect(/[؀-ۿ]/.test(value), `FILTER_LABELS.${key} بلا حرف عربيّ`).toBe(true);
    }
  });

  it("«جارٍ» بألف واحدة حين تَرِد — اتّساقاً مع ACTION_LABELS", () => {
    for (const value of Object.values(FILTER_LABELS)) {
      expect(value).not.toContain("جاري ");
    }
  });
});

describe("أدوار الإسناد", () => {
  it("الأدوار الأربعة الأساسية موجودة ومتمايزة", () => {
    for (const role of ["performedBy", "beneficiary", "counterparty", "approvedBy"] as const) {
      expect(ATTRIBUTION_LABELS[role]).toBeTruthy();
    }
  });

  it("لا تسميتين متطابقتين — الخلط هو العطب نفسه", () => {
    const values = Object.values(ATTRIBUTION_LABELS);
    expect(new Set(values).size).toBe(values.length);
  });

  it("«نفّذها» ≠ «المستفيد» صراحةً", () => {
    expect(ATTRIBUTION_LABELS.performedBy).not.toBe(ATTRIBUTION_LABELS.beneficiary);
    expect(ATTRIBUTION_LABELS.performedBy).toBe("نفّذها");
    expect(ATTRIBUTION_LABELS.beneficiary).toBe("المستفيد");
  });

  it("ATTRIBUTION_ROLES يغطّي كل المفاتيح", () => {
    expect(ATTRIBUTION_ROLES.sort()).toEqual(Object.keys(ATTRIBUTION_LABELS).sort());
  });
});

describe("إيقاع شبكة الفلاتر", () => {
  it("لكل عدد أعمدة صنفٌ مسجَّل", () => {
    for (const columns of FILTER_GRID_COLUMNS) {
      expect(FILTER_GRID_CLASS[columns], `لا صنف للأعمدة ${columns}`).toBeTruthy();
    }
  });

  it("mobile-first: كل الأصناف تبدأ بعمودٍ واحد", () => {
    for (const columns of FILTER_GRID_COLUMNS) {
      expect(FILTER_GRID_CLASS[columns]).toContain("grid-cols-1");
    }
  });

  it("فجوةٌ واحدة عبر النظام (كانت ٢/٣/٤/٥ عشوائياً)", () => {
    for (const columns of FILTER_GRID_COLUMNS) {
      expect(FILTER_GRID_CLASS[columns]).toContain("gap-3");
    }
  });

  it("عددُ الأعمدة يتصاعد فعلياً مع القيمة", () => {
    expect(FILTER_GRID_CLASS[1]).not.toContain("sm:grid-cols");
    expect(FILTER_GRID_CLASS[2]).toContain("sm:grid-cols-2");
    expect(FILTER_GRID_CLASS[3]).toContain("lg:grid-cols-3");
    expect(FILTER_GRID_CLASS[4]).toContain("lg:grid-cols-4");
  });
});

describe("مفردات الجدول", () => {
  it("نصوص غير فارغة", () => {
    for (const [key, value] of Object.entries(TABLE_LABELS)) {
      expect(value.trim(), `TABLE_LABELS.${key} فارغة`).not.toBe("");
    }
  });
});
