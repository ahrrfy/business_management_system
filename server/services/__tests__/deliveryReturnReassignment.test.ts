import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { reassignDeliveryConsignment } from "../delivery/parties";

const actor = { userId: 1, branchId: 1, role: "manager" };
function db() {
  const database = getDb();
  if (!database) throw new Error("Isolated test database is required");
  return database;
}

beforeEach(async () => {
  await db()
    .insert(s.branches)
    .values({ id: 1, name: "الرئيسي", code: "MAIN", type: "MAIN" });
  await db()
    .insert(s.users)
    .values({
      id: 1,
      openId: "return-reassignment",
      role: "manager",
      branchId: 1,
    });
  await db()
    .insert(s.deliveryParties)
    .values({
      id: 1,
      name: "شركة التوصيل",
      partyType: "COMPANY",
      currentBalance: "321.00",
      isActive: true,
    });
  await db()
    .insert(s.invoices)
    .values({
      id: 1,
      invoiceNumber: "RETURN-REASSIGN-INV",
      branchId: 1,
      subtotal: "1000.00",
      total: "1000.00",
      paidAmount: "0.00",
      createdBy: 1,
    });
  await db().insert(s.deliveryConsignments).values({
    id: 1,
    consignmentNumber: "RETURN-REASSIGN-CN",
    partyId: 1,
    branchId: 1,
    invoiceId: 1,
    sourceId: 1,
    sourceType: "INVOICE",
    codAmount: "1000.00",
    parcelStatus: "ASSIGNED",
    status: "DISPATCHED",
    externalTrackingRef: "RETURN-REASSIGN-TRACK",
    failureReason: "سبب محفوظ",
    dispatchedBy: 1,
  });
  await db().insert(s.deliveryLedgerEntries).values({
    eventKey: "return-reassignment-existing-ledger",
    partyId: 1,
    branchId: 1,
    consignmentId: 1,
    entryType: "COD_ASSIGNED",
    amount: "1000.00",
    createdBy: 1,
  });
});

async function snapshot() {
  return {
    consignments: await db().select().from(s.deliveryConsignments),
    parties: await db().select().from(s.deliveryParties),
    invoices: await db().select().from(s.invoices),
    ledger: await db().select().from(s.deliveryLedgerEntries),
    events: await db().select().from(s.deliveryEvents),
    outbox: await db().select().from(s.deliveryOutbox),
    keys: await db().select().from(s.idempotencyKeys),
    receipts: await db().select().from(s.receipts),
  };
}
const request = {
  partyId: 1,
  consignmentId: 1,
  assignedUserId: null,
  clientRequestId: "reassignment-guard-request",
};

describe("reassignment preserves return and terminal eligibility", () => {
  it.each(["ASSIGNED", "OUT_FOR_DELIVERY", "FAILED"] as const)(
    "rejects declared return retaining physical %s without any mutation",
    async (parcelStatus) => {
      await db()
        .update(s.deliveryConsignments)
        .set({
          parcelStatus,
          returnDeclaredAt: new Date("2026-10-12T08:00:00Z"),
          returnDeclaredReason: "رفض العميل",
        })
        .where(eq(s.deliveryConsignments.id, 1));
      const before = await snapshot();
      await expect(
        reassignDeliveryConsignment(request, actor),
      ).rejects.toMatchObject({
        code: "PRECONDITION_FAILED",
        message: expect.stringContaining("أُعلن رجوع"),
      });
      expect(await snapshot()).toEqual(before);
    },
  );

  it.each(["DELIVERED", "CANCELLED", "RETURNED", "WRITTEN_OFF"] as const)(
    "rejects financially closed %s even with assignable physical status",
    async (status) => {
      await db()
        .update(s.deliveryConsignments)
        .set({ status, parcelStatus: "FAILED" })
        .where(eq(s.deliveryConsignments.id, 1));
      const before = await snapshot();
      await expect(
        reassignDeliveryConsignment(request, actor),
      ).rejects.toMatchObject({
        code: "PRECONDITION_FAILED",
        message: expect.stringContaining("مغلقة"),
      });
      expect(await snapshot()).toEqual(before);
    },
  );

  it("reassigns a healthy parcel and preserves committed replay after a later return declaration", async () => {
    const before = await snapshot();
    expect(await reassignDeliveryConsignment(request, actor)).toEqual({
      consignmentId: 1,
      replay: false,
    });
    const after = await snapshot();
    expect(after.consignments[0]).toMatchObject({
      parcelStatus: "OUT_FOR_DELIVERY",
      failureReason: null,
    });
    expect(after.ledger).toEqual(before.ledger);
    expect(after.invoices).toEqual(before.invoices);
    expect(after.parties).toEqual(before.parties);
    expect(after.events).toHaveLength(1);
    await db()
      .update(s.deliveryConsignments)
      .set({ returnDeclaredAt: new Date("2026-10-12T09:00:00Z") })
      .where(eq(s.deliveryConsignments.id, 1));
    const declared = await snapshot();
    expect(await reassignDeliveryConsignment(request, actor)).toEqual({
      consignmentId: 1,
      replay: true,
    });
    expect(await snapshot()).toEqual(declared);
    await expect(
      reassignDeliveryConsignment(
        { ...request, clientRequestId: "new-after-declaration" },
        actor,
      ),
    ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    expect(await snapshot()).toEqual(declared);
  });
});
