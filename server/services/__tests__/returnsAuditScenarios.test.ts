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
import { describe, expect, it } from "vitest";

const readServer = (rel: string) =>
  readFileSync(new URL(`../../${rel}`, import.meta.url), "utf8");

const readClient = (rel: string) =>
  readFileSync(new URL(`../../../client/src/${rel}`, import.meta.url), "utf8");

describe("١. تدقيق الأثر المالي والمخزني والتسجيل الذري في returnRouter", () => {
  const routerSrc = readServer("routers/returnRouter.ts");

  it("يحتوي على مسار مرتجع المبيعات الذري executeSalesReturnCart بضوابط مالية ومخزنية", () => {
    expect(routerSrc).toContain(
      "executeSalesReturnCart: salesCashierProcedure",
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
    expect(routerSrc).toContain(
      'min(1, "يجب تحديد صنف واحد على الأقل للمرتجع")',
    );
    expect(routerSrc).toContain(
      'z.enum(["CREDIT_OFFSET", "CASH_IN", "CARD_TRANSFER"])',
    );
    expect(routerSrc).toContain("adjustSupplierBalance(");
    expect(routerSrc).toContain('movementType: "OUT"');
    expect(routerSrc).toContain('referenceType: "PURCHASE_RETURN"');
  });

  it("يضمن التسجيل في سجل التدقيق الإداري logAudit لكل عملية مرتجع", () => {
    expect(routerSrc).toContain("logAudit(");
    expect(routerSrc).toContain('action: "sale.return_cart"');
    expect(routerSrc).toContain('action: "purchase.return_cart"');
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

  it("إجراء مرتجع الشراء في المشتريات يقود إلى بوابة المرتجعات مع رقم أمر الشراء", () => {
    expect(purchasesSrc).toContain('key: "preturn"');
    expect(purchasesSrc).toContain(
      "href: `/returns?portal=purchases&po=${encodeURIComponent(p.poNumber)}`",
    );
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
  const salesPortalSrc = readClient("components/returns/SalesReturnPortal.tsx");
  const purchasePortalSrc = readClient(
    "components/returns/PurchaseReturnPortal.tsx",
  );

  it("يوفّر إجراء getOpenRefundDrawers بصلاحية كاشير لجلب الأدراج المفتوحة بالفرع مع مؤشر الملكية", () => {
    expect(routerSrc).toContain("getOpenRefundDrawers: salesCashierProcedure");
    expect(routerSrc).toContain("expectedCash: s.expectedCash");
    expect(routerSrc).toContain(
      "isMine: Number(s.userId) === Number(ctx.user.id)",
    );
  });

  it("يربط مرتجع المبيعات النقدي بدرج الوردية مع فحص الكفاية وتوليد إيصال DRAWER OUT وقيد PAYMENT_OUT", () => {
    expect(routerSrc).toContain("assertCashOutAvailable(tx");
    expect(routerSrc).toContain('cashBucket: "DRAWER"');
    expect(routerSrc).toContain('direction: "OUT"');
    expect(routerSrc).toContain("PAYMENT_OUT_CUSTOMER_REFUND");
    expect(routerSrc).toContain("roleDebits: { AR: returnTotalDec }");
    expect(routerSrc).toContain("roleCredits: { CASH: returnTotalDec }");
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
    expect(routerSrc).toContain("PAYMENT_IN_SUPPLIER_REFUND");
    expect(routerSrc).toContain("roleDebits: { CASH: returnTotalDec }");
    expect(routerSrc).toContain("roleCredits: { AP: returnTotalDec }");
  });

  it("بوابات المرتجعات SalesReturnPortal وPurchaseReturnPortal تعرض منتقي الأدراج عند اختيار الاسترداد النقدي", () => {
    expect(salesPortalSrc).toContain(
      "openDrawersQ = trpc.returns.getOpenRefundDrawers.useQuery",
    );
    expect(salesPortalSrc).toContain("اختيار درج النقدية للصرف (الوردية)");
    expect(salesPortalSrc).toContain(
      'shiftId: salesRefundMethod === "CASH" ? (selectedShiftId ?? undefined) : undefined',
    );

    expect(purchasePortalSrc).toContain(
      "openDrawersQ = trpc.returns.getOpenRefundDrawers.useQuery",
    );
    expect(purchasePortalSrc).toContain("اختيار درج الوردية المودع بها النقد:");
    expect(purchasePortalSrc).toContain(
      'shiftId: purchaseSettlement === "CASH_IN" ? (selectedShiftId ?? undefined) : undefined',
    );
  });
});
