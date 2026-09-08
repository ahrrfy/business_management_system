import { describe, expect, it } from "vitest";
import { SHORTFALL_REASONS, SHORTFALL_REASON_LABEL_AR } from "@shared/shortfallReason";
import {
  SHORTFALL_OPTIONS,
  buildSettleDailyPayload,
  canSettle,
  previewSignature,
  previewTotals,
  settleResultSummary,
  settlementVerdict,
  type SettlementPreview,
} from "./dailySettlement";

const preview: SettlementPreview = {
  partyId: 3,
  branchId: 1,
  expectedCash: "12500.00",
  feeDue: "3000.00",
  deductions: "0.00",
  net: "9500.00",
  lines: [
    { consignmentId: 1, consignmentNumber: "CN-1", invoiceNumber: "10002", customerName: "سارة", codAmount: "5000.00", collectedAmount: "5000.00", remaining: "0.00", parcelStatus: "DELIVERED" },
    { consignmentId: 2, consignmentNumber: "CN-2", invoiceNumber: "10003", customerName: "أحمد", codAmount: "7500.00", collectedAmount: "7000.00", remaining: "500.00", parcelStatus: "DELIVERED" },
  ],
  returnsAwaitingReceipt: 1,
};

describe("التسوية اليوميّة بتأكيدٍ واحد — الحكم المحلّيّ", () => {
  it("طابق / نقص / زاد / فارغ / غير صالح", () => {
    expect(settlementVerdict(preview, "9500")).toEqual({ kind: "BALANCED", diff: "0.00", net: "9500.00", counted: "9500.00" });
    expect(settlementVerdict(preview, "9500.004")).toMatchObject({ kind: "INVALID" });
    expect(settlementVerdict(preview, "9000")).toEqual({ kind: "SHORT", diff: "-500.00", net: "9500.00", counted: "9000.00" });
    expect(settlementVerdict(preview, "9750.25")).toEqual({ kind: "OVER", diff: "250.25", net: "9500.00", counted: "9750.25" });
    expect(settlementVerdict(preview, "")).toMatchObject({ kind: "EMPTY", counted: null });
    expect(settlementVerdict(preview, "9,500")).toMatchObject({ kind: "INVALID", counted: null });
  });

  it("الإقفال: المطابق بلا شرط، العجز بسببٍ مصنَّف، الزيادة تُرسَل والخادم يجيب، والفارغ/غير الصالح لا", () => {
    expect(canSettle(settlementVerdict(preview, "9500"), null)).toBe(true);
    expect(canSettle(settlementVerdict(preview, "9000"), null)).toBe(false);
    expect(canSettle(settlementVerdict(preview, "9000"), "CUSTOMER_REQUESTED_DISCOUNT")).toBe(true);
    expect(canSettle(settlementVerdict(preview, "9999"), null)).toBe(true);
    expect(canSettle(settlementVerdict(preview, ""), "OTHER")).toBe(false);
    expect(canSettle(settlementVerdict(preview, "x"), "OTHER")).toBe(false);
  });

  it("الحمولة الخادميّة: العجز يحمل سببه، والمطابق لا يحمل سبباً ولو اختير", () => {
    const short = buildSettleDailyPayload(preview, settlementVerdict(preview, "9000"), "PARTIAL_REFUSAL", "RECEPTION", "req-1");
    expect(short).toEqual({ partyId: 3, branchId: 1, countedCash: "9000.00", shortfallReason: "PARTIAL_REFUSAL", shiftType: "RECEPTION", clientRequestId: "req-1" });
    const balanced = buildSettleDailyPayload(preview, settlementVerdict(preview, "9500"), "OTHER", "RETAIL", "req-2");
    expect(balanced).toEqual({ partyId: 3, branchId: 1, countedCash: "9500.00", shiftType: "RETAIL", clientRequestId: "req-2" });
    expect(buildSettleDailyPayload(preview, settlementVerdict(preview, "9000"), null, "RETAIL", "req-3")).toBeNull();
    expect(buildSettleDailyPayload(preview, settlementVerdict(preview, ""), null, "RETAIL", "req-4")).toBeNull();
  });

  it("أسباب العجز من المصدر المشترك حرفياً", () => {
    expect(SHORTFALL_OPTIONS.map((o) => o.value)).toEqual([...SHORTFALL_REASONS]);
    expect(SHORTFALL_OPTIONS[0].label).toBe(SHORTFALL_REASON_LABEL_AR[SHORTFALL_REASONS[0]]);
  });

  it("بصمةُ المعاينة: تتغيّر بتغيّر الصافي أو دخول/خروج طردٍ أو تحرّك متبقٍّ (Codex #1012 P1)", () => {
    const base = previewSignature(preview);
    // ثباتٌ على نفس المعاينة (لا تعتمد على ترتيب الأسطر).
    expect(previewSignature({ ...preview, lines: [...preview.lines].reverse() })).toBe(base);
    // تغيّرُ الصافي ⇒ بصمةٌ مختلفة.
    expect(previewSignature({ ...preview, net: "9600.00" })).not.toBe(base);
    // دخولُ طردٍ جديد ⇒ بصمةٌ مختلفة (المجموعة الحيّة تغيّرت بعد المعاينة).
    const withExtra = { ...preview, lines: [...preview.lines, { consignmentId: 9, consignmentNumber: "CN-9", invoiceNumber: "10009", customerName: "ليلى", codAmount: "3000.00", collectedAmount: "0.00", remaining: "3000.00", parcelStatus: "DELIVERED" }] };
    expect(previewSignature(withExtra)).not.toBe(base);
    // تحرّكُ متبقّي طردٍ قائم ⇒ بصمةٌ مختلفة.
    const moved = { ...preview, lines: preview.lines.map((l) => (l.consignmentId === 2 ? { ...l, remaining: "1000.00" } : l)) };
    expect(previewSignature(moved)).not.toBe(base);
  });

  it("مجاميع المعاينة والنتيجة المُهيكَلة", () => {
    expect(previewTotals(preview)).toEqual({ lines: 2, codTotal: "12500.00", collectedTotal: "12000.00", remainingTotal: "500.00" });
    const ok = settleResultSummary({ remittanceId: 41, status: "BALANCED", shortfallTotal: "0.00", receiptId: 77 });
    expect(ok.title).toBe("أُقفل اليوم مطابقاً");
    expect(ok.lines).toEqual(["سند التوريد #41", "إيصال القبض #77 (النقد دخل الدرج)"]);
    const short = settleResultSummary({ remittanceId: 42, status: "SHORT", shortfallTotal: "500.00", receiptId: null });
    expect(short.title).toBe("أُقفل اليوم بعجزٍ مُصنَّف");
    expect(short.lines[0]).toContain("500");
    expect(short.lines[0]).toContain("SHORTFALL_ASSIGNED");
    expect(short.lines[2]).toBe("بلا إيصال قبض — لم يدخل نقدٌ الدرج");
  });
});
