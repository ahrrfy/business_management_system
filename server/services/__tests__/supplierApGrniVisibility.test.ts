// انحدار ١١/٩/٢٦: بعد هجرة حوكمة المشتريات (PR #923) صار مسار الترحيل الحيّ يكتب قيود GRNI بنوع
// `ADJUST` لا `PURCHASE`، فبقيت قرّاءُ ذمّة المورّد (reconcile + كشف الحساب) تبحث عن `PURCHASE`
// ⇒ أمرُ الشراء الحديث يختفي من الكشف ورصيدُه صحيح، وreconcile يُنذر انحرافاً كاذباً. هذه الحزمة
// تُثبت أنّ الأمر الحديث يظهر في الكشف وأنّ reconcile نظيف. راجع
// [[supplier-statement-grni-adjust-blindness-2026-09-11]].
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { decidePurchaseOrderControl } from "../purchase/controls";
import { confirmPurchaseOrder, createPurchaseOrder } from "../purchaseService";
import { reconcileSupplierBalances } from "../reconcileService";
import { getSupplierStatement } from "../reports/apAging";
import { getArApAgingDetail } from "../reportsAgingDetailService";
import { getPurchasesReport } from "../reportsPurchasesService";
import { truncateTables } from "./__testUtils__";

const creator = { userId: 1, branchId: 1, role: "admin" as const };
const approver = { userId: 2, branchId: 1, role: "manager" as const };

const TABLES = [
  "idempotencyKeys",
  "auditLogs",
  "purchaseOrderEvents",
  "purchaseOrderControlRequests",
  "purchaseOrderRequisitionAllocations",
  "purchaseOrderRevisionItems",
  "purchaseOrderRevisions",
  "supplierInvoiceApprovalRequests",
  "supplierInvoiceMatchAllocations",
  "supplierInvoiceMatchRuns",
  "supplierInvoiceLines",
  "supplierPaymentAllocations",
  "supplierPayments",
  "supplierPaymentRequestAllocations",
  "supplierPaymentRequests",
  "supplierInvoices",
  "goodsReceiptAccountingLinks",
  "goodsReceiptItems",
  "goodsReceipts",
  "journalLines",
  "journalEntries",
  "doubleEntrySettings",
  "accrualObligationEvents",
  "accrualObligations",
  "accountingEntries",
  "expenses",
  "receipts",
  "financialPeriods",
  "inventoryMovements",
  "purchaseOrderItems",
  "purchaseOrders",
  "purchaseControlSettings",
  "branchStock",
  "productUnits",
  "productVariants",
  "products",
  "suppliers",
  "branches",
  "users",
] as const;

function db() {
  const value = getDb();
  if (!value) throw new Error("DATABASE_URL not set");
  return value;
}

async function seed() {
  await db().insert(s.branches).values({ id: 1, name: "الرئيسي", code: "MAIN", type: "MAIN" });
  await db()
    .insert(s.users)
    .values([
      { id: 1, openId: "ap-grni-creator", name: "منشئ", role: "admin", loginMethod: "local", branchId: 1 },
      { id: 2, openId: "ap-grni-approver", name: "معتمد", role: "manager", loginMethod: "local", branchId: 1, isOwner: true },
    ]);
  await db().insert(s.suppliers).values({ id: 1, name: "مورد حديث", currentBalance: "0.00" });
  await db().insert(s.products).values({ id: 1, name: "ورق" });
  await db().insert(s.productVariants).values({ id: 1, productId: 1, sku: "AP-GRNI", costPrice: "4.00" });
  await db().insert(s.productUnits).values({ id: 1, variantId: 1, unitName: "قطعة", conversionFactor: "1", isBaseUnit: true });
  await db().insert(s.branchStock).values({ variantId: 1, branchId: 1, quantity: 10 });
}

/** يقود أمر شراء حديثاً كاملاً (DRAFT → SENT → RECEIVED) عبر مسار الحوكمة (GRNI/ADJUST). */
async function postModernCreditPurchase(): Promise<number> {
  const draft = await createPurchaseOrder(
    {
      supplierId: 1,
      branchId: 1,
      status: "DRAFT",
      settlementType: "CREDIT",
      shippingCost: "0.00",
      customsCost: "0.00",
      clientRequestId: `ap-grni-draft-${randomUUID()}`,
      items: [{ variantId: 1, productUnitId: 1, quantity: "10", unitPrice: "6.00" }],
    },
    creator,
  );
  const request = await confirmPurchaseOrder(
    {
      purchaseOrderId: draft.purchaseOrderId,
      expectedVersion: draft.version,
      reason: "اكتملت المراجعة وأُرسل للاعتماد",
      clientRequestId: `ap-grni-submit-${randomUUID()}`,
    },
    creator,
  );
  await decidePurchaseOrderControl(
    {
      requestId: request.requestId,
      decisionKey: `purchase-decision-PURCHASE_ORDER-${request.requestId}-approve-${randomUUID()}`,
      approve: true,
      reason: "تحققت من المورد والأسعار ووصول الكميات",
      confirmedFullReceipt: true,
    },
    approver,
  );
  return draft.purchaseOrderId;
}

beforeEach(async () => {
  await truncateTables(TABLES);
  await seed();
});

describe("رؤية ذمّة المورّد لأوامر الشراء الحديثة (GRNI/ADJUST)", () => {
  it("الأمر الحديث يرفع الرصيد إلى 60 ويُثبَت بقيود ADJUST فقط", async () => {
    const poId = await postModernCreditPurchase();
    const [supplier] = await db().select().from(s.suppliers).where(eq(s.suppliers.id, 1));
    expect(supplier.currentBalance).toBe("60.00");
    const entries = await db()
      .select({ entryType: s.accountingEntries.entryType })
      .from(s.accountingEntries)
      .where(eq(s.accountingEntries.purchaseOrderId, poId));
    expect(entries.length).toBeGreaterThan(0);
    expect(entries.every((e) => e.entryType === "ADJUST")).toBe(true);
  });

  it("reconcileSupplierBalances لا يُنذر بانحراف على الأمر الحديث", async () => {
    await postModernCreditPurchase();
    const drift = await reconcileSupplierBalances();
    expect(drift).toEqual([]);
  });

  it("كشف الحساب يُظهر الأمر الحديث بقيمته ويطابق رصيده المخزَّن", async () => {
    const poId = await postModernCreditPurchase();
    const stmt = await getSupplierStatement(1, {});
    expect(stmt).not.toBeNull();
    const poRow = stmt!.purchaseOrders.find((p) => p.id === poId);
    expect(poRow).toBeDefined();
    expect(poRow!.total).toBe("60.00");
    expect(stmt!.summary.currentBalance).toBe("60.00");
    // إجمالي مشتريات الفترة (بلا فترة = الكلّ) يشمل الأمر الحديث.
    expect(stmt!.summary.totalPurchases).toBe("60.00");
  });

  it("تفصيل أعمار الذمم الدائنة (getArApAgingDetail) يُظهر الأمر الحديث بمتبقٍّ 60", async () => {
    const poId = await postModernCreditPurchase();
    const detail = await getArApAgingDetail({ side: "AP" });
    const row = detail.rows.find((r) => r.id === poId);
    expect(row).toBeDefined();
    expect(row!.unpaid).toBe("60.00");
    expect(detail.totals.unpaid).toBe("60.00");
  });

  it("تقرير المشتريات (getPurchasesReport) يُظهر المورّد بحجم شراءٍ 60", async () => {
    await postModernCreditPurchase();
    const report = await getPurchasesReport({ from: "2020-01-01", to: "2099-12-31" });
    const row = report.rows.find((r) => r.supplierId === 1);
    expect(row).toBeDefined();
    expect(row!.total).toBe("60.00");
    expect(row!.unpaid).toBe("60.00");
  });
});
