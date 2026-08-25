import { and, eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { appRouter } from "../../routers";
import { cancelDeliveryAssignment } from "../delivery/cancellation";
import { dispatchInvoiceToDelivery } from "../delivery/dispatchInvoice";
import { listConsignmentsForParty } from "../delivery/queries";

const TABLES = [
  "deliveryOutbox",
  "deliveryEvents",
  "deliveryLedgerEntries",
  "deliveryRemittanceLines",
  "deliveryRemittances",
  "deliveryConsignments",
  "deliveryPartyMembers",
  "deliveryParties",
  "idempotencyKeys",
  "auditLogs",
  "receipts",
  "invoiceItems",
  "invoices",
  "branchStock",
  "productUnits",
  "productVariants",
  "products",
  "customers",
  "users",
  "branches",
];

const MANAGER = { userId: 1, branchId: 1, role: "manager" };
const SALES = { userId: 2, branchId: 1, role: "sales_rep" };

function db() {
  const d = getDb();
  if (!d) throw new Error("DATABASE_URL not set for tests");
  return d;
}

async function reset() {
  const d = db();
  await d.execute(sql`SET FOREIGN_KEY_CHECKS = 0`);
  for (const table of TABLES)
    await d.execute(sql.raw(`TRUNCATE TABLE \`${table}\``));
  await d.execute(sql`SET FOREIGN_KEY_CHECKS = 1`);
}

async function seed() {
  const d = db();
  await d.insert(s.branches).values([
    { id: 1, name: "الرئيسي", code: "MAIN", type: "MAIN" },
    { id: 2, name: "الفرع الثاني", code: "B2", type: "SALES" },
  ]);
  await d.insert(s.users).values([
    {
      id: 1,
      openId: "manager-1",
      name: "مدير ١",
      email: "m1@test.local",
      role: "manager",
      loginMethod: "local",
      branchId: 1,
    },
    {
      id: 2,
      openId: "sales-1",
      name: "مبيعات",
      email: "sales@test.local",
      role: "sales_rep",
      loginMethod: "local",
      branchId: 1,
    },
    {
      id: 3,
      openId: "courier-1",
      name: "مندوب ١",
      email: "c1@test.local",
      role: "courier",
      loginMethod: "local",
      branchId: 1,
    },
    {
      id: 4,
      openId: "courier-2",
      name: "مندوب ٢",
      email: "c2@test.local",
      role: "courier",
      loginMethod: "local",
      branchId: 1,
    },
    {
      id: 5,
      openId: "manager-2",
      name: "مدير ٢",
      email: "m2@test.local",
      role: "manager",
      loginMethod: "local",
      branchId: 2,
    },
  ]);
  await d
    .insert(s.customers)
    .values({
      id: 1,
      name: "عميل",
      currentBalance: "10000.00",
      creditLimit: "100000.00",
    });
  await d.insert(s.products).values({ id: 1, name: "منتج" });
  await d
    .insert(s.productVariants)
    .values({ id: 1, productId: 1, sku: "DEL-CANCEL", costPrice: "500.00" });
  await d
    .insert(s.productUnits)
    .values({
      id: 1,
      variantId: 1,
      unitName: "قطعة",
      conversionFactor: 1,
      isBaseUnit: true,
    });
  await d
    .insert(s.branchStock)
    .values({ branchId: 1, variantId: 1, quantity: 25 });
  await d.insert(s.deliveryParties).values([
    {
      id: 1,
      partyType: "INDIVIDUAL",
      name: "مندوب أول",
      branchId: 1,
      userId: 3,
      defaultFee: "0",
      currentBalance: "0",
    },
    {
      id: 2,
      partyType: "INDIVIDUAL",
      name: "مندوب ثان",
      branchId: 1,
      userId: 4,
      defaultFee: "0",
      currentBalance: "0",
    },
  ]);
}

async function seedInvoice(
  id = 100,
  status: typeof s.invoices.$inferInsert.status = "PENDING",
) {
  await db()
    .insert(s.invoices)
    .values({
      id,
      invoiceNumber: `INV-CANCEL-${id}`,
      sourceType: "POS",
      sourceId: `cancel-${id}`,
      branchId: 1,
      customerId: 1,
      priceTier: "RETAIL",
      subtotal: "10000.00",
      taxAmount: "0.00",
      discountAmount: "0.00",
      total: "10000.00",
      costTotal: "5000.00",
      paidAmount: "0.00",
      returnedTotal: "0.00",
      status,
      contactName: "الاسم القديم",
      contactPhone: "07800000000",
      createdBy: 2,
    });
}

async function dispatch(
  invoiceId = 100,
  partyId = 1,
  key = `dispatch-${invoiceId}-${partyId}`,
) {
  return dispatchInvoiceToDelivery(
    {
      invoiceId,
      partyId,
      recipientName: "المستلم الأول",
      recipientPhone: "07800000000",
      deliveryAddress: "العنوان الأول",
      deliveryFee: "1000",
      clientRequestId: key,
    },
    SALES,
  );
}

function caller(
  role: string,
  permissionsOverride: Record<string, string> | null,
  id = 2,
  branchId = 1,
) {
  return appRouter.createCaller({
    req: { headers: {} },
    res: { cookie() {}, clearCookie() {} },
    user: { id, role, branchId, permissionsOverride },
  } as any);
}

beforeEach(async () => {
  await reset();
  await seed();
});

describe("cancelDeliveryAssignment — عقد الإلغاء التشغيلي", () => {
  it.each(["ASSIGNED", "FAILED"] as const)(
    "%s: يلغي الإسناد ويحرر COD بلا لمس الفاتورة أو المخزون أو الإيصالات",
    async (parcelStatus) => {
      await seedInvoice();
      await db().insert(s.receipts).values({
        invoiceId: 100,
        branchId: 1,
        direction: "IN",
        amount: "250.00",
        paymentMethod: "CARD",
        referenceNumber: "CONTROL-RECEIPT",
        createdBy: 2,
      });
      const created = await dispatch();
      if (parcelStatus === "FAILED") {
        await db()
          .update(s.deliveryConsignments)
          .set({
            parcelStatus: "FAILED",
            failedAt: new Date(),
            failureReason: "تعذر",
          })
          .where(eq(s.deliveryConsignments.id, created.consignmentId));
      }

      const invoiceBefore = (
        await db().select().from(s.invoices).where(eq(s.invoices.id, 100))
      )[0];
      const stockBefore = (
        await db()
          .select()
          .from(s.branchStock)
          .where(
            and(eq(s.branchStock.branchId, 1), eq(s.branchStock.variantId, 1)),
          )
      )[0];
      const receiptsBefore = await db()
        .select()
        .from(s.receipts)
        .where(eq(s.receipts.invoiceId, 100));

      const result = await cancelDeliveryAssignment(
        {
          consignmentId: created.consignmentId,
          reason: "إلغاء طلب التوصيل بناءً على طلب العميل",
          clientRequestId: `cancel-${parcelStatus.toLowerCase()}-100`,
        },
        MANAGER,
      );

      expect(result.idempotentReplay).toBe(false);
      const cn = (
        await db()
          .select()
          .from(s.deliveryConsignments)
          .where(eq(s.deliveryConsignments.id, created.consignmentId))
      )[0];
      expect(cn).toMatchObject({
        status: "CANCELLED",
        parcelStatus: "CANCELLED",
        moneyStatus: "CANCELLED",
        assignedUserId: null,
        cancellationReason: "إلغاء طلب التوصيل بناءً على طلب العميل",
        cancelledBy: 1,
      });
      expect(cn.cancelledAt).not.toBeNull();
      expect(String(cn.collectedAmount)).toBe("0.00");
      expect(cn.remittanceId).toBeNull();

      const ledger = await db()
        .select()
        .from(s.deliveryLedgerEntries)
        .where(
          eq(s.deliveryLedgerEntries.consignmentId, created.consignmentId),
        );
      expect(ledger.map((row) => [row.entryType, String(row.amount)])).toEqual([
        ["COD_ASSIGNED", "10000.00"],
        ["COD_RELEASED", "10000.00"],
      ]);
      const cancelledEvent = (
        await db()
          .select()
          .from(s.deliveryEvents)
          .where(
            and(
              eq(s.deliveryEvents.consignmentId, created.consignmentId),
              eq(s.deliveryEvents.eventType, "ASSIGNMENT_CANCELLED"),
            ),
          )
      )[0];
      expect(cancelledEvent).toBeTruthy();
      expect((await listConsignmentsForParty(1, true)).rows).toHaveLength(0);

      expect(
        (await db().select().from(s.invoices).where(eq(s.invoices.id, 100)))[0],
      ).toEqual(invoiceBefore);
      expect(
        (
          await db()
            .select()
            .from(s.branchStock)
            .where(
              and(
                eq(s.branchStock.branchId, 1),
                eq(s.branchStock.variantId, 1),
              ),
            )
        )[0],
      ).toEqual(stockBefore);
      expect(
        await db()
          .select()
          .from(s.receipts)
          .where(eq(s.receipts.invoiceId, 100)),
      ).toEqual(receiptsBefore);
    },
  );

  it.each([
    "ACCEPTED",
    "PICKED_UP",
    "OUT_FOR_DELIVERY",
    "DELIVERED",
    "RETURNED",
    "CANCELLED",
  ] as const)("يرفض الحالة %s", async (parcelStatus) => {
    await seedInvoice();
    const created = await dispatch();
    await db()
      .update(s.deliveryConsignments)
      .set({ parcelStatus })
      .where(eq(s.deliveryConsignments.id, created.consignmentId));
    await expect(
      cancelDeliveryAssignment(
        {
          consignmentId: created.consignmentId,
          reason: "سبب صالح للإلغاء",
          clientRequestId: `cancel-reject-${parcelStatus.toLowerCase()}`,
        },
        MANAGER,
      ),
    ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
  });

  it.each(["COLLECTED", "REMITTED"] as const)(
    "يرفض الإرسالية ذات المال %s",
    async (mode) => {
      await seedInvoice();
      const created = await dispatch();
      if (mode === "COLLECTED") {
        await db()
          .update(s.deliveryConsignments)
          .set({ collectedAmount: "1.00" })
          .where(eq(s.deliveryConsignments.id, created.consignmentId));
      } else {
        await db().insert(s.deliveryRemittances).values({
          id: 77,
          remittanceNumber: "DR-CANCEL-77",
          branchId: 1,
          partyId: 1,
          collectedTotal: "0",
          feesTotal: "0",
          netRemitted: "0",
          shortfallTotal: "0",
          status: "BALANCED",
          receivedBy: 1,
        });
        await db()
          .update(s.deliveryConsignments)
          .set({ remittanceId: 77 })
          .where(eq(s.deliveryConsignments.id, created.consignmentId));
      }
      await expect(
        cancelDeliveryAssignment(
          {
            consignmentId: created.consignmentId,
            reason: "سبب صالح للإلغاء",
            clientRequestId: `cancel-money-${mode.toLowerCase()}`,
          },
          MANAGER,
        ),
      ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    },
  );

  it("idempotency: الإعادة لا تكرر التحرير، وتغيير السبب بنفس المفتاح CONFLICT", async () => {
    await seedInvoice();
    const created = await dispatch();
    const input = {
      consignmentId: created.consignmentId,
      reason: "إلغاء موثق",
      clientRequestId: "cancel-idempotent-100",
    };
    expect(
      (await cancelDeliveryAssignment(input, MANAGER)).idempotentReplay,
    ).toBe(false);
    expect(
      (await cancelDeliveryAssignment(input, MANAGER)).idempotentReplay,
    ).toBe(true);
    await expect(
      cancelDeliveryAssignment({ ...input, reason: "سبب مختلف" }, MANAGER),
    ).rejects.toMatchObject({ code: "CONFLICT" });

    const releases = await db()
      .select()
      .from(s.deliveryLedgerEntries)
      .where(
        and(
          eq(s.deliveryLedgerEntries.consignmentId, created.consignmentId),
          eq(s.deliveryLedgerEntries.entryType, "COD_RELEASED"),
        ),
      );
    expect(releases).toHaveLength(1);
    const events = await db()
      .select()
      .from(s.deliveryEvents)
      .where(
        and(
          eq(s.deliveryEvents.consignmentId, created.consignmentId),
          eq(s.deliveryEvents.eventType, "ASSIGNMENT_CANCELLED"),
        ),
      );
    expect(events).toHaveLength(1);
  });

  it("يفرض المدير ونطاق الفرع حتى عند استدعاء الخدمة مباشرة", async () => {
    await seedInvoice();
    const created = await dispatch();
    const input = {
      consignmentId: created.consignmentId,
      reason: "سبب صالح",
      clientRequestId: "cancel-auth-100",
    };
    await expect(cancelDeliveryAssignment(input, SALES)).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    await expect(
      cancelDeliveryAssignment(input, {
        userId: 5,
        branchId: 2,
        role: "manager",
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});

describe("dispatchInvoiceToDelivery — إعادة تنشيط السجل الملغى", () => {
  it("يعيد نفس الإرسالية لجهة جديدة، يسجل COD جديداً، ويحدّث تفاصيل التوصيل", async () => {
    await seedInvoice();
    const first = await dispatch();
    await cancelDeliveryAssignment(
      {
        consignmentId: first.consignmentId,
        reason: "تغيير جهة التوصيل",
        clientRequestId: "cancel-before-reactivation",
      },
      MANAGER,
    );

    const reactivateInput = {
      invoiceId: 100,
      partyId: 2,
      deliveryFee: "1750",
      feeCollection: "COURIER" as const,
      recipientName: "المستلم الجديد",
      recipientPhone: "07711111111",
      deliveryAddress: "العنوان الجديد",
      governorate: "بغداد",
      clientRequestId: "reactivate-invoice-100",
    };
    const reactivated = await dispatchInvoiceToDelivery(reactivateInput, SALES);
    expect(reactivated.consignmentId).toBe(first.consignmentId);
    expect(reactivated.consignmentNumber).toBe(first.consignmentNumber);
    expect(reactivated.reactivated).toBe(true);

    const replay = await dispatchInvoiceToDelivery(reactivateInput, SALES);
    expect(replay.consignmentId).toBe(first.consignmentId);
    expect(replay.idempotentReplay).toBe(true);

    const cn = (
      await db()
        .select()
        .from(s.deliveryConsignments)
        .where(eq(s.deliveryConsignments.id, first.consignmentId))
    )[0];
    expect(cn).toMatchObject({
      partyId: 2,
      assignedUserId: 4,
      status: "DISPATCHED",
      parcelStatus: "ASSIGNED",
      moneyStatus: "UNSETTLED",
      recipientName: "المستلم الجديد",
      recipientPhone: "07711111111",
      deliveryAddress: "العنوان الجديد",
      governorate: "بغداد",
      cancellationReason: null,
      cancelledBy: null,
    });
    expect(cn.cancelledAt).toBeNull();
    expect(String(cn.deliveryFee)).toBe("1750.00");

    const ledger = await db()
      .select()
      .from(s.deliveryLedgerEntries)
      .where(eq(s.deliveryLedgerEntries.consignmentId, first.consignmentId));
    expect(
      ledger.map((row) => [
        Number(row.partyId),
        row.entryType,
        String(row.amount),
      ]),
    ).toEqual([
      [1, "COD_ASSIGNED", "10000.00"],
      [1, "COD_RELEASED", "10000.00"],
      [2, "COD_ASSIGNED", "10000.00"],
    ]);
    expect(
      await db()
        .select()
        .from(s.deliveryConsignments)
        .where(eq(s.deliveryConsignments.invoiceId, 100)),
    ).toHaveLength(1);
    expect(
      await db()
        .select()
        .from(s.deliveryEvents)
        .where(
          and(
            eq(s.deliveryEvents.consignmentId, first.consignmentId),
            eq(s.deliveryEvents.eventType, "ASSIGNMENT_REACTIVATED"),
          ),
        ),
    ).toHaveLength(1);
  });

  it("يمنع الفاتورة SUPERSEDED", async () => {
    await seedInvoice(101, "SUPERSEDED");
    await expect(dispatch(101, 1, "dispatch-superseded-101")).rejects.toThrow(
      /مستبدلة/,
    );
    expect(
      await db()
        .select()
        .from(s.deliveryConsignments)
        .where(eq(s.deliveryConsignments.invoiceId, 101)),
    ).toHaveLength(0);
  });

  it("بوابة الراوتر تسمح sales_rep ذي store=FULL وتحترم السحب الصريح", async () => {
    await seedInvoice(102);
    const allowed = await caller("sales_rep", null).delivery.dispatchInvoice({
      invoiceId: 102,
      partyId: 1,
      clientRequestId: "router-sales-dispatch-102",
    });
    expect(allowed.invoiceId).toBe(102);

    await seedInvoice(103);
    await expect(
      caller("sales_rep", { store: "NONE" }).delivery.dispatchInvoice({
        invoiceId: 103,
        partyId: 1,
        clientRequestId: "router-denied-dispatch-103",
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});
