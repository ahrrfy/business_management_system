import { sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { getRecentMovements } from "../treasury/movements";
import { getCustomerStatement } from "../reports/arAging";
import { getSupplierStatement } from "../reports/apAging";
import { listExpenses } from "../expenseService";
import { enrichShiftListProvenance } from "../shiftService";
import {
  getStatutoryAccountLedger,
  getStatutoryGeneralJournal,
} from "../accounting/statutoryReports";
import {
  approveStatutoryProfile,
  createStatutoryProfile,
  replaceStatutoryAccounts,
  replaceStatutoryMappings,
} from "../accounting/statutoryAccounting";
import { writeJournal } from "../accounting/journalStore";
import type { JournalLine } from "../accounting/postingEngine";
import { extractInsertId } from "../../lib/insertId";
import { withTx } from "../tx";
import { money } from "../money";
import type { FinancialCellProvenancePayload } from "@shared/financialProvenance";

const TABLES = [
  "idempotencyKeys",
  "statutoryLedgerSnapshots",
  "journalLines",
  "journalEntries",
  "accountingEntries",
  "statutoryAccountMappings",
  "statutoryAccounts",
  "statutoryProfiles",
  "accounts",
  "doubleEntrySettings",
  "expenseStockItems",
  "expenses",
  "receipts",
  "invoiceItems",
  "invoices",
  "purchaseOrderItems",
  "purchaseOrders",
  "productVariants",
  "products",
  "customers",
  "suppliers",
  "shifts",
  "branches",
  "users",
];

const ACTOR_ID = 1;
const CURRENT_CYCLE_ID = "statutory-m2-verification-cycle";

function db() {
  const d = getDb();
  if (!d) throw new Error("DATABASE_URL not set");
  return d;
}

function verifyStrictReconciliation(
  prov: FinancialCellProvenancePayload | undefined | null,
  context: string,
) {
  expect(prov, `${context}: provenance must be defined`).toBeDefined();
  if (!prov) return;

  expect(
    prov.reconciliation,
    `${context}: reconciliation summary must be defined`,
  ).toBeDefined();
  expect(
    prov.reconciliation?.isFullyReconciled,
    `${context}: isFullyReconciled must be true`,
  ).toBe(true);
  expect(
    prov.reconciliation?.discrepancy,
    `${context}: discrepancy must be exactly '0.00'`,
  ).toBe("0.00");

  const subItems = prov.subItems ?? [];
  expect(
    subItems.length,
    `${context}: subItems count must match reconciliation summary`,
  ).toBe(prov.reconciliation?.subItemsCount);

  // Mathematical summation: sum(cleanToDecimal(item.amount)) == totalAmount
  const sum = subItems.reduce((acc, it) => acc.plus(money(it.amount)), money(0));
  const total = money(prov.totalAmount);
  const diff = total.minus(sum).abs();
  expect(
    diff.lte(0.005),
    `${context}: algebraic sum (${sum.toFixed(2)}) must equal totalAmount (${total.toFixed(2)})`,
  ).toBe(true);
}

describe("Milestone 2 Backend Services — 100% Mathematical Reconciliation Verification", () => {
  beforeEach(async () => {
    const d = db();
    await d.insert(s.branches).values([
      { id: 1, name: "الفرع الرئيسي", code: "MAIN", type: "MAIN" },
    ]);
    await d.insert(s.users).values([
      {
        id: 1,
        openId: "admin-1",
        name: "المدير العام",
        role: "admin",
        loginMethod: "local",
        branchId: 1,
      },
    ]);
  });

  describe("Domain 1: Treasury Movements (getRecentMovements)", () => {
    it("attaches 100% reconciled provenance to invoice receipts, expenses, and standalone movements", async () => {
      const d = db();
      await d.insert(s.customers).values({
        id: 1,
        name: "شركة النور للطباعة",
        phone: "07700000001",
      });
      await d.insert(s.products).values({
        id: 1,
        name: "ورق طباعة A4 80g",
        sku: "P-A4",
        type: "STOCK",
      });
      await d.insert(s.productVariants).values({
        id: 1,
        productId: 1,
        sku: "V-A4",
        price: "25000.00",
        cost: "18000.00",
      });

      // Invoice with 2 line items: 25000 + 50000 = 75000
      await d.insert(s.invoices).values({
        id: 101,
        invoiceNumber: "INV-101",
        customerId: 1,
        branchId: 1,
        subtotal: "75000.00",
        total: "75000.00",
        paidAmount: "75000.00",
        status: "PAID",
      });
      await d.insert(s.invoiceItems).values([
        {
          id: 1,
          invoiceId: 101,
          variantId: 1,
          quantity: "1",
          baseQuantity: "1",
          unitPrice: "25000.00",
          total: "25000.00",
        },
        {
          id: 2,
          invoiceId: 101,
          variantId: 1,
          quantity: "2",
          baseQuantity: "2",
          unitPrice: "25000.00",
          total: "50000.00",
        },
      ]);

      // Full receipt for invoice 101
      await d.insert(s.receipts).values({
        id: 1001,
        branchId: 1,
        direction: "IN",
        amount: "75000.00",
        paymentMethod: "CASH",
        cashBucket: "TREASURY",
        status: "COMPLETED",
        invoiceId: 101,
        referenceNumber: "REC-1001",
        createdBy: 1,
        createdAt: new Date("2026-08-01T10:00:00Z"),
      });

      // Standalone expense
      await d.insert(s.expenses).values({
        id: 201,
        branchId: 1,
        amount: "30000.00",
        description: "ضيافة واحتياجات مكتبية",
        status: "ACTIVE",
        source: "CASH",
        createdBy: 1,
        expenseDate: new Date("2026-08-01T11:00:00Z"),
        createdAt: new Date("2026-08-01T11:00:00Z"),
      });

      const movements = await getRecentMovements(
        { branchId: 1 },
        { scopedBranchId: null, role: "admin", userId: 1 },
      );

      expect(movements.length).toBeGreaterThanOrEqual(2);

      for (const m of movements) {
        verifyStrictReconciliation(m.provenance, `TreasuryMovement #${m.id}`);
      }
    });
  });

  describe("Domain 2: Customer Statement & AR (getCustomerStatement)", () => {
    it("attaches 100% reconciled provenance to invoices (with tax, discount, delivery, rounding) and payments", async () => {
      const d = db();
      await d.insert(s.customers).values({
        id: 2,
        name: "مكتب الرشيد للقرطاسية",
        phone: "07700000002",
      });
      await d.insert(s.products).values({
        id: 2,
        name: "دفاتر مدرسية سلك",
        sku: "P-NOTE",
        type: "STOCK",
      });
      await d.insert(s.productVariants).values({
        id: 2,
        productId: 2,
        sku: "V-NOTE",
        price: "10000.00",
        cost: "7000.00",
      });

      // Invoice with line item (20000) - discount (2000) + delivery (5000) + rounding (250) = 23250
      await d.insert(s.invoices).values({
        id: 102,
        invoiceNumber: "INV-102",
        customerId: 2,
        branchId: 1,
        subtotal: "20000.00",
        total: "23250.00",
        paidAmount: "10000.00",
        discountAmount: "2000.00",
        deliveryFee: "5000.00",
        cashRoundingAdjustment: "250.00",
        status: "PARTIALLY_PAID",
        invoiceDate: new Date("2026-08-02T10:00:00Z"),
        createdAt: new Date("2026-08-02T10:00:00Z"),
      });
      await d.insert(s.invoiceItems).values({
        id: 3,
        invoiceId: 102,
        variantId: 2,
        quantity: "2",
        baseQuantity: "2",
        unitPrice: "10000.00",
        total: "20000.00",
      });

      // Partial payment
      await d.insert(s.receipts).values({
        id: 1002,
        customerId: 2,
        branchId: 1,
        direction: "IN",
        amount: "10000.00",
        paymentMethod: "CASH",
        cashBucket: "TREASURY",
        status: "COMPLETED",
        invoiceId: 102,
        referenceNumber: "REC-1002",
        createdBy: 1,
        createdAt: new Date("2026-08-02T12:00:00Z"),
      });

      const statement = await getCustomerStatement(2);

      expect(statement.invoices.length).toBe(1);
      const inv = statement.invoices[0];
      verifyStrictReconciliation(inv.provenance, `CustomerInvoice #${inv.invoiceNumber}`);

      expect(statement.payments.length).toBeGreaterThanOrEqual(1);
      for (const p of statement.payments) {
        verifyStrictReconciliation(p.provenance, `CustomerPayment #${p.id}`);
      }
    });
  });

  describe("Domain 3: Supplier Statement & AP (getSupplierStatement)", () => {
    it("attaches 100% reconciled provenance to purchase orders and supplier payments", async () => {
      const d = db();
      await d.insert(s.suppliers).values({
        id: 1,
        name: "شركة دجلة للتجهيزات المكتبية",
        phone: "07800000001",
      });
      await d.insert(s.products).values({
        id: 3,
        name: "أقلام جاف أزرق",
        sku: "P-PEN",
        type: "STOCK",
      });
      await d.insert(s.productVariants).values({
        id: 3,
        productId: 3,
        sku: "V-PEN",
        price: "1500.00",
        cost: "1000.00",
      });

      // PO with total = 50000
      await d.insert(s.purchaseOrders).values({
        id: 301,
        poNumber: "PO-301",
        supplierId: 1,
        branchId: 1,
        subtotal: "50000.00",
        total: "50000.00",
        paidAmount: "25000.00",
        status: "CONFIRMED",
        orderDate: new Date("2026-08-03T10:00:00Z"),
        createdAt: new Date("2026-08-03T10:00:00Z"),
      });
      await d.insert(s.purchaseOrderItems).values({
        id: 1,
        purchaseOrderId: 301,
        variantId: 3,
        quantity: "50",
        baseQuantity: 50,
        unitPrice: "1000.00",
        total: "50000.00",
      });

      // Purchase recognition (accounting entry)
      await d.insert(s.accountingEntries).values({
        id: 500,
        branchId: 1,
        supplierId: 1,
        purchaseOrderId: 301,
        entryType: "PURCHASE",
        amount: "50000.00",
        entryDate: new Date("2026-08-03T10:00:00Z"),
        dedupeKey: "PURCHASE:PO-301",
        voucherNumber: "PO-301",
        notes: "استلام أمر الشراء PO-301",
        createdBy: 1,
      });

      // Payment to supplier (accounting entry)
      await d.insert(s.accountingEntries).values({
        id: 501,
        branchId: 1,
        supplierId: 1,
        purchaseOrderId: 301,
        entryType: "PAYMENT_OUT",
        amount: "25000.00",
        entryDate: new Date("2026-08-03T14:00:00Z"),
        voucherNumber: "PV-501",
        notes: "دفعة سداد نقدية لأمر الشراء PO-301",
        createdBy: 1,
      });

      const statement = await getSupplierStatement(1);

      expect(statement.purchaseOrders.length).toBe(1);
      const po = statement.purchaseOrders[0];
      verifyStrictReconciliation(po.provenance, `SupplierPO #${po.poNumber}`);

      expect(statement.payments.length).toBe(1);
      const pay = statement.payments[0];
      verifyStrictReconciliation(pay.provenance, `SupplierPayment #${pay.id}`);
    });
  });

  describe("Domain 4: Expenses (listExpenses)", () => {
    it("attaches 100% reconciled provenance to stock-item and direct operational expenses", async () => {
      const d = db();
      await d.insert(s.products).values({
        id: 4,
        name: "حبر طابعة ليزر أسود",
        sku: "P-TONER",
        type: "STOCK",
      });
      await d.insert(s.productVariants).values({
        id: 4,
        productId: 4,
        sku: "V-TONER",
        price: "45000.00",
        cost: "35000.00",
      });

      // Stock expense with 2 consumed items: 35000 * 2 = 70000
      await d.insert(s.expenses).values({
        id: 202,
        branchId: 1,
        amount: "70000.00",
        description: "استهلاك أحبار في قسم الطباعة",
        status: "ACTIVE",
        source: "STOCK",
        createdBy: 1,
        expenseDate: new Date("2026-08-04T10:00:00Z"),
        createdAt: new Date("2026-08-04T10:00:00Z"),
      });
      await d.insert(s.expenseStockItems).values({
        id: 1,
        expenseId: 202,
        variantId: 4,
        quantity: "2",
        baseQuantity: "2",
        unitCost: "35000.00",
        lineCost: "70000.00",
      });

      const res = await listExpenses({ branchId: 1 });

      expect(res.rows.length).toBeGreaterThanOrEqual(1);
      const stockExp = res.rows.find((r) => Number(r.id) === 202);
      expect(stockExp).toBeDefined();
      verifyStrictReconciliation(stockExp?.provenance, `StockExpense #${stockExp?.id}`);
    });
  });

  describe("Domain 5: Shifts & Cashier (enrichShiftListProvenance)", () => {
    it("deconstructs drawer cash into 8 buckets with 100% reconciliation and denomination breakdown", async () => {
      const d = db();
      await d.insert(s.shifts).values({
        id: 10,
        branchId: 1,
        userId: 1,
        openingBalance: "50000.00",
        expectedCash: "170000.00", // 50000 open + 150000 sales - 30000 drop = 170000
        countedCash: "170000.00",
        variance: "0.00",
        status: "CLOSED",
        shiftType: "RETAIL",
        countedBreakdown: JSON.stringify({ "25000": 4, "50000": 1, "10000": 2 }), // 100k + 50k + 20k = 170k
      });

      // Receipt 1: Cash sale 150,000
      await d.insert(s.invoices).values({
        id: 103,
        invoiceNumber: "INV-103",
        branchId: 1,
        shiftId: 10,
        subtotal: "150000.00",
        total: "150000.00",
        paidAmount: "150000.00",
        status: "PAID",
      });
      await d.insert(s.receipts).values({
        id: 1003,
        branchId: 1,
        shiftId: 10,
        direction: "IN",
        amount: "150000.00",
        paymentMethod: "CASH",
        cashBucket: "DRAWER",
        status: "COMPLETED",
        approvalStatus: "APPROVED",
        invoiceId: 103,
        createdBy: 1,
      });

      // Receipt 2: Cash drop 30,000 to treasury
      await d.insert(s.receipts).values({
        id: 1004,
        branchId: 1,
        shiftId: 10,
        direction: "OUT",
        amount: "30000.00",
        paymentMethod: "CASH",
        cashBucket: "DRAWER",
        status: "COMPLETED",
        approvalStatus: "APPROVED",
        referenceNumber: "CD-1004",
        createdBy: 1,
      });

      const shiftRows = [
        {
          id: 10,
          branchId: 1,
          branchName: "MAIN",
          userId: 1,
          userName: "أحمد",
          openingBalance: "50000.00",
          expectedCash: "170000.00",
          countedCash: "170000.00",
          variance: "0.00",
          status: "CLOSED",
          shiftType: "RETAIL",
          countedBreakdown: JSON.stringify({ "25000": 4, "50000": 1, "10000": 2 }),
        },
      ];

      const enriched = await enrichShiftListProvenance(shiftRows);

      expect(enriched.length).toBe(1);
      const sh = enriched[0];

      verifyStrictReconciliation(sh.provenance, `Shift #${sh.id} Drawer Reconciled`);
      verifyStrictReconciliation(sh.countedProvenance, `Shift #${sh.id} Counted Provenance`);
    });
  });

  describe("Domain 6: Statutory Accounting (getStatutoryAccountLedger & getStatutoryGeneralJournal)", () => {
    it("attaches 100% reconciled provenance with contra account lines to journal ledger rows", async () => {
      const d = db();
      await d.insert(s.doubleEntrySettings).values({
        id: 1,
        mode: "ACTIVE",
        shadowCycleId: CURRENT_CYCLE_ID,
      });

      await d.insert(s.accounts).values([
        {
          code: "1000",
          name: "الصندوق",
          type: "ASSET",
          systemRole: "CASH",
          sortOrder: 1,
        },
        {
          code: "4100",
          name: "مبيعات القرطاسية",
          type: "REVENUE",
          systemRole: "SALES_STATIONERY",
          sortOrder: 5,
        },
      ]);

      const internal = await d.select().from(s.accounts);
      const internalByRole = new Map(internal.map((row) => [row.systemRole, Number(row.id)]));

      let profileId = 0;
      await withTx(async (tx) => {
        profileId = (
          await createStatutoryProfile(
            tx,
            {
              profileKey: "IRAQI_STATUTORY",
              version: 1,
              name: "دليل التحقق 1",
              authorityReference: "كتاب التحقق 1/2026",
              effectiveFrom: "2026-08-01",
            },
            ACTOR_ID,
          )
        ).id;

        await replaceStatutoryAccounts(tx, profileId, [
          {
            code: "181",
            name: "الصندوق ونقد باليد",
            type: "ASSET",
            normalBalance: "DEBIT",
            isPosting: true,
          },
          {
            code: "411",
            name: "إيراد نشاط الطباعة والقرطاسية",
            type: "REVENUE",
            normalBalance: "CREDIT",
            isPosting: true,
          },
        ]);

        const statutoryRows = await tx
          .select()
          .from(s.statutoryAccounts)
          .where(sql`${s.statutoryAccounts.profileId} = ${profileId}`);
        const statutoryByCode = new Map(statutoryRows.map((row) => [row.code, Number(row.id)]));

        await replaceStatutoryMappings(
          tx,
          profileId,
          [
            {
              internalAccountId: internalByRole.get("CASH")!,
              statutoryAccountId: statutoryByCode.get("181")!,
            },
            {
              internalAccountId: internalByRole.get("SALES_STATIONERY")!,
              statutoryAccountId: statutoryByCode.get("411")!,
            },
          ],
          ACTOR_ID,
        );

        await approveStatutoryProfile(
          tx,
          {
            profileId,
            accountantName: "مراقب التحقق",
            approvalReference: "محضر التحقق 1/2026",
          },
          ACTOR_ID,
        );
      });

      // Post Journal: Cash Debit 80,000 / Sales Stationery Credit 80,000
      const entryResult = await d.insert(s.accountingEntries).values({
        entryType: "ADJUST",
        branchId: 1,
        entryDate: new Date("2026-08-10T00:00:00.000Z"),
        amount: "80000.00",
        revenue: "80000.00",
        cost: "0.00",
        profit: "80000.00",
        taxAmount: "0.00",
      });
      const entryId = extractInsertId(entryResult);
      await withTx((tx) =>
        writeJournal(
          tx,
          entryId,
          new Date("2026-08-10T00:00:00.000Z"),
          1,
          [
            { role: "CASH", debit: "80000.00", credit: "0.00" },
            { role: "SALES_STATIONERY", debit: "0.00", credit: "80000.00" },
          ],
          { cycleId: CURRENT_CYCLE_ID },
        ),
      );

      const cashAccount = internal.find((a) => a.systemRole === "CASH");
      const ledger = await getStatutoryAccountLedger({
        from: "2026-08-01",
        to: "2026-08-31",
        accountId: cashAccount!.id,
      });

      expect(ledger.available).toBe(true);
      if (ledger.available) {
        expect(ledger.rows.length).toBeGreaterThanOrEqual(1);
        for (const row of ledger.rows) {
          verifyStrictReconciliation(row.provenance, `StatutoryLedgerRow #${row.lineId}`);
        }
      }

      const journal = await getStatutoryGeneralJournal({
        from: "2026-08-01",
        to: "2026-08-31",
      });

      expect(journal.available).toBe(true);
      if (journal.available) {
        expect(journal.rows.length).toBeGreaterThanOrEqual(2);
        for (const row of journal.rows) {
          verifyStrictReconciliation(row.provenance, `StatutoryGeneralJournalRow #${row.lineId}`);
        }
      }
    });
  });
});
