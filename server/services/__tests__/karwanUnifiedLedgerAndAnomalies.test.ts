import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import {
  assessUsdRateSanity,
  balanceDirectionLabel,
  buildBalanceTrailSnapshot,
} from "../../../shared/balanceTrail";
import { getDb } from "../../db";
import { extractInsertId } from "../../lib/insertId";
import { customerRouter } from "../../routers/customerRouter";
import { reportsRouter } from "../../routers/reportsRouter";
import { saleRouter } from "../../routers/saleRouter";
import { supplierRouter } from "../../routers/supplierRouter";
import { createManualJournal } from "../accounting/manualJournalService";
import {
  alignSupplierUsdBalance,
  loadOpenSupplierUsdTotals,
  reclassifySupplierReceipt,
  reconcileCustomerCrossBranch,
  scanAccountAnomalies,
} from "../accounting/accountAnomalyService";
import { assertSupplierAdvanceInboundHistory } from "../purchase/advanceRefundEvidence";
import { autoSettleSupplierAccountTx } from "../reconciliation/autoSettlementService";
import {
  reconcileCustomerBalances,
  reconcileSupplierBalances,
} from "../reconcileService";
import { getARAging, getCustomerStatement } from "../reports/arAging";
import { getAPAging, getSupplierStatement } from "../reports/apAging";
import { buildSupplierBookFifo } from "../purchase/supplierBookSettlement";
import { boundedSupplierUsdDelta } from "../purchase/supplierVoucherCurrency";
import { createSale } from "../saleService";
import { withTx } from "../tx";
import { approveVoucher, createVoucher } from "../voucherService";

const db = () => {
  const d = getDb();
  if (!d) throw new Error("DATABASE_URL not set");
  return d;
};

const maker = { userId: 7, branchId: 1, role: "accountant" as const, isOwner: false };
const owner = { userId: 9, branchId: 1, role: "manager" as const, isOwner: true };

async function seedCoreEntities() {
  const d = db();
  await d.insert(s.branches).values([
    { id: 1, name: "الفرع الرئيسي", code: "MAIN", type: "MAIN" },
    { id: 2, name: "الفرع الثاني", code: "BR2", type: "SALES" },
  ]);
  await d.insert(s.users).values([
    { id: 7, openId: "k-maker", name: "محاسب", role: "accountant", branchId: 1, isOwner: false },
    { id: 9, openId: "k-owner", name: "مالك", role: "admin", branchId: 1, isOwner: true },
  ]);
  await d.insert(s.products).values({ id: 1, name: "طابعة حرارية" });
  await d.insert(s.productVariants).values({
    id: 1,
    productId: 1,
    variantName: "أساسي",
    sku: "KARWAN-PRN-1",
    costPrice: "50000.00",
  });
  await d.insert(s.productUnits).values({
    id: 1,
    variantId: 1,
    unitName: "قطعة",
    conversionFactor: "1",
    isBaseUnit: true,
  });
  await d.insert(s.productPrices).values({
    productUnitId: 1,
    priceTier: "RETAIL",
    price: "100000.00",
  });
  await d.insert(s.branchStock).values([
    { variantId: 1, branchId: 1, quantity: 50 },
    { variantId: 1, branchId: 2, quantity: 50 },
  ]);
  await d.insert(s.shifts).values([
    {
      id: 1,
      userId: 9,
      branchId: 1,
      status: "OPEN",
      openedAt: new Date(),
      openGuard: "1:9",
      openingBalance: "0.00",
    },
    {
      id: 2,
      userId: 9,
      branchId: 2,
      status: "OPEN",
      openedAt: new Date(),
      openGuard: "2:9",
      openingBalance: "0.00",
    },
  ]);
}

describe("قواعد المحاسبة الموحدة ومسار كروان وكاشف الشذوذ", () => {
  it("تحقق الدوال الصافية لحدود USD وفحص سعر الصرف ولقطة الرصيد وFIFO", () => {
    expect(boundedSupplierUsdDelta("52786.00", "10.00")).toBe("10.00");
    expect(boundedSupplierUsdDelta("5.00", "10.00")).toBe("5.00");
    expect(boundedSupplierUsdDelta("0.00", "10.00")).toBe("0.00");
    expect(boundedSupplierUsdDelta("-50.00", "10.00")).toBe("0.00");

    expect(assessUsdRateSanity("1500.00", "1490.00").status).toBe("OK");
    expect(assessUsdRateSanity("169.00", "1500.00")).toMatchObject({
      status: "ANOMALOUS",
      suggestedRate: "1690",
    });
    expect(assessUsdRateSanity("2100.00", "1500.00").status).toBe("WARN");

    expect(balanceDirectionLabel("SUPPLIER", "4707834.00")).toBe("له علينا");
    expect(balanceDirectionLabel("SUPPLIER", "-150.00")).toBe("لنا عليه");
    expect(balanceDirectionLabel("CUSTOMER", "500.00")).toBe("لنا عليه");
    expect(balanceDirectionLabel("CUSTOMER", "-200.00")).toBe("له علينا");

    const snap = buildBalanceTrailSnapshot({
      partyType: "SUPPLIER",
      before: "4707834.00",
      debit: "3055000.00",
    });
    expect(snap.beforeDirectionLabel).toBe("له علينا");
    expect(snap.afterDirectionLabel).toBe("له علينا");
    expect(snap.after).toBe("1652834.00");

    const fifo = buildSupplierBookFifo(
      [
        {
          supplierInvoiceId: 10,
          openingEntryId: null,
          date: "2026-11-20",
          order: 1,
          amount: "470834.00",
          currencyTotal: "470834.00",
          currencyUsed: "0.00",
          total: "470834.00",
          snapshot: { supplierInvoiceId: 10 },
        },
      ],
      [
        {
          entryId: 1,
          receiptId: 101,
          exchangeId: null,
          kind: "PAYMENT",
          date: "2026-11-18",
          allowUnallocated: true,
          ignoreTargetDate: true,
          amount: "3055000.00",
          snapshot: { entryId: 1 },
        },
      ],
    );
    expect(fifo.sources[0]?.allocations[0]?.supplierInvoiceId).toBe(10);
    expect(fifo.sources[0]?.allocations[0]?.amount).toBe("470834.00");
    expect(fifo.sources[0]?.unallocatedAmount).toBe("2584166.00");
  });

  describe("سيناريوهات القاعدة الكاملة (كروان، الإفراط، اليوميات، الشذوذ، التصدير)", () => {
    beforeEach(async () => {
      await seedCoreEntities();
    });

    it("يحل قضية المورد (470,834 فاتورة + 4,237,000 RV- + 52,786$ انحراف USD) ويمرر صرف 3,055,000 بدقة تامة", async () => {
      const d = db();
      await d.insert(s.suppliers).values({
        id: 1,
        name: "مورد كروان للإلكترونيات",
        currentBalance: "470834.00",
        currentBalanceUsd: "52786.00",
      });
      await d.insert(s.purchaseOrders).values({
        id: 1,
        poNumber: "PO-KARWAN-1",
        supplierId: 1,
        branchId: 1,
        status: "RECEIVED",
        settlementType: "CREDIT",
        subtotal: "470834.00",
        total: "470834.00",
        paidAmount: "0.00",
        orderDate: new Date("2026-11-18T08:00:00Z"),
        agreedCurrency: "IQD",
      });
      const entryId = extractInsertId(
        await d.insert(s.accountingEntries).values({
          entryType: "PURCHASE",
          entryDate: new Date("2026-11-18T08:00:00Z"),
          supplierId: 1,
          branchId: 1,
          purchaseOrderId: 1,
          amount: "470834.00",
          purchaseLiabilityAccount: "AP",
          createdBy: 7,
        }),
      );
      await d.insert(s.supplierInvoices).values({
        id: 1,
        invoiceNumber: "SIN-KARWAN-1",
        clientRequestId: "karwan-sin-1",
        origin: "LEGACY",
        liabilityClass: "LEGACY_AP",
        paymentGate: "OPEN",
        legacyPurchaseOrderId: 1,
        supplierId: 1,
        branchId: 1,
        status: "POSTED",
        invoiceDate: "2026-11-18",
        currency: "IQD",
        subtotal: "470834.00",
        totalAmount: "470834.00",
        payloadCanonical: "{}",
        payloadHash: "1".repeat(64),
        evidenceType: "LEGACY_LEDGER",
        legacySettledAmount: "0.00",
        legacySettlementEvidenceHash: "1".repeat(64),
        postingEntryId: entryId,
      });

      // سند قبض مستقل RV بقيمة 4,237,000 كالتزام دائن مشروع
      const rv = await createVoucher(
        {
          voucherType: "RECEIPT",
          branchId: 1,
          amount: "4237000.00",
          paymentMethod: "TRANSFER",
          referenceNumber: "RV-1-20261118-00003",
          partyType: "SUPPLIER",
          partyId: 1,
          description: "التزام دائن إضافي للمورد",
          supplierReceiptPurpose: "CREDIT_OBLIGATION",
          clientRequestId: randomUUID(),
        },
        owner,
      );
      expect(rv.balanceBefore).toBe("470834.00");
      expect(rv.balanceAfter).toBe("4707834.00");

      // صرف 3,055,000 — كان يفشل سابقاً بسبب قيد تاريخ السند وانحراف الدولار وعدم ضم RV-
      const pv = await createVoucher(
        {
          voucherType: "PAYMENT",
          branchId: 1,
          amount: "3055000.00",
          paymentMethod: "TRANSFER",
          referenceNumber: "PV-KARWAN-3055",
          partyType: "SUPPLIER",
          partyId: 1,
          description: "سداد دفعة من إجمالي المستحق",
          clientRequestId: randomUUID(),
        },
        maker,
      );
      const approvedPv = await approveVoucher(pv.receiptId, owner);
      expect(approvedPv.approvalStatus).toBe("APPROVED");
      expect(approvedPv.balanceBefore).toBe("4707834.00");
      expect(approvedPv.balanceAfter).toBe("1652834.00");
      expect(approvedPv.excessUnallocatedAmount).toBe("0.00");

      const [supAfter] = await d.select().from(s.suppliers).where(eq(s.suppliers.id, 1));
      expect(supAfter.currentBalance).toBe("1652834.00");
      expect(await reconcileSupplierBalances()).toEqual([]);

      // التحقق من تطابق كشف حساب المورد مع رصيد البطاقة ومعادلة الرصيد
      const stmt = await getSupplierStatement(1, { includeItems: true });
      expect(stmt).not.toBeNull();
      expect(stmt!.ledger.closingBalance).toBe("1652834.00");
      expect(stmt!.payments.some((p) => p.entryType === "PAYMENT_IN" && p.amount === "4237000.00")).toBe(true);
      expect(stmt!.payments.some((p) => p.entryType === "PAYMENT_OUT" && p.amount === "3055000.00")).toBe(true);

      // كاشف الشذوذ يلتقط انحراف الدولار 52,786$ ويعالجه ذرياً
      const beforeAnom = await scanAccountAnomalies({ supplierId: 1 });
      const usdAnom = beforeAnom.anomalies.find((a) => a.kind === "SUPPLIER_USD_DRIFT");
      expect(usdAnom).toBeDefined();
      expect(usdAnom!.metrics.expectedAmount).toBe("0.00");
      expect(usdAnom!.metrics.actualAmount).toBe("52786.00");

      const aligned = await alignSupplierUsdBalance(
        { supplierId: 1, note: "مواءمة الانحراف التاريخي", clientRequestId: randomUUID() },
        owner,
      );
      expect(aligned.aligned).toBe(true);
      expect(aligned.usdBefore).toBe("52786.00");
      expect(aligned.usdAfter).toBe("0.00");

      const afterAnom = await scanAccountAnomalies({ supplierId: 1 });
      expect(afterAnom.anomalies.find((a) => a.kind === "SUPPLIER_USD_DRIFT")).toBeUndefined();
    });

    it("يكتشف شذوذ سعر الصرف وRV غير المصنف ومقاصة العميل بين الفروع ويسدّد فاتورة العميل من الرصيد الدائن بلا نقد", async () => {
      const d = db();
      await d.insert(s.suppliers).values({
        id: 2,
        name: "مورد استيراد",
        currentBalance: "0.00",
        currentBalanceUsd: "0.00",
      });
      await d.insert(s.purchaseOrders).values({
        id: 20,
        poNumber: "PO-USD-BAD",
        supplierId: 2,
        branchId: 1,
        status: "CONFIRMED",
        settlementType: "CREDIT",
        subtotal: "16900.00",
        total: "16900.00",
        paidAmount: "0.00",
        orderDate: new Date("2026-11-18T10:00:00Z"),
        agreedCurrency: "USD",
        usdTotal: "100.00",
        agreedRate: "169.0000", // سقوط صفرية 169 بدل 1690
      });

      // سند قبض مورد غير مصنف (أُدرج مباشرة كما في السندات التاريخية قبل الحقل)
      const rawRvId = extractInsertId(
        await d.insert(s.receipts).values({
          branchId: 1,
          direction: "IN",
          amount: "50000.00",
          paymentMethod: "TRANSFER",
          referenceNumber: "RAW-UNCLASSIFIED-RV",
          partyType: "SUPPLIER",
          partyId: 2,
          voucherNumber: "RV-1-20261118-99999",
          description: "سند مورد بدون تصنيف",
          createdBy: 7,
          status: "COMPLETED",
          approvalStatus: "APPROVED",
          approvedBy: 9,
          approvedAt: new Date(),
        }),
      );
      await d.insert(s.accountingEntries).values({
        entryType: "PAYMENT_IN",
        entryDate: new Date(),
        branchId: 1,
        supplierId: 2,
        receiptId: rawRvId,
        amount: "50000.00",
        createdBy: 7,
      });
      await d
        .update(s.suppliers)
        .set({ currentBalance: "50000.00" })
        .where(eq(s.suppliers.id, 2));

      const supAnom = await scanAccountAnomalies({ supplierId: 2 });
      expect(supAnom.anomalies.some((a) => a.kind === "ANOMALOUS_USD_RATE")).toBe(true);
      expect(supAnom.anomalies.some((a) => a.kind === "UNCLASSIFIED_SUPPLIER_RECEIPT")).toBe(true);

      const reclassified = await reclassifySupplierReceipt(
        {
          receiptId: rawRvId,
          action: "CONFIRM_CREDIT_OBLIGATION",
          reason: "اعتماد الالتزام الدائن",
          clientRequestId: randomUUID(),
        },
        owner,
      );
      expect(reclassified.updatedPurpose).toBe("CREDIT_OBLIGATION");

      // عميل: رصيد دائن في الفرع 1، وفاتورتان في الفرع 1 والفرع 2
      await d.insert(s.accounts).values([
        { id: 10, code: "3100", name: "جاري المالك", type: "EQUITY", systemRole: "OWNER_CURRENT", isActive: true, sortOrder: 1 },
        { id: 20, code: "1200", name: "ذمم العملاء", type: "ASSET", systemRole: "AR", isActive: true, sortOrder: 2 },
      ]);
      await d.insert(s.customers).values({
        id: 1,
        name: "عميل متعدد الفروع",
        currentBalance: "0.00",
        creditLimit: "9999999.00",
      });

      // فاتورة في الفرع 1 (100,000) + فاتورة في الفرع 2 (100,000)
      const saleBr1 = await createSale(
        {
          branchId: 1,
          customerId: 1,
          priceTier: "RETAIL",
          sourceType: "ORDER",
          lines: [{ variantId: 1, productUnitId: 1, quantity: "1" }],
        },
        { userId: 9, branchId: 1, role: "admin" },
      );
      const saleBr2 = await createSale(
        {
          branchId: 2,
          customerId: 1,
          priceTier: "RETAIL",
          sourceType: "ORDER",
          lines: [{ variantId: 1, productUnitId: 1, quantity: "1" }],
        },
        { userId: 9, branchId: 2, role: "admin" },
      );

      // رصيد دائن بالفرع 1 عبر قيد يومية يدوي (لا يُسوّي الفاتورة تلقائياً) لاختبار useCustomerCredit عبر ترحيل الرصيد التاريخي
      await withTx((tx) =>
        createManualJournal(
          tx,
          {
            entryDate: "2026-11-18",
            notes: "رصيد دائن للعميل في الفرع 1",
            branchId: 1,
            lines: [
              { accountId: 10, debit: "100000.00", credit: "0.00" },
              { accountId: 20, debit: "0.00", credit: "100000.00", customerId: 1 },
            ],
          },
          { userId: 7, branchId: 1, role: "accountant" },
          { user: { id: 7, name: "محاسب", role: "accountant" }, req: { ip: "127.0.0.1", headers: {} } } as any,
        ),
      );

      // سداد فاتورة الفرع 1 من الرصيد الدائن بلا نقد عبر tRPC router
      const saleCaller = saleRouter.createCaller({
        user: { id: 9, name: "مالك", role: "admin", branchId: 1, isOwner: true },
      } as any);
      const creditPay = await saleCaller.pay({
        invoiceId: saleBr1.invoiceId,
        useCustomerCredit: true,
        clientRequestId: randomUUID(),
      });
      expect(creditPay.status).toBe("PAID");
      expect((creditPay as any).creditApplied).toBe("100000.00");

      // قبض عام 250,000 في الفرع 1 بعد سداد فاتورة الفرع 1 -> رصيد متاح للمقاصة مع الفرع 2
      await createVoucher(
        {
          voucherType: "RECEIPT",
          branchId: 1,
          amount: "250000.00",
          paymentMethod: "TRANSFER",
          referenceNumber: "CUST-BR1-CR",
          partyType: "CUSTOMER",
          partyId: 1,
          description: "دفعة مقدمة في الفرع الرئيسي",
          clientRequestId: randomUUID(),
        },
        owner,
      );

      const custAnom = await scanAccountAnomalies({ customerId: 1 });
      expect(custAnom.anomalies.some((a) => a.kind === "CROSS_BRANCH_CUSTOMER_CREDIT")).toBe(true);

      // مقاصة فاتورة الفرع 2 من رصيد الفرع 1 عبر router
      const custCaller = customerRouter.createCaller({
        user: { id: 9, name: "مالك", role: "admin", branchId: 1, isOwner: true },
      } as any);
      const ibcRes = await custCaller.reconcileCrossBranch({
        customerId: 1,
        sourceBranchId: 1,
        targetBranchId: 2,
        invoiceId: saleBr2.invoiceId,
        clientRequestId: randomUUID(),
      });
      expect(ibcRes.settledAmount).toBe("100000.00");
      expect(await reconcileCustomerBalances()).toEqual([]);

      // اختبار BatchInvoicesData وincludeItems على التقارير
      const reportsCaller = reportsRouter.createCaller({
        user: { id: 9, name: "مالك", role: "admin", branchId: 1, isOwner: true },
      } as any);
      const batchCust = await reportsCaller.batchInvoicesData({
        partyType: "CUSTOMER",
        partyId: 1,
        includeItems: true,
        statusFilter: "COMPLETED_ONLY",
      });
      expect(batchCust.invoices.length).toBeGreaterThanOrEqual(1);
      expect(batchCust.invoices[0]?.items[0]?.unitName).toBe("قطعة");
    });

    it("يستهلك allowSupplierOverpay تلقائياً في autoSettleSupplierAccountTx عند وجود يومية يدوية وفاتورة جديدة", async () => {
      const d = db();
      await d.insert(s.accounts).values([
        { id: 10, code: "3100", name: "جاري المالك", type: "EQUITY", systemRole: "OWNER_CURRENT", isActive: true, sortOrder: 1 },
        { id: 30, code: "2100", name: "ذمم الموردين", type: "LIABILITY", systemRole: "AP", isActive: true, sortOrder: 2 },
      ]);
      await d.insert(s.suppliers).values({
        id: 1,
        name: "مورد سلفة",
        currentBalance: "0.00",
        currentBalanceUsd: "0.00",
      });

      const ov = await createVoucher(
        {
          voucherType: "PAYMENT",
          branchId: 1,
          amount: "300000.00",
          paymentMethod: "TRANSFER",
          referenceNumber: "OV-SUP-1",
          partyType: "SUPPLIER",
          partyId: 1,
          description: "دفعة مقدمة على حساب المورد",
          allowSupplierOverpay: true,
          clientRequestId: randomUUID(),
        },
        owner,
      );
      expect(ov.balanceAfter).toBe("-300000.00");

      // تسجيل قيد يدوي يرفع استحقاق المورد 100,000 + فاتورة مورد جديدة 150,000
      await withTx((tx) =>
        createManualJournal(
          tx,
          {
            entryDate: "2026-11-18",
            notes: "استحقاق إضافي للمورد",
            branchId: 1,
            lines: [
              { accountId: 10, debit: "100000.00", credit: "0.00" },
              { accountId: 30, debit: "0.00", credit: "100000.00", supplierId: 1 },
            ],
          },
          { userId: 7, branchId: 1, role: "accountant" },
          { user: { id: 7, name: "محاسب", role: "accountant" }, req: { ip: "127.0.0.1", headers: {} } } as any,
        ),
      );
      await d.insert(s.purchaseOrders).values({
        id: 50,
        poNumber: "PO-AUTO-50",
        supplierId: 1,
        branchId: 1,
        status: "RECEIVED",
        settlementType: "CREDIT",
        subtotal: "150000.00",
        total: "150000.00",
        paidAmount: "0.00",
        orderDate: new Date("2026-11-18T12:00:00Z"),
        agreedCurrency: "IQD",
      });
      const e50 = extractInsertId(
        await d.insert(s.accountingEntries).values({
          entryType: "PURCHASE",
          entryDate: new Date("2026-11-18T12:00:00Z"),
          supplierId: 1,
          branchId: 1,
          purchaseOrderId: 50,
          amount: "150000.00",
          purchaseLiabilityAccount: "AP",
          createdBy: 7,
        }),
      );
      await d.insert(s.supplierInvoices).values({
        id: 50,
        invoiceNumber: "SIN-AUTO-50",
        clientRequestId: "sin-auto-50",
        origin: "LEGACY",
        liabilityClass: "LEGACY_AP",
        paymentGate: "OPEN",
        legacyPurchaseOrderId: 50,
        supplierId: 1,
        branchId: 1,
        status: "POSTED",
        invoiceDate: "2026-11-18",
        currency: "IQD",
        subtotal: "150000.00",
        totalAmount: "150000.00",
        legacySettledAmount: "0.00",
        legacySettlementEvidenceHash: "5".repeat(64),
        payloadCanonical: "{}",
        payloadHash: "5".repeat(64),
        evidenceType: "OTHER",
        postingEntryId: e50,
      });
      await d
        .update(s.suppliers)
        .set({ currentBalance: "-50000.00" }) // -300k + 100k + 150k = -50k
        .where(eq(s.suppliers.id, 1));

      const autoRes = await withTx((tx) => autoSettleSupplierAccountTx(tx, 1, owner));
      expect(autoRes.settledOrdersCount).toBeGreaterThanOrEqual(1);
      const [inv50] = await d.select().from(s.supplierInvoices).where(eq(s.supplierInvoices.id, 50));
      expect(inv50.paymentGate).toBe("SETTLED");
      expect(await reconcileSupplierBalances()).toEqual([]);

      const supCaller = supplierRouter.createCaller({
        user: { id: 9, name: "مالك", role: "admin", branchId: 1, isOwner: true },
      } as any);
      const anomCheck = await supCaller.anomalies({ supplierId: 1 });
      expect(anomCheck.anomalies.filter((a) => a.kind === "LEDGER_BALANCE_DRIFT")).toEqual([]);
    });

    it("يفرض SOD وإعفاء CREDIT_OBLIGATION وبوابة المالك لـ alignUsdBalance وإبقاء متبقي USD الموجب", async () => {
      const d = db();
      await d.insert(s.users).values({
        id: 8,
        openId: "k-mgr2",
        name: "مدير ثان",
        role: "manager",
        branchId: 1,
        isOwner: false,
      });
      await d.insert(s.suppliers).values({
        id: 10,
        name: "مورد حزمة ب",
        currentBalance: "100000.00",
        currentBalanceUsd: "250.00",
      });

      const rawRv = extractInsertId(
        await d.insert(s.receipts).values({
          branchId: 1,
          direction: "IN",
          amount: "100000.00",
          paymentMethod: "TRANSFER",
          referenceNumber: "RAW-MF2-RV",
          partyType: "SUPPLIER",
          partyId: 10,
          voucherNumber: "RV-1-20261118-88881",
          description: "قبض غير مصنف",
          createdBy: 7,
          status: "COMPLETED",
          approvalStatus: "APPROVED",
          approvedBy: 9,
          approvedAt: new Date(),
        }),
      );

      // رفض التصنيف الذاتي لغير المالك (SOD)
      await expect(
        reclassifySupplierReceipt(
          {
            receiptId: rawRv,
            action: "CONFIRM_CREDIT_OBLIGATION",
            clientRequestId: randomUUID(),
          },
          { userId: 7, branchId: 1, role: "manager", isOwner: false },
        ),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });

      // مدير آخر يعتمد التصنيف وتُسقط العقبة عن assertSupplierAdvanceInboundHistory
      await reclassifySupplierReceipt(
        {
          receiptId: rawRv,
          action: "CONFIRM_CREDIT_OBLIGATION",
          reason: "رصيد مورد مثبت",
          clientRequestId: randomUUID(),
        },
        { userId: 8, branchId: 1, role: "manager", isOwner: false },
      );
      await expect(assertSupplierAdvanceInboundHistory(d, 10, 1)).resolves.toBeUndefined();

      // REVERSE_RECEIPT يدعم idempotent replay بالمفتاح نفسه
      const revRv = extractInsertId(
        await d.insert(s.receipts).values({
          branchId: 1,
          direction: "IN",
          amount: "20000.00",
          paymentMethod: "TRANSFER",
          referenceNumber: "RAW-MF2-REV",
          partyType: "SUPPLIER",
          partyId: 10,
          voucherNumber: "RV-1-20261118-88882",
          description: "سند قابل للعكس",
          createdBy: 7,
          status: "COMPLETED",
          approvalStatus: "APPROVED",
          approvedBy: 9,
          approvedAt: new Date(),
        }),
      );
      await d.insert(s.accountingEntries).values({
        entryType: "PAYMENT_IN",
        entryDate: new Date("2026-11-18T10:00:00Z"),
        branchId: 1,
        supplierId: 10,
        receiptId: revRv,
        amount: "20000.00",
        createdBy: 7,
      });
      await d.update(s.suppliers).set({ currentBalance: "120000.00" }).where(eq(s.suppliers.id, 10));
      const revKey = randomUUID();
      const firstRev = await reclassifySupplierReceipt(
        { receiptId: revRv, action: "REVERSE_RECEIPT", reason: "عكس", clientRequestId: revKey },
        owner,
      );
      const replayRev = await reclassifySupplierReceipt(
        { receiptId: revRv, action: "REVERSE_RECEIPT", reason: "عكس", clientRequestId: revKey },
        owner,
      );
      expect(replayRev.evidenceHash).toBe(firstRev.evidenceHash);

      // non-owner مرفوض في alignSupplierUsdBalance
      await expect(
        alignSupplierUsdBalance(
          { supplierId: 10, clientRequestId: randomUUID() },
          { userId: 8, branchId: 1, role: "manager", isOwner: false },
        ),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });

      // فاتورة USD: سداد الدينار بالكامل مع بقاء 10.00$ بسبب فرق سعر الصرف
      const inv101PostE = extractInsertId(
        await d.insert(s.accountingEntries).values({
          entryType: "PURCHASE",
          entryDate: new Date("2026-11-18T08:00:00Z"),
          branchId: 1,
          supplierId: 10,
          amount: "150000.00",
          createdBy: 9,
        }),
      );
      await d.insert(s.supplierInvoices).values({
        id: 101,
        invoiceNumber: "SIN-USD-RES",
        externalInvoiceNumber: "EXT-USD-RES",
        externalNumberNorm: "ext-usd-res",
        clientRequestId: "sin-usd-res",
        origin: "NATIVE",
        liabilityClass: "NATIVE_AP",
        paymentGate: "SETTLED",
        supplierId: 10,
        branchId: 1,
        status: "POSTED",
        invoiceDate: "2026-11-18",
        currency: "USD",
        agreedRate: "1500.0000",
        usdTotal: "100.00",
        subtotal: "150000.00",
        totalAmount: "150000.00",
        payloadCanonical: "{}",
        payloadHash: "a".repeat(64),
        evidenceType: "OTHER",
        evidenceReference: "TEST-USD-RES",
        createdBy: 9,
        postingEntryId: inv101PostE,
        postedBy: 9,
        postedAt: new Date(),
      });
      const pay101R = extractInsertId(
        await d.insert(s.receipts).values({
          branchId: 1,
          direction: "OUT",
          amount: "150000.00",
          paymentMethod: "TRANSFER",
          referenceNumber: "SP-USD-RES-1",
          partyType: "SUPPLIER",
          partyId: 10,
          voucherNumber: "PV-1-20261118-88883",
          description: "سداد ديناري لالتزام USD",
          createdBy: 9,
          status: "COMPLETED",
          approvalStatus: "APPROVED",
          approvedBy: 9,
          approvedAt: new Date(),
        }),
      );
      const pay101E = extractInsertId(
        await d.insert(s.accountingEntries).values({
          entryType: "PAYMENT_OUT",
          entryDate: new Date("2026-11-18T09:00:00Z"),
          branchId: 1,
          supplierId: 10,
          receiptId: pay101R,
          amount: "150000.00",
          createdBy: 9,
        }),
      );
      const src101 = extractInsertId(
        await d.insert(s.supplierBookSettlementSources).values({
          supplierId: 10,
          branchId: 1,
          sourceAccountingEntryId: pay101E,
          sourceReceiptId: pay101R,
          kind: "PAYMENT",
          amount: "150000.00",
          sourceSnapshot: "{}",
          sourceHash: "b".repeat(64),
          planHash: "b".repeat(64),
          adoptionKey: "USD-RES-BOOK-1",
          adoptedBy: 9,
          reversalHistory: "[]",
        }),
      );
      await d.insert(s.supplierBookSettlementAllocations).values({
        sourceId: src101,
        supplierInvoiceId: 101,
        allocatedAmount: "150000.00",
        allocatedCurrencyAmount: "90.00",
        targetSnapshot: "{}",
        targetHash: "c".repeat(64),
      });
      const openUsdMap = await loadOpenSupplierUsdTotals(d, [10]);
      expect(openUsdMap.get(10)?.toFixed(2)).toBe("10.00");

      const alignKey = randomUUID();
      const align1 = await alignSupplierUsdBalance({ supplierId: 10, clientRequestId: alignKey }, owner);
      expect(align1.aligned).toBe(true);
      expect(align1.usdAfter).toBe("10.00");
      await d.update(s.suppliers).set({ currentBalanceUsd: "99.00" }).where(eq(s.suppliers.id, 10));
      await alignSupplierUsdBalance({ supplierId: 10, clientRequestId: randomUUID() }, owner);
      const alignReplay = await alignSupplierUsdBalance({ supplierId: 10, clientRequestId: alignKey }, owner);
      expect(alignReplay.aligned).toBe(true);
      expect(alignReplay.deltaUsd).toBe(align1.deltaUsd);
    });

    it("يعزل ASSET_ACQ وFULFILLMENT_CHARGE_COST عن BOOK ويجيز الدفع الزائد من الخزينة فقط", async () => {
      const d = db();
      await d.insert(s.suppliers).values({
        id: 20,
        name: "مورد أصل وتنفيذ",
        currentBalance: "50000.00",
        currentBalanceUsd: "0.00",
      });
      await d.insert(s.accountingEntries).values({
        entryType: "ADJUST",
        entryDate: new Date("2026-11-18T08:00:00Z"),
        branchId: 1,
        supplierId: 20,
        amount: "50000.00",
        dedupeKey: "FULFILLMENT_CHARGE_COST:901",
        notes: "مستحق مقاول تنفيذ",
        createdBy: 7,
      });

      // رفض DRAWER على سند OVERPAY نقدي
      await expect(
        createVoucher(
          {
            voucherType: "PAYMENT",
            branchId: 1,
            amount: "10000.00",
            paymentMethod: "CASH",
            partyType: "SUPPLIER",
            partyId: 20,
            description: "صرف زائد عبر الدرج",
            allowSupplierOverpay: true,
            supplierCashSource: { mode: "DRAWER", shiftId: 1 } as any,
            clientRequestId: randomUUID(),
          },
          owner,
        ),
      ).rejects.toMatchObject({ code: "BAD_REQUEST" });

      // سند OVERPAY معلق ثم اعتماد لاحق بعد إدراج فاتورة يمر عبر الخزينة وبلا خطأ
      const pendingOverpay = await createVoucher(
        {
          voucherType: "PAYMENT",
          branchId: 1,
          amount: "80000.00",
          paymentMethod: "TRANSFER",
          referenceNumber: "OVP-PEND-1",
          partyType: "SUPPLIER",
          partyId: 20,
          description: "سند زائد معلق",
          allowSupplierOverpay: true,
          clientRequestId: randomUUID(),
        },
        maker,
      );
      const approvedOverpay = await approveVoucher(pendingOverpay.receiptId, owner);
      expect(approvedOverpay.approvalStatus).toBe("APPROVED");
    });

    it("يمرر المقاصة المتتابعة والاستخدام التاريخي بالفرع وتقارير الأعمار الفرعية واليومية المزدوجة", async () => {
      const d = db();
      await d.insert(s.accounts).values([
        { id: 10, code: "3100", name: "جاري المالك", type: "EQUITY", systemRole: "OWNER_CURRENT", isActive: true, sortOrder: 1 },
        { id: 20, code: "1200", name: "ذمم العملاء", type: "ASSET", systemRole: "AR", isActive: true, sortOrder: 2 },
        { id: 30, code: "2100", name: "ذمم الموردين", type: "LIABILITY", systemRole: "AP", isActive: true, sortOrder: 3 },
        { id: 40, code: "1900", name: "تسوية الفروع", type: "ASSET", systemRole: "INTERBRANCH_CLEARING", isActive: true, sortOrder: 4 },
      ]);
      await d.insert(s.suppliers).values({
        id: 30,
        name: "مورد يومية يدوية فرع 1",
        currentBalance: "0.00",
        currentBalanceUsd: "0.00",
      });
      await d.insert(s.customers).values({
        id: 30,
        name: "عميل مقاصة وتاريخي",
        currentBalance: "0.00",
        creditLimit: "9999999.00",
      });

      // يومية يدوية AP للمورد 30 في فرع 1 => تظهر في getAPAging({ branchId: 1 })
      await withTx((tx) =>
        createManualJournal(
          tx,
          {
            entryDate: "2026-11-18",
            notes: "قيد يدوي AP",
            branchId: 1,
            lines: [
              { accountId: 10, debit: "75000.00", credit: "0.00" },
              { accountId: 30, debit: "0.00", credit: "75000.00", supplierId: 30 },
            ],
          },
          maker,
          { user: { id: 7, name: "محاسب", role: "accountant" }, req: { ip: "127.0.0.1", headers: {} } } as any,
        ),
      );
      const apBranch = await getAPAging({ branchId: 1 });
      expect(apBranch.find((r) => r.supplierId === 30)?.currentBalance).toBe("75000.00");

      // عميل 30: قبض متتبع 50,000 + يومية يدوية AR (مدين 60,000 / دائن 150,000 => صافي دائن 90,000) + عربون محتجز 200,000
      await createVoucher(
        {
          voucherType: "RECEIPT",
          branchId: 1,
          amount: "50000.00",
          paymentMethod: "TRANSFER",
          referenceNumber: "C30-TRK-1",
          partyType: "CUSTOMER",
          partyId: 30,
          description: "قبض متتبع فرع 1",
          clientRequestId: randomUUID(),
        },
        owner,
      );
      await withTx((tx) =>
        createManualJournal(
          tx,
          {
            entryDate: "2026-11-18",
            notes: "قيد يدوي مزدوج الاتجاه للعميل",
            branchId: 1,
            lines: [
              { accountId: 20, debit: "60000.00", credit: "0.00", customerId: 30 },
              { accountId: 20, debit: "0.00", credit: "150000.00", customerId: 30 },
              { accountId: 10, debit: "90000.00", credit: "0.00" },
            ],
          },
          maker,
          { user: { id: 7, name: "محاسب", role: "accountant" }, req: { ip: "127.0.0.1", headers: {} } } as any,
        ),
      );
      const woId = extractInsertId(
        await d.insert(s.workOrders).values({
          orderNumber: "WO-HELD-30",
          branchId: 1,
          title: "أمر شغل عربون محتجز",
          status: "IN_PROGRESS",
          createdBy: 9,
          customerId: 30,
        }),
      );
      const heldRId = extractInsertId(
        await d.insert(s.receipts).values({
          branchId: 1,
          direction: "IN",
          amount: "200000.00",
          paymentMethod: "TRANSFER",
          referenceNumber: "WO-HOLD-30",
          partyType: "CUSTOMER",
          partyId: 30,
          workOrderId: woId,
          description: "عربون محتجز لا يجوز سحبه",
          createdBy: 9,
          status: "COMPLETED",
          approvalStatus: "APPROVED",
          approvedBy: 9,
          approvedAt: new Date(),
        }),
      );
      await d.insert(s.accountingEntries).values({
        entryType: "PAYMENT_IN",
        entryDate: new Date("2026-11-18T09:00:00Z"),
        branchId: 1,
        customerId: 30,
        receiptId: heldRId,
        amount: "200000.00",
        notes: "[WO_DEPOSIT:HELD]",
        createdBy: 9,
      });

      // فاتورة في فرع 1 (100,000) + فاتورة في فرع 2 (100,000)
      const s1 = await createSale(
        {
          branchId: 1,
          customerId: 30,
          priceTier: "RETAIL",
          sourceType: "ORDER",
          deferCustomerSettlement: true,
          lines: [{ variantId: 1, productUnitId: 1, quantity: "1" }],
        },
        { userId: 9, branchId: 1, role: "admin" },
      );
      const s2 = await createSale(
        {
          branchId: 2,
          customerId: 30,
          priceTier: "RETAIL",
          sourceType: "ORDER",
          deferCustomerSettlement: true,
          lines: [{ variantId: 1, productUnitId: 1, quantity: "1" }],
        },
        { userId: 9, branchId: 2, role: "admin" },
      );

      // استخدام الرصيد في فرع 1 يستهلك 50,000 المتتبع + 50,000 من الرصيد التاريخي (اليومية اليدوية) مع replay محكم
      const saleCaller = saleRouter.createCaller({
        user: { id: 9, name: "مالك", role: "admin", branchId: 1, isOwner: true },
      } as any);
      const creditKey1 = randomUUID();
      const firstPay = await saleCaller.pay({
        invoiceId: s1.invoiceId,
        amount: "70000.00",
        useCustomerCredit: true,
        clientRequestId: creditKey1,
      });
      expect((firstPay as any).creditApplied).toBe("70000.00");
      await saleCaller.pay({
        invoiceId: s1.invoiceId,
        amount: "30000.00",
        useCustomerCredit: true,
        clientRequestId: randomUUID(),
      });
      const firstReplay = await saleCaller.pay({
        invoiceId: s1.invoiceId,
        amount: "70000.00",
        useCustomerCredit: true,
        clientRequestId: creditKey1,
      });
      expect((firstReplay as any).creditApplied).toBe("70000.00");
      expect(await reconcileCustomerBalances()).toEqual([]);

      // المتبقي من الرصيد الدائن في فرع 1 = 40,000 (140,000 - 100,000) وعربون الحجز 200,000 مستبعد
      const custCaller = customerRouter.createCaller({
        user: { id: 9, name: "مالك", role: "admin", branchId: 1, isOwner: true },
      } as any);
      const ibcRes = await custCaller.reconcileCrossBranch({
        customerId: 30,
        sourceBranchId: 1,
        targetBranchId: 2,
        invoiceId: s2.invoiceId,
        clientRequestId: randomUUID(),
      });
      expect(ibcRes.settledAmount).toBe("40000.00");
      expect(await reconcileCustomerBalances()).toEqual([]);

      // getARAging({ branchId: 2 }) يظهر المتبقي 60,000 بعد CUSTOMER_INTERBRANCH_IN (-40,000)
      const arBr2 = await getARAging({ branchId: 2 });
      expect(arBr2.find((r) => r.customerId === 30)?.currentBalance).toBe("60000.00");

      // كشف حساب العميل في فرع 1 يُظهر حركتي اليدوي الإجماليتين (OUT 60,000 و IN 150,000) لا الصافي 90,000
      const stmtC30 = await getCustomerStatement(30, { branchId: 1 });
      expect(stmtC30).not.toBeNull();
      expect(
        stmtC30!.payments.some((p) => p.paymentMethod === "MANUAL_JOURNAL" && p.direction === "OUT" && p.amount === "60000.00"),
      ).toBe(true);
      expect(
        stmtC30!.payments.some((p) => p.paymentMethod === "MANUAL_JOURNAL" && p.direction === "IN" && p.amount === "150000.00"),
      ).toBe(true);
    });
  });
});
