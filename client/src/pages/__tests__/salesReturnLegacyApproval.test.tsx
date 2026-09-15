import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { decisionSpec } from "@shared/decisionRegistry";

const read = (relative: string) =>
  readFileSync(new URL(relative, import.meta.url), "utf8");

const returnsHub = read("../ReturnsHub.tsx");
const composer = read("../../components/returns/ReturnComposer.tsx");
const decisionRow = read("../../components/decision/DecisionRow.tsx");
const salesSource = read("../../../../server/services/decisions/sources/sales.ts");
const legacySource = salesSource.slice(
  salesSource.indexOf("export const returnRequestSource"),
  salesSource.indexOf("// ───────────────────────────── ٣)"),
);

describe("مسار اعتماد طلبات مرتجع البيع القديمة", () => {
  it("رابط القرار يفتح الطلب نفسه في شاشة المرتجعات", () => {
    expect(decisionSpec("sales.returnRequest.approve")!.href(123)).toBe(
      "/returns?requestId=123",
    );
    expect(decisionSpec("sales.returnRequest.reject")!.href(123)).toBe(
      "/returns?requestId=123",
    );
  });

  it("صفحة الاعتماد تستنتج الفاتورة من requestId ولا تسمح بمراجعة فاتورة أخرى", () => {
    expect(returnsHub).toContain("invoiceId={approvalRequest.data.invoiceId}");
    expect(returnsHub).toContain("approvingRequestId={approvingRequestId}");
    expect(returnsHub).not.toContain("invoiceId={initialInvoice}");
    expect(returnsHub).toContain(
      'approvalRequest.data.status !== "PENDING_APPROVAL"',
    );
  });

  it("سبب الطلب محفوظ ومقفل أثناء الاعتماد", () => {
    expect(composer).toContain("setReason(requestDetail.data.reason)");
    expect(composer).toContain("disabled={isLocked || qtyLocked}");
    expect(composer).toContain("requestDetail.data.invoiceId !== invoiceId");
  });

  it("بطاقة القرار لا تعيد إجمالي الفاتورة ولا بنداً مجهولاً ولا خروج مال ثابتاً", () => {
    expect(legacySource).toContain("buildReturnRequestDecisionView");
    expect(legacySource).not.toContain("amount: r.invoiceTotal");
    expect(legacySource).not.toContain('label: l.productName ?? l.name ?? "بند"');
    expect(legacySource).not.toContain('trigger: "MONEY_OUT"');
    expect(legacySource).toContain('openActionLabel: "مراجعة واعتماد"');
    expect(legacySource).toContain("refundableReturnRequestsByInvoice");
    expect(salesSource).toContain("loadRefundCapsByInvoiceIds(db, invoiceIds)");
    expect(salesSource).not.toContain("loadRefundCaps(db, invoiceId)");
  });

  it("ينعش صندوق القرارات قبل الرجوع إليه بعد الاعتماد", () => {
    expect(composer).toContain("utils.decisions.inbox.invalidate()");
  });

  it("يعرض وقت إنشاء الفاتورة بصيغة محلية لا كنص تقني", () => {
    expect(decisionRow).toContain("it.timestamp ? fmtDateTime(it.timestamp)");
    expect(decisionRow).toContain("row.openActionLabel ??");
  });
});
