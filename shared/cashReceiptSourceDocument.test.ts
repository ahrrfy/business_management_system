import { describe, expect, it } from "vitest";
import {
  CASH_RECEIPT_SOURCE_DOCUMENTS,
  CASH_RECEIPT_SOURCE_LABEL_AR,
  isCashReceiptSourceDocument,
} from "./cashReceiptSourceDocument";

describe("cashReceiptSourceDocument — مصدرٌ واحدٌ لاسم مستند الإيصال النقديّ", () => {
  it("يغطّي القيمَ الثلاث التي يُرجعها تقرير النقد اليتيم", () => {
    // `CashOrphanRow["source"]` في `server/services/reportsTreasuryService.ts`.
    for (const key of ["EXPENSE", "VOUCHER", "OTHER"] as const) {
      expect(CASH_RECEIPT_SOURCE_LABEL_AR[key]).toBeTruthy();
    }
  });

  it("يغطّي القيمَ الستّ التي يُرجعها محرّك تشخيص النقد السالب", () => {
    // `sourceOf` في `server/services/cashRemediation/classifier.ts`.
    for (const key of [
      "EXPENSE",
      "INVOICE",
      "WORK_ORDER",
      "RESERVATION",
      "VOUCHER",
      "RECEIPT",
    ] as const) {
      expect(CASH_RECEIPT_SOURCE_LABEL_AR[key]).toBeTruthy();
    }
  });

  it("يُثبّت الألفاظ كما كانت في الشاشتين — فلا ينجرف لفظٌ بلا قصد", () => {
    // البقاءُ على اللفظ نفسه هو شرطُ التوحيد: الموظّف يقارن الشاشتين صفّاً بصفّ.
    expect(CASH_RECEIPT_SOURCE_LABEL_AR).toEqual({
      EXPENSE: "مصروف",
      VOUCHER: "سند",
      INVOICE: "فاتورة",
      WORK_ORDER: "أمر شغل",
      RESERVATION: "حجز",
      RECEIPT: "إيصال منفرد",
      OTHER: "أخرى",
    });
  });

  it("لا لفظَ يتكرّر بين مستندَين — لفظان متطابقان يُعميان التتبّع", () => {
    const labels = Object.values(CASH_RECEIPT_SOURCE_LABEL_AR);
    expect(new Set(labels).size).toBe(labels.length);
  });

  it("لكلّ مفتاحٍ تسميةٌ غير فارغة، ولا تسميةَ لمفتاحٍ خارج التعداد", () => {
    expect(Object.keys(CASH_RECEIPT_SOURCE_LABEL_AR).sort()).toEqual(
      [...CASH_RECEIPT_SOURCE_DOCUMENTS].sort(),
    );
    for (const key of CASH_RECEIPT_SOURCE_DOCUMENTS) {
      expect(CASH_RECEIPT_SOURCE_LABEL_AR[key].trim().length).toBeGreaterThan(0);
    }
  });

  it("الحارسُ النوعيّ يرفض ما ليس مستنداً معروفاً", () => {
    expect(isCashReceiptSourceDocument("EXPENSE")).toBe(true);
    // `SALE_INVOICE` مفتاحُ `shared/documentActions.ts` لا مفتاحُنا — القاموسان لا يُوحَّدان.
    expect(isCashReceiptSourceDocument("SALE_INVOICE")).toBe(false);
    expect(isCashReceiptSourceDocument(null)).toBe(false);
  });
});
