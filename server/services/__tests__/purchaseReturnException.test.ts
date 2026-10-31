import mysql from "mysql2/promise";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { appRouter } from "../../routers";
import { truncateAllTables } from "./__testUtils__";
import { requestPurchaseReturnReversal } from "../purchase/returnGovernance";
import {
  previewSupplierBookSettlement,
  adoptSupplierBookSettlement,
} from "../purchase/supplierBookSettlement";
import { extractInsertId } from "../../lib/insertId";
import { POSTING_POLICY_HASH } from "../accounting/postingEngine";

const db = () => getDb()!;
const caller = (owner = false) =>
  appRouter.createCaller({
    req: { headers: {}, ip: "127.0.0.1" },
    res: { cookie() {}, clearCookie() {} },
    user: {
      id: owner ? 1 : 2,
      role: owner ? "admin" : "manager",
      branchId: 1,
      isActive: true,
      isOwner: owner,
      permissionsOverride: null,
    },
  } as never);
beforeEach(async () => {
  await truncateAllTables();
  await db()
    .insert(s.branches)
    .values({ id: 1, name: "Test", code: "MAIN", type: "MAIN" });
  await db()
    .insert(s.users)
    .values([
      {
        id: 1,
        openId: "exception-owner",
        role: "admin",
        isOwner: true,
        branchId: 1,
      },
      { id: 2, openId: "exception-manager", role: "manager", branchId: 1 },
    ]);
  await db()
    .insert(s.suppliers)
    .values({ id: 1, name: "Supplier", currentBalance: "0.00" });
  await db().insert(s.products).values({ id: 1, name: "Owned paper" });
  await db()
    .insert(s.productVariants)
    .values({ id: 1, productId: 1, sku: "EX-1", costPrice: "100.00" });
  await db().insert(s.productUnits).values({
    id: 1,
    variantId: 1,
    unitName: "piece",
    conversionFactor: "1",
    isBaseUnit: true,
  });
  await db()
    .insert(s.branchStock)
    .values({ branchId: 1, variantId: 1, quantity: 10 });
});
const proposal = () => ({
  supplierId: 1,
  branchId: 1,
  reference: `ACK-${randomUUID()}`,
  evidenceType: "SUPPLIER_ACKNOWLEDGEMENT" as const,
  items: [
    {
      variantId: 1,
      productUnitId: 1,
      productName: "Owned paper",
      quantity: 1,
      unitCost: "150.00",
    },
  ],
  settlement: { method: "CREDIT_OFFSET" as const, totalAmount: "150.00" },
  reason: "اتفاق موثق على إرجاع مخزون افتتاحي",
  clientRequestId: randomUUID(),
});
describe("governed owner exception cart", () => {
  it.each(["inactive", "consignor", "missing"] as const)(
    "allows correcting a definitively invalid %s supplier under the same request key",
    async (kind) => {
      await db()
        .insert(s.suppliers)
        .values({ id: 2, name: "Valid replacement", currentBalance: "0.00" });
      if (kind === "inactive")
        await db()
          .update(s.suppliers)
          .set({ isActive: false })
          .where(eq(s.suppliers.id, 1));
      if (kind === "consignor")
        await db()
          .update(s.suppliers)
          .set({ supplierKind: "CONSIGNOR" })
          .where(eq(s.suppliers.id, 1));
      const input = {
        ...proposal(),
        supplierId: kind === "missing" ? 99999 : 1,
      };
      const api = caller(true).returns;
      await expect(api.executePurchaseReturnCart(input)).resolves.toMatchObject(
        { mode: "INVALID_PROPOSAL" },
      );
      for (const table of [
        s.purchaseReturnRequests,
        s.purchaseReturns,
        s.inventoryMovements,
        s.accountingEntries,
        s.receipts,
      ])
        expect(await db().select().from(table)).toHaveLength(0);
      expect((await db().select().from(s.branchStock))[0].quantity).toBe(10);
      const corrected = { ...input, supplierId: 2 };
      const posted = await api.executePurchaseReturnCart(corrected);
      if (posted.mode !== "EXECUTED")
        throw new Error("Expected executed return");
      await db()
        .update(s.suppliers)
        .set({ isActive: false })
        .where(eq(s.suppliers.id, 2));
      await expect(
        api.executePurchaseReturnCart(corrected),
      ).resolves.toMatchObject({
        mode: "EXECUTED",
        requestId: posted.requestId,
      });
      await expect(
        api.executePurchaseReturnCart({
          ...corrected,
          reason: "Different persisted proposal",
        }),
      ).rejects.toMatchObject({ code: "CONFLICT" });
      expect(await db().select().from(s.purchaseReturnRequests)).toHaveLength(
        1,
      );
      expect(await db().select().from(s.inventoryMovements)).toHaveLength(1);
      expect(await db().select().from(s.accountingEntries)).toHaveLength(1);
      expect(
        (await db().select().from(s.suppliers).where(eq(s.suppliers.id, 2)))[0]
          .currentBalance,
      ).toBe("-150.00");
    },
  );

  it.each(
    (["ACTIVE", "OFF"] as const).flatMap((mode) =>
      (["0.00", "100.00"] as const).flatMap((book) =>
        (["CREDIT_OFFSET", "CASH_IN"] as const).map((method) => ({
          mode,
          book,
          method,
        })),
      ),
    ),
  )(
    "partially reverses a zero-agreement line: $mode / saved $book / $method",
    async ({ mode, book, method }) => {
      await db()
        .update(s.productVariants)
        .set({ costPrice: book })
        .where(eq(s.productVariants.id, 1));
      await db().insert(s.products).values({ id: 2, name: "Paid item" });
      await db()
        .insert(s.productVariants)
        .values({ id: 2, productId: 2, sku: "PAID-2", costPrice: "100.00" });
      await db()
        .insert(s.branchStock)
        .values({ variantId: 2, branchId: 1, quantity: 10 });
      await db().insert(s.shifts).values({
        id: 1,
        branchId: 1,
        userId: 1,
        status: "OPEN",
        openGuard: "ZERO-AGREEMENT",
      });
      await db()
        .insert(s.accounts)
        .values([
          { code: "ZA-AP", name: "AP", type: "LIABILITY", systemRole: "AP" },
          {
            code: "ZA-STOCK",
            name: "Inventory",
            type: "ASSET",
            systemRole: "INVENTORY",
          },
          {
            code: "ZA-VARIANCE",
            name: "Variance",
            type: "EXPENSE",
            systemRole: "PURCHASE_PRICE_VARIANCE",
          },
          { code: "ZA-CASH", name: "Cash", type: "ASSET", systemRole: "CASH" },
        ]);
      if (mode === "ACTIVE")
        await db()
          .insert(s.doubleEntrySettings)
          .values({
            id: 1,
            mode,
            shadowCycleId: "zero-agreement",
            shadowOpeningHash: "a".repeat(64),
            policyApprovalReference: "ZERO-AGREEMENT",
            policyApprovalPolicyHash: POSTING_POLICY_HASH,
            policyApprovalCycleId: "zero-agreement",
            policyApprovalOpeningHash: "a".repeat(64),
            policyAccountantName: "Test accountant",
            policyApprovedAt: new Date(),
            policyApprovedBy: 1,
          });
      const input = {
        ...proposal(),
        items: [
          {
            variantId: 1,
            productUnitId: 1,
            productName: "Free agreement",
            quantity: 1,
            unitCost: "0.00",
          },
          {
            variantId: 2,
            productName: "Paid item",
            quantity: 1,
            unitCost: "150.00",
          },
        ],
        settlement: {
          method,
          totalAmount: "150.00",
          ...(method === "CASH_IN" ? { shiftId: 1 } : {}),
        },
      };
      const posted =
        await caller(true).returns.executePurchaseReturnCart(input);
      if (posted.mode !== "EXECUTED")
        throw new Error("Expected executed return");
      const baselineEntries = await db().select().from(s.accountingEntries);
      const baselineReceipts = await db().select().from(s.receipts);
      const baselineJournals = await db().select().from(s.journalEntries);
      const baselineBalance = (await db().select().from(s.suppliers))[0]
        .currentBalance;
      // A zero monetary reversal must not route through a new drawer/treasury.
      await db()
        .update(s.shifts)
        .set({ status: "CLOSED", openGuard: null })
        .where(eq(s.shifts.id, 1));
      const [returned] = await db().select().from(s.purchaseReturns);
      const [item] = await db()
        .select()
        .from(s.purchaseReturnItems)
        .where(eq(s.purchaseReturnItems.variantId, 1));
      const reversalInput = {
        purchaseReturnId: returned.id,
        expectedReturnVersion: returned.version,
        requestKey: randomUUID(),
        evidenceType: "SUPPLIER_ACKNOWLEDGEMENT" as const,
        evidenceReference: "ZERO-AGREEMENT-REVERSAL",
        reason: "إعادة البند بلا اتفاق مالي",
        lines: [{ purchaseReturnItemId: item.id, baseQuantity: 1 }],
      };
      const requester = { userId: 2, branchId: 1, role: "manager" };
      const pending = await requestPurchaseReturnReversal(
        reversalInput,
        requester,
      );
      expect(pending.status).toBe("PENDING");
      expect(await db().select().from(s.inventoryMovements)).toHaveLength(2);
      const decision = {
        requestId: pending.requestId,
        decisionKey: randomUUID(),
        action: "APPROVE" as const,
        reviewReason: "اعتماد عودة البند الصفري",
      };
      await expect(
        caller(true).purchaseReturnGovernance.decideReversal(decision),
      ).resolves.toMatchObject({ status: "APPROVED", idempotent: false });
      await expect(
        caller(true).purchaseReturnGovernance.decideReversal(decision),
      ).resolves.toMatchObject({ status: "APPROVED", idempotent: true });
      await expect(
        requestPurchaseReturnReversal(reversalInput, requester),
      ).resolves.toMatchObject({
        requestId: pending.requestId,
        status: "APPROVED",
        idempotent: true,
      });
      const reversals = await db().select().from(s.purchaseReturnReversals);
      expect(reversals).toHaveLength(1);
      expect(reversals[0]).toMatchObject({
        totalAmount: "0.00",
        netAmount: "0.00",
        taxAmount: "0.00",
        cashRepaymentReceiptId: null,
      });
      const reversalItems = await db()
        .select()
        .from(s.purchaseReturnReversalItems);
      expect(reversalItems).toHaveLength(1);
      expect(reversalItems[0].valuationEvidence).toMatchObject({
        basis: "SAVED_RETURN",
        originalValuationHash: item.valuationEvidenceHash,
        inventoryAmount: book,
        netAmount: "0.00",
        varianceAmount: book,
      });
      expect((await db().select().from(s.purchaseReturns))[0].status).toBe(
        "PARTIALLY_REVERSED",
      );
      expect(
        (
          await db()
            .select()
            .from(s.branchStock)
            .where(eq(s.branchStock.variantId, 1))
        )[0].quantity,
      ).toBe(10);
      expect(
        (
          await db()
            .select()
            .from(s.branchStock)
            .where(eq(s.branchStock.variantId, 2))
        )[0].quantity,
      ).toBe(9);
      expect(
        (
          await db()
            .select()
            .from(s.productVariants)
            .where(eq(s.productVariants.id, 1))
        )[0],
      ).toMatchObject({ costPrice: book, transitBaseBySourceBranch: {} });
      expect(await db().select().from(s.inventoryMovements)).toHaveLength(3);
      expect((await db().select().from(s.suppliers))[0].currentBalance).toBe(
        baselineBalance,
      );
      expect(await db().select().from(s.receipts)).toEqual(baselineReceipts);
      const entries = await db().select().from(s.accountingEntries);
      expect(entries).toHaveLength(
        baselineEntries.length + (book === "0.00" ? 0 : 1),
      );
      if (book === "0.00") {
        expect(reversals[0].accountingEntryId).toBeNull();
        expect(entries).toEqual(baselineEntries);
      } else {
        expect(
          entries.find((row) => row.id === reversals[0].accountingEntryId),
        ).toMatchObject({
          entryType: "RETURN",
          amount: "0.00",
          cost: "100.00",
          profit: "100.00",
          ...(mode === "ACTIVE"
            ? { postingProfile: "RETURN_PURCHASE_ZERO_AGREEMENT" }
            : {}),
        });
      }
      const journals = await db().select().from(s.journalEntries);
      const added = journals.filter(
        (row) => !baselineJournals.some((prior) => prior.id === row.id),
      );
      expect(added).toHaveLength(mode === "ACTIVE" && book !== "0.00" ? 1 : 0);
      if (added.length) {
        expect(added[0].status).toBe("POSTED");
        const lines = await db()
          .select({
            role: s.journalLines.role,
            debit: s.journalLines.debit,
            credit: s.journalLines.credit,
          })
          .from(s.journalLines)
          .where(eq(s.journalLines.journalId, added[0].id));
        expect(lines).toHaveLength(2);
        expect(lines).toEqual(
          expect.arrayContaining([
            { role: "INVENTORY", debit: "100.00", credit: "0.00" },
            {
              role: "PURCHASE_PRICE_VARIANCE",
              debit: "0.00",
              credit: "100.00",
            },
          ]),
        );
      }
      if (method === "CREDIT_OFFSET") {
        const plan = await previewSupplierBookSettlement({
          supplierId: 1,
          branchId: 1,
        });
        expect(plan.sources).toHaveLength(1);
        expect(plan.sources[0]).toMatchObject({
          kind: "CREDIT",
          unallocatedAmount: "150.00",
        });
        if (book === "0.00") {
          await db()
            .update(s.inventoryMovements)
            .set({ referenceId: reversals[0].id + 99999 })
            .where(
              eq(s.inventoryMovements.id, reversalItems[0].inventoryMovementId),
            );
          await expect(
            previewSupplierBookSettlement({ supplierId: 1, branchId: 1 }),
          ).rejects.toThrow();
        }
      }
    },
  );

  it("definitively rejects reused evidence on a new key and accepts corrected evidence on that same key", async () => {
    const input = proposal();
    const api = caller(true).returns;
    await expect(api.executePurchaseReturnCart(input)).resolves.toMatchObject({
      mode: "EXECUTED",
    });
    const duplicate = { ...input, clientRequestId: randomUUID() };
    await expect(
      api.executePurchaseReturnCart(duplicate),
    ).resolves.toMatchObject({ mode: "INVALID_PROPOSAL" });
    expect(await db().select().from(s.purchaseReturnRequests)).toHaveLength(1);
    expect(await db().select().from(s.purchaseReturns)).toHaveLength(1);
    expect(await db().select().from(s.inventoryMovements)).toHaveLength(1);
    expect(await db().select().from(s.accountingEntries)).toHaveLength(1);
    expect((await db().select().from(s.branchStock))[0].quantity).toBe(9);
    expect((await db().select().from(s.suppliers))[0].currentBalance).toBe(
      "-150.00",
    );
    const corrected = { ...duplicate, reference: `ACK-${randomUUID()}` };
    const posted = await api.executePurchaseReturnCart(corrected);
    expect(posted.mode).toBe("EXECUTED");
    if (posted.mode !== "EXECUTED") throw new Error("Expected executed return");
    await expect(
      api.executePurchaseReturnCart(corrected),
    ).resolves.toMatchObject({ mode: "EXECUTED", requestId: posted.requestId });
    expect(await db().select().from(s.purchaseReturnRequests)).toHaveLength(2);
    expect(await db().select().from(s.purchaseReturns)).toHaveLength(2);
    expect(await db().select().from(s.inventoryMovements)).toHaveLength(2);
    expect(await db().select().from(s.accountingEntries)).toHaveLength(2);
    expect(await db().select().from(s.receipts)).toHaveLength(0);
    expect((await db().select().from(s.branchStock))[0].quantity).toBe(8);
    expect((await db().select().from(s.suppliers))[0].currentBalance).toBe(
      "-300.00",
    );
  });

  it.each(["ACTIVE", "OFF"] as const)(
    "returns and reverses zero-cost stock at positive agreed value with double entry %s",
    async (mode) => {
      await db()
        .update(s.productVariants)
        .set({ costPrice: "0.00" })
        .where(eq(s.productVariants.id, 1));
      await db()
        .insert(s.accounts)
        .values([
          { code: "ZERO-AP", name: "AP", type: "LIABILITY", systemRole: "AP" },
          {
            code: "ZERO-STOCK",
            name: "Inventory",
            type: "ASSET",
            systemRole: "INVENTORY",
          },
          {
            code: "ZERO-VARIANCE",
            name: "Variance",
            type: "EXPENSE",
            systemRole: "PURCHASE_PRICE_VARIANCE",
          },
        ]);
      if (mode === "ACTIVE")
        await db()
          .insert(s.doubleEntrySettings)
          .values({
            id: 1,
            mode,
            shadowCycleId: "zero-cost-active",
            shadowOpeningHash: "a".repeat(64),
            policyApprovalReference: "ZERO-APPROVAL",
            policyApprovalPolicyHash: POSTING_POLICY_HASH,
            policyApprovalCycleId: "zero-cost-active",
            policyApprovalOpeningHash: "a".repeat(64),
            policyAccountantName: "Test accountant",
            policyApprovedAt: new Date(),
            policyApprovedBy: 1,
          });
      const input = proposal();
      const api = caller(true).returns;
      const posted = await api.executePurchaseReturnCart(input);
      expect(posted.mode).toBe("EXECUTED");
      if (posted.mode !== "EXECUTED")
        throw new Error("Expected executed return");
      await expect(api.executePurchaseReturnCart(input)).resolves.toMatchObject(
        { mode: "EXECUTED", requestId: posted.requestId },
      );
      expect(await db().select().from(s.purchaseReturnRequests)).toHaveLength(
        1,
      );
      expect(await db().select().from(s.purchaseReturns)).toHaveLength(1);
      expect(await db().select().from(s.inventoryMovements)).toHaveLength(1);
      expect(await db().select().from(s.accountingEntries)).toHaveLength(1);
      expect((await db().select().from(s.accountingEntries))[0]).toMatchObject({
        amount: "-150.00",
        cost: "0.00",
      });
      expect(await db().select().from(s.receipts)).toHaveLength(0);
      expect((await db().select().from(s.branchStock))[0].quantity).toBe(9);
      expect((await db().select().from(s.productVariants))[0]).toMatchObject({
        costPrice: "0.00",
        transitBaseBySourceBranch: {},
      });
      expect((await db().select().from(s.suppliers))[0].currentBalance).toBe(
        "-150.00",
      );
      expect(
        (await db().select().from(s.purchaseReturnItems))[0].valuationEvidence,
      ).toMatchObject({
        inventoryAmount: "0.00",
        netAmount: "150.00",
        varianceAmount: "-150.00",
      });
      const lines = await db()
        .select({
          role: s.journalLines.role,
          debit: s.journalLines.debit,
          credit: s.journalLines.credit,
        })
        .from(s.journalLines);
      expect(lines).toEqual(
        mode === "ACTIVE"
          ? expect.arrayContaining([
              { role: "AP", debit: "150.00", credit: "0.00" },
              {
                role: "PURCHASE_PRICE_VARIANCE",
                debit: "0.00",
                credit: "150.00",
              },
            ])
          : [],
      );
      expect(lines).toHaveLength(mode === "ACTIVE" ? 2 : 0);
      // Later receipts/revaluation may change current WAVG. Reversal must add
      // back the saved zero value, preserving the remaining 9 * 100 book value.
      await db()
        .update(s.productVariants)
        .set({ costPrice: "100.00" })
        .where(eq(s.productVariants.id, 1));
      const [returned] = await db().select().from(s.purchaseReturns);
      const [item] = await db().select().from(s.purchaseReturnItems);
      const reversalInput = {
        purchaseReturnId: returned.id,
        expectedReturnVersion: returned.version,
        requestKey: randomUUID(),
        evidenceType: "SUPPLIER_ACKNOWLEDGEMENT" as const,
        evidenceReference: "ZERO-COST-REVERSAL",
        reason: "إلغاء الاتفاق وإعادة المخزون بقيمته المحفوظة",
        lines: [{ purchaseReturnItemId: item.id, baseQuantity: 1 }],
      };
      const requester = { userId: 2, branchId: 1, role: "manager" };
      const pending = await requestPurchaseReturnReversal(
        reversalInput,
        requester,
      );
      expect(pending.status).toBe("PENDING");
      expect(await db().select().from(s.purchaseReturnReversals)).toHaveLength(
        0,
      );
      expect((await db().select().from(s.branchStock))[0].quantity).toBe(9);
      expect((await db().select().from(s.suppliers))[0].currentBalance).toBe(
        "-150.00",
      );
      const decision = {
        requestId: pending.requestId,
        decisionKey: randomUUID(),
        action: "APPROVE" as const,
        reviewReason: "اعتماد إعادة المخزون بقيمة المصدر",
      };
      await expect(
        caller(true).purchaseReturnGovernance.decideReversal(decision),
      ).resolves.toMatchObject({ status: "APPROVED", idempotent: false });
      await expect(
        caller(true).purchaseReturnGovernance.decideReversal(decision),
      ).resolves.toMatchObject({ status: "APPROVED", idempotent: true });
      await expect(
        requestPurchaseReturnReversal(reversalInput, requester),
      ).resolves.toMatchObject({
        requestId: pending.requestId,
        status: "APPROVED",
        idempotent: true,
      });
      expect(
        await db().select().from(s.purchaseReturnReversalRequests),
      ).toHaveLength(1);
      expect(await db().select().from(s.purchaseReturnReversals)).toHaveLength(
        1,
      );
      const reversalItems = await db()
        .select()
        .from(s.purchaseReturnReversalItems);
      expect(reversalItems).toHaveLength(1);
      expect(reversalItems[0].valuationEvidence).toMatchObject({
        basis: "SAVED_RETURN",
        purchaseReturnItemId: item.id,
        originalValuationHash: item.valuationEvidenceHash,
        baseQuantity: 1,
        inventoryAmount: "0.00",
        netAmount: "150.00",
        varianceAmount: "-150.00",
      });
      expect((await db().select().from(s.purchaseReturns))[0].status).toBe(
        "REVERSED",
      );
      expect(await db().select().from(s.inventoryMovements)).toHaveLength(2);
      const entries = await db().select().from(s.accountingEntries);
      expect(entries).toHaveLength(2);
      expect(entries).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ amount: "-150.00", cost: "0.00" }),
          expect.objectContaining({ amount: "150.00", cost: "0.00" }),
        ]),
      );
      expect(await db().select().from(s.receipts)).toHaveLength(0);
      expect((await db().select().from(s.branchStock))[0].quantity).toBe(10);
      expect((await db().select().from(s.productVariants))[0]).toMatchObject({
        costPrice: "90.00",
        transitBaseBySourceBranch: {},
      });
      expect((await db().select().from(s.suppliers))[0].currentBalance).toBe(
        "0.00",
      );
      const journals = await db().select().from(s.journalEntries);
      expect(journals).toHaveLength(mode === "ACTIVE" ? 2 : 0);
      if (mode === "ACTIVE") {
        for (const entry of entries)
          expect(entry.postingProfile).toBe("RETURN_PURCHASE_ZERO_BOOK");
      }
      const allLines = await db().select().from(s.journalLines);
      expect(allLines).toHaveLength(mode === "ACTIVE" ? 4 : 0);
      expect(allLines.some((line) => line.role === "INVENTORY")).toBe(false);
      for (const journal of journals) {
        expect(journal.status).toBe("POSTED");
        const journalLines = allLines.filter(
          (line) => line.journalId === journal.id,
        );
        expect(journalLines).toHaveLength(2);
        expect(journalLines.map((line) => line.debit).sort()).toEqual([
          "0.00",
          "150.00",
        ]);
        expect(journalLines.map((line) => line.credit).sort()).toEqual([
          "0.00",
          "150.00",
        ]);
      }
      for (const role of ["AP", "PURCHASE_PRICE_VARIANCE"]) {
        const roleLines = allLines.filter((line) => line.role === role);
        expect(roleLines.map((line) => line.debit).sort()).toEqual(
          roleLines.map((line) => line.credit).sort(),
        );
      }
    },
  );

  it("direct approval holds current authority until its blocked supplier write commits", async () => {
    const pending =
      await caller().returns.executePurchaseReturnCart(proposal());
    if (pending.mode !== "REQUESTED")
      throw new Error("Expected pending request");
    const block = await mysql.createConnection(process.env.TEST_DATABASE_URL!);
    const observer = await mysql.createConnection(
      process.env.TEST_DATABASE_URL!,
    );
    let revoke: Promise<unknown> | undefined;
    let decision: Promise<unknown> | undefined;
    try {
      await block.beginTransaction();
      await block.query("SELECT id FROM suppliers WHERE id=1 FOR UPDATE");
      decision = caller(true).purchaseReturnGovernance.decideReturn({
        requestId: pending.requestId,
        decisionKey: randomUUID(),
        action: "APPROVE",
        reviewReason: "Direct owner approval",
      });
      const waitFor = async (table: string) => {
        const deadline = Date.now() + 5000;
        while (Date.now() < deadline) {
          const [rows] = await observer.query<any[]>(
            "SELECT l.OBJECT_NAME FROM performance_schema.data_lock_waits w JOIN performance_schema.data_locks l ON l.ENGINE_LOCK_ID=w.REQUESTING_ENGINE_LOCK_ID WHERE l.OBJECT_SCHEMA=DATABASE() AND l.OBJECT_NAME=?",
            [table],
          );
          if (rows.length) return;
          await new Promise((r) => setTimeout(r, 20));
        }
        throw new Error(`No actual lock wait on ${table}`);
      };
      await waitFor("suppliers");
      let revoked = false;
      revoke = db()
        .update(s.users)
        .set({ isOwner: false, isActive: false })
        .where(eq(s.users.id, 1))
        .then(() => {
          revoked = true;
        });
      await waitFor("users").catch(async (error) => {
        // Record the vulnerable original outcome after revocation committed;
        // the repaired path instead observes the actual user-row lock wait.
        await block.commit();
        const outcome = await decision;
        await revoke;
        console.info(
          "STALE_OWNER_REPRO",
          JSON.stringify({
            revoked,
            outcome,
            returns: (await db().select().from(s.purchaseReturns)).length,
            quantity: (await db().select().from(s.branchStock))[0].quantity,
          }),
        );
        throw error;
      });
      expect(revoked).toBe(false);
      await block.commit();
      await expect(decision).resolves.toMatchObject({ status: "APPROVED" });
      await revoke;
      expect((await db().select().from(s.branchStock))[0].quantity).toBe(9);
      expect(await db().select().from(s.purchaseReturns)).toHaveLength(1);
      await expect(
        caller(true).purchaseReturnGovernance.decideReturn({
          requestId: pending.requestId,
          decisionKey: randomUUID(),
          action: "APPROVE",
          reviewReason: "Stale context retry",
        }),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
      expect(await db().select().from(s.purchaseReturns)).toHaveLength(1);
    } finally {
      await block.rollback();
      await Promise.allSettled([decision, revoke].filter(Boolean));
      await block.end();
      await observer.end();
    }
  });
  it("direct return and reversal reject current explicit operation denial", async () => {
    const pending =
      await caller().returns.executePurchaseReturnCart(proposal());
    if (pending.mode !== "REQUESTED")
      throw new Error("Expected pending request");
    await db()
      .update(s.users)
      .set({
        operationPolicy: {
          version: 1,
          grants: {
            "operation.purchaseReturnGovernance.decideReturn": false,
            "operation.purchaseReturnGovernance.decideReversal": false,
          },
        },
      })
      .where(eq(s.users.id, 2));
    await expect(
      caller().purchaseReturnGovernance.decideReturn({
        requestId: pending.requestId,
        decisionKey: randomUUID(),
        action: "APPROVE",
        reviewReason: "Must reject stale permission",
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      caller().purchaseReturnGovernance.decideReversal({
        requestId: pending.requestId,
        decisionKey: randomUUID(),
        action: "APPROVE",
        reviewReason: "Must reject stale permission",
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(await db().select().from(s.purchaseReturns)).toHaveLength(0);
    expect(await db().select().from(s.accountingEntries)).toHaveLength(0);
    expect((await db().select().from(s.branchStock))[0].quantity).toBe(10);
  });
  it("proves pre-insert validation rollback but preserves post-request failure identity", async () => {
    const input = proposal();
    input.items[0].productUnitId = 99999;
    await expect(
      caller().returns.executePurchaseReturnCart(input),
    ).resolves.toMatchObject({ mode: "INVALID_PROPOSAL" });
    expect(await db().select().from(s.purchaseReturnRequests)).toHaveLength(0);
    input.items[0].productUnitId = 1;
    await expect(
      caller().returns.executePurchaseReturnCart(input),
    ).resolves.toMatchObject({ mode: "REQUESTED" });
    expect(await db().select().from(s.purchaseReturnRequests)).toHaveLength(1);
    const cash = {
      ...proposal(),
      settlement: {
        method: "CASH_IN" as const,
        totalAmount: "150.00",
        shiftId: 99999,
      },
    };
    await expect(
      caller(true).returns.executePurchaseReturnCart(cash),
    ).rejects.toBeDefined();
    expect(
      (await db().select().from(s.purchaseReturnRequests)).filter(
        (r) => r.requestKey === cash.clientRequestId,
      ),
    ).toHaveLength(1);
  });

  it("ACTIVE posts real AP inventory variance GL and exactly reverses saved values", async () => {
    await db()
      .insert(s.accounts)
      .values([
        { code: "EX-AP", name: "AP", type: "LIABILITY", systemRole: "AP" },
        {
          code: "EX-STOCK",
          name: "Inventory",
          type: "ASSET",
          systemRole: "INVENTORY",
        },
        {
          code: "EX-VARIANCE",
          name: "Variance",
          type: "EXPENSE",
          systemRole: "PURCHASE_PRICE_VARIANCE",
        },
      ]);
    await db()
      .insert(s.doubleEntrySettings)
      .values({
        id: 1,
        mode: "ACTIVE",
        shadowCycleId: "exception-active",
        shadowOpeningHash: "a".repeat(64),
        policyApprovalReference: "EX-APPROVAL",
        policyApprovalPolicyHash: POSTING_POLICY_HASH,
        policyApprovalCycleId: "exception-active",
        policyApprovalOpeningHash: "a".repeat(64),
        policyAccountantName: "Test accountant",
        policyApprovedAt: new Date(),
        policyApprovedBy: 1,
      });
    const input = proposal();
    const result = await caller(true).returns.executePurchaseReturnCart(input);
    expect(result.mode).toBe("EXECUTED");
    await caller(true).returns.executePurchaseReturnCart(input);
    const before = await db()
      .select({
        role: s.journalLines.role,
        debit: s.journalLines.debit,
        credit: s.journalLines.credit,
        status: s.journalEntries.status,
      })
      .from(s.journalLines)
      .innerJoin(
        s.journalEntries,
        eq(s.journalEntries.id, s.journalLines.journalId),
      );
    expect(before).toHaveLength(3);
    expect(before).toEqual(
      expect.arrayContaining([
        { role: "AP", debit: "150.00", credit: "0.00", status: "POSTED" },
        {
          role: "INVENTORY",
          debit: "0.00",
          credit: "100.00",
          status: "POSTED",
        },
        {
          role: "PURCHASE_PRICE_VARIANCE",
          debit: "0.00",
          credit: "50.00",
          status: "POSTED",
        },
      ]),
    );
    const [returned] = await db().select().from(s.purchaseReturns);
    const [item] = await db().select().from(s.purchaseReturnItems);
    await requestPurchaseReturnReversal(
      {
        purchaseReturnId: returned.id,
        expectedReturnVersion: returned.version,
        requestKey: randomUUID(),
        evidenceType: "SUPPLIER_ACKNOWLEDGEMENT",
        evidenceReference: "ACTIVE-REV",
        reason: "إلغاء الاستثناء المعتمد وإعادة المخزون",
        lines: [{ purchaseReturnItemId: item.id, baseQuantity: 1 }],
      },
      { userId: 1, branchId: 1, role: "admin" },
    );
    const after = await db().select().from(s.journalLines);
    expect(after).toHaveLength(6);
    for (const role of ["AP", "INVENTORY", "PURCHASE_PRICE_VARIANCE"]) {
      const lines = after.filter((line) => line.role === role);
      expect(lines.map((line) => line.debit).sort()).toEqual(
        lines.map((line) => line.credit).sort(),
      );
    }
    expect(await db().select().from(s.accountingEntries)).toHaveLength(2);
    expect((await db().select().from(s.suppliers))[0].currentBalance).toBe(
      "0.00",
    );
    expect((await db().select().from(s.branchStock))[0].quantity).toBe(10);
    expect((await db().select().from(s.productVariants))[0].costPrice).toBe(
      "100.00",
    );
  });
  it("uses the explicitly selected drawer and replays after that drawer closes", async () => {
    await db()
      .insert(s.shifts)
      .values([
        { id: 11, branchId: 1, userId: 1, status: "OPEN", openGuard: "EX-11" },
        { id: 12, branchId: 1, userId: 2, status: "OPEN", openGuard: "EX-12" },
      ]);
    const input = {
      ...proposal(),
      settlement: {
        method: "CASH_IN" as const,
        totalAmount: "150.00",
        shiftId: 12,
      },
    };
    const posted = await caller(true).returns.executePurchaseReturnCart(input);
    expect(posted.mode).toBe("EXECUTED");
    if (posted.mode !== "EXECUTED") throw new Error("Expected executed return");
    expect((await db().select().from(s.receipts))[0]).toMatchObject({
      shiftId: 12,
      direction: "IN",
      amount: "150.00",
      paymentMethod: "CASH",
    });
    expect((await db().select().from(s.suppliers))[0].currentBalance).toBe(
      "0.00",
    );
    await db()
      .update(s.shifts)
      .set({ status: "CLOSED", openGuard: null })
      .where(eq(s.shifts.id, 12));
    expect(
      await caller(true).returns.executePurchaseReturnCart(input),
    ).toMatchObject({ mode: "EXECUTED", requestId: posted.requestId });
    expect(await db().select().from(s.receipts)).toHaveLength(1);
    expect(
      (await previewSupplierBookSettlement({ supplierId: 1, branchId: 1 }))
        .sources,
    ).toHaveLength(0);
  });
  it("noncash refund requires a reference and never becomes BOOK credit", async () => {
    const input = {
      ...proposal(),
      settlement: {
        method: "CARD_TRANSFER" as const,
        totalAmount: "150.00",
        reference: "BANK-ACK-123",
      },
    };
    expect(
      await caller(true).returns.executePurchaseReturnCart(input),
    ).toMatchObject({ mode: "EXECUTED" });
    expect((await db().select().from(s.receipts))[0]).toMatchObject({
      shiftId: null,
      cashBucket: null,
      direction: "IN",
      paymentMethod: "TRANSFER",
    });
    expect(
      (await previewSupplierBookSettlement({ supplierId: 1, branchId: 1 }))
        .sources,
    ).toHaveLength(0);
  });
  it("operational detail and reversal APIs do not disclose carrying-value proof", async () => {
    const posted =
      await caller(true).returns.executePurchaseReturnCart(proposal());
    if (posted.mode !== "EXECUTED") throw new Error("expected posted return");
    const policy = {
      version: 1 as const,
      grants: {
        "operation.purchaseReturns.get": true,
        "operation.purchaseReturnGovernance.reversalSources": true,
      },
      dataVisibility: { purchaseCost: false, profitMargin: false },
    };
    await db()
      .update(s.users)
      .set({ operationPolicy: policy })
      .where(eq(s.users.id, 2));
    const api = appRouter.createCaller({
      req: { headers: {} },
      res: {},
      user: {
        id: 2,
        role: "manager",
        branchId: 1,
        isActive: true,
        operationPolicyEnabled: true,
        resolvedOperationPolicy: policy,
      },
    } as never);
    const detail = await api.purchaseReturns.get({
      id: posted.purchaseReturnId,
    });
    expect(detail.items[0]).toMatchObject({
      lineTotal: "150.00",
      historicalValueKnown: true,
    });
    const reversal = await api.purchaseReturnGovernance.reversalSources({
      branchId: 1,
    });
    for (const dto of [detail, reversal])
      expect(JSON.stringify(dto)).not.toMatch(
        /inventoryUnitCost|inventoryAmount|varianceAmount|valuationEvidence|executionEvidence/,
      );
  });
  it("explicit underlying request denial prevents cart effects", async () => {
    const policy = {
      version: 1 as const,
      grants: {
        "operation.returns.executePurchaseReturnCart": true,
        "operation.purchaseReturnGovernance.requestReturn": false,
      },
      dataVisibility: { purchaseCost: true, profitMargin: true },
    };
    await db()
      .update(s.users)
      .set({ operationPolicy: policy })
      .where(eq(s.users.id, 2));
    await expect(
      caller().returns.executePurchaseReturnCart(proposal()),
    ).rejects.toThrow();
    expect(await db().select().from(s.purchaseReturnRequests)).toHaveLength(0);
    expect(await db().select().from(s.inventoryMovements)).toHaveLength(0);
  });
  it("retains real unused CREDIT without a fake invoice and reverses saved carrying value", async () => {
    const posted =
      await caller(true).returns.executePurchaseReturnCart(proposal());
    expect(posted.mode).toBe("EXECUTED");
    if (posted.mode !== "EXECUTED") throw new Error("Expected executed return");
    const plan = await previewSupplierBookSettlement({
      supplierId: 1,
      branchId: 1,
    });
    expect(plan.sources).toHaveLength(1);
    expect(plan.sources[0]).toMatchObject({
      kind: "CREDIT",
      unallocatedAmount: "150.00",
      allocations: [],
    });
    const actor = { userId: 1, branchId: 1, role: "admin" };
    await adoptSupplierBookSettlement(
      {
        supplierId: 1,
        branchId: 1,
        requestKey: randomUUID(),
        expectedPlanHash: plan.planHash,
      },
      actor,
    );
    expect(await db().select().from(s.supplierInvoices)).toHaveLength(0);
    expect(
      await db().select().from(s.supplierBookSettlementSources),
    ).toHaveLength(1);
    const [creditSource] = await db()
      .select()
      .from(s.supplierBookSettlementSources);
    await db().insert(s.purchaseOrders).values({
      id: 1,
      poNumber: "LATER-REAL-PO",
      supplierId: 1,
      branchId: 1,
      status: "RECEIVED",
      settlementType: "CREDIT",
      subtotal: "100.00",
      total: "100.00",
      paidAmount: "0.00",
    });
    const entryId = extractInsertId(
      await db()
        .insert(s.accountingEntries)
        .values({
          entryType: "PURCHASE",
          entryDate: new Date("2026-10-31T00:00:00Z"),
          supplierId: 1,
          branchId: 1,
          purchaseOrderId: 1,
          amount: "100.00",
          purchaseLiabilityAccount: "AP",
          createdBy: 1,
        }),
    );
    await db()
      .insert(s.supplierInvoices)
      .values({
        id: 1,
        invoiceNumber: "LATER-REAL-INVOICE",
        clientRequestId: randomUUID(),
        origin: "LEGACY",
        liabilityClass: "LEGACY_UNKNOWN",
        paymentGate: "BLOCKED_REVIEW",
        legacyPurchaseOrderId: 1,
        supplierId: 1,
        branchId: 1,
        status: "POSTED",
        invoiceDate: "2026-10-31",
        currency: "IQD",
        subtotal: "100.00",
        totalAmount: "100.00",
        payloadCanonical: "{}",
        payloadHash: "a".repeat(64),
        evidenceType: "LEGACY_LEDGER",
        legacySettlementEvidenceHash: "b".repeat(64),
        postingEntryId: entryId,
      });
    await db()
      .update(s.suppliers)
      .set({ currentBalance: "-50.00" })
      .where(eq(s.suppliers.id, 1));
    const later = await previewSupplierBookSettlement({
      supplierId: 1,
      branchId: 1,
    });
    expect(later.sources[0]).toMatchObject({
      retainedSourceId: creditSource.id,
      unallocatedAmount: "50.00",
    });
    await adoptSupplierBookSettlement(
      {
        supplierId: 1,
        branchId: 1,
        requestKey: randomUUID(),
        expectedPlanHash: later.planHash,
      },
      actor,
    );
    expect(
      await db().select().from(s.supplierBookSettlementSources),
    ).toHaveLength(1);
    expect(
      (await db().select().from(s.supplierBookSettlementAllocations))[0],
    ).toMatchObject({
      sourceId: creditSource.id,
      allocatedAmount: "100.00",
      reversedAmount: "0.00",
    });
    await db()
      .update(s.productVariants)
      .set({ costPrice: "200.00" })
      .where(eq(s.productVariants.id, 1));
    const [returned] = await db().select().from(s.purchaseReturns);
    const [item] = await db().select().from(s.purchaseReturnItems);
    await requestPurchaseReturnReversal(
      {
        purchaseReturnId: returned.id,
        expectedReturnVersion: returned.version,
        requestKey: randomUUID(),
        evidenceType: "SUPPLIER_ACKNOWLEDGEMENT",
        evidenceReference: "REVERSAL-ACK",
        reason: "إلغاء الاتفاق مع إعادة كامل البضاعة",
        lines: [{ purchaseReturnItemId: item.id, baseQuantity: 1 }],
      },
      actor,
    );
    expect(
      (await db().select().from(s.purchaseReturnReversalItems))[0]
        .valuationEvidence,
    ).toMatchObject({ inventoryAmount: "100.00", netAmount: "150.00" });
    expect((await db().select().from(s.productVariants))[0].costPrice).toBe(
      "190.00",
    );
    expect((await db().select().from(s.branchStock))[0].quantity).toBe(10);
    expect((await db().select().from(s.suppliers))[0].currentBalance).toBe(
      "100.00",
    );
    expect(
      (await db().select().from(s.supplierBookSettlementSources))[0],
    ).toMatchObject({
      kind: "CREDIT",
      amount: "150.00",
      reversedAmount: "150.00",
    });
    expect(
      (await db().select().from(s.supplierBookSettlementAllocations))[0]
        .reversedAmount,
    ).toBe("100.00");
  });
  it("owner executes once, persists independent carrying value, and rejects changed retry payload", async () => {
    const input = proposal();
    const first = await caller(true).returns.executePurchaseReturnCart(input);
    expect(first.mode).toBe("EXECUTED");
    if (first.mode !== "EXECUTED") throw new Error("Expected executed return");
    const again = await caller(true).returns.executePurchaseReturnCart(input);
    expect(again).toMatchObject({
      mode: "EXECUTED",
      requestId: first.requestId,
    });
    expect(await db().select().from(s.purchaseReturns)).toHaveLength(1);
    expect(await db().select().from(s.inventoryMovements)).toHaveLength(1);
    expect(
      (await db().select().from(s.purchaseReturnItems))[0].valuationEvidence,
    ).toMatchObject({
      inventoryAmount: "100.00",
      netAmount: "150.00",
      varianceAmount: "-50.00",
    });
    expect((await db().select().from(s.suppliers))[0].currentBalance).toBe(
      "-150.00",
    );
    await expect(
      caller(true).returns.executePurchaseReturnCart({
        ...input,
        reason: "اتفاق مختلف غير معتمد",
      }),
    ).rejects.toThrow();
    expect(await db().select().from(s.purchaseReturns)).toHaveLength(1);
  });
  it("concurrent owner retries retain one document and one stock movement", async () => {
    const input = proposal();
    const outcomes = await Promise.allSettled([
      caller(true).returns.executePurchaseReturnCart(input),
      caller(true).returns.executePurchaseReturnCart(input),
    ]);
    expect(
      outcomes
        .filter((r) => r.status === "rejected")
        .map((r) => r.reason.message),
    ).toEqual([]);
    expect(await db().select().from(s.purchaseReturns)).toHaveLength(1);
    expect(await db().select().from(s.inventoryMovements)).toHaveLength(1);
  });
  it("nonowner request has zero effects and one durable retry identity", async () => {
    const input = proposal();
    const first = await caller().returns.executePurchaseReturnCart(input);
    expect(first).toMatchObject({ mode: "REQUESTED" });
    const replay = await caller().returns.executePurchaseReturnCart(input);
    expect(replay).toMatchObject({
      mode: "REQUESTED",
      requestId: (first as any).requestId,
    });
    expect(await db().select().from(s.purchaseReturnRequests)).toHaveLength(1);
    expect(await db().select().from(s.inventoryMovements)).toHaveLength(0);
    expect(await db().select().from(s.accountingEntries)).toHaveLength(0);
    expect((await db().select().from(s.branchStock))[0].quantity).toBe(10);
  });
  it("rejects caller total tampering without financial effects", async () => {
    const input = proposal();
    input.settlement.totalAmount = "999.00";
    await expect(
      caller(true).returns.executePurchaseReturnCart(input),
    ).rejects.toThrow();
    expect(await db().select().from(s.accountingEntries)).toHaveLength(0);
    expect(
      (await db().select().from(s.suppliers).where(eq(s.suppliers.id, 1)))[0]
        .currentBalance,
    ).toBe("0.00");
  });
});
