import { createRealtimeEvent, REALTIME_EVENT_TYPES } from "@shared/realtimeEvents";
import { scheduleFinancialRefresh } from "../../realtime/financialRefresh";
import { and, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import * as realtime from "../../realtime";
import { withTx } from "../tx";
import { openShift } from "../shiftService";
import { money } from "../money";
import { recordDeliveryFeeHeldInTx } from "../delivery/feeHeld";
import { cancelDeliveryAssignmentInTx } from "../delivery/cancellation";
import { dispatchInvoiceToDelivery } from "../delivery/dispatchInvoice";
import {
  assertStandaloneConsignmentTx,
  dispatchInvoiceShipment,
  getShipmentDetails,
  listShipmentInvoiceCandidates,
  loadShipmentMembersTx,
} from "../delivery/shipments";

const actor = { userId: 1, branchId: 1, role: "admin" };
const cashier = { userId: 1, branchId: 1, role: "cashier" };
const input = {
  invoiceId: 2,
  invoiceIds: [2, 1],
  partyId: 1,
  deliveryFee: "1500",
  externalTrackingRef: "00441446",
  recipientName: "المستلم",
  recipientPhone: "07701234567",
  deliveryAddress: "بغداد",
  notes: "فواتير العميل معاً",
  clientRequestId: "shipment-one",
};
function db() {
  const d = getDb();
  if (!d) throw new Error("test database required");
  return d;
}

async function holdDeliveryFee(invoiceId: number, amount = "1500") {
  const existing = (
    await db()
      .select()
      .from(s.shifts)
      .where(
        and(eq(s.shifts.userId, actor.userId), eq(s.shifts.status, "OPEN")),
      )
      .limit(1)
  )[0];
  const shiftId = existing
    ? Number(existing.id)
    : (
        await openShift(
          { branchId: 1, openingBalance: "0", shiftType: "RECEPTION" },
          actor,
        )
      ).shiftId;
  return withTx((tx) =>
    recordDeliveryFeeHeldInTx(tx, {
      invoiceId,
      branchId: 1,
      shiftId,
      amount: money(amount),
      actorUserId: actor.userId,
      description: "أمانة أجرة توصيل سابقة للتجميع",
    }),
  );
}

beforeEach(async () => {
  vi.restoreAllMocks();
  await db()
    .insert(s.branches)
    .values([
      { id: 1, name: "الرئيسي", code: "SHIP1", type: "MAIN" },
      { id: 2, name: "الفرع الثاني", code: "SHIP2", type: "SALES" },
    ]);
  await db().insert(s.users).values({
    id: 1,
    openId: "shipment-writer",
    name: "كاتب الشحنة",
    email: "shipment@test.local",
    role: "admin",
    branchId: 1,
  });
  await db()
    .insert(s.customers)
    .values([
      { id: 1, name: "عميل أول", phone: "+9647701234567", currentBalance: "0" },
      { id: 2, name: "عميل آخر", phone: "+9647701234568", currentBalance: "0" },
    ]);
  await db()
    .insert(s.deliveryParties)
    .values([
      {
        id: 1,
        name: "شركة أولى",
        partyType: "COMPANY",
        branchId: 1,
        defaultFee: "1500",
      },
      {
        id: 2,
        name: "شركة ثانية",
        partyType: "COMPANY",
        branchId: 1,
        defaultFee: "2000",
      },
    ]);
  await db()
    .insert(s.invoices)
    .values([
      {
        id: 1,
        invoiceNumber: "SHIP-INV-1",
        sourceType: "POS",
        customerId: 1,
        branchId: 1,
        subtotal: "1000",
        total: "1000",
        createdBy: 1,
      },
      {
        id: 2,
        invoiceNumber: "SHIP-INV-2",
        sourceType: "WORKORDER",
        customerId: 1,
        branchId: 1,
        subtotal: "2500",
        total: "2500",
        paidAmount: "400",
        returnedTotal: "100",
        createdBy: 1,
      },
      {
        id: 3,
        invoiceNumber: "SHIP-INV-3",
        sourceType: "POS",
        customerId: 2,
        branchId: 1,
        subtotal: "1000",
        total: "1000",
        createdBy: 1,
      },
      {
        id: 4,
        invoiceNumber: "SHIP-INV-4",
        sourceType: "POS",
        customerId: 1,
        branchId: 2,
        subtotal: "1000",
        total: "1000",
        createdBy: 1,
      },
      {
        id: 5,
        invoiceNumber: "SHIP-INV-5",
        sourceType: "ONLINE",
        customerId: 1,
        branchId: 1,
        subtotal: "1000",
        total: "1000",
        createdBy: 1,
      },
      {
        id: 6,
        invoiceNumber: "SHIP-INV-6",
        sourceType: "POS",
        branchId: 1,
        contactName: "عابر",
        contactPhone: "٠٧٧٠١٢٣٤٥٦٧",
        subtotal: "1000",
        total: "1000",
        createdBy: 1,
      },
      {
        id: 7,
        invoiceNumber: "SHIP-INV-7",
        sourceType: "POS",
        branchId: 1,
        contactName: "عابر",
        contactPhone: "+9647701234567",
        subtotal: "1000",
        total: "1000",
        createdBy: 1,
      },
      {
        id: 8,
        invoiceNumber: "SHIP-INV-8",
        sourceType: "POS",
        branchId: 1,
        contactName: "عابر بلا هاتف",
        subtotal: "1000",
        total: "1000",
        createdBy: 1,
      },
    ]);
});

describe("شحنة واحدة لعدة فواتير مع استقلال الأثر المالي", () => {
  it("أمانة أجرة القائد تبقى مرتبطة بإرساليته عند تطابق COUNTER والمبلغ", async () => {
    await holdDeliveryFee(1);
    const result = await dispatchInvoiceShipment(
      { ...input, feeCollection: "COUNTER" },
      cashier,
    );
    expect(
      result.members.map((row) => [
        Number(row.invoiceId),
        row.deliveryFee,
        row.feeCollection,
      ]),
    ).toEqual([
      [1, "1500.00", "COUNTER"],
      [2, "0.00", "COURIER"],
    ]);
    expect(await db().select().from(s.receipts)).toMatchObject([
      {
        invoiceId: 1,
        direction: "IN",
        amount: "1500.00",
        referenceNumber: "DLV-FEE-INV-1",
      },
    ]);
  });

  it("أمانة أجرة الفاتورة الثانية تجعلها القائد دون نقل الإيصال وتحفظ القائد عند إعادة الإسناد", async () => {
    await holdDeliveryFee(2);
    const receiptsBefore = await db().select().from(s.receipts);
    const entriesBefore = await db().select().from(s.accountingEntries);
    await expect(dispatchInvoiceShipment(input, cashier)).rejects.toThrow(
      /أمانة أجرة.*مقبوضة في الاستقبال/,
    );
    expect(await db().select().from(s.deliveryConsignments)).toHaveLength(0);
    expect(await db().select().from(s.deliveryShipmentMembers)).toHaveLength(0);
    expect(await db().select().from(s.deliveryLedgerEntries)).toHaveLength(0);
    expect(await db().select().from(s.idempotencyKeys)).toHaveLength(0);
    expect(await db().select().from(s.receipts)).toEqual(receiptsBefore);
    expect(await db().select().from(s.accountingEntries)).toEqual(
      entriesBefore,
    );
    const result = await dispatchInvoiceShipment(
      { ...input, feeCollection: "COUNTER" },
      cashier,
    );
    expect(result.invoiceId).toBe(2);
    expect(
      result.members.map((row) => [
        Number(row.invoiceId),
        row.deliveryFee,
        row.feeCollection,
        row.externalTrackingRef,
      ]),
    ).toEqual([
      [2, "1500.00", "COUNTER", "00441446"],
      [1, "0.00", "COURIER", null],
    ]);
    expect(await db().select().from(s.receipts)).toEqual(receiptsBefore);
    expect(await db().select().from(s.accountingEntries)).toEqual(
      entriesBefore,
    );
    const replay = await dispatchInvoiceShipment(
      { ...input, feeCollection: "COUNTER", invoiceIds: [1, 2] },
      cashier,
    );
    expect(replay.invoiceId).toBe(2);
    expect(replay.consignmentId).toBe(result.consignmentId);
    await withTx(async (tx) => {
      for (const member of result.members)
        await cancelDeliveryAssignmentInTx(
          tx,
          {
            consignmentId: member.id,
            reason: "إعادة إسناد الشحنة",
            clientRequestId: `fee-owner-cancel-${member.id}`,
          },
          actor,
          { assertAuthority: false, shipmentMember: true },
        );
    });
    const reassigned = await dispatchInvoiceShipment(
      {
        ...input,
        feeCollection: "COUNTER",
        partyId: 2,
        externalTrackingRef: "HELD-REASSIGNED",
        clientRequestId: "held-reassign",
      },
      cashier,
    );
    expect(reassigned.invoiceId).toBe(2);
    expect(reassigned.leaderConsignmentId).toBe(result.leaderConsignmentId);
    expect(
      reassigned.members.find((row) => Number(row.invoiceId) === 2),
    ).toMatchObject({
      feeCollection: "COUNTER",
      deliveryFee: "1500.00",
      externalTrackingRef: "HELD-REASSIGNED",
    });
    expect(await db().select().from(s.receipts)).toEqual(receiptsBefore);
  });

  it("أمانة أجرة على عدة فواتير تمنع التجميع حتى مع COUNTER صالح على القائد", async () => {
    await holdDeliveryFee(1);
    await holdDeliveryFee(2, "500");
    await expect(
      dispatchInvoiceShipment({ ...input, feeCollection: "COUNTER" }, cashier),
    ).rejects.toThrow(/أمانة أجرة.*عدة فواتير/);
    expect(await db().select().from(s.deliveryConsignments)).toHaveLength(0);
    expect(await db().select().from(s.receipts)).toHaveLength(2);
    expect(
      (await db().select().from(s.accountingEntries)).map(
        (row) => row.entryType,
      ),
    ).toEqual(["DELIVERY_FEE_HELD", "DELIVERY_FEE_HELD"]);
  });

  it.each(["COURIER", "SHOP"] as const)(
    "أمانة أجرة القائد لا تُهمل عند اختيار %s",
    async (feeCollection) => {
      await holdDeliveryFee(1);
      await expect(
        dispatchInvoiceShipment({ ...input, feeCollection }, cashier),
      ).rejects.toThrow(/أمانة أجرة.*مقبوضة في الاستقبال/);
      await expect(
        dispatchInvoiceToDelivery(
          {
            invoiceId: 1,
            partyId: 1,
            deliveryFee: "1500",
            feeCollection,
            externalTrackingRef: "SINGLE-HELD",
            clientRequestId: `single-held-${feeCollection}`,
          },
          cashier,
        ),
      ).rejects.toThrow(/أمانة أجرة.*مقبوضة في الاستقبال/);
      expect(await db().select().from(s.deliveryConsignments)).toHaveLength(0);
    },
  );

  it("أمانة أجرة القائد ترفض مبلغ COUNTER غير المطابق وتبقي الإيصال كما هو", async () => {
    await holdDeliveryFee(1);
    await expect(
      dispatchInvoiceShipment(
        { ...input, feeCollection: "COUNTER", deliveryFee: "1000" },
        cashier,
      ),
    ).rejects.toThrow(/يجب أن تساوي الأجرة/);
    expect(await db().select().from(s.deliveryConsignments)).toHaveLength(0);
    expect(await db().select().from(s.receipts)).toMatchObject([
      { invoiceId: 1, amount: "1500.00" },
    ]);
  });

  it("يربط فواتير البيع وأمر الشغل ذرياً؛ البوليصة والأجرة للقائد فقط، والنشر بعد الالتزام", async () => {
    const transaction = vi.spyOn(db(), "transaction");
    const publishedAfterCommit: boolean[] = [];
    const publish = vi
      .spyOn(realtime, "publishRealtimeEvent")
      .mockImplementation((event, payload, scope) => {
        if (event === REALTIME_EVENT_TYPES.DELIVERY_DISPATCHED) {
          publishedAfterCommit.push(
            transaction.mock.settledResults.at(-1)?.type === "fulfilled",
          );
        }
        return createRealtimeEvent(event, payload, scope);
      });
    // An independent debounced financial refresh must not count as another invoice dispatch.
    scheduleFinancialRefresh(1);
    await new Promise((resolve) => setTimeout(resolve, 450));
    const before = await db().select().from(s.invoices);
    const result = await dispatchInvoiceShipment(input, cashier);
    expect(result.codAmount).toBe("3000.00");
    expect(result.remainingAmount).toBe("3000.00");
    expect(result.members.map((row) => row.invoiceRemaining)).toEqual([
      "1000.00",
      "2000.00",
    ]);
    expect(result.deliveryFee).toBe("1500.00");
    expect(result.members.map((row) => Number(row.invoiceId))).toEqual([1, 2]);
    expect(result.leaderConsignmentId).toBe(result.members[0].id);
    expect(result.members.map((row) => row.externalTrackingRef)).toEqual([
      "00441446",
      null,
    ]);
    expect(result.members.map((row) => row.deliveryFee)).toEqual([
      "1500.00",
      "0.00",
    ]);
    expect(await db().select().from(s.deliveryShipmentMembers)).toHaveLength(2);
    expect(
      (await db().select().from(s.deliveryLedgerEntries))
        .map((row) => row.amount)
        .sort(),
    ).toEqual(["1000.00", "2000.00"]);
    expect(await db().select().from(s.invoices)).toEqual(before);
    expect(await db().select().from(s.receipts)).toHaveLength(0);
    expect(
      await db()
        .select()
        .from(s.auditLogs)
        .where(eq(s.auditLogs.action, "delivery.dispatchInvoiceShipment")),
    ).toHaveLength(1);
    const dispatched = publish.mock.calls.filter(
      ([event]) => event === REALTIME_EVENT_TYPES.DELIVERY_DISPATCHED,
    );
    expect(dispatched).toHaveLength(2);
    expect(
      dispatched
        .map(([, payload]) => (payload as { invoiceId: number }).invoiceId)
        .sort(),
    ).toEqual([1, 2]);
    expect(publishedAfterCommit).toEqual([true, true]);
    expect(
      publish.mock.calls.some(
        ([event]) => event === REALTIME_EVENT_TYPES.FINANCIAL_DATA_CHANGED,
      ),
    ).toBe(true);
    expect(
      await getShipmentDetails(result.members[1].id, cashier),
    ).toMatchObject({
      leaderConsignmentId: result.leaderConsignmentId,
      memberCount: 2,
      codAmount: "3000.00",
    });
  });

  it("إعادة الطلب مع ترتيب فواتير مختلف تعيد نفس الشحنة بلا أحداث أو نشر مكرر", async () => {
    const publish = vi.spyOn(realtime, "publishRealtimeEvent");
    const first = await dispatchInvoiceShipment(input, cashier);
    await db()
      .update(s.deliveryParties)
      .set({ isActive: false })
      .where(eq(s.deliveryParties.id, 1));
    const second = await dispatchInvoiceShipment(
      { ...input, invoiceIds: [1, 2] },
      cashier,
    );
    expect(second).toMatchObject({
      consignmentId: first.consignmentId,
      idempotentReplay: true,
    });
    expect(await db().select().from(s.deliveryConsignments)).toHaveLength(2);
    expect(await db().select().from(s.deliveryEvents)).toHaveLength(2);
    expect(await db().select().from(s.idempotencyKeys)).toHaveLength(1);
    expect(
      publish.mock.calls.filter(
        ([event]) => event === REALTIME_EVENT_TYPES.DELIVERY_DISPATCHED,
      ),
    ).toHaveLength(2);
    await expect(
      dispatchInvoiceShipment({ ...input, notes: "ملاحظة مختلفة" }, cashier),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(
      dispatchInvoiceShipment(
        { ...input, partialDispatchConfirmed: true },
        cashier,
      ),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("يقفل سباق طلبين متماثلين على قفل الجهة ويعيد نتيجة واحدة", async () => {
    const results = await Promise.all([
      dispatchInvoiceShipment(input, cashier),
      dispatchInvoiceShipment(input, cashier),
    ]);
    expect(new Set(results.map((row) => row.consignmentId)).size).toBe(1);
    expect(results.filter((row) => row.idempotentReplay)).toHaveLength(1);
    expect(await db().select().from(s.deliveryConsignments)).toHaveLength(2);
  });

  it("يرد كل آثار الفاتورة الأولى إن فشلت فاتورة لاحقة، ولا ينشر حدثاً", async () => {
    const publish = vi.spyOn(realtime, "publishRealtimeEvent");
    await expect(
      dispatchInvoiceShipment(
        { ...input, invoiceIds: [1, 5], invoiceId: 1 },
        cashier,
      ),
    ).rejects.toThrow(/متجر إلكتروني/);
    for (const table of [
      s.deliveryConsignments,
      s.deliveryShipmentMembers,
      s.deliveryLedgerEntries,
      s.deliveryEvents,
      s.deliveryOutbox,
      s.idempotencyKeys,
      s.auditLogs,
    ]) {
      expect(await db().select().from(table)).toHaveLength(0);
    }
    expect(
      publish.mock.calls.filter(
        ([event]) => event === REALTIME_EVENT_TYPES.DELIVERY_DISPATCHED,
      ),
    ).toHaveLength(0);
  });

  it("يرفض العملاء المختلفين والفروع المختلطة وتكرار الفاتورة قبل أثر مالي", async () => {
    await expect(
      dispatchInvoiceShipment(
        { ...input, invoiceIds: [1, 3], invoiceId: 1 },
        actor,
      ),
    ).rejects.toThrow(/العميل نفسه/);
    await expect(
      dispatchInvoiceShipment(
        { ...input, invoiceIds: [1, 4], invoiceId: 1 },
        actor,
      ),
    ).rejects.toThrow(/أكثر من فرع/);
    await expect(
      dispatchInvoiceShipment(
        { ...input, invoiceIds: [1, 1], invoiceId: 1 },
        actor,
      ),
    ).rejects.toThrow(/فاتورة مختلفة/);
    expect(await db().select().from(s.deliveryConsignments)).toHaveLength(0);
  });

  it("يفرض عزل الفرع قبل replay وقراءة التفاصيل والمرشحين", async () => {
    const result = await dispatchInvoiceShipment(input, cashier);
    const otherBranch = { ...cashier, branchId: 2 };
    await expect(
      dispatchInvoiceShipment(input, otherBranch),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      getShipmentDetails(result.consignmentId, otherBranch),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      listShipmentInvoiceCandidates(1, otherBranch),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("يوحد هاتف الزبون العابر ولا يجمع فاتورة بلا هاتف أو مع حساب مسجل", async () => {
    const candidates = await listShipmentInvoiceCandidates(6, cashier);
    expect(candidates.candidates.map((row) => Number(row.id)).sort()).toEqual([
      7,
    ]);
    const result = await dispatchInvoiceShipment(
      { ...input, invoiceId: 6, invoiceIds: [6, 7] },
      cashier,
    );
    expect(result.memberCount).toBe(2);
    await expect(
      dispatchInvoiceShipment(
        {
          ...input,
          invoiceId: 6,
          invoiceIds: [6, 8],
          clientRequestId: "anonymous-no-phone",
        },
        cashier,
      ),
    ).rejects.toThrow(/هاتف موحد/);
    await expect(
      dispatchInvoiceShipment(
        {
          ...input,
          invoiceId: 1,
          invoiceIds: [1, 6],
          clientRequestId: "anonymous-account",
        },
        cashier,
      ),
    ).rejects.toThrow(/العميل نفسه/);
  });

  it("يبقي بوليصة الشركة إلزامية وفريدة دون تكرارها على الأعضاء", async () => {
    await expect(
      dispatchInvoiceShipment({ ...input, externalTrackingRef: null }, cashier),
    ).rejects.toThrow(/بوليصة الشركة مطلوب/);
    const result = await dispatchInvoiceShipment(input, cashier);
    await expect(
      dispatchInvoiceShipment(
        {
          ...input,
          invoiceId: 6,
          invoiceIds: [6, 7],
          clientRequestId: "tracking-duplicate",
        },
        cashier,
      ),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect(await db().select().from(s.deliveryConsignments)).toHaveLength(2);
    expect(
      result.members.filter((row) => row.externalTrackingRef != null),
    ).toHaveLength(1);
  });

  it("يحمي كل عضو والقائد من الإسناد المنفرد حتى بعد إلغاء الشحنة، ويدعم إعادة إسنادها كاملة", async () => {
    const first = await dispatchInvoiceShipment(input, cashier);
    await withTx(async (tx) => {
      for (const row of first.members)
        await cancelDeliveryAssignmentInTx(
          tx,
          {
            consignmentId: row.id,
            reason: "تبديل جهة التوصيل",
            clientRequestId: `cancel-member-${row.id}`,
          },
          actor,
          { assertAuthority: false, shipmentMember: true },
        );
    });
    const cancelledCandidates = await listShipmentInvoiceCandidates(2, cashier);
    expect(cancelledCandidates.requiredInvoiceIds).toEqual([1, 2]);
    expect(
      cancelledCandidates.candidates.map((row) => Number(row.invoiceId)),
    ).toEqual([1]);
    for (const row of first.members) {
      await expect(
        dispatchInvoiceToDelivery(
          {
            invoiceId: Number(row.invoiceId),
            partyId: 2,
            externalTrackingRef: "REASSIGN",
            clientRequestId: `single-${row.id}`,
          },
          cashier,
        ),
      ).rejects.toThrow(/شحنة مجمعة/);
      await expect(
        withTx((tx) => assertStandaloneConsignmentTx(tx, row.id, "إرجاع")),
      ).rejects.toThrow(/الشحنة كاملة/);
    }
    const second = await dispatchInvoiceShipment(
      {
        ...input,
        partyId: 2,
        externalTrackingRef: "SECOND-SHIP",
        clientRequestId: "shipment-reassign",
      },
      cashier,
    );
    expect(second.consignmentId).toBe(first.consignmentId);
    expect(second.members.map((row) => row.id)).toEqual(
      first.members.map((row) => row.id),
    );
    expect(second.members.every((row) => Number(row.partyId) === 2)).toBe(true);
    expect(second.members.map((row) => row.externalTrackingRef)).toEqual([
      "SECOND-SHIP",
      null,
    ]);
    expect(await db().select().from(s.deliveryShipmentMembers)).toHaveLength(2);
  });

  it("المرشحون لا يكشفون فواتير عميل آخر أو فرع آخر أو متجر أو عضو شحنة", async () => {
    const candidates = await listShipmentInvoiceCandidates(1, cashier);
    expect(candidates.anchor.invoiceNumber).toBe("SHIP-INV-1");
    expect(candidates.candidates.map((row) => Number(row.id))).toEqual([2]);
    const result = await dispatchInvoiceShipment(input, cashier);
    expect(
      (await listShipmentInvoiceCandidates(1, cashier)).candidates,
    ).toHaveLength(0);
    const rows = await withTx((tx) =>
      loadShipmentMembersTx(tx, result.members[1].id),
    );
    expect(rows.map((row) => row.id)).toEqual(
      result.members.map((row) => row.id),
    );
  });

  it("يحتفظ مسار الإرسالية القديمة المنفردة بتفاصيلها دون إنشاء عضوية وهمية", async () => {
    const single = await dispatchInvoiceToDelivery(
      {
        invoiceId: 1,
        partyId: 1,
        externalTrackingRef: "SINGLE",
        deliveryFee: "500",
        clientRequestId: "legacy-single",
      },
      cashier,
    );
    const details = await getShipmentDetails(single.consignmentId, cashier);
    expect(details).toMatchObject({
      leaderConsignmentId: single.consignmentId,
      memberCount: 1,
      codAmount: "1000.00",
      deliveryFee: "500.00",
    });
    await expect(
      withTx((tx) => assertStandaloneConsignmentTx(tx, single.consignmentId)),
    ).resolves.toBeUndefined();
    expect(await db().select().from(s.deliveryShipmentMembers)).toHaveLength(0);
  });
});
