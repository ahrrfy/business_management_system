import { sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { previewShadowOpening } from "../accounting/shadowOpening";
import {
  createPostingIntent,
  createPostingIntentEvidence,
  creditLine,
  debitLine,
} from "../accounting/postingEngine";
import { money } from "../money";

function db() {
  const value = getDb();
  if (!value) throw new Error("DATABASE_URL not set for tests");
  return value;
}

async function reset() {
  await db().execute(sql`SET FOREIGN_KEY_CHECKS = 0`);
  for (const table of [
    "journalLines",
    "journalEntries",
    "doubleEntrySettings",
    "payrollObligationAllocations",
    "payrollObligations",
    "payrollAccountingEvents",
    "payrollItems",
    "payrollRuns",
    "installmentLines",
    "installmentPlans",
    "assetMaintenance",
    "orderPayments",
    "receptionDrafts",
    "workOrders",
    "employeeAdvances",
    "employees",
    "cashTransfers",
    "deliveryLedgerEntries",
    "deliveryConsignments",
    "invoices",
    "exchangeTransactions",
    "accountingEntries",
    "shifts",
    "receipts",
    "branchStock",
    "productVariants",
    "products",
    "digitalWallets",
    "digitalProviders",
    "exchangeHouses",
    "deliveryParties",
    "fixedAssets",
    "customers",
    "suppliers",
    "users",
    "branches",
  ]) {
    await db().execute(sql.raw(`DELETE FROM \`${table}\``));
  }
  await db().execute(sql`SET FOREIGN_KEY_CHECKS = 1`);
}

async function seedOperationalBalances(
  options: { missingCashBucket?: boolean } = {},
) {
  await db()
    .insert(s.branches)
    .values([
      { id: 1, name: "الرئيسي", code: "MAIN", type: "MAIN" },
      { id: 2, name: "المبيعات", code: "SALES", type: "SALES" },
    ]);
  await db().insert(s.users).values({
    id: 1,
    openId: "opening-admin",
    name: "مدير الافتتاح",
    role: "admin",
    loginMethod: "local",
    branchId: 1,
  });
  await db().insert(s.shifts).values({
    id: 10,
    branchId: 1,
    userId: 1,
    openingBalance: "0.00",
    status: "OPEN",
    shiftType: "RECEPTION",
    openGuard: "1:1:RECEPTION",
  });
  await db()
    .insert(s.customers)
    .values({ id: 1, name: "عميل", currentBalance: "100.00" });
  await db()
    .insert(s.suppliers)
    .values([
      { id: 1, name: "مورد", supplierKind: "REGULAR", currentBalance: "40.00" },
      {
        id: 2,
        name: "مودع",
        supplierKind: "CONSIGNOR",
        currentBalance: "30.00",
      },
      {
        id: 3,
        name: "مزود رقمي",
        supplierKind: "REGULAR",
        currentBalance: "0.00",
      },
    ]);
  await db()
    .insert(s.products)
    .values([
      { id: 1, name: "ملكية", isConsignment: false, isService: false },
      {
        id: 2,
        name: "أمانة",
        isConsignment: true,
        consignorId: 2,
        isService: false,
      },
    ]);
  await db()
    .insert(s.productVariants)
    .values([
      { id: 1, productId: 1, sku: "OWN", costPrice: "10.00" },
      { id: 2, productId: 2, sku: "CON", costPrice: "99.00" },
    ]);
  await db()
    .insert(s.branchStock)
    .values([
      { variantId: 1, branchId: 1, quantity: 3 },
      { variantId: 2, branchId: 1, quantity: 9 },
    ]);
  await db()
    .insert(s.receipts)
    .values([
      {
        branchId: 1,
        shiftId: 10,
        direction: "IN",
        amount: "50.00",
        paymentMethod: "CASH",
        cashBucket: "DRAWER",
        status: "COMPLETED",
        approvalStatus: "APPROVED",
      },
      {
        branchId: 1,
        shiftId: 10,
        direction: "OUT",
        amount: "5.00",
        paymentMethod: "CASH",
        cashBucket: "DRAWER",
        status: "COMPLETED",
        approvalStatus: "APPROVED",
      },
      {
        branchId: 1,
        direction: "IN",
        amount: "20.00",
        paymentMethod: "CASH",
        cashBucket: "TREASURY",
        status: "COMPLETED",
        approvalStatus: "APPROVED",
      },
      {
        branchId: 1,
        direction: "IN",
        amount: "12.00",
        paymentMethod: "CARD",
        status: "COMPLETED",
        approvalStatus: "APPROVED",
      },
      {
        branchId: 2,
        direction: "IN",
        amount: "999.00",
        paymentMethod: "CASH",
        cashBucket: "DRAWER",
        status: "REVERSED",
        approvalStatus: "APPROVED",
      },
      ...(options.missingCashBucket
        ? [
            {
              branchId: 1,
              shiftId: 10,
              direction: "IN" as const,
              amount: "7.00",
              paymentMethod: "CASH" as const,
              cashBucket: null,
              status: "COMPLETED" as const,
              approvalStatus: "APPROVED" as const,
            },
          ]
        : []),
    ]);
  await db().insert(s.deliveryParties).values({
    id: 1,
    name: "مندوب",
    branchId: 1,
    currentBalance: "15.00",
  });
  await db().insert(s.deliveryLedgerEntries).values({
    eventKey: "OPENING-DELIVERY-FLOAT-1",
    partyId: 1,
    branchId: 1,
    entryType: "COD_COLLECTED",
    amount: "15.00",
  });
  await db().insert(s.exchangeHouses).values({
    id: 1,
    name: "صيرفة",
    balanceIqd: "100.00",
    balanceUsd: "2.00",
    balanceUsdCarryingIqd: "3000.00",
    usdCostRate: "1500.0000",
  });
  await db().insert(s.digitalProviders).values({
    id: 1,
    supplierId: 3,
    providerType: "TELECOM",
    settlementMode: "PREPAID",
    recognitionMode: "PRINCIPAL_GROSS",
    referencePolicy: "OPTIONAL",
    settlementCycle: "ON_DEMAND",
    createdBy: 1,
  });
  await db().insert(s.digitalWallets).values({
    id: 1,
    providerId: 1,
    branchId: 1,
    code: "W1",
    name: "محفظة",
    currency: "IQD",
    currentBalance: "25.00",
  });
  await db()
    .insert(s.fixedAssets)
    .values([
      {
        id: 1,
        code: "AST-1",
        name: "آلة",
        category: "printing",
        branchId: 1,
        purchaseDate: "2026-01-01",
        purchaseValue: "1000.00",
        accumulatedDepreciation: "100.00",
        usefulLifeYears: 5,
        status: "active",
      },
      {
        id: 2,
        code: "AST-RETIRED",
        name: "أصل متقاعد",
        category: "devices",
        branchId: 1,
        purchaseDate: "2025-01-01",
        purchaseValue: "9999.00",
        accumulatedDepreciation: "0.00",
        usefulLifeYears: 5,
        status: "retired",
      },
    ]);
}

function roleLine(
  report: Awaited<ReturnType<typeof previewShadowOpening>>,
  role: string,
  branchId: number | null,
) {
  return report.lines.find(
    (line) => line.role === role && line.branchId === branchId,
  );
}

function allocateResidualToCapital(
  report: Awaited<ReturnType<typeof previewShadowOpening>>,
) {
  return report.unallocatedOpeningBalance.scopes.map((scope) => ({
    role: "CAPITAL" as const,
    branchId: scope.branchId,
    debit: scope.debit,
    credit: scope.credit,
  }));
}

beforeEach(reset);

describe("معاينة افتتاح دورة الدفتر المزدوج", () => {
  it("يصدر لشركة نظيفة شهادة افتتاح صفرية قابلة للاعتماد بلا قيد POSTED", async () => {
    const report = await previewShadowOpening({ cycleId: "cycle-empty" });
    expect(report.canApprove).toBe(true);
    expect(report.lines).toEqual([]);
    expect(report.blockers).toEqual([]);
    expect(report.roleTotals).toEqual([]);
    expect(report.branchTotals).toEqual([
      {
        branchId: null,
        debit: "0.00",
        credit: "0.00",
        difference: "0.00",
        isBalanced: true,
      },
    ]);
    expect(report.journalGroups).toEqual([
      {
        branchId: null,
        sourceKey: `SHADOW_OPENING:cycle-empty:${report.asOf}:GLOBAL`,
        lines: [],
        debit: "0.00",
        credit: "0.00",
      },
    ]);
    expect(report.openingHash).toMatch(/^[a-f0-9]{64}$/);
    await expect(
      previewShadowOpening({ cycleId: "cycle-empty" }),
    ).resolves.toMatchObject({ openingHash: report.openingHash });
  });

  it("يقرأ الذمم والمخزون والنقد والمحافظ والأصول بالفلسة ويستبعد بضاعة الأمانة من المخزون", async () => {
    await seedOperationalBalances();
    const report = await previewShadowOpening({ cycleId: "cycle-opening-1" });

    expect(roleLine(report, "AR", null)?.netDebit).toBe("100.00");
    expect(roleLine(report, "AP", null)?.netDebit).toBe("-40.00");
    expect(roleLine(report, "CONSIGNMENT_PAYABLE", null)?.netDebit).toBe(
      "-30.00",
    );
    expect(roleLine(report, "INVENTORY", 1)?.netDebit).toBe("30.00");
    expect(roleLine(report, "CASH", 1)?.netDebit).toBe("45.00");
    expect(roleLine(report, "TREASURY_CASH", 1)?.netDebit).toBe("20.00");
    expect(roleLine(report, "CARD_BANK", 1)?.netDebit).toBe("12.00");
    expect(roleLine(report, "DELIVERY_FLOAT", 1)?.netDebit).toBe("15.00");
    expect(roleLine(report, "EXCHANGE_RECEIVABLE_IQD", null)?.netDebit).toBe(
      "100.00",
    );
    expect(roleLine(report, "EXCHANGE_RECEIVABLE_USD", null)?.netDebit).toBe(
      "3000.00",
    );
    expect(roleLine(report, "EXCHANGE_WALLET_IQD", null)).toBeUndefined();
    expect(roleLine(report, "EXCHANGE_WALLET_USD", null)).toBeUndefined();
    expect(roleLine(report, "DIGITAL_WALLET", 1)?.netDebit).toBe("25.00");
    expect(roleLine(report, "FIXED_ASSETS", 1)?.netDebit).toBe("1000.00");
    expect(roleLine(report, "ACCUMULATED_DEPRECIATION", 1)?.netDebit).toBe(
      "-100.00",
    );
    expect(report.lines.some((line) => line.netDebit === "891.00")).toBe(false);
  });

  it("يحجب الرصيد غير المنسوب ثم يعتمد تخصيصاً يدوياً متوازناً بلا OPENING_EQUITY", async () => {
    await seedOperationalBalances();
    const draft = await previewShadowOpening({ cycleId: "cycle-opening-1" });
    expect(draft.canApprove).toBe(false);
    expect(draft.unallocatedOpeningBalance.scopes).toHaveLength(2);
    expect(draft.blockers).toContainEqual(
      expect.objectContaining({ code: "BALANCE_SHEET_SOURCE_UNCONFIRMED" }),
    );

    const report = await previewShadowOpening({
      cycleId: "cycle-opening-1",
      allocations: allocateResidualToCapital(draft),
    });

    expect(report.canApprove).toBe(true);
    expect(report.totals).toMatchObject({
      difference: "0.00",
      isBalanced: true,
    });
    expect(report.branchTotals.every((row) => row.isBalanced)).toBe(true);
    expect(report.journalGroups).toHaveLength(2);
    expect(report.journalGroups.map((group) => group.sourceKey)).toEqual([
      `SHADOW_OPENING:cycle-opening-1:${report.asOf}:GLOBAL`,
      `SHADOW_OPENING:cycle-opening-1:${report.asOf}:B1`,
    ]);
    expect(report.unallocatedOpeningBalance.scopes).toEqual([]);
    expect(report.manualAllocations).toEqual([
      {
        role: "CAPITAL",
        branchId: null,
        debit: "0.00",
        credit: "3130.00",
      },
      {
        role: "CAPITAL",
        branchId: 1,
        debit: "0.00",
        credit: "1047.00",
      },
    ]);
    expect(report.lines.some((line) => line.role === "OPENING_EQUITY")).toBe(
      false,
    );
  });

  it("يرفض دقة تخصيص غير مالية ويبقي فرق فلس واحد غير معتمد", async () => {
    await seedOperationalBalances();
    const draft = await previewShadowOpening({ cycleId: "cycle-opening-1" });
    await expect(
      previewShadowOpening({
        cycleId: "cycle-opening-1",
        allocations: [
          {
            role: "CAPITAL",
            branchId: null,
            debit: "0.00",
            credit: "1.001",
          },
        ],
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    const short = allocateResidualToCapital(draft).map((allocation) =>
      allocation.branchId == null
        ? { ...allocation, credit: "3129.99" }
        : allocation,
    );
    const report = await previewShadowOpening({
      cycleId: "cycle-opening-1",
      allocations: short,
    });
    expect(report.canApprove).toBe(false);
    expect(report.unallocatedOpeningBalance.scopes).toContainEqual({
      branchId: null,
      netDebit: "-0.01",
      debit: "0.00",
      credit: "0.01",
    });
  });

  it("يبني hash حتمياً من الدورة والتاريخ والأسطر ويتغير عند فلس واحد", async () => {
    await seedOperationalBalances();
    const first = await previewShadowOpening({ cycleId: "cycle-opening-1" });
    const second = await previewShadowOpening({ cycleId: "cycle-opening-1" });
    expect(second.openingHash).toBe(first.openingHash);
    expect(first.openingHash).toMatch(/^[a-f0-9]{64}$/);
    const allocatedCapital = await previewShadowOpening({
      cycleId: "cycle-opening-1",
      allocations: allocateResidualToCapital(first),
    });
    const allocatedRetained = await previewShadowOpening({
      cycleId: "cycle-opening-1",
      allocations: allocateResidualToCapital(first).map((allocation) => ({
        ...allocation,
        role: "RETAINED_EARNINGS" as const,
      })),
    });
    expect(allocatedCapital.openingHash).not.toBe(first.openingHash);
    expect(allocatedRetained.openingHash).not.toBe(
      allocatedCapital.openingHash,
    );

    await db()
      .update(s.customers)
      .set({ currentBalance: "100.01" })
      .where(sql`${s.customers.id} = 1`);
    const changed = await previewShadowOpening({ cycleId: "cycle-opening-1" });
    expect(changed.openingHash).not.toBe(first.openingHash);
    const otherCycle = await previewShadowOpening({
      cycleId: "cycle-opening-2",
    });
    expect(otherCycle.openingHash).not.toBe(changed.openingHash);
  });

  it("يحجب الاعتماد ولا يخمّن دلو إيصال نقدي مفقود", async () => {
    await seedOperationalBalances({ missingCashBucket: true });
    const report = await previewShadowOpening({ cycleId: "cycle-opening-1" });
    expect(report.canApprove).toBe(false);
    expect(report.blockers).toContainEqual(
      expect.objectContaining({
        code: "CASH_BUCKET_MISSING",
        count: 1,
        amount: "7.00",
      }),
    );
    expect(roleLine(report, "CASH", 1)?.netDebit).toBe("45.00");
  });

  it("يحسب الوردية المفتوحة فقط ويستبعد درج وردية مغلقة حتى مع فرق تاريخي", async () => {
    await seedOperationalBalances();
    await db().insert(s.shifts).values({
      id: 1,
      branchId: 1,
      userId: 1,
      openingBalance: "100.00",
      status: "OPEN",
      shiftType: "RETAIL",
      openGuard: "1:1:RETAIL",
    });
    await db().insert(s.receipts).values({
      branchId: 1,
      direction: "OUT",
      amount: "100.00",
      paymentMethod: "CASH",
      cashBucket: "TREASURY",
      status: "COMPLETED",
      approvalStatus: "APPROVED",
    });

    const open = await previewShadowOpening({ cycleId: "cycle-opening-1" });
    expect(roleLine(open, "CASH", 1)?.netDebit).toBe("145.00");

    await db()
      .update(s.shifts)
      .set({ status: "CLOSED", openGuard: null })
      .where(sql`${s.shifts.id} = 1`);
    await db()
      .insert(s.receipts)
      .values([
        {
          branchId: 1,
          shiftId: 1,
          direction: "OUT",
          amount: "140.00",
          paymentMethod: "CASH",
          cashBucket: "DRAWER",
          status: "COMPLETED",
          approvalStatus: "APPROVED",
        },
        {
          branchId: 1,
          direction: "IN",
          amount: "140.00",
          paymentMethod: "CASH",
          cashBucket: "TREASURY",
          status: "COMPLETED",
          approvalStatus: "APPROVED",
        },
      ]);
    const closed = await previewShadowOpening({ cycleId: "cycle-opening-1" });
    expect(roleLine(closed, "CASH", 1)?.netDebit).toBe("45.00");
  });

  it("يصافي إيصال DRAWER/CARD المعكوس مع التعويضي عبر كل حالات الإيصال", async () => {
    await seedOperationalBalances();
    await db()
      .insert(s.receipts)
      .values([
        {
          branchId: 1,
          shiftId: 10,
          direction: "IN",
          amount: "20.00",
          paymentMethod: "CASH",
          cashBucket: "DRAWER",
          status: "REVERSED",
          approvalStatus: "APPROVED",
        },
        {
          branchId: 1,
          shiftId: 10,
          direction: "OUT",
          amount: "20.00",
          paymentMethod: "CASH",
          cashBucket: "DRAWER",
          status: "COMPLETED",
          approvalStatus: "APPROVED",
        },
        {
          branchId: 1,
          direction: "IN",
          amount: "30.00",
          paymentMethod: "CARD",
          status: "REVERSED",
          approvalStatus: "APPROVED",
        },
        {
          branchId: 1,
          direction: "OUT",
          amount: "30.00",
          paymentMethod: "CARD",
          status: "COMPLETED",
          approvalStatus: "APPROVED",
        },
        {
          branchId: 1,
          direction: "IN",
          amount: "40.00",
          paymentMethod: "CASH",
          cashBucket: "TREASURY",
          status: "REVERSED",
          approvalStatus: "APPROVED",
        },
        {
          branchId: 1,
          direction: "OUT",
          amount: "40.00",
          paymentMethod: "CASH",
          cashBucket: "TREASURY",
          status: "COMPLETED",
          approvalStatus: "APPROVED",
        },
      ]);

    const report = await previewShadowOpening({ cycleId: "cycle-opening-1" });
    expect(roleLine(report, "CASH", 1)?.netDebit).toBe("45.00");
    expect(roleLine(report, "TREASURY_CASH", 1)?.netDebit).toBe("20.00");
    expect(roleLine(report, "CARD_BANK", 1)?.netDebit).toBe("12.00");
  });

  it("يفصل الشيكات ومحفظة الدفع ورصيد الاتصالات عن البنك والمحفظة الرقمية التشغيلية", async () => {
    await seedOperationalBalances();
    const [originalCheck] = await db()
      .insert(s.receipts)
      .values({
        branchId: 1,
        direction: "IN",
        amount: "19.00",
        paymentMethod: "CHECK",
        checkNumber: "CHK-IN-19",
        status: "COMPLETED",
        approvalStatus: "APPROVED",
      })
      .$returningId();
    await db().insert(s.installmentPlans).values({
      id: 1,
      customerId: 1,
      branchId: 1,
      totalAmount: "19.00",
      createdBy: 1,
    });
    await db().insert(s.installmentLines).values({
      id: 91,
      planId: 1,
      seq: 1,
      dueDate: "2026-08-15",
      amount: "19.00",
      kind: "CHECK",
      status: "BOUNCED",
      receiptId: Number(originalCheck.id),
    });
    await db()
      .insert(s.receipts)
      .values([
        {
          branchId: 1,
          direction: "IN",
          amount: "11.00",
          paymentMethod: "CHECK",
          status: "REVERSED",
          approvalStatus: "APPROVED",
        },
        {
          branchId: 1,
          direction: "OUT",
          amount: "7.00",
          paymentMethod: "CHECK",
          checkNumber: "CHK-ISSUED-7",
          referenceNumber: "SUPPLIER-CHECK-7",
          status: "COMPLETED",
          approvalStatus: "APPROVED",
        },
        {
          branchId: 1,
          direction: "OUT",
          amount: "19.00",
          paymentMethod: "CHECK",
          referenceNumber: "BOUNCE-CHK-91",
          status: "COMPLETED",
          approvalStatus: "APPROVED",
        },
        {
          branchId: 1,
          direction: "IN",
          amount: "13.00",
          paymentMethod: "WALLET",
          status: "COMPLETED",
          approvalStatus: "APPROVED",
        },
        {
          branchId: 1,
          direction: "IN",
          amount: "17.00",
          paymentMethod: "TELECOM",
          status: "COMPLETED",
          approvalStatus: "APPROVED",
        },
        {
          branchId: 1,
          direction: "IN",
          amount: "999.00",
          paymentMethod: "CARD",
          status: "COMPLETED",
          approvalStatus: "PENDING_APPROVAL",
        },
      ]);

    const report = await previewShadowOpening({ cycleId: "cycle-opening-1" });
    expect(roleLine(report, "CARD_BANK", 1)?.netDebit).toBe("5.00");
    expect(roleLine(report, "CHECKS_RECEIVABLE", 1)?.netDebit).toBe("11.00");
    expect(roleLine(report, "PAYMENT_WALLET", 1)?.netDebit).toBe("13.00");
    expect(roleLine(report, "TELECOM_BALANCE", 1)?.netDebit).toBe("17.00");
    expect(roleLine(report, "DIGITAL_WALLET", 1)?.netDebit).toBe("25.00");
  });

  it("يحجب ادعاء ارتداد شيك بلا قسط وأصل مطابقين ولا يخمّن حسابه", async () => {
    await seedOperationalBalances();
    await db().insert(s.receipts).values({
      branchId: 1,
      direction: "OUT",
      amount: "23.00",
      paymentMethod: "CHECK",
      referenceNumber: "BOUNCE-CHK-404",
      status: "COMPLETED",
      approvalStatus: "APPROVED",
    });
    const report = await previewShadowOpening({ cycleId: "cycle-opening-1" });
    expect(report.blockers).toContainEqual(
      expect.objectContaining({
        code: "CHECK_SOURCE_AMBIGUOUS",
        amount: "23.00",
      }),
    );
    expect(roleLine(report, "CHECKS_RECEIVABLE", 1)).toBeUndefined();
  });

  it("يستبعد عهدة التوصيل المدعومة بذمة عميل ويضيف صافي أجرة SHOP المستحقة", async () => {
    await seedOperationalBalances();
    await db().insert(s.invoices).values({
      id: 1,
      invoiceNumber: "INV-DELIVERY-1",
      sourceType: "POS",
      branchId: 1,
      customerId: 1,
      subtotal: "40.00",
      total: "40.00",
      status: "CONFIRMED",
    });
    await db().insert(s.deliveryConsignments).values({
      id: 1,
      consignmentNumber: "CN-TEST-1",
      branchId: 1,
      partyId: 1,
      invoiceId: 1,
      sourceType: "INVOICE",
      sourceId: 1,
      codAmount: "40.00",
      feeCollection: "SHOP",
    });
    await db()
      .insert(s.deliveryLedgerEntries)
      .values([
        {
          eventKey: "DELIVERY-CUSTOMER-BACKED-1",
          partyId: 1,
          consignmentId: 1,
          branchId: 1,
          entryType: "COD_COLLECTED",
          amount: "40.00",
        },
        {
          eventKey: "DELIVERY-SHOP-EARNED-1",
          partyId: 1,
          consignmentId: 1,
          branchId: 1,
          entryType: "FEE_EARNED",
          amount: "30.00",
        },
        {
          eventKey: "DELIVERY-SHOP-PAID-1",
          partyId: 1,
          consignmentId: 1,
          branchId: 1,
          entryType: "FEE_PAID",
          amount: "10.00",
        },
      ]);

    const report = await previewShadowOpening({ cycleId: "cycle-opening-1" });
    expect(roleLine(report, "DELIVERY_FLOAT", 1)?.netDebit).toBe("15.00");
    expect(roleLine(report, "COURIER_PAYABLE", 1)?.netDebit).toBe("-20.00");
  });

  it("يحجب صافي أجرة SHOP السالب ولا يحوّله إلى أصل", async () => {
    await seedOperationalBalances();
    await db().insert(s.invoices).values({
      id: 1,
      invoiceNumber: "INV-DELIVERY-NEG",
      sourceType: "POS",
      branchId: 1,
      subtotal: "0.00",
      total: "0.00",
      status: "CONFIRMED",
    });
    await db().insert(s.deliveryConsignments).values({
      id: 1,
      consignmentNumber: "CN-TEST-NEG",
      branchId: 1,
      partyId: 1,
      invoiceId: 1,
      sourceType: "INVOICE",
      sourceId: 1,
      codAmount: "0.00",
      feeCollection: "SHOP",
    });
    await db().insert(s.deliveryLedgerEntries).values({
      eventKey: "DELIVERY-SHOP-NEG",
      partyId: 1,
      consignmentId: 1,
      branchId: 1,
      entryType: "FEE_PAID",
      amount: "5.00",
    });

    const report = await previewShadowOpening({ cycleId: "cycle-opening-1" });
    expect(roleLine(report, "COURIER_PAYABLE", 1)).toBeUndefined();
    expect(report.blockers).toContainEqual(
      expect.objectContaining({
        code: "COURIER_PAYABLE_NEGATIVE",
        source: "deliveryLedgerEntries.SHOP_FEE:1",
        amount: "5.00",
      }),
    );
  });

  it("يرحّل صافي أمانة أجرة المندوب كالتزام: قبض موجب ناقص صرف/رد", async () => {
    await seedOperationalBalances();
    await db()
      .insert(s.accountingEntries)
      .values([
        {
          entryType: "DELIVERY_FEE_HELD",
          branchId: 1,
          revenue: "0.00",
          cost: "0.00",
          profit: "0.00",
          amount: "100.00",
          entryDate: new Date(),
        },
        {
          entryType: "DELIVERY_FEE_HELD",
          branchId: 1,
          revenue: "0.00",
          cost: "0.00",
          profit: "0.00",
          amount: "-40.00",
          entryDate: new Date(),
        },
      ]);
    const report = await previewShadowOpening({ cycleId: "cycle-opening-1" });
    expect(roleLine(report, "COURIER_PAYABLE", 1)).toMatchObject({
      netDebit: "-60.00",
      debit: "0.00",
      credit: "60.00",
    });
  });

  it("يحجب صافي أمانة مندوب سالباً ولا يختلق له أصلاً مديناً", async () => {
    await seedOperationalBalances();
    await db().insert(s.accountingEntries).values({
      entryType: "DELIVERY_FEE_HELD",
      branchId: 1,
      revenue: "0.00",
      cost: "0.00",
      profit: "0.00",
      amount: "-5.00",
      entryDate: new Date(),
    });

    const report = await previewShadowOpening({ cycleId: "cycle-opening-1" });
    expect(roleLine(report, "COURIER_PAYABLE", 1)).toBeUndefined();
    expect(report.blockers).toContainEqual(
      expect.objectContaining({
        code: "COURIER_PAYABLE_NEGATIVE",
        amount: "5.00",
      }),
    );
  });

  it("يقيّم النقد الأجنبي بالكلفة الدفترية من حركات USD النافذة ويستبعد المعكوس", async () => {
    await seedOperationalBalances();
    await db()
      .insert(s.exchangeTransactions)
      .values([
        {
          txnNumber: "EX-FX-BUY-1",
          exchangeHouseId: 1,
          branchId: 1,
          type: "FX_BUY",
          currency: "USD",
          usdAmount: "100.00",
          iqdAmount: "150000.00",
          exchangeRate: "1500.0000",
          status: "ACTIVE",
        },
        {
          txnNumber: "EX-DEPOSIT-USD-1",
          exchangeHouseId: 1,
          branchId: 1,
          type: "DEPOSIT",
          currency: "USD",
          usdAmount: "40.00",
          iqdAmount: "60000.00",
          exchangeRate: "1500.0000",
          status: "ACTIVE",
        },
        {
          txnNumber: "EX-WITHDRAW-USD-1",
          exchangeHouseId: 1,
          branchId: 1,
          type: "WITHDRAW",
          currency: "USD",
          usdAmount: "10.00",
          iqdAmount: "15000.00",
          exchangeRate: "1500.0000",
          status: "ACTIVE",
        },
        {
          txnNumber: "EX-REVERSED-USD-1",
          exchangeHouseId: 1,
          branchId: 1,
          type: "FX_BUY",
          currency: "USD",
          usdAmount: "999.00",
          exchangeRate: "1500.0000",
          status: "REVERSED",
        },
      ]);

    const report = await previewShadowOpening({ cycleId: "cycle-opening-1" });
    expect(roleLine(report, "FOREIGN_CASH_USD", 1)).toMatchObject({
      netDebit: "105000.00",
      debit: "105000.00",
      credit: "0.00",
    });
  });

  it("يحجب مصدر النقد الأجنبي الناقص أو الذي ينتج كمية أو قيمة سالبة", async () => {
    await seedOperationalBalances();
    await db().insert(s.exchangeTransactions).values({
      txnNumber: "EX-DEPOSIT-USD-NEG",
      exchangeHouseId: 1,
      branchId: 1,
      type: "DEPOSIT",
      currency: "USD",
      usdAmount: "10.00",
      iqdAmount: "15000.00",
      exchangeRate: "1500.0000",
      status: "ACTIVE",
    });

    const report = await previewShadowOpening({ cycleId: "cycle-opening-1" });
    expect(roleLine(report, "FOREIGN_CASH_USD", 1)).toBeUndefined();
    expect(report.blockers).toContainEqual(
      expect.objectContaining({ code: "FOREIGN_CASH_SOURCE_INVALID" }),
    );
  });

  it("يشتق السلف والنقد قيد الطريق والعرابين والضريبة ورأس المال من مصادرها الحاكمة", async () => {
    await seedOperationalBalances();
    await db().insert(s.employees).values({
      id: 1,
      branchId: 1,
      firstName: "محاسب",
      lastName: "الاختبار",
    });
    await db().insert(s.employeeAdvances).values({
      id: 1,
      employeeId: 1,
      branchId: 1,
      amount: "50.00",
      remaining: "35.00",
      status: "ACTIVE",
      createdBy: 1,
    });
    await db()
      .insert(s.cashTransfers)
      .values([
        {
          id: 1,
          transferNumber: "CT-TEST-1",
          fromBranchId: 1,
          toBranchId: 2,
          amount: "25.00",
          status: "IN_TRANSIT",
          sentBy: 1,
        },
        {
          id: 2,
          transferNumber: "CT-TEST-2",
          fromBranchId: 1,
          toBranchId: 2,
          amount: "40.00",
          status: "RECEIVED",
          sentBy: 1,
          receivedBy: 1,
          receivedAt: new Date(),
        },
      ]);
    await db().insert(s.workOrders).values({
      id: 1,
      orderNumber: "WO-TEST-1",
      branchId: 1,
      title: "طلب اختبار",
      materialsCost: "21.00",
      deposit: "18.00",
      status: "IN_PROGRESS",
      createdBy: 1,
    });
    await db().insert(s.receptionDrafts).values({
      id: 1,
      draftNumber: "DRF-TEST-1",
      branchId: 1,
      status: "OPEN",
      commitRequestId: "00000000-0000-0000-0000-000000000001",
      createdBy: 1,
    });
    await db()
      .insert(s.orderPayments)
      .values([
        {
          draftId: 1,
          branchId: 1,
          kind: "COLLECTION",
          amount: "9.00",
          method: "CASH",
          status: "HELD",
          createdBy: 1,
        },
        {
          draftId: 1,
          branchId: 1,
          kind: "REFUND",
          amount: "2.00",
          method: "CASH",
          createdBy: 1,
        },
      ]);
    await db()
      .insert(s.accountingEntries)
      .values([
        {
          entryType: "SALE",
          branchId: 1,
          revenue: "100.00",
          cost: "0.00",
          profit: "100.00",
          taxAmount: "10.00",
          amount: "110.00",
          entryDate: new Date(),
        },
        {
          entryType: "TREASURY_FUNDING",
          branchId: 1,
          revenue: "0.00",
          cost: "0.00",
          profit: "0.00",
          amount: "200.00",
          entryDate: new Date(),
        },
      ]);

    const report = await previewShadowOpening({ cycleId: "cycle-opening-1" });
    expect(roleLine(report, "EMPLOYEE_ADVANCES", 1)?.netDebit).toBe("35.00");
    expect(roleLine(report, "CASH_IN_TRANSIT", 1)?.netDebit).toBe("25.00");
    expect(roleLine(report, "CASH_IN_TRANSIT", null)).toBeUndefined();
    expect(roleLine(report, "INTERBRANCH_CLEARING", 1)?.netDebit).toBe("40.00");
    expect(roleLine(report, "INTERBRANCH_CLEARING", 2)?.netDebit).toBe(
      "-40.00",
    );
    expect(
      report.lines
        .filter((line) => line.role === "INTERBRANCH_CLEARING")
        .reduce((sum, line) => sum.plus(money(line.netDebit)), money(0))
        .isZero(),
    ).toBe(true);
    expect(roleLine(report, "WORK_IN_PROGRESS", 1)?.netDebit).toBe("21.00");
    expect(roleLine(report, "OTHER_LIABILITY", 1)?.netDebit).toBe("-25.00");
    expect(roleLine(report, "TAX_PAYABLE", 1)?.netDebit).toBe("-10.00");
    expect(roleLine(report, "CAPITAL", 1)?.netDebit).toBe("-200.00");
  });

  it("يشتق التزامات الرواتب من remaining بالفرع المثبت ويترك القانوني مفتوحاً بعد تسوية الراتب", async () => {
    await seedOperationalBalances();
    await db().insert(s.employees).values({
      id: 1,
      branchId: 1,
      firstName: "موظف",
      lastName: "منقول",
    });
    await db().insert(s.payrollRuns).values({
      id: 1,
      period: "2026-08",
      status: "approved",
      revisionNo: 1,
      accrualDate: "2026-08-31",
      approvalSnapshotHash: "a".repeat(64),
      totalNet: "70.00",
      totalIncomeTax: "10.00",
      totalSocialSecurityEmployee: "5.00",
      totalSocialSecurityEmployer: "8.00",
      totalEndOfServiceAccrual: "2.00",
      approvedBy: 1,
      approvedAt: new Date(),
    });
    await db().insert(s.payrollItems).values({
      id: 1,
      runId: 1,
      employeeId: 1,
      branchIdSnapshot: 2,
      revisionNo: 1,
      payType: "monthly",
      gross: "100.00",
      net: "70.00",
      snapshotHash: "b".repeat(64),
    });
    await db().insert(s.payrollObligations).values([
      {
        runId: 1,
        itemId: 1,
        employeeId: 1,
        branchIdSnapshot: 2,
        revisionNo: 1,
        kind: "SALARY_NET",
        originalAmount: "70.00",
        remainingAmount: "70.00",
        status: "OPEN",
        sourceType: "PAYROLL_APPROVAL",
        sourceKey: "PAYROLL:1:1:1:SALARY_NET",
      },
      {
        runId: 1,
        itemId: 1,
        employeeId: 1,
        branchIdSnapshot: 2,
        revisionNo: 1,
        kind: "INCOME_TAX",
        originalAmount: "10.00",
        remainingAmount: "4.00",
        status: "PARTIAL",
        sourceType: "PAYROLL_APPROVAL",
        sourceKey: "PAYROLL:1:1:1:INCOME_TAX",
      },
      {
        runId: 1,
        itemId: 1,
        employeeId: 1,
        branchIdSnapshot: 2,
        revisionNo: 1,
        kind: "SOCIAL_SECURITY",
        originalAmount: "13.00",
        remainingAmount: "13.00",
        status: "OPEN",
        sourceType: "PAYROLL_APPROVAL",
        sourceKey: "PAYROLL:1:1:1:SOCIAL_SECURITY",
      },
      {
        runId: 1,
        itemId: 1,
        employeeId: 1,
        branchIdSnapshot: 2,
        revisionNo: 1,
        kind: "EOS_PROVISION",
        originalAmount: "2.00",
        remainingAmount: "2.00",
        status: "OPEN",
        sourceType: "PAYROLL_APPROVAL",
        sourceKey: "PAYROLL:1:1:1:EOS_PROVISION",
      },
    ]);

    const report = await previewShadowOpening({ cycleId: "cycle-opening-1" });
    expect(roleLine(report, "ACCRUED_SALARY", 2)?.netDebit).toBe("-70.00");
    expect(roleLine(report, "PAYROLL_TAX_PAYABLE", 2)?.netDebit).toBe(
      "-4.00",
    );
    expect(roleLine(report, "SOCIAL_SECURITY_PAYABLE", 2)?.netDebit).toBe(
      "-13.00",
    );
    expect(roleLine(report, "EOS_PROVISION", 2)?.netDebit).toBe("-2.00");
    expect(report.blockers).not.toContainEqual(
      expect.objectContaining({ code: "PAYROLL_LEGACY_UNCOVERED" }),
    );

    await db()
      .update(s.payrollObligations)
      .set({ remainingAmount: "0.00", status: "SETTLED" })
      .where(sql`${s.payrollObligations.kind} = 'SALARY_NET'`);
    await db()
      .update(s.payrollRuns)
      .set({ status: "paid" })
      .where(sql`${s.payrollRuns.id} = 1`);
    const paid = await previewShadowOpening({ cycleId: "cycle-opening-1" });
    expect(roleLine(paid, "ACCRUED_SALARY", 2)).toBeUndefined();
    expect(roleLine(paid, "PAYROLL_TAX_PAYABLE", 2)?.netDebit).toBe("-4.00");
  });

  it("يحجب مسيّر legacy معتمداً بلا obligations مستقلة ولا يختلق التزاماً من الإجمالي", async () => {
    await seedOperationalBalances();
    await db().insert(s.payrollRuns).values({
      period: "2026-08",
      status: "approved",
      revisionNo: 0,
      totalNet: "25.00",
      approvedBy: 1,
      approvedAt: new Date(),
    });
    const report = await previewShadowOpening({ cycleId: "cycle-opening-1" });
    expect(roleLine(report, "ACCRUED_SALARY", null)).toBeUndefined();
    expect(report.blockers).toContainEqual(
      expect.objectContaining({
        code: "PAYROLL_LEGACY_UNCOVERED",
        amount: "25.00",
      }),
    );
  });

  it("يثبت ACCRUED_EXPENSES من طلب اقتناء أصل وقيد canonical ويكشف العبث بالبصمة", async () => {
    await seedOperationalBalances();
    await db().insert(s.fixedAssets).values({
      id: 3,
      code: "AST-ACCRUAL-3",
      name: "أصل غير مسدد",
      category: "devices",
      branchId: 1,
      purchaseDate: "2026-08-15",
      purchaseValue: "250.00",
      usefulLifeYears: 5,
      status: "active",
    });
    await db().insert(s.receipts).values({
      id: 300,
      branchId: 1,
      direction: "OUT",
      amount: "250.00",
      paymentMethod: "CASH",
      cashBucket: "TREASURY",
      referenceNumber: "ASSET-ACQ-3",
      status: "PENDING",
      approvalStatus: "PENDING_APPROVAL",
      internalNote:
        '@SYSTEM_PAYMENT_REQUEST:{"kind":"ASSET_ACQUISITION","assetId":3}',
    });
    const components = {
      roleDebits: { FIXED_ASSETS: "250.00" },
      roleCredits: { ACCRUED_EXPENSES: "250.00" },
    } as const;
    const evidence = createPostingIntentEvidence(
      createPostingIntent(
        "ADJUST_FIXED_ASSET_ACCRUAL",
        "ADJUST",
        [
          debitLine("FIXED_ASSETS", "250.00"),
          creditLine("ACCRUED_EXPENSES", "250.00"),
        ],
        components,
      ),
      { amount: "250.00", ...components },
    );
    await db().insert(s.accountingEntries).values({
      entryType: "ADJUST",
      branchId: 1,
      amount: "250.00",
      entryDate: new Date(),
      dedupeKey: "ASSET_ACCRUAL:3",
      ...evidence,
    });

    const report = await previewShadowOpening({ cycleId: "cycle-opening-1" });
    expect(roleLine(report, "ACCRUED_EXPENSES", 1)?.netDebit).toBe("-250.00");
    expect(report.blockers).not.toContainEqual(
      expect.objectContaining({ code: "ACCRUED_EXPENSE_SOURCE_INVALID" }),
    );

    await db()
      .update(s.accountingEntries)
      .set({ postingIntentHash: "0".repeat(64) })
      .where(sql`${s.accountingEntries.dedupeKey} = 'ASSET_ACCRUAL:3'`);
    const tampered = await previewShadowOpening({
      cycleId: "cycle-opening-1",
    });
    expect(roleLine(tampered, "ACCRUED_EXPENSES", 1)).toBeUndefined();
    expect(tampered.blockers).toContainEqual(
      expect.objectContaining({ code: "ACCRUED_EXPENSE_SOURCE_INVALID" }),
    );
  });

  it("يرفض دورة مفقودة ولا يسمح بإعادة استعمال hash خارج دورة الظل", async () => {
    await seedOperationalBalances();
    await expect(previewShadowOpening()).rejects.toMatchObject({
      code: "PRECONDITION_FAILED",
    });
  });
});
