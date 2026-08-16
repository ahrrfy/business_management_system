import { sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { reconcileDoubleEntryOperational } from "../accounting/doubleEntryOperationalReconcile";
import { POSTING_POLICY_HASH } from "../accounting/postingEngine";
import {
  previewShadowOpening,
  type ShadowOpeningPreview,
  verifyStoredShadowOpening,
} from "../accounting/shadowOpening";
import { buyUsdAtExchange } from "../exchange/buyUsd";
import { createExchangeHouse } from "../exchange/crud";

function db() {
  const value = getDb();
  if (!value) throw new Error("DATABASE_URL not set for tests");
  return value;
}

async function reset() {
  nextJournalId = 100;
  await db().execute(sql`SET FOREIGN_KEY_CHECKS = 0`);
  for (const table of [
    "journalLines",
    "journalEntries",
    "doubleEntrySettings",
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

let nextJournalId = 100;

async function seedSimpleOperationalState() {
  await db()
    .insert(s.branches)
    .values([
      { id: 1, name: "الرئيسي", code: "MAIN", type: "MAIN" },
      { id: 2, name: "المبيعات", code: "SALES", type: "SALES" },
    ]);
  await db().insert(s.users).values({
    id: 1,
    openId: "reconcile-admin",
    name: "مدير المطابقة",
    role: "admin",
    loginMethod: "local",
    branchId: 1,
  });
  await db().insert(s.shifts).values({
    id: 1,
    branchId: 1,
    userId: 1,
    openingBalance: "0.00",
    status: "OPEN",
    shiftType: "RETAIL",
    openGuard: "1:1:RETAIL",
  });
  await db()
    .insert(s.customers)
    .values({ id: 1, name: "عميل", currentBalance: "100.00" });
  await db()
    .insert(s.products)
    .values({ id: 1, name: "صنف", isConsignment: false, isService: false });
  await db().insert(s.productVariants).values({
    id: 1,
    productId: 1,
    sku: "REC-1",
    costPrice: "10.00",
  });
  await db()
    .insert(s.branchStock)
    .values({ variantId: 1, branchId: 1, quantity: 3 });
  await db().insert(s.receipts).values({
    branchId: 1,
    shiftId: 1,
    direction: "IN",
    amount: "50.00",
    paymentMethod: "CASH",
    cashBucket: "DRAWER",
    status: "COMPLETED",
    approvalStatus: "APPROVED",
  });
}

async function approvedOpening(cycleId: string) {
  const draft = await previewShadowOpening({ cycleId });
  return previewShadowOpening({
    cycleId,
    allocations: draft.unallocatedOpeningBalance.scopes.map((scope) => ({
      role: "CAPITAL" as const,
      branchId: scope.branchId,
      debit: scope.debit,
      credit: scope.credit,
    })),
  });
}

async function writeOpening(
  report: ShadowOpeningPreview,
  cycleId = report.cycleId,
) {
  for (const group of report.journalGroups) {
    const id = nextJournalId++;
    const inserted = await db()
      .insert(s.journalEntries)
      .values({
        id,
        entryId: null,
        sourceType: "SHADOW_OPENING",
        sourceKey: group.sourceKey.replace(report.cycleId, cycleId),
        postingProfile: "SHADOW_OPENING_V1",
        cycleId,
        entryDate: new Date(`${report.asOf}T00:00:00.000Z`),
        branchId: group.branchId,
        status: group.lines.length === 0 ? "MEMO" : "POSTED",
      });
    void inserted;
    if (group.lines.length > 0) {
      await db()
        .insert(s.journalLines)
        .values(
          group.lines.map((line) => ({
            journalId: id,
            role: line.role,
            debit: line.debit,
            credit: line.credit,
          })),
        );
    }
  }
}

beforeEach(reset);

describe("مطابقة الدفتر المزدوج مع الأرصدة التشغيلية", () => {
  it("يعتمد شهادة افتتاح صفرية MEMO واحدة مرتبطة بالبصمة بلا أسطر", async () => {
    const opening = await previewShadowOpening({ cycleId: "cycle-zero" });
    await writeOpening(opening);

    const stored = await verifyStoredShadowOpening({
      cycleId: "cycle-zero",
      expectedHash: opening.openingHash,
      db: db(),
    });
    const reconciliation = await reconcileDoubleEntryOperational({
      cycleId: "cycle-zero",
    });

    expect(opening).toMatchObject({
      canApprove: true,
      lines: [],
      blockers: [],
    });
    expect(stored).toMatchObject({
      exists: true,
      hashMatches: true,
      balanced: true,
      sourceKeysValid: true,
      postingProfilesValid: true,
      openingHash: opening.openingHash,
      entryCount: 1,
      lineCount: 0,
    });
    expect(reconciliation).toMatchObject({
      ok: true,
      driftCount: 0,
      totalAbsoluteDifference: "0.00",
    });
  });

  it("يرفض العبث بالشهادة الصفرية: POSTED بلا أسطر أو MEMO يحمل سطراً", async () => {
    const opening = await previewShadowOpening({
      cycleId: "cycle-zero-tamper",
    });
    await writeOpening(opening);

    await db()
      .update(s.journalEntries)
      .set({ status: "POSTED" })
      .where(sql`${s.journalEntries.cycleId} = 'cycle-zero-tamper'`);
    const postedWithoutLines = await verifyStoredShadowOpening({
      cycleId: "cycle-zero-tamper",
      expectedHash: opening.openingHash,
      db: db(),
    });
    expect(postedWithoutLines).toMatchObject({
      hashMatches: false,
      balanced: false,
      postingProfilesValid: false,
      lineCount: 0,
    });

    await db()
      .update(s.journalEntries)
      .set({ status: "MEMO" })
      .where(sql`${s.journalEntries.cycleId} = 'cycle-zero-tamper'`);
    await db().insert(s.journalLines).values({
      journalId: 100,
      role: "CASH",
      debit: "0.01",
      credit: "0.00",
    });
    const memoWithLine = await verifyStoredShadowOpening({
      cycleId: "cycle-zero-tamper",
      expectedHash: opening.openingHash,
      db: db(),
    });
    expect(memoWithLine).toMatchObject({
      hashMatches: false,
      balanced: false,
      postingProfilesValid: false,
      lineCount: 1,
    });
  });

  it("يطابق الافتتاح المنشور عالمياً ولكل فرع بالفلس الصارم", async () => {
    await seedSimpleOperationalState();
    const opening = await approvedOpening("cycle-reconcile-1");
    await writeOpening(opening);

    const report = await reconcileDoubleEntryOperational({
      cycleId: "cycle-reconcile-1",
    });
    const stored = await verifyStoredShadowOpening({
      cycleId: "cycle-reconcile-1",
      expectedHash: opening.openingHash,
      db: db(),
    });
    expect(report.ok).toBe(true);
    expect(
      opening.manualAllocations.every((row) => row.role === "CAPITAL"),
    ).toBe(true);
    expect(report.globalRows.some((row) => row.role === "CAPITAL")).toBe(false);
    expect(stored.asOf).toBe(opening.asOf);
    expect(stored.openingHash).toBe(opening.openingHash);
    expect(stored).toMatchObject({
      exists: true,
      hashMatches: true,
      balanced: true,
      sourceKeysValid: true,
      postingProfilesValid: true,
    });
    expect(report.driftCount).toBe(0);
    expect(report.totalAbsoluteDifference).toBe("0.00");
    expect(report.journalIntegrity).toMatchObject({
      difference: "0.00",
      isBalanced: true,
    });
    expect(report.globalRows.find((row) => row.role === "AR")).toMatchObject({
      operationalNetDebit: "100.00",
      journalNetDebit: "100.00",
      matches: true,
    });
    expect(
      report.branchRows.find(
        (row) => row.role === "INVENTORY" && row.branchId === 1,
      ),
    ).toMatchObject({
      operationalNetDebit: "30.00",
      journalNetDebit: "30.00",
      matches: true,
    });
    expect(
      report.branchRows.find(
        (row) => row.role === "CASH" && row.branchId === 1,
      ),
    ).toMatchObject({
      operationalNetDebit: "50.00",
      journalNetDebit: "50.00",
      matches: true,
    });
  });

  it("يكشف انحراف فلس واحد باتجاه journal−operational", async () => {
    await seedSimpleOperationalState();
    const opening = await approvedOpening("cycle-reconcile-1");
    await writeOpening(opening);
    await db()
      .update(s.customers)
      .set({ currentBalance: "100.01" })
      .where(sql`${s.customers.id} = 1`);

    const report = await reconcileDoubleEntryOperational({
      cycleId: "cycle-reconcile-1",
    });
    expect(report.ok).toBe(false);
    expect(report.driftCount).toBe(1);
    expect(report.totalAbsoluteDifference).toBe("0.01");
    expect(report.globalRows.find((row) => row.role === "AR")).toMatchObject({
      operationalNetDebit: "100.01",
      journalNetDebit: "100.00",
      difference: "-0.01",
      matches: false,
    });
  });

  it("يعزل دورات الظل ولا يضاعف قيود دورة قديمة بعد الإيقاف وإعادة البدء", async () => {
    await seedSimpleOperationalState();
    const oldOpening = await approvedOpening("cycle-old");
    await writeOpening(oldOpening, "cycle-old");
    const newOpening = await approvedOpening("cycle-new");
    await writeOpening(newOpening, "cycle-new");

    const current = await reconcileDoubleEntryOperational({
      cycleId: "cycle-new",
    });
    expect(current.ok).toBe(true);
    expect(
      current.globalRows.find((row) => row.role === "AR")?.journalNetDebit,
    ).toBe("100.00");
  });

  it("لا يضاعف انحراف الدور الفرعي في الإجمالي العالمي والحكم الرسمي", async () => {
    await seedSimpleOperationalState();
    const opening = await approvedOpening("cycle-branch-drift");
    await writeOpening(opening);
    await db()
      .update(s.branchStock)
      .set({ quantity: 4 })
      .where(
        sql`${s.branchStock.branchId} = 1 AND ${s.branchStock.variantId} = 1`,
      );

    const report = await reconcileDoubleEntryOperational({
      cycleId: "cycle-branch-drift",
    });
    expect(report.driftCount).toBe(1);
    expect(report.totalAbsoluteDifference).toBe("10.00");
    expect(
      report.globalRows.find((row) => row.role === "INVENTORY"),
    ).toMatchObject({ difference: "-10.00", matches: false });
    expect(
      report.rows.filter((row) => row.role === "INVENTORY" && !row.matches),
    ).toEqual([
      expect.objectContaining({
        scope: "BRANCH",
        branchId: 1,
        difference: "-10.00",
      }),
    ]);
  });

  it("يعزل النقد قيد الطريق والمقاصة بالفروع ويُصافر المقاصة على مستوى الشركة", async () => {
    await seedSimpleOperationalState();
    await db().insert(s.cashTransfers).values({
      id: 1,
      transferNumber: "CT-RECONCILE-1",
      fromBranchId: 1,
      toBranchId: 2,
      amount: "25.00",
      status: "IN_TRANSIT",
      sentBy: 1,
    });
    const opening = await approvedOpening("cycle-transit");
    expect(
      opening.lines.find((line) => line.role === "CASH_IN_TRANSIT"),
    ).toMatchObject({ branchId: 1, netDebit: "25.00" });
    await writeOpening(opening);

    const inTransit = await reconcileDoubleEntryOperational({
      cycleId: "cycle-transit",
    });
    expect(inTransit.ok).toBe(true);
    expect(
      inTransit.branchRows.find(
        (row) => row.role === "CASH_IN_TRANSIT" && row.branchId === 1,
      ),
    ).toMatchObject({ operationalNetDebit: "25.00", matches: true });

    await db()
      .update(s.cashTransfers)
      .set({ status: "RECEIVED", receivedBy: 1, receivedAt: new Date() })
      .where(sql`${s.cashTransfers.id} = 1`);
    const received = await reconcileDoubleEntryOperational({
      cycleId: "cycle-transit",
    });
    expect(received.driftCount).toBe(3);
    expect(received.totalAbsoluteDifference).toBe("75.00");
    expect(
      received.rows.filter(
        (row) =>
          !row.matches &&
          ["CASH_IN_TRANSIT", "INTERBRANCH_CLEARING"].includes(row.role),
      ),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          scope: "BRANCH",
          branchId: 1,
          role: "CASH_IN_TRANSIT",
          difference: "25.00",
        }),
        expect.objectContaining({
          scope: "BRANCH",
          branchId: 1,
          role: "INTERBRANCH_CLEARING",
          difference: "-25.00",
        }),
        expect.objectContaining({
          scope: "BRANCH",
          branchId: 2,
          role: "INTERBRANCH_CLEARING",
          difference: "25.00",
        }),
      ]),
    );
    expect(
      received.globalRows.find((row) => row.role === "INTERBRANCH_CLEARING"),
    ).toMatchObject({
      operationalNetDebit: "0.00",
      journalNetDebit: "0.00",
      difference: "0.00",
      matches: true,
    });
  });

  it("يكشف فساد توازن يومية منشورة ولا يخفيه داخل فروق الأدوار", async () => {
    await seedSimpleOperationalState();
    const opening = await approvedOpening("cycle-reconcile-1");
    await writeOpening(opening);
    await db()
      .insert(s.journalEntries)
      .values({
        id: 999,
        sourceType: "SHADOW_OPENING",
        sourceKey: "SHADOW_OPENING:cycle-reconcile-1:corrupt",
        cycleId: "cycle-reconcile-1",
        entryDate: new Date(`${opening.asOf}T00:00:00.000Z`),
        branchId: 1,
        status: "POSTED",
      });
    await db().insert(s.journalLines).values({
      journalId: 999,
      role: "CASH",
      debit: "0.01",
      credit: "0.00",
    });

    const report = await reconcileDoubleEntryOperational({
      cycleId: "cycle-reconcile-1",
    });
    const stored = await verifyStoredShadowOpening({
      cycleId: "cycle-reconcile-1",
      expectedHash: opening.openingHash,
      db: db(),
    });
    expect(report.ok).toBe(false);
    expect(stored).toMatchObject({ hashMatches: false, balanced: false });
    expect(report.journalIntegrity).toMatchObject({
      difference: "0.01",
      isBalanced: false,
    });
    expect(report.blockers).toContainEqual(
      expect.objectContaining({ code: "JOURNAL_UNBALANCED", amount: "0.01" }),
    );
  });

  it("يطابق end-to-end عبور control الدولار من مدين إلى دائن مع النقد الأجنبي الخام مصفّراً", async () => {
    const cycleId = "cycle-exchange-crossing";
    const openingHash = "c".repeat(64);
    await db().insert(s.branches).values({
      id: 1,
      name: "الرئيسي",
      code: "MAIN",
      type: "MAIN",
    });
    await db().insert(s.users).values({
      id: 1,
      openId: "exchange-reconcile-admin",
      name: "مدير مطابقة الصيرفة",
      role: "admin",
      loginMethod: "local",
      branchId: 1,
    });
    await db().insert(s.doubleEntrySettings).values({
      id: 1,
      mode: "ACTIVE",
      shadowCycleId: cycleId,
      shadowOpeningHash: openingHash,
      policyApprovalReference: "EXCHANGE-CROSSING-E2E",
      policyApprovalPolicyHash: POSTING_POLICY_HASH,
      policyApprovalCycleId: cycleId,
      policyApprovalOpeningHash: openingHash,
      policyAccountantName: "محاسب اختبار المطابقة",
      policyApprovedAt: new Date("2026-08-01T00:00:00.000Z"),
      policyApprovedBy: 1,
    });

    const actor = { userId: 1, branchId: 1, role: "admin" };
    const house = await createExchangeHouse(
      {
        name: "صيرفة عبور التسوية",
        openingBalanceUsd: "5.00",
        openingUsdRate: "1400.0000",
      },
      actor,
    );
    await buyUsdAtExchange(
      {
        exchangeHouseId: house.id,
        branchId: 1,
        usdAmount: "10.00",
        exchangeRate: "1500.0000",
        confirmNegative: true,
      },
      actor,
    );

    const report = await reconcileDoubleEntryOperational({ cycleId });
    const byGlobalRole = new Map(
      report.globalRows.map((row) => [row.role, row]),
    );
    const foreignCash = report.branchRows.find(
      (row) => row.role === "FOREIGN_CASH_USD" && row.branchId === 1,
    );

    expect(report).toMatchObject({
      ok: true,
      driftCount: 0,
      totalAbsoluteDifference: "0.00",
      journalIntegrity: { difference: "0.00", isBalanced: true },
      blockers: [],
    });
    expect(byGlobalRole.get("EXCHANGE_RECEIVABLE_USD")).toMatchObject({
      operationalNetDebit: "0.00",
      journalNetDebit: "0.00",
      matches: true,
    });
    expect(byGlobalRole.get("EXCHANGE_PAYABLE_USD")).toMatchObject({
      operationalNetDebit: "-7500.00",
      journalNetDebit: "-7500.00",
      matches: true,
    });
    expect(byGlobalRole.get("EXCHANGE_WALLET_USD")).toMatchObject({
      operationalNetDebit: "0.00",
      journalNetDebit: "0.00",
      matches: true,
    });
    expect(foreignCash).toMatchObject({
      operationalNetDebit: "15000.00",
      journalNetDebit: "15000.00",
      matches: true,
    });
  });
});
