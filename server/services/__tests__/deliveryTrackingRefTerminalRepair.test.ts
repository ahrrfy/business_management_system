import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import * as schema from "../../../drizzle/schema";
import type { TrpcContext } from "../../context";
import { getDb } from "../../db";
import { deliveryRouter } from "../../routers/deliveryRouter";
import { updateDeliveryParty } from "../delivery/parties";

function db() {
  const database = getDb();
  if (!database) throw new Error("DATABASE_URL not set for tests");
  return database;
}

function adminCaller() {
  return deliveryRouter.createCaller({
    req: { headers: {} },
    res: {},
    sessionId: null,
    platformAdmin: null,
    user: {
      id: 81,
      openId: "tracking_ref_terminal_admin",
      name: "مدير إصلاح البوليصة",
      email: "tracking-terminal@test.local",
      role: "admin",
      branchId: 81,
      isActive: true,
      permissionsOverride: null,
      totpEnabledAt: new Date(),
    },
  } as unknown as TrpcContext);
}

describe("إصلاح رقم بوليصة الإرسالية الطرفية", () => {
  it("يصلح metadata للملغاة دون إعادة تنشيطها ثم يسمح بتحويل الجهة إلى شركة", async () => {
    await db().insert(schema.branches).values({
      id: 81,
      name: "فرع إصلاح البوليصة",
      code: "TRM81",
      type: "MAIN",
    });
    await db().insert(schema.users).values({
      id: 81,
      openId: "tracking_ref_terminal_admin",
      name: "مدير إصلاح البوليصة",
      email: "tracking-terminal@test.local",
      role: "admin",
      loginMethod: "local",
      branchId: 81,
    });
    await db().insert(schema.deliveryParties).values({
      id: 81,
      name: "مندوب تاريخي",
      partyType: "INDIVIDUAL",
      branchId: 81,
    });
    await db().insert(schema.invoices).values({
      id: 81,
      invoiceNumber: "INV-TERMINAL-TRACKING",
      sourceType: "WORKORDER",
      branchId: 81,
      subtotal: "1000.00",
      total: "1000.00",
      createdBy: 81,
    });
    await db().insert(schema.deliveryConsignments).values({
      id: 81,
      consignmentNumber: "CN-TERMINAL-TRACKING",
      branchId: 81,
      partyId: 81,
      invoiceId: 81,
      sourceType: "INVOICE",
      sourceId: 81,
      codAmount: "1000.00",
      status: "CANCELLED",
      parcelStatus: "CANCELLED",
      moneyStatus: "CANCELLED",
      dispatchedBy: 81,
    });

    await expect(adminCaller().updateTrackingRef({
      consignmentId: 81,
      externalTrackingRef: "]C1۰۰۴۴۱۴۴۶",
    })).resolves.toEqual({ consignmentNumber: "CN-TERMINAL-TRACKING" });

    const [repaired] = await db()
      .select({
        externalTrackingRef: schema.deliveryConsignments.externalTrackingRef,
        status: schema.deliveryConsignments.status,
        parcelStatus: schema.deliveryConsignments.parcelStatus,
        moneyStatus: schema.deliveryConsignments.moneyStatus,
      })
      .from(schema.deliveryConsignments)
      .where(eq(schema.deliveryConsignments.id, 81));
    expect(repaired).toEqual({
      externalTrackingRef: "00441446",
      status: "CANCELLED",
      parcelStatus: "CANCELLED",
      moneyStatus: "CANCELLED",
    });

    await expect(updateDeliveryParty(
      { id: 81, partyType: "COMPANY" },
      { userId: 81, branchId: 81 },
    )).resolves.toEqual({ id: 81 });
    const [party] = await db()
      .select({ partyType: schema.deliveryParties.partyType })
      .from(schema.deliveryParties)
      .where(eq(schema.deliveryParties.id, 81));
    expect(party?.partyType).toBe("COMPANY");
  });
});
