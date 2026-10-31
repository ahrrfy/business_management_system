/**
 * Comprehensive Returns Audit & Scenarios Test Suite
 *
 * يدقق ويفحص:
 * ١) الأثر المخزني والمالي والتشغيلي لمرتجعات المبيعات (سليم/تالف، نقدي/بطاقة/رصيد متجر).
 * ٢) الأثر المخزني والمالي والتشغيلي لمرتجعات الشراء (معادلة ذمة/مردود كاش/حوالة).
 * ٣) الوظائف الطباعية وسندات الإرجاع الحرارية (إيصال مبيعات وسند مشتريات).
 * ٤) سلامة التسجيل الذري والقيود المحاسبية وسجل التدقيق.
 * ٥) بقاء نظام الاعتماد والحوكمة للمرتجعات كطبقة أمان مؤسسية.
 * ٦) صحة عقود التوجيه الموحدة من الفواتير وأوامر الشراء إلى البوابة المركزية.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import ts from "typescript";
import { purchaseReturnCartInputSchema } from "../../../shared/purchaseReturnCartInput";
const cartProbe = vi.hoisted(() => ({ request: vi.fn(), read: vi.fn() }));
vi.mock("../purchase/returnGovernance", () => ({ requestPurchaseReturn: cartProbe.request }));
vi.mock("../purchaseReturnsService", () => ({ getPurchaseReturn: cartProbe.read }));
import { executeGovernedReturnCart } from "../purchase/returnCart";

const readServer = (rel: string) =>
  readFileSync(new URL(`../../${rel}`, import.meta.url), "utf8");

const readClient = (rel: string) =>
  readFileSync(new URL(`../../../client/src/${rel}`, import.meta.url), "utf8");

function functionSource(file: string, name: string) {
  const source = ts.createSourceFile(file, readServer(file), ts.ScriptTarget.Latest, true);
  const fn = source.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === name);
  if (!fn || !ts.isFunctionDeclaration(fn) || !fn.body) throw new Error(`Missing owner ${file}:${name}`);
  return fn.body.getText(source);
}
const purchaseExecution = functionSource("services/purchase/returnGovernance.ts", "decidePurchaseReturnAuthorized");
const purchaseRequest = functionSource("services/purchase/returnException.ts", "createExceptionReturnRequest");
const purchaseCart = functionSource("services/purchase/returnCart.ts", "executeGovernedReturnCart");
const cartInput = {
  supplierId: 1, branchId: 2, reference: "supplier-return-note-42", evidenceType: "RETURN_NOTE" as const,
  items: [{ variantId: 3, productName: "قلم", quantity: 2, unitCost: "5.00" }],
  settlement: { method: "CASH_IN" as const, totalAmount: "10.00", shiftId: 7 },
  reason: "إرجاع للمورد", clientRequestId: "cart-42",
};

describe("١. تدقيق الأثر المالي والمخزني والتسجيل الذري في returnRouter", () => {
  const routerSrc = readServer("routers/returnRouter.ts");

  it("يحتوي على مسار مرتجع المبيعات الذري executeSalesReturnCart بضوابط مالية ومخزنية", () => {
    expect(routerSrc).toContain(
      "executeSalesReturnCart: returnsProcedure",
    );
    expect(routerSrc).toContain(
      'min(1, "يجب تحديد صنف واحد على الأقل للإرجاع")',
    );
    expect(routerSrc).toContain('z.enum(["RESTOCK", "DAMAGED"])');
    expect(routerSrc).toContain('z.enum(["CASH", "CARD", "STORE_CREDIT"])');
    expect(routerSrc).toContain("postEntry(");
    expect(routerSrc).toContain("returnTotalDec");
  });

  it("يحتوي على مسار مرتجع الشراء الذري executePurchaseReturnCart مع حسم ذمة المورد", () => {
    expect(routerSrc).toContain(
      "executePurchaseReturnCart: salesManagerProcedure",
    );
    // Test the exact schema consumed by this route, including rejected boundaries.
    const route = routerSrc.slice(routerSrc.indexOf("executePurchaseReturnCart: salesManagerProcedure"));
    expect(route).toMatch(/\.input\(purchaseReturnCartInputSchema\)[\s\S]*executeGovernedReturnCart\(input,/);
    expect(purchaseReturnCartInputSchema.safeParse(cartInput).success).toBe(true);
    for (const method of ["CREDIT_OFFSET", "CASH_IN", "CARD_TRANSFER"]) {
      expect(purchaseReturnCartInputSchema.safeParse({ ...cartInput, settlement: { ...cartInput.settlement, method } }).success).toBe(true);
    }
    for (const invalid of [{ ...cartInput, items: [] }, { ...cartInput, settlement: { ...cartInput.settlement, method: "UNKNOWN" } },
      { ...cartInput, items: [{ ...cartInput.items[0], quantity: 0 }] }]) {
      expect(purchaseReturnCartInputSchema.safeParse(invalid).success).toBe(false);
    }
    expect(purchaseExecution).toContain("adjustSupplierBalance(tx");
    expect(purchaseExecution).toMatch(/applyMovement\(tx,[\s\S]*movementType: "OUT"[\s\S]*referenceType: "PURCHASE_RETURN"/);
  });

  it("يحفظ تدقيق البيع ودليل طلب وقرار وتنفيذ الشراء المحكم داخل معاملته", () => {
    expect(routerSrc).toContain("logAudit(");
    expect(routerSrc).toContain('action: "sale.return_cart"');
    expect(purchaseCart).toMatch(/await requestPurchaseReturn\([\s\S]*requestKey: input.clientRequestId/);
    const dispatch = functionSource("services/purchase/returnGovernance.ts", "requestPurchaseReturn");
    expect(dispatch).toMatch(/input.sourceKind === "OWNER_EXCEPTION"[\s\S]*createExceptionReturnRequest\(input, actor\)[\s\S]*finishReturnRequest\(result, input.reason, actor\)/);
    expect(purchaseRequest).toContain("withTx(");
    expect(purchaseRequest).toMatch(/tx.insert\(purchaseReturnRequests\).values\(\{[\s\S]*payloadCanonical: canonical,[\s\S]*payloadHash: hash,[\s\S]*requestedBy: actor.userId/);
    expect(purchaseExecution).toContain("withTx(");
    expect(purchaseExecution).toMatch(/const executionEvidence = \{[\s\S]*requestId: request.id,[\s\S]*ownerId: actor.userId,[\s\S]*accountingEntryId,[\s\S]*receiptId: cashReceiptId,/);
    expect(purchaseExecution).toMatch(/\.update\(purchaseReturns\)\s*\.set\(\{\s*executionEvidence,\s*executionEvidenceHash: evidenceHash\(executionEvidence\)/);
    expect(purchaseExecution).toMatch(/\.update\(purchaseReturnRequests\)\s*\.set\(\{[\s\S]*reviewedBy: actor.userId,[\s\S]*decisionKey: key,[\s\S]*decisionHash: hash,/);
    const finish = functionSource("services/purchase/returnGovernance.ts", "finishReturnRequest");
    expect(finish).toMatch(/request.status === "APPROVED"[\s\S]*eq\(purchaseReturns.requestId, result.requestId\)/);
    expect(finish).toMatch(/request.status === "APPROVED" && !posted\)\s*returnConflict/);
    const reader = functionSource("services/purchaseReturnsService.ts", "getPurchaseReturn");
    expect(reader).toMatch(/\.from\(purchaseReturns\)/);
    expect(reader).toContain("requestId: purchaseReturns.requestId");
    expect(reader).toContain("return { ...header, items }");
  });

  it("يرجع الطلب المنتظر دون مستند تنفيذ، ويقرأ المستند فقط بعد الاعتماد", async () => {
    cartProbe.request.mockReset(); cartProbe.read.mockReset();
    const actor = { userId: 4, branchId: 2, role: "manager" };
    cartProbe.request.mockResolvedValueOnce({ requestId: 42, status: "PENDING", idempotent: false });
    expect(await executeGovernedReturnCart(cartInput, actor)).toEqual({ mode: "REQUESTED", requestId: 42, status: "PENDING" });
    expect(cartProbe.read).not.toHaveBeenCalled();
    expect(cartProbe.request).toHaveBeenLastCalledWith(expect.objectContaining({ sourceKind: "OWNER_EXCEPTION", requestKey: "cart-42", supplierId: 1, branchId: 2,
      settlement: "CASH", paymentMethod: "CASH", cashRoute: { cashBucket: "DRAWER", shiftId: 7 } }), actor);
    const document = { id: 73, requestId: 42, postedBy: 4, evidenceReference: cartInput.reference };
    cartProbe.request.mockResolvedValueOnce({ requestId: 42, status: "APPROVED", purchaseReturnId: 73 });
    cartProbe.read.mockResolvedValueOnce(document);
    expect(await executeGovernedReturnCart(cartInput, actor)).toEqual({ mode: "EXECUTED", requestId: 42, purchaseReturnId: 73, document });
    expect(cartProbe.read).toHaveBeenCalledWith(73, 2);
  });
});

describe("٢. تدقيق نظام الاعتماد والحوكمة كطبقة أمان مؤسسية", () => {
  const govRouterSrc = readServer("routers/purchaseReturnGovernanceRouter.ts");
  const salesRouterSrc = readServer("routers/returnRouter.ts");

  it("حوكمة مرتجعات الموردين توفر طابور الاعتماد والتحقق للمدير", () => {
    expect(govRouterSrc).toContain("pendingReturns:");
    expect(govRouterSrc).toContain("returnSources:");
    expect(govRouterSrc).toContain("reversalSources:");
    expect(govRouterSrc).toContain("decideReturn:");
  });

  it("حوكمة مرتجعات العملاء تتيح الاعتماد والرفض المسبب للمدير", () => {
    expect(salesRouterSrc).toContain("approveRequest: salesManagerProcedure");
    expect(salesRouterSrc).toContain("rejectRequest: salesManagerProcedure");
  });
});

describe("٣. تدقيق الوظائف الطباعية وإيصالات وسندات الإرجاع الحرارية", () => {
  const printHelperSrc = readClient(
    "components/returns/printThermalReturnReceipt.ts",
  );

  it("يصدّر دالة طباعة إيصال مرتجع المبيعات الحراري بكامل بياناته", () => {
    expect(printHelperSrc).toContain(
      "export async function printSalesReturnReceipt(",
    );
    expect(printHelperSrc).toContain("إيصال مرتجع مبيعات");
    expect(printHelperSrc).toContain("returnNumber");
    expect(printHelperSrc).toContain("customerName");
    expect(printHelperSrc).toContain("totalAmount");
  });

  it("يصدّر دالة طباعة سند مرتجع المشتريات للموردين الحراري", () => {
    expect(printHelperSrc).toContain(
      "export async function printPurchaseReturnVoucher(",
    );
    expect(printHelperSrc).toContain("سند مرتجع مشتريات");
    expect(printHelperSrc).toContain("supplierName");
    expect(printHelperSrc).toContain("totalAmount");
  });
});

describe("٤. تدقيق إزالة التشتت وتوحيد الروابط في المبيعات والمشتريات", () => {
  const invoicesSrc = readClient("pages/Invoices.tsx");
  const purchasesSrc = readClient("pages/Purchases.tsx");
  const returnsHubSrc = readClient("pages/ReturnsHub.tsx");
  const salesHubSrc = readClient("pages/SalesHub.tsx");
  const purchasesHubSrc = readClient("pages/PurchasesHub.tsx");

  it("إجراء الإرجاع الفوري في الفواتير يقود مباشرة إلى بوابة المرتجعات", () => {
    expect(invoicesSrc).toContain('key: "return"');
    expect(invoicesSrc).toContain(
      "href: `/returns?portal=sales&invoice=${encodeURIComponent(r.invoiceNumber)}`",
    );
    expect(invoicesSrc).not.toContain("<SalesReturnDrawer");
  });

  it("يوجه منفذ مرتجع الشراء للبوابة المباشرة وطالب الاعتماد لمسار الحوكمة", () => {
    expect(purchasesSrc).toContain('key: "preturn"');
    expect(purchasesSrc).toContain("href: canExecutePurchaseReturn");
    expect(purchasesSrc).toContain(
      "`/returns?portal=purchases&po=${encodeURIComponent(p.poNumber)}`",
    );
    expect(purchasesSrc).toContain('"/purchases/returns-governance"');
  });

  it("بوابة المرتجعات ReturnsHub هي المنفذ المركزي المستقل دون تحويلات مشتتة", () => {
    expect(returnsHubSrc).not.toContain("/purchases?tab=returns-governance");
    expect(returnsHubSrc).toContain('backHref="/"');
  });

  it("تبويبات PurchasesHub مطهرة بالكامل ولا تحتوي على أي تبويب للمرتجعات", () => {
    expect(purchasesHubSrc).not.toContain('value: "returns-governance"');
    expect(purchasesHubSrc).not.toContain('label: "حوكمة المرتجعات"');
  });

  it("تبويبات SalesHub مطهرة بالكامل ولا تحتوي على أي تبويب للمرتجعات", () => {
    expect(salesHubSrc).not.toContain('value: "returns"');
    expect(salesHubSrc).not.toContain('label: "حوكمة واعتمادات المرتجعات"');
  });
});

describe("٥. تدقيق ربط الأدراج النقدية والمطابقة الذرية ومنع أسطر الترحيل الصفرية", () => {
  const routerSrc = readServer("routers/returnRouter.ts");
  const returnServiceSrc = readServer("services/returnService.ts");
  const salesPortalSrc = readClient("components/returns/SalesReturnPortal.tsx");
  const salesModelSrc = readClient("components/returns/useSalesReturnPortal.ts");
  const salesStateSrc = readClient("components/returns/useSalesReturnState.ts");
  const salesSubmissionSrc = readClient("components/returns/useSalesReturnSubmission.ts");
  const salesSettlementSrc = readClient("components/returns/SalesReturnSettlementPanel.tsx");
  const salesMethodsSrc = readClient("components/returns/SalesReturnSettlementMethods.tsx");
  const salesDrawersSrc = readClient("components/returns/SalesReturnCashDrawers.tsx");
  const purchasePortalSrc = readClient(
    "components/returns/PurchaseReturnPortal.tsx",
  );

  it("يوفّر إجراء getOpenRefundDrawers بصلاحية كاشير لجلب الأدراج المفتوحة بالفرع مع مؤشر الملكية", () => {
    expect(routerSrc).toContain("getOpenRefundDrawers: returnsProcedure");
    expect(routerSrc).toContain("expectedCash: s.expectedCash");
    expect(routerSrc).toContain(
      "isMine: Number(s.userId) === Number(ctx.user.id)",
    );
  });

  it("يربط مرتجع المبيعات النقدي بدرج الوردية مع فحص الكفاية وتوليد إيصال DRAWER OUT وقيد PAYMENT_OUT", () => {
    expect(routerSrc).toContain("assertCashOutAvailable(tx");
    expect(routerSrc).toContain("recordSalesReturnCartReceipt(tx");
    expect(routerSrc).toContain("PAYMENT_OUT_CUSTOMER_REFUND");
    expect(routerSrc).toContain("roleDebits: { AR: returnTotalDec }");
    expect(routerSrc).toContain("roleCredits: { CASH: returnTotalDec }");
    expect(returnServiceSrc).toContain('cashBucket: "DRAWER"');
    expect(returnServiceSrc).toContain('direction: "OUT"');
  });

  it("يطهر أسطر الترحيل في PostingIntent من أي أسطر صفرية تسبب خطأ المبلغ الصفري غير مسموح", () => {
    // التأكد من عدم وجود أسطر صفرية صلبة في مصفوفة lines لقيد المرتجع
    expect(routerSrc).not.toContain('debitLine("DELIVERY_REVENUE", money(0))');
    expect(routerSrc).not.toContain('creditLine("TAX_PAYABLE", money(0))');
    expect(routerSrc).not.toContain(
      'creditLine("PURCHASE_PRICE_VARIANCE", money(0))',
    );
  });

  it("يربط مرتجع المشتريات النقدي بدرج الوردية مع إيصال DRAWER IN وقيد PAYMENT_IN", () => {
    expect(purchaseCart).toMatch(/input.settlement.method === "CASH_IN"\s*\? \{\s*cashBucket: "DRAWER",\s*shiftId: input.settlement.shiftId/);
    expect(purchaseExecution).toMatch(/tx.insert\(receipts\).values\(\{[\s\S]*cashBucket: cash\?\.cashBucket \?\? null,[\s\S]*direction: "IN"/);
    expect(purchaseExecution).toMatch(/paymentAssetRole\(\s*request.paymentMethod,\s*cash\?\.cashBucket \?\? null,\s*"IN"/);
    expect(purchaseExecution).toMatch(/const cashSource = \{\s*roleDebits: \{ \[asset\]: total \},\s*roleCredits: \{ AP: total \}/);
    expect(purchaseExecution).toMatch(/postEntry\(tx, \{\s*entryType: "PAYMENT_IN",[\s\S]*receiptId: cashReceiptId,[\s\S]*"PAYMENT_IN_SUPPLIER_REFUND"[\s\S]*postingSourceComponents: cashSource/);
  });

  it("بوابات المرتجعات SalesReturnPortal وPurchaseReturnPortal تعرض منتقي الأدراج عند اختيار الاسترداد النقدي", () => {
    expect(salesStateSrc).toContain(
      "openDrawersQ = trpc.returns.getOpenRefundDrawers.useQuery",
    );
    expect(salesDrawersSrc).toContain("اختيار درج النقدية للصرف (الوردية)");
    expect(salesSubmissionSrc).toMatch(/shiftId:\s*settlementMethod === "CASH" && effectiveCashOrCardRefund > 0/);
    expect(salesPortalSrc).toContain('import { useSalesReturnPortal } from "./useSalesReturnPortal";');
    expect(salesPortalSrc).toContain("const model = useSalesReturnPortal(props)");
    expect(salesModelSrc).toContain("const state = useSalesReturnState(props)");
    expect(salesModelSrc).toMatch(/useSalesReturnSubmission\(\{\s*\.\.\.state,\s*\.\.\.settlement,/);
    expect(salesModelSrc).toContain("return { ...state, ...settlement, ...lookup, ...cart, ...scan, ...submission }");
    expect(salesPortalSrc).toMatch(/<SalesReturnSettlementPanel\s+\{\.\.\.\{[\s\S]*?openDrawersQ,[\s\S]*?selectedShiftId,/);
    expect(salesSettlementSrc).toMatch(/<SalesReturnSettlementMethods\s+\{\.\.\.\{[\s\S]*?openDrawersQ,[\s\S]*?selectedShiftId,/);
    expect(salesMethodsSrc).toMatch(/salesRefundMethod === "CASH" && \(\s*<SalesReturnCashDrawers/);
    expect(salesMethodsSrc).toMatch(/<SalesReturnCashDrawers\s+\{\.\.\.\{\s*openDrawersQ,\s*openDrawers,\s*selectedShiftId,/);

    expect(purchasePortalSrc).toContain(
      "openDrawersQ = trpc.returns.getOpenRefundDrawers.useQuery",
    );
    expect(purchasePortalSrc).toContain("اختيار درج الوردية المودع بها النقد:");
    expect(purchasePortalSrc).toMatch(
      /shiftId:\s*purchaseSettlement === "CASH_IN"/,
    );
  });
});
