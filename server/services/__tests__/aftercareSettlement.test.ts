import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import {
  aftercareExecutionLines,
  aftercareExecutions,
  aftercareSettlementLines,
  aftercareSettlements,
} from "../../../drizzle/fulfillmentSchema";
import { getDb } from "../../db";
import { applyMovement, applyValuedInboundMovement } from "../inventoryService";
import { withTx } from "../tx";
import {
  approveAftercareCase,
  cancelAftercareExecution,
  confirmAftercareDelivery,
  createAftercareCase,
  declareAftercareExecutionReturn,
  dispatchAftercareExecution,
  prepareAftercareExecution,
  resolveAftercareCase,
} from "../fulfillment/aftercare";
import { staffHandoverConsignments } from "../delivery/staffTransition";
import { previewWorkflowSource } from "../delivery/workflow/preview";
import { receiveWorkflowReturn } from "../delivery/workflow/returns";
import {
  getAftercareCase,
  resolveAftercareActor,
} from "../fulfillment/aftercareQueries";
import {
  approveAftercareSettlement,
  postAftercareSettlement,
  previewAftercareSettlement,
  requestAftercareSettlement,
  withdrawAftercareSettlement,
} from "../fulfillment/aftercareSettlement";

const maker = { userId: 1, branchId: 1, role: "cashier" };
const manager = { userId: 2, branchId: 1, role: "admin" };
const reviewer = { userId: 3, branchId: 1, role: "manager" };
const foreign = { userId: 4, branchId: 2, role: "manager" };
const key = () => randomUUID();
function db() {
  const value = getDb();
  if (!value) throw new Error("isolated test DB required");
  return value;
}

beforeEach(async () => {
  await db()
    .insert(s.branches)
    .values([
      { id: 1, name: "الأصل", code: "MAIN", type: "MAIN" },
      { id: 2, name: "فرع آخر", code: "OTHER", type: "SALES" },
    ]);
  await db()
    .insert(s.users)
    .values([
      {
        id: 1,
        openId: "acs-maker",
        name: "طالب",
        role: "cashier",
        branchId: 1,
      },
      {
        id: 2,
        openId: "acs-manager",
        name: "إدارة",
        role: "admin",
        branchId: 1,
      },
      {
        id: 3,
        openId: "acs-reviewer",
        name: "مراجع",
        role: "manager",
        branchId: 1,
      },
      {
        id: 4,
        openId: "acs-foreign",
        name: "فرع آخر",
        role: "manager",
        branchId: 2,
      },
      {
        id: 5,
        openId: "acs-driver",
        name: "ناقل",
        role: "courier",
        branchId: 1,
      },
    ]);
  await db().insert(s.deliveryParties).values({
    id: 1,
    name: "ناقل مرتبط",
    partyType: "INDIVIDUAL",
    branchId: 1,
    userId: 5,
    defaultFee: "0",
  });
  await db()
    .insert(s.deliveryPartyMembers)
    .values({ partyId: 1, userId: 5, memberRole: "DRIVER", createdBy: 2 });
  await db()
    .insert(s.customers)
    .values({ id: 1, name: "عميل", currentBalance: "0" });
  await db()
    .insert(s.products)
    .values([
      { id: 1, name: "أصل مخزني" },
      { id: 2, name: "خامة جديدة" },
    ]);
  await db()
    .insert(s.productVariants)
    .values([
      { id: 1, productId: 1, sku: "ACS-1", costPrice: "10.00" },
      { id: 2, productId: 2, sku: "ACS-2", costPrice: "5.00" },
    ]);
  await db()
    .insert(s.branchStock)
    .values([
      { variantId: 1, branchId: 1, quantity: 100 },
      { variantId: 2, branchId: 1, quantity: 100 },
    ]);
  await db().insert(s.invoices).values({
    id: 1,
    invoiceNumber: "ACS-ORIGINAL",
    sourceType: "POS",
    branchId: 1,
    customerId: 1,
    subtotal: "1000",
    total: "1000",
    paidAmount: "1000",
    costTotal: "100",
    status: "PAID",
  });
  await db().insert(s.invoiceItems).values({
    id: 1,
    invoiceId: 1,
    variantId: 1,
    quantity: "10",
    baseQuantity: 10,
    unitPrice: "100",
    total: "1000",
    lineCost: "100",
  });
  await withTx((tx) =>
    applyMovement(tx, {
      variantId: 1,
      branchId: 1,
      baseQuantity: 10,
      movementType: "OUT",
      referenceType: "INVOICE",
      referenceId: 1,
      createdBy: 1,
    }),
  );
});

async function prepared(
  disposition: "REPLACEMENT" | "REPRINT" = "REPLACEMENT",
  quantity = 3,
) {
  const created = await createAftercareCase(
    {
      branchId: 1,
      invoiceId: 1,
      clientRequestId: key(),
      reason: "معالجة نقص مثبت",
      evidence: "محضر المصدر والكمية",
      lines: [
        {
          originalInvoiceItemId: 1,
          componentVariantId: 1,
          baseQuantity: quantity,
          disposition,
          evidence: "دليل النقص الأصلي",
        },
      ],
    },
    maker,
  );
  await approveAftercareCase(
    { id: created.id, expectedVersion: 1, clientRequestId: key() },
    manager,
  );
  const detail = await getAftercareCase(created.id, manager);
  await prepareAftercareExecution(
    {
      id: created.id,
      expectedVersion: detail.case.version,
      clientRequestId: key(),
      recipientName: "مستلم",
      recipientPhone: "07700000000",
      deliveryAddress: "عنوان مستلم موثق",
      deliveryFee: "0",
      lines: [
        {
          aftercareLineId: detail.lines[0].id,
          baseQuantity: quantity,
          materials:
            disposition === "REPRINT"
              ? [{ variantId: 2, baseQuantity: quantity }]
              : undefined,
        },
      ],
    },
    manager,
  );
  return getAftercareCase(created.id, manager);
}
function input(data: Awaited<ReturnType<typeof prepared>>, usable = 2) {
  return {
    id: data.case.id,
    expectedVersion: data.case.version,
    reason: "توقف التجهيز بطلب موثق",
    evidence: "استلام فعلي وفحص الصالح والتالف",
    physicalHeldConfirmed: true,
    sourceRights: [],
    decisions: data.executions.flatMap((execution) =>
      execution.lines.map((line) => ({
        executionLineId: line.id,
        usableBaseQuantity: usable,
        consumedBaseQuantity: 0,
        damagedBaseQuantity: line.baseQuantity - usable,
        evidence: "استلام وفحص فعلي موثق",
      })),
    ),
  };
}
async function approvedSettlement(payload: ReturnType<typeof input>) {
  const preview = await previewAftercareSettlement(payload, manager);
  const requested = await requestAftercareSettlement(
    { ...payload, previewHash: preview.previewHash, clientRequestId: key() },
    manager,
  );
  await approveAftercareSettlement(
    { id: requested.id, expectedVersion: 1, clientRequestId: key() },
    reviewer,
  );
  return requested.id;
}
async function stock(variantId = 1) {
  return (
    await db()
      .select()
      .from(s.branchStock)
      .where(
        and(
          eq(s.branchStock.variantId, variantId),
          eq(s.branchStock.branchId, 1),
        ),
      )
  )[0].quantity;
}

describe("controlled stopped aftercare settlement actual path", () => {
  it("returns only proven usable stock at original issue cost after WAVG changes, reverses only that expense, and replays once", async () => {
    const data = await prepared();
    expect(await stock()).toBe(87);
    // Genuine valued inbound changes current WAVG; return must keep the saved issue's 10/unit.
    await withTx((tx) =>
      applyValuedInboundMovement(tx, {
        branchId: 1,
        variantId: 1,
        baseQuantity: 13,
        historicalValue: "260",
        referenceType: "PURCHASE",
        referenceId: 2,
        createdBy: 2,
      }),
    );
    const payload = input(data);
    const id = await approvedSettlement(payload);
    const command = { id, expectedVersion: 2, clientRequestId: key() };
    await postAftercareSettlement(command, reviewer);
    expect((await postAftercareSettlement(command, reviewer)).replay).toBe(
      true,
    );
    expect(await stock()).toBe(102);
    const [row] = await db()
      .select()
      .from(aftercareSettlementLines)
      .where(eq(aftercareSettlementLines.settlementId, id));
    expect(row.restoredValue).toBe("20.00");
    expect(row.usableBaseQuantity).toBe(2);
    expect(row.damagedBaseQuantity).toBe(1);
    expect(row.originalMovementId).toBe(data.executions[0].lines[0].movementId);
    const [returned] = await db()
      .select()
      .from(s.inventoryMovements)
      .where(eq(s.inventoryMovements.id, row.returnMovementId!));
    expect(returned.movementType).toBe("RETURN");
    expect(returned.quantity).toBe(2);
    const [cost] = await db()
      .select({ value: sql<string>`SUM(${s.accountingEntries.cost})` })
      .from(s.accountingEntries)
      .where(
        sql`${s.accountingEntries.dedupeKey} IN (${`AFTERCARE_ISSUE:${data.executions[0].id}`},${`AFTERCARE_ISSUE_RETURN:${id}`})`,
      );
    expect(cost.value).toBe("10.00");
    const [variant] = await db()
      .select()
      .from(s.productVariants)
      .where(eq(s.productVariants.id, 1));
    expect(variant.costPrice).toBe("11.27");
    const after = await getAftercareCase(data.case.id, manager);
    expect(after.lines[0].deliveredBaseQuantity).toBe(0);
    expect(after.lines[0].settledBaseQuantity).toBe(3);
    await resolveAftercareCase(
      {
        id: data.case.id,
        expectedVersion: after.case.version,
        resolution: "سويت الكميات والحقوق فعلياً",
        clientRequestId: key(),
      },
      manager,
    );
    expect((await getAftercareCase(data.case.id, manager)).case.status).toBe(
      "RESOLVED",
    );
  });

  it("does not restore consumed reprint materials or charge their expense twice", async () => {
    const data = await prepared("REPRINT", 2);
    const payload = input(data, 0);
    payload.decisions = payload.decisions.map((line) => ({
      ...line,
      consumedBaseQuantity: 2,
      damagedBaseQuantity: 0,
    }));
    const id = await approvedSettlement(payload);
    await postAftercareSettlement(
      { id, expectedVersion: 2, clientRequestId: key() },
      reviewer,
    );
    expect(await stock(2)).toBe(98);
    const returns = await db()
      .select()
      .from(s.inventoryMovements)
      .where(eq(s.inventoryMovements.referenceType, "AFTERCARE_SETTLEMENT"));
    expect(returns).toHaveLength(0);
    const adjustments = await db()
      .select()
      .from(s.accountingEntries)
      .where(eq(s.accountingEntries.dedupeKey, `AFTERCARE_ISSUE_RETURN:${id}`));
    expect(adjustments).toHaveLength(0);
    expect(
      (await getAftercareCase(data.case.id, manager)).lines[0]
        .deliveredBaseQuantity,
    ).toBe(0);
  });

  it("enforces current branch, independent review, independent posting and stale preview without any stock change", async () => {
    const data = await prepared();
    const payload = input(data);
    const preview = await previewAftercareSettlement(payload, manager);
    const command = {
      ...payload,
      previewHash: preview.previewHash,
      clientRequestId: key(),
    };
    await expect(
      requestAftercareSettlement(
        {
          ...command,
          decisions: command.decisions.map((row) => ({
            ...row,
            usableBaseQuantity: 1,
            damagedBaseQuantity: 2,
          })),
        },
        manager,
      ),
    ).rejects.toThrow(/معاينة/);
    const requested = await requestAftercareSettlement(command, manager);
    expect((await requestAftercareSettlement(command, manager)).replay).toBe(
      true,
    );
    await expect(
      approveAftercareSettlement(
        { id: requested.id, expectedVersion: 1, clientRequestId: key() },
        manager,
      ),
    ).rejects.toThrow(/مستقلاً/);
    await expect(
      approveAftercareSettlement(
        { id: requested.id, expectedVersion: 1, clientRequestId: key() },
        foreign,
      ),
    ).rejects.toThrow(/فرع/);
    await approveAftercareSettlement(
      { id: requested.id, expectedVersion: 1, clientRequestId: key() },
      reviewer,
    );
    await expect(
      postAftercareSettlement(
        { id: requested.id, expectedVersion: 2, clientRequestId: key() },
        manager,
      ),
    ).rejects.toThrow(/مستقلاً/);
    expect(await stock()).toBe(87);
    expect(await db().select().from(aftercareSettlementLines)).toHaveLength(0);
  });

  it("preserves original issue on verified pre-pickup cancellation and reissue", async () => {
    const data = await prepared();
    const execution = data.executions[0];
    await expect(
      cancelAftercareExecution(
        {
          id: execution.id,
          expectedVersion: execution.version,
          clientRequestId: key(),
          reason: "تحقق عهدة المكتبة",
          physicalHeldConfirmed: false,
        },
        manager,
      ),
    ).rejects.toThrow(/فعلي/);
    await cancelAftercareExecution(
      {
        id: execution.id,
        expectedVersion: execution.version,
        clientRequestId: key(),
        reason: "تحقق كامل عهدة المكتبة قبل الاستلام",
        physicalHeldConfirmed: true,
      },
      manager,
    );
    const after = await getAftercareCase(data.case.id, manager);
    await prepareAftercareExecution(
      {
        id: data.case.id,
        expectedVersion: after.case.version,
        clientRequestId: key(),
        recipientName: "مستلم",
        recipientPhone: "07700000000",
        deliveryAddress: "عنوان مثبت لإعادة الإرسال",
        deliveryFee: "0",
        reuseExecutionId: execution.id,
        lines: [{ aftercareLineId: data.lines[0].id, baseQuantity: 3 }],
      },
      manager,
    );
    expect(await stock()).toBe(87);
    const issues = await db()
      .select()
      .from(s.inventoryMovements)
      .where(eq(s.inventoryMovements.referenceType, "AFTERCARE"));
    expect(issues).toHaveLength(1);
    const outputs = await db().select().from(aftercareExecutionLines);
    expect(
      outputs.filter((row) => row.reusedFromLineId === execution.lines[0].id),
    ).toHaveLength(1);
  });

  it("requires explicit internal driver but preserves a genuine named external individual carrier", async () => {
    const data = await prepared();
    const execution = data.executions[0];
    const command = {
      id: execution.id,
      expectedVersion: execution.version,
      clientRequestId: key(),
      partyId: 1,
    };
    await expect(dispatchAftercareExecution(command, manager)).rejects.toThrow(
      /المندوب الموظف/,
    );
    await db().insert(s.deliveryParties).values({
      id: 2,
      name: "ناقل خارجي مسمى",
      partyType: "INDIVIDUAL",
      branchId: 1,
      defaultFee: "0",
    });
    const sent = await dispatchAftercareExecution(
      { ...command, partyId: 2, clientRequestId: key() },
      manager,
    );
    const [cn] = await db()
      .select()
      .from(s.deliveryConsignments)
      .where(eq(s.deliveryConsignments.id, sent.consignmentId!));
    expect(cn.partyId).toBe(2);
    expect(cn.assignedUserId).toBeNull();
    expect(await stock()).toBe(87);
    expect(
      await resolveAftercareActor(
        { id: 2, role: "admin", branchId: null },
        { executionId: execution.id },
      ),
    ).toMatchObject({ userId: 2, branchId: 1 });
    await expect(
      resolveAftercareActor(
        { id: 4, role: "manager", branchId: null },
        { executionId: execution.id },
      ),
    ).rejects.toThrow(/فرع/);
  });

  it("rejects administrative cancellation after real handover and requires declared, inspected return before settlement", async () => {
    const data = await prepared();
    const execution = data.executions[0];
    const sent = await dispatchAftercareExecution(
      {
        id: execution.id,
        expectedVersion: execution.version,
        clientRequestId: key(),
        partyId: 1,
        assignedUserId: 5,
      },
      manager,
    );
    const handover = await staffHandoverConsignments(
      {
        consignmentIds: [sent.consignmentId!],
        assignedUserId: 5,
        clientRequestId: key(),
      },
      manager,
    );
    expect(handover.moved).toBe(1);
    await expect(
      cancelAftercareExecution(
        {
          id: execution.id,
          expectedVersion: 2,
          clientRequestId: key(),
          reason: "إلغاء إداري بعد خروج فعلي",
          physicalHeldConfirmed: true,
        },
        manager,
      ),
    ).rejects.toThrow(/استلام/);
    await expect(
      confirmAftercareDelivery(
        {
          id: execution.id,
          expectedVersion: 2,
          clientRequestId: key(),
          result: "RETURNED",
          proof: "استلام مفحوص دون إعلان",
        },
        manager,
      ),
    ).rejects.toThrow(/أعلن الرجوع/);
    await declareAftercareExecutionReturn(
      {
        id: execution.id,
        expectedVersion: 2,
        clientRequestId: key(),
        reason: "تعذر التسليم وطلب العودة",
      },
      manager,
    );
    const declared = await getAftercareCase(data.case.id, manager);
    expect(declared.executions[0].status).toBe("DISPATCHED");
    expect(declared.executions[0].lines[0].custodyBaseQuantity).toBe(3);
    await expect(
      previewAftercareSettlement(input(declared), manager),
    ).rejects.toThrow(/عهدة ناقل/);
    const actualSource = await previewWorkflowSource(
      {
        source: { kind: "aftercareExecution", id: execution.id },
        branchId: 1,
        station: "return",
      },
      manager,
    );
    const receiptCommand = {
      source: {
        kind: actualSource.source.kind,
        id: actualSource.source.id,
        expectedVersion: actualSource.source.version,
      },
      branchId: 1,
      inspected: true as const,
      evidence: "استلمت كامل الثلاث وفحصت القطع فعلياً",
      clientRequestId: key(),
    };
    const actualReceipt = await receiveWorkflowReturn(receiptCommand, manager);
    expect(actualReceipt).toMatchObject({
      mode: "PHYSICAL_RECEIPT",
      aftercareExecutionId: execution.id,
      consignmentIds: [sent.consignmentId],
    });
    expect(
      (await receiveWorkflowReturn(receiptCommand, manager)).idempotentReplay,
    ).toBe(true);
    expect(await stock()).toBe(87);
    const [original] = await db()
      .select()
      .from(s.invoices)
      .where(eq(s.invoices.id, 1));
    expect(original.returnedTotal).toBe("0.00");
    expect(original.paidAmount).toBe("1000.00");
    const received = await getAftercareCase(data.case.id, manager);
    const id = await approvedSettlement(input(received, 3));
    await postAftercareSettlement(
      { id, expectedVersion: 2, clientRequestId: key() },
      reviewer,
    );
    expect(await stock()).toBe(90);
    expect(
      (await getAftercareCase(data.case.id, manager)).lines[0],
    ).toMatchObject({ deliveredBaseQuantity: 0, settledBaseQuantity: 3 });
  });

  it("withdraws an unposted review with its audit history and releases preparation hold", async () => {
    const data = await prepared();
    const payload = input(data);
    const preview = await previewAftercareSettlement(payload, manager);
    const requested = await requestAftercareSettlement(
      { ...payload, previewHash: preview.previewHash, clientRequestId: key() },
      manager,
    );
    await withdrawAftercareSettlement(
      {
        id: requested.id,
        expectedVersion: 1,
        clientRequestId: key(),
        reason: "استكمال دليل فحص أو تصحيح قرار",
      },
      manager,
    );
    expect(
      (
        await db()
          .select()
          .from(aftercareSettlements)
          .where(eq(aftercareSettlements.id, requested.id))
      )[0].status,
    ).toBe("WITHDRAWN");
    expect(
      (await getAftercareCase(data.case.id, manager)).settlement,
    ).toBeNull();
    expect(await stock()).toBe(87);
    expect((await db().select().from(aftercareExecutions))[0].status).toBe(
      "PREPARED",
    );
  });
});
