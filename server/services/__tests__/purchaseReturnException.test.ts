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
    "returns zero-cost stock at positive agreed value with double entry %s",
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
