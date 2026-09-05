/**
 * عرضُ طلب ضبط البيع في الصندوق — نقيٌّ بلا قاعدة (مُسجَّل في `vitest.unit.config.ts`).
 *
 * يقيس علّتَي Codex على #1004: المبلغُ المعروض كان إجماليَّ الفاتورة كاملاً أيّاً كان الطلب،
 * وزرُّ الاعتماد كان نشطاً حيث يفشل التنفيذ حتماً بلا توجيه نقدٍ لحظة الاعتماد.
 */
import { describe, expect, it } from "vitest";
import { salesControlAffectedAmount, salesControlInlineBlock, salesControlShiftIds } from "../sources/salesControlView";

const invoice = { total: "100000.00", paidAmount: "40000.00", returnedTotal: "10000.00" };
const items = [
  { id: 10, total: "50000.00", baseQuantity: 5 },
  { id: 11, total: "50000.00", baseQuantity: 10 },
];

describe("salesControlAffectedAmount — ما يمسه القرار لا اجمالي الفاتورة", () => {
  it("مرتجع جزئي 10,000 على فاتورة 100,000 يعرض 10,000 (حصة الكمية من اجمالي البند)", () => {
    const r = salesControlAffectedAmount({ requestType: "SALES_RETURN", payload: { lines: [{ invoiceItemId: 10, baseQuantity: 1 }] }, invoice, items, refundable: "40000.00" });
    expect(r.amount).toBe("10000.00");
    expect(r.label).toMatch(/قيمة البنود المرتجعة/);
  });
  it("مرتجع بمبلغ رد فوري يعرض مبلغ الرد (المسجل او العابر)", () => {
    expect(salesControlAffectedAmount({ requestType: "SALES_RETURN", payload: { lines: [], refund: { amount: "1500", method: "CASH" } }, invoice, items, refundable: "0" })).toEqual({ amount: "1500.00", label: "مبلغ الرد الفوري" });
    expect(salesControlAffectedAmount({ requestType: "SALES_RETURN", payload: { lines: [], resolution: { amount: "2250.5", method: "CASH", kind: "IMMEDIATE_REFUND" } }, invoice, items, refundable: "0" }).amount).toBe("2250.50");
  });
  it("مرتجع ببنود لا تطابق الفاتورة لا يدعي مبلغا", () => {
    const r = salesControlAffectedAmount({ requestType: "SALES_RETURN", payload: { lines: [{ invoiceItemId: 999, baseQuantity: 1 }] }, invoice, items, refundable: "0" });
    expect(r.amount).toBeNull();
  });
  it("الغاء فاتورة غير مقبوضة = صفر لا اجماليها، والمقبوضة = المقبوض القابل للرد", () => {
    expect(salesControlAffectedAmount({ requestType: "SALES_CANCEL", payload: { refundPaymentMethod: "CASH" }, invoice, items, refundable: "0.00" })).toEqual({ amount: "0.00", label: "فاتورة غير مقبوضة — لا مال يخرج عند الالغاء" });
    expect(salesControlAffectedAmount({ requestType: "SALES_CANCEL", payload: { refundPaymentMethod: "CASH" }, invoice, items, refundable: "40000.00" })).toEqual({ amount: "40000.00", label: "المقبوض القابل للرد عند الالغاء" });
  });
  it("اعادة الاصدار/الاستبدال: الدفعة الاضافية ان وجدت والا المقبوض المعاد تخصيصه", () => {
    expect(salesControlAffectedAmount({ requestType: "SALES_EXCHANGE", payload: { lines: [], additionalPayment: { amount: "700", method: "CASH" } }, invoice, items, refundable: "40000.00" })).toEqual({ amount: "700.00", label: "دفعة اضافية تُحصَّل الآن" });
    expect(salesControlAffectedAmount({ requestType: "SALES_REISSUE", payload: { lines: [] }, invoice, items, refundable: "40000.00" }).amount).toBe("40000.00");
    expect(salesControlAffectedAmount({ requestType: "SALES_REISSUE", payload: { lines: [] }, invoice, items, refundable: "0" })).toEqual({ amount: "0.00", label: "لا مقبوض يُعاد تخصيصه" });
  });
  it("تغيير الاستحقاق يعرض المتبقي (الاجمالي − المرتجع − المدفوع) لا الاجمالي", () => {
    expect(salesControlAffectedAmount({ requestType: "SALES_DUE_DATE_CHANGE", payload: { dueDate: "2026-10-01" }, invoice, items, refundable: "0" })).toEqual({ amount: "50000.00", label: "المتبقي الذي يتغير استحقاقه" });
  });
  it("لا Number() على المال: نص عشري غريب لا يسقط ولا يحول الى NaN", () => {
    expect(salesControlAffectedAmount({ requestType: "SALES_RETURN", payload: { lines: [], refund: { amount: "abc" } }, invoice, items, refundable: "0" }).amount).toBe("0.00");
  });
});

describe("salesControlInlineBlock — لا زر اعتماد يكذب", () => {
  const open = new Map<number, string | null>([[5, "OPEN"], [6, "CLOSED"]]);
  it("الالغاء ببطاقة بلا مرجع جهاز محجوب؛ وبمرجع او نقدا يمر", () => {
    expect(salesControlInlineBlock("SALES_CANCEL", { refundPaymentMethod: "CARD" }, open)).toMatch(/مرجع عملية جهاز الدفع/);
    expect(salesControlInlineBlock("SALES_CANCEL", { refundPaymentMethod: "CARD", reference: "TERM-1" }, open)).toBeNull();
    expect(salesControlInlineBlock("SALES_CANCEL", { refundPaymentMethod: "CASH" }, open)).toBeNull();
  });
  it("المرتجع: الرد بالبطاقة بلا مرجع محجوب، والدرج المقفل او الغائب محجوب، والمفتوح يمر، وبلا رد يمر", () => {
    expect(salesControlInlineBlock("SALES_RETURN", { lines: [], refund: { amount: "1", method: "CARD" } }, open)).toMatch(/الرد بالبطاقة/);
    expect(salesControlInlineBlock("SALES_RETURN", { lines: [], refund: { amount: "1", method: "CASH", shiftId: 6 } }, open)).toMatch(/#6\) أُقفل/);
    expect(salesControlInlineBlock("SALES_RETURN", { lines: [], resolution: { amount: "1", method: "CASH", shiftId: 7 } }, open)).toMatch(/#7\) لم يعد موجوداً/);
    expect(salesControlInlineBlock("SALES_RETURN", { lines: [], refund: { amount: "1", method: "CASH", shiftId: 5 } }, open)).toBeNull();
    expect(salesControlInlineBlock("SALES_RETURN", { lines: [], refund: { amount: "1", method: "CASH" } }, open)).toBeNull();
    expect(salesControlInlineBlock("SALES_RETURN", { lines: [{ invoiceItemId: 1, baseQuantity: 1 }], restock: true }, open)).toBeNull();
  });
  it("الانواع بلا توجيه نقد تمر", () => {
    expect(salesControlInlineBlock("SALES_REISSUE", { lines: [] }, open)).toBeNull();
    expect(salesControlInlineBlock("SALES_DUE_DATE_CHANGE", { dueDate: null }, open)).toBeNull();
  });
  it("salesControlShiftIds يجمع ادراج الرد والعابر", () => {
    expect(salesControlShiftIds({ refund: { shiftId: 3 }, resolution: { shiftId: "4" } })).toEqual([3, 4]);
    expect(salesControlShiftIds({ lines: [] })).toEqual([]);
  });
});
