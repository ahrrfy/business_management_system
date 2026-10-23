import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { decisionSpec } from "@shared/decisionRegistry";

const read = (relative: string) =>
  readFileSync(new URL(relative, import.meta.url), "utf8");

const returnsHub = read("../ReturnsHub.tsx");
const composer = read("../../components/returns/ReturnComposer.tsx");
const composerModel = read("../../components/returns/useReturnComposer.ts");
const composerState = read("../../components/returns/useReturnComposerState.ts");
const composerGuard = read("../../components/returns/useReturnComposerGuard.ts");
const composerMutations = read("../../components/returns/useReturnComposerMutations.ts");
const composerDocumentation = read("../../components/returns/ReturnComposerDocumentation.tsx");
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
    expect(composerState).toContain("setReason(requestDetail.data.reason)");
    expect(composerDocumentation).toContain("disabled={isLocked || qtyLocked}");
    expect(composerGuard).toContain("requestDetail.data.invoiceId !== invoiceId");
    expect(composer).toContain('import { useReturnComposer } from "./useReturnComposer";');
    expect(composer).toContain("const model = useReturnComposer(props)");
    expect(composerModel).toContain("const state = useReturnComposerState(props)");
    expect(composerModel).toMatch(/useReturnComposerGuard\(\{\s*\.\.\.state,\s*\.\.\.settlement,/);
    expect(composerModel).toContain("return { ...state, ...settlement, ...mutations, ...quantity, ...guard, ...submission }");
    expect(composer).toContain('import { ReturnComposerDocumentation } from "./ReturnComposerDocumentation";');
    expect(composer).toMatch(/<ReturnComposerDocumentation\s+\{\.\.\.\{[\s\S]*?reason,\s*setReason,[\s\S]*?qtyLocked,\s*isLocked,/);
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
    expect(composerMutations).toContain("await invalidateFinancialQueries(queryClient, inv?.branchId)");
    expect(composerModel).toContain("const mutations = useReturnComposerMutations({ ...state, ...settlement })");
    expect(composerMutations).toMatch(/approveRequest\.useMutation\(\{\s*onSuccess:[\s\S]*?await invalidateFinancialQueries\(queryClient, inv\?\.branchId\);\s*onDone\?\./);
  });

  it("يعرض وقت إنشاء الفاتورة بصيغة محلية لا كنص تقني", () => {
    expect(decisionRow).toContain("it.timestamp ? fmtDateTime(it.timestamp)");
    expect(decisionRow).toContain("row.openActionLabel ??");
  });
});
