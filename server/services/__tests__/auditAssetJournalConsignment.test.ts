import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import type { TrpcContext } from "../../context";
import { consignmentRouter } from "../../routers/consignmentRouter";
import {
  createManualJournal,
  type CreateManualJournalInput,
} from "../accounting/manualJournalService";
import { dashboard, disposalLog } from "../assets/reports";
import { updateAsset } from "../assets/update";
import { createProduct } from "../catalogService";
import {
  createConsignmentNote,
  type CreateConsignmentNoteInput,
} from "../consignment/noteService";
import { withTx } from "../tx";

const actor = { userId: 1, branchId: 1, role: "admin" as const };
const auditContext = {
  user: { id: 1, name: "Audit tester", role: "admin" as const },
  req: { ip: "127.0.0.1", headers: {} },
} as unknown as Pick<TrpcContext, "user" | "req">;
const scope = { branchId: null } as const;
function db() {
  const d = getDb();
  if (!d) throw new Error("Missing synthetic test DB");
  return d;
}

beforeEach(async () => {
  await db()
    .insert(s.branches)
    .values([
      { id: 1, code: "MAIN", name: "Audit main", type: "MAIN" },
      { id: 2, code: "SALES", name: "Audit second", type: "SALES" },
    ]);
  await db()
    .insert(s.users)
    .values([
      {
        id: 1,
        openId: "audit-maker",
        name: "Audit maker",
        role: "admin",
        branchId: 1,
        isActive: true,
      },
      {
        id: 2,
        openId: "audit-other",
        name: "Audit other",
        role: "admin",
        branchId: 2,
        isActive: true,
      },
    ]);
  await db()
    .insert(s.accounts)
    .values([
      {
        id: 40,
        code: "5100",
        name: "Audit expense",
        type: "EXPENSE",
        systemRole: "RENT",
        isActive: true,
      },
      {
        id: 45,
        code: "2150",
        name: "Audit accrual",
        type: "LIABILITY",
        systemRole: "ACCRUED_EXPENSES",
        isActive: true,
      },
    ]);
  await db()
    .insert(s.suppliers)
    .values([
      {
        id: 1,
        name: "Audit consignor",
        supplierKind: "CONSIGNOR",
        currentBalance: "10000.00",
        isActive: true,
      },
      {
        id: 2,
        name: "Audit other consignor",
        supplierKind: "CONSIGNOR",
        currentBalance: "10000.00",
        isActive: true,
      },
    ]);
});

function journalInput(): CreateManualJournalInput {
  return {
    clientRequestId: randomUUID(),
    entryDate: "2026-10-01",
    notes: "Audit rent accrual",
    branchId: 1,
    lines: [
      { accountId: 40, debit: "100.00", credit: "0.00" },
      { accountId: 45, debit: "0.00", credit: "100.00" },
    ],
  };
}
const postJournal = (input: CreateManualJournalInput, principal = actor) =>
  withTx((tx) => createManualJournal(tx, input, principal, auditContext));

describe("16-F01 manual journal replay identity", () => {
  it.each(["amount", "date", "notes", "branch", "actor", "account", "party"])(
    "rejects a reused key with changed %s and preserves the committed result",
    async (change) => {
      const input = journalInput();
      const committed = await postJournal(input);
      const changed = structuredClone(input);
      if (change === "amount") {
        changed.lines[0].debit = "200";
        changed.lines[1].credit = "200";
      }
      if (change === "date") changed.entryDate = "2026-10-02";
      if (change === "notes") changed.notes = "Different accrual explanation";
      if (change === "branch") changed.branchId = 2;
      if (change === "account") changed.lines[0].accountId = 45;
      if (change === "party") changed.lines[0].customerId = 100;
      await expect(
        postJournal(
          changed,
          change === "actor" ? { ...actor, userId: 2 } : actor,
        ),
      ).rejects.toMatchObject({ code: "CONFLICT" });
      expect(await db().select().from(s.accountingEntries)).toHaveLength(1);
      expect(await db().select().from(s.journalEntries)).toHaveLength(1);
      expect((await db().select().from(s.accountingEntries))[0].amount).toBe(
        "100.00",
      );
      expect(committed.amount).toBe("100.00");
    },
  );

  it("replays the canonical request after accounts are disabled and the period closes", async () => {
    const input = journalInput();
    const first = await postJournal(input);
    await db().update(s.accounts).set({ isActive: false });
    await db().insert(s.financialPeriods).values({
      cutoffDate: "2026-10-31",
      status: "LOCKED",
      lockedBy: 1,
      lockedAt: new Date(),
    });
    const equivalent = {
      ...input,
      notes: ` ${input.notes} `,
      lines: [...input.lines].reverse().map((l) => ({
        ...l,
        debit: String(l.debit === "0.00" ? "0" : "100"),
        credit: String(l.credit === "0.00" ? "0" : "100"),
      })),
    };
    expect(await postJournal(equivalent)).toEqual(first);
    expect(await db().select().from(s.accountingEntries)).toHaveLength(1);
  });

  it("does not reserve the key or leave a partial journal when validation rolls back", async () => {
    const input = journalInput();
    await expect(
      postJournal({
        ...input,
        lines: [input.lines[0], { ...input.lines[1], credit: "99" }],
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(await db().select().from(s.accountingEntries)).toHaveLength(0);
    expect(await db().select().from(s.journalEntries)).toHaveLength(0);
    expect(await db().select().from(s.journalLines)).toHaveLength(0);
    expect((await postJournal(input)).amount).toBe("100.00");
  });
});

async function seedAsset(
  status: "active" | "maintenance" | "retired" | "disposed",
  id = 100,
) {
  await db()
    .insert(s.fixedAssets)
    .values({
      id,
      code: `AST-AUDIT-${id}`,
      name: "Audit printer",
      category: "printing",
      branchId: 1,
      purchaseDate: "2024-01-01",
      purchaseValue: "100000.00",
      salvageValue: "0",
      usefulLifeYears: 5,
      accumulatedDepreciation: "20000.00",
      status,
      disposalDate:
        status === "retired" || status === "disposed" ? "2025-01-01" : null,
    });
  return id;
}
const assetInput = {
  name: "Audit printer changed",
  category: "printing",
  branchId: 1,
  purchaseDate: "2024-01-01",
  purchaseValue: "100000",
  usefulLifeYears: 10,
  salvageValue: "0",
  depreciationMethod: "sl" as const,
};

describe("17-F01/F02 derecognized assets", () => {
  it.each(["retired", "disposed"] as const)(
    "rejects estimate changes after %s with no row or ledger mutation",
    async (status) => {
      const id = await seedAsset(status);
      const before = (
        await db().select().from(s.fixedAssets).where(eq(s.fixedAssets.id, id))
      )[0];
      await expect(updateAsset(id, assetInput, actor)).rejects.toThrow(
        /لا يمكن تعديل أصل/,
      );
      expect(
        (
          await db()
            .select()
            .from(s.fixedAssets)
            .where(eq(s.fixedAssets.id, id))
        )[0],
      ).toEqual(before);
      expect(await db().select().from(s.accountingEntries)).toHaveLength(0);
    },
  );

  it("allows a current asset estimate correction and posts exactly one adjustment", async () => {
    const id = await seedAsset("active");
    await updateAsset(id, assetInput, actor);
    expect((await db().select().from(s.fixedAssets))[0].usefulLifeYears).toBe(
      10,
    );
    expect(await db().select().from(s.accountingEntries)).toHaveLength(1);
  });

  it("excludes retired assets from every current dashboard aggregate while retaining disposal history", async () => {
    await seedAsset("retired", 100);
    const retired = (await db().select().from(s.fixedAssets))[0];
    const report = await dashboard(scope);
    expect(report.kpis).toEqual({
      totalAssets: 0,
      purchaseValue: 0,
      bookValue: 0,
      accumulated: 0,
      inMaintenance: 0,
      inCustody: 0,
    });
    expect(report.byCategory).toEqual([]);
    expect(report.byBranch).toEqual([]);
    expect(report.needsAction).toEqual([]);
    expect((await disposalLog(scope)).map((a) => a.id)).toEqual([100]);
    expect((await db().select().from(s.fixedAssets))[0]).toEqual(retired);
  });
});

async function noteInput(): Promise<CreateConsignmentNoteInput> {
  const sku = `AUDIT-${randomUUID().slice(0, 8)}`;
  await createProduct(
    {
      name: "Audit consignment",
      isConsignment: true,
      consignorId: 1,
      variants: [
        {
          sku,
          costPrice: "10",
          units: [
            {
              unitName: "piece",
              conversionFactor: "1",
              isBaseUnit: true,
              prices: [{ priceTier: "RETAIL", price: "20" }],
            },
          ],
        },
      ],
    },
    actor,
  );
  const [v] = await db()
    .select()
    .from(s.productVariants)
    .where(eq(s.productVariants.sku, sku));
  const [u] = await db()
    .select()
    .from(s.productUnits)
    .where(eq(s.productUnits.variantId, v.id));
  return {
    noteType: "DEPOSIT",
    consignorId: 1,
    branchId: 1,
    clientRequestId: randomUUID(),
    notes: "Audit stock receipt",
    lines: [
      {
        lineDirection: "IN",
        variantId: v.id,
        productUnitId: u.id,
        quantity: "10",
      },
    ],
  };
}

describe("18-F01 consignment replay identity and atomicity", () => {
  it("persists the canonical fingerprint and verifies complete legacy evidence without rewriting history", async () => {
    const input = await noteInput();
    const first = await createConsignmentNote(input, actor);
    const [saved] = await db().select().from(s.consignmentNotes);
    expect(saved.requestPayloadHash).toMatch(/^[a-f0-9]{64}$/);
    await db()
      .update(s.consignmentNotes)
      .set({ requestPayloadHash: null })
      .where(eq(s.consignmentNotes.id, first.noteId));
    expect(await createConsignmentNote(input, actor)).toMatchObject({
      noteId: first.noteId,
      idempotentReplay: true,
    });
    await expect(
      createConsignmentNote(
        { ...input, lines: input.lines.map((l) => ({ ...l, quantity: "11" })) },
        actor,
      ),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect(
      (await db().select().from(s.consignmentNotes))[0].requestPayloadHash,
    ).toBeNull();
    expect(await db().select().from(s.inventoryMovements)).toHaveLength(1);
  });

  it.each(["quantity", "consignor", "branch", "actor", "notes", "attachment"])(
    "rejects changed %s without a second stock or financial effect",
    async (change) => {
      const input = await noteInput();
      await createConsignmentNote(input, actor);
      const changed = structuredClone(input);
      if (change === "quantity") changed.lines[0].quantity = "20";
      if (change === "consignor") changed.consignorId = 2;
      if (change === "branch") changed.branchId = 2;
      if (change === "notes") changed.notes = "Changed stock receipt";
      if (change === "attachment") changed.attachmentUrl = "different-evidence";
      await expect(
        createConsignmentNote(
          changed,
          change === "actor" ? { ...actor, userId: 2 } : actor,
        ),
      ).rejects.toMatchObject({ code: "CONFLICT" });
      expect(await db().select().from(s.consignmentNotes)).toHaveLength(1);
      expect(await db().select().from(s.inventoryMovements)).toHaveLength(1);
      expect((await db().select().from(s.branchStock))[0].quantity).toBe(10);
      expect(await db().select().from(s.accountingEntries)).toHaveLength(0);
    },
  );

  it("replays after the consignor and product unit become inactive", async () => {
    const input = await noteInput();
    const first = await createConsignmentNote(input, actor);
    await db()
      .update(s.suppliers)
      .set({ isActive: false })
      .where(eq(s.suppliers.id, 1));
    await db()
      .update(s.productUnits)
      .set({ isActive: false })
      .where(eq(s.productUnits.id, input.lines[0].productUnitId));
    const replay = await createConsignmentNote(
      {
        ...input,
        lines: input.lines.map((l) => ({ ...l, quantity: "10.000" })),
      },
      actor,
    );
    expect(replay).toMatchObject({
      noteId: first.noteId,
      idempotentReplay: true,
    });
    expect(await db().select().from(s.inventoryMovements)).toHaveLength(1);
  });

  it("allows only one semantic payload to win a concurrent key collision", async () => {
    const input = await noteInput();
    const changed = {
      ...input,
      lines: input.lines.map((l) => ({ ...l, quantity: "20" })),
    };
    const results = await Promise.allSettled([
      createConsignmentNote(input, actor),
      createConsignmentNote(changed, actor),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const failure = results.find((r) => r.status === "rejected");
    expect(failure).toMatchObject({
      status: "rejected",
      reason: { code: "CONFLICT" },
    });
    expect(await db().select().from(s.consignmentNotes)).toHaveLength(1);
    expect(await db().select().from(s.inventoryMovements)).toHaveLength(1);
    expect([10, 20]).toContain(
      (await db().select().from(s.branchStock))[0].quantity,
    );
  });

  it("rolls back an exchange if the withdrawal is insufficient and allows the same key after correction", async () => {
    const input = await noteInput();
    const exchange = {
      ...input,
      noteType: "EXCHANGE" as const,
      lines: [
        input.lines[0],
        { ...input.lines[0], lineDirection: "OUT" as const, quantity: "20" },
      ],
    };
    await expect(createConsignmentNote(exchange, actor)).rejects.toMatchObject({
      code: "CONFLICT",
    });
    expect(await db().select().from(s.consignmentNotes)).toHaveLength(0);
    expect(await db().select().from(s.inventoryMovements)).toHaveLength(0);
    expect(await db().select().from(s.branchStock)).toHaveLength(0);
    const created = await createConsignmentNote(input, actor);
    expect(created.idempotentReplay).toBe(false);
  });
});

function caller() {
  return consignmentRouter.createCaller({
    req: { headers: {}, ip: "127.0.0.1" },
    res: {},
    user: {
      id: 1,
      name: "Audit maker",
      role: "admin",
      branchId: 1,
      isActive: true,
    },
  } as unknown as TrpcContext);
}

describe("18-F02 settlement payment evidence end to end", () => {
  it.each(["CARD", "TRANSFER"] as const)(
    "preserves actual %s evidence on the pending voucher and canonical replay",
    async (paymentMethod) => {
      const input = {
        consignorId: 1,
        amount: "100",
        paymentMethod,
        branchId: 1,
        clientRequestId: randomUUID(),
        referenceNumber: "BANK-AUDIT-123",
        cardLastFour: paymentMethod === "CARD" ? "4321" : undefined,
      };
      const result = await caller().createSettlement(input);
      expect(result.approvalStatus).toBe("PENDING_APPROVAL");
      const [receipt] = await db()
        .select()
        .from(s.receipts)
        .where(eq(s.receipts.id, result.receiptId));
      expect(receipt.referenceNumber).toBe(input.referenceNumber);
      expect(receipt.cardLastFour).toBe(input.cardLastFour ?? null);
      expect(receipt.paymentMethod).toBe(paymentMethod);
      expect(receipt.cashBucket).toBeNull();
      expect(
        (await db().select().from(s.suppliers).where(eq(s.suppliers.id, 1)))[0]
          .currentBalance,
      ).toBe("10000.00");
      expect((await caller().createSettlement(input)).receiptId).toBe(
        result.receiptId,
      );
      expect(await db().select().from(s.receipts)).toHaveLength(1);
      await expect(
        caller().createSettlement({
          ...input,
          referenceNumber: "CHANGED-REFERENCE",
        }),
      ).rejects.toMatchObject({ code: "CONFLICT" });
      expect(await db().select().from(s.receipts)).toHaveLength(1);
      expect(await db().select().from(s.accountingEntries)).toHaveLength(0);
    },
  );

  it.each(["CARD", "TRANSFER"] as const)(
    "rejects %s without payment evidence before creating a voucher",
    async (paymentMethod) => {
      await expect(
        caller().createSettlement({
          consignorId: 1,
          amount: "100",
          paymentMethod,
          branchId: 1,
          clientRequestId: randomUUID(),
        }),
      ).rejects.toMatchObject({ code: "BAD_REQUEST" });
      expect(await db().select().from(s.receipts)).toHaveLength(0);
    },
  );
});
